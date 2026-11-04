// long-session-kit: context meter band + automatic handoffs for long sessions.
//
// Behaviour adapted from the "Context Meter" and "Auto Handoff" mods in the
// Claude Mods Starter Kit v1.0.0 (MIT, Copyright (c) 2026 Prompt Advisers).
// This file is a rewrite from that behaviour, not a copy of its code.
//
// Triggers (one handoff = one `$.model.fork` call):
//   1. context fill reaches `threshold` % (default 50), once per crossing;
//   2. the session has been idle `idleMinutes` (default 30);
//   3. the prompt cache has `cacheWarningMinutesLeft` (default 10) of its
//      `cacheTtlMinutes` (default 60) left, i.e. idle >= ttl - warning (50).
// 2 and 3 share one rule: at most one handoff per idle period (a period ends
// when the next main-thread turn completes). With the defaults, 2 fires first
// (30 < 50) and 3 never fires; 3 only fires first if idleMinutes > ttl - warning.
//
// Where a handoff goes (first match wins), for the session's project root
// (`$.session.root()`, the folder the session is linked to):
//   1. the folder chosen with `/lsk folder` (kept per project in `$.store`);
//   2. the `handoffDir` setting, if set: a sub-folder per project inside it;
//   3. the top level of the project root (the default).
// The target must already exist as a folder. If it has gone, the handoff falls
// back to the project root and says so; if that is gone too, nothing is written.
import type { EngineInterface, Register } from 'claude-code'

import type { LskMeter, LskSaved } from '../types'

const ROOT = { plugin: 'long-session-kit', key: 'root' } as const
const INTERACTIVE = { plugin: 'long-session-kit', key: 'isInteractive' } as const
const RUNNING = { plugin: 'long-session-kit', key: 'running' } as const
const LAST_ACTIVITY = { plugin: 'long-session-kit', key: 'lastActivityAt' } as const
const COVERED = { plugin: 'long-session-kit', key: 'coveredAt' } as const
const FIRED = { plugin: 'long-session-kit', key: 'fired' } as const
const BUSY = { plugin: 'long-session-kit', key: 'busy' } as const
const LAST = { plugin: 'long-session-kit', key: 'last' } as const
const METER = { plugin: 'long-session-kit', key: 'meter' } as const
const OFFER = { plugin: 'long-session-kit', key: 'offerAt' } as const
const STATUS_ON = { plugin: 'long-session-kit', key: 'statusOn' } as const

const TICK_MS = 60_000
// Where 0.1.0 kept handoffs, and the base of the "Documents" choice in /lsk folder.
const FALLBACK_DIR = 'C:\\Users\\Example\\Documents\\Claude Handoffs'
const RESUME_CAP = 60_000
const FOLDERS_KEY = 'folders'
const SESSION_LABEL = 'Session folder (default)'
const GITIGNORE_NOTE =
  'If that folder is a git repository, add handoff-*.md and LATEST.md to its .gitignore (the kit does not edit it).'
const CONFIDENTIAL = 'may contain confidential information. Do not share it, commit it or place it in a shared folder.'

export const HANDOFF_PROMPT = `Write a cold-start handoff for this session so that a new session with no access to this conversation can carry on from here. Do not call any tools. Answer with the document only, in Australian English, without em dashes.

Line 1 must be exactly "LATEST: " followed by one sentence saying where the session has got to. Then a blank line, then these sections as "##" headings:

## What was done
The work completed, in order, and what was verified (tests run, output seen) versus not verified.
## Decisions
Decisions made and why. List anything still undecided separately.
## Open items
Unfinished work, open questions, blockers and risks.
## Next step
The single next action, then the steps after it, with exact commands where they matter.
## Files touched
Every file created, changed or important to the work, with its full path and what it is for.

Rules: use only facts from this conversation and mark anything assumed. Never include passwords, API keys, tokens or other secrets. Do not include commercial rates, margins or contract values unless the work itself is about them.`

export type Cfg = {
  threshold: number
  isEnabled: boolean
  idleMinutes: number
  cacheWarn: number
  cacheTtl: number
  minTurns: number
  /** The optional `handoffDir` setting: a base folder, blank = not set. */
  dir: string
}

export type IdleDecision = { fire: boolean; reason: string }

export type Kind = 'session' | 'chosen' | 'config'
/** Where a handoff should go. `check` is the folder that has to exist already. */
export type Wanted = { kind: Kind; dir: string; check: string }
/** Where it will go: `dir` is unset when nothing usable exists; `missing` names a folder that was not found. */
export type Placed = { kind: Kind; dir?: string; missing?: string }
export type FolderCheck = { ok: true; path: string } | { ok: false; why: string }
type Found = { dir: string; pointer: string; mtimeMs: number }

// ---- pure helpers (exported for the tests) --------------------------------

export function num(v: unknown, fallback: number, min = 0, max = 1_000_000): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

export function toThreshold(v: unknown): number | undefined {
  const n = num(v, -1, 1, 99)
  return n < 0 ? undefined : Math.round(n)
}

export function readCfg(options: Record<string, unknown> | undefined, stored: unknown): Cfg {
  const o = options ?? {}
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
  return {
    threshold: toThreshold(s.threshold) ?? toThreshold(o.threshold) ?? 50,
    isEnabled: typeof s.isEnabled === 'boolean' ? s.isEnabled : o.enabled !== false,
    idleMinutes: num(o.idleMinutes, 30),
    cacheWarn: num(o.cacheWarningMinutesLeft, 10),
    cacheTtl: num(o.cacheTtlMinutes, 60, 1),
    minTurns: Math.round(num(o.minTurns, 3)),
    dir: typeof o.handoffDir === 'string' ? o.handoffDir.trim() : '',
  }
}

// Decides the idle / cache-warning triggers. `idleMs` is time since the last
// main-thread turn ended. Pure, so the "which fires when" rule is testable.
export function decideIdle(cfg: Cfg, idleMs: number): IdleDecision {
  const idleMin = idleMs / 60_000
  const idleHit = cfg.idleMinutes > 0 && idleMin >= cfg.idleMinutes
  // The cache trigger only applies while the cache is still warm.
  const cacheStart = cfg.cacheTtl - cfg.cacheWarn
  const cacheHit = cfg.cacheWarn > 0 && idleMin >= cacheStart && idleMin < cfg.cacheTtl
  if (idleHit) return { fire: true, reason: `idle for ${Math.floor(idleMin)} min (limit ${cfg.idleMinutes})` }
  if (cacheHit) {
    const left = Math.max(0, Math.ceil(cfg.cacheTtl - idleMin))
    return { fire: true, reason: `prompt cache about ${left} min from going cold` }
  }
  return { fire: false, reason: '' }
}

export function projectName(cwd: string): string {
  const last = cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const clean = last.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim()
  return clean === '' || /^[A-Za-z]:?$/.test(clean) ? 'project' : clean
}

export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') || /^[A-Za-z]:/.test(base) ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

// "/lsk folder  C:\My Folder" -> { verb: 'folder', rest: 'C:\My Folder' }
export function splitCommand(raw: string): { verb: string; rest: string } {
  const text = raw.trim()
  const at = text.search(/\s/)
  if (at < 0) return { verb: text.toLowerCase(), rest: '' }
  return { verb: text.slice(0, at).toLowerCase(), rest: text.slice(at).trim() }
}

// A pasted path: trimmed, one pair of wrapping quotes removed (Explorer's "Copy as path"
// adds them), trailing separators dropped but a drive root kept ("C:\").
export function cleanPath(raw: string): string {
  let p = raw.trim()
  const quoted = /^(["'])(.*)\1$/.exec(p)
  if (quoted) p = (quoted[2] ?? '').trim()
  const stripped = p.replace(/[\\/]+$/, '')
  if (stripped === '') return p.slice(0, 1)
  return /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped
}

export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\//.test(p)
}

const pad = (n: number) => String(n).padStart(2, '0')

export function fileStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// DD/MM/YYYY HH:mm, 24-hour
export function humanTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function splitReply(text: string): { summary: string; body: string } {
  const lines = text.replace(/^\s+/, '').split('\n')
  const m = /^LATEST:\s*(.+)$/.exec(lines[0] ?? '')
  if (m) return { summary: m[1].replace(/\s+/g, ' ').trim(), body: lines.slice(1).join('\n') }
  return { summary: 'Handoff written by long-session-kit.', body: text }
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

function short(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(n)
}

// Compact meter text for the status line, e.g. "22% 222k/1M". Pure, so it is testable.
export function statusText(meter: LskMeter): string {
  return `${meter.percent}% ${short(meter.tokens)}/${short(meter.window)}`
}

type Eng = EngineInterface
type Opts = Record<string, unknown>

// A survey holds the AbovePrompt band and a hook yields to it, so while one is up the
// meter moves to this plugin's status line (under the prompt); cleared when it ends.
async function syncSurveyStatus($: Eng, text: string | undefined): Promise<void> {
  const on = (await $.state.get(STATUS_ON)).value === true
  if (text === undefined) {
    if (!on) return
    $.ui.status(undefined)
    await $.state.set(STATUS_ON, false)
    return
  }
  $.ui.status(text)
  await $.state.set(STATUS_ON, true)
}

async function getCfg($: Eng, opts: Opts): Promise<Cfg> {
  return readCfg(opts, await $.store.get('settings'))
}

// The session's project root: the folder the session is linked to. `$.session.root()` is
// where the session started or where /cd, a host directory change or a worktree move took
// it; a shell `cd` does not move it (unlike `$.session.cwd()`). Read live, so a move shows.
async function sessionRoot($: Eng): Promise<string> {
  const live = await $.session.root().catch(() => '')
  if (live) return live
  return (await $.state.get(ROOT)).value ?? ''
}

async function isDir($: Eng, path: string): Promise<boolean> {
  const st = await $.fs.stat(path).catch(() => undefined)
  return st?.kind === 'dir'
}

// ---- the folder a handoff goes to ---------------------------------------------

// The choices made with /lsk folder: { <project root, normalised>: <folder> }. One entry per
// project, so a folder picked for one project never takes another project's handoffs.
async function readFolders($: Eng): Promise<Record<string, string>> {
  const v = await $.store.get(FOLDERS_KEY)
  const out: Record<string, string> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [key, path] of Object.entries(v as Record<string, unknown>)) {
      if (typeof path === 'string' && path !== '') out[key] = path
    }
  }
  return out
}

async function saveChosen($: Eng, root: string, path: string | undefined): Promise<void> {
  const all = await readFolders($)
  if (path === undefined) delete all[norm(root)]
  else all[norm(root)] = path
  await $.store.set(FOLDERS_KEY, all)
}

// The folder 0.1.0 used and the "Documents" choice offers: Documents\Claude Handoffs\<project>.
async function docsFolder($: Eng, root: string): Promise<string> {
  const home = await $.env.get('USERPROFILE')
  const base = home ? joinPath(home, 'Documents', 'Claude Handoffs') : FALLBACK_DIR
  return joinPath(base, projectName(root))
}

async function wantedTarget($: Eng, cfg: Cfg, root: string): Promise<Wanted> {
  const chosen = (await readFolders($))[norm(root)]
  if (chosen) return { kind: 'chosen', dir: chosen, check: chosen }
  if (cfg.dir !== '') return { kind: 'config', dir: joinPath(cfg.dir, projectName(root)), check: cfg.dir }
  return { kind: 'session', dir: root, check: root }
}

// Never writes into a folder that is not there: a chosen or configured folder that has gone
// falls back to the project root; with that gone too, there is no folder (dir unset).
async function placeHandoff($: Eng, cfg: Cfg, root: string): Promise<Placed> {
  const want = await wantedTarget($, cfg, root)
  if (await isDir($, want.check)) return { kind: want.kind, dir: want.dir }
  if (want.kind !== 'session' && (await isDir($, root))) return { kind: 'session', dir: root, missing: want.check }
  return { kind: want.kind, missing: want.check }
}

// Status text for the folder: where handoffs go now, and the .gitignore note.
async function folderLines($: Eng, cfg: Cfg, root: string): Promise<string[]> {
  const how: Record<Kind, string> = {
    session: 'the session folder, the default',
    chosen: 'chosen with /lsk folder',
    config: 'from the handoffDir setting, one sub-folder per project',
  }
  const want = await wantedTarget($, cfg, root)
  const place = await placeHandoff($, cfg, root)
  const lines: string[] = []
  if (place.dir !== undefined && place.missing === undefined) {
    lines.push(`Handoff folder: ${place.dir} (${how[place.kind]}).`)
  } else if (place.dir !== undefined) {
    lines.push(
      `Handoff folder: ${place.dir} (the session folder). ${place.missing} was not found, so handoffs fall back to the session folder. Run /lsk folder to pick another.`,
    )
  } else if (want.kind === 'session') {
    lines.push(`Handoff folder: ${root} (the session folder), but it was not found, so no handoff can be saved.`)
  } else {
    lines.push(
      `Handoff folder: ${want.dir} (${how[want.kind]}), but ${place.missing} was not found and neither was the session folder, so no handoff can be saved.`,
    )
  }
  lines.push(GITIGNORE_NOTE)
  return lines
}

// A typed or pasted folder for /lsk folder: absolute, no network path, and a folder that exists.
async function checkFolder($: Eng, raw: string): Promise<FolderCheck> {
  const p = cleanPath(raw)
  if (p === '') return { ok: false, why: 'give a full folder path, for example C:\\Work\\My Project.' }
  if (/^[\\/]{2}/.test(p)) return { ok: false, why: `${p} is a network path. Use a local folder or a mapped drive letter.` }
  if (!isAbsolutePath(p)) return { ok: false, why: `${p} is not a full path. Start with the drive letter, for example C:\\Work\\My Project.` }
  if (/[<>:"|?*\x00-\x1f]/.test(p.replace(/^[A-Za-z]:/, ''))) {
    return { ok: false, why: `${p} has characters a folder name cannot hold (< > : " | ? *).` }
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return { ok: false, why: `${p} must not contain "..". Give the full path.` }
  const st = await $.fs.stat(p).catch(() => undefined)
  if (!st) return { ok: false, why: `${p} does not exist. Create the folder first, then run /lsk folder again.` }
  if (st.kind !== 'dir') return { ok: false, why: `${p} is a file, not a folder.` }
  return { ok: true, path: p }
}

// Drops the choice, so the handoffDir setting (if set) or else the session folder applies again.
async function resetFolder($: Eng, opts: Opts, root: string): Promise<{ text: string }> {
  await saveChosen($, root, undefined)
  const want = await wantedTarget($, await getCfg($, opts), root)
  const which = want.kind === 'session' ? 'the session folder' : 'the folder from the handoffDir setting'
  return { text: `Folder choice cleared. Handoffs go to ${want.dir} (${which}) from the next handoff on.\n${GITIGNORE_NOTE}` }
}

async function chooseFolder($: Eng, root: string, path: string): Promise<{ text: string }> {
  if (samePath(path, root)) {
    await saveChosen($, root, undefined)
    return { text: `That is the session folder, the default. Handoffs go to ${root} from the next handoff on.` }
  }
  await saveChosen($, root, path)
  return {
    text: `Handoffs for ${projectName(root)} will be saved to ${path} from the next handoff on. Earlier handoffs stay where they are.\n${GITIGNORE_NOTE}`,
  }
}

// The "Documents" choice names a folder that may not exist yet, and $.fs has no mkdir:
// a write creates the folders it needs, so a short note file brings the folder into being.
async function ensureDocsFolder($: Eng, path: string, project: string): Promise<boolean> {
  if (await isDir($, path)) return true
  try {
    await $.fs.write(joinPath(path, 'README.txt'), `This folder holds handoffs written by long-session-kit for ${project}.\nA handoff ${CONFIDENTIAL}\n`)
  } catch {
    return false
  }
  return isDir($, path)
}

// /lsk folder with no argument: ask. The dialog adds its own Other for a typed path.
async function askFolder($: Eng, opts: Opts, root: string): Promise<{ text: string }> {
  const project = projectName(root)
  const docs = await docsFolder($, root)
  const docsLabel = `Documents\\Claude Handoffs\\${project}`
  let answer: string
  try {
    answer = await $.ui.ask(`Where should handoffs for ${project} be saved (Other: type a full folder path)?`, {
      options: [SESSION_LABEL, docsLabel],
      header: 'Folder',
    })
  } catch {
    return { text: 'No change: the folder question was dismissed (or there is no one to ask). /lsk folder <path> sets it directly.' }
  }
  const choice = answer.trim()
  if (choice === '') return { text: 'No change: no folder was given.' }
  if (choice === SESSION_LABEL) return resetFolder($, opts, root)
  if (choice === docsLabel) {
    if (!(await ensureDocsFolder($, docs, project))) return { text: `Folder not changed: ${docs} could not be created.` }
    return chooseFolder($, root, docs)
  }
  const check = await checkFolder($, choice)
  if (!check.ok) return { text: `Folder not changed: ${check.why}` }
  return chooseFolder($, root, check.path)
}

// /lsk folder [<path>|reset|status]
async function folderCommand($: Eng, opts: Opts, rest: string): Promise<{ text: string }> {
  const root = await sessionRoot($)
  if (!root) return { text: 'Folder not changed: the session has no folder yet.' }
  const word = rest.trim().toLowerCase()
  if (word === 'status') return { text: (await folderLines($, await getCfg($, opts), root)).join('\n') }
  if (word === 'reset') return resetFolder($, opts, root)
  if (rest.trim() === '') return askFolder($, opts, root)
  const check = await checkFolder($, rest)
  if (!check.ok) return { text: `Folder not changed: ${check.why}` }
  return chooseFolder($, root, check.path)
}

// Every place a handoff of this project may be: the target, the session folder, the
// handoffDir folder and the Documents folder 0.1.0 used. /lsk resume takes the newest.
async function findLatest($: Eng, cfg: Cfg, root: string): Promise<{ found?: Found; places: string[] }> {
  const want = await wantedTarget($, cfg, root)
  const all = [want.dir, root, ...(cfg.dir !== '' ? [joinPath(cfg.dir, projectName(root))] : []), await docsFolder($, root)]
  const places: string[] = []
  for (const p of all) if (!places.some(q => samePath(p, q))) places.push(p)
  let found: Found | undefined
  for (const dir of places) {
    const pointer = joinPath(dir, 'LATEST.md')
    const st = await $.fs.stat(pointer).catch(() => undefined)
    if (st && st.kind === 'file' && (!found || st.mtimeMs > found.mtimeMs)) found = { dir, pointer, mtimeMs: st.mtimeMs }
  }
  return { found, places }
}

// ---- writing a handoff --------------------------------------------------------

// Writes one handoff. One model call (`$.model.fork`); everything else is $.fs.
async function writeHandoff(
  $: Eng,
  opts: Opts,
  reason: string,
  isManual: boolean,
): Promise<{ path?: string; skipped?: string; fellBack?: string }> {
  const cfg = await getCfg($, opts)
  const root = await sessionRoot($)
  if (!root) return { skipped: 'no session folder' }
  if ((await $.state.get(BUSY)).value === true) return { skipped: 'busy' }

  // Trivial-session guard: count the person's own prompts, not tool results.
  const rows = await $.session.messages()
  const prompts = Array.isArray(rows) ? rows.filter(r => r.role === 'user' && r.text.trim() !== '').length : 0
  if (prompts < (isManual ? 1 : cfg.minTurns)) return { skipped: `trivial session (${prompts} prompts)` }

  const place = await placeHandoff($, cfg, root)
  if (place.dir === undefined) {
    const text =
      place.kind === 'session'
        ? `Handoff not saved: the session folder ${root} was not found.`
        : `Handoff not saved: ${place.missing ?? 'the handoff folder'} was not found, and neither was the session folder. Run /lsk folder to pick a folder.`
    $.ui.toast(text, { timeoutMs: 8000 })
    $.ui.log(`long-session-kit: ${text}`)
    return { skipped: 'no folder' }
  }
  const dir = place.dir

  await $.state.set(BUSY, true)
  try {
    const covers = (await $.state.get(LAST_ACTIVITY)).value ?? 0
    const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (!reply.isAnswered) {
      $.ui.log(`long-session-kit: no handoff, the fork returned ${reply.reason}`)
      if (isManual) $.ui.toast('Handoff was not saved. Try /lsk now again.')
      return { skipped: reply.reason }
    }
    const { summary, body } = splitReply(reply.text)
    if (body.trim() === '') throw new Error('the summary response was empty')
    const now = await $.clock.now()
    const stamp = fileStamp(now)
    let name = `handoff-${stamp}.md`
    for (let n = 2; await $.fs.exists(joinPath(dir, name)); n++) name = `handoff-${stamp}-${n}.md`
    const header =
      `# Handoff: ${projectName(root)}\n\n` +
      `Date: ${humanTime(now)}\n` +
      `Trigger: ${reason}\n` +
      `Session folder: ${root}\n\n` +
      `> This handoff ${CONFIDENTIAL}\n\n`
    const path = joinPath(dir, name)
    await $.fs.write(path, header + body.trim() + '\n')
    await $.fs.write(joinPath(dir, 'LATEST.md'), `${name}\n${summary}\n> This pointer ${CONFIDENTIAL}\n`)
    await $.state.set(LAST, { path, at: now, reason } satisfies LskSaved)
    await $.state.set(COVERED, covers)
    const fellBack = place.missing === undefined ? undefined : `${place.missing} was not found, so the session folder was used.`
    $.ui.toast(`Handoff saved to ${path}${fellBack ? `. ${fellBack}` : ''}`, { timeoutMs: 8000 })
    $.ui.log(`long-session-kit: saved ${path} (${reason})${fellBack ? `. ${fellBack}` : ''}`)
    return { path, fellBack }
  } catch (err) {
    $.ui.log(`long-session-kit: writing the handoff failed (${(err as Error)?.message ?? err})`)
    $.ui.toast('Handoff was not saved.')
    return { skipped: 'error' }
  } finally {
    await $.state.set(BUSY, false)
  }
}

async function tick($: Eng, opts: Opts): Promise<void> {
  try {
    $.ui.invalidate('ui.render') // refreshes the cache countdown in the band
    const cfg = await getCfg($, opts)
    if (!cfg.isEnabled) return
    if ((await $.state.get(RUNNING)).value === true || (await $.state.get(BUSY)).value === true) return
    const last = (await $.state.get(LAST_ACTIVITY)).value ?? 0
    if (last === 0 || (await $.state.get(COVERED)).value === last) return
    const decision = decideIdle(cfg, (await $.clock.now()) - last)
    if (!decision.fire) return
    // Mark the period covered first, so a skipped or failed attempt is not retried every minute.
    await $.state.set(COVERED, last)
    await writeHandoff($, opts, decision.reason, false)
  } catch (err) {
    $.ui.log(`long-session-kit: idle check failed (${(err as Error)?.message ?? err})`)
  }
}


// ---- the mod ----------------------------------------------------------------

export const register: Register = (on, options) => {
  const opts = options as Record<string, unknown>

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'lsk',
      description: 'Long session kit: handoff now | on | off | status | threshold <n> | folder | resume',
      argumentHint: '[now|on|off|status|threshold <n>|folder [path|reset|status]|resume]',
    })
    const root = await $.session.root().catch(() => e.cwd)
    await $.state.set(ROOT, root)
    await $.state.set(INTERACTIVE, e.isInteractive)
    await $.state.set(RUNNING, false)

    const u = await $.session.usage()
    if (u.context.tokens !== undefined && u.context.window > 0) {
      const percent = u.context.percent ?? Math.round((u.context.tokens / u.context.window) * 100)
      await $.state.set(METER, { tokens: u.context.tokens, window: u.context.window, percent })
    }

    // Offer to resume from a handoff written before this session began.
    const { found } = await findLatest($, await getCfg($, opts), root)
    if (found && (!(u.startedAt > 0) || found.mtimeMs < u.startedAt)) await $.state.set(OFFER, found.mtimeMs)

    // The idle clock. $.clock.every runs until cancelled or the module reloads.
    $.clock.every(TICK_MS, () => {
      void tick($, opts)
    })
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await $.state.set(RUNNING, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      await $.state.set(RUNNING, false)
      await $.state.set(LAST_ACTIVITY, await $.clock.now())
      await $.state.set(OFFER, 0)
    }
    return result
  })

  // After /clear there is no session.start: reset so an empty session is not "idle".
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await $.state.set(LAST_ACTIVITY, 0)
      await $.state.set(COVERED, 0)
      await $.state.set(FIRED, false)
      await $.state.set(METER, null)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (!e.changed.includes('context')) return result
    const { tokens, window, percent } = e.context
    if (tokens === undefined || percent === undefined) return result
    await $.state.set(METER, { tokens, window, percent })

    const cfg = await getCfg($, opts)
    const fired = (await $.state.get(FIRED)).value === true
    if (percent < cfg.threshold) {
      if (fired) await $.state.set(FIRED, false) // re-arm after a compaction or /clear
      return result
    }
    if (fired || !cfg.isEnabled) return result
    await $.state.set(FIRED, true)
    const reason = `context at ${percent}%, threshold ${cfg.threshold}%`
    // From a timer: the fork must not run inside this dispatch.
    $.clock.after(0, () => {
      void writeHandoff($, opts, reason, false).then(async r => {
        // Nothing saved because the fork was not ready: allow the next measurement to retry.
        if (!r.path && r.skipped === 'nothing-to-fork') await $.state.set(FIRED, false)
      })
    })
    return result
  })

  on('command.run', { command: 'lsk' }, async ($, e) => {
    const { verb, rest } = splitCommand(e.args ?? '')
    const value = rest.split(/\s+/)[0] ?? ''
    const stored = await $.store.get('settings')
    const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
    const cfg = readCfg(opts, stored)

    if (verb === '' || verb === 'status') {
      const meter = (await $.state.get(METER)).value
      const last = (await $.state.get(LAST)).value
      const act = (await $.state.get(LAST_ACTIVITY)).value ?? 0
      const now = await $.clock.now()
      const root = await sessionRoot($)
      const cache = act === 0 ? 'no response yet' : cacheText(cfg, now - act)
      return {
        text: [
          `Long session kit is ${cfg.isEnabled ? 'on' : 'off'}. Context ${meter ? meter.percent + '%' : 'not measured yet'}, handoff at ${cfg.threshold}%.`,
          `Idle handoff after ${cfg.idleMinutes || 'never'} min; cache warning ${cfg.cacheWarn || 'off'} min before the ${cfg.cacheTtl} min cache expires. Cache: ${cache}.`,
          last ? `Last handoff: ${last.path}, ${ago(now - last.at)} (${last.reason}).` : 'No handoff written this session.',
          ...(root ? await folderLines($, cfg, root) : ['Handoff folder: the session has no folder yet.']),
          'Commands: /lsk now, on, off, status, threshold <n>, folder [<path>|reset|status], resume.',
        ].join('\n'),
      }
    }

    if (verb === 'on' || verb === 'off') {
      await $.store.set('settings', { ...base, isEnabled: verb === 'on' })
      return { text: `Automatic handoffs are ${verb}.` }
    }

    if (verb === 'threshold') {
      const n = toThreshold(value)
      if (n === undefined) return { text: 'Usage is /lsk threshold <1-99>' }
      await $.store.set('settings', { ...base, threshold: n })
      await $.state.set(FIRED, false)
      return { text: `Handoff threshold set to ${n}%.` }
    }

    if (verb === 'folder') return folderCommand($, opts, rest)

    if (verb === 'now') {
      if ((await $.state.get(BUSY)).value === true) return { text: 'A handoff is already being written.' }
      if ((await $.state.get(INTERACTIVE)).value === true) {
        $.clock.after(0, () => {
          void writeHandoff($, opts, '/lsk now', true)
        })
        return { text: 'Writing a handoff in the background. A toast says where it is saved.' }
      }
      const r = await writeHandoff($, opts, '/lsk now', true)
      return { text: r.path ? `Handoff saved to ${r.path}${r.fellBack ? `. ${r.fellBack}` : ''}` : `No handoff written (${r.skipped}).` }
    }

    if (verb === 'resume') {
      const root = await sessionRoot($)
      if (!root) return { text: 'The session has no folder yet, so there is nowhere to look for a handoff.' }
      const { found, places } = await findLatest($, cfg, root)
      if (!found) return { text: `No handoff found. Looked in: ${places.join('; ')}` }
      const name = (((await $.fs.read(found.pointer).catch(() => '')) as string).split(/\r?\n/)[0] ?? '').trim()
      if (!name.endsWith('.md') || /[\\/]/.test(name) || !(await $.fs.exists(joinPath(found.dir, name)))) {
        return { text: `${found.pointer} is missing or points at a file that is not there. Run /lsk now in the original session.` }
      }
      const content = (await $.fs.read(joinPath(found.dir, name))) as string
      await $.state.set(OFFER, 0)
      // A command hook may not submit (the prompt would wait on this hook): submit from a timer.
      $.clock.after(0, () => {
        void $.prompt.submit({
          text:
            'Resume from this handoff. Brief me in a few lines on where we left off, verify the current state of anything it calls done, then continue with its next step. Ask before doing anything that needs my go-ahead.\n\n' +
            content.slice(0, RESUME_CAP),
        })
      })
      return { text: `Resuming from ${joinPath(found.dir, name)}` }
    }

    return { text: 'Usage is /lsk [now|on|off|status|threshold <n>|folder [path|reset|status]|resume]' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const original = await next(e)
    const meter = (await $.state.get(METER)).value as LskMeter | null
    if (e.props.view?.agentId || !meter) return original
    if (e.props.hasSurvey) {
      await syncSurveyStatus($, statusText(meter))
      return original
    }
    await syncSurveyStatus($, undefined)
    const cfg = await getCfg($, opts)
    const act = (await $.state.get(LAST_ACTIVITY)).value ?? 0
    const offer = (await $.state.get(OFFER)).value ?? 0
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const color = meter.percent >= cfg.threshold ? 'red' : meter.percent >= cfg.threshold - 10 ? 'yellow' : 'green'
    const icon = meter.percent >= cfg.threshold ? '●' : meter.percent >= cfg.threshold - 10 ? '◑' : '◔'
    const wide = e.props.bodyColumns >= 60
    const mine = (
      <Box flexDirection="row" paddingX={1}>
        <Text color={color} bold>
          {`${icon} ${meter.percent}%`}
        </Text>
        <Text dimColor>{` ${short(meter.tokens)}/${short(meter.window)}`}</Text>
        {wide && <Text dimColor>{cfg.isEnabled ? `  ·  handoff at ${cfg.threshold}%` : '  ·  handoff off'}</Text>}
        {wide && act > 0 && <Text dimColor>{`  ·  cache ${cacheText(cfg, now - act)}`}</Text>}
        {offer > 0 && <Text dimColor>{`  ·  handoff from ${ago(now - offer)}: `}</Text>}
        {offer > 0 && <Text bold>/lsk resume</Text>}
      </Box>
    )
    // Claude Code's own placeholder ({ type: 'engine' }) must never be nested: the desktop drops a band that nests it.
    if (!original || (original as { type?: string }).type === 'engine') return mine
    return <Box flexDirection="column">{original}{mine}</Box>
  })
}

// "warm, 48 min left" / "cold"
export function cacheText(cfg: Cfg, idleMs: number): string {
  const left = cfg.cacheTtl - Math.floor(idleMs / 60_000)
  return left > 0 ? `warm, ${left} min left` : 'cold'
}
