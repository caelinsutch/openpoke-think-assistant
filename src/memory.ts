export type MemoryMessage = {
  role: string;
  content: string;
};

export type MemoryRecord = {
  id: string;
  content: string;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
};

export type MemoryRecallResult = {
  result: string;
  memories: MemoryRecord[];
  vectorMemories?: MemoryRecord[];
  textMemories?: MemoryRecord[];
};

export type MemoryRememberResult = {
  id: string;
};

export interface MemoryProfile {
  remember(input: { content: string; sessionId?: string }): Promise<MemoryRememberResult>;
  recall(query: string, opts?: { limit?: number }): Promise<MemoryRecallResult>;
  ingest(messages: MemoryMessage[], opts?: { sessionId?: string }): Promise<void>;
  list(opts?: { limit?: number }): Promise<MemoryRecord[]>;
  forget(id: string): Promise<void>;
  summarizeForPrompt(): Promise<string>;
}

export interface MemoryStore {
  ensure(): void;
  upsert(record: MemoryRecord): void;
  search(query: string, limit: number): MemoryRecord[];
  list(limit: number): MemoryRecord[];
  delete(id: string): void;
}

export interface VectorMemoryStore {
  upsert(record: MemoryRecord): Promise<void>;
  search(query: string, limit: number): Promise<MemoryRecord[]>;
  delete(id: string): Promise<void>;
}

export interface EmbeddingModel {
  embed(texts: string[]): Promise<number[][]>;
}

type SqlTag = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => T[];

export class MemoryProfileImpl implements MemoryProfile {
  constructor(
    private store: MemoryStore,
    private vectorStore?: VectorMemoryStore,
  ) {}

  async remember(input: { content: string; sessionId?: string }): Promise<MemoryRememberResult> {
    const content = input.content.trim();
    if (!content) throw new Error("Memory content is required");

    const now = Date.now();
    const id = `mem_${crypto.randomUUID()}`;
    this.store.ensure();
    this.store.upsert({
      id,
      content,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
    });
    await this.vectorStore?.upsert({
      id,
      content,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
    });
    return { id };
  }

  async recall(query: string, opts?: { limit?: number }): Promise<MemoryRecallResult> {
    const limit = opts?.limit ?? 10;
    this.store.ensure();
    const textMemories = this.store.search(query, limit);
    const vectorMemories = (await this.vectorStore?.search(query, limit)) ?? [];
    const memories = mergeMemoryResults([textMemories, vectorMemories], limit);
    return {
      memories,
      textMemories,
      vectorMemories,
      result:
        memories.length === 0
          ? "No relevant memories found."
          : memories.map((memory) => `[${memory.id}]\n${memory.content}`).join("\n\n"),
    };
  }

  async ingest(messages: MemoryMessage[], opts?: { sessionId?: string }): Promise<void> {
    this.store.ensure();
    for (const message of messages) {
      const content = message.content.trim();
      if (!content) continue;
      await this.remember({
        content: `${message.role}: ${content}`,
        sessionId: opts?.sessionId,
      });
    }
  }

  async list(opts?: { limit?: number }): Promise<MemoryRecord[]> {
    this.store.ensure();
    return this.store.list(opts?.limit ?? 20);
  }

  async forget(id: string): Promise<void> {
    this.store.ensure();
    this.store.delete(id);
    await this.vectorStore?.delete(id);
  }

  async summarizeForPrompt(): Promise<string> {
    const memories = await this.list({ limit: 20 });
    if (memories.length === 0) {
      return "No memories stored yet. Use remember_memory for durable facts and recall_memory for retrieval.";
    }
    return [
      `${memories.length} recent memories available. Use recall_memory for specific details.`,
      ...memories.slice(0, 8).map((memory) => `- ${memory.content}`),
    ].join("\n");
  }
}

function mergeMemoryResults(resultSets: MemoryRecord[][], limit: number): MemoryRecord[] {
  const byId = new Map<string, MemoryRecord>();
  for (const records of resultSets) {
    for (const record of records) {
      if (!byId.has(record.id)) byId.set(record.id, record);
    }
  }
  return [...byId.values()].slice(0, limit);
}

export class SqliteMemoryStore implements MemoryStore {
  #initialized = false;

  constructor(private sql: SqlTag) {}

  ensure(): void {
    if (this.#initialized) return;
    void this.sql`CREATE TABLE IF NOT EXISTS memory_records (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    void this.sql`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts
      USING fts5(
        id UNINDEXED,
        content,
        tokenize='porter unicode61'
      )
    `;
    this.#initialized = true;
  }

  upsert(record: MemoryRecord): void {
    this.ensure();
    this.deleteFTS(record.id);
    void this.sql`
      INSERT INTO memory_records (id, content, session_id, created_at, updated_at)
      VALUES (
        ${record.id},
        ${record.content},
        ${record.sessionId ?? null},
        ${record.createdAt},
        ${record.updatedAt}
      )
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `;
    void this.sql`
      INSERT INTO memory_records_fts (id, content)
      VALUES (${record.id}, ${record.content})
    `;
  }

  search(query: string, limit: number): MemoryRecord[] {
    this.ensure();
    const sanitized = query
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => `"${word.replace(/"/g, '""')}"`)
      .join(" ");
    if (!sanitized) return this.list(limit);

    try {
      return this.sql<MemoryRecord>`
        SELECT r.id, r.content, r.session_id as sessionId, r.created_at as createdAt, r.updated_at as updatedAt
        FROM memory_records_fts f
        JOIN memory_records r ON r.id = f.id
        WHERE memory_records_fts MATCH ${sanitized}
        ORDER BY rank
        LIMIT ${limit}
      `;
    } catch {
      return [];
    }
  }

  list(limit: number): MemoryRecord[] {
    this.ensure();
    return this.sql<MemoryRecord>`
      SELECT id, content, session_id as sessionId, created_at as createdAt, updated_at as updatedAt
      FROM memory_records
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
  }

  delete(id: string): void {
    this.ensure();
    this.deleteFTS(id);
    void this.sql`DELETE FROM memory_records WHERE id = ${id}`;
  }

  private deleteFTS(id: string): void {
    const rows = this.sql<{ rowid: number }>`
      SELECT rowid FROM memory_records_fts WHERE id = ${id}
    `;
    for (const row of rows) {
      void this.sql`DELETE FROM memory_records_fts WHERE rowid = ${row.rowid}`;
    }
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  #records = new Map<string, MemoryRecord>();

  ensure(): void {}

  upsert(record: MemoryRecord): void {
    this.#records.set(record.id, record);
  }

  search(query: string, limit: number): MemoryRecord[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const records = this.list(Number.MAX_SAFE_INTEGER);
    if (terms.length === 0) return records.slice(0, limit);
    return records
      .map((record) => ({
        record,
        score: terms.reduce(
          (score, term) => score + (record.content.toLowerCase().includes(term) ? 1 : 0),
          0,
        ),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
      .slice(0, limit)
      .map(({ record }) => record);
  }

  list(limit: number): MemoryRecord[] {
    return [...this.#records.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  delete(id: string): void {
    this.#records.delete(id);
  }
}

type VectorizeIndexLike = Pick<Vectorize, "upsert" | "query" | "deleteByIds">;

export class WorkersAIEmbeddingModel implements EmbeddingModel {
  constructor(
    private ai: Ai,
    private model = "@cf/baai/bge-base-en-v1.5",
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = (await this.ai.run(this.model, { text: texts })) as {
      data?: number[][];
    };
    if (!Array.isArray(response.data)) {
      throw new Error("Workers AI embedding response did not include data");
    }
    return response.data;
  }
}

export class VectorizeMemoryStore implements VectorMemoryStore {
  constructor(
    private index: VectorizeIndexLike,
    private embeddings: EmbeddingModel,
    private records: Pick<MemoryStore, "list">,
    private namespace: string,
  ) {}

  async upsert(record: MemoryRecord): Promise<void> {
    const [values] = await this.embeddings.embed([record.content]);
    if (!values) throw new Error("Embedding model returned no vector");
    await this.index.upsert([
      {
        id: record.id,
        namespace: this.namespace,
        values,
        metadata: {
          sessionId: record.sessionId ?? "",
          updatedAt: record.updatedAt,
        },
      },
    ]);
  }

  async search(query: string, limit: number): Promise<MemoryRecord[]> {
    const [values] = await this.embeddings.embed([query]);
    if (!values) return [];
    const matches = await this.index.query(values, {
      topK: limit,
      namespace: this.namespace,
      returnMetadata: "none",
    });
    const ids = matches.matches.map((match) => match.id);
    if (ids.length === 0) return [];
    const recordsById = new Map(
      this.records.list(Math.max(limit * 4, 50)).map((record) => [record.id, record]),
    );
    return ids.flatMap((id) => {
      const record = recordsById.get(id);
      return record ? [record] : [];
    });
  }

  async delete(id: string): Promise<void> {
    await this.index.deleteByIds([id]);
  }
}
