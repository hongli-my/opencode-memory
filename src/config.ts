import { readFileSync, existsSync } from "node:fs"

export type Config = {
  layer1: {
    memoryCharLimit: number
    userCharLimit: number
  }
  layer2: {
    maxResults: number
    similarityThreshold: number
    ttlDays: number
  }
  nudge: {
    interval: number
  }
  embedding: {
    model: string
    dims: number
  }
  scope: "user" | "project"
  dedupThreshold: number
}

export const defaultConfig: Config = {
  layer1: {
    memoryCharLimit: 2200,
    userCharLimit: 1375,
  },
  layer2: {
    maxResults: 5,
    similarityThreshold: 0.25,
    ttlDays: 30,
  },
  nudge: {
    interval: 10,
  },
  embedding: {
    model: "Xenova/all-MiniLM-L6-v2",
    dims: 384,
  },
  scope: "user",
  dedupThreshold: 0.92,
}

export function loadConfig(configPath: string): Config {
  if (!existsSync(configPath)) return defaultConfig
  const raw = readFileSync(configPath, "utf-8")
  const stripped = stripJsonc(raw)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return defaultConfig
  }
  return deepMerge(defaultConfig, parsed) as Config
}

function stripJsonc(text: string): string {
  let out = ""
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (ch === '"') {
      out += ch
      i++
      while (i < n) {
        const c = text[i]
        out += c
        if (c === "\\" && i + 1 < n) {
          out += text[i + 1]
          i += 2
          continue
        }
        i++
        if (c === '"') break
      }
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2
      while (i < n && text[i] !== "\n") i++
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += ch
    i++
  }
  return out
}

function deepMerge<T>(base: T, override: Record<string, unknown>): T {
  if (typeof base !== "object" || base === null) return override as T
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const key of Object.keys(override)) {
    const baseVal = (base as Record<string, unknown>)[key]
    const overrideVal = override[key]
    if (
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal) &&
      typeof overrideVal === "object" &&
      overrideVal !== null &&
      !Array.isArray(overrideVal)
    ) {
      result[key] = deepMerge(baseVal, overrideVal as Record<string, unknown>)
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal
    }
  }
  return result as T
}
