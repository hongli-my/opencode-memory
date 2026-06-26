import { randomUUID } from "node:crypto"
import { tool } from "@opencode-ai/plugin"
import type { MemoryStore, MemoryType } from "./store.js"
import type { Config } from "./config.js"
import { embed } from "./embed.js"
import { resolveScope, getL1Blocks } from "./retrieve.js"

type ToolContext = {
  sessionID: string
  worktree: string
}

export function createMemoryTools(store: MemoryStore, config: Config) {
  function scopeFor(ctx: ToolContext, override?: "user" | "project"): string {
    if (override === "user") return "user"
    if (override === "project") return resolveScope({ ...config, scope: "project" }, ctx.worktree)
    return resolveScope(config, ctx.worktree)
  }

  function expiryFromNow(): number | null {
    if (config.layer2.ttlDays <= 0) return null
    return Date.now() + config.layer2.ttlDays * 86400000
  }

  return {
    "memory_add": tool({
      description:
        "Save a memory for future sessions. Use proactively when the user states a preference, correction, personal detail, or when a decision/convention worth remembering emerges. Set core=true for high-value items that should always be in context (user profile, key conventions). Set core=false for long-tail facts that are recalled by semantic relevance.",
      args: {
        content: tool.schema.string().describe("The memory content as a declarative fact, not an instruction to yourself. E.g. 'User prefers TypeScript with strict mode' not 'Remember to use strict TS'"),
        type: tool.schema.enum(["preference", "note", "fact", "decision"]).describe("preference = who the user is (name, role, style, likes/dislikes). note = environment/conventions/tool quirks. fact = a concrete piece of knowledge. decision = a choice made and why."),
        core: tool.schema.boolean().optional().describe("true = Layer 1 (always in system prompt, strict char limit). false = Layer 2 (semantic recall). Default false."),
        scope: tool.schema.enum(["user", "project"]).optional().describe("user = global across all projects. project = this project only. Defaults to config scope."),
      },
      async execute(args: { content: string; type: MemoryType; core?: boolean; scope?: "user" | "project" }, context: ToolContext) {
        const scope = scopeFor(context, args.scope)
        const core = args.core ?? false

        const emb = await embed(args.content)
        const similar = store.findSimilar({ embedding: emb, scope, threshold: config.dedupThreshold })
        if (similar.length > 0) {
          const newId = randomUUID()
          store.add({
            id: newId,
            content: args.content,
            type: args.type,
            core,
            scope,
            embedding: emb,
            expiresAt: core ? null : expiryFromNow(),
          })
          store.markSuperseded(scope, similar.map((m) => m.id), newId)
          return {
            title: "Memory Saved (deduped)",
            output: `Saved as ${core ? "core (L1)" : "long-tail (L2)"} memory.\n${similar.length} similar older memor${similar.length === 1 ? "y" : "ies"} superseded.\n\nContent: ${args.content}`,
          }
        }

        if (core) {
          const limit = args.type === "preference" ? config.layer1.userCharLimit : config.layer1.memoryCharLimit
          const used = store.coreCharCount(scope, args.type)
          if (used + args.content.length > limit) {
            const blocks = getL1Blocks(store, scope, config)
            const current = blocks.find((b) => b.type === args.type)
            return {
              title: "Memory Char Limit Exceeded",
              output: `${args.type} memory at ${used}/${limit} chars. Adding this entry (${args.content.length} chars) would exceed the limit.\nConsolidate now: use memory_replace to merge overlapping entries into shorter ones or memory_forget to remove stale entries, then retry this add — all in this turn.\n\nCurrent ${args.type} entries:\n${current?.content ?? "(empty)"}`,
            }
          }
        }

        store.add({
          id: randomUUID(),
          content: args.content,
          type: args.type,
          core,
          scope,
          embedding: emb,
          expiresAt: core ? null : expiryFromNow(),
        })
        return {
          title: "Memory Saved",
          output: `Saved as ${core ? "core (L1)" : "long-tail (L2)"} memory.\n\nContent: ${args.content}`,
        }
      },
    }),

    "memory_search": tool({
      description:
        "Search your persistent memory by semantic relevance. Use when you need to recall past decisions, user preferences, or project conventions that aren't in the current context.",
      args: {
        query: tool.schema.string().describe("Natural language query describing what you want to recall."),
        scope: tool.schema.enum(["user", "project"]).optional().describe("user = global memories. project = this project only. Defaults to config scope."),
        limit: tool.schema.number().optional().describe("Max results. Default 5."),
        type: tool.schema.enum(["preference", "note", "fact", "decision"]).optional().describe("Filter by memory type."),
      },
      async execute(args: { query: string; scope?: "user" | "project"; limit?: number; type?: MemoryType }, context: ToolContext) {
        const scope = scopeFor(context, args.scope)
        const queryEmb = await embed(args.query)
        const results = store.search({
          queryEmbedding: queryEmb,
          scope,
          limit: args.limit ?? config.layer2.maxResults,
          threshold: config.layer2.similarityThreshold,
          type: args.type,
        })
        if (results.length === 0) {
          return { title: "Memory Search", output: "No matching memories found." }
        }
        const lines = results.map((m, i) => `${i + 1}. [${m.type}] (${(m.similarity * 100).toFixed(0)}% match) ${m.content}`)
        return { title: "Memory Search", output: `Found ${results.length} matching memor${results.length === 1 ? "y" : "ies"}:\n\n${lines.join("\n")}` }
      },
    }),

    "memory_replace": tool({
      description:
        "Replace an existing memory entry. Use to consolidate or update memories when they evolve. The old_text must match an existing entry exactly.",
      args: {
        old_text: tool.schema.string().describe("Exact content of the memory to replace."),
        new_text: tool.schema.string().describe("New content for the memory."),
        type: tool.schema.enum(["preference", "note", "fact", "decision"]).describe("Type of the memory being replaced."),
        scope: tool.schema.enum(["user", "project"]).optional().describe("user = global. project = this project only. Defaults to config scope."),
      },
      async execute(args: { old_text: string; new_text: string; type: MemoryType; scope?: "user" | "project" }, context: ToolContext) {
        const scope = scopeFor(context, args.scope)
        const changes = store.replaceContent(scope, args.old_text, args.new_text, args.type)
        if (changes === 0) {
          return { title: "Memory Replace", output: `No memory found matching: "${args.old_text}"` }
        }
        return { title: "Memory Replaced", output: `Replaced ${changes} entr${changes === 1 ? "y" : "ies"}.\nOld: ${args.old_text}\nNew: ${args.new_text}` }
      },
    }),

    "memory_forget": tool({
      description:
        "Delete memories matching a pattern. Use when information is outdated, incorrect, or no longer relevant. Matches by substring.",
      args: {
        pattern: tool.schema.string().describe("Substring to match against memory content. All matching memories will be deleted."),
        scope: tool.schema.enum(["user", "project"]).optional().describe("user = global. project = this project only. Defaults to config scope."),
      },
      async execute(args: { pattern: string; scope?: "user" | "project" }, context: ToolContext) {
        const scope = scopeFor(context, args.scope)
        const deleted = store.forget(scope, args.pattern)
        if (deleted === 0) {
          return { title: "Memory Forget", output: `No memories matched: "${args.pattern}"` }
        }
        return { title: "Memory Forgotten", output: `Deleted ${deleted} memor${deleted === 1 ? "y" : "ies"} matching: "${args.pattern}"` }
      },
    }),

    "memory_list": tool({
      description:
        "List all active memories. Use to review and consolidate when the memory is getting full, or to see what's already stored before adding duplicates.",
      args: {
        scope: tool.schema.enum(["user", "project"]).optional().describe("user = global. project = this project only. Defaults to config scope."),
        type: tool.schema.enum(["preference", "note", "fact", "decision"]).optional().describe("Filter by type."),
        core: tool.schema.boolean().optional().describe("true = only core (L1). false = only long-tail (L2). undefined = all."),
      },
      async execute(args: { scope?: "user" | "project"; type?: MemoryType; core?: boolean }, context: ToolContext) {
        const scope = scopeFor(context, args.scope)
        const memories = store.list(scope, { type: args.type, core: args.core })
        if (memories.length === 0) {
          return { title: "Memory List", output: "No memories stored." }
        }
        const lines = memories.map((m, i) => {
          const layer = m.core ? "L1" : "L2"
          return `${i + 1}. [${layer}] [${m.type}] ${m.content}`
        })
        return { title: "Memory List", output: `${memories.length} memor${memories.length === 1 ? "y" : "ies"}:\n\n${lines.join("\n")}` }
      },
    }),
  }
}
