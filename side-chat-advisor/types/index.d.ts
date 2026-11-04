export type Band = { id: number; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'side-chat-advisor': { band: Band | null }
  }
}
