import type { EngineInterface, Register } from 'claude-code'

import { DECISION_DEFAULT, classify, labelOf, looksLikeDecision } from './advisor-logic'
import type { DecisionInfo, Sensitivity, Tier } from './advisor-logic'

// Deterministic heuristics only: no model calls, no network. Text is read inside one call and never stored.

const NAME = 'decision-support'
const TOAST_MS = 14_000
// How long a question waits before the prompt (or the turn) goes on unchanged.
const ASK_MS = 120_000
// How long to wait for /advisor to run when the mod asks the engine to run it.
const RUN_MS = 4_000
const HEADER = 'Advisor'
const MODES = ['ask', 'auto-suggest', 'off'] as const
type Mode = (typeof MODES)[number]
const KEEP = 'Continue without advisor'
const AUTO_USE = 'Auto: always suggest this model'
const AUTO_OFF = 'Auto: never ask again'
const DEFAULTS: Record<Tier, string> = {
  deep: 'claude-fable-5-1',
  standard: 'claude-opus-5-5',
  quick: 'claude-haiku-5-5',
}
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,80}$/

function modelOf(value: unknown, tier: Tier): string {
  return typeof value === 'string' && MODEL_ID.test(value.trim()) ? value.trim() : DEFAULTS[tier]
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function sensitivityOf(value: unknown): Sensitivity {
  return value === 'low' || value === 'high' ? value : 'medium'
}

function asMode(v: unknown): Mode | undefined {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v) ? (v as Mode) : undefined
}

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

function isPersonOrigin(o: { kind?: string; asUser?: boolean } | undefined): boolean {
  if (o === undefined) return true
  if (o.kind === 'plugin') return o.asUser === true
  return !AUTOMATED_ORIGINS.has(o.kind ?? '')
}

// Everything the hooks share, built once per register() call and passed to the helpers below.
type St = {
  models: Record<Tier, string>
  sensitivity: Sensitivity
  cooldown: number
  mode: () => Mode
  setMode: (m: Mode) => void
  asking: boolean
  askedThisTurn: boolean
  pending: DecisionInfo | undefined
  turnsSince: number
  shown: number
  last: string
}

function suggest($: EngineInterface, label: string, model: string) {
  $.ui.toast(
    `Second opinion? This looks like a ${label}. Try /advisor ${model}. Ignore this to carry on; /decision-support mode off stops these.`,
    { timeoutMs: TOAST_MS },
  )
}

// Asks one question and resolves to the label chosen, or null when it was dismissed, failed (a -p run has no
// one to ask) or got no answer in time. The caller then carries on as if nothing was asked.
async function choose($: EngineInterface, question: string, options: readonly string[]): Promise<string | null> {
  try {
    const timeout = $.clock.sleep(ASK_MS).then(() => null)
    const answer = $.ui.ask(question, { options, header: HEADER })
    answer.catch(() => undefined)
    return await Promise.race([answer, timeout])
  } catch {
    return null
  }
}

// Sets the advisor through the engine, never by editing settings. Order: (1) run the built-in /advisor via
// $.command.run, only where the turn is not waiting on this hook (canRun); (2) a /config row for the advisor,
// if the session lists one; (3) otherwise say exactly what to type. Returns the line to show.
async function applyAdvisor($: EngineInterface, model: string, canRun: boolean): Promise<string> {
  const typed = `/advisor ${model}`
  if (canRun) {
    try {
      const timeout = $.clock.sleep(RUN_MS).then(() => null)
      const ran = $.command.run({ command: 'advisor', args: model })
      ran.catch(() => undefined)
      const r = (await Promise.race([ran, timeout])) as { text?: string } | null
      if (r === null) return `Asked Claude Code to run ${typed}. If no "Advisor set to" line appears, type ${typed} yourself.`
      if (typeof r.text === 'string' && r.text.trim() !== '') return r.text.trim().slice(0, 300)
    } catch {
      // Fall through to the next way.
    }
  }
  try {
    const rows = await $.config.list()
    const row = rows.find(
      x => /advisor/i.test(x.key) && !x.key.startsWith(`${NAME}.`) && !x.isLocked && (x.kind === 'text' || x.kind === 'choice'),
    )
    if (row) {
      const value = row.kind === 'choice' ? row.options?.find(o => o === model) : model
      if (value !== undefined) {
        const r = await $.config.set({ key: row.key, value })
        if (r.deny === undefined) return `Advisor set to ${model}.`
      }
    }
  } catch {
    // Fall through.
  }
  return `Advisor not changed from here. Type ${typed} to use it.`
}

// Holds the caller while the person decides. In auto-suggest it only shows the suggestion. Never throws.
async function askFlow($: EngineInterface, st: St, info: DecisionInfo, why: string, canRun: boolean): Promise<void> {
  try {
    const model = st.models[info.tier]
    st.shown += 1
    st.last = info.label
    if (st.mode() === 'auto-suggest') {
      suggest($, info.label, model)
      return
    }
    if (st.asking) return
    st.asking = true
    st.askedThisTurn = true
    try {
      const use = `Use /advisor with ${model}`
      const answer = await choose(
        $,
        `This looks like a decision where a second opinion helps (${info.label}). Use /advisor with ${model} (${why})?`,
        [use, KEEP, AUTO_USE, AUTO_OFF],
      )
      if (answer === use || answer === AUTO_USE) {
        $.ui.toast(await applyAdvisor($, model, canRun), { timeoutMs: TOAST_MS })
      }
      if (answer === AUTO_USE || answer === AUTO_OFF) {
        const m: Mode = answer === AUTO_USE ? 'auto-suggest' : 'off'
        st.setMode(m)
        await $.store.set('mode', m)
      }
    } finally {
      st.asking = false
    }
  } catch {
    // A failed question never touches the prompt or the turn.
  }
}

// What Claude's own AskUserQuestion call is about, as a tier and label; the text is dropped after this call.
function infoFromQuestions(e: unknown, sensitivity: Sensitivity): DecisionInfo {
  try {
    const qs = (e as { questions?: { question?: string; header?: string }[] }).questions ?? []
    const text = qs.map(q => String(q.question ?? '')).join(' ')
    const v = classify(text, sensitivity)
    if (v) return { label: labelOf(v.category), tier: v.tier, why: v.why }
  } catch {
    // Use the default.
  }
  return DECISION_DEFAULT
}

function isOwnAsk(e: unknown): boolean {
  const qs = (e as { questions?: { header?: string }[] }).questions
  return qs?.[0]?.header === HEADER
}

export const register: Register = (on, options) => {
  // The built-in /advisor is never touched: this mod's command is /decision-support.
  const cfgEnabled = options.enabled !== false
  const configMode = asMode(options.mode) ?? 'ask'
  const stuckAfter = numberOf(options.stuckThreshold, 3)

  // Module variables reset on a reload; nothing here is needed after one. Counters only, no prompt text.
  let enabled = cfgEnabled
  let modeOverride: Mode | undefined
  let sincePrompt = Number.MAX_SAFE_INTEGER
  let failStreak = 0
  const st: St = {
    models: {
      deep: modelOf(options.deepModel, 'deep'),
      standard: modelOf(options.standardModel, 'standard'),
      quick: modelOf(options.quickModel, 'quick'),
    },
    sensitivity: sensitivityOf(options.sensitivity),
    cooldown: numberOf(options.cooldownPrompts, 3),
    mode: () => modeOverride ?? configMode,
    setMode: m => {
      modeOverride = m
    },
    asking: false,
    askedThisTurn: false,
    pending: undefined,
    turnsSince: Number.MAX_SAFE_INTEGER,
    shown: 0,
    last: '',
  }
  const isOn = () => enabled && st.mode() !== 'off'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Decision Support: when to use /advisor and with which model. on, off, status or mode ask|auto-suggest|off',
      argumentHint: '[on|off|status|mode <ask|auto-suggest|off>]',
    })
    const stored = await $.store.get('enabled')
    enabled = typeof stored === 'boolean' ? stored : cfgEnabled
    modeOverride = asMode(await $.store.get('mode'))
    return next(e)
  })

  // Prompt heuristics. In ask mode a qualifying prompt is held while the person is asked; whatever the answer,
  // dismissal, error or timeout, the prompt goes on with its text untouched.
  on('prompt.submit', async ($, e, next) => {
    try {
      failStreak = 0
      sincePrompt += 1
      const typed = isPersonOrigin(e.origin as { kind?: string; asUser?: boolean } | undefined)
      if (isOn() && typed && !e.command && !e.isMeta && !e.text.trimStart().startsWith('/') && sincePrompt > st.cooldown) {
        const v = classify(e.text, st.sensitivity)
        if (v) {
          sincePrompt = 0
          st.turnsSince = 0
          await askFlow($, st, { label: labelOf(v.category), tier: v.tier, why: v.why }, v.why, false)
        }
      }
    } catch {
      // A failed check never touches the prompt.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Decision points seen in a tool call, and the stuck check. The result is always passed on as it came.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const mainChat = e.agentId === undefined
    // Claude's own question: only flagged here; the ask waits for the end of the turn so two dialogs never overlap.
    if (mainChat && tool === 'AskUserQuestion' && !st.asking && !isOwnAsk(e) && isOn()) {
      st.pending = infoFromQuestions(e, st.sensitivity)
    }
    const ran = await next(e)
    try {
      if (mainChat && tool === 'ExitPlanMode' && !st.asking && isOn() && ran.deny === undefined && ran.isError !== true) {
        // Plan approved and about to be carried out: the best moment for a second look at the plan.
        if (!st.askedThisTurn && st.turnsSince > st.cooldown) {
          st.turnsSince = 0
          await askFlow($, st, { label: 'plan about to be carried out', tier: 'standard', why: 'a plan is cheapest to fix before the work starts' }, 'a plan is cheapest to fix before the work starts', false)
        }
      } else if (mainChat && tool !== 'AskUserQuestion' && isOn() && stuckAfter > 0) {
        if (ran.deny === undefined && ran.isError === true) {
          failStreak += 1
          if (failStreak === stuckAfter) {
            st.last = 'stuck'
            st.shown += 1
            suggest($, `stuck spot (${failStreak} failed tool calls in a row)`, st.models.standard)
          }
        } else {
          failStreak = 0
        }
      }
    } catch {
      // Counting is a nicety.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // End of a turn: the turn has finished, so asking here blocks nothing. Fires for a flagged AskUserQuestion, or
  // when the final text offers options. At most one ask per turn, none for subagent turns.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran
    try {
      st.turnsSince += 1
      let info = st.pending
      st.pending = undefined
      const already = st.askedThisTurn
      st.askedThisTurn = false
      if (!already && isOn() && !e.isAborted && st.turnsSince > st.cooldown) {
        if (info === undefined && looksLikeDecision(e.answer)) {
          const v = classify(e.answer, st.sensitivity)
          info = v ? { label: labelOf(v.category), tier: v.tier, why: v.why } : DECISION_DEFAULT
        }
        if (info) {
          st.turnsSince = 0
          await askFlow($, st, info, info.why, true)
        }
      }
    } catch {
      // Never touches the turn.
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: NAME }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      await $.store.set('enabled', enabled)
      return { text: enabled ? 'Decision Support is on.' : 'Decision Support is off. Type /decision-support on to turn it back on.' }
    }
    if (arg.startsWith('mode')) {
      const m = asMode(arg.slice(4).trim())
      if (!m) return { text: `Mode is ${st.mode()}. Type /decision-support mode ask, auto-suggest or off.` }
      modeOverride = m
      await $.store.set('mode', m)
      return { text: `Decision Support mode: ${m}.` }
    }
    if (arg !== '' && arg !== 'status') return { text: 'Type /decision-support on, off, status or mode <ask|auto-suggest|off>.' }
    return {
      text: [
        `Decision Support is ${enabled ? 'on' : 'off'}. Mode: ${st.mode()}${modeOverride === undefined ? ' (from config)' : ' (set by command or an Auto answer)'}, sensitivity: ${st.sensitivity}.`,
        'ask holds a qualifying prompt (or, at the end of a turn, a decision Claude reached) and asks whether to use /advisor; auto-suggest only shows a toast with the command; off is silent.',
        `Models: deep ${st.models.deep}, standard ${st.models.standard}, quick ${st.models.quick}.`,
        `Suggestions this session: ${st.shown}${st.last ? ` (last: ${st.last})` : ''}. Stuck check: ${stuckAfter > 0 ? `after ${stuckAfter} failed tool calls (toast only)` : 'off'}.`,
        'Decision points: Claude calling AskUserQuestion, a turn ending with options or "which approach" wording, plan approval (ExitPlanMode).',
        'On "Use", the mod asks Claude Code to run /advisor <model>; if that is not possible it shows the exact command to type. It never edits settings files.',
      ].join('\n'),
    }
  })
}
