import type { CommandInfo, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const

const PANE = {
  plugin: 'commands-pane',
  component: 'Pane',
  requestId: 'commands-pane',
  props: {
    title: 'Commands',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

function info(
  name: string,
  description: string,
  source: CommandInfo['source'] = 'builtin',
  plugin?: string,
): CommandInfo {
  return plugin === undefined ? { name, description, source } : { name, description, source, plugin }
}

// Session: clear, resume (2). Context: compact, memory (2). Config: model (1).
const LIST: CommandInfo[] = [
  info('resume', 'Resume a conversation'),
  info('clear', 'Clear conversation history and free up context'),
  info('memory', 'Edit Claude memory files'),
  info('compact', 'Clear conversation history but keep a summary in context'),
  info('model', 'Set the AI model for Claude Code'),
]

type Row = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }
type World = {
  list: CommandInfo[]
  isPlaced: boolean
  reason: string
  panes: Row[]
  opens: string[]
  closes: string[]
  reads: number
  store: Record<string, unknown>
  registered: { name: string; description: string }[]
}

function world(over: Partial<World> = {}): World {
  return {
    list: LIST,
    isPlaced: true,
    reason: '',
    panes: [],
    opens: [],
    closes: [],
    reads: 0,
    store: {},
    registered: [],
    ...over,
  }
}

// Nothing sits beneath the plugin: each hook here stands for the engine.
function engine(on: On, w: World, stored: Record<string, unknown> = {}) {
  w.store = { ...stored }
  // The store is the test's own (not mock.store) so a write can be read back.
  on('store.get', (_, e) => ({ value: w.store[e.key] }))
  on('store.set', (_, e) => {
    w.store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete w.store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(w.store) }))
  const clock = mock.clock(on)
  on('command.register', (_, e) => {
    w.registered.push({ name: e.name, description: e.description })
    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.list', () => {
    w.reads += 1
    return { value: w.list }
  })
  on('ui.panes', () => ({ value: w.panes }))
  on('ui.open', (_, e) => {
    w.opens.push(e.id)
    w.panes = [{ id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: w.isPlaced }]
    return { value: w.isPlaced ? { isPlaced: true as const } : { isPlaced: false as const, reason: w.reason } }
  })
  on('ui.close', (_, e) => {
    w.closes.push(e.id)
    w.panes = w.panes.filter(p => p.id !== e.id)
    return { value: undefined }
  })
  return clock
}

test('session.start registers /commands and reads the list once', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)

  expect(w.registered.map(r => r.name)).toEqual(['commands'])
  expect(w.registered[0]?.description).toContain('slash commands')
  expect(w.reads).toBe(1)
  expect(w.opens).toEqual([]) // nothing opens unasked
})

test('/commands opens the pane, and run again it closes it', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)

  const opened = await $.command.run({ command: 'commands', args: '' })
  expect(w.opens).toEqual(['commands-pane'])
  expect(opened.text).toContain('Commands pane opened (engine: isPlaced true): 5 commands in 3 groups')

  const closed = await $.command.run({ command: 'commands', args: '' })
  expect(w.closes).toEqual(['commands-pane'])
  expect(closed.text).toBe('Commands pane closed.')

  // And once more: open again, no leftover state in the way.
  await $.command.run({ command: 'commands', args: 'toggle' })
  expect(w.opens).toEqual(['commands-pane', 'commands-pane'])
})

test('when the engine does not place the pane, the list comes back as text and nothing is left open', async ($, on) => {
  const w = world({ isPlaced: false, reason: 'the terminal is 90 columns wide; an unasked pane needs 144' })
  const clock = engine(on, w)
  await $.session.start(START)

  const out = await $.command.run({ command: 'commands', args: '' })

  expect(out.text).toContain('isPlaced false: the terminal is 90 columns wide; an unasked pane needs 144')
  expect(out.text).toContain('Slash commands (5)')
  expect(out.text).toContain('Session and conversation (2)')
  expect(out.text).toContain('  /clear  Clear conversation history and free up context')
  expect(w.closes).toEqual(['commands-pane']) // the undrawn pane is closed again

  // No timer was started for a pane nobody sees.
  const reads = w.reads
  await clock.advance(5 * 60_000)
  expect(w.reads).toBe(reads)
})

test('/commands text prints the grouped list and opens no pane', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)

  const out = await $.command.run({ command: 'commands', args: 'text' })

  expect(w.opens).toEqual([])
  expect(out.text.split('\n').slice(0, 5)).toEqual([
    'Slash commands (5)',
    '',
    'Session and conversation (2)',
    '  /clear  Clear conversation history and free up context',
    '  /resume  Resume a conversation',
  ])
  // Text is not collapsible: every group is listed in full.
  expect(out.text).toContain('Context and memory (2)')
  expect(out.text).toContain('  /compact  Clear conversation history but keep a summary in context')
  expect(out.text).toContain('Config and setup (1)')
})

test('/commands refresh re-reads the list; a bad argument gets the usage line', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)

  w.list = [...LIST, info('doctor', 'Diagnose your installation')]
  const refreshed = await $.command.run({ command: 'commands', args: 'refresh' })
  expect(refreshed.text).toBe('Re-read the command list: 6 commands in 3 groups.')
  expect((await $.command.run({ command: 'commands', args: 'text' })).text).toContain('/doctor')

  const bad = await $.command.run({ command: 'commands', args: 'sideways' })
  expect(bad.text).toContain('Usage: /commands')
})

test('the pane opens the first group and keeps the rest collapsed, on every surface', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Button', key: 'fold:session' }))?.props['label']).toBe(
      '▼ Session and conversation (2)',
    )
    expect((await ui.find({ type: 'Button', key: 'fold:context' }))?.props['label']).toBe(
      '► Context and memory (2)',
    )
    expect((await ui.find({ type: 'Button', key: 'fold:config' }))?.props['label']).toBe(
      '► Config and setup (1)',
    )
    // The open group shows its rows, name first with the slash; the closed ones show none.
    expect(await ui.find({ type: 'Text', text: '/clear' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/resume' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/compact' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '/model' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Slash commands (5)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Drawn on ' + surface })).toBeDefined()
    await ui.unmount()
  }
})

// Each surface gets its own engine, so one surface's choices are not the next one's starting point.
for (const surface of ['terminal', 'desktop'] as const) {
  test(`pressing a group header opens or closes it, and the choice is kept in $.store (${surface})`, async ($, on) => {
    const w = world()
    engine(on, w)
    await $.session.start(START)

    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'fold:context' })
    expect(await ui.find({ type: 'Text', text: '/compact' })).toBeDefined()
    expect((await ui.find({ key: 'fold:context' }))?.props['label']).toBe('▼ Context and memory (2)')
    expect(w.store['folds']).toEqual({ context: true })

    await ui.press({ key: 'fold:session' }) // the first group, open by default, closes by hand
    expect(await ui.find({ type: 'Text', text: '/clear' })).toBeUndefined()
    expect(w.store['folds']).toEqual({ context: true, session: false })

    await ui.press({ key: 'fold:context' })
    expect(await ui.find({ type: 'Text', text: '/compact' })).toBeUndefined()
    expect(w.store['folds']).toEqual({ session: false, context: false })

    await ui.press({ key: 'fold:session' })
    expect(await ui.find({ type: 'Text', text: '/clear' })).toBeDefined()
    await ui.unmount()
  })
}

test('choices made in an earlier session come back at the next session.start', async ($, on) => {
  const w = world()
  engine(on, w, { folds: { session: false, context: true } })
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'fold:session' }))?.props['label']).toBe('► Session and conversation (2)')
  expect((await ui.find({ key: 'fold:context' }))?.props['label']).toBe('▼ Context and memory (2)')
  expect(await ui.find({ type: 'Text', text: '/clear' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '/compact' })).toBeDefined()
  await ui.unmount()
})

test('a stored value that is not a map of booleans is ignored', async ($, on) => {
  const w = world()
  engine(on, w, { folds: 'garbage' })
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'fold:session' }))?.props['label']).toBe('▼ Session and conversation (2)')
  expect((await ui.find({ key: 'fold:context' }))?.props['label']).toBe('► Context and memory (2)')
  await ui.unmount()
})

test('plugin commands nest under one collapsible sub-group per plugin', async ($, on) => {
  const w = world({
    list: [
      info('docx', 'Word documents', 'plugin', 'anthropic-skills'),
      info('example-plugin:run', 'Run an example task', 'plugin', 'example-plugin'),
      info('example-plugin:verify', 'Verify the recode', 'plugin', 'example-plugin'),
      info('standup', 'My daily note', 'user'),
    ],
  })
  engine(on, w)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Skills and plugins is the first group, so it is open; its sub-groups start closed.
  expect((await ui.find({ key: 'fold:plugins' }))?.props['label']).toBe('▼ Skills and plugins (3)')
  expect((await ui.find({ key: 'fold:plugins/anthropic-skills' }))?.props['label']).toBe(
    '► anthropic-skills (1)',
  )
  expect((await ui.find({ key: 'fold:plugins/example-plugin' }))?.props['label']).toBe('► example-plugin (2)')
  expect(await ui.find({ type: 'Text', text: '/example-plugin:run' })).toBeUndefined()
  expect((await ui.find({ key: 'fold:user' }))?.props['label']).toBe('► Your own commands (1)')

  await ui.press({ key: 'fold:plugins/example-plugin' })
  expect(await ui.find({ type: 'Text', text: '/example-plugin:run' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/docx' })).toBeUndefined()
  expect(w.store['folds']).toEqual({ 'plugins/example-plugin': true })
  await ui.unmount()
})

test('rows are cut to the width of the pane', async ($, on) => {
  const w = world({ list: [info('compact', 'x'.repeat(200))] })
  engine(on, w)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
  const row = await ui.find({ type: 'Text', text: '/compact' })

  // Two columns of indent come off the 40, and the cut ends in an ellipsis.
  expect(row?.text).toBeDefined()
  expect(row?.text.length).toBeLessThanOrEqual(38)
  expect(row?.text.endsWith('…')).toBe(true)
  await ui.unmount()
})

test('Refresh re-reads the list and the pane shows what is new', async ($, on) => {
  const w = world()
  engine(on, w)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '/hello' })).toBeUndefined()

  w.list = [...LIST, info('hello', 'Says hi', 'builtin')] // lands in Other
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ type: 'Text', text: 'Slash commands (6)' })).toBeDefined()
  expect(await ui.find({ key: 'fold:other' })).toBeDefined()
  await ui.unmount()
})

test('an empty list says so instead of drawing nothing', async ($, on) => {
  const w = world({ list: [] })
  engine(on, w)
  await $.session.start(START)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'No commands read yet. Press Refresh.' })).toBeDefined()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()
  await ui.unmount()
})

test('while the pane is open the list is re-read every 60 s, and closing it stops that', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await $.session.start(START)

  // Closed: nothing ticks.
  const atStart = w.reads
  await clock.advance(5 * 60_000)
  expect(w.reads).toBe(atStart)

  await $.command.run({ command: 'commands', args: '' }) // opens, and reads once
  const atOpen = w.reads
  await clock.advance(59_000)
  expect(w.reads).toBe(atOpen)
  await clock.advance(1_000)
  expect(w.reads).toBe(atOpen + 1)
  await clock.advance(60_000)
  expect(w.reads).toBe(atOpen + 2)

  await $.command.run({ command: 'commands', args: '' }) // closes
  const atClose = w.reads
  await clock.advance(10 * 60_000)
  expect(w.reads).toBe(atClose)
})

test('a timer that finds its pane gone stops itself', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await $.session.start(START)
  await $.command.run({ command: 'commands', args: '' })

  w.panes = [] // closed without a ui.close reaching the plugin
  const atLoss = w.reads
  await clock.advance(60_000)
  expect(w.reads).toBe(atLoss) // the tick looked, saw no pane, and did not read
  w.panes = [{ id: 'commands-pane', title: 'Commands', isShown: true, isFocused: false, isPlaced: true }]
  await clock.advance(10 * 60_000)
  expect(w.reads).toBe(atLoss) // and it has stopped for good
})

test('after an unplaced answer, running /commands again asks again', async ($, on) => {
  const w = world({ isPlaced: false, reason: 'no surface' })
  engine(on, w)
  await $.session.start(START)
  await $.command.run({ command: 'commands', args: '' })

  w.isPlaced = true
  const second = await $.command.run({ command: 'commands', args: '' })
  expect(second.text).toContain('isPlaced true')
  expect(w.opens).toEqual(['commands-pane', 'commands-pane'])
})
