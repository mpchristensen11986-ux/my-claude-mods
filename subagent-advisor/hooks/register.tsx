import type { CommandInfo, EngineInterface, Register } from 'claude-code'

import type { Advice, AdviceKind, Mode, Sensitivity } from '../types'

// Deterministic heuristics only: no model calls, no network, no tokens spent.
// The prompt text is read inside one call and never stored or logged.

const NAME = 'subagent-advisor'
const TOAST_MS = 12_000
// How long the question waits for an answer before the prompt goes on unchanged.
const ASK_MS = 120_000
const MODES: readonly Mode[] = ['ask', 'auto-delegate', 'auto-continue', 'off']
const LABEL = {
  use: 'Use subagents',
  keep: 'Continue as normal',
  autoUse: 'Auto: always use subagents',
  autoKeep: 'Auto: never ask again',
} as const

// Points needed to speak, and Read/Grep/Glob calls in one turn before the gentle nudge.
const THRESHOLD: Record<Sensitivity, number> = { high: 2, medium: 3, low: 4 }
const TOOL_LIMIT: Record<Sensitivity, number> = { high: 6, medium: 10, low: 15 }
// Tools that flood the main context in bulk. Compared as strings: Glob and Grep are not on every build.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const MIN_LENGTH = 15
// Prompts that must pass before another suggestion, so it never nags.
const GAP = 2

const BREADTH =
  /\b(?:across|throughout|through|in|over)\s+(?:the\s+|all\s+|every\s+|my\s+|our\s+)*(?:whole\s+|entire\s+)?(?:repo|repository|repositories|codebase|code\s?base|project|projects|folders?|directory|directories|files|modules|sources?)\b|\b(?:every|all|each)\s+(?:the\s+)?(?:files?|modules?|folders?|documents?|pdfs?|spreadsheets?|contracts?|packages?|services?)\b|\b(?:audit|inventory|sweep|everywhere|anywhere|whole\s+codebase|entire\s+repo)\b|\b(?:find|list)\s+all\b/
const SEARCH = /\b(?:find|search|locate|grep|where\s+is|where\s+are|which\s+files?|who\s+calls|usages?\s+of|references?\s+to)\b/
const PARALLEL =
  /\bin\s+parallel\b|\bat\s+the\s+same\s+time\b|\bsimultaneously\b|\bconcurrently\b|\bindependent(?:ly)?\b|\bseparate(?:ly)?\s+(?:agents?|tasks?|workstreams?)\b|\bfor\s+each\s+of\b/
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+\S/
const RESEARCH =
  /\b(?:research|investigate|deep[\s-]dive|survey|literature|state\s+of\s+the\s+art|due\s+diligence|root\s+cause|compare\s+(?:the\s+)?(?:options|vendors|libraries|approaches|alternatives))\b/
const REVIEW = /\b(?:review|audit)\b.{0,40}\b(?:diff|pr|pull\s+request|branch|changeset|commits?)\b/
const LARGE = /\b(?:large|big|huge|whole|entire|massive|thousand|\d{3,}\s+(?:lines|files))\b/
const BULK =
  /\b(?:read|go\s+through|read\s+through|skim|summari[sz]e|digest|ingest)\b.{0,30}\b(?:all|every|each|these|those|the\s+\d+|\d+)\b.{0,20}\b(?:files?|documents?|pdfs?|logs?|emails?|reports?|specs?|contracts?|pages)\b/
const PATH_TOKEN = /[\w.-]+[\\/][\w.\\/-]+\.\w{1,5}\b/g
// The person is already thinking about delegation.
const ALREADY = /\bsub-?agents?\b|\bagents?\b/

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length
}

/** Scores one prompt. Pure: nothing about the text leaves this function but short reasons. */
export function analyse(text: string): Advice | null {
  const t = text.toLowerCase()
  if (t.trim().length < MIN_LENGTH || ALREADY.test(t)) return null

  const reasons: string[] = []
  let score = 0
  let explore = 0
  let parallel = 0
  let general = 0

  if (BREADTH.test(t)) {
    // One clear sweep-everything phrase ("audit every file", "across the codebase") is enough to ask on its own:
    // asking costs one click, and in the default ask mode a wrong guess is dismissed in a second.
    score += 3
    explore += 3
    reasons.push('it reaches across many files')
  }
  if (SEARCH.test(t)) {
    score += 1
    explore += 1
    reasons.push('it is a search')
  }
  const items = text.split('\n').filter(l => LIST_ITEM.test(l)).length
  if (items >= 3) {
    score += 2
    parallel += 2
    reasons.push('it lists several parts')
  }
  if (PARALLEL.test(t)) {
    score += 2
    parallel += 2
    reasons.push('its parts look independent')
  }
  if (RESEARCH.test(t)) {
    score += 2
    general += 2
    reasons.push('it is long research')
  }
  if (REVIEW.test(t)) {
    const big = LARGE.test(t)
    score += big ? 3 : 2
    general += big ? 3 : 2
    reasons.push(big ? 'it is a review of a large diff' : 'it is a diff review')
  }
  if (BULK.test(t)) {
    score += 2
    explore += 2
    reasons.push('it reads many files in bulk')
  }
  if (count(text, PATH_TOKEN) >= 5) {
    score += 1
    explore += 1
    reasons.push('it names many files')
  }
  if (score === 0) return null

  let kind: AdviceKind = 'explore'
  if (parallel > 0 && parallel >= Math.max(explore, general)) kind = 'parallel'
  else if (general > explore) kind = 'general'
  return { kind, score, reasons: reasons.slice(0, 3) }
}

function asMode(v: unknown): Mode | undefined {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v) ? (v as Mode) : undefined
}

// Asks one question and resolves to the label chosen, or null when the dialog was dismissed, failed
// (a -p run has no one to ask) or got no answer in time. The caller then sends the prompt unchanged.
async function choose($: EngineInterface, question: string, options: readonly string[]): Promise<string | null> {
  try {
    const timeout = $.clock.sleep(ASK_MS).then(() => null)
    const answer = $.ui.ask(question, { options, header: 'Subagents' })
    // A late rejection after the timeout won is not left unhandled.
    answer.catch(() => undefined)
    return await Promise.race([answer, timeout])
  } catch {
    return null
  }
}

function asSensitivity(v: unknown): Sensitivity {
  return v === 'low' || v === 'high' ? v : 'medium'
}

// Views that follow a subagent choice. Both are slash commands queued with $.command.run. The engine runs a queued
// command once the session is idle (types: "queued and run once the session is idle"), so they open when the
// delegating turn ends, not while it runs. $.command.run is refused inside a hook the turn waits on (prompt.submit,
// tool.call and others); the engine's own message names turn.complete as the later event to run it from.
const AGENTS_CMD = 'agents-info' // the agents panel; provided by the separate savvy-progress mod
const TASKS_CMD = 'tasks' // the engine's own background tasks view, when this session lists it
const INSTALL_HINT =
  'Subagent advisor: the agents panel needs the savvy-progress mod, which is not installed. Mute this with /subagent-advisor views off.'

type ViewsState = { hinted: boolean }
type ViewTargets = { agents: boolean; tasks: boolean }

/** Which of the two views this session can run. Pure: names and sources only. */
function targetsIn(list: readonly CommandInfo[]): ViewTargets {
  return {
    // A plugin's command. A user's own file of that name is not run on the person's behalf.
    agents: list.some(c => c.name === AGENTS_CMD && c.source === 'plugin'),
    // Only the engine's own /tasks, for the same reason.
    tasks: list.some(c => c.name === TASKS_CMD && c.source === 'builtin'),
  }
}

// Reads the live command list; undefined when it cannot be read, so the caller guesses nothing.
async function viewTargets($: EngineInterface): Promise<ViewTargets | undefined> {
  try {
    return targetsIn(await $.command.list())
  } catch {
    return undefined
  }
}

// Queues one slash command and moves on. The promise settles only once the command has run, which is after the
// current turn, so nothing ever waits on it; a refusal or a failure is swallowed.
function queueCommand($: EngineInterface, command: string, args: string): void {
  try {
    $.command.run({ command, args }).catch(() => undefined)
  } catch {
    // Opening a view is a nicety and never touches the turn.
  }
}

// Called once per subagent choice, from the main loop's turn.complete. Checks the live command list first. A missing
// /agents-info (savvy-progress not installed) gets one short toast per session; a list that cannot be read is skipped.
async function openViews($: EngineInterface, st: ViewsState): Promise<void> {
  const found = await viewTargets($)
  if (found === undefined) return
  if (found.agents) {
    queueCommand($, AGENTS_CMD, 'open')
  } else if (!st.hinted) {
    st.hinted = true
    try {
      $.ui.toast(INSTALL_HINT, { timeoutMs: TOAST_MS })
    } catch {
      // A hint is a nicety.
    }
  }
  if (found.tasks) queueCommand($, TASKS_CMD, '')
}

function viewsStatus(found: ViewTargets | undefined): string {
  if (found === undefined) return 'the command list could not be read'
  const agents = found.agents ? '/agents-info found' : '/agents-info not found (needs the savvy-progress mod)'
  const tasks = found.tasks ? 'built-in /tasks found' : 'built-in /tasks not listed in this session'
  return `${agents}; ${tasks}`
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

export const register: Register = (on, options) => {
  const sensitivity = asSensitivity(options.sensitivity)
  const toolNudge = options.toolCallNudge !== false
  const configEnabled = options.enabled !== false
  const configMode = asMode(options.mode) ?? 'ask'
  const configViews = options.openViews !== false

  // Module variables reset on a reload; nothing here is needed after one.
  let override: boolean | undefined
  // Set by /subagent-advisor mode, or by an Auto answer; it wins over the config's mode.
  let modeOverride: Mode | undefined
  // Set by /subagent-advisor views on|off; it wins over the config's openViews.
  let viewsOverride: boolean | undefined
  // A subagent choice, in two steps so it can only ever fire for its own turn and once. `chosen` is set in
  // prompt.submit and spent by the next main-loop turn.start, which binds the turn's id to `armedTurn`; the
  // main-loop turn.complete of that same id spends `armedTurn` and opens the views.
  let chosen = false
  let armedTurn: string | undefined
  const views: ViewsState = { hinted: false }
  // One question at a time: a prompt that arrives while one is open goes straight on.
  let asking = false
  // Agent types the engine has offered the model this session, read from agent.offer. Empty means none seen yet.
  const offered = new Set<string>()
  let sinceLast = GAP
  let suggested = 0
  let reads = 0
  let nudged = false
  let usedAgent = false

  const mode = (): Mode => modeOverride ?? configMode
  const isOn = () => (override ?? configEnabled) && mode() !== 'off'
  const viewsOn = () => viewsOverride ?? configViews

  // A type is named only if the engine offered it, or if no offer has been seen yet (then the names the types file documents).
  const has = (type: string) => offered.size === 0 || offered.has(type)

  // What Claude is asked to do, by kind; names only agent types the engine offered.
  function doing(a: Advice): string {
    let what: string
    if (a.kind === 'parallel') {
      what = 'run the independent parts as parallel subagents, one each, and keep this chat for the synthesis'
    } else if (a.kind === 'general') {
      what = has('general-purpose')
        ? 'hand it to a general-purpose subagent so the reading stays out of this chat'
        : 'hand it to a subagent so the reading stays out of this chat'
    } else {
      what = has('Explore')
        ? 'use an Explore subagent: it searches read-only and returns a summary, not the file contents'
        : 'hand the search to a subagent so the results stay out of this chat'
    }
    return what
  }

  function advice(a: Advice): string {
    return `Subagent advisor: ${a.reasons.join(', ')}. Consider asking Claude to ${doing(a)}. Mute with /subagent-advisor off.`
  }

  // The instruction attached beside the prompt as hidden context; the prompt text itself is not rewritten.
  function delegation(a: Advice): string {
    const kind = a.kind === 'parallel' ? 'parallel subagents' : a.kind === 'general' ? 'a general-purpose subagent' : 'an Explore subagent'
    return `The user chose to delegate this prompt to subagents (${kind}). Please ${doing(a)}. Use the Agent tool for that, then give the user the result.`
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: NAME,
      description: 'Subagent advisor: on, off, status, mode ask|auto-delegate|auto-continue|off, or views on|off',
      argumentHint: '[on|off|status|mode <ask|auto-delegate|auto-continue|off>|views <on|off>]',
    })
    const stored = await $.store.get('enabled')
    if (typeof stored === 'boolean') override = stored
    modeOverride = asMode(await $.store.get('mode'))
    const storedViews = await $.store.get('views')
    if (typeof storedViews === 'boolean') viewsOverride = storedViews
    return next(e)
  })

  // Only the offers are read; every type is still offered as it was.
  on('agent.offer', ($, e, next) => {
    offered.add(e.agent)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Holds a qualifying prompt and asks (mode ask), or decides by itself (auto modes). The prompt text is never
  // rewritten or stored: "Use subagents" attaches a hidden instruction through `context`. If anything fails, or
  // the question is dismissed or times out, the prompt goes on unchanged.
  on('prompt.submit', async ($, e, next) => {
    // A choice never carries over to another prompt: whatever an earlier prompt left unspent is dropped first.
    chosen = false
    let extra: string | undefined
    try {
      // The engine always stamps an origin; the test kit's own submit leaves it out, which reads as the person's.
      const fromPerson = isPersonOrigin(e.origin as { kind?: string; asUser?: boolean } | undefined)
      if (isOn() && fromPerson && !e.command && !e.isMeta && !e.text.trim().startsWith('/')) {
        sinceLast += 1
        const a = sinceLast > GAP ? analyse(e.text) : null
        if (a && a.score >= THRESHOLD[sensitivity]) {
          sinceLast = 0
          suggested += 1
          const m = mode()
          if (m === 'auto-delegate') {
            extra = delegation(a)
            $.ui.toast(`Subagent advisor (auto): asked Claude to ${doing(a)}.`, { timeoutMs: TOAST_MS })
          } else if (m === 'auto-continue') {
            $.ui.toast(advice(a), { timeoutMs: TOAST_MS })
          } else if (!asking) {
            asking = true
            try {
              const answer = await choose($, `This prompt looks suited to subagents: ${a.reasons.join(', ')}. Ask Claude to ${doing(a)}?`, [
                LABEL.use,
                LABEL.keep,
                LABEL.autoUse,
                LABEL.autoKeep,
              ])
              if (answer === LABEL.use || answer === LABEL.autoUse) extra = delegation(a)
              if (answer === LABEL.autoUse || answer === LABEL.autoKeep) {
                modeOverride = answer === LABEL.autoUse ? 'auto-delegate' : 'auto-continue'
                await $.store.set('mode', modeOverride)
              }
            } finally {
              asking = false
            }
          }
        }
      }
    } catch {
      // A failed suggestion must never touch the prompt.
      extra = undefined
    }
    // A subagent was chosen (Use subagents, Auto: always use subagents, or auto-delegate). Only a prompt that starts a
    // turn of its own can open the views: one typed over a running turn (turnId set) is folded into that turn, and
    // nothing here can say which turn it joins.
    if (extra && viewsOn() && e.turnId === undefined) chosen = true
    const result = await next(extra ? { ...e, context: [...(e.context ?? []), extra] } : e)
    // A prompt dropped beneath this hook starts no turn.
    if (result.drop !== undefined) chosen = false
    return result
  }).catch(($, e, next) => {
    chosen = false
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      reads = 0
      nudged = false
      usedAgent = false
      // The first main-loop turn after the choice is the choice's turn; its id is all that can open the views.
      if (chosen) {
        chosen = false
        armedTurn = e.turnId
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The end of the choice's own turn: queue the views. Nothing is awaited that could wait on the session going idle
  // (the queued commands run once it is), and nothing here changes the turn's result.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined && armedTurn !== undefined && e.turnId === armedTurn) {
        armedTurn = undefined
        if (viewsOn() && !e.isAborted) await openViews($, views)
      }
    } catch {
      // Opening a view never touches the turn.
    }
    return result
  }).catch(($, e, next) => next(e))

  // Counts the main thread's own Read/Grep/Glob calls: the work a subagent would have taken.
  on('tool.call', ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        const tool = String(e.tool)
        if (tool === 'Agent') usedAgent = true
        else if (READ_TOOLS.has(tool)) {
          reads += 1
          if (isOn() && toolNudge && !nudged && !usedAgent && reads >= TOOL_LIMIT[sensitivity]) {
            nudged = true
            const who = has('Explore') ? 'an Explore subagent' : 'a subagent'
            $.ui.toast(
              `Subagent advisor: ${reads} Read/Grep/Glob calls in this turn. Next time ${who} could do this searching and hand back a summary, which keeps this chat lean. Mute with /subagent-advisor off.`,
              { timeoutMs: TOAST_MS },
            )
          }
        }
      }
    } catch {
      // Counting must never touch the call.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: NAME }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      override = arg === 'on'
      await $.store.set('enabled', override)
      return { text: override ? 'Subagent advisor is on.' : 'Subagent advisor is off. Type /subagent-advisor on to turn it back on.' }
    }
    if (arg.startsWith('mode')) {
      const m = asMode(arg.slice(4).trim())
      if (!m) return { text: `Mode is ${mode()}. Type /subagent-advisor mode ask, auto-delegate, auto-continue or off.` }
      modeOverride = m
      await $.store.set('mode', m)
      return { text: `Subagent advisor mode: ${m}.` }
    }
    if (arg === 'views' || arg.startsWith('views ')) {
      const v = arg.slice(5).trim()
      if (v !== 'on' && v !== 'off') return { text: `Views are ${viewsOn() ? 'on' : 'off'}. Type /subagent-advisor views on or views off.` }
      viewsOverride = v === 'on'
      await $.store.set('views', viewsOverride)
      return {
        text: viewsOverride
          ? 'Views are on: after you choose subagents, /agents-info open and the built-in /tasks are queued to run when that turn ends.'
          : 'Views are off: choosing subagents no longer opens anything. Type /subagent-advisor views on to turn them back on.',
      }
    }
    if (arg !== '' && arg !== 'status') {
      return { text: 'Type /subagent-advisor on, off, status, mode <ask|auto-delegate|auto-continue|off> or views <on|off>.' }
    }
    const types = offered.size === 0 ? 'none seen yet' : [...offered].sort().join(', ')
    const found = await viewTargets($)
    return {
      text: [
        `Subagent advisor is ${isOn() ? 'on' : 'off'}${override === undefined ? ' (from config)' : ' (set by command)'}.`,
        `Mode: ${mode()}${modeOverride === undefined ? ' (from config)' : ' (set by command or an Auto answer)'}. ask holds a qualifying prompt and asks; auto-delegate always adds the subagent instruction; auto-continue never asks (toast only).`,
        `Views: ${viewsOn() ? 'on' : 'off'}${viewsOverride === undefined ? ' (from config)' : ' (set by command)'}. After a subagent choice, /agents-info open and the built-in /tasks are queued and run when that turn ends. In this session: ${viewsStatus(found)}.`,
        `Sensitivity: ${sensitivity}. Read/Grep/Glob nudge: ${toolNudge ? `on, after ${TOOL_LIMIT[sensitivity]} calls in a turn` : 'off'}.`,
        `Suggestions this session: ${suggested}. Agent types the engine has offered: ${types}.`,
        'Change mode, sensitivity, the nudge and views in /config. Type /subagent-advisor on, off, status, mode <x> or views <on|off>.',
      ].join('\n'),
    }
  })
}
