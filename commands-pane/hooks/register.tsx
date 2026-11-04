import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, Register, Timer } from 'claude-code'

import type { CommandsPaneItem, CommandsPaneFolds } from '../types'
import {
  countCommands,
  defaultOpenId,
  groupCommands,
  groupHeader,
  isGroupOpen,
  isPersonOrigin,
  parseFolds,
  renderText,
  rowParts,
  sameItems,
  setFold,
  toItems,
} from './groups'

const PANE = 'commands-pane'
const TITLE = 'Commands'
const REFRESH_MS = 60_000
const STORE_FOLDS = 'folds'
const USAGE =
  'Usage: /commands (open or close the pane), /commands text (the list as plain text), /commands refresh (re-read the list).'

// Change a tag when the shape of what it holds changes: a value stored under
// another tag reads as the initial, so old data never meets new code.
const commandsAtom = atom(
  { plugin: 'commands-pane', key: 'commands' } as const,
  [] as CommandsPaneItem[],
  { shape: 'commands-1' },
)
const foldsAtom = atom(
  { plugin: 'commands-pane', key: 'folds' } as const,
  {} as CommandsPaneFolds,
  { shape: 'folds-1' },
)

// The refresh timer. It runs only while the pane is open: it is started when a
// pane is placed, cancelled when the pane closes, and cancels itself if it ever
// finds the pane gone. A hot reload drops the timer with the old module.
let ticker: Timer | undefined

function stopTicker(): void {
  ticker?.cancel()
  ticker = undefined
}

function startTicker($: EngineInterface): void {
  if (ticker !== undefined) return
  ticker = $.clock.every(REFRESH_MS, () => {
    void tick($)
  })
}

async function tick($: EngineInterface): Promise<void> {
  try {
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
    if (!isUp) {
      stopTicker()
      return
    }
    await refreshCommands($)
  } catch {
    // Try again next period; a failed read leaves what the pane shows as it was.
  }
}

/** Re-reads `$.command.list()` into the pane's state, writing only when something changed. */
async function refreshCommands($: EngineInterface): Promise<CommandsPaneItem[]> {
  const items = toItems(await $.command.list())
  const before = await read($, commandsAtom)
  if (!sameItems(before, items)) await update($, commandsAtom, () => items)
  return items
}

async function loadFolds($: EngineInterface): Promise<void> {
  const folds = parseFolds(await $.store.get(STORE_FOLDS))
  await update($, foldsAtom, () => folds)
}

/** Flips one group, reading the state afresh, and remembers it for the next session. */
async function toggleFold($: EngineInterface, id: string): Promise<void> {
  const items = await read($, commandsAtom)
  const firstId = defaultOpenId(groupCommands(items))
  const next = await update($, foldsAtom, folds => setFold(folds, id, !isGroupOpen(folds, id, firstId)))
  try {
    await $.store.set(STORE_FOLDS, next)
  } catch {
    // The group still flips for this session; it is just not remembered.
  }
}

async function refreshNow($: EngineInterface): Promise<void> {
  try {
    await refreshCommands($)
  } catch {
    // Keep the list on screen as it was.
  }
}

async function prepare($: EngineInterface): Promise<void> {
  stopTicker()
  try {
    await loadFolds($)
  } catch {
    // No remembered state: the first group opens and the rest start closed.
  }
  try {
    await refreshCommands($)
  } catch {
    // The pane reads the list again when it opens.
  }
}

function shortError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/\s+/g, ' ').slice(0, 160)
}

/** Answers /commands. Returns the command's own text; never calls `next`. */
async function runCommand($: EngineInterface, e: Args<'command.run'>): Promise<{ text: string }> {
  const arg = e.args.trim().toLowerCase()
  try {
    if (arg === 'refresh') {
      const items = await refreshCommands($)
      const groups = groupCommands(items)
      return { text: `Re-read the command list: ${items.length} commands in ${groups.length} groups.` }
    }
    if (arg === 'text') {
      return { text: renderText(groupCommands(await refreshCommands($))) }
    }
    if (arg !== '' && arg !== 'toggle') return { text: USAGE }

    // A pane is for the person at the keyboard. A run by a timer, a peer or
    // another plugin gets the text and leaves any open pane alone.
    if (!isPersonOrigin(e.origin)) {
      const text = renderText(groupCommands(await refreshCommands($)))
      return { text: `${text}\n\n(Not run by you, so no pane was opened or closed.)` }
    }

    const shown = (await $.ui.panes()).find(pane => pane.id === PANE)
    if (shown !== undefined && shown.isPlaced) {
      stopTicker()
      await $.ui.close({ id: PANE })
      return { text: 'Commands pane closed.' }
    }

    const groups = groupCommands(await refreshCommands($))
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    if (opened.isPlaced) {
      startTicker($)
      return {
        text: `Commands pane opened (engine: isPlaced true): ${countCommands(groups)} commands in ${groups.length} groups. Run /commands again to close it, or /commands text for a plain list.`,
      }
    }

    // Open but undrawn: nothing would show it, so close it and give the list as text.
    try {
      await $.ui.close({ id: PANE })
    } catch {
      // Nothing to undo if the pane is already gone.
    }
    return {
      text: `The engine did not place the commands pane (isPlaced false: ${opened.reason}), so here is the list as text.\n\n${renderText(groups)}`,
    }
  } catch (err) {
    return { text: `/commands could not finish: ${shortError(err)}` }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'commands',
      description: 'Show the slash commands in a collapsible pane, grouped by function',
      argumentHint: '[text|refresh]',
      // The command reads nothing of the turn, so it can answer mid-turn.
      immediate: true,
    })
    await prepare($)

    return next(e)
  })

  on('command.run', { command: 'commands' }, ($, e) => runCommand($, e)).catch(() => ({
    text: '/commands could not run. Try /commands text for a plain list.',
  }))

  // The person's close mark and Escape land here too. The refresh timer stops
  // with the pane, whoever closed it.
  on('ui.close', { id: PANE }, async (_$, e, next) => {
    const closed = await next(e)
    stopTicker()

    return closed
  }).catch((_$, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const items = await read($, commandsAtom)
    const folds = await read($, foldsAtom)
    const groups = groupCommands(items)
    const firstId = defaultOpenId(groups)
    const columns = Math.max(24, e.props.bodyColumns)

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between" gap={1}>
          <Text weight="semibold" color="claude">
            Slash commands ({countCommands(groups)})
          </Text>
          <Button key="refresh" label="Refresh" onPress={() => refreshNow($)} />
        </Box>
        {items.length === 0 && (
          <Text color="subtle">No commands read yet. Press Refresh.</Text>
        )}
        {groups.map(group => {
          const isOpen = isGroupOpen(folds, group.id, firstId)
          return (
            <Box flexDirection="column">
              <Button
                key={`fold:${group.id}`}
                plain
                label={`${isOpen ? '▼' : '►'} ${groupHeader(group.label, group.count)}`}
                onPress={() => toggleFold($, group.id)}
              />
              {isOpen && (
                <Box flexDirection="column" paddingLeft={2}>
                  {group.commands.map(item => {
                    const row = rowParts(item, columns - 2)
                    return (
                      <Text wrap="truncate-end">
                        <Text weight="semibold">{row.name}</Text>
                        {row.description !== '' && <Text color="subtle">{`  ${row.description}`}</Text>}
                      </Text>
                    )
                  })}
                  {group.subgroups.map(sub => {
                    const isSubOpen = isGroupOpen(folds, sub.id, firstId)
                    return (
                      <Box flexDirection="column">
                        <Button
                          key={`fold:${sub.id}`}
                          plain
                          label={`${isSubOpen ? '▼' : '►'} ${groupHeader(sub.label, sub.count)}`}
                          onPress={() => toggleFold($, sub.id)}
                        />
                        {isSubOpen && (
                          <Box flexDirection="column" paddingLeft={2}>
                            {sub.commands.map(item => {
                              const row = rowParts(item, columns - 4)
                              return (
                                <Text wrap="truncate-end">
                                  <Text weight="semibold">{row.name}</Text>
                                  {row.description !== '' && (
                                    <Text color="subtle">{`  ${row.description}`}</Text>
                                  )}
                                </Text>
                              )
                            })}
                          </Box>
                        )}
                      </Box>
                    )
                  })}
                </Box>
              )}
            </Box>
          )
        })}
        <Text color="subtle" size="caption">
          {`Drawn on ${e.surface}: ${e.props.placement}, ${e.props.bodyColumns} columns. Re-reads every 60 s while open.`}
        </Text>
      </Box>
    )
  })
}
