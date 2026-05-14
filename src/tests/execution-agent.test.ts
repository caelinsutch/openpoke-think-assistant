/**
 * Hidden execution-agent roster tests.
 *
 * These pin down the OpenPoke-style addition: execution agents are
 * durable worker facets owned by `AssistantDirectory`, but they are not
 * user-visible chats and cannot be reached directly over the sub-agent
 * HTTP/WebSocket route.
 */

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { uniqueDirectoryName } from "./helpers";

function executionAgentPath(directory: string, agentId: string): string {
  return `/agents/assistant-directory/${directory}/sub/execution-agent/${agentId}`;
}

describe("AssistantDirectory — hidden execution agents", () => {
  it("creates and lists durable execution agents separately from chats", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName()
    );

    const worker = await directory.createExecutionAgent({
      role: "research",
      title: "Vendor research",
      instructions: "Track vendor research and preserve useful comparisons."
    });

    expect(worker).toMatchObject({
      role: "research",
      title: "Vendor research",
      status: "idle"
    });

    const roster = await directory.listExecutionAgents();
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      id: worker.id,
      role: "research",
      title: "Vendor research"
    });

    const chats = await directory.createChat({ title: "Visible chat" });
    const chatRoster = (await directory.listSubAgents()).filter(
      (entry) => entry.className === "MyAssistant"
    );
    expect(chatRoster.map((entry) => entry.name)).toContain(chats.id);
  });

  it("does not allow direct routing to execution-agent facets", async () => {
    const directoryName = uniqueDirectoryName();
    const directory = await getAgentByName(
      env.AssistantDirectory,
      directoryName
    );
    const worker = await directory.createExecutionAgent({
      role: "general",
      title: "Private worker",
      instructions: "Stay hidden behind the orchestrator."
    });

    const res = await exports.default.fetch(
      `http://example.com${executionAgentPath(directoryName, worker.id)}`,
      { headers: { Upgrade: "websocket" } }
    );

    expect(res.status).toBe(404);
  });
});
