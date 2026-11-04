import { expect, mock, test } from 'claude-code/testing'

import {
  cleanPath,
  decideIdle,
  isAbsolutePath,
  joinPath,
  projectName,
  readCfg,
  samePath,
  splitCommand,
  splitReply,
  statusText,
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
  on('model.fork', () => {
    w.forkCount++
    return { value: { isAnswered: true, text: 'LATEST: Summary.\n\n## What was done\nx', usage: {} } }
  })
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
