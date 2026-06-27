import { homedir } from "node:os"
import { join } from "node:path"
import { MemoryStore } from "./store.js"
import { loadConfig } from "./config.js"
import { createMemoryTools } from "./tools.js"
import { InjectionManager } from "./inject.js"
import { configureEmbedding } from "./embed.js"

export const id = "opencode-memory"

type PluginInput = {
  worktree: string
}

export const server = async (input: PluginInput) => {
  const configPath = join(homedir(), ".config", "opencode", "memory.jsonc")
  const config = loadConfig(configPath)
  configureEmbedding(config.embedding.model)

  const xdg = process.env.XDG_DATA_HOME
  const base = xdg || join(homedir(), ".local", "share")
  const dataDir = join(base, "opencode")

  const store = new MemoryStore(dataDir)
  const injection = new InjectionManager(store, config, input.worktree)
  const tools = createMemoryTools(store, config)

  let lastPurge = 0

  return {
    config: async (cfg: Record<string, any>) => {
      if (!cfg.experimental) cfg.experimental = {}
      if (!Array.isArray(cfg.experimental.primary_tools)) cfg.experimental.primary_tools = []
      const existing = new Set(cfg.experimental.primary_tools)
      for (const name of ["memory_add", "memory_search", "memory_replace", "memory_forget", "memory_list"]) {
        if (!existing.has(name)) cfg.experimental.primary_tools.push(name)
      }
    },

    tool: tools,

    "experimental.chat.system.transform": async (
      input: { sessionID?: string; model: unknown },
      output: { system: string[] },
    ) => {
      injection.onSystemTransform(input, output)
    },

    "experimental.chat.messages.transform": async (
      _input: unknown,
      output: { messages: Array<{ info: { id: string; sessionID: string; role: string }; parts: Array<Record<string, unknown>> }> },
    ) => {
      await injection.onMessagesTransform(_input, output)
    },

    "experimental.session.compacting": async (
      input: { sessionID: string },
      output: { context: string[]; prompt?: string },
    ) => {
      injection.onCompacting(input, output)
    },

    event: async () => {
      const now = Date.now()
      if (now - lastPurge > 3600000) {
        lastPurge = now
        store.purgeExpired()
      }
    },

    dispose: async () => {
      store.close()
    },
  }
}

export default { id, server }
