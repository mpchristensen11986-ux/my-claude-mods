// Types for subagent-advisor. The mod adds no noun to `$` and keeps no $.state.
// Persistent values in $.store: 'enabled' (boolean, /subagent-advisor on|off), 'mode' (Mode, /subagent-advisor mode <x> or an Auto answer)
// and 'views' (boolean, /subagent-advisor views on|off: whether a subagent choice queues /agents-info open and the built-in /tasks).
/** ask: hold the prompt and ask. auto-delegate / auto-continue: decide without asking. off: silent. */
export type Mode = 'ask' | 'auto-delegate' | 'auto-continue' | 'off'

export type Sensitivity = 'low' | 'medium' | 'high'

export type AdviceKind = 'explore' | 'parallel' | 'general'

export type Advice = {
  kind: AdviceKind
  score: number
  /** Short plain reasons, never any prompt text. */
  reasons: string[]
}
