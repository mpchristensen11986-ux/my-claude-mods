/**
 * One slash command as the pane keeps it: the fields of the engine's
 * CommandInfo, trimmed to one line. `source` is a plain string so a source a
 * later release adds still reads (it is grouped under Other).
 */
export type CommandsPaneItem = {
  name: string
  description: string
  source: string
  plugin?: string
}

/**
 * The groups the person opened or closed by hand, by group id. A group not
 * named here is open only if it is the first one shown.
 */
export type CommandsPaneFolds = Record<string, boolean>

declare module 'claude-code' {
  interface PluginState {
    'commands-pane': {
      /** The last read of the command list. Empty until the first read. */
      commands: Shaped<CommandsPaneItem[]>
      /** Open or closed by hand. Mirrored to $.store so it outlives the session. */
      folds: Shaped<CommandsPaneFolds>
    }
  }
}
