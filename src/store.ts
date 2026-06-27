import { Database } from "bun:sqlite"
import { join } from "node:path"
import { mkdirSync } from "node:fs"

export type MemoryType = "preference" | "note" | "fact" | "decision"

export type Memory = {
  id: string
  content: string
  type: MemoryType
  core: boolean
  scope: string
  embedding: Float32Array | null
  created_at: number
  expires_at: number | null
  superseded_by: string | null
  metadata: Record<string, unknown> | null
}

type Row = {
  id: string
  content: string
  type: string
  core: number
  scope: string
  embedding: Buffer | null
  created_at: number
  expires_at: number | null
  superseded_by: string | null
  metadata: string | null
}

function toMemory(row: Row): Memory {
  return {
    id: row.id,
    content: row.content,
    type: row.type as MemoryType,
    core: row.core === 1,
    scope: row.scope,
    embedding: row.embedding
      ? new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
      : null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    superseded_by: row.superseded_by,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }
}

function embeddingToBuffer(emb: Float32Array): Buffer {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength)
}

export class MemoryStore {
  private db: Database
  private coreVersion = 0

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new Database(join(dataDir, "memory.db"))
    this.db.run("PRAGMA journal_mode=WAL")
    this.db.run("PRAGMA foreign_keys=ON")
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY,
        content       TEXT NOT NULL,
        type          TEXT NOT NULL,
        core          INTEGER NOT NULL DEFAULT 0,
        scope         TEXT NOT NULL,
        embedding     BLOB,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER,
        superseded_by TEXT,
        metadata      TEXT
      )
    `)
    this.db.run("CREATE INDEX IF NOT EXISTS idx_scope_core ON memories(scope, core)")
    this.db.run("CREATE INDEX IF NOT EXISTS idx_scope_type ON memories(scope, type)")
    this.db.run("CREATE INDEX IF NOT EXISTS idx_superseded ON memories(superseded_by)")
  }

  add(input: {
    id: string
    content: string
    type: MemoryType
    core: boolean
    scope: string
    embedding: Float32Array | null
    expiresAt: number | null
    metadata?: Record<string, unknown>
  }): void {
    this.db
      .prepare(
        `INSERT INTO memories (id, content, type, core, scope, embedding, created_at, expires_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.content,
        input.type,
        input.core ? 1 : 0,
        input.scope,
        input.embedding ? embeddingToBuffer(input.embedding) : null,
        Date.now(),
        input.expiresAt,
        input.metadata ? JSON.stringify(input.metadata) : null,
      )
    if (input.core) this.coreVersion++
  }

  getCoreVersion(): number {
    return this.coreVersion
  }

  list(scope: string, opts?: { type?: MemoryType; core?: boolean }): Memory[] {
    const conditions = ["scope = ?", "(superseded_by IS NULL)"]
    const params: (string | number)[] = [scope]
    if (opts?.type) {
      conditions.push("type = ?")
      params.push(opts.type)
    }
    if (opts?.core !== undefined) {
      conditions.push("core = ?")
      params.push(opts.core ? 1 : 0)
    }
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY created_at`)
      .all(...params) as Row[]
    return rows.map(toMemory)
  }

  getCore(scope: string): Memory[] {
    return this.list(scope, { core: true })
  }

  coreCharCount(scope: string, type: MemoryType): number {
    const rows = this.db
      .prepare(
        `SELECT content FROM memories WHERE scope = ? AND core = 1 AND type = ? AND superseded_by IS NULL`,
      )
      .all(scope, type) as Pick<Row, "content">[]
    return rows.reduce((sum, r) => sum + r.content.length, 0)
  }

  search(input: {
    queryEmbedding: Float32Array
    scope: string
    limit: number
    threshold: number
    type?: MemoryType
  }): Array<Memory & { similarity: number }> {
    const conditions = [
      "scope = ?",
      "core = 0",
      "superseded_by IS NULL",
      "embedding IS NOT NULL",
    ]
    const params: (string | number)[] = [input.scope]
    if (input.type) {
      conditions.push("type = ?")
      params.push(input.type)
    }
    const now = Date.now()
    conditions.push("(expires_at IS NULL OR expires_at > ?)")
    params.push(now)

    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE ${conditions.join(" AND ")}`)
      .all(...params) as Row[]

    return rows
      .map((r) => {
        const mem = toMemory(r)
        const sim = cosineSimilarity(input.queryEmbedding, mem.embedding!)
        return { ...mem, similarity: sim }
      })
      .filter((m) => m.similarity >= input.threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, input.limit)
  }

  findSimilar(input: {
    embedding: Float32Array
    scope: string
    threshold: number
  }): Memory[] {
    const now = Date.now()
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE scope = ? AND core = 0 AND superseded_by IS NULL AND embedding IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(input.scope, now) as Row[]
    return rows
      .map((r) => {
        const mem = toMemory(r)
        return { mem, sim: cosineSimilarity(input.embedding, mem.embedding!) }
      })
      .filter((x) => x.sim >= input.threshold)
      .sort((a, b) => b.sim - a.sim)
      .map((x) => x.mem)
  }

  markSuperseded(scope: string, oldIds: string[], newId: string): void {
    if (oldIds.length === 0) return
    const placeholders = oldIds.map(() => "?").join(",")
    this.db
      .prepare(`UPDATE memories SET superseded_by = ? WHERE id IN (${placeholders}) AND scope = ?`)
      .run(newId, ...oldIds, scope)
  }

  replaceContent(scope: string, oldText: string, newText: string, type: MemoryType, newEmbedding?: Float32Array): number {
    const result = this.db
      .prepare(
        `UPDATE memories SET content = ?, embedding = ? WHERE scope = ? AND content = ? AND type = ? AND superseded_by IS NULL`,
      )
      .run(newText, newEmbedding ? embeddingToBuffer(newEmbedding) : null, scope, oldText, type)
    if (result.changes > 0) this.coreVersion++
    return result.changes
  }

  forget(scope: string, pattern: string): number {
    const escaped = pattern.replace(/[%_]/g, (m) => "\\" + m)
    const likePattern = `%${escaped}%`
    const result = this.db
      .prepare(`DELETE FROM memories WHERE scope = ? AND content LIKE ? ESCAPE '\\'`)
      .run(scope, likePattern)
    if (result.changes > 0) this.coreVersion++
    return result.changes
  }

  deleteById(scope: string, id: string): boolean {
    const result = this.db.prepare(`DELETE FROM memories WHERE id = ? AND scope = ?`).run(id, scope)
    if (result.changes > 0) this.coreVersion++
    return result.changes > 0
  }

  purgeExpired(): number {
    const now = Date.now()
    const result = this.db.prepare(`DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?`).run(now)
    return result.changes
  }

  close(): void {
    this.db.close()
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
