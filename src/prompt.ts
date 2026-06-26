import type { Config } from "./config.js"

export const MEMORY_GUIDANCE = `## Persistent Memory

You have persistent memory that survives across sessions. Use the memory tools proactively:

**When to save (memory_add):**
- User states a preference, correction, or personal detail (name, role, style, tech stack)
- A significant decision is made and the reasoning matters later
- A convention or tool quirk worth remembering emerges
- Write as a declarative fact, not an instruction to yourself

**Layers:**
- core=true (L1): always in your system prompt. Strict char limit. Use for high-value items (user profile, key conventions). If the limit is exceeded, consolidate using memory_replace/memory_forget in the same turn.
- core=false (L2): recalled by semantic relevance to the current query. Use for long-tail facts.

**Memory types:**
- preference: who the user is (name, role, communication style, likes/dislikes)
- note: environment facts, conventions, tool quirks, lessons learned
- fact: concrete knowledge worth retaining
- decision: a choice made and why

**When to search (memory_search):** when you need to recall past decisions, user preferences, or project conventions not in the current context.

**When to forget (memory_forget):** when information is outdated, incorrect, or superseded.

**When to replace (memory_replace):** when a memory evolves — merge overlapping entries into shorter ones or update stale content.`

export function buildNudge(config: Config): string {
  const interval = config.nudge.interval
  return `\n\n[System nudge: ${interval} turns since last memory review. Scan the recent conversation for: (1) user preferences or personal details, (2) important decisions, (3) conventions worth saving. Save anything worth remembering using memory_add before continuing.]`
}

export function buildCompactionFlush(): string {
  return `\n\n[System: Context compaction is about to occur. This is your last chance to save important memories from the conversation before older messages are compressed. Use memory_add now for any preference, decision, or fact worth preserving.]`
}
