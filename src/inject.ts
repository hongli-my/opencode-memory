import { randomUUID } from "node:crypto"
import type { MemoryStore } from "./store.js"
import type { Config } from "./config.js"
import { getL1Blocks, formatL1ForSystemPrompt, searchL2, buildMemoryContextBlock, resolveScope } from "./retrieve.js"
import { MEMORY_GUIDANCE, buildNudge, buildCompactionFlush } from "./prompt.js"

type SystemTransformInput = { sessionID?: string; model: unknown }
type SystemTransformOutput = { system: string[] }
type MessagesTransformOutput = {
  messages: Array<{
    info: { id: string; sessionID: string; role: string }
    parts: Array<Record<string, unknown>>
  }>
}
type CompactingOutput = { context: string[]; prompt?: string }

export class InjectionManager {
  private store: MemoryStore
  private config: Config
  private worktree: string
  private l1SnapshotCache = new Map<string, string>()
  private turnCounts = new Map<string, number>()
  private embedCache = new Map<string, Float32Array>()

  constructor(store: MemoryStore, config: Config, worktree: string) {
    this.store = store
    this.config = config
    this.worktree = worktree
  }

  onSystemTransform(input: SystemTransformInput, output: SystemTransformOutput): void {
    const sessionID = input.sessionID ?? "_default"
    const scope = resolveScope(this.config, this.worktree)

    if (!this.l1SnapshotCache.has(sessionID)) {
      const blocks = getL1Blocks(this.store, scope, this.config)
      this.l1SnapshotCache.set(sessionID, formatL1ForSystemPrompt(blocks))
    }

    const snapshot = this.l1SnapshotCache.get(sessionID)!
    if (snapshot) {
      output.system.push(snapshot)
    }
    output.system.push(MEMORY_GUIDANCE)

    const turns = (this.turnCounts.get(sessionID) ?? 0) + 1
    this.turnCounts.set(sessionID, turns)
    if (turns > 1 && (turns - 1) % this.config.nudge.interval === 0) {
      output.system.push(buildNudge(this.config))
    }
  }

  async onMessagesTransform(_input: unknown, output: MessagesTransformOutput): Promise<void> {
    const lastUserIdx = findLastUserMessageIndex(output.messages)
    if (lastUserIdx < 0) return

    const msg = output.messages[lastUserIdx]
    const userText = extractUserText(msg.parts)
    if (!userText || userText.trim().length === 0) return

    const scope = resolveScope(this.config, this.worktree)

    let queryEmbedding = this.embedCache.get(userText)
    if (!queryEmbedding) {
      try {
        const { embed } = await import("./embed.js")
        queryEmbedding = await embed(userText)
        this.embedCache.set(userText, queryEmbedding)
        if (this.embedCache.size > 100) {
          const firstKey = this.embedCache.keys().next().value
          if (firstKey) this.embedCache.delete(firstKey)
        }
      } catch {
        return
      }
    }

    const results = this.store.search({
      queryEmbedding,
      scope,
      limit: this.config.layer2.maxResults,
      threshold: this.config.layer2.similarityThreshold,
    })
    if (results.length === 0) return

    const block = buildMemoryContextBlock(results)
    msg.parts.push({
      id: "prt_" + randomUUID(),
      sessionID: msg.info.sessionID,
      messageID: msg.info.id,
      type: "text",
      text: block,
      synthetic: true,
    })
  }

  onCompacting(_input: { sessionID: string }, output: CompactingOutput): void {
    output.context.push(buildCompactionFlush())
  }
}

function findLastUserMessageIndex(messages: MessagesTransformOutput["messages"]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.role === "user") return i
  }
  return -1
}

function extractUserText(parts: Array<Record<string, unknown>>): string {
  return parts
    .filter((p) => p.type === "text" && !p.synthetic)
    .map((p) => p.text as string)
    .filter((t) => typeof t === "string")
    .join("\n")
}
