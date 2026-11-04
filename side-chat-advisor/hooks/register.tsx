import type { EngineInterface, Register } from 'claude-code'

import type { Band } from '../types'

const BAND = { plugin: 'side-chat-advisor', key: 'band' } as const
const NAME = 'side-chat-advisor'
const ACCENT = '#d97757'
const BAND_MS = 20_000
const TOAST_MS = 8_000

export type Sensitivity = 'low' | 'medium' | 'high'
export type Verdict = { score: number; isSuggested: boolean; reason: string }
export type Context = {
  // Text of the last few messages of the main chat, used for the overlap test only. Never stored.
  recent: string
  // How many messages the main chat holds.
  messageCount: number
  hasAttachments: boolean
}

// Score needed to suggest, per sensitivity.
export const THRESHOLD: Record<Sensitivity, number> = { low: 6, medium: 4, high: 3 }

const STOP = new Set(
  'about above after again also been before being between both cannot could does doing done from have here into just like make more most much need only other over please should some such than that their them then there these they this those very want what when where which while will with would your you the and for are but not can its our how why who was were has had'.split(
    ' ',
  ),
)

const MARKER = /\b(side ?chat|side question|side note|btw|by the way|quick question|quick one|random question|off[- ]topic|unrelated|out of curiosity|tangent|separate question|real quick|one[- ]off|unrelated to)\b/i
const LOOKUP =
  /^\s*(what('?s| is| are| does| do)\b|who (is|was|are|were)\b|when (was|did|is|does)\b|where (is|does|are)\b|define\b|meaning of\b|difference between\b|how do (you|i) (say|spell|pronounce|convert)\b|convert\b|translate\b|is it (true|ok|okay|legal)\b|which is (better|bigger|older|faster)\b|how (many|much|long|far|old) (is|are|does|do|was)\b)/i
const MEANS = /\bwhat does .{1,60} (mean|stand for)\b|\bwhat('?s| is) .{1,40} short for\b|\bstands? for\b/i
const CONTINUE = /^\s*(yes|yep|yeah|no|nope|ok|okay|go|go on|go ahead|continue|proceed|do it|sure|thanks|thank you|thx|cheers|great|good|option \d|[1-9a-d])\b[\s\S]{0,30}$/i
const ACTION = /^\s*(please\s+)?(fix|implement|refactor|build|create|write|add|update|change|edit|run|make|generate|draft|review|check|deploy|install|remove|delete|rename|move|test|debug|commit|push|set up|continue|finish|rewrite|replace|apply|merge|open|save|send|price|estimate|populate|fill)\b/i
const TASK_REF =
  /\b(this|that|these|those|the|your|my|our)\s+(file|files|code|function|bug|error|test|tests|output|plan|repo|script|change|changes|diff|pr|commit|branch|folder|doc|document|spreadsheet|schedule|estimate|tender|contract|template|register|mod|plugin|page|result|results|thing)\b/i
const PATHISH = /[\w.-]+\.(ts|tsx|js|jsx|py|md|json|xlsx|docx|pdf|csv|html|css|yml|yaml|sql|ps1|sh)\b|[A-Za-z]:\\|\/[\w.-]+\/[\w.-]+|`[^`]+`|```/
const ANAPHORA = /\b(above|earlier|previous(ly)?|you (just|said|wrote|did|made)|as discussed|from before|same (thing|again)|try again|redo)\b/i

function tokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (!STOP.has(w)) out.add(w)
  }
  return out
}

// Deterministic: same input, same verdict. No model call, nothing kept.
export function classify(text: string, ctx: Context, sensitivity: Sensitivity): Verdict {
  const none: Verdict = { score: 0, isSuggested: false, reason: '' }
  const t = text.trim()
  if (!t || t.startsWith('/') || ctx.hasAttachments) return none
  if (CONTINUE.test(t)) return none
  // A chat with nothing in it has no context to pollute.
  if (ctx.messageCount < 2) return none

  const words = t.split(/\s+/).length
  let score = 0
  let content = 0
  const why: string[] = []

  if (MARKER.test(t)) {
    score += 4
    content += 1
    why.push('you flagged it as a side question')
  }
  if (LOOKUP.test(t)) {
    score += 2
    content += 1
    why.push('a quick lookup or definition')
  }
  if (MEANS.test(t)) {
    score += 1
    content += 1
    if (!why.includes('a quick lookup or definition')) why.push('a quick lookup or definition')
  }

  if (words <= 15) score += 2
  else if (words <= 30) score += 1
  else if (words > 120) score -= 5
  else if (words > 60) score -= 3

  if (!t.includes('\n') && (t.match(/\?/g) ?? []).length === 1 && t.endsWith('?')) score += 1

  if (PATHISH.test(t)) score -= 3
  if (TASK_REF.test(t)) score -= 3
  if (ACTION.test(t)) score -= 3
  if (ANAPHORA.test(t)) score -= 2

  const mine = tokens(t)
  if (mine.size >= 2 && ctx.recent) {
    const theirs = tokens(ctx.recent)
    let shared = 0
    for (const w of mine) if (theirs.has(w)) shared += 1
    const overlap = shared / mine.size
    if (overlap <= 0.1) {
      score += 2
      content += 1
      why.push('not related to what this chat is working on')
    } else if (overlap >= 0.4) {
      score -= 2
    }
  }

  const isSuggested = content > 0 && score >= THRESHOLD[sensitivity]
  const reason = why.slice(0, 2).join(' and ')
  return { score, isSuggested, reason: isSuggested ? reason : '' }
}

export function suggestion(reason: string) {
  const r = reason || 'a short one-off question'
  return `This looks like a Side Chat candidate (${r}). Open a Side Chat in Split View to keep this chat's context clean.`
}

async function setBand($: EngineInterface, b: Band | null) {
  try {
    await $.state.set(BAND, b)
  } catch {
    // The next change redraws anyway.
  }
}

function asSensitivity(v: unknown): Sensitivity {
  return v === 'low' || v === 'high' ? v : 'medium'
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
  const showToast = options.showToast !== false
  const showBand = options.showBand !== false
  const cooldown = typeof options.cooldown === 'number' && options.cooldown >= 0 ? Math.floor(options.cooldown) : 3
  const configEnabled = options.enabled !== false

  // Module variables reset on a reload; they hold counts only, never prompt text.
  let enabled = configEnabled
  let sincePrev = Number.POSITIVE_INFINITY
  let nextId = 1
  let suggested = 0
  let seen = 0
  // Counts and a short reason only, never prompt text; shown by /sidechat-advisor status.
  let lastNote = 'no prompt checked yet'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sidechat-advisor',
      description: 'Side Chat Advisor: suggests a Side Chat for quick tangents. on, off or status',
      argumentHint: '[on|off|status]',
    })
    try {
      const stored = await $.store.get('enabled')
      if (typeof stored === 'boolean') enabled = stored
    } catch {
      // The config default stands.
    }
    return next(e)
  })

  // Never blocks, rewrites or delays: it reads the prompt, may raise a toast and a band, and passes the event on as received.
  on('prompt.submit', async ($, e, next) => {
    try {
      if (!enabled) {
        lastNote = 'the mod is off'
        return next(e)
      }
      if (e.isMeta || e.command) {
        lastNote = 'a slash or meta prompt, skipped'
        return next(e)
      }
      if (!isPersonOrigin(e.origin as { kind?: string; asUser?: boolean } | undefined)) {
        lastNote = `origin "${(e.origin as { kind?: string } | undefined)?.kind}" is not treated as you`
        return next(e)
      }
      seen += 1
      sincePrev += 1
      // A new prompt makes an older suggestion stale.
      void setBand($, null)
      if (sincePrev <= cooldown) {
        lastNote = `cooldown: ${sincePrev} of ${cooldown} prompts since the last suggestion`
        return next(e)
      }

      const messages = await $.session.messages()
      const recent = messages
        .slice(-6)
        .map(m => m.text)
        .join('\n')
        .slice(-6000)
      const verdict = classify(
        e.text,
        { recent, messageCount: messages.length, hasAttachments: (e.attachments?.length ?? 0) > 0 },
        sensitivity,
      )
      lastNote = `${messages.length} messages in this chat, score ${verdict.score}, ${verdict.isSuggested ? 'suggested' : 'not suggested'} (needs a score of ${THRESHOLD[sensitivity]} and at least 2 messages)`
      if (verdict.isSuggested) {
        sincePrev = 0
        suggested += 1
        const text = suggestion(verdict.reason)
        if (showToast) $.ui.toast(text, { timeoutMs: TOAST_MS })
        if (showBand) {
          const id = nextId++
          void setBand($, { id, reason: verdict.reason || 'a short one-off question' })
          $.clock.after(BAND_MS, () => {
            void $.state
              .get(BAND)
              .then(({ value }) => (value?.id === id ? setBand($, null) : undefined))
              .catch(() => undefined)
          })
        }
      }
    } catch {
      // The advisor never costs the person their prompt.
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sidechat-advisor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      await $.store.set('enabled', enabled)
      if (!enabled) await setBand($, null)
      return { text: enabled ? `Side Chat Advisor is on (${sensitivity}).` : 'Side Chat Advisor is off. Type /sidechat-advisor on to turn it back on.' }
    }
    return {
      text: [
        `Side Chat Advisor is ${enabled ? 'on' : 'off'}, sensitivity: ${sensitivity}, cooldown: ${cooldown} prompts.`,
        `Toast: ${showToast ? 'on' : 'off'}. Band: ${showBand ? 'on' : 'off'}.`,
        `Prompts checked this session: ${seen}. Suggestions shown: ${suggested}.`,
        `Last prompt: ${lastNote}.`,
        'It only suggests. A mod cannot open a Side Chat, so open one in Split View yourself.',
        'Type /sidechat-advisor on, off or status. Sensitivity and display are set in /config.',
      ].join('\n'),
    }
  })

  on('ui.press', { plugin: NAME, element: 'dismiss' }, async ($, e) => {
    await setBand($, null)
    return { element: e.element }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!enabled || e.props.hasSurvey) return next(e)
    const { value } = await $.state.get(BAND)
    if (!value) return next(e)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // Claude Code's own placeholder ({ type: 'engine' }) must never be nested: the desktop drops a band that nests it.
    const below = rest && (rest as { type?: string }).type !== 'engine' ? rest : null
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" gap={1}>
          <Text wrap="truncate-end">
            <Text color={ACCENT}>●</Text>
            <Text bold> Side Chat candidate</Text>
            <Text dimColor> · {value.reason}. Open a Side Chat in Split View.</Text>
          </Text>
          <Button key="dismiss" label="Dismiss" role="dismiss" onPress={() => undefined} />
        </Box>
      </Box>
    )
  })
}
