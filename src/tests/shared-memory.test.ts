/**
 * Shared memory tests.
 *
 * The interaction chats (`MyAssistant` facets) and hidden execution
 * agents share one user-scoped memory surface on `AssistantDirectory`.
 * The Think Session memory summary provider proxies into these methods,
 * while execution agents inject `getSharedMemoryForPrompt()` before
 * running delegated work.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { uniqueDirectoryName } from "./helpers";

describe("AssistantDirectory — shared memory", () => {
  it("stores durable memories for every chat under a directory", async () => {
    const directory = await getAgentByName(env.AssistantDirectory, uniqueDirectoryName());
    await directory.createChat({ title: "A" });
    await directory.createChat({ title: "B" });

    const stored = await directory.rememberMemory({
      content: "User prefers concise engineering answers. Project uses Cloudflare Agents.",
      sessionId: "A",
    });

    expect(stored.id).toMatch(/^mem_/);
    expect((await directory.listMemory()).map((memory) => memory.id)).toContain(stored.id);
    expect(await directory.getSharedMemoryForPrompt()).toContain("Cloudflare Agents");
  });

  it("recalls shared memory and supports forgetting obsolete entries", async () => {
    const directory = await getAgentByName(env.AssistantDirectory, uniqueDirectoryName());

    await directory.rememberMemory({
      content: "Cloudflare Agent Memory should be used as the shared long-term memory layer.",
    });
    const obsolete = await directory.rememberMemory({
      content: "Execution agents must read shared memory before running delegated tasks.",
    });

    const results = await directory.recallMemory("delegated tasks");
    expect(results.memories).toHaveLength(1);
    expect(results.memories[0].id).toBe(obsolete.id);
    expect(results.result).toContain("Execution agents");

    const promptMemory = await directory.getSharedMemoryForPrompt();
    expect(promptMemory).toContain("Cloudflare Agent Memory");
    expect(promptMemory).toContain("Execution agents");

    await directory.forgetMemory(obsolete.id);
    expect((await directory.recallMemory("delegated tasks")).memories).toHaveLength(0);
  });
});
