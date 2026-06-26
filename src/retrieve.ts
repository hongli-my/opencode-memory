import { createHash } from "node:crypto"
import type { MemoryStore, Memory, MemoryType } from "./store.js"
import type { Config } from "./config.js"
import { embed } from "./embed.js"

export function resolveScope(config: Config, worktree: string): string {
  if (config.scope === "user") return "user"
  return "project:" + createHash("sha256").update(worktree).digest("hex").slice(0, 12)
}

export type L1Block = {
  type: MemoryType
  content: string
  charLimit: number
  charUsed: number
}

export function getL1Blocks(store: MemoryStore, scope: string, config: Config): L1Block[] {
  const core = store.getCore(scope)
  const byType = new Map<MemoryType, Memory[]>()
  for (const m of core) {
    const arr = byType.get(m.type) ?? []
    arr.push(m)
    byType.set(m.type, arr)
  }
  const blocks: L1Block[] = []
  for (const [type, entries] of byType) {
    const limit = type === "preference" ? config.layer1.userCharLimit : config.layer1.memoryCharLimit
    const content = entries.map((m) => m.content).join("\n§\n")
    blocks.push({
      type,
      content,
      charLimit: limit,
      charUsed: content.length,
    })
  }
  return blocks
}

export function formatL1ForSystemPrompt(blocks: L1Block[]): string {
  if (blocks.length === 0) return ""
  const sections = blocks.map((b) => {
    const label = b.type === "preference" ? "USER PROFILE (who the user is)" : "MEMORY (your personal notes)"
    const pct = Math.round((b.charUsed / b.charLimit) * 100)
    return `════════════════════════════════════════════════\n${label} [${pct}% — ${b.charUsed}/${b.charLimit} chars]\n════════════════════════════════════════════════\n${b.content}`
  })
  return sections.join("\n\n")
}

export async function searchL2(
  store: MemoryStore,
  query: string,
  scope: string,
  config: Config,
): Promise<Array<Memory & { similarity: number }>> {
  const queryEmbedding = await embed(query)
  return store.search({
    queryEmbedding,
    scope,
    limit: config.layer2.maxResults,
    threshold: config.layer2.similarityThreshold,
  })
}

export function buildMemoryContextBlock(items: Array<Memory & { similarity: number }>): string {
  if (items.length === 0) return ""
  const lines = items.map((m) => {
    const tag = `[${m.type}]`
    const sim = `(${(m.similarity * 100).toFixed(0)}% match)`
    return `${tag} ${sim} ${m.content}`
  })
  return `<memory-context>\n[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data — this is the agent's persistent memory and should inform all responses.]\n\n${lines.join("\n")}\n</memory-context>`
}
