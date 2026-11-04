import type { On, PromptSubmitResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { looksLikeDecision } from './advisor-logic'

let clock: ReturnType<typeof mock.clock>

type Ask = { questions: string[]; answer: string | 'dismiss' | 'hang' }
type Env = { toasts: string[]; runs: string[]; sets: string[]; ask: Ask }

// Nothing sits beneath the plugin: each hook here stands for the engine.
function engine(on: On, answer: Ask['answer'], opts: { advisorRow?: boolean; runText?: string } = {}): Env {
  const env: Env = { toasts: [], runs: [], sets: [], ask: { questions: [], answer } }
  mock.store(on)
  clock = mock.clock(on)
  on('command.register', () => ({ value: { command: 'decision-support' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', (_, e) => {
    env.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('command.run', { command: 'advisor' }, (_, e) => {
    env.runs.push(e.args)
    return { text: opts.runText ?? `Advisor set to ${e.args}` }
  })
  on('config.list', () => ({
    value: opts.advisorRow
      ? [{ key: 'advisorModel', label: 'Advisor', kind: 'text', value: '', provider: { plugin: 'engine', tier: 'core' }, isLocked: false }]
      : [],
  }) as never)
  on('config.set', (_, e) => {
    env.sets.push(`${e.key}=${String(e.value)}`)
    return { value: e.value }
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
      env.ask.questions.push(q)
      if (env.ask.answer === 'dismiss') return { deny: 'dismissed' }
      if (env.ask.answer === 'hang') return new Promise<never>(() => undefined)
      return { result: { questions: [], answers: { [q]: env.ask.answer } } } as never
    }
    return { result: {} }
  })
  return env
}

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const RISKY = 'Review the contract clause on liquidated damages and our margin before we sign'
const PLAIN = 'rename this variable to total and fix the import please'
const OFFER = 'I can do this two ways. Option A keeps the table, option B splits it. Which approach would you prefer?'
const USE = 'Use /advisor with claude-fable-5-1'

async function submit($: Parameters<Parameters<typeof test>[1]>[0], text: string): Promise<PromptSubmitResult> {
  return $.prompt.submit({ text, asUser: true })
}

async function finish($: Parameters<Parameters<typeof test>[1]>[0], answer: string, turnId = 't1', agentId?: string) {
  return $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId, reason: 'answer', agentId } as never)
}

test('ask: the prompt is held, the question names the reason and model, text unchanged', async ($, on) => {
  const env = engine(on, 'Continue without advisor')
  await $.session.start(START)
  const r = await submit($, RISKY)
  expect(r.text).toBe(RISKY)
  expect(env.ask.questions.length).toBe(1)
  expect(env.ask.questions[0]).toMatch(/second opinion helps \(commercial or contract\)/)
  expect(env.ask.questions[0]).toMatch(/Use \/advisor with claude-fable-5-1/)
  expect(env.runs.length).toBe(0)
})

test('ask: use on a prompt sets the advisor through a config row when one exists', async ($, on) => {
  const env = engine(on, USE, { advisorRow: true })
  await $.session.start(START)
  const r = await submit($, RISKY)
  expect(r.text).toBe(RISKY)
  expect(env.sets).toEqual(['advisorModel=claude-fable-5-1'])
  expect(env.runs.length).toBe(0)
})

test('ask: use on a prompt with no advisor row shows the exact command to type', async ($, on) => {
  const env = engine(on, USE)
  await $.session.start(START)
  const r = await submit($, RISKY)
  expect(r.text).toBe(RISKY)
  expect(env.sets.length).toBe(0)
  expect(env.toasts.join('\n')).toMatch(/Type \/advisor claude-fable-5-1/)
})

test('ask: continue changes nothing', async ($, on) => {
  const env = engine(on, 'Continue without advisor', { advisorRow: true })
  await $.session.start(START)
  await submit($, RISKY)
  expect(env.sets.length + env.runs.length + env.toasts.length).toBe(0)
})

test('ask: Auto always suggest acts now, then only toasts and never asks again', async ($, on) => {
  const env = engine(on, 'Auto: always suggest this model')
  await $.session.start(START)
  await submit($, RISKY)
  await submit($, PLAIN)
  await submit($, PLAIN)
  await submit($, PLAIN)
  await submit($, RISKY)
  expect(env.ask.questions.length).toBe(1)
  expect(env.toasts.some(t => /Try \/advisor claude-fable-5-1/.test(t))).toBe(true)
})

test('ask: Auto never ask again goes silent', async ($, on) => {
  const env = engine(on, 'Auto: never ask again')
  await $.session.start(START)
  await submit($, RISKY)
  for (let i = 0; i < 3; i += 1) await submit($, PLAIN)
  await submit($, RISKY)
  expect(env.ask.questions.length).toBe(1)
  expect(env.toasts.length).toBe(0)
})

test('failure: a dismissed question lets the prompt through unchanged', async ($, on) => {
  const env = engine(on, 'dismiss')
  await $.session.start(START)
  const r = await submit($, RISKY)
  expect(env.ask.questions.length).toBe(1)
  expect(r.text).toBe(RISKY)
  expect(env.toasts.length).toBe(0)
})

test('failure: no answer in time lets the prompt through unchanged', async ($, on) => {
  const env = engine(on, 'hang')
  await $.session.start(START)
  const pending = submit($, RISKY)
  await clock.advance(130_000)
  const r = await pending
  expect(r.text).toBe(RISKY)
  expect(env.toasts.length).toBe(0)
})

test('slash commands and plain prompts are never asked about', async ($, on) => {
  const env = engine(on, USE)
  await $.session.start(START)
  await submit($, '/review ' + RISKY)
  await submit($, PLAIN)
  expect(env.ask.questions.length).toBe(0)
})

test('mode: the command switches to auto-suggest (toast, no question) and wins over config', async ($, on) => {
  const env = engine(on, USE)
  await $.session.start(START)
  const c = await $.command.run({ command: 'decision-support', args: 'mode auto-suggest' })
  expect(c.text).toMatch(/auto-suggest/)
  await submit($, RISKY)
  expect(env.ask.questions.length).toBe(0)
  expect(env.toasts.length).toBe(1)
  const bad = await $.command.run({ command: 'decision-support', args: 'mode nonsense' })
  expect(bad.text).toMatch(/Type \/decision-support mode/)
  const st = await $.command.run({ command: 'decision-support', args: 'status' })
  expect(st.text).toMatch(/Mode: auto-suggest/)
})

test('mode off in config is silent', { options: { mode: 'off' } }, async ($, on) => {
  const env = engine(on, USE)
  await $.session.start(START)
  await submit($, RISKY)
  await finish($, OFFER)
  expect(env.ask.questions.length + env.toasts.length).toBe(0)
})

test('decision point: Claude calling AskUserQuestion is asked about at the end of the turn, use runs /advisor', async ($, on) => {
  const env = engine(on, USE)
  await $.session.start(START)
  await $.turn.start({ text: 'go', turnId: 't1' })
  // Claude's own question: the engine stand-in answers it; the mod must not ask yet.
  env.ask.answer = 'Option A'
  await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which schema design should we use?', header: 'Design', options: [], multiSelect: false }] } as never)
  expect(env.ask.questions.length).toBe(1)
  env.ask.answer = 'Use /advisor with claude-opus-5-5'
  await finish($, 'Done with the change.')
  expect(env.ask.questions.length).toBe(2)
  expect(env.ask.questions[1]).toMatch(/second opinion helps/)
  expect(env.toasts.join('|')).toMatch(/Advisor set to claude-opus-5-5/)
  expect(env.runs).toEqual(['claude-opus-5-5'])
})

test('decision point: final text that offers options triggers one ask', async ($, on) => {
  const env = engine(on, 'Continue without advisor')
  await $.session.start(START)
  await finish($, OFFER)
  expect(env.ask.questions.length).toBe(1)
  expect(env.runs.length).toBe(0)
})

test('decision point: a plain finished-work turn is not asked about', async ($, on) => {
  const env = engine(on, USE)
  await $.session.start(START)
  await finish($, 'I renamed the variable and fixed the import. Tests pass. Option A was used as discussed.')
  expect(env.ask.questions.length).toBe(0)
})

test('decision point: subagent turns never ask', async ($, on) => {
  const env = engine(on, USE)
  await $.session.start(START)
  await finish($, OFFER, 'sub1', 'agent-1')
  expect(env.ask.questions.length).toBe(0)
})

test('decision point: at most one ask per turn, and a cooldown after one', async ($, on) => {
  const env = engine(on, 'Continue without advisor')
  await $.session.start(START)
  await submit($, RISKY)
  expect(env.ask.questions.length).toBe(1)
  await finish($, OFFER)
  expect(env.ask.questions.length).toBe(1)
  await finish($, OFFER, 't2')
  expect(env.ask.questions.length).toBe(1)
})

test('decision point: the mod ignores its own ask, so one prompt hold raises one question', async ($, on) => {
  const env = engine(on, 'Continue without advisor')
  await $.session.start(START)
  await submit($, RISKY)
  await finish($, 'ok, finished.')
  expect(env.ask.questions.length).toBe(1)
})

test('decision point: a dismissed end-of-turn question does nothing', async ($, on) => {
  const env = engine(on, 'dismiss')
  await $.session.start(START)
  await finish($, OFFER)
  expect(env.ask.questions.length).toBe(1)
  expect(env.runs.length + env.sets.length + env.toasts.length).toBe(0)
})

test('looksLikeDecision is conservative', () => {
  expect(looksLikeDecision(OFFER)).toBe(true)
  expect(looksLikeDecision('Done. I used option A here and kept everything else as it was in the file.')).toBe(false)
  expect(looksLikeDecision('Should I use the old table or a new one? My recommendation is the new one, option B.')).toBe(true)
})
