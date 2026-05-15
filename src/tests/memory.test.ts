import { describe, expect, it } from "vitest";
import {
  InMemoryMemoryStore,
  MemoryProfileImpl,
  VectorizeMemoryStore,
  type EmbeddingModel,
  type MemoryStore,
} from "../memory";

class FakeEmbeddingModel implements EmbeddingModel {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      return [
        normalized.includes("cloudflare") || normalized.includes("edge") ? 1 : 0,
        normalized.includes("delegated") || normalized.includes("execution") ? 1 : 0,
        normalized.includes("preference") || normalized.includes("concise") ? 1 : 0,
      ];
    });
  }
}

class FakeVectorizeIndex implements Pick<Vectorize, "upsert" | "query" | "deleteByIds"> {
  #vectors = new Map<string, number[]>();

  async upsert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation> {
    for (const vector of vectors) {
      this.#vectors.set(vector.id, [...(vector.values as number[])]);
    }
    return { mutationId: crypto.randomUUID() };
  }

  async query(vector: number[], options?: VectorizeQueryOptions): Promise<VectorizeMatches> {
    const matches = [...this.#vectors.entries()]
      .map(([id, values]) => ({
        id,
        score: dot(vector, values),
      }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, options?.topK ?? 10);
    return { count: matches.length, matches };
  }

  async deleteByIds(ids: string[]): Promise<VectorizeAsyncMutation> {
    for (const id of ids) this.#vectors.delete(id);
    return { mutationId: crypto.randomUUID() };
  }
}

describe("MemoryProfile", () => {
  it("remembers, recalls, ingests, lists, and forgets memories without a DO", async () => {
    const store = new InMemoryMemoryStore();
    const profile = createProfile(store);

    const first = await profile.remember({
      content: "User prefers concise engineering answers.",
      sessionId: "chat-a",
    });
    await profile.ingest([
      { role: "user", content: "Use Cloudflare Vectorize for semantic memory." },
    ]);

    expect((await profile.list()).map((memory) => memory.id)).toContain(first.id);
    expect((await profile.recall("concise")).result).toContain("concise engineering");
    expect(await profile.summarizeForPrompt()).toContain("Use recall_memory");

    await profile.forget(first.id);
    expect((await profile.recall("concise")).memories).toHaveLength(0);
  });

  it("uses Vectorize results in recall alongside text search", async () => {
    const store = new InMemoryMemoryStore();
    const profile = createProfile(store);

    await profile.remember({
      content: "OpenPoke work should run on the Cloudflare edge.",
    });
    await profile.remember({
      content: "Execution agents own delegated tasks.",
    });

    const result = await profile.recall("edge runtime", { limit: 5 });

    expect(result.vectorMemories?.map((memory) => memory.content)).toContain(
      "OpenPoke work should run on the Cloudflare edge.",
    );
    expect(result.memories.map((memory) => memory.content)).toContain(
      "OpenPoke work should run on the Cloudflare edge.",
    );
  });
});

function createProfile(store: MemoryStore) {
  return new MemoryProfileImpl(
    store,
    new VectorizeMemoryStore(new FakeVectorizeIndex(), new FakeEmbeddingModel(), store, "test"),
  );
}

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
}
