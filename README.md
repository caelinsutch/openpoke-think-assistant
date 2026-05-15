# OpenPoke Think Assistant

An OpenPoke-style orchestrator assistant built with `@cloudflare/think` and
the sub-agent routing primitive from `agents`. The visible chat acts as the interaction agent, while hidden execution agents own durable work threads.

## What this demonstrates

- **OpenPoke-style execution agents** — visible `MyAssistant` chats can list, create, and delegate to hidden `ExecutionAgent` facets. Execution agents persist their role, instructions, event log, and latest result so follow-up work can route back to the same durable worker thread.
- **Durable tasks and cron triggers** — `AssistantDirectory` stores task and trigger records, schedules cron triggers from the parent, and routes triggered runs back to the owning execution agent.
- **Orchestration panel** — the sidebar has an **Orchestration** drawer for inspecting execution agents, creating durable tasks, attaching cron triggers, and manually running tasks without prompting the assistant to call tools.
- **Multi-session via sub-agent routing** — each user gets an `AssistantDirectory`
  parent DO that owns the sidebar and shared memory. Each chat is its own `MyAssistant` facet
  (full Think DO — own extensions and messages). Addressed transparently
  via `useAgent({ sub: [{ agent: "MyAssistant", name: chatId }] })`
- **Shared workspace across chats** — `AssistantDirectory` owns one `Workspace`
  backed by its SQLite; every `MyAssistant` child gets a `SharedWorkspace`
  proxy that forwards file I/O to the parent. A `hello.txt` written in chat A
  is visible verbatim in chat B. The proxy swaps in via the `WorkspaceFsLike`
  type exported by `@cloudflare/shell` — no casts; builtin workspace tools
  AND codemode's `state.*` sandbox API both route through it
- **Shared MCP across chats** — server registry, OAuth credentials, live
  connections, and tool descriptors all live on `AssistantDirectory`. Auth
  to a server once (e.g. GitHub MCP) and every chat sees its tools. Each
  child carries a `SharedMCPClient` proxy that builds per-turn MCP tool
  sets via one DO RPC hop to the parent. `useChats()` surfaces
  `mcpState` / `addMcpServer` / `removeMcpServer` so the MCP panel is
  the same across chats and open tabs
- **Live cross-chat file updates** — the directory's `Workspace` is wired
  with `onChange` → `broadcast`, so every open tab's file browser updates
  live whenever any chat writes, edits, or deletes a file. `useChats()`
  surfaces it as a `workspaceRevision` counter for `useEffect` deps
- **Think base class** — `getModel()`, `configureSession()`, `getTools()`, `maxSteps` for a batteries-included agent
- **Built-in workspace** — file tools (read, write, edit, find, grep, delete) auto-wired on every turn
- **Sandboxed code execution** — `createExecuteTool` lets the LLM write and run JavaScript in a Dynamic Worker via `@cloudflare/codemode`
- **Self-authored extensions** — `extensionLoader` + `createExtensionTools` let the agent create new tools at runtime
- **Shared persistent memory** — `AssistantDirectory` exposes a `MemoryProfile` API modeled after Cloudflare Agent Memory (`remember`, `recall`, `ingest`, `list`, `forget`). `MyAssistant` exposes explicit memory tools, execution agents inject the same memory summary before running tasks, and the Think context block is only a read-only prompt summary.
- **Non-destructive compaction** — older messages summarized when context overflows, originals preserved
- **Hybrid memory retrieval** — durable records live in the directory DO's SQLite store with FTS5 keyword search, and semantic recall is backed by Cloudflare Vectorize plus Workers AI embeddings.
- **Dynamic configuration** — typed `AgentConfig` with model tier and persona, persisted in SQLite
- **Server-side tools** — `getWeather`, `calculate` execute on the server
- **Client-side tools** — `getUserTimezone` runs in the browser via `onToolCall`
- **Tool approval** — `calculate` requires user approval for large numbers
- **MCP integration** — connect external tool servers; tools appear in every chat automatically (shared at the directory level)
- **Lifecycle hooks** — `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChatResponse`
- **Durable chat recovery** — `chatRecovery` wraps turns in fibers for crash recovery
- **Parent-owned scheduled work** — daily summary scheduled from the directory (facets can't own schedules), fans out to the most recently active chat
- **Regeneration with branch navigation** — v1/v2/v3 response versions via `getBranches`
- **Stream resumption** — page refresh replays the active stream (built into Think)
- **useAgentChat** — Think speaks the same CF_AGENT protocol as AIChatAgent
- **GitHub OAuth** — users sign in with GitHub; the Worker owns all DO naming, so each user gets their own directory + isolated chats

## How to run

### 1. Optional: create a GitHub OAuth App

For local development, GitHub OAuth is optional. If `GITHUB_CLIENT_ID` or `GITHUB_CLIENT_SECRET` is missing, the app uses a mock `local-dev` user so you can run the assistant immediately.

To test real GitHub auth, create an OAuth App at [GitHub OAuth Apps](https://github.com/settings/developers) and set:

- **Homepage URL:** `http://localhost:5173`
- **Authorization callback URL:** `http://localhost:5173/auth/callback`

Then copy `.env.example` to `.env` and fill in `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### 2. Start the app

```sh
bun install
bun run start
```

Open the app, click **Sign in with GitHub**, approve the OAuth flow, and you
will land in the Think assistant scoped to your GitHub login.

### 3. Test orchestration

Use the sidebar **Orchestration** button to open the control panel. From there you can:

- Create hidden execution agents with a role, title, and persistent instructions.
- Create durable tasks owned by those agents.
- Create cron triggers such as `0 14 * * *` to schedule a task from the parent directory.
- Click **Run now** on a task to route it through the owning execution agent immediately.

You can still test the same flow through chat by asking the assistant to use its orchestration tools, or through the worker tests:

```sh
bun run test
bun run test:e2e
```

### 4. Set up Vectorize memory

The fallback memory backend uses Cloudflare Vectorize for semantic recall and Workers AI for embeddings. Create the index before deploying or running the remote AI E2E suite:

```sh
npx wrangler vectorize create think-assistant-memory --dimensions=768 --metric=cosine
```

The binding is configured as `MEMORY_VECTORIZE` in `wrangler.jsonc` with `remote: true`, because Vectorize is a remote-only binding in local development. The local unit tests use a fake Vectorize binding object to verify the memory API without touching Cloudflare. The remote E2E verifies the real Vectorize path:

```sh
RUN_AI_E2E=1 bunx vitest --run --config src/tests/vitest.ai.config.ts -t "Vectorize memory"
```

## Architecture

```
AssistantDirectory ("alice")            ◄── one DO per authenticated GitHub user
  ├─ MyAssistant[chat-abc]   [facet]    ◄── each chat is its own Think DO
  ├─ MyAssistant[chat-def]   [facet]
  └─ MyAssistant[chat-ghi]   [facet]
```

`AssistantDirectory` owns the chat list, the sidebar state, the shared
workspace, the shared MCP registry (servers, OAuth creds, live
connections), and any cross-chat concerns (e.g. the daily-summary
schedule — facets can't `schedule()` so the parent does it and fans
out). `MyAssistant` is a Think DO per conversation, with its own
SQLite storage, extensions, and message history — plus a
`SharedWorkspace` proxy and a `SharedMCPClient` proxy that route file
operations and MCP tool invocations back to the directory.

The browser never chooses a DO name. It connects to `/chat` (the
directory) and `/chat/sub/my-assistant/<chatId>` (a specific chat), and
the Worker resolves the `AssistantDirectory` instance from the
authenticated GitHub cookie:

```ts
if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
  const user = await getGitHubUserFromRequest(request);
  if (!user) return createUnauthorizedResponse(request);
  const directory = await getAgentByName(env.AssistantDirectory, user.login);
  return directory.fetch(request);
}
```

The directory's built-in sub-agent router picks up the
`/sub/my-assistant/<chatId>` tail — no per-chat plumbing lives in the
Worker. Access control lives on the parent via `onBeforeSubAgent` as a
strict registry gate:

```ts
override async onBeforeSubAgent(_req, { className, name }) {
  if (!this.hasSubAgent(className, name)) {
    return new Response("Not found", { status: 404 });
  }
}
```

On the client, `useChats()` (a local hook in `src/use-chats.ts`) wraps
the sidebar connection and RPCs. Each chat pane uses
`useAgent({ agent: "AssistantDirectory", basePath: "chat", sub: [{ agent: "MyAssistant", name: chatId }] })`.
See `examples/multi-ai-chat` for the minimal AIChatAgent version of the
same pattern.

### Shared workspace

Each `MyAssistant` overrides `this.workspace` with a `SharedWorkspace`
proxy that forwards every call to `AssistantDirectory.workspace` over
a DO RPC hop:

```ts
class MyAssistant extends Think<Env> {
  override workspace: WorkspaceFsLike = new SharedWorkspace(this);

  getTools() {
    return {
      execute: createExecuteTool({
        tools: createWorkspaceTools(this.workspace),
        // state.* in the sandbox also hits the shared workspace,
        // because SharedWorkspace satisfies WorkspaceFsLike.
        state: createWorkspaceStateBackend(this.workspace),
        loader: this.env.LOADER,
      }),
      // ...
    };
  }
}

class SharedWorkspace implements WorkspaceFsLike {
  readFile(p) {
    return (await this.parent()).readFile(p);
  }
  writeFile(p, c) {
    return (await this.parent()).writeFile(p, c);
  }
  // ...readFileBytes / writeFileBytes / appendFile / exists / stat /
  //    lstat / mkdir / readDir / rm / cp / mv / symlink / readlink / glob
}
```

The proxy satisfies `@cloudflare/shell`'s `WorkspaceFsLike` interface,
which is a strict superset of `@cloudflare/think`'s `WorkspaceLike`.
That one type annotation unlocks two things at once:

- **All of Think's workspace-aware machinery** (`createWorkspaceTools`,
  lifecycle hooks, the builtin `listWorkspaceFiles` /
  `readWorkspaceFile` RPCs) works unchanged against the proxy.
- **Codemode's `state.*` sandbox API** works too, via
  `createWorkspaceStateBackend(this.workspace)`. Multi-file operations
  like `state.planEdits` and `state.applyEdits` run against the shared
  workspace, so a plan composed in one chat can mutate files another
  chat just created.

The parent DO and the child facet live on the same machine, so each
RPC hop is in-process and cheap (no network, no serialization across
external links).

### Shared memory

Memory is shared at the `AssistantDirectory` level, not owned by individual chat facets. The public app-facing surface is `MemoryProfile` in `src/memory.ts`:

```ts
type MemoryProfile = {
  remember(input: { content: string; sessionId?: string }): Promise<{ id: string }>;
  recall(query: string, opts?: { limit?: number }): Promise<MemoryRecallResult>;
  ingest(messages: MemoryMessage[], opts?: { sessionId?: string }): Promise<void>;
  list(opts?: { limit?: number }): Promise<MemoryRecord[]>;
  forget(id: string): Promise<void>;
  summarizeForPrompt(): Promise<string>;
};
```

That shape intentionally resembles Cloudflare Agent Memory's profile API, so swapping the local fallback for a managed `env.MEMORY.getProfile(...)` implementation should be isolated to the provider layer.

The current fallback uses two retrieval paths:

- `SqliteMemoryStore` writes durable records into the directory DO and indexes them with FTS5 for keyword recall.
- `VectorizeMemoryStore` embeds records with Workers AI (`@cf/baai/bge-base-en-v1.5`) and writes vectors to `MEMORY_VECTORIZE` for semantic recall, using the directory name as the Vectorize namespace so each user/workspace recalls only its own vectors.

`recall()` fuses text and vector results by memory id. `MyAssistant` exposes explicit tools (`remember_memory`, `recall_memory`, `list_memory`, `forget_memory`) instead of letting Think's context block own writes. The `memory` context block remains useful, but only as a compact read-only prompt summary that tells the model memory exists and when to call retrieval.

Execution agents call `getSharedMemoryForPrompt()` before every delegated task, so the hidden worker sees the same user/project memory as the visible interaction agent without relying on shared model context.

**Trade-offs worth knowing:**

- _Every chat can see every chat's files._ That's the design — a
  multi-chat assistant should remember what it wrote in previous
  chats. If you fork this for a less-trusted surface (e.g. public
  guests), gate access in `AssistantDirectory` instead of exposing the
  workspace methods directly.
- _Extensions, messages, Think config, and branch history stay
  per-chat._ The workspace and the MCP registry are shared; everything
  else lives in each child DO's own storage. Extensions in particular
  persist to `ctx.storage` (not the workspace), so a tool authored in
  chat A isn't auto-available in chat B. That's a sensible default for
  this demo — extensions are "this chat's custom tools" — but if you
  want a fork where extensions cross chats too, move their persistence
  into the parent directory DO alongside the workspace and MCP
  registry.
- _Extensions with `workspace: "read-write"` permissions inherit the
  same reach._ The shell-level permission model is about what _the
  LLM_ can do inside a single chat; it doesn't distinguish between
  "this chat's files" and "this user's files" because the underlying
  `Workspace` doesn't either. For the assistant example this is what
  we actually want. For other apps — e.g. a hostile-code sandbox —
  consider giving each chat its own non-shared workspace by removing
  the override in `MyAssistant`.
- _Serialization is per-file, not per-turn._ Two chats writing to the
  same path queue behind each other in the parent DO's single-threaded
  isolate, which is the usual semantics you'd want.
- _Change events fan out to every client, but not to sibling chats._
  `AssistantDirectory.workspace` is constructed with `onChange: (ev)
=> this.broadcast(...)`, so every file mutation reaches every client
  connected to the directory — that's every browser tab the user has
  open, across every chat. `useChats()` translates those broadcasts
  into a `workspaceRevision` counter that chat panes pass into their
  file-browser effects, so a write in chat A lights up chat B's files
  list live. The parent does _not_ RPC events into sibling child
  facets — no server-side tool in this example reacts to another
  chat's writes. Add a parent → child RPC if that use case shows up.

### Shared MCP

MCP follows the same pattern as the workspace: the registry, OAuth
credentials, live connections, and tool caches all live on
`AssistantDirectory`. Each child carries a `SharedMCPClient` proxy
that RPCs the parent on each turn:

```ts
class MyAssistant extends Think<Env> {
  sharedMcp = new SharedMCPClient(this);

  async beforeTurn(ctx) {
    // Splice the directory's shared MCP tools into this turn.
    return { tools: await this.sharedMcp.getAITools() };
  }
}

class SharedMCPClient {
  async getAITools(timeoutMs = 5_000): Promise<ToolSet> {
    const parent = await this.parent();
    // Wait up to `timeoutMs` for any in-progress connections; returns
    // only tools from servers that are ready.
    const descriptors = await parent.listMcpToolDescriptors(timeoutMs);
    return buildToolSet(descriptors, (serverId, name, args) =>
      parent.callMcpTool(serverId, name, args),
    );
  }
}
```

OAuth callback URL is `/chat/mcp-callback` — one URL for every
server across every chat. The Worker's existing `/chat*` gate
forwards it to the directory; `Agent._onRequest` dispatches to
`handleMcpOAuthCallback`, which uses `mcp.isCallbackRequest` to
match on stored callback URLs. Token lives in the directory's DO
storage via `DurableObjectOAuthClientProvider`.

Browser-side, `useChats()` exposes `mcpState`, `addMcpServer`,
`removeMcpServer`, sourced from the directory's
`CF_AGENT_MCP_SERVERS` broadcasts. The MCP panel in each `Chat`
reads these from props, so every tab sees the same server list in
real time.

**Trade-offs worth knowing:**

- _Every chat can call every MCP tool you've connected._ Same model
  as the workspace — this is the point of a multi-chat assistant. If
  you need per-chat tool gating, filter in `SharedMCPClient.getAITools`
  using the existing `getAITools(filter?)` signature on
  `MCPClientManager` as a template.
- _Each tool invocation is one extra DO RPC hop._ Same machine,
  in-process, cheap. If an MCP tool call is network-bound (most are),
  the added hop is noise.
- _The parent's isolate is the serialization point._ Two chats
  calling tools at the same time interleave in the parent's JS event
  loop (single-threaded DO isolate). MCP tools usually await network,
  so they don't block each other in practice, but the parent is
  technically the user's MCP fan-in point.
- _Connection count per user = server count._ The directory keeps
  one live connection per registered server. SSE-style MCP transports
  are lightweight but still real. Worth knowing before forking this
  for users who register dozens of servers.
- _OAuth callbacks on this URL require an authenticated GitHub
  session._ Callbacks come back to the same origin in the user's
  browser, so the GitHub session cookie is present; the Worker's
  existing `/chat*` gate validates it before forwarding to the
  directory. Unauthenticated probes to `/chat/mcp-callback` 401.

## Deploying

Create or update your GitHub OAuth App so it also has your production
callback URL:

```text
https://your-domain.example/auth/callback
```

Set the secrets:

```sh
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
```

Deploy:

```sh
bun run deploy
```

## Key code

**Server** (`src/server.ts`):

```typescript
export class AssistantDirectory extends Agent<Env, DirectoryState> {
  // Strict registry gate — clients can only reach chats this
  // directory spawned via `createChat`.
  override async onBeforeSubAgent(_req, { className, name }) {
    if (!this.hasSubAgent(className, name)) {
      return new Response("Not found", { status: 404 });
    }
  }

  @callable()
  async createChat() {
    const id = nanoid(10);
    await this.subAgent(MyAssistant, id); // spawn the facet
    /* ... persist meta, refresh sidebar ... */
  }
}

export class MyAssistant extends Think<Env> {
  chatRecovery = true;
  extensionLoader = this.env.LOADER;

  getModel() {
    /* model tier from config */
  }
  configureSession(session) {
    /* persona, read-only memory summary, compaction */
  }
  getTools() {
    /* execute, extensions, memory, orchestration, getWeather, calculate, ... */
  }

  // Each turn updates the parent's sidebar preview via the
  // typed `parentAgent(AssistantDirectory)` stub.
  async onChatResponse(result) {
    const directory = await this.parentAgent(AssistantDirectory);
    await directory.recordChatTurn(this.name, extractPreview(result));
  }
}
```

**Client** (`src/client.tsx`) — `useChats()` (a local prototype in
`src/use-chats.ts`) drives the sidebar; each chat pane uses
`useAgentChat` from `@cloudflare/ai-chat/react` over a sub-routed
`useAgent` connection.

## Related

- [Think docs](../../docs/think/index.md)
- [Think tools](../../docs/think/tools.md)
- [Think lifecycle hooks](../../docs/think/lifecycle-hooks.md)
