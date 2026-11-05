import { expect, mock, test } from 'claude-code/testing'

import {
  cleanPath,
  compactText,
  decideContext,
  decideIdle,
  isAbsolutePath,
  joinPath,
  projectName,
  readCfg,
  samePath,
  splitCommand,
  splitReply,
  statusText,
  thresholdText,
  toSecond,
} from './register'

const cfg = (o: Record<string, unknown> = {}) => readCfg(o, undefined)
const MIN = 60_000
const ROOT = 'C:\\Work\\My Project'
const DOCS = 'C:\\Users\\Tester\\Documents\\Claude Handoffs\\My Project'
const SESSION_LABEL = 'Session folder (default)'
const DOCS_LABEL = 'Documents\\Claude Handoffs\\My Project'
const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

test('defaults: 50% threshold, idle 30, cache warning 10 of 60, no handoffDir', () => {
  const c = cfg()
  expect(c.threshold).toBe(50)
  expect(c.idleMinutes).toBe(30)
  expect(c.cacheWarn).toBe(10)
  expect(c.cacheTtl).toBe(60)
  expect(c.minTurns).toBe(3)
  expect(c.dir).toBe('')
})

test('with defaults the idle trigger fires first and the cache trigger never gets its turn', () => {
  const c = cfg()
  expect(decideIdle(c, 29 * MIN).fire).toBe(false)
  expect(decideIdle(c, 30 * MIN).reason).toMatch(/idle for 30 min/)
  // At 50 min the cache rule would match, but the idle reason is what is reported:
  expect(decideIdle(c, 50 * MIN).reason).toMatch(/idle/)
})

test('cache trigger fires on its own when the idle trigger is off or later', () => {
  const off = cfg({ idleMinutes: 0 })
  expect(decideIdle(off, 49 * MIN).fire).toBe(false)
  expect(decideIdle(off, 50 * MIN).reason).toMatch(/cache about 10 min/)
  expect(decideIdle(off, 61 * MIN).fire).toBe(false) // already cold: no cache trigger
  const late = cfg({ idleMinutes: 55 })
  expect(decideIdle(late, 50 * MIN).reason).toMatch(/cache/)
})

test('paths: Windows spaces, project name and comparison', () => {
  expect(projectName('C:\\Users\\Example\\Documents\\Projects\\Example Project')).toBe(
    'Example Project',
  )
  expect(joinPath('C:\\Users\\Example\\Documents\\Claude Handoffs\\', 'p', 'LATEST.md')).toBe(
    'C:\\Users\\Example\\Documents\\Claude Handoffs\\p\\LATEST.md',
  )
  expect(samePath('C:\\Proj\\x\\', 'c:/proj/X')).toBe(true)
  expect(samePath('C:\\Projects2\\x', 'C:\\Proj')).toBe(false)
})

test('/lsk folder arguments: verb split, quotes removed, drive root kept, absolute check', () => {
  expect(splitCommand('  Folder   D:\\My Folder\\Sub ')).toEqual({ verb: 'folder', rest: 'D:\\My Folder\\Sub' })
  expect(splitCommand('status')).toEqual({ verb: 'status', rest: '' })
  expect(splitCommand('')).toEqual({ verb: '', rest: '' })
  expect(cleanPath('"D:\\My Folder\\Sub\\"')).toBe('D:\\My Folder\\Sub')
  expect(cleanPath("'D:\\My Folder'")).toBe('D:\\My Folder')
  expect(cleanPath('D:\\')).toBe('D:\\')
  expect(cleanPath('D:')).toBe('D:\\')
  expect(cleanPath('""')).toBe('')
  expect(isAbsolutePath('D:\\x')).toBe(true)
  expect(isAbsolutePath('D:/x')).toBe(true)
  expect(isAbsolutePath('x\\y')).toBe(false)
  expect(isAbsolutePath('D:x')).toBe(false)
})

test('splitReply takes the LATEST line as the summary', () => {
  expect(splitReply('LATEST: Done the thing.\n\n## What was done\nx').summary).toBe('Done the thing.')
})

test('statusText is the compact meter shown while a survey holds the band', () => {
  expect(statusText({ percent: 22, tokens: 222_000, window: 1_000_000 })).toBe('22% 222k/1M')
})

test('second threshold: default 70, 0 or "off" is off, a stored 0 beats the setting, junk falls back', () => {
  expect(cfg().secondRaw).toBe(70)
  expect(cfg().second).toBe(70)
  expect(cfg({ secondThreshold: 85 }).second).toBe(85)
  expect(cfg({ secondThreshold: 0 }).second).toBe(0)
  expect(cfg({ secondThreshold: 'off' }).second).toBe(0)
  expect(cfg({ secondThreshold: 'abc' }).second).toBe(70)
  expect(cfg({ secondThreshold: 150 }).second).toBe(70)
  expect(cfg({ secondThreshold: -5 }).second).toBe(70)
  // The person's own override is stored; a stored 0 ("off") must not fall through to the setting.
  expect(readCfg({ secondThreshold: 80 }, { secondThreshold: 0 }).second).toBe(0)
  expect(readCfg({ secondThreshold: 80 }, { secondThreshold: 90 }).second).toBe(90)
  expect(readCfg({ secondThreshold: 80 }, { threshold: 60 }).second).toBe(80)
  expect(toSecond('off')).toBe(0)
  expect(toSecond('0')).toBe(0)
  expect(toSecond('70%')).toBe(70)
  expect(toSecond(0.5)).toBeUndefined()
  expect(toSecond(100)).toBeUndefined()
  expect(toSecond('')).toBeUndefined()
})

test('second threshold must be above the first, otherwise it is ignored (and kept as set)', () => {
  const same = cfg({ secondThreshold: 50 })
  expect([same.secondRaw, same.second]).toEqual([50, 0])
  const below = cfg({ secondThreshold: 40 })
  expect([below.secondRaw, below.second]).toEqual([40, 0])
  // The default 70 is not above a first threshold of 80: judged on every read.
  const raised = readCfg({}, { threshold: 80 })
  expect([raised.secondRaw, raised.second]).toEqual([70, 0])
  expect(readCfg({ threshold: 30, secondThreshold: 40 }, undefined).second).toBe(40)
})

test('decideContext: crossings, a jump over both, re-arming each latch, off and disabled', () => {
  const step = (p: number, fired = false, firedSecond = false, o: Record<string, unknown> = {}) =>
    decideContext(cfg(o), p, fired, firedSecond)
  expect(step(49)).toEqual({ fired: false, firedSecond: false })
  expect(step(50)).toEqual({ fired: true, firedSecond: false, write: 'first' })
  expect(step(69, true)).toEqual({ fired: true, firedSecond: false })
  expect(step(70, true)).toEqual({ fired: true, firedSecond: true, write: 'second' })
  expect(step(85)).toEqual({ fired: true, firedSecond: true, write: 'second' }) // one jump over both
  expect(step(90, true, true)).toEqual({ fired: true, firedSecond: true }) // already handed off
  expect(step(60, true, true)).toEqual({ fired: true, firedSecond: false }) // back under 70: second re-arms only
  expect(step(40, true, true)).toEqual({ fired: false, firedSecond: false }) // back under 50: both re-arm
  // First latch cleared (say /lsk threshold) while above the second, whose handoff covers it: no extra handoff.
  expect(step(75, false, true)).toEqual({ fired: true, firedSecond: true })
  expect(step(75, true, false, { secondThreshold: 0 })).toEqual({ fired: true, firedSecond: false })
  expect(step(75, false, false, { secondThreshold: 0 })).toEqual({ fired: true, firedSecond: false, write: 'first' })
  expect(step(75, false, false, { secondThreshold: 40 })).toEqual({ fired: true, firedSecond: false, write: 'first' })
  expect(step(75, false, false, { enabled: false })).toEqual({ fired: false, firedSecond: false })
  expect(step(40, true, true, { enabled: false })).toEqual({ fired: false, firedSecond: false })
})

test('the compact suggestion and the band wording', () => {
  expect(compactText(72)).toBe('Context at 72%. A fresh handoff is saved. Consider /compact, or continue in a new chat with /lsk resume.')
  expect(thresholdText(cfg())).toBe('handoff at 50% / 70%')
  expect(thresholdText(cfg({ secondThreshold: 0 }))).toBe('handoff at 50%')
  expect(thresholdText(cfg({ secondThreshold: 40 }))).toBe('handoff at 50%')
})

// ---- a world beneath the plugin: an in-memory file system, store, clock and dialogs ----------

function addParents(dirs: Set<string>, path: string) {
  const parts = path.split(/[\\/]/)
  for (let i = 1; i < parts.length; i++) dirs.add(key(parts.slice(0, i).join('\\')))
}

type Opts = {
  prompts?: number
  root?: string
  cwd?: string
  dirs?: string[]
  files?: Record<string, string>
  store?: Record<string, unknown>
  startedAt?: number
}

// Nothing sits beneath the plugin: each hook here stands for the engine.
function world(on: any, o: Opts = {}) {
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 4, 2, 0, 0) })
  mock.store(on, o.store)
  const w = {
    clock,
    dirs: new Set<string>((o.dirs ?? [ROOT]).map(key)),
    files: new Map<string, { text: string; at: number }>(),
    written: [] as string[],
    toasts: [] as string[],
    submitted: [] as string[],
    asked: [] as { question: string; labels: string[] }[],
    answer: 'dismiss', // what the folder question is answered with; 'dismiss' closes it
    forkCount: 0,
    hold: undefined as Promise<void> | undefined, // while set, a fork waits for it: a handoff stays in flight
  }
  for (const [path, text] of Object.entries(o.files ?? {})) {
    w.files.set(key(path), { text, at: 1 })
    addParents(w.dirs, path)
  }
  on('command.register', () => ({ value: { command: 'lsk' } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: o.startedAt ?? 0, context: { window: 1_000_000, tokens: 100_000, percent: 10 }, rateLimits: [] },
  }))
  on('session.root', () => ({ value: o.root ?? ROOT }))
  on('session.cwd', () => ({ value: o.cwd ?? o.root ?? ROOT }))
  on('session.messages', () => ({
    value: Array.from({ length: o.prompts ?? 4 }, () => ({ role: 'user', text: 'do a thing', toolUses: [] })),
  }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\Tester' : undefined }))
  on('fs.stat', (_: any, e: any) => {
    const k = key(e.path)
    const f = w.files.get(k)
    if (f) return { value: { kind: 'file', size: f.text.length, mtimeMs: f.at, isLink: false } }
    if (w.dirs.has(k)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    return { deny: 'ENOENT' }
  })
  on('fs.exists', (_: any, e: any) => ({ value: w.files.has(key(e.path)) || w.dirs.has(key(e.path)) }))
  on('fs.read', (_: any, e: any) => {
    const f = w.files.get(key(e.path))
    return f ? { value: f.text } : { deny: 'ENOENT' }
  })
  on('fs.write', (_: any, e: any) => {
    w.written.push(e.path)
    w.files.set(key(e.path), { text: e.text, at: clock.now() })
    addParents(w.dirs, e.path)
    return { value: undefined }
  })
  on('model.fork', async () => {
    w.forkCount++
    if (w.hold) await w.hold
    return { value: { isAnswered: true, text: 'LATEST: Summary.\n\n## What was done\nx', usage: {} } }
  })
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('prompt.submit', (_: any, e: any) => {
    w.submitted.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('ui.toast', (_: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', (_: any, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0]
      w.asked.push({ question: q.question, labels: q.options.map((x: { label: string }) => x.label) })
      if (w.answer === 'dismiss') return { deny: 'dismissed' }
      return { result: { questions: [], answers: { [q.question]: w.answer } } } as never
    }
    return { result: {} }
  })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return w
}

const START = { cwd: ROOT, surface: 'terminal' } as const
const begin = ($: any, isInteractive = false) => $.session.start({ ...START, isInteractive })

async function lsk($: any, args: string): Promise<string> {
  const r = await $.command.run({ command: 'lsk', args })
  return r.text ?? ''
}

async function oneTurn($: any) {
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
}

const HANDOFF_AT = (dir: string) => new RegExp(`^Handoff saved to ${dir.replace(/[\\.()]/g, '\\$&')}\\\\handoff-\\d{4}-\\d{2}-\\d{2}-\\d{6}\\.md$`)

// ---- the default: the session root ---------------------------------------------------------

test('one idle handoff per idle period, at the top level of the session root', async ($, on) => {
  const w = world(on, { prompts: 4 })
  await begin($, true)
  await oneTurn($)
  await w.clock.advance(31 * MIN)
  expect(w.forkCount).toBe(1)
  const handoff = w.written.find(p => /\\handoff-[^\\]+\.md$/.test(p))
  expect(handoff).toBeDefined()
  expect(handoff?.slice(0, ROOT.length + 1)).toBe(`${ROOT}\\`)
  expect(handoff?.slice(ROOT.length + 1)).not.toContain('\\') // top level: no sub-folder
  expect(w.written).toContain(`${ROOT}\\LATEST.md`)
  expect(w.written.some(p => p.includes('Claude Handoffs'))).toBe(false)
  await w.clock.advance(40 * MIN) // still the same idle period, past the cache warning too
  expect(w.forkCount).toBe(1)
})

test('the session root is used, not the working directory a shell cd moved to', async ($, on) => {
  const deeper = `${ROOT}\\src\\deeper`
  const w = world(on, { cwd: deeper, dirs: [ROOT, deeper] })
  await begin($)
  expect(await lsk($, 'now')).toMatch(HANDOFF_AT(ROOT))
  expect(w.written.every(p => p.startsWith(`${ROOT}\\`) && !p.startsWith(deeper))).toBe(true)
})

test('each file carries the confidentiality header, the session folder and the trigger', async ($, on) => {
  const w = world(on)
  await begin($)
  await lsk($, 'now')
  const handoff = [...w.files.entries()].find(([k]) => /\/handoff-[^/]+\.md$/.test(k))?.[1].text ?? ''
  expect(handoff).toContain('# Handoff: My Project')
  expect(handoff).toContain(`Session folder: ${ROOT}`)
  expect(handoff).toContain('Trigger: /lsk now')
  expect(handoff).toContain('may contain confidential information. Do not share it, commit it or place it in a shared folder.')
  const latest = w.files.get(key(`${ROOT}\\LATEST.md`))?.text ?? ''
  expect(latest.split('\n')[0]).toMatch(/^handoff-.*\.md$/) // line 1 stays the pointer /lsk resume reads
  expect(latest.split('\n')[1]).toBe('Summary.')
  expect(latest).toContain('may contain confidential information')
})

test('no automatic handoff for a trivial session', async ($, on) => {
  const w = world(on, { prompts: 1 })
  await begin($, true)
  await oneTurn($)
  await w.clock.advance(31 * MIN)
  expect(w.forkCount).toBe(0)
  expect(w.written).toHaveLength(0)
})

test('status names the session folder and carries the .gitignore note', async ($, on) => {
  world(on)
  await begin($)
  const text = await lsk($, 'status')
  expect(text).toContain(`Handoff folder: ${ROOT} (the session folder, the default).`)
  expect(text).toContain('add handoff-*.md and LATEST.md to its .gitignore')
  expect(text).toContain('folder [<path>|reset|status]')
})

// ---- /lsk folder <path> --------------------------------------------------------------------

test('/lsk folder <path>: a valid folder is used, quoted or not, with spaces and a trailing slash', async ($, on) => {
  const target = 'D:\\Handoff Files\\Project X'
  const w = world(on, { dirs: [ROOT, target] })
  await begin($)
  for (const arg of [`"${target}"`, target, `${target}\\`]) {
    await lsk($, 'folder reset')
    expect(await lsk($, `folder ${arg}`)).toContain(`will be saved to ${target} from the next handoff on`)
  }
  expect(await lsk($, 'status')).toContain(`Handoff folder: ${target} (chosen with /lsk folder).`)
  expect(await lsk($, 'now')).toMatch(HANDOFF_AT(target))
  expect(w.written.every(p => p.startsWith(`${target}\\`))).toBe(true)
  expect(w.written).toContain(`${target}\\LATEST.md`)
})

test('/lsk folder <path>: an invalid path is refused with a reason and nothing changes', async ($, on) => {
  const w = world(on, { files: { 'D:\\Notes.txt': 'x' } })
  await begin($)
  const bad: [string, RegExp][] = [
    ['Handoffs', /not a full path/],
    ['..\\Handoffs', /not a full path/],
    ['%USERPROFILE%\\Handoffs', /not a full path/],
    ['D:Handoffs', /not a full path/],
    ['D:\\Nope', /does not exist/],
    ['D:\\Notes.txt', /is a file, not a folder/],
    ['\\\\server\\share\\x', /network path/],
    ['D:\\a\\..\\b', /\.\./],
    ['D:\\bad|name', /characters/],
    ['""', /give a full folder path/],
  ]
  for (const [arg, why] of bad) {
    const said = await lsk($, `folder ${arg}`)
    expect(said).toMatch(/^Folder not changed:/)
    expect(said).toMatch(why)
  }
  expect(await lsk($, 'folder status')).toContain(`Handoff folder: ${ROOT} (the session folder, the default).`)
  expect(w.written).toHaveLength(0)
})

test('/lsk folder reset returns to the session folder', async ($, on) => {
  const w = world(on, { dirs: [ROOT, 'D:\\Chosen'] })
  await begin($)
  await lsk($, 'folder D:\\Chosen')
  expect(await lsk($, 'folder status')).toContain('Handoff folder: D:\\Chosen (chosen with /lsk folder).')
  const said = await lsk($, 'folder reset')
  expect(said).toContain(`Handoffs go to ${ROOT} (the session folder)`)
  expect(await lsk($, 'folder status')).toContain(`Handoff folder: ${ROOT} (the session folder, the default).`)
  expect(await lsk($, 'now')).toMatch(HANDOFF_AT(ROOT))
  expect(w.written.some(p => p.startsWith('D:\\'))).toBe(false)
})

test('choosing the session folder by path is the same as reset', async ($, on) => {
  world(on, { dirs: [ROOT] })
  await begin($)
  expect(await lsk($, `folder ${ROOT}\\`)).toContain('That is the session folder, the default.')
  expect(await lsk($, 'folder status')).toContain('(the session folder, the default)')
})

test('a chosen folder applies to future handoffs only', async ($, on) => {
  const w = world(on, { dirs: [ROOT, 'D:\\Chosen'] })
  await begin($)
  await lsk($, 'now')
  const before = [...w.written]
  expect(before.every(p => p.startsWith(`${ROOT}\\`))).toBe(true)
  await lsk($, 'folder D:\\Chosen')
  expect(w.written).toEqual(before) // nothing moved or copied
  await w.clock.advance(1000)
  await lsk($, 'now')
  expect(w.written.slice(before.length).every(p => p.startsWith('D:\\Chosen\\'))).toBe(true)
})

// ---- /lsk folder with no argument: the question --------------------------------------------

test('/lsk folder asks with two options (the dialog adds Other); Session folder resets', async ($, on) => {
  const w = world(on, { dirs: [ROOT, 'D:\\Chosen'] })
  await begin($)
  await lsk($, 'folder D:\\Chosen')
  w.answer = SESSION_LABEL
  const said = await lsk($, 'folder')
  expect(w.asked).toHaveLength(1)
  expect(w.asked[0]?.labels).toEqual([SESSION_LABEL, DOCS_LABEL])
  expect(w.asked[0]?.question).toMatch(/\?$/)
  expect(said).toContain('Folder choice cleared')
  expect(await lsk($, 'folder status')).toContain(`Handoff folder: ${ROOT} (the session folder, the default).`)
})

test('/lsk folder: the Documents choice creates the folder and is used', async ($, on) => {
  const w = world(on)
  await begin($)
  w.answer = DOCS_LABEL
  const said = await lsk($, 'folder')
  expect(said).toContain(`will be saved to ${DOCS} from the next handoff on`)
  expect(w.files.get(key(`${DOCS}\\README.txt`))?.text).toContain('may contain confidential information')
  expect(await lsk($, 'now')).toMatch(HANDOFF_AT(DOCS))
  expect(w.written.some(p => p === `${ROOT}\\LATEST.md`)).toBe(false)
})

test('/lsk folder: Other (a typed path) is validated like /lsk folder <path>', async ($, on) => {
  const w = world(on, { dirs: [ROOT, 'E:\\Typed Folder'] })
  await begin($)
  w.answer = '"E:\\Typed Folder"'
  expect(await lsk($, 'folder')).toContain('will be saved to E:\\Typed Folder from the next handoff on')
  expect(await lsk($, 'folder status')).toContain('Handoff folder: E:\\Typed Folder (chosen with /lsk folder).')
  w.answer = 'E:\\Missing'
  const bad = await lsk($, 'folder')
  expect(bad).toMatch(/^Folder not changed: E:\\Missing does not exist/)
  expect(await lsk($, 'folder status')).toContain('E:\\Typed Folder') // the earlier choice stands
})

test('/lsk folder: dismissing the question changes nothing', async ($, on) => {
  const w = world(on)
  await begin($)
  w.answer = 'dismiss'
  const said = await lsk($, 'folder')
  expect(said).toMatch(/^No change: the folder question was dismissed/)
  expect(w.asked).toHaveLength(1)
  expect(await lsk($, 'folder status')).toContain(`Handoff folder: ${ROOT} (the session folder, the default).`)
  expect(w.written).toHaveLength(0)
})

// ---- persistence, handoffDir, and folders that are not there -------------------------------

test('a choice kept in the store survives into a new session and overrides handoffDir', { options: { handoffDir: 'D:\\Base' } }, async ($, on) => {
  const w = world(on, {
    dirs: [ROOT, 'D:\\Base', 'D:\\Chosen'],
    store: { folders: { 'c:/work/my project': 'D:\\Chosen' } },
  })
  await begin($)
  expect(await lsk($, 'status')).toContain('Handoff folder: D:\\Chosen (chosen with /lsk folder).')
  expect(await lsk($, 'now')).toMatch(HANDOFF_AT('D:\\Chosen'))
  expect(w.written.some(p => p.startsWith('D:\\Base'))).toBe(false)
})

test('a choice is per project: another project keeps its default', async ($, on) => {
  const other = 'C:\\Work\\Other Job'
  const w = world(on, { root: other, dirs: [other, 'D:\\Chosen'], store: { folders: { 'c:/work/my project': 'D:\\Chosen' } } })
  await begin($)
  expect(await lsk($, 'now')).toMatch(HANDOFF_AT(other))
  expect(w.written.some(p => p.startsWith('D:\\'))).toBe(false)
})

test('/lsk folder keeps the choice in the store: a new session starts with it, reset clears it', async ($, on) => {
  const w = world(on, { dirs: [ROOT, 'D:\\Chosen'] })
  await begin($)
  await lsk($, 'folder D:\\Chosen')
  await begin($) // a new session: the choice lives only in $.store, so this reads it back
  expect(await lsk($, 'status')).toContain('Handoff folder: D:\\Chosen (chosen with /lsk folder).')
  await lsk($, 'folder reset')
  await begin($)
  expect(await lsk($, 'status')).toContain(`Handoff folder: ${ROOT} (the session folder, the default).`)
  expect(w.written).toHaveLength(0)
})

test('handoffDir, when set, gives each project a sub-folder; reset falls back to it', { options: { handoffDir: 'D:\\Base' } }, async ($, on) => {
  const w = world(on, { dirs: [ROOT, 'D:\\Base', 'D:\\Chosen'] })
  await begin($)
  expect(await lsk($, 'status')).toContain('Handoff folder: D:\\Base\\My Project (from the handoffDir setting, one sub-folder per project).')
  await lsk($, 'folder D:\\Chosen')
  expect(await lsk($, 'folder reset')).toContain('D:\\Base\\My Project (the folder from the handoffDir setting)')
  expect(await lsk($, 'now')).toMatch(HANDOFF_AT('D:\\Base\\My Project'))
  expect(w.written.some(p => p.startsWith(ROOT))).toBe(false)
})

test('a chosen folder that has gone: fall back to the session folder and say so', async ($, on) => {
  const w = world(on, { store: { folders: { 'c:/work/my project': 'D:\\Gone' } } })
  await begin($)
  const status = await lsk($, 'status')
  expect(status).toContain(`Handoff folder: ${ROOT} (the session folder).`)
  expect(status).toContain('D:\\Gone was not found, so handoffs fall back to the session folder')
  const out = await lsk($, 'now')
  expect(out).toContain(`Handoff saved to ${ROOT}\\handoff-`)
  expect(out).toContain('D:\\Gone was not found, so the session folder was used.')
  expect(w.toasts.some(t => t.includes('D:\\Gone was not found, so the session folder was used.'))).toBe(true)
  expect(w.written.some(p => p.startsWith('D:\\Gone'))).toBe(false)
  expect(w.written.every(p => p.startsWith(`${ROOT}\\`))).toBe(true)
})

test('a handoffDir that does not exist falls back the same way', { options: { handoffDir: 'D:\\NoBase' } }, async ($, on) => {
  const w = world(on)
  await begin($)
  const out = await lsk($, 'now')
  expect(out).toContain('D:\\NoBase was not found, so the session folder was used.')
  expect(w.written.some(p => p.startsWith('D:\\'))).toBe(false)
  expect(w.written).toContain(`${ROOT}\\LATEST.md`)
})

test('nothing is written when the target and the session folder are both gone', async ($, on) => {
  const w = world(on, { dirs: [], store: { folders: { 'c:/work/my project': 'D:\\Gone' } } })
  await begin($)
  const out = await lsk($, 'now')
  expect(out).toBe('No handoff written (no folder).')
  expect(w.written).toHaveLength(0)
  expect(w.forkCount).toBe(0) // no model call spent on a handoff with nowhere to go
  expect(w.toasts.some(t => /^Handoff not saved: D:\\Gone was not found, and neither was the session folder/.test(t))).toBe(true)
})

test('the session folder itself missing: nothing written, no folder made', async ($, on) => {
  const w = world(on, { dirs: [] })
  await begin($)
  expect(await lsk($, 'now')).toBe('No handoff written (no folder).')
  expect(w.written).toHaveLength(0)
  expect(w.toasts.some(t => t.includes(`the session folder ${ROOT} was not found`))).toBe(true)
})

// ---- the two context triggers --------------------------------------------------------------

type World = ReturnType<typeof world>

// One context measurement, then a second of clock so the handoff the crossing scheduled (from a timer) runs.
async function measure($: any, w: World, percent: number) {
  await $.session.measure({
    context: { window: 1_000_000, tokens: percent * 10_000, percent },
    rateLimits: [],
    changed: ['context'],
  })
  await w.clock.advance(1000)
}

const handoffFiles = (w: World) => w.written.filter(p => /\\handoff-[^\\]+\.md$/.test(p))
const compactToasts = (w: World) => w.toasts.filter(t => /Consider \/compact/.test(t))
const textOf = (w: World, path: string) => w.files.get(key(path))?.text ?? ''
const latestPointer = (w: World) => textOf(w, `${ROOT}\\LATEST.md`).split('\n')[0]
const baseName = (p: string) => p.slice(p.lastIndexOf('\\') + 1)

test('crossing 50 then 70: two handoffs (LATEST.md follows the second) and one /compact suggestion', async ($, on) => {
  const w = world(on)
  await begin($)
  await measure($, w, 40)
  expect(w.forkCount).toBe(0)
  await measure($, w, 55)
  expect(w.forkCount).toBe(1)
  expect(compactToasts(w)).toHaveLength(0) // the first crossing only writes a handoff
  const first = handoffFiles(w)[0] ?? ''
  expect(latestPointer(w)).toBe(baseName(first))
  expect(textOf(w, first)).toContain('Trigger: context at 55%, threshold 50%')

  await measure($, w, 75)
  expect(w.forkCount).toBe(2)
  const files = handoffFiles(w)
  expect(files).toHaveLength(2)
  const second = files[1] ?? ''
  expect(second).not.toBe(first)
  expect(files.every(p => p.startsWith(`${ROOT}\\`) && !p.slice(ROOT.length + 1).includes('\\'))).toBe(true)
  expect(textOf(w, second)).toContain('Trigger: context at 75%, second threshold 70%')
  expect(latestPointer(w)).toBe(baseName(second)) // LATEST.md now names the second handoff
  expect(compactToasts(w)).toEqual([compactText(75)])
  expect(w.submitted).toHaveLength(0) // a suggestion only: nothing is submitted for the person
})

test('one big jump over both thresholds: ONE handoff and the /compact suggestion', async ($, on) => {
  const w = world(on)
  await begin($)
  await measure($, w, 40)
  await measure($, w, 85)
  expect(w.forkCount).toBe(1)
  expect(handoffFiles(w)).toHaveLength(1)
  expect(textOf(w, handoffFiles(w)[0] ?? '')).toContain('Trigger: context at 85%, thresholds 50% and 70%')
  expect(compactToasts(w)).toEqual([compactText(85)])
  await measure($, w, 90) // still the same crossing
  expect(w.forkCount).toBe(1)
  expect(compactToasts(w)).toHaveLength(1)
})

test('the suggestion shows once per crossing, not on every measurement', async ($, on) => {
  const w = world(on)
  await begin($)
  await measure($, w, 55)
  for (const p of [71, 72, 73, 74, 80, 99]) await measure($, w, p)
  expect(w.forkCount).toBe(2)
  expect(compactToasts(w)).toHaveLength(1)
})

test('both triggers re-arm: the second below 70, both below 50 (a compaction)', async ($, on) => {
  const w = world(on)
  await begin($)
  await measure($, w, 55)
  await measure($, w, 75)
  expect([w.forkCount, compactToasts(w).length]).toEqual([2, 1])
  await measure($, w, 80)
  expect([w.forkCount, compactToasts(w).length]).toEqual([2, 1])
  await measure($, w, 60) // under 70, still over 50: the second is armed again, the first is not
  expect(w.forkCount).toBe(2)
  await measure($, w, 72)
  expect([w.forkCount, compactToasts(w).length]).toEqual([3, 2])
  expect(textOf(w, handoffFiles(w)[2] ?? '')).toContain('Trigger: context at 72%, second threshold 70%')
  await measure($, w, 30) // a compaction: both armed
  await measure($, w, 55)
  expect([w.forkCount, compactToasts(w).length]).toEqual([4, 2]) // the first trigger again, no suggestion
  await measure($, w, 71)
  expect([w.forkCount, compactToasts(w).length]).toEqual([5, 3])
})

test('secondThreshold 0 turns the second trigger off: first handoff only, no suggestion', { options: { secondThreshold: 0 } }, async ($, on) => {
  const w = world(on)
  await begin($)
  await measure($, w, 55)
  await measure($, w, 75)
  await measure($, w, 95)
  expect(w.forkCount).toBe(1)
  expect(compactToasts(w)).toHaveLength(0)
  const status = await lsk($, 'status')
  expect(status).toContain('Handoff threshold: first 50%. Second threshold: off')
})

test('a second threshold not above the first is ignored, and status says so', { options: { secondThreshold: 40 } }, async ($, on) => {
  const w = world(on)
  await begin($)
  const status = await lsk($, 'status')
  expect(status).toContain('Second threshold 40% is ignored: it must be above the first threshold (50%)')
  await measure($, w, 75) // a single handoff for the first trigger, no suggestion
  expect(w.forkCount).toBe(1)
  expect(compactToasts(w)).toHaveLength(0)
  expect(await lsk($, 'threshold 30')).toBe('Handoff threshold set to 30%.') // 40 is above 30 now
  expect(await lsk($, 'status')).toContain('Handoff thresholds: first 30%, second 40%')
})

test('raising the first threshold past the default 70 ignores the second, and the command says so', async ($, on) => {
  world(on)
  await begin($)
  const said = await lsk($, 'threshold 80')
  expect(said).toContain('Handoff threshold set to 80%. The second threshold (70%) is now ignored')
  expect(await lsk($, 'status')).toContain('Second threshold 70% is ignored: it must be above the first threshold (80%)')
})

test('/lsk second overrides the setting: a number, off, a value that is too low, and usage', async ($, on) => {
  const w = world(on)
  await begin($)
  expect(await lsk($, 'second')).toMatch(/^Usage is \/lsk second <1-99\|off>\. Handoff thresholds: first 50%, second 70%/)
  expect(await lsk($, 'second abc')).toMatch(/^Usage is \/lsk second/)
  expect(await lsk($, 'second 100')).toMatch(/^Usage is \/lsk second/)
  expect(await lsk($, 'second 80')).toMatch(/^Second threshold set to 80%\. At that fill a fresh handoff is saved and \/compact is suggested/)
  expect(await lsk($, 'status')).toContain('Handoff thresholds: first 50%, second 80%')
  await measure($, w, 55)
  await measure($, w, 75) // under the new second threshold
  expect([w.forkCount, compactToasts(w).length]).toEqual([1, 0])
  await measure($, w, 82)
  expect([w.forkCount, compactToasts(w).length]).toEqual([2, 1])
  expect(compactToasts(w)[0]).toBe(compactText(82))

  expect(await lsk($, 'second 40')).toMatch(/^Second threshold set to 40%, but it is ignored: it must be above the first threshold \(50%\)/)
  expect(await lsk($, 'status')).toContain('Second threshold 40% is ignored')
  expect(await lsk($, 'second off')).toBe('Second threshold is off: no second handoff and no /compact suggestion.')
  expect(await lsk($, 'status')).toContain('Second threshold: off')
  await measure($, w, 90)
  expect([w.forkCount, compactToasts(w).length]).toEqual([2, 1])

  expect(await lsk($, 'second 60')).toMatch(/^Second threshold set to 60%\./) // back on, armed again
  await measure($, w, 91)
  expect([w.forkCount, compactToasts(w).length]).toEqual([3, 2])
})

test('a stored /lsk second override beats the setting in a new session', { options: { secondThreshold: 90 } }, async ($, on) => {
  const w = world(on, { store: { settings: { secondThreshold: 0 } } })
  await begin($)
  expect(await lsk($, 'status')).toContain('Second threshold: off')
  await measure($, w, 95)
  expect([w.forkCount, compactToasts(w).length]).toEqual([1, 0])
})

test('status shows both thresholds and when the last handoff was written', async ($, on) => {
  world(on)
  await begin($)
  const before = await lsk($, 'status')
  expect(before).toContain('Handoff thresholds: first 50%, second 70% (the second also suggests /compact; it never runs it).')
  expect(before).toContain('No handoff written this session.')
  expect(before).toContain('second <n|off>')
  await lsk($, 'now')
  const after = await lsk($, 'status')
  expect(after).toMatch(/Last handoff: \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(just now\), /)
  expect(after).toContain('(/lsk now)')
})

test('no handoff and no suggestion for a trivial session', async ($, on) => {
  const w = world(on, { prompts: 1 })
  await begin($)
  for (const p of [55, 75, 90]) await measure($, w, p)
  expect(w.forkCount).toBe(0)
  expect(w.written).toHaveLength(0)
  expect(compactToasts(w)).toHaveLength(0)
  expect(w.toasts).toHaveLength(0)
})

test('with automatic handoffs off there is no handoff and no suggestion; switching on arms it again', async ($, on) => {
  const w = world(on)
  await begin($)
  await lsk($, 'off')
  await measure($, w, 75)
  expect(w.forkCount).toBe(0)
  expect(compactToasts(w)).toHaveLength(0)
  await lsk($, 'on')
  await measure($, w, 76)
  expect([w.forkCount, compactToasts(w).length]).toEqual([1, 1])
})

test('the second handoff falls back to the session folder like the first, and the suggestion still shows', async ($, on) => {
  const w = world(on, { store: { folders: { 'c:/work/my project': 'D:\\Gone' } } })
  await begin($)
  await measure($, w, 75)
  expect(handoffFiles(w).every(p => p.startsWith(`${ROOT}\\`))).toBe(true)
  expect(w.toasts.some(t => t.includes('D:\\Gone was not found, so the session folder was used.'))).toBe(true)
  expect(compactToasts(w)).toEqual([compactText(75)])
})

test('no folder to write to: no handoff, the folder toast, and no "handoff is saved" suggestion', async ($, on) => {
  const w = world(on, { dirs: [] })
  await begin($)
  await measure($, w, 75)
  expect(w.forkCount).toBe(0)
  expect(w.written).toHaveLength(0)
  expect(w.toasts.some(t => t.includes('Handoff not saved'))).toBe(true)
  expect(compactToasts(w)).toHaveLength(0)
})

test('a second crossing while the first handoff is still being written is not lost', async ($, on) => {
  const w = world(on)
  let release = () => {}
  w.hold = new Promise<void>(resolve => {
    release = resolve
  })
  await begin($)
  await measure($, w, 55) // the first handoff is now in flight (its fork is held)
  expect(w.forkCount).toBe(1)
  await measure($, w, 75) // skipped as busy (no double handoff), but the latch is given back
  expect(w.forkCount).toBe(1)
  expect(compactToasts(w)).toHaveLength(0)
  w.hold = undefined
  release()
  await w.clock.advance(1000)
  expect(handoffFiles(w)).toHaveLength(1) // the first one finished
  await measure($, w, 76) // the next measurement tries the second again
  expect(w.forkCount).toBe(2)
  expect(handoffFiles(w)).toHaveLength(2)
  expect(compactToasts(w)).toEqual([compactText(76)])
})

// ---- the band ------------------------------------------------------------------------------

async function band($: any, columns: number) {
  const ui = await $.ui.mount({
    plugin: 'long-session-kit',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: columns, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  const texts: string[] = []
  for (const el of await ui.findAll({ type: 'Text' })) texts.push(el.text)
  await ui.unmount()
  return texts.join('')
}

test('band: both thresholds in the text, "consider /compact" only past the second and only with room', async ($, on) => {
  const w = world(on)
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never) // Claude Code's own placeholder for the band
  await begin($)
  await measure($, w, 55)
  const mid = await band($, 100)
  expect(mid).toContain('handoff at 50% / 70%')
  expect(mid).not.toContain('/compact')
  await measure($, w, 75)
  const high = await band($, 100)
  expect(high).toContain('75%')
  expect(high).toContain('handoff at 50% / 70%')
  expect(high).toContain('consider /compact')
  expect(await band($, 75)).not.toContain('consider /compact') // no room: the note is dropped, the toast has said it
  await lsk($, 'second off')
  const off = await band($, 100)
  expect(off).toContain('handoff at 50%')
  expect(off).not.toContain('/ 70%')
  expect(off).not.toContain('consider /compact')
})

// ---- /lsk resume ---------------------------------------------------------------------------

const POINTER = 'handoff-2026-11-03-0900.md\nWhere it got to.\n'

test('/lsk resume finds a handoff at the top level of the session folder', async ($, on) => {
  const w = world(on, {
    files: { [`${ROOT}\\LATEST.md`]: POINTER, [`${ROOT}\\handoff-2026-11-03-0900.md`]: '# Handoff: My Project\n\nNext step: X' },
  })
  await begin($)
  expect(await lsk($, 'resume')).toBe(`Resuming from ${ROOT}\\handoff-2026-11-03-0900.md`)
  await w.clock.advance(1)
  expect(w.submitted).toHaveLength(1)
  expect(w.submitted[0]).toContain('Next step: X')
})

test('/lsk resume also finds one in the Documents folder 0.1.0 used, and takes the newest', async ($, on) => {
  const w = world(on, { files: { [`${DOCS}\\LATEST.md`]: POINTER, [`${DOCS}\\handoff-2026-11-03-0900.md`]: 'old one' } })
  await begin($)
  expect(await lsk($, 'resume')).toBe(`Resuming from ${DOCS}\\handoff-2026-11-03-0900.md`)
  await w.clock.advance(1)
  expect(w.submitted[0]).toContain('old one')
  // A newer handoff in the session folder wins.
  await lsk($, 'now')
  w.submitted.length = 0
  const said = await lsk($, 'resume')
  expect(said).toMatch(new RegExp(`^Resuming from ${ROOT.replace(/\\/g, '\\\\')}\\\\handoff-`))
})

test('/lsk resume with nothing saved says where it looked', async ($, on) => {
  world(on)
  await begin($)
  const said = await lsk($, 'resume')
  expect(said).toMatch(/^No handoff found\. Looked in: /)
  expect(said).toContain(ROOT)
  expect(said).toContain(DOCS)
})
