// Pure grouping, trimming and text layout for the commands pane. Nothing here
// touches `$`, so every function can be unit-tested on plain data.
import type { CommandsPaneFolds, CommandsPaneItem } from '../types'

// ---------------------------------------------------------------------------
// The editable keyword table (built-in commands only)
// ---------------------------------------------------------------------------
//
// A built-in command goes to the rule whose keywords score highest against its
// name and its one-line description. A keyword matches a whole word; a trailing
// `*` lets the last word be a prefix (`review*` matches review, reviewer).
// Several words (`add dir`) must appear next to each other, in order. Words are
// runs of letters and digits, so `security-review` is two words: security and
// review. A name hit scores NAME_WEIGHT, a description hit DESCRIPTION_WEIGHT,
// and the earlier rule wins a tie. No score at all means the group Other.
//
// To move a command, add its name to the rule you want and keep it out of the
// others. Rules show in the pane in the order they are listed here. A rule's id
// is also the key its open or closed state is remembered under, and must not be
// `plugins`, `user`, `mcp` or `other`, which belong to the groups below.

export type GroupRule = { id: string; label: string; keywords: readonly string[] }

export const NAME_WEIGHT = 5
export const DESCRIPTION_WEIGHT = 1

export const BUILTIN_RULES: readonly GroupRule[] = [
  {
    id: 'session',
    label: 'Session and conversation',
    keywords: [
      'clear', 'resume', 'continue', 'rename', 'export', 'rewind', 'fork',
      'exit', 'quit', 'copy', 'recap', 'btw', 'tasks', 'todos', 'bashes',
      'session*', 'conversation*', 'history', 'transcript',
    ],
  },
  {
    id: 'context',
    label: 'Context and memory',
    keywords: [
      'context', 'memory', 'memories', 'compact', 'cost', 'usage', 'token*',
      'stats', 'add dir', 'directory', 'directories',
    ],
  },
  {
    id: 'review',
    label: 'Review and quality',
    keywords: [
      'review*', 'security', 'diff*', 'pr', 'pull request', 'simplify',
      'lint*', 'audit*', 'quality',
    ],
  },
  {
    id: 'config',
    label: 'Config and setup',
    keywords: [
      'config*', 'setting*', 'model', 'permission*', 'theme', 'login',
      'logout', 'init', 'doctor', 'status*', 'setup', 'install*', 'update',
      'upgrade', 'plugin*', 'mcp', 'hook*', 'agents', 'ide', 'vim', 'voice',
      'style', 'terminal', 'keybinding*', 'privacy', 'sandbox', 'effort',
      'fast', 'advisor', 'skills', 'account',
    ],
  },
]

// The groups that are not a keyword match: where a command's source decides.
export const PLUGINS_GROUP = { id: 'plugins', label: 'Skills and plugins' } as const
export const USER_GROUP = { id: 'user', label: 'Your own commands' } as const
export const MCP_GROUP = { id: 'mcp', label: 'MCP prompts' } as const
export const OTHER_GROUP = { id: 'other', label: 'Other' } as const

/** The sub-group for a plugin command the engine gives no plugin name for. */
export const UNNAMED_PLUGIN = 'Unnamed plugin'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandSubgroup = {
  /** `plugins/<plugin name>`: also the key its open or closed state is kept under. */
  id: string
  label: string
  /** How many commands it holds. */
  count: number
  commands: CommandsPaneItem[]
}

export type CommandGroup = {
  id: string
  label: string
  /** Every command in the group, sub-groups included. */
  count: number
  /** The group's own commands, sorted by name. Empty for Skills and plugins. */
  commands: CommandsPaneItem[]
  /** Sorted by plugin name. Only Skills and plugins has any. */
  subgroups: CommandSubgroup[]
}

/** What `$.command.list()` returns, as far as this file needs it. */
export type RawCommand = {
  name?: unknown
  description?: unknown
  source?: unknown
  plugin?: unknown
}

// ---------------------------------------------------------------------------
// Keyword matching
// ---------------------------------------------------------------------------

function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 0)
}

function hasKeyword(haystack: readonly string[], keyword: string): boolean {
  const isPrefix = keyword.endsWith('*')
  const want = wordsOf(isPrefix ? keyword.slice(0, -1) : keyword)
  if (want.length === 0) return false
  for (let start = 0; start + want.length <= haystack.length; start += 1) {
    let isMatch = true
    for (let i = 0; i < want.length; i += 1) {
      const have = haystack[start + i] ?? ''
      const target = want[i] ?? ''
      const isLast = i === want.length - 1
      const hit = isLast && isPrefix ? have.startsWith(target) : have === target
      if (!hit) {
        isMatch = false
        break
      }
    }
    if (isMatch) return true
  }
  return false
}

/** How well one rule fits a command: name hits count more than description hits. */
export function scoreRule(rule: GroupRule, item: CommandsPaneItem): number {
  const nameWords = wordsOf(item.name)
  const descriptionWords = wordsOf(item.description)
  let score = 0
  for (const keyword of rule.keywords) {
    if (hasKeyword(nameWords, keyword)) score += NAME_WEIGHT
    if (hasKeyword(descriptionWords, keyword)) score += DESCRIPTION_WEIGHT
  }
  return score
}

/** The id of the rule a built-in command belongs to, or undefined for Other. */
export function classifyBuiltin(
  item: CommandsPaneItem,
  rules: readonly GroupRule[] = BUILTIN_RULES,
): string | undefined {
  let best: string | undefined
  let bestScore = 0
  for (const rule of rules) {
    const score = scoreRule(rule, item)
    if (score > bestScore) {
      best = rule.id
      bestScore = score
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Trimming what the engine returns
// ---------------------------------------------------------------------------

const MAX_DESCRIPTION = 300

/** One line, no leading slash, nothing the pane cannot draw; nameless rows dropped. */
export function toItems(list: readonly RawCommand[]): CommandsPaneItem[] {
  const out: CommandsPaneItem[] = []
  for (const raw of list) {
    const name = String(raw.name ?? '').trim().replace(/^\/+/, '')
    if (name === '') continue
    const description = String(raw.description ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_DESCRIPTION)
    const source = typeof raw.source === 'string' ? raw.source : 'other'
    const plugin = typeof raw.plugin === 'string' ? raw.plugin.trim() : ''
    out.push(plugin === '' ? { name, description, source } : { name, description, source, plugin })
  }
  return out
}

export function sameItems(a: readonly CommandsPaneItem[], b: readonly CommandsPaneItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function byName(a: CommandsPaneItem, b: CommandsPaneItem): number {
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  if (x < y) return -1
  if (x > y) return 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** The sub-group a plugin command lands in: its plugin, else the part of its name before a colon. */
export function pluginLabel(item: CommandsPaneItem): string {
  const named = (item.plugin ?? '').trim()
  if (named !== '') return named
  const colon = item.name.indexOf(':')
  return colon > 0 ? item.name.slice(0, colon) : UNNAMED_PLUGIN
}

function byLabel(a: CommandSubgroup, b: CommandSubgroup): number {
  // The unnamed bucket goes last whatever its letters would say.
  const aLast = a.label === UNNAMED_PLUGIN
  const bLast = b.label === UNNAMED_PLUGIN
  if (aLast !== bLast) return aLast ? 1 : -1
  const x = a.label.toLowerCase()
  const y = b.label.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Sorts a command list into the groups the pane and the text list show, in
 * display order, leaving out any group with nothing in it.
 */
export function groupCommands(
  list: readonly CommandsPaneItem[],
  rules: readonly GroupRule[] = BUILTIN_RULES,
): CommandGroup[] {
  const own = new Map<string, CommandsPaneItem[]>()
  const plugins = new Map<string, CommandsPaneItem[]>()
  const put = (id: string, item: CommandsPaneItem): void => {
    own.set(id, [...(own.get(id) ?? []), item])
  }

  for (const item of list) {
    if (item.source === 'builtin') put(classifyBuiltin(item, rules) ?? OTHER_GROUP.id, item)
    else if (item.source === 'plugin') {
      const label = pluginLabel(item)
      plugins.set(label, [...(plugins.get(label) ?? []), item])
    } else if (item.source === 'user') put(USER_GROUP.id, item)
    else if (item.source === 'mcp') put(MCP_GROUP.id, item)
    else put(OTHER_GROUP.id, item)
  }

  const groups: CommandGroup[] = []
  const flat = (id: string, label: string): void => {
    const commands = [...(own.get(id) ?? [])].sort(byName)
    if (commands.length > 0) groups.push({ id, label, count: commands.length, commands, subgroups: [] })
  }

  for (const rule of rules) flat(rule.id, rule.label)

  const subgroups: CommandSubgroup[] = [...plugins.entries()]
    .map(([label, items]) => {
      const commands = [...items].sort(byName)
      return { id: `${PLUGINS_GROUP.id}/${label}`, label, count: commands.length, commands }
    })
    .sort(byLabel)
  if (subgroups.length > 0) {
    const count = subgroups.reduce((n, sub) => n + sub.count, 0)
    groups.push({ id: PLUGINS_GROUP.id, label: PLUGINS_GROUP.label, count, commands: [], subgroups })
  }

  flat(USER_GROUP.id, USER_GROUP.label)
  flat(MCP_GROUP.id, MCP_GROUP.label)
  flat(OTHER_GROUP.id, OTHER_GROUP.label)
  return groups
}

export function countCommands(groups: readonly CommandGroup[]): number {
  return groups.reduce((n, group) => n + group.count, 0)
}

/** `Context and memory (6)` */
export function groupHeader(label: string, count: number): string {
  return `${label} (${count})`
}

// ---------------------------------------------------------------------------
// Open and closed
// ---------------------------------------------------------------------------

export const MAX_FOLDS = 200

/** The group that starts open: the first one shown. */
export function defaultOpenId(groups: readonly CommandGroup[]): string | undefined {
  return groups[0]?.id
}

/** What the person chose for this group, else open only for the first group. */
export function isGroupOpen(
  folds: CommandsPaneFolds,
  id: string,
  firstId: string | undefined,
): boolean {
  if (Object.prototype.hasOwnProperty.call(folds, id)) return folds[id] === true
  return id === firstId
}

/** Keeps the newest `max` choices, so a store full of retired plugin names cannot grow. */
export function pruneFolds(folds: CommandsPaneFolds, max: number = MAX_FOLDS): CommandsPaneFolds {
  const entries = Object.entries(folds)
  return Object.fromEntries(entries.length > max ? entries.slice(entries.length - max) : entries)
}

/** Records one choice as the newest. Returns a new object. */
export function setFold(folds: CommandsPaneFolds, id: string, isOpen: boolean): CommandsPaneFolds {
  const next: CommandsPaneFolds = { ...folds }
  delete next[id]
  next[id] = isOpen
  return pruneFolds(next)
}

/** Reads what `$.store` held, keeping only well-formed choices. */
export function parseFolds(raw: unknown): CommandsPaneFolds {
  const folds: CommandsPaneFolds = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return folds
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === 'boolean' && id !== '__proto__' && id.length > 0 && id.length <= 120) {
      folds[id] = value
    }
  }
  return pruneFolds(folds)
}

// ---------------------------------------------------------------------------
// Fitting text to a width
// ---------------------------------------------------------------------------

/** Cuts to `max` characters with an ellipsis, never splitting a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max === 1) return '…'
  let cut = text.slice(0, max - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}

const MIN_DESCRIPTION = 8

/** The name (with its slash) and as much of the description as fits `columns`. */
export function rowParts(
  item: CommandsPaneItem,
  columns: number,
): { name: string; description: string } {
  const name = truncate(`/${item.name}`, Math.max(1, columns))
  const room = columns - name.length - 2
  const description = room >= MIN_DESCRIPTION ? truncate(item.description, room) : ''
  return { name, description }
}

export function formatRow(item: CommandsPaneItem, columns: number, indent: number): string {
  const { name, description } = rowParts(item, columns - indent)
  return `${' '.repeat(indent)}${description === '' ? name : `${name}  ${description}`}`
}

/** The whole list as plain text: the same groups and counts, nothing collapsed. */
export function renderText(groups: readonly CommandGroup[], columns: number = 100): string {
  if (groups.length === 0) return 'No slash commands found.'
  const lines: string[] = [`Slash commands (${countCommands(groups)})`, '']
  for (const group of groups) {
    lines.push(groupHeader(group.label, group.count))
    for (const item of group.commands) lines.push(formatRow(item, columns, 2))
    for (const sub of group.subgroups) {
      lines.push(`  ${groupHeader(sub.label, sub.count)}`)
      for (const item of sub.commands) lines.push(formatRow(item, columns, 4))
    }
    lines.push('')
  }
  while (lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Who ran the command
// ---------------------------------------------------------------------------

// Origins that are never the person typing. Everything else counts as the person: the desktop app is an
// Agent SDK host, so its own composer arrives as `sdk` (or unclassified), not `composer`.
const AUTOMATED_ORIGINS = new Set([
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'projects-relay',
  'channel',
  'coordinator',
  'observer',
  'observer-activity',
])

export function isPersonOrigin(o: { kind?: string; asUser?: boolean } | undefined): boolean {
  if (o === undefined) return true
  if (o.kind === 'plugin') return o.asUser === true
  return !AUTOMATED_ORIGINS.has(o.kind ?? '')
}
