/**
 * Opt-in AI E2E smoke test.
 *
 * The default worker test config intentionally omits the Workers AI binding,
 * so this suite stays skipped in normal CI. To make it active, add an AI
 * binding to `src/tests/wrangler.jsonc`, run with real Cloudflare credentials,
 * and change `RUN_AI_E2E=1`.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import { uniqueDirectoryName } from "./helpers";

describe("AI E2E — execution task runner", () => {
  it("runs a durable task through a hidden execution agent", async () => {
    const directory = await getAgentByName(env.AssistantDirectory, uniqueDirectoryName("ai-e2e"));
    const worker = await directory.createExecutionAgent({
      role: "general",
      title: "AI smoke worker",
      instructions: "Return concise deterministic status reports.",
    });
    const task = await directory.createExecutionTask({
      agentId: worker.id,
      title: "Say hello",
      instructions: "Return the exact phrase: hello from execution agent",
    });

    const result = await directory.runExecutionTask(task.id);

    expect(result.status).toBe("done");
    expect(result.result?.toLowerCase()).toContain("hello");
  });

  it("fires a scheduled trigger through its durable task", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName("ai-trigger-e2e"),
    );
    const worker = await directory.createExecutionAgent({
      role: "reminder",
      title: "AI trigger worker",
      instructions: "Return concise deterministic status reports.",
    });
    const task = await directory.createExecutionTask({
      agentId: worker.id,
      title: "Triggered hello",
      instructions: "Return the exact phrase: scheduled hello from execution agent",
    });
    const trigger = await directory.createExecutionTrigger({
      agentId: worker.id,
      taskId: task.id,
      cron: "0 14 * * *",
    });

    await directory.fireExecutionTrigger({ triggerId: trigger.id });

    const [updatedTrigger] = await directory.listExecutionTriggers(worker.id);
    expect(updatedTrigger.lastRunAt).toBeTypeOf("number");

    const [updatedTask] = await directory.listExecutionTasks(worker.id);
    expect(updatedTask.status).toBe("done");
    expect(updatedTask.lastRunAt).toBeTypeOf("number");
    expect(updatedTask.result?.toLowerCase()).toContain("scheduled hello");
  });
});

describe("AI E2E — Vectorize memory", () => {
  it("recalls a memory through the Vectorize-backed memory profile", async () => {
    const directory = await getAgentByName(
      env.AssistantDirectory,
      uniqueDirectoryName("vector-memory-e2e"),
    );
    const marker = `Vectorize E2E marker ${crypto.randomUUID()}`;

    await directory.rememberMemory({
      content: `${marker}: semantic memory belongs in Cloudflare Vectorize.`,
    });

    let result = await directory.recallMemory("semantic memory belongs in Cloudflare Vectorize", {
      limit: 10,
    });
    for (
      let attempt = 0;
      attempt < 30 && !result.vectorMemories?.some((memory) => memory.content.includes(marker));
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      result = await directory.recallMemory("semantic memory belongs in Cloudflare Vectorize", {
        limit: 10,
      });
    }

    expect(result.vectorMemories?.map((memory) => memory.content).join("\n")).toContain(marker);
  });
});
