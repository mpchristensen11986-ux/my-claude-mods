// Pure, deterministic heuristics for decision-support. No engine access, no model calls, no storage.
// The prompt text is read once by classify() and never kept.

export type Tier = 'deep' | 'standard' | 'quick'
export type Category = 'security' | 'commercial' | 'irreversible' | 'architecture' | 'plan' | 'check'
export type Sensitivity = 'low' | 'medium' | 'high'

export type Verdict = { category: Category; tier: Tier; why: string }

type Rule = { category: Exclude<Category, 'check'>; weight: number; re: RegExp }

// Strong signals weigh 2, weak ones 1. Each rule counts once per prompt.
const RULES: readonly Rule[] = [
  { category: 'security', weight: 2, re: /\b(security|vulnerabilit\w*|exploit\w*|injection|cve-\d+|penetration|threat model|credentials?|api[- ]?keys?|secrets?)\b/ },
  { category: 'security', weight: 1, re: /\b(auth(entication|orisation|orization)?|permissions?|encrypt\w*|tokens?|passwords?|firewall|privilege\w*)\b/ },
  { category: 'commercial', weight: 2, re: /\b(contracts?|clauses?|variations?|eots?|extensions? of time|liquidated damages|indemnit\w*|security of payment|payment claims?|head contract|subcontract\w*|rise and fall|fuel (rebate|mechanism)|termination|insurance)\b/ },
  { category: 'commercial', weight: 1, re: /\b(tender|margins?|pricing|quotes?|commercial\w*|rates?|liabilit\w*|claims?|budget|invoice\w*|legal)\b/ },
  { category: 'irreversible', weight: 2, re: /\b(drop (table|database)|force[- ]push|reset --hard|rm -rf|truncate|irreversible|cannot be undone|can'?t be undone|wipe|purge|delete (all|every|the (whole|entire))|overwrite (all|the (whole|entire)))\b/ },
  { category: 'irreversible', weight: 1, re: /\b(production|prod|migrat\w+|deploy\w*|release|rollback|delete|publish|go live|cutover|send (it|this|that) to)\b/ },
  { category: 'architecture', weight: 2, re: /\b(architect\w*|design (choice|decision|pattern|review)|trade-?offs?|monolith|microservices?|data model|schema design|system design|which (approach|option|design)|pros and cons)\b/ },
  { category: 'architecture', weight: 1, re: /\b(should (we|i) (use|go with|build|choose|adopt)|refactor\w*|restructur\w*|rewrite|redesign\w*|approach|strategy)\b/ },
]

// An explicit ask for another view is always worth the nudge.
const EXPLICIT = /\b(second opinion|sanity[- ]?check|double[- ]?check|devil'?s advocate|am i missing|poke holes|critique|red[- ]?team|pressure[- ]?test)\b/

const PLAN_WORDS = /\b(plan|roadmap|step[- ]by[- ]step|phases?|milestones?|work ?breakdown|implement (the )?(whole|entire|full))\b/

const THRESHOLD: Record<Sensitivity, number> = { low: 4, medium: 3, high: 2 }

const TIER: Record<Category, Tier> = {
  security: 'deep',
  commercial: 'deep',
  irreversible: 'standard',
  architecture: 'standard',
  plan: 'standard',
  check: 'quick',
}

const WHY: Record<Category, string> = {
  security: 'a security call where a missed hole is costly, so a stronger reasoning model earns its tokens',
  commercial: 'a commercial or contract call where a missed clause costs money, so a stronger reasoning model earns its tokens',
  irreversible: 'a risky or hard-to-undo action, so a second pair of eyes before it runs is cheap insurance',
  architecture: 'a design or architecture choice with trade-offs that are hard to reverse later',
  plan: 'a long plan before execution, so the advisor can test it before you commit effort to it',
  check: 'you asked for a second look, so a fast and cheap model is enough for a sanity check',
}

const LABEL: Record<Category, string> = {
  security: 'security',
  commercial: 'commercial or contract',
  irreversible: 'risky action',
  architecture: 'design choice',
  plan: 'long plan',
  check: 'sanity check',
}

export function labelOf(category: Category): string {
  return LABEL[category]
}

export function tierOf(category: Category): Tier {
  return TIER[category]
}

export function whyOf(category: Category): string {
  return WHY[category]
}

// Returns a verdict when the prompt looks like it would benefit from an advisor, else null.
export function classify(raw: string, sensitivity: Sensitivity): Verdict | null {
  const text = raw.toLowerCase()
  if (text.length < 12) return null
  // Already talking about the advisor: do not nag.
  if (/\/advisor\b/.test(text) || /\badvisor\b/.test(text)) return null

  const scores: Record<Exclude<Category, 'check'>, number> = {
    security: 0,
    commercial: 0,
    irreversible: 0,
    architecture: 0,
    plan: 0,
  }
  for (const rule of RULES) if (rule.re.test(text)) scores[rule.category] += rule.weight

  // Plan: size and shape, not keywords alone.
  const numbered = (raw.match(/^\s*(\d+[.)]|[-*])\s+\S/gm) ?? []).length
  if (raw.length > 1500) scores.plan += 2
  if (numbered >= 5) scores.plan += 2
  if (raw.length > 400 && PLAN_WORDS.test(text)) scores.plan += 1

  let best: Exclude<Category, 'check'> | null = null
  let top = 0
  for (const key of Object.keys(scores) as Array<Exclude<Category, 'check'>>) {
    if (scores[key] > top) {
      top = scores[key]
      best = key
    }
  }

  const asked = EXPLICIT.test(text)
  if (best && top >= THRESHOLD[sensitivity]) return { category: best, tier: TIER[best], why: WHY[best] }
  // An explicit ask with a weak topical signal still takes that topic's tier; with none it is a quick check.
  if (asked) {
    if (best && top >= 2) return { category: best, tier: TIER[best], why: WHY[best] }
    return { category: 'check', tier: 'quick', why: WHY.check }
  }
  return null
}

// ---- Decision points in the session's own reasoning (pure, deterministic) ----

export type DecisionInfo = { label: string; tier: Tier; why: string }

export const DECISION_DEFAULT: DecisionInfo = {
  label: 'choice between approaches',
  tier: 'standard',
  why: 'a choice between approaches is cheaper to get right with a second view before you commit to one',
}

// Strong wording: the turn is asking the person to pick. Weak wording: it is laying options out.
const OFFER_STRONG = /\b(would you prefer|do you prefer|which (approach|option|way|route|design) (would you|do you|should we|should i)|which (approach|option) (is|sounds)|should i [^.?!\n]{1,80}\bor\b|should we [^.?!\n]{1,80}\bor\b)/i
const OFFER_WEAK = /\b(option [a-c]\b|option [1-3]\b|approach [a-c]\b|my recommendation|i('d| would) recommend|trade-?offs? (between|are))/i

// True when the final text of a turn offers options or asks which approach to take. Needs a question in the
// closing part for strong wording, or two weak signals; one stray "option A" in a report is not enough.
export function looksLikeDecision(answer: string): boolean {
  if (answer.length < 40) return false
  const tail = answer.slice(-400)
  if (OFFER_STRONG.test(tail) && tail.includes('?')) return true
  const weak = (answer.match(new RegExp(OFFER_WEAK.source, 'gi')) ?? []).length
  return weak >= 2 && tail.includes('?')
}
