/**
 * Assistant — a Think-based multi-session chat app.
 *
 * Architecture:
 *
 *     AssistantDirectory ("alice")                  ◄── one DO per GitHub login
 *       ├─ MyAssistant[chat-abc]  [facet]           ◄── one Think DO per chat
 *       ├─ MyAssistant[chat-def]  [facet]
 *       └─ MyAssistant[chat-ghi]  [facet]
 *
 * - `AssistantDirectory` is a top-level `Agent`. It owns the chat list,
 *   the sidebar state, and any per-user cross-chat concerns (e.g. the
 *   daily summary schedule that facets can't own themselves). It gates
 *   child access with `onBeforeSubAgent` as a strict-registry check.
 * - `MyAssistant` is a `Think` subclass that lives as a **facet** of
 *   `AssistantDirectory` (`this.subAgent(MyAssistant, chatId)`). Each
 *   chat is its own Durable Object with its own SQLite storage,
 *   workspace, extensions, MCP servers, and message history, all
 *   colocated with the parent on the same machine.
 * - The Worker authenticates the GitHub session, then forwards every
 *   `/chat*` request into the authenticated user's directory via
 *   `getAgentByName(env.AssistantDirectory, user.login).fetch(request)`.
 *   The built-in sub-agent router inside `Agent.fetch()` picks up the
 *   `/sub/my-assistant/:chatId` tail, so we don't need any custom
 *   per-chat plumbing in the Worker.
 *
 * Cross-chat shared workspace:
 *
 *     AssistantDirectory owns a single `Workspace` backed by its own
 *     SQLite. Every chat's `this.workspace` is a `SharedWorkspace`
 *     proxy that forwards `readFile` / `writeFile` / `readDir` / etc.
 *     to the parent's real workspace over a DO RPC hop. A file
 *     written in chat A is visible verbatim in chat B — the assistant
 *     has one continuous filesystem across every chat with a given
 *     user, not a fresh scratch space per conversation.
 *
 *     The proxy implements the `WorkspaceFsLike` interface from
 *     `@cloudflare/shell`, which is strictly wider than the
 *     `WorkspaceLike` Think's builtin tooling needs. That means the
 *     same proxy also backs codemode's `state.*` sandbox API via
 *     `createWorkspaceStateBackend` — so `state.planEdits` in chat B
 *     sees and mutates the same files chat A just wrote. No casts.
 *
 *     The directory's `Workspace` is constructed with
 *     `onChange: (ev) => this.broadcast(...)`, so every file mutation
 *     is fanned out to every client connected to the directory —
 *     meaning all of the user's open tabs, regardless of which chat
 *     is active. The client's `useChats()` hook turns each broadcast
 *     into a `workspaceRevision` bump, which the chat pane's file
 *     browser uses as a `useEffect` dep to stay live without polling.
 *
 * Cross-chat shared MCP:
 *
 *     MCP server registry, OAuth credentials, live connections, and
 *     tool descriptors all live on `AssistantDirectory`. Each
 *     `MyAssistant` child carries a `SharedMCPClient` proxy that
 *     builds each turn's MCP tool set by RPC'ing the parent for
 *     current tools, then routes each `execute` back through the
 *     parent. Net effect: auth to a server once, and every chat the
 *     user ever opens sees the tools. The OAuth redirect URL is
 *     `chat/mcp-callback` — one URL for every chat, resolved on the
 *     directory's authenticated Worker path. The child's own default
 *     `this.mcp` stays in place but empty; it's never registered on
 *     and never connects out.
 *
 * Features demonstrated inside each `MyAssistant`:
 *   - Workspace tools (read, write, edit, find, grep, delete) — backed by the shared directory workspace, not per-chat
 *   - Sandboxed code execution via @cloudflare/codemode
 *   - Self-authored extensions via ExtensionManager (per-chat — lives in the child DO's own storage)
 *   - Shared MemoryProfile API with SQLite full-text search + Cloudflare Vectorize semantic recall
 *   - Non-destructive compaction for long conversations
 *   - Full-text search across conversation history (FTS5)
 *   - Dynamic typed configuration (model tier, persona) — per-chat
 *   - MCP server integration — shared across all chats via SharedMCPClient
 *   - Client-side tools and tool approval
 *   - Lifecycle hooks (beforeToolCall logging, afterToolCall analytics)
 *   - Durable chat recovery (chatRecovery)
 *   - Regeneration with branch navigation
 */

import { createWorkersAI } from "workers-ai-provider";
import { Agent, callable, getAgentByName } from "agents";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Think, Session, Workspace } from "@cloudflare/think";
import {
  createWorkspaceStateBackend,
  type FileInfo,
  type WorkspaceChangeEvent,
  type WorkspaceFsLike,
} from "@cloudflare/shell";
import {
  createUnauthorizedResponse,
  getGitHubUserFromRequest,
  handleGitHubCallback,
  handleGitHubLogin,
  handleLogout,
} from "./auth";
import { createExecuteTool } from "@cloudflare/think/tools/execute";
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";
import { createExtensionTools } from "@cloudflare/think/tools/extensions";
import { createCompactFunction } from "agents/experimental/memory/utils";
import type {
  TurnContext,
  TurnConfig,
  ChatResponseResult,
  ToolCallContext,
  ToolCallResultContext,
  StepContext,
} from "@cloudflare/think";
import { tool, generateText } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  MemoryProfileImpl,
  SqliteMemoryStore,
  VectorizeMemoryStore,
  WorkersAIEmbeddingModel,
  type MemoryMessage,
  type MemoryProfile,
  type MemoryRecallResult,
  type MemoryRecord,
  type MemoryRememberResult,
} from "./memory";

// ── Shared types (sidebar state, RPC contracts) ───────────────────────

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
}

export interface DirectoryState {
  chats: ChatSummary[];
}

export interface ExecutionAgentSummary {
  id: string;
  role: "research" | "email" | "reminder" | "general";
  title: string;
  instructions: string;
  status: "idle" | "running" | "done" | "error";
  createdAt: number;
  updatedAt: number;
  lastResult?: string;
}

export interface ExecutionTaskSummary {
  id: string;
  agentId: string;
  title: string;
  instructions: string;
  status: "queued" | "running" | "done" | "error";
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  result?: string;
}

export interface ExecutionTriggerSummary {
  id: string;
  agentId: string;
  taskId: string;
  kind: "cron";
  cron: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
}

type ExecutionAgentEvent = {
  id: string;
  type: "task" | "result" | "error";
  text: string;
  createdAt: number;
};

type ExecutionAgentState = ExecutionAgentSummary & {
  events: ExecutionAgentEvent[];
};

/**
 * Tool descriptor the directory returns to children over RPC. Mirrors
 * what `MCPClientManager.listTools()` returns — an MCP SDK `Tool` plus
 * the `serverId` annotation so the child can build a `callMcpTool`
 * closure — and stays structured-cloneable for the DO RPC boundary.
 */
export type McpToolDescriptor = Tool & { serverId: string };

type AgentConfig = {
  modelTier: "fast" | "capable";
  persona: string;
};

// ── ExecutionAgent — hidden persistent worker facet ─────────────────
//
// OpenPoke-style split:
//   - `MyAssistant` remains the visible interaction agent.
//   - `ExecutionAgent` facets are hidden work owners. They keep their
//     own operational event log and can be reused later for follow-up
//     work on the same thread.
//
// These agents are deliberately not user-routable. The directory's
// `onBeforeSubAgent` only allows `MyAssistant` over HTTP/WebSocket;
// execution agents are reached through parent-owned DO RPC.

export class ExecutionAgent extends Agent<Env, ExecutionAgentState> {
  initialState: ExecutionAgentState = {
    id: "",
    role: "general",
    title: "Execution agent",
    instructions: "",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
    events: [],
  };

  async configureAgent(summary: ExecutionAgentSummary): Promise<void> {
    this.setState({
      ...summary,
      events: this.state.events ?? [],
    });
  }

  snapshot(): ExecutionAgentSummary {
    const { events: _events, ...summary } = this.state;
    return summary;
  }

  async runTask(task: string, context?: string): Promise<ExecutionAgentSummary> {
    const now = Date.now();
    const taskEvent: ExecutionAgentEvent = {
      id: crypto.randomUUID(),
      type: "task",
      text: task,
      createdAt: now,
    };
    this.setState({
      ...this.state,
      status: "running",
      updatedAt: now,
      events: [...(this.state.events ?? []), taskEvent],
    });

    try {
      const sharedMemory = await this._loadSharedMemory();
      const history = this.state.events
        .slice(-12)
        .map(
          (event) =>
            `${new Date(event.createdAt).toISOString()} ${event.type.toUpperCase()}: ${event.text}`,
        )
        .join("\n\n");

      const result = await generateText({
        model: createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.6", {
          sessionAffinity: this.name,
        }),
        system: `You are a focused execution agent with role "${this.state.role}".

Own this work thread over time. Use prior task history to preserve continuity.
Do not add personality. Return a concise status report with concrete outputs,
blockers, and suggested next action.

Persistent instructions:
${this.state.instructions || "Handle the delegated task carefully."}

Shared user/project memory:
${sharedMemory || "(empty)"}`,
        prompt: `Current task:
${task}

Visible assistant context:
${context || "(none)"}

Recent execution log:
${history || "(empty)"}`,
      });

      const doneAt = Date.now();
      const resultText = result.text.slice(0, 4000);
      const resultEvent: ExecutionAgentEvent = {
        id: crypto.randomUUID(),
        type: "result",
        text: resultText,
        createdAt: doneAt,
      };

      this.setState({
        ...this.state,
        status: "done",
        updatedAt: doneAt,
        lastResult: resultText,
        events: [...(this.state.events ?? []), resultEvent],
      });
      return this.snapshot();
    } catch (error) {
      const failedAt = Date.now();
      const message = error instanceof Error ? error.message : "Execution agent failed";
      const errorEvent: ExecutionAgentEvent = {
        id: crypto.randomUUID(),
        type: "error",
        text: message,
        createdAt: failedAt,
      };
      this.setState({
        ...this.state,
        status: "error",
        updatedAt: failedAt,
        lastResult: message,
        events: [...(this.state.events ?? []), errorEvent],
      });
      return this.snapshot();
    }
  }

  private async _loadSharedMemory(): Promise<string> {
    try {
      const directory = await this.parentAgent(AssistantDirectory);
      return await directory.getSharedMemoryForPrompt();
    } catch (err) {
      console.warn("[ExecutionAgent] Failed to load shared memory:", err);
      return "";
    }
  }
}

// ── AssistantDirectory — one DO per authenticated GitHub user ─────────
//
// Owns:
//   - the chat index (titles, timestamps, previews) in `chat_meta`
//   - access control for its child chats (strict-registry gate)
//   - cross-chat scheduled work (daily summary)
//
// **Existence is framework-owned.** The authoritative set of chats is
// `listSubAgents(MyAssistant)` — the registry `subAgent()` /
// `deleteSubAgent()` maintain in lockstep with the actual facets. We
// keep a separate `chat_meta` table for metadata (title, preview) keyed
// by chat id; a row there is pure decoration. If they drift, the
// registry wins.

export class AssistantDirectory extends Agent<Env, DirectoryState> {
  initialState: DirectoryState = { chats: [] };

  /**
   * Shared workspace for every chat under this directory. Backed by the
   * directory's own SQLite so all of a user's files live in one place —
   * a `hello.txt` written in chat A shows up verbatim in chat B.
   *
   * Children (`MyAssistant` facets) see this workspace through the
   * `SharedWorkspace` proxy below, which forwards each call to
   * `readFile` / `writeFile` / etc. here. See `SharedWorkspace`.
   *
   * The `onChange` hook fires on every mutation (create/update/delete)
   * regardless of which chat's tool caused it. We rebroadcast to every
   * client connected to this directory — that's every browser tab the
   * user has open — so live UI like the file browser refreshes across
   * chats and tabs without polling. See `_broadcastWorkspaceChange`.
   *
   * Security note: this means any tool running inside any chat has
   * read-write access to every file this user owns. That's the point —
   * a multi-chat assistant should remember what it did in previous
   * chats — but extensions declared with `workspace: "read-write"`
   * inherit the same reach. If you fork this example for a
   * less-trusted extension surface, add gating here.
   */
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name,
    onChange: (event) => this._broadcastWorkspaceChange(event),
    // r2: this.env.R2 — uncomment to spill large files to R2.
  });

  #memoryProfile?: MemoryProfile;

  private get memoryProfile(): MemoryProfile {
    const sqlite = new SqliteMemoryStore((strings, ...values) =>
      this.sql(strings, ...(values as Array<string | number | boolean | null>)),
    );
    const vectorStore = this.env.MEMORY_VECTORIZE
      ? new VectorizeMemoryStore(
          this.env.MEMORY_VECTORIZE,
          new WorkersAIEmbeddingModel(this.env.AI),
          sqlite,
          this.name,
        )
      : undefined;
    this.#memoryProfile ??= new MemoryProfileImpl(sqlite, vectorStore);
    return this.#memoryProfile;
  }

  /**
   * Fan-out: push workspace change events to every client connected to
   * this directory. Each chat pane's `useAgent` connection to the
   * directory (via `useChats()`) receives these; the client side
   * treats them as signals to refresh workspace-backed UI.
   *
   * Deliberately a best-effort `broadcast` (not `setState`), so file
   * churn doesn't trigger full `DirectoryState` re-broadcasts on every
   * write. Does NOT notify sibling child facets — no tool in this
   * example reacts server-side to another chat's writes. Add a
   * parent → child RPC here if that use case shows up.
   */
  private _broadcastWorkspaceChange(event: WorkspaceChangeEvent): void {
    this.broadcast(JSON.stringify({ type: "workspace-change", event }));
  }

  onStart() {
    void this.sql`CREATE TABLE IF NOT EXISTS chat_meta (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      last_message_preview TEXT
    )`;
    void this.sql`CREATE TABLE IF NOT EXISTS execution_agent_meta (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_result TEXT
    )`;
    void this.sql`CREATE TABLE IF NOT EXISTS execution_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_at INTEGER,
      result TEXT
    )`;
    void this.sql`CREATE TABLE IF NOT EXISTS execution_triggers (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      cron TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_at INTEGER
    )`;
    this._refreshState();

    // The directory owns cross-chat scheduled work. Facets can't
    // schedule (see `packages/agents/src/index.ts` — schedule() throws
    // on _isFacet), so any recurring turn lives here and RPCs into the
    // most-recently-active child on fire.
    this.schedule("0 9 * * *", "dailySummary", {}, { idempotent: true });

    // OAuth popup handler for MCP servers. The directory owns the MCP
    // state, so the OAuth redirect (`/chat/mcp-callback`) lands here
    // and the framework dispatches into `this.mcp` via
    // `handleMcpOAuthCallback` on the base `Agent` class.
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200,
          });
        }
        return new Response(`Authentication Failed: ${result.authError || "Unknown error"}`, {
          headers: { "content-type": "text/plain" },
          status: 400,
        });
      },
    });
  }

  /**
   * Only allow the Worker to reach a `MyAssistant` facet that this
   * directory has explicitly spawned via `createChat`. `hasSubAgent`
   * is backed by the same registry `listSubAgents` reads from, so an
   * unknown chat id gets a 404 before any child is woken.
   */
  override async onBeforeSubAgent(
    _req: Request,
    { className, name }: { className: string; name: string },
  ): Promise<Request | Response | void> {
    if (className !== "MyAssistant") {
      return new Response("Not found", { status: 404 });
    }
    if (!this.hasSubAgent(className, name)) {
      return new Response(`${className} "${name}" not found`, { status: 404 });
    }
    // Fall through — framework forwards the request to the facet.
  }

  // ── Sidebar state ──────────────────────────────────────────────────

  /**
   * Build the sidebar from two sources:
   *   1. `listSubAgents(MyAssistant)` — authoritative set of chats.
   *   2. `chat_meta` — app-owned title + preview decoration.
   *
   * A chat present in the registry without a meta row still renders
   * with a default title; a meta row without a registry entry is
   * silently ignored.
   */
  private _refreshState() {
    const registry = this.listSubAgents(MyAssistant);
    const metaRows = this.sql<{
      id: string;
      title: string;
      updated_at: number;
      last_message_preview: string | null;
    }>`SELECT id, title, updated_at, last_message_preview FROM chat_meta`;
    const metaById = new Map(metaRows.map((row) => [row.id, row]));

    const chats: ChatSummary[] = registry
      .map((entry) => {
        const meta = metaById.get(entry.name);
        return {
          id: entry.name,
          title: meta?.title ?? defaultChatTitle(entry.createdAt),
          createdAt: entry.createdAt,
          updatedAt: meta?.updated_at ?? entry.createdAt,
          lastMessagePreview: meta?.last_message_preview ?? undefined,
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    this.setState({ ...this.state, chats });
  }

  // ── Chat lifecycle (RPC from the sidebar) ──────────────────────────

  @callable()
  async createChat(opts?: { title?: string }): Promise<ChatSummary> {
    const id = nanoid(10);
    const now = Date.now();
    const title = opts?.title?.trim() || defaultChatTitle(now);

    // Spawn the facet FIRST so the registry is populated. If the
    // metadata INSERT fails for any reason, a subsequent `deleteChat`
    // or `_refreshState` will still find the chat via the registry.
    await this.subAgent(MyAssistant, id);
    void this.sql`
      INSERT INTO chat_meta (id, title, updated_at, last_message_preview)
      VALUES (${id}, ${title}, ${now}, NULL)
    `;
    this._refreshState();
    return {
      id,
      title,
      createdAt: now,
      updatedAt: now,
    };
  }

  @callable()
  async renameChat(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    void this.sql`
      INSERT INTO chat_meta (id, title, updated_at)
      VALUES (${id}, ${trimmed}, ${Date.now()})
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        updated_at = excluded.updated_at
    `;
    this._refreshState();
  }

  @callable()
  async deleteChat(id: string): Promise<void> {
    // Wipe the facet (idempotent — safe if already gone), then drop
    // its metadata. Order doesn't matter for correctness since the
    // registry is authoritative, but we do the facet first so a crash
    // between the two leaves no orphan meta rows visible.
    await this.deleteSubAgent(MyAssistant, id);
    void this.sql`DELETE FROM chat_meta WHERE id = ${id}`;
    this._refreshState();
  }

  /**
   * Called by a child `MyAssistant` after every assistant turn — see
   * `MyAssistant.onChatResponse`. Keeps the sidebar preview and
   * "last active" ordering in sync with the real conversations.
   *
   * Deliberately NOT `@callable()` — this is a parent-side side effect
   * of committing a turn, not something a browser should be able to
   * trigger directly. Child→parent DO RPC doesn't need the decorator.
   * Marking it `@callable()` would let a client forge sidebar entries
   * for any chat id in their own directory.
   */
  async recordChatTurn(chatId: string, preview: string): Promise<void> {
    void this.sql`
      INSERT INTO chat_meta (id, title, updated_at, last_message_preview)
      VALUES (
        ${chatId},
        ${defaultChatTitle(Date.now())},
        ${Date.now()},
        ${preview}
      )
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        last_message_preview = excluded.last_message_preview
    `;
    this._refreshState();
  }

  // ── Scheduled work (parent-owned, fans out to one child) ───────────

  /**
   * Fires daily at 09:00 UTC (from `onStart()`'s cron schedule).
   *
   * Design note: we post the summary into the most-recently-updated
   * chat rather than fanning out to every chat. For a demo this keeps
   * the behavior legible — one notification per day, attached to the
   * conversation the user was last using. A real app might fan out, or
   * skip chats idle beyond some threshold.
   */
  async dailySummary() {
    const [row] = this.sql<{ id: string }>`
      SELECT id FROM chat_meta ORDER BY updated_at DESC LIMIT 1
    `;
    if (!row) return;

    const target = await this.subAgent(MyAssistant, row.id);
    await target.postDailySummaryPrompt();
  }

  // ── Hidden execution agents (OpenPoke-style worker roster) ───────
  //
  // The visible `MyAssistant` calls these over parent DO RPC from its
  // orchestration tools. The browser can also call the list/create/run
  // surface for the orchestration panel. Direct HTTP/WebSocket routing
  // to `ExecutionAgent` facets remains blocked by `onBeforeSubAgent`.

  @callable()
  async listExecutionAgents(): Promise<ExecutionAgentSummary[]> {
    const registry = this.listSubAgents(ExecutionAgent);
    const rows = this.sql<{
      id: string;
      role: ExecutionAgentSummary["role"];
      title: string;
      instructions: string;
      status: ExecutionAgentSummary["status"];
      created_at: number;
      updated_at: number;
      last_result: string | null;
    }>`SELECT id, role, title, instructions, status, created_at, updated_at, last_result FROM execution_agent_meta`;
    const rowById = new Map(rows.map((row) => [row.id, row]));

    return registry
      .map((entry) => {
        const row = rowById.get(entry.name);
        return {
          id: entry.name,
          role: row?.role ?? "general",
          title: row?.title ?? `Execution agent ${entry.name}`,
          instructions: row?.instructions ?? "",
          status: row?.status ?? "idle",
          createdAt: row?.created_at ?? entry.createdAt,
          updatedAt: row?.updated_at ?? entry.createdAt,
          lastResult: row?.last_result ?? undefined,
        } satisfies ExecutionAgentSummary;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  @callable()
  async createExecutionAgent(opts: {
    role: ExecutionAgentSummary["role"];
    title: string;
    instructions: string;
  }): Promise<ExecutionAgentSummary> {
    const id = nanoid(10);
    const now = Date.now();
    const summary: ExecutionAgentSummary = {
      id,
      role: opts.role,
      title: opts.title.trim() || `${opts.role} agent`,
      instructions: opts.instructions.trim(),
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };

    const agent = await this.subAgent(ExecutionAgent, id);
    await agent.configureAgent(summary);
    this._upsertExecutionAgentMeta(summary);
    return summary;
  }

  async delegateToExecutionAgent(
    id: string,
    task: string,
    context?: string,
  ): Promise<ExecutionAgentSummary> {
    if (!this.hasSubAgent("ExecutionAgent", id)) {
      throw new Error(`ExecutionAgent "${id}" not found`);
    }

    const agent = await this.subAgent(ExecutionAgent, id);
    const summary = await agent.runTask(task, context);
    this._upsertExecutionAgentMeta(summary);
    return summary;
  }

  @callable()
  async listExecutionTasks(agentId?: string): Promise<ExecutionTaskSummary[]> {
    const rows = agentId
      ? this.sql<{
          id: string;
          agent_id: string;
          title: string;
          instructions: string;
          status: ExecutionTaskSummary["status"];
          created_at: number;
          updated_at: number;
          last_run_at: number | null;
          result: string | null;
        }>`SELECT id, agent_id, title, instructions, status, created_at, updated_at, last_run_at, result FROM execution_tasks WHERE agent_id = ${agentId}`
      : this.sql<{
          id: string;
          agent_id: string;
          title: string;
          instructions: string;
          status: ExecutionTaskSummary["status"];
          created_at: number;
          updated_at: number;
          last_run_at: number | null;
          result: string | null;
        }>`SELECT id, agent_id, title, instructions, status, created_at, updated_at, last_run_at, result FROM execution_tasks`;

    return rows
      .map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        title: row.title,
        instructions: row.instructions,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastRunAt: row.last_run_at ?? undefined,
        result: row.result ?? undefined,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  @callable()
  async createExecutionTask(opts: {
    agentId: string;
    title: string;
    instructions: string;
  }): Promise<ExecutionTaskSummary> {
    if (!this.hasSubAgent("ExecutionAgent", opts.agentId)) {
      throw new Error(`ExecutionAgent "${opts.agentId}" not found`);
    }

    const now = Date.now();
    const task: ExecutionTaskSummary = {
      id: nanoid(10),
      agentId: opts.agentId,
      title: opts.title.trim() || "Execution task",
      instructions: opts.instructions.trim(),
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this._upsertExecutionTask(task);
    return task;
  }

  @callable()
  async runExecutionTask(taskId: string, context?: string): Promise<ExecutionTaskSummary> {
    const task = this._getExecutionTask(taskId);
    if (!task) throw new Error(`Execution task "${taskId}" not found`);

    const startedAt = Date.now();
    this._upsertExecutionTask({
      ...task,
      status: "running",
      updatedAt: startedAt,
      lastRunAt: startedAt,
    });

    const summary = await this.delegateToExecutionAgent(
      task.agentId,
      `${task.title}\n\n${task.instructions}`,
      context,
    );

    const finishedAt = Date.now();
    const next: ExecutionTaskSummary = {
      ...task,
      status: summary.status === "error" ? "error" : "done",
      updatedAt: finishedAt,
      lastRunAt: finishedAt,
      result: summary.lastResult,
    };
    this._upsertExecutionTask(next);
    return next;
  }

  @callable()
  async listExecutionTriggers(agentId?: string): Promise<ExecutionTriggerSummary[]> {
    const rows = agentId
      ? this.sql<{
          id: string;
          agent_id: string;
          task_id: string;
          kind: "cron";
          cron: string;
          enabled: number;
          created_at: number;
          updated_at: number;
          last_run_at: number | null;
        }>`SELECT id, agent_id, task_id, kind, cron, enabled, created_at, updated_at, last_run_at FROM execution_triggers WHERE agent_id = ${agentId}`
      : this.sql<{
          id: string;
          agent_id: string;
          task_id: string;
          kind: "cron";
          cron: string;
          enabled: number;
          created_at: number;
          updated_at: number;
          last_run_at: number | null;
        }>`SELECT id, agent_id, task_id, kind, cron, enabled, created_at, updated_at, last_run_at FROM execution_triggers`;

    return rows
      .map((row) => ({
        id: row.id,
        agentId: row.agent_id,
        taskId: row.task_id,
        kind: row.kind,
        cron: row.cron,
        enabled: row.enabled === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastRunAt: row.last_run_at ?? undefined,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  @callable()
  async createExecutionTrigger(opts: {
    agentId: string;
    taskId: string;
    cron: string;
  }): Promise<ExecutionTriggerSummary> {
    const task = this._getExecutionTask(opts.taskId);
    if (!task) throw new Error(`Execution task "${opts.taskId}" not found`);
    if (task.agentId !== opts.agentId) {
      throw new Error("Execution trigger agentId must match the task owner");
    }

    const now = Date.now();
    const trigger: ExecutionTriggerSummary = {
      id: nanoid(10),
      agentId: opts.agentId,
      taskId: opts.taskId,
      kind: "cron",
      cron: opts.cron.trim(),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    this._upsertExecutionTrigger(trigger);
    await this.schedule(
      trigger.cron,
      "fireExecutionTrigger",
      { triggerId: trigger.id },
      { idempotent: true },
    );
    return trigger;
  }

  async fireExecutionTrigger(payload: { triggerId: string } | string): Promise<void> {
    const triggerId = typeof payload === "string" ? payload : payload.triggerId;
    const trigger = this._getExecutionTrigger(triggerId);
    if (!trigger || !trigger.enabled) return;

    const now = Date.now();
    this._upsertExecutionTrigger({
      ...trigger,
      updatedAt: now,
      lastRunAt: now,
    });
    await this.runExecutionTask(trigger.taskId, "Triggered by scheduled cron.");
  }

  private _getExecutionTask(id: string): ExecutionTaskSummary | null {
    const [row] = this.sql<{
      id: string;
      agent_id: string;
      title: string;
      instructions: string;
      status: ExecutionTaskSummary["status"];
      created_at: number;
      updated_at: number;
      last_run_at: number | null;
      result: string | null;
    }>`SELECT id, agent_id, title, instructions, status, created_at, updated_at, last_run_at, result FROM execution_tasks WHERE id = ${id}`;
    if (!row) return null;
    return {
      id: row.id,
      agentId: row.agent_id,
      title: row.title,
      instructions: row.instructions,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: row.last_run_at ?? undefined,
      result: row.result ?? undefined,
    };
  }

  private _getExecutionTrigger(id: string): ExecutionTriggerSummary | null {
    const [row] = this.sql<{
      id: string;
      agent_id: string;
      task_id: string;
      kind: "cron";
      cron: string;
      enabled: number;
      created_at: number;
      updated_at: number;
      last_run_at: number | null;
    }>`SELECT id, agent_id, task_id, kind, cron, enabled, created_at, updated_at, last_run_at FROM execution_triggers WHERE id = ${id}`;
    if (!row) return null;
    return {
      id: row.id,
      agentId: row.agent_id,
      taskId: row.task_id,
      kind: row.kind,
      cron: row.cron,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRunAt: row.last_run_at ?? undefined,
    };
  }

  private _upsertExecutionTask(task: ExecutionTaskSummary): void {
    void this.sql`
      INSERT INTO execution_tasks (
        id,
        agent_id,
        title,
        instructions,
        status,
        created_at,
        updated_at,
        last_run_at,
        result
      )
      VALUES (
        ${task.id},
        ${task.agentId},
        ${task.title},
        ${task.instructions},
        ${task.status},
        ${task.createdAt},
        ${task.updatedAt},
        ${task.lastRunAt ?? null},
        ${task.result ?? null}
      )
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        instructions = excluded.instructions,
        status = excluded.status,
        updated_at = excluded.updated_at,
        last_run_at = excluded.last_run_at,
        result = excluded.result
    `;
  }

  private _upsertExecutionTrigger(trigger: ExecutionTriggerSummary): void {
    void this.sql`
      INSERT INTO execution_triggers (
        id,
        agent_id,
        task_id,
        kind,
        cron,
        enabled,
        created_at,
        updated_at,
        last_run_at
      )
      VALUES (
        ${trigger.id},
        ${trigger.agentId},
        ${trigger.taskId},
        ${trigger.kind},
        ${trigger.cron},
        ${trigger.enabled ? 1 : 0},
        ${trigger.createdAt},
        ${trigger.updatedAt},
        ${trigger.lastRunAt ?? null}
      )
      ON CONFLICT(id) DO UPDATE SET
        cron = excluded.cron,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at,
        last_run_at = excluded.last_run_at
    `;
  }

  private _upsertExecutionAgentMeta(summary: ExecutionAgentSummary): void {
    void this.sql`
      INSERT INTO execution_agent_meta (
        id,
        role,
        title,
        instructions,
        status,
        created_at,
        updated_at,
        last_result
      )
      VALUES (
        ${summary.id},
        ${summary.role},
        ${summary.title},
        ${summary.instructions},
        ${summary.status},
        ${summary.createdAt},
        ${summary.updatedAt},
        ${summary.lastResult ?? null}
      )
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        title = excluded.title,
        instructions = excluded.instructions,
        status = excluded.status,
        updated_at = excluded.updated_at,
        last_result = excluded.last_result
    `;
  }

  // ── Shared workspace RPC surface (called by SharedWorkspace) ─────
  //
  // Children reach the directory via `parentAgent(AssistantDirectory)`,
  // which exposes these as typed DO RPC methods. `@callable()` is
  // deliberately NOT used — the client has no business writing to
  // another chat's files via the sidebar websocket; workspace I/O is
  // LLM-tool-only. DO-to-DO RPC doesn't need the decorator.
  //
  // The surface covers the full `WorkspaceFsLike` interface from
  // `@cloudflare/shell`, which is what `createWorkspaceStateBackend`
  // needs to drive codemode's `state.*` sandbox API. That means a
  // plan from one chat can edit files the same way as a single-chat
  // app — the shared workspace is the single source of truth.
  //
  // Each method is a one-line delegate. We use
  // `Parameters<Workspace["method"]>[n]` to stay automatically in
  // sync with `@cloudflare/shell` rather than re-stating the types.

  async readFile(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }

  async readFileBytes(path: string): Promise<Uint8Array | null> {
    return this.workspace.readFileBytes(path);
  }

  async writeFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["writeFile"]>[2],
  ): Promise<void> {
    return this.workspace.writeFile(path, content, mimeType);
  }

  async writeFileBytes(
    path: string,
    content: Parameters<Workspace["writeFileBytes"]>[1],
    mimeType?: Parameters<Workspace["writeFileBytes"]>[2],
  ): Promise<void> {
    return this.workspace.writeFileBytes(path, content, mimeType);
  }

  async appendFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["appendFile"]>[2],
  ): Promise<void> {
    return this.workspace.appendFile(path, content, mimeType);
  }

  async exists(path: string): Promise<boolean> {
    return this.workspace.exists(path);
  }

  async readDir(path: string, opts?: Parameters<Workspace["readDir"]>[1]): Promise<FileInfo[]> {
    return this.workspace.readDir(path, opts);
  }

  async rm(path: string, opts?: Parameters<Workspace["rm"]>[1]): Promise<void> {
    return this.workspace.rm(path, opts);
  }

  async glob(pattern: string): Promise<FileInfo[]> {
    return this.workspace.glob(pattern);
  }

  async mkdir(path: string, opts?: Parameters<Workspace["mkdir"]>[1]): Promise<void> {
    return this.workspace.mkdir(path, opts);
  }

  async stat(path: string): Promise<FileInfo | null> {
    return this.workspace.stat(path);
  }

  async lstat(path: string): Promise<FileInfo | null> {
    return this.workspace.lstat(path);
  }

  async cp(src: string, dest: string, opts?: Parameters<Workspace["cp"]>[2]): Promise<void> {
    return this.workspace.cp(src, dest, opts);
  }

  async mv(src: string, dest: string): Promise<void> {
    return this.workspace.mv(src, dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    return this.workspace.symlink(target, linkPath);
  }

  async readlink(path: string): Promise<string> {
    return this.workspace.readlink(path);
  }

  // ── Shared MCP surface ───────────────────────────────────────────
  //
  // The directory owns the MCP state for every chat under it:
  //   - server registry (+ OAuth client registrations) in
  //     `cf_agents_mcp_servers`
  //   - OAuth tokens via `DurableObjectOAuthClientProvider`
  //   - live connections + tool/prompt/resource caches in memory
  //
  // Browser-callable surface (`@callable()`): `addServer` /
  // `removeServer`. These go through the directory's WS connection
  // (the one `useChats()` already owns) rather than the per-chat WS,
  // so the UI talks to the same DO that holds the state.
  //
  // Child-callable surface (not `@callable()`): `listMcpToolDescriptors`
  // / `callMcpTool`. These are invoked via `parentAgent(AssistantDirectory)`
  // from `SharedMCPClient` on each chat turn.

  /**
   * Register a new MCP server for this user and kick off the initial
   * connection. If the server requires OAuth, returns the provider's
   * `authUrl` so the browser can open the popup.
   *
   * The callback URL is `/chat/mcp-callback` — resolved by the Worker
   * to this directory instance for the authenticated user. One URL
   * for every server for every chat.
   */
  @callable()
  async addServer(name: string, url: string): ReturnType<AssistantDirectory["addMcpServer"]> {
    return await this.addMcpServer(name, url, {
      callbackPath: "chat/mcp-callback",
    });
  }

  @callable()
  async removeServer(id: string): Promise<void> {
    await this.removeMcpServer(id);
  }

  /**
   * Snapshot of currently-ready MCP tools across every server this
   * directory has connected. Children call this once per chat turn
   * (via `SharedMCPClient.getAITools()`) to assemble the LLM's tool
   * set.
   *
   * Waits up to `timeoutMs` for in-progress connections to become
   * ready before returning, so a chat launched right after the
   * directory wakes from hibernation still sees tools from servers
   * that are mid-handshake. `MCPClientManager.waitForConnections`
   * returns eagerly if everything is already ready.
   *
   * Deliberately NOT `@callable()` — child→parent DO RPC doesn't
   * need the decorator, and the browser reads MCP state via the
   * `CF_AGENT_MCP_SERVERS` broadcast (automatic, not this path).
   */
  async listMcpToolDescriptors(timeoutMs = 5_000): Promise<McpToolDescriptor[]> {
    await this.mcp.waitForConnections({ timeout: timeoutMs });
    return this.mcp.listTools() as McpToolDescriptor[];
  }

  /**
   * Invoke an MCP tool. Returns the raw `CallToolResult` from the MCP
   * SDK; the child is responsible for unwrapping `isError` into a
   * thrown exception for the AI SDK's tool pipeline.
   *
   * Deliberately NOT `@callable()` — only intended to be reached via
   * `SharedMCPClient.execute(...)`. A `@callable()` here would let a
   * client invoke any MCP tool directly over the sidebar WS,
   * bypassing the agent's `beforeToolCall`/`afterToolCall` hooks.
   */
  async callMcpTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return (await this.mcp.callTool({
      arguments: args,
      name,
      serverId,
    })) as CallToolResult;
  }

  // ── Shared memory surface ────────────────────────────────────────
  //
  // This mirrors the managed Agent Memory profile API from Cloudflare's
  // beta announcement. Today it is backed by a local SQLite/FTS store;
  // once a managed Agent Memory binding is available, only `memoryProfile` should
  // need to change.

  async rememberMemory(input: {
    content: string;
    sessionId?: string;
  }): Promise<MemoryRememberResult> {
    return this.memoryProfile.remember(input);
  }

  async recallMemory(query: string, opts?: { limit?: number }): Promise<MemoryRecallResult> {
    return this.memoryProfile.recall(query, opts);
  }

  async ingestMemory(messages: MemoryMessage[], opts?: { sessionId?: string }): Promise<void> {
    return this.memoryProfile.ingest(messages, opts);
  }

  async listMemory(opts?: { limit?: number }): Promise<MemoryRecord[]> {
    return this.memoryProfile.list(opts);
  }

  async forgetMemory(id: string): Promise<void> {
    return this.memoryProfile.forget(id);
  }

  async getSharedMemoryForPrompt(): Promise<string> {
    return this.memoryProfile.summarizeForPrompt();
  }
}

// ── SharedWorkspace — proxy used by children ─────────────────────────
//
// Satisfies `WorkspaceFsLike` (the interface shipped by
// `@cloudflare/shell`) by forwarding every call to the parent
// `AssistantDirectory`'s real `Workspace`. Because `WorkspaceFsLike`
// is a strict superset of `WorkspaceLike`, this also satisfies
// everything Think's builtin tools need — but covering the wider
// surface is what lets us pass the same object to
// `createWorkspaceStateBackend` below, so codemode's `state.*` sandbox
// API operates on the shared workspace too.
//
// Per-call it's one extra RPC hop; parent and child are DO facets
// colocated on the same machine, so the hop is in-process and cheap.
//
// The parent stub is resolved lazily on first use and cached. Stubs
// from `parentAgent()` are thin proxies — they don't hold connections,
// so caching the resolved stub across the child's lifetime is safe
// even if the parent hibernates and comes back between calls.

class SharedWorkspace implements WorkspaceFsLike {
  #stubPromise?: Promise<DurableObjectStub<AssistantDirectory>>;

  constructor(private child: Pick<MyAssistant, "parentAgent">) {}

  private parent(): Promise<DurableObjectStub<AssistantDirectory>> {
    this.#stubPromise ??= this.child.parentAgent(AssistantDirectory);
    return this.#stubPromise;
  }

  async readFile(path: string) {
    return (await this.parent()).readFile(path);
  }

  async readFileBytes(path: string) {
    return (await this.parent()).readFileBytes(path);
  }

  async writeFile(path: string, content: string, mimeType?: Parameters<Workspace["writeFile"]>[2]) {
    return (await this.parent()).writeFile(path, content, mimeType);
  }

  async writeFileBytes(
    path: string,
    content: Parameters<Workspace["writeFileBytes"]>[1],
    mimeType?: Parameters<Workspace["writeFileBytes"]>[2],
  ) {
    return (await this.parent()).writeFileBytes(path, content, mimeType);
  }

  async appendFile(
    path: string,
    content: string,
    mimeType?: Parameters<Workspace["appendFile"]>[2],
  ) {
    return (await this.parent()).appendFile(path, content, mimeType);
  }

  async exists(path: string) {
    return (await this.parent()).exists(path);
  }

  async readDir(path?: string, opts?: Parameters<Workspace["readDir"]>[1]) {
    return (await this.parent()).readDir(path ?? "/", opts);
  }

  async rm(path: string, opts?: Parameters<Workspace["rm"]>[1]) {
    return (await this.parent()).rm(path, opts);
  }

  async glob(pattern: string) {
    return (await this.parent()).glob(pattern);
  }

  async mkdir(path: string, opts?: Parameters<Workspace["mkdir"]>[1]) {
    return (await this.parent()).mkdir(path, opts);
  }

  async stat(path: string) {
    return (await this.parent()).stat(path);
  }

  async lstat(path: string) {
    return (await this.parent()).lstat(path);
  }

  async cp(src: string, dest: string, opts?: Parameters<Workspace["cp"]>[2]) {
    return (await this.parent()).cp(src, dest, opts);
  }

  async mv(src: string, dest: string) {
    return (await this.parent()).mv(src, dest);
  }

  async symlink(target: string, linkPath: string) {
    return (await this.parent()).symlink(target, linkPath);
  }

  async readlink(path: string) {
    return (await this.parent()).readlink(path);
  }
}

// ── SharedMCPClient — child-side proxy for the directory's MCP ──────
//
// MCP state (server registry, OAuth tokens, live connections, tool
// caches) lives entirely on `AssistantDirectory`. This class lets a
// child expose those shared tools to its LLM as if they were local,
// while every actual invocation round-trips through one parent-DO
// RPC hop.
//
// Shape:
//   - `getAITools(timeoutMs?)` — snapshot the parent's current tools
//     and return them as an AI SDK `ToolSet`. Called once per turn
//     from `MyAssistant.beforeTurn`; the resulting tools are merged
//     into the turn via `TurnConfig.tools`.
//   - Each returned tool's `execute` RPCs `parent.callMcpTool(...)`
//     and translates the MCP-level `isError` result into a thrown
//     exception for Think's `afterToolCall` pipeline. Mirrors what
//     `MCPClientManager.getAITools()` does internally for a local
//     MCP client — same tool-key format, same error semantics — so
//     the LLM sees an identical surface whether MCP is local or
//     proxied.
//
// The parent stub is resolved lazily on first call and cached, same
// pattern as `SharedWorkspace` above.

class SharedMCPClient {
  #stubPromise?: Promise<DurableObjectStub<AssistantDirectory>>;

  constructor(private child: Pick<MyAssistant, "parentAgent">) {}

  private parent(): Promise<DurableObjectStub<AssistantDirectory>> {
    this.#stubPromise ??= this.child.parentAgent(AssistantDirectory);
    return this.#stubPromise;
  }

  /**
   * Assemble a snapshot `ToolSet` of the currently-ready MCP tools.
   * The returned tools are safe to splice into Think's turn toolset
   * via `TurnConfig.tools`.
   */
  async getAITools(timeoutMs = 5_000): Promise<ToolSet> {
    const parent = await this.parent();
    const descriptors = (await parent.listMcpToolDescriptors(timeoutMs)) as McpToolDescriptor[];

    const entries: [string, ToolSet[string]][] = [];
    for (const descriptor of descriptors) {
      try {
        // Same key format MCPClientManager uses internally, so the
        // LLM's tool vocabulary matches the local-MCP case.
        const toolKey = `tool_${descriptor.serverId.replace(/-/g, "")}_${descriptor.name}`;
        const { serverId, name, inputSchema, outputSchema } = descriptor;
        const title =
          descriptor.title ?? (descriptor.annotations as { title?: string } | undefined)?.title;

        entries.push([
          toolKey,
          {
            description: descriptor.description,
            title,
            inputSchema: inputSchema
              ? z.fromJSONSchema(inputSchema as Parameters<typeof z.fromJSONSchema>[0])
              : z.fromJSONSchema({ type: "object" }),
            outputSchema: outputSchema
              ? z.fromJSONSchema(outputSchema as Parameters<typeof z.fromJSONSchema>[0])
              : undefined,
            execute: async (args) => {
              const stub = await this.parent();
              const result = (await stub.callMcpTool(
                serverId,
                name,
                args as Record<string, unknown>,
              )) as CallToolResult;
              if (result.isError) {
                const content = result.content as
                  | Array<{ type: string; text?: string }>
                  | undefined;
                const firstText = content?.[0];
                const message =
                  firstText?.type === "text" && firstText.text
                    ? firstText.text
                    : "Tool call failed";
                throw new Error(message);
              }
              return result;
            },
          },
        ]);
      } catch (err) {
        console.warn(
          `[SharedMCPClient] Skipping tool "${descriptor.name}" from "${descriptor.serverId}": ${err}`,
        );
      }
    }

    return Object.fromEntries(entries);
  }
}

// ── Shared memory provider — child-side Session API adapter ─────────

class SharedMemorySummaryProvider {
  #stubPromise?: Promise<DurableObjectStub<AssistantDirectory>>;

  constructor(private child: Pick<MyAssistant, "parentAgent">) {}

  private parent(): Promise<DurableObjectStub<AssistantDirectory>> {
    this.#stubPromise ??= this.child.parentAgent(AssistantDirectory);
    return this.#stubPromise;
  }

  async get(): Promise<string | null> {
    return (await this.parent()).getSharedMemoryForPrompt();
  }
}

// ── MyAssistant — one Think DO per chat (a facet of the directory) ────

export class MyAssistant extends Think<Env> {
  static options = {
    sendIdentityOnConnect: true,
  };
  override maxSteps = 10;
  chatRecovery = true;
  extensionLoader = this.env.LOADER;

  /**
   * Override Think's default per-chat workspace with a proxy into the
   * shared `AssistantDirectory.workspace`. This class field runs in the
   * subclass's synthetic constructor after `super(ctx, env)`, so by the
   * time Think's wrapped `onStart` fires its `!this.workspace` default-
   * init check, the shared proxy is already in place — Think never
   * creates a per-chat `Workspace` at all.
   *
   * Declared as `WorkspaceFsLike` (the wider interface from
   * `@cloudflare/shell`) rather than Think's `WorkspaceLike` so that
   * `createWorkspaceStateBackend(this.workspace)` in `getTools()` sees
   * the full filesystem surface it needs. `WorkspaceFsLike` is a strict
   * superset of `WorkspaceLike`, so Think's internals keep working.
   *
   * All workspace-aware code — the builtin tools from
   * `createWorkspaceTools`, lifecycle hooks, the `listWorkspaceFiles`
   * / `readWorkspaceFile` RPCs below, and codemode's `state.*` sandbox
   * API via `createWorkspaceStateBackend` — routes through this proxy
   * transparently.
   */
  override workspace: WorkspaceFsLike = new SharedWorkspace(this);

  /**
   * Proxy to the directory's MCP state. Used by `beforeTurn` below to
   * splice the user's shared MCP tools into each turn's tool set.
   *
   * The child's own `this.mcp` (Think's default) stays around but is
   * never registered against — it exists solely so Agent framework
   * paths that reach for `this.mcp.*` (hibernation restore, OAuth
   * callback routing, broadcast plumbing) don't need to care about
   * the parallel-field arrangement. Those paths all resolve to an
   * empty, idle MCP client.
   *
   * OAuth callbacks (`/chat/mcp-callback`) are routed to the parent
   * directory by the Worker, never to a child, so child-side
   * `isCallbackRequest` in the framework reliably returns false here.
   */
  sharedMcp = new SharedMCPClient(this);

  getModel(): LanguageModel {
    const tier = this.getConfig<AgentConfig>()?.modelTier ?? "fast";
    const models: Record<string, string> = {
      fast: "@cf/moonshotai/kimi-k2.6",
      capable: "@cf/moonshotai/kimi-k2.6",
    };
    return createWorkersAI({ binding: this.env.AI })(models[tier] ?? models.fast, {
      sessionAffinity: this.sessionAffinity,
    });
  }

  configureSession(session: Session) {
    const persona =
      this.getConfig<AgentConfig>()?.persona ||
      "You are a capable technical assistant. You have access to a persistent workspace, sandboxed code execution, and the ability to create new tools on the fly. You think before you act, and you prefer writing code over making many sequential tool calls.";

    return session
      .withContext("soul", {
        provider: {
          get: async () =>
            `${persona}

Be concise. Prefer short, direct answers over lengthy explanations.
The execute tool runs JavaScript you write in a sandboxed environment. Use it for multi-file operations, data transformations, or any task that would require many sequential tool calls.
You can create extensions: new tools that persist across conversations. Offer to create one when a recurring task would benefit from it.
For durable multi-step work, use execution agents: list the existing roster, create a focused worker when no suitable one exists, create durable tasks for work that may need status or retries, and create cron triggers for work that should wake up later. Reuse the same execution agent for follow-ups on the same thread of work.
When you learn something about the user or their project, save it to memory.`,
        },
      })
      .withContext("memory", {
        description:
          "Read-only summary of shared user/project memory. Use remember_memory to store important facts and recall_memory to retrieve details instead of relying on this summary alone.",
        maxTokens: 2000,
        provider: new SharedMemorySummaryProvider(this),
      })
      .onCompaction(
        createCompactFunction({
          summarize: (prompt) =>
            generateText({ model: this.getModel(), prompt }).then((r) => r.text),
        }),
      )
      .compactAfter(50000)
      .withCachedPrompt();
  }

  getTools(): ToolSet {
    const extensionTools = this.extensionManager
      ? {
          ...createExtensionTools({ manager: this.extensionManager }),
          ...this.extensionManager.getTools(),
        }
      : {};

    return {
      execute: createExecuteTool({
        tools: createWorkspaceTools(this.workspace),
        // `state.*` inside the sandbox is backed by the SHARED workspace
        // too — `createWorkspaceStateBackend` accepts our `SharedWorkspace`
        // proxy because it satisfies the `WorkspaceFsLike` interface from
        // `@cloudflare/shell`. That means `state.planEdits`/`applyEdits`
        // in chat B sees and mutates the same files chat A just wrote.
        state: createWorkspaceStateBackend(this.workspace),
        loader: this.env.LOADER,
      }),

      ...extensionTools,

      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("City name"),
        }),
        execute: async ({ city }) => {
          const conditions = ["sunny", "cloudy", "rainy", "snowy"];
          const temp = Math.floor(Math.random() * 30) + 5;
          return {
            city,
            temperature: temp,
            condition: conditions[Math.floor(Math.random() * conditions.length)],
            unit: "celsius",
          };
        },
      }),

      getUserTimezone: tool({
        description:
          "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
        inputSchema: z.object({}),
      }),

      calculate: tool({
        description: "Perform a math calculation. Requires approval for large numbers (over 1000).",
        inputSchema: z.object({
          a: z.number().describe("First number"),
          b: z.number().describe("Second number"),
          operator: z.enum(["+", "-", "*", "/"]).describe("Arithmetic operator"),
        }),
        needsApproval: async ({ a, b }) => Math.abs(a) > 1000 || Math.abs(b) > 1000,
        execute: async ({ a, b, operator }) => {
          const ops: Record<string, (x: number, y: number) => number> = {
            "+": (x, y) => x + y,
            "-": (x, y) => x - y,
            "*": (x, y) => x * y,
            "/": (x, y) => x / y,
          };
          if (operator === "/" && b === 0) {
            return { error: "Division by zero" };
          }
          return {
            expression: `${a} ${operator} ${b}`,
            result: ops[operator](a, b),
          };
        },
      }),

      remember_memory: tool({
        description:
          "Store an important durable user or project memory. Use this for stable preferences, decisions, facts, and reusable context that should survive across chats and execution agents.",
        inputSchema: z.object({
          content: z.string().describe("The memory to store as a concise standalone statement."),
        }),
        execute: async ({ content }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.rememberMemory({ content, sessionId: this.name });
        },
      }),

      recall_memory: tool({
        description:
          "Recall relevant durable user or project memories. Use this before relying on the summary in the MEMORY context block.",
        inputSchema: z.object({
          query: z.string().describe("Question or search query for memory recall."),
          limit: z.number().int().min(1).max(20).optional().describe("Maximum memories to return."),
        }),
        execute: async ({ query, limit }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.recallMemory(query, { limit });
        },
      }),

      list_memory: tool({
        description: "List the most recent durable memories for this user/workspace.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(50).optional().describe("Maximum memories to return."),
        }),
        execute: async ({ limit }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.listMemory({ limit });
        },
      }),

      forget_memory: tool({
        description:
          "Delete a durable memory by id when it is wrong, obsolete, or the user asks to forget it.",
        inputSchema: z.object({
          id: z
            .string()
            .describe("The memory id returned by remember_memory, recall_memory, or list_memory."),
        }),
        execute: async ({ id }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          await directory.forgetMemory(id);
          return { ok: true };
        },
      }),

      list_execution_agents: tool({
        description:
          "List hidden execution agents that already own durable work threads. Use this before creating a new execution agent.",
        inputSchema: z.object({}),
        execute: async () => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.listExecutionAgents();
        },
      }),

      create_execution_agent: tool({
        description:
          "Create a hidden persistent execution agent for a specific work thread when no existing agent fits.",
        inputSchema: z.object({
          role: z
            .enum(["research", "email", "reminder", "general"])
            .describe("The worker role template to use."),
          title: z.string().describe("Short human-readable name for the work thread."),
          instructions: z
            .string()
            .describe(
              "Durable instructions this worker should keep using on future delegated tasks.",
            ),
        }),
        execute: async ({ role, title, instructions }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.createExecutionAgent({ role, title, instructions });
        },
      }),

      delegate_to_execution_agent: tool({
        description:
          "Send a bounded task to an existing hidden execution agent and return its status report.",
        inputSchema: z.object({
          id: z.string().describe("The execution agent id from the roster."),
          task: z.string().describe("The concrete task the execution agent should perform."),
          context: z.string().optional().describe("Relevant user-facing conversation context."),
        }),
        execute: async ({ id, task, context }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.delegateToExecutionAgent(id, task, context);
        },
      }),

      create_execution_task: tool({
        description:
          "Create a durable task owned by a hidden execution agent. Use this for work that may need status, history, retries, or a future trigger.",
        inputSchema: z.object({
          agentId: z.string().describe("The execution agent that owns the task."),
          title: z.string().describe("Short task title."),
          instructions: z
            .string()
            .describe("Concrete instructions the execution agent should run now or later."),
        }),
        execute: async ({ agentId, title, instructions }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.createExecutionTask({ agentId, title, instructions });
        },
      }),

      list_execution_tasks: tool({
        description: "List durable execution tasks, optionally scoped to one execution agent.",
        inputSchema: z.object({
          agentId: z.string().optional().describe("Optional execution agent id."),
        }),
        execute: async ({ agentId }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.listExecutionTasks(agentId);
        },
      }),

      run_execution_task: tool({
        description:
          "Run an existing durable execution task through its owning hidden execution agent.",
        inputSchema: z.object({
          taskId: z.string().describe("The task id to run."),
          context: z.string().optional().describe("Relevant user-facing conversation context."),
        }),
        execute: async ({ taskId, context }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.runExecutionTask(taskId, context);
        },
      }),

      create_execution_trigger: tool({
        description:
          "Create a cron trigger that wakes an execution agent by running one of its durable tasks on schedule.",
        inputSchema: z.object({
          agentId: z.string().describe("The execution agent that owns the task."),
          taskId: z.string().describe("The durable task to run on schedule."),
          cron: z
            .string()
            .describe("Cron expression, for example '0 14 * * 1' for Mondays at 14:00 UTC."),
        }),
        execute: async ({ agentId, taskId, cron }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.createExecutionTrigger({ agentId, taskId, cron });
        },
      }),

      list_execution_triggers: tool({
        description:
          "List cron triggers that can wake hidden execution agents, optionally scoped to one execution agent.",
        inputSchema: z.object({
          agentId: z.string().optional().describe("Optional execution agent id."),
        }),
        execute: async ({ agentId }) => {
          const directory = await this.parentAgent(AssistantDirectory);
          return directory.listExecutionTriggers(agentId);
        },
      }),
    };
  }

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig | void> {
    // Shared memory can be written by another chat since this facet's
    // prompt was cached. Refresh once per turn so cross-chat memory is
    // visible before inference starts.
    await this.session.refreshSystemPrompt();

    // Splice the directory's shared MCP tools into this turn. Think
    // merges `config.tools` additively on top of the base tool set, so
    // whatever tools we return here join `workspace` / `extensions` /
    // `execute` / builtins on every turn. The proxy waits for any
    // in-progress MCP connections to settle (5s default) before
    // returning, so a chat that just woke up still sees tools from
    // servers that are mid-handshake.
    const mcpTools = await this.sharedMcp.getAITools();

    console.log(
      `Turn starting: ${Object.keys(ctx.tools).length} base tools + ${Object.keys(mcpTools).length} MCP tools, continuation=${ctx.continuation}`,
    );

    return { tools: mcpTools };
  }

  beforeToolCall(ctx: ToolCallContext): void {
    console.log(`Tool call: ${ctx.toolName}`, JSON.stringify(ctx.input));
  }

  afterToolCall(ctx: ToolCallResultContext): void {
    if (ctx.success) {
      const resultSize = JSON.stringify(ctx.output).length;
      console.log(`Tool result: ${ctx.toolName} (${resultSize} bytes, ${ctx.durationMs}ms)`);
    } else {
      console.error(`Tool failed: ${ctx.toolName} (${ctx.durationMs}ms)`, ctx.error);
    }
  }

  onStepFinish(ctx: StepContext): void {
    if (ctx.usage) {
      console.log(
        `Step finished (${ctx.finishReason}): ${ctx.usage.inputTokens}in/${ctx.usage.outputTokens}out`,
      );
    }
  }

  async onChatResponse(result: ChatResponseResult): Promise<void> {
    console.log(`Turn ${result.status}: ${result.message.parts.length} parts`);

    // Update the sidebar preview on the parent directory. Best-effort —
    // the chat should still function if the RPC fails.
    const preview = result.message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("")
      .slice(0, 120);
    if (!preview) return;

    try {
      const directory = await this.parentAgent(AssistantDirectory);
      await directory.recordChatTurn(this.name, preview);
    } catch (err) {
      console.warn("[MyAssistant] Failed to update directory preview:", err);
    }
  }

  // No `onStart` override: MCP is shared from the parent directory
  // (see `AssistantDirectory.onStart`), schedules live on the parent,
  // and everything else per-chat (workspace proxy, extensions, session config)
  // is wired up by Think's own base `onStart` via class fields.

  /**
   * Called by `AssistantDirectory.dailySummary()` on the daily cron.
   * Queues a proactive user message so the model produces a summary on
   * the next connection/turn. Runs as an RPC from the parent — no
   * model call happens here.
   *
   * Deliberately NOT `@callable()` — parent→child DO RPC doesn't need
   * the decorator, and exposing this to browsers would let a client
   * inject a "summarize recent work" prompt on demand.
   */
  async postDailySummaryPrompt() {
    await this.saveMessages([
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [
          {
            type: "text",
            text: "Generate a brief summary of what we worked on recently. Check the workspace for any files and summarize the current state of things.",
          },
        ],
      },
    ]);
  }

  // `addServer` / `removeServer` used to live here as `@callable`
  // wrappers around `this.addMcpServer` / `this.removeMcpServer`. They
  // moved to `AssistantDirectory` so every chat shares one MCP server
  // list. The client now calls the directory directly via `useChats()`;
  // see `src/use-chats.ts`.

  @callable()
  async getResponseVersions(userMessageId: string) {
    return this.session.getBranches(userMessageId);
  }

  @callable()
  updateConfig(config: AgentConfig) {
    this.configure<AgentConfig>(config);
  }

  @callable()
  currentConfig() {
    return this.getConfig<AgentConfig>();
  }

  @callable()
  async listWorkspaceFiles(path: string = "/") {
    try {
      return await this.workspace.readDir(path);
    } catch {
      return [];
    }
  }

  @callable()
  async readWorkspaceFile(path: string) {
    try {
      return await this.workspace.readFile(path);
    } catch {
      return null;
    }
  }

  @callable()
  async listExtensions() {
    if (!this.extensionManager) return [];
    return this.extensionManager.list();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function defaultChatTitle(timestamp: number): string {
  const date = new Date(timestamp);
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  return `New chat — ${month} ${day}`;
}

function createJsonResponse(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

// ── Worker ────────────────────────────────────────────────────────────
//
// The Worker owns exactly two things:
//   1. the GitHub OAuth flow
//   2. the auth gate in front of `/chat*`, forwarding to the user's
//      AssistantDirectory. The directory's built-in sub-agent router
//      picks up the `/sub/my-assistant/:chatId` tail on its own — no
//      per-chat routing code lives here.

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/auth/login") {
        return handleGitHubLogin(request, env);
      }

      if (url.pathname === "/auth/callback") {
        return await handleGitHubCallback(request, env);
      }

      if (url.pathname === "/auth/logout") {
        if (request.method !== "POST") {
          return new Response("Method not allowed", { status: 405 });
        }
        return handleLogout(request);
      }

      if (url.pathname === "/auth/me") {
        const user = await getGitHubUserFromRequest(request, env);
        if (!user) {
          return createUnauthorizedResponse(request);
        }
        return createJsonResponse(user);
      }

      // User-scoped chat routing. The Worker, not the browser, decides
      // which AssistantDirectory DO owns this user's chats. Everything
      // below `/chat` (including sub-agent routing to a specific
      // `MyAssistant` facet) is handled by the directory's built-in
      // `Agent.fetch()` + sub-routing logic.
      if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
        const user = await getGitHubUserFromRequest(request, env);
        if (!user) {
          return createUnauthorizedResponse(request);
        }

        const directory = await getAgentByName(env.AssistantDirectory, user.login);
        return directory.fetch(request);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected auth error";
      return createJsonResponse({ error: message }, { status: 500 });
    }

    // Any other path is intentionally unhandled. We do NOT fall back
    // to `routeAgentRequest` — that would let a client reach
    // `/agents/assistant-directory/<login>` or
    // `/agents/my-assistant/<chatId>` without going through the
    // GitHub-authenticated `/chat*` gate.
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
