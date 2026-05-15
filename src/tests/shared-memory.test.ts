/**
 * Shared memory tests.
 *
 * The interaction chats (`MyAssistant` facets) and hidden execution
 * agents share one user-scoped memory surface on `AssistantDirectory`.
 * The Think Session providers in each chat proxy into these methods,
 * while execution agents inject `getSharedMemoryForPrompt()` before
 * running delegated work.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { uniqueDirectoryName } from "./helpers";

describe("AssistantDirectory — shared memory", () => {
  it("stores one durable memory block for every chat under a directory", async () => {
    const directory = await getAgentByName(env.AssistantDirectory, uniqueDirectoryName());
    await directory.createChat({ title: "A" });
    await directory.createChat({ title: "B" });

    await directory.setSharedContextBlock(
      "memory",
      "User prefers concise engineering answers. Project uses Cloudflare Agents.",
    );

    expect(await directory.getSharedContextBlock("memory")).toContain(
      "concise engineering answers",
    );
    expect(await directory.getSharedMemoryForPrompt()).toContain("Cloudflare Agents");
  });

  it("indexes shared searchable knowledge and includes its summary in memory prompts", async () => {
    const directory = await getAgentByName(env.AssistantDirectory, uniqueDirectoryName());

    await directory.setSharedSearchEntry(
      "agent-memory",
      "Cloudflare Agent Memory should be used as the shared long-term memory layer.",
    );
    await directory.setSharedSearchEntry(
      "execution-agents",
      "Execution agents must read shared memory before running delegated tasks.",
    );

    const results = await directory.searchSharedMemory("delegated tasks");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      key: "execution-agents",
    });

    const promptMemory = await directory.getSharedMemoryForPrompt();
    expect(promptMemory).toContain("KNOWLEDGE");
    expect(promptMemory).toContain("agent-memory");
    expect(promptMemory).toContain("execution-agents");
  });
});
