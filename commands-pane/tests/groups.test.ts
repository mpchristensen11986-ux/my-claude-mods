import { expect, test } from 'claude-code/testing'

import type { CommandsPaneItem } from '../types'
import {
  BUILTIN_RULES,
  UNNAMED_PLUGIN,
  classifyBuiltin,
  countCommands,
  defaultOpenId,
  formatRow,
  groupCommands,
  groupHeader,
  isGroupOpen,
  isPersonOrigin,
  parseFolds,
  pluginLabel,
  pruneFolds,
  renderText,
  rowParts,
  setFold,
  toItems,
  truncate,
} from '../hooks/groups'

function cmd(
  name: string,
  description: string,
  source: string = 'builtin',
  plugin?: string,
): CommandsPaneItem {
  return plugin === undefined ? { name, description, source } : { name, description, source, plugin }
}

// Descriptions as Claude Code words them, near enough: the table matches on them too.
const BUILTINS: CommandsPaneItem[] = [
  cmd('clear', 'Clear conversation history and free up context'),
  cmd('resume', 'Resume a conversation'),
  cmd('rename', 'Rename the current conversation'),
  cmd('export', 'Export the current conversation to a file or clipboard'),
  cmd('rewind', 'Restore the code and/or conversation to a previous point'),
  cmd('exit', 'Exit the REPL'),
  cmd('compact', 'Clear conversation history but keep a summary in context'),
  cmd('memory', 'Edit Claude memory files'),
  cmd('context', 'Visualize current context usage as a colored grid'),
  cmd('cost', 'Show the total cost and duration of the current session'),
  cmd('usage', 'Show plan usage limits'),
  cmd('add-dir', 'Add a new working directory'),
  cmd('review', 'Review a pull request'),
  cmd('security-review', 'Complete a security review of the pending changes on the current branch'),
  cmd('diff', 'View uncommitted changes and per-turn diffs'),
  cmd('pr-comments', 'Get comments from a GitHub pull request'),
  cmd('config', 'Open config panel'),
  cmd('model', 'Set the AI model for Claude Code'),
  cmd('permissions', 'Manage allow and deny tool permissions'),
  cmd('theme', 'Change the theme'),
  cmd('login', 'Sign in with your Anthropic account'),
  cmd('init', 'Initialize a new CLAUDE.md file with codebase documentation'),
  cmd('doctor', 'Diagnose and verify your Claude Code installation and settings'),
  cmd('status', 'Show Claude Code status including version, model, account, and tool statuses'),
  cmd('statusline', 'Set up the status line UI'),
  cmd('mcp', 'Manage MCP servers'),
  cmd('help', 'Show help and available commands'),
  cmd('release-notes', 'View release notes'),
]

function idsOf(list: CommandsPaneItem[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const group of groupCommands(list)) {
    for (const item of group.commands) out[item.name] = group.id
  }
  return out
}

test('built-in commands land in the group their name and description point to', () => {
  const where = idsOf(BUILTINS)

  for (const name of ['clear', 'resume', 'rename', 'export', 'rewind', 'exit']) {
    expect(where[name]).toBe('session')
  }
  for (const name of ['compact', 'memory', 'context', 'cost', 'usage', 'add-dir']) {
    expect(where[name]).toBe('context')
  }
  for (const name of ['review', 'security-review', 'diff', 'pr-comments']) {
    expect(where[name]).toBe('review')
  }
  for (const name of ['config', 'model', 'permissions', 'theme', 'login', 'init', 'doctor', 'status', 'statusline', 'mcp']) {
    expect(where[name]).toBe('config')
  }
  expect(where['help']).toBe('other')
  expect(where['release-notes']).toBe('other')
})

test('a name hit outweighs description hits, and the earlier rule wins a tie', () => {
  // `compact` names Context; its description talks about the conversation (Session).
  expect(classifyBuiltin(cmd('compact', 'Clear conversation history, keep a summary'))).toBe('context')
  // No hit anywhere: Other (undefined here).
  expect(classifyBuiltin(cmd('zzz', 'Does something unrelated'))).toBeUndefined()
  // One keyword in two rules, same weight: the first rule listed takes it.
  const rules = [
    { id: 'a', label: 'A', keywords: ['alpha'] },
    { id: 'b', label: 'B', keywords: ['alpha'] },
  ]
  expect(classifyBuiltin(cmd('alpha', ''), rules)).toBe('a')
})

test('keywords match whole words, prefixes only with a star, and phrases in order', () => {
  const rules = [
    { id: 'whole', label: 'Whole', keywords: ['pr'] },
    { id: 'prefix', label: 'Prefix', keywords: ['review*'] },
    { id: 'phrase', label: 'Phrase', keywords: ['add dir'] },
  ]
  // `pr` must not match inside `prompt` or `proxy`.
  expect(classifyBuiltin(cmd('prompt', 'Proxy things'), rules)).toBeUndefined()
  expect(classifyBuiltin(cmd('pr-comments', ''), rules)).toBe('whole')
  expect(classifyBuiltin(cmd('reviewer', ''), rules)).toBe('prefix')
  expect(classifyBuiltin(cmd('add-dir', ''), rules)).toBe('phrase')
  expect(classifyBuiltin(cmd('dir-add', ''), rules)).toBeUndefined()
})

test('the table can be edited: a custom rule set regroups the same commands', () => {
  const rules = [{ id: 'mine', label: 'Mine', keywords: ['help'] }]
  const groups = groupCommands(BUILTINS, rules)
  expect(groups[0]?.id).toBe('mine')
  expect(groups[0]?.commands.map(c => c.name)).toEqual(['help'])
  expect(groups[groups.length - 1]?.id).toBe('other')
})

test('each source goes to its own group, in display order, and empty groups are left out', () => {
  const list = [
    cmd('clear', 'Clear conversation history'),
    cmd('weird', 'Something no rule knows'),
    cmd('standup', 'My own command', 'user'),
    cmd('github:search', 'An MCP prompt', 'mcp'),
    cmd('docx', 'Word documents', 'plugin', 'anthropic-skills'),
    cmd('mystery', 'An unknown source', 'telepathy'),
  ]
  const groups = groupCommands(list)

  expect(groups.map(g => g.label)).toEqual([
    'Session and conversation',
    'Skills and plugins',
    'Your own commands',
    'MCP prompts',
    'Other',
  ])
  const other = groups.find(g => g.id === 'other')
  expect(other?.commands.map(c => c.name)).toEqual(['mystery', 'weird'])
  expect(groups.find(g => g.id === 'user')?.commands[0]?.name).toBe('standup')
  expect(groups.find(g => g.id === 'mcp')?.commands[0]?.name).toBe('github:search')
})

test('plugin and skill commands nest under one sub-group per plugin, sorted, counts rolled up', () => {
  const list = [
    cmd('example-skill', 'Tender', 'plugin', 'anthropic-skills'),
    cmd('docx', 'Word', 'plugin', 'anthropic-skills'),
    cmd('example-plugin:run', 'Recode', 'plugin', 'example-plugin'),
    cmd('example-plugin:verify', 'Verify', 'plugin', 'example-plugin'),
    cmd('loose', 'No plugin name given', 'plugin'),
    cmd('tokeneconomizer:status', 'Status', 'plugin'),
    cmd('Alpha', 'Capital letters sort with the rest', 'plugin', 'Zed'),
  ]
  const [group] = groupCommands(list)

  expect(group?.id).toBe('plugins')
  expect(group?.count).toBe(7)
  expect(group?.commands).toEqual([])
  expect(group?.subgroups.map(s => [s.label, s.count])).toEqual([
    ['anthropic-skills', 2],
    ['example-plugin', 2],
    ['tokeneconomizer', 1], // plugin name read from the part of the name before the colon
    ['Zed', 1],
    [UNNAMED_PLUGIN, 1], // always last
  ])
  expect(group?.subgroups[0]?.commands.map(c => c.name)).toEqual(['docx', 'example-skill'])
  expect(group?.subgroups[0]?.id).toBe('plugins/anthropic-skills')
  expect(pluginLabel(cmd('x', '', 'plugin', '  '))).toBe(UNNAMED_PLUGIN)
})

test('counts in the header and across the groups add up', () => {
  const groups = groupCommands(BUILTINS)
  expect(countCommands(groups)).toBe(BUILTINS.length)

  const context = groups.find(g => g.id === 'context')
  expect(context?.count).toBe(6)
  expect(groupHeader(context?.label ?? '', context?.count ?? 0)).toBe('Context and memory (6)')

  const withPlugins = groupCommands([...BUILTINS, cmd('a', '', 'plugin', 'p'), cmd('b', '', 'plugin', 'q')])
  expect(countCommands(withPlugins)).toBe(BUILTINS.length + 2)
})

test('names sort alphabetically inside a group, whatever their case or the order they came in', () => {
  const list = ['Zebra', 'apple', 'Mango', 'banana', 'cherry'].map(name => cmd(name, 'help me', 'user'))
  const [group] = groupCommands(list)
  expect(group?.commands.map(c => c.name)).toEqual(['apple', 'banana', 'cherry', 'Mango', 'Zebra'])
})

test('toItems trims the engine list to one clean line per command', () => {
  const items = toItems([
    { name: '/compact', description: '  Clear\n  history  ', source: 'builtin' },
    { name: '', description: 'nameless', source: 'builtin' },
    { name: 'x', description: undefined, source: 42, plugin: ' p ' },
    { name: 'long', description: 'y'.repeat(500), source: 'user' },
  ])
  expect(items[0]).toEqual({ name: 'compact', description: 'Clear history', source: 'builtin' })
  expect(items).toHaveLength(3)
  expect(items[1]).toEqual({ name: 'x', description: '', source: 'other', plugin: 'p' })
  expect(items[2]?.description).toHaveLength(300)
})

test('the first group starts open and the rest closed, until the person chooses', () => {
  const groups = groupCommands(BUILTINS)
  const first = defaultOpenId(groups)
  expect(first).toBe('session')
  expect(isGroupOpen({}, 'session', first)).toBe(true)
  expect(isGroupOpen({}, 'context', first)).toBe(false)
  expect(isGroupOpen({}, 'plugins/anything', first)).toBe(false)
  // A choice wins over the default, both ways.
  expect(isGroupOpen({ session: false }, 'session', first)).toBe(false)
  expect(isGroupOpen({ context: true }, 'context', first)).toBe(true)
  expect(defaultOpenId([])).toBeUndefined()
})

test('remembered choices are cleaned on the way in and capped on the way out', () => {
  expect(parseFolds(null)).toEqual({})
  expect(parseFolds('open')).toEqual({})
  expect(parseFolds([true])).toEqual({})
  expect(parseFolds({ a: true, b: 'yes', c: false, '': true })).toEqual({ a: true, c: false })

  const once = setFold({ a: true }, 'b', false)
  expect(once).toEqual({ a: true, b: false })
  // Setting an old key again makes it the newest, so pruning drops the stalest.
  const again = setFold(once, 'a', false)
  expect(Object.keys(again)).toEqual(['b', 'a'])

  const many: Record<string, boolean> = {}
  for (let i = 0; i < 12; i += 1) many[`g${i}`] = true
  expect(Object.keys(pruneFolds(many, 5))).toEqual(['g7', 'g8', 'g9', 'g10', 'g11'])
})

test('truncate fits a width, ends in an ellipsis, and never splits an emoji', () => {
  expect(truncate('short', 10)).toBe('short')
  expect(truncate('exactly ten', 11)).toBe('exactly ten')
  expect(truncate('a longer description', 10)).toBe('a longer…')
  expect(truncate('anything', 1)).toBe('…')
  expect(truncate('anything', 0)).toBe('')
  // Cutting after the high half of a surrogate pair would leave a broken character.
  expect(truncate('ab\u{1F600}cdef', 4)).toBe('ab…')
})

test('a row shows the slash name and as much description as fits', () => {
  const item = cmd('compact', 'Clear conversation history but keep a summary in context')
  expect(rowParts(item, 60)).toEqual({
    name: '/compact',
    description: 'Clear conversation history but keep a summary in…',
  })
  // Too narrow for a useful description: the name alone.
  expect(rowParts(item, 14)).toEqual({ name: '/compact', description: '' })
  expect(formatRow(item, 40, 2)).toBe('  /compact  Clear conversation history…')
  expect(formatRow(cmd('x', ''), 40, 4)).toBe('    /x')
})

test('the text list carries the same groups, counts and nesting, nothing collapsed', () => {
  const text = renderText(
    groupCommands([
      cmd('clear', 'Clear conversation history'),
      cmd('compact', 'Summarise the context'),
      cmd('docx', 'Word documents', 'plugin', 'anthropic-skills'),
      cmd('standup', 'Daily note', 'user'),
    ]),
  )
  expect(text.split('\n')).toEqual([
    'Slash commands (4)',
    '',
    'Session and conversation (1)',
    '  /clear  Clear conversation history',
    '',
    'Context and memory (1)',
    '  /compact  Summarise the context',
    '',
    'Skills and plugins (1)',
    '  anthropic-skills (1)',
    '    /docx  Word documents',
    '',
    'Your own commands (1)',
    '  /standup  Daily note',
  ])
  expect(renderText([])).toBe('No slash commands found.')
})

test('the shipped table has the four built-in groups, in the order the pane shows them', () => {
  expect(BUILTIN_RULES.map(rule => rule.label)).toEqual([
    'Session and conversation',
    'Context and memory',
    'Review and quality',
    'Config and setup',
  ])
})

test('only the automated origins are not the person', () => {
  expect(isPersonOrigin(undefined)).toBe(true)
  expect(isPersonOrigin({ kind: 'composer' })).toBe(true)
  // The desktop app is an SDK host, so its own composer arrives as `sdk`.
  expect(isPersonOrigin({ kind: 'sdk' })).toBe(true)
  expect(isPersonOrigin({ kind: 'bridge' })).toBe(true)
  expect(isPersonOrigin({ kind: 'unclassified' })).toBe(true)
  for (const kind of ['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'channel', 'coordinator', 'observer']) {
    expect(isPersonOrigin({ kind })).toBe(false)
  }
  expect(isPersonOrigin({ kind: 'plugin' })).toBe(false)
  expect(isPersonOrigin({ kind: 'plugin', asUser: true })).toBe(true)
})
