import type { CommandInfo, On, PromptSubmitResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Nothing sits beneath the plugin: each hook here stands for the engine.
let clock: ReturnType<typeof mock.clock>

type Ask = { questions: string[]; answer: string | 'dismiss' | 'hang' }

// What the engine below the plugin says about commands: the session's command list, and what happens to a command
// the plugin queues with $.command.run (ok: answers at once; reject: refuses; hang: never settles, as a command
// queued behind a running turn does until the session is idle).
type World = { commands: CommandInfo[] | 'unreadable'; runs: string[]; runMode: 'ok' | 'reject' | 'hang' }

const AGENTS: CommandInfo = { name: 'agents-info', description: 'Agents panel', source: 'plugin', plugin: 'savvy-progress' }
const TASKS: CommandInfo = { name: 'tasks', description: 'View and manage everything running in the background', source: 'builtin' }

function world(over: Partial<World> = {}): World {
  return { commands: [AGENTS, TASKS], runs: [], runMode: 'ok', ...over }
}

function engine(on: On, toasts: string[], ask?: Ask, w?: World, stored?: Record<string, unknown>) {
  mock.store(on, stored)
  clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'subagent-advisor' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  if (w) {
    on('command.list', () => {
      if (w.commands === 'unreadable') throw new Error('the list is not available')
      return { value: w.commands }
    })
    on('command.run', (_, e) => {
      w.runs.push(`${e.command} ${e.args}`.trim())
      if (w.runMode === 'reject') throw new Error('refused')
      if (w.runMode === 'hang') return new Promise<never>(() => undefined)
      return { text: 'ok' }
    })
  }
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  // What reaches the bottom of prompt.submit: the text and the hidden context the mod attached.
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion' && ask) {
      const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
      ask.questions.push(q)
      if (ask.answer === 'dismiss') return { deny: 'dismissed' }
      if (ask.answer === 'hang') return new Promise<never>(() => undefined)
      return { result: { questions: [], answers: { [q]: ask.answer } } } as never
    }
    return { result: {} }
  })
}

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const BROAD = 'Search across the whole codebase and find every place we call the legacy pricing API'

test('a broad search gets an Explore suggestion and the prompt still goes through', { options: { mode: 'auto-continue' } }, async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start(START)
  const r = await $.prompt.submit({ text: BROAD, asUser: true })
  expect(r.text).toBe(BROAD)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/Explore/)
})

test('a plain prompt gets nothing', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start(START)
  await $.prompt.submit({ text: 'Rename this variable to something clearer please, thanks', asUser: true })
  expect(toasts.length).toBe(0)
})

test('independent parts get a parallel suggestion', { options: { mode: 'auto-continue' } }, async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start(START)
  await $.prompt.submit({
    text: 'Do these:\n- check the fuel report\n- check the plant register\n- check the timesheets\nThey are independent.',
    asUser: true,
  })
  expect(toasts[0]).toMatch(/parallel/)
})

test('a prompt that already names subagents is left alone', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start(START)
  await $.prompt.submit({ text: 'Use a subagent to search across the whole codebase for every call to it', asUser: true })
  expect(toasts.length).toBe(0)
})

test('many Read calls in one turn nudge once', { options: { mode: 'auto-continue' } }, async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (let i = 0; i < 12; i += 1) await $.tool.call({ tool: 'Read', file_path: `/f${i}.ts` })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/Read\/Grep\/Glob/)
})

test('off stops suggestions', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start(START)
  await $.command.run({ command: 'subagent-advisor', args: 'off' })
  await $.prompt.submit({ text: BROAD, asUser: true })
  expect(toasts.length).toBe(0)
})

const ONE_SIGNAL = 'Please audit the permission checks in the billing module carefully'

test('medium stays quiet on one signal', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start(START)
  await $.prompt.submit({ text: ONE_SIGNAL, asUser: true })
  expect(toasts.length).toBe(0)
})

test('high speaks on one signal', { options: { sensitivity: 'high', mode: 'auto-continue' } }, async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)
  await $.session.start(START)
  await $.prompt.submit({ text: ONE_SIGNAL, asUser: true })
  expect(toasts.length).toBe(1)
})

// Mode ask (the default): the prompt is held and the person is asked.
async function submit($: Parameters<Parameters<typeof test>[1]>[0], text: string): Promise<PromptSubmitResult> {
  return $.prompt.submit({ text, asUser: true })
}

test('ask: the prompt is held and the question names the kind', async ($, on) => {
  const toasts: string[] = []
  const ask: Ask = { questions: [], answer: 'Continue as normal' }
  engine(on, toasts, ask)
  await $.session.start(START)
  await submit($, BROAD)
  expect(ask.questions.length).toBe(1)
  expect(ask.questions[0]).toMatch(/Explore/)
})

test('ask: Use subagents attaches the delegation instruction, text unchanged', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Use subagents' }
  engine(on, [], ask)
  await $.session.start(START)
  const r = await submit($, BROAD)
  expect(r.text).toBe(BROAD)
  expect(String(r.context?.[0])).toMatch(/Explore subagent/)
})

test('ask: Continue as normal passes the prompt unchanged', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Continue as normal' }
  engine(on, [], ask)
  await $.session.start(START)
  const r = await submit($, BROAD)
  expect(r.text).toBe(BROAD)
  expect(r.context).toBeUndefined()
})

test('ask: Auto always use subagents delegates now and never asks again', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Auto: always use subagents' }
  engine(on, [], ask)
  await $.session.start(START)
  const first = await submit($, BROAD)
  expect(String(first.context?.[0])).toMatch(/subagent/)
  // Cooldown: two plain prompts, then a qualifying one.
  await submit($, 'Rename this variable to something clearer please, thanks')
  await submit($, 'Rename this variable to something clearer please, thanks')
  const again = await submit($, BROAD)
  expect(ask.questions.length).toBe(1)
  expect(String(again.context?.[0])).toMatch(/subagent/)
})

test('ask: Auto never ask again continues without asking afterwards', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Auto: never ask again' }
  engine(on, [], ask)
  await $.session.start(START)
  await submit($, BROAD)
  await submit($, 'Rename this variable to something clearer please, thanks')
  await submit($, 'Rename this variable to something clearer please, thanks')
  const again = await submit($, BROAD)
  expect(ask.questions.length).toBe(1)
  expect(again.context).toBeUndefined()
})

test('auto-delegate: no question, instruction attached', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Continue as normal' }
  engine(on, [], ask)
  await $.session.start(START)
  const r = await submit($, BROAD)
  expect(ask.questions.length).toBe(0)
  expect(String(r.context?.[0])).toMatch(/Explore subagent/)
})

test('auto-continue: no question, prompt unchanged', { options: { mode: 'auto-continue' } }, async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Use subagents' }
  engine(on, [], ask)
  await $.session.start(START)
  const r = await submit($, BROAD)
  expect(ask.questions.length).toBe(0)
  expect(r.context).toBeUndefined()
})

test('mode off in config is silent', { options: { mode: 'off' } }, async ($, on) => {
  const toasts: string[] = []
  const ask: Ask = { questions: [], answer: 'Use subagents' }
  engine(on, toasts, ask)
  await $.session.start(START)
  await submit($, BROAD)
  expect(ask.questions.length + toasts.length).toBe(0)
})

test('the mode command switches mode and wins over config', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Continue as normal' }
  engine(on, [], ask)
  await $.session.start(START)
  const c = await $.command.run({ command: 'subagent-advisor', args: 'mode auto-delegate' })
  expect(c.text).toMatch(/auto-delegate/)
  const r = await submit($, BROAD)
  expect(ask.questions.length).toBe(0)
  expect(String(r.context?.[0])).toMatch(/subagent/)
  const bad = await $.command.run({ command: 'subagent-advisor', args: 'mode nonsense' })
  expect(bad.text).toMatch(/Type \/subagent-advisor mode/)
})

test('failure: a dismissed or failed question lets the prompt through unchanged', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'dismiss' }
  engine(on, [], ask)
  await $.session.start(START)
  const r = await submit($, BROAD)
  expect(ask.questions.length).toBe(1)
  expect(r.text).toBe(BROAD)
  expect(r.context).toBeUndefined()
})

test('failure: no answer in time lets the prompt through unchanged', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'hang' }
  engine(on, [], ask)
  await $.session.start(START)
  const pending = submit($, BROAD)
  await clock.advance(130_000)
  const r = await pending
  expect(r.text).toBe(BROAD)
  expect(r.context).toBeUndefined()
})

test('slash commands and meta prompts are never asked about', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Use subagents' }
  engine(on, [], ask)
  await $.session.start(START)
  await submit($, '/review ' + BROAD)
  expect(ask.questions.length).toBe(0)
})

// Views: after a subagent choice, /agents-info open and the built-in /tasks are queued when the choice's turn ends.
const PLAIN = 'Rename this variable to something clearer please, thanks'

type Kit = Parameters<Parameters<typeof test>[1]>[0]

async function startTurn($: Kit, turnId: string, agentId?: string): Promise<void> {
  await $.turn.start({ text: 'go', turnId, ...(agentId ? { agentId } : {}) })
}

// Ends a turn, then lets what the plugin queued unawaited (the commands) land.
async function endTurn($: Kit, turnId: string, over: { agentId?: string; aborted?: boolean } = {}): Promise<void> {
  await $.turn.complete({
    answer: 'done',
    durationMs: 5,
    turnId,
    isAborted: over.aborted === true,
    reason: over.aborted ? 'aborted' : 'answer',
    ...(over.agentId ? { agentId: over.agentId } : {}),
  })
  await clock.settle()
}

// Two plain prompts clear the cooldown so the next qualifying prompt is looked at again.
async function cooldown($: Kit): Promise<void> {
  await submit($, PLAIN)
  await submit($, PLAIN)
}

test('views: Use subagents queues /agents-info open and /tasks once, when the turn ends, prompt unchanged', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Use subagents' }
  const w = world()
  engine(on, [], ask, w)
  await $.session.start(START)
  const r = await submit($, BROAD)
  expect(r.text).toBe(BROAD)
  expect(String(r.context?.[0])).toMatch(/Explore subagent/)
  await startTurn($, 't1')
  await clock.settle()
  // Nothing runs while the turn is under way, and nothing ran inside the prompt hook.
  expect(w.runs.length).toBe(0)
  await endTurn($, 't1')
  expect(w.runs).toEqual(['agents-info open', 'tasks'])
})

test('views: Auto always use subagents opens the views for that turn, and for the next choice', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Auto: always use subagents' }
  const w = world()
  engine(on, [], ask, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(w.runs).toEqual(['agents-info open', 'tasks'])
  await cooldown($)
  await submit($, BROAD)
  await startTurn($, 't2')
  await endTurn($, 't2')
  expect(ask.questions.length).toBe(1)
  expect(w.runs).toEqual(['agents-info open', 'tasks', 'agents-info open', 'tasks'])
})

test('views: auto-delegate mode opens them with no question', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Continue as normal' }
  const w = world()
  engine(on, [], ask, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(ask.questions.length).toBe(0)
  expect(w.runs).toEqual(['agents-info open', 'tasks'])
})

test('views: Continue as normal opens nothing', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Continue as normal' }
  const w = world()
  engine(on, [], ask, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(ask.questions.length).toBe(1)
  expect(w.runs.length).toBe(0)
})

test('views: Auto never ask again opens nothing, now or later', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Auto: never ask again' }
  const w = world()
  engine(on, [], ask, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  await cooldown($)
  await submit($, BROAD)
  await startTurn($, 't2')
  await endTurn($, 't2')
  expect(w.runs.length).toBe(0)
})

test('views: never twice for one choice, and a subagent turn does not spend it', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const w = world()
  engine(on, [], undefined, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  // A subagent's own turn start and end, ids of its own, change nothing.
  await startTurn($, 'sub1', 'agent-1')
  await endTurn($, 'sub1', { agentId: 'agent-1' })
  expect(w.runs.length).toBe(0)
  await endTurn($, 't1')
  expect(w.runs).toEqual(['agents-info open', 'tasks'])
  // The same turn ending again, and a later turn with no choice behind it.
  await endTurn($, 't1')
  await submit($, PLAIN)
  await startTurn($, 't2')
  await endTurn($, 't2')
  expect(w.runs).toEqual(['agents-info open', 'tasks'])
})

test('views: a choice never carries over to another prompt', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const w = world()
  engine(on, [], undefined, w)
  await $.session.start(START)
  // The choice is made, but no turn starts for that prompt. The next prompt makes no choice.
  await submit($, BROAD)
  await submit($, PLAIN)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(w.runs.length).toBe(0)
})

test('views: an aborted turn opens nothing', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const w = world()
  engine(on, [], undefined, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1', { aborted: true })
  expect(w.runs.length).toBe(0)
})

test('views: a prompt typed over a running turn opens nothing', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const w = world()
  engine(on, [], undefined, w)
  await $.session.start(START)
  await $.prompt.submit({ text: BROAD, asUser: true, turnId: 'running' } as never)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(w.runs.length).toBe(0)
})

test('views: skips /agents-info quietly when it is missing, with one install toast per session', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const toasts: string[] = []
  const w = world({ commands: [TASKS] })
  engine(on, toasts, undefined, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  await cooldown($)
  await submit($, BROAD)
  await startTurn($, 't2')
  await endTurn($, 't2')
  // /tasks is still queued; /agents-info never is.
  expect(w.runs).toEqual(['tasks', 'tasks'])
  const hints = toasts.filter(t => /savvy-progress/.test(t))
  expect(hints.length).toBe(1)
  expect(hints[0]).toMatch(/not installed/)
})

test('views: neither command listed means nothing is run', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const w = world({ commands: [] })
  engine(on, [], undefined, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(w.runs.length).toBe(0)
})

test('views: a command list that cannot be read runs nothing and shows nothing', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const toasts: string[] = []
  const w = world({ commands: 'unreadable' })
  engine(on, toasts, undefined, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(w.runs.length).toBe(0)
  expect(toasts.filter(t => /savvy-progress/.test(t)).length).toBe(0)
})

test('views: only the engine /tasks and a plugin /agents-info are ever run', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const w = world({
    commands: [
      { name: 'tasks', description: 'my own', source: 'user' },
      { name: 'agents-info', description: 'my own', source: 'user' },
    ],
  })
  engine(on, [], undefined, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(w.runs.length).toBe(0)
})

test('views: openViews false in config switches them off', { options: { mode: 'auto-delegate', openViews: false } }, async ($, on) => {
  const w = world()
  engine(on, [], undefined, w)
  await $.session.start(START)
  const r = await submit($, BROAD)
  // The delegation itself is unchanged.
  expect(String(r.context?.[0])).toMatch(/Explore subagent/)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(w.runs.length).toBe(0)
})

test('views: the views command switches them off and on, and wins over config', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const w = world()
  engine(on, [], undefined, w)
  await $.session.start(START)
  const off = await $.command.run({ command: 'subagent-advisor', args: 'views off' })
  expect(off.text).toMatch(/Views are off/)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(w.runs.length).toBe(0)
  const back = await $.command.run({ command: 'subagent-advisor', args: 'views on' })
  expect(back.text).toMatch(/Views are on/)
  await cooldown($)
  await submit($, BROAD)
  await startTurn($, 't2')
  await endTurn($, 't2')
  expect(w.runs).toEqual(['agents-info open', 'tasks'])
  const bare = await $.command.run({ command: 'subagent-advisor', args: 'views' })
  expect(bare.text).toMatch(/Type \/subagent-advisor views on or views off/)
})

test('views: switching them off after the choice and before the turn ends opens nothing', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const w = world()
  engine(on, [], undefined, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await $.command.run({ command: 'subagent-advisor', args: 'views off' })
  await endTurn($, 't1')
  expect(w.runs.length).toBe(0)
})

test('views: a stored override is read at session start and wins over config', { options: { mode: 'auto-delegate', openViews: true } }, async ($, on) => {
  const w = world()
  engine(on, [], undefined, w, { views: false })
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(w.runs.length).toBe(0)
})

test('views: status says what is on and what the session lists', async ($, on) => {
  engine(on, [], undefined, world())
  await $.session.start(START)
  const s = await $.command.run({ command: 'subagent-advisor', args: 'status' })
  expect(s.text).toMatch(/Views: on \(from config\)/)
  expect(s.text).toMatch(/\/agents-info found; built-in \/tasks found/)
})

test('views: status reports a missing /agents-info and an unreadable list without guessing', async ($, on) => {
  const w = world({ commands: [] })
  engine(on, [], undefined, w)
  await $.session.start(START)
  const missing = await $.command.run({ command: 'subagent-advisor', args: 'status' })
  expect(missing.text).toMatch(/\/agents-info not found \(needs the savvy-progress mod\); built-in \/tasks not listed/)
  w.commands = 'unreadable'
  const unreadable = await $.command.run({ command: 'subagent-advisor', args: 'status' })
  expect(unreadable.text).toMatch(/the command list could not be read/)
})

test('failure: when the queued command is refused, the prompt and the turn are unaffected', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Use subagents' }
  const w = world({ runMode: 'reject' })
  engine(on, [], ask, w)
  await $.session.start(START)
  const r = await submit($, BROAD)
  expect(r.text).toBe(BROAD)
  expect(String(r.context?.[0])).toMatch(/Explore subagent/)
  await startTurn($, 't1')
  await endTurn($, 't1')
  // Both were attempted, once each, and the refusal went nowhere.
  expect(w.runs).toEqual(['agents-info open', 'tasks'])
})

test('failure: a queued command that never settles does not hold the turn', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Use subagents' }
  const w = world({ runMode: 'hang' })
  engine(on, [], ask, w)
  await $.session.start(START)
  await submit($, BROAD)
  await startTurn($, 't1')
  // Resolves because the plugin never awaits the queued command; a plugin that did would hang here.
  const done = await $.turn.complete({ answer: 'done', durationMs: 5, turnId: 't1', isAborted: false, reason: 'answer' })
  expect(done.text).toBe('done')
  await clock.settle()
  expect(w.runs).toEqual(['agents-info open', 'tasks'])
})

test('views: slash commands never open them', async ($, on) => {
  const ask: Ask = { questions: [], answer: 'Use subagents' }
  const w = world()
  engine(on, [], ask, w)
  await $.session.start(START)
  await submit($, '/review ' + BROAD)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(ask.questions.length).toBe(0)
  expect(w.runs.length).toBe(0)
})

test('views: meta prompts and notifications never open them', { options: { mode: 'auto-delegate' } }, async ($, on) => {
  const w = world()
  engine(on, [], undefined, w)
  await $.session.start(START)
  // A prompt the person does not see as typed is never looked at.
  await $.prompt.submit({ text: BROAD, asUser: true, isMeta: true } as never)
  await startTurn($, 't1')
  await endTurn($, 't1')
  expect(w.runs.length).toBe(0)
  // A notification is not the person either.
  await $.prompt.submit({ text: BROAD, origin: { kind: 'task-notification' } } as never)
  await startTurn($, 't2')
  await endTurn($, 't2')
  expect(w.runs.length).toBe(0)
})
