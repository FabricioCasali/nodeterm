// Persistence of the transcript index. The path-explicit helpers are exercised directly; the
// refresh loop runs against a LINKED account's config dir in a temp dir. Its other root,
// `~/.claude/projects`, is the run's private home (test/setup/home-sandbox.ts), never the real one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { fakePlatform } from './platform-fake'
import { loadPersistedIndex, loadShards, persistShards, shardFileName } from './transcript-index'
import type { TranscriptIndexEntry } from './transcript-index-core'

const entry = (id: string, text: string): TranscriptIndexEntry => ({
  sessionId: id,
  transcriptPath: `/p/${id}.jsonl`,
  cwd: '/c',
  mtime: 1,
  title: id,
  text
})
const keys = (index: TranscriptIndexEntry[]): string[] => index.map((e) => e.transcriptPath)
const byId = (a: TranscriptIndexEntry, b: TranscriptIndexEntry): number => a.sessionId.localeCompare(b.sessionId)

function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code })
}

let dir: string
let shards: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nt-transcript-index-'))
  shards = join(dir, 'transcript-index')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('persistShards / loadShards', () => {
  it('round-trips, one file per entry', async () => {
    const index = [entry('a', 'alpha'), entry('b', 'beta')]
    expect(await persistShards(shards, index, keys(index))).toEqual(new Set())
    expect((await readdir(shards)).sort()).toEqual(keys(index).map(shardFileName).sort())
    expect((await loadShards(shards)).sort(byId)).toEqual(index)
  })

  it('a key absent from the index deletes its shard', async () => {
    const index = [entry('a', 'alpha'), entry('b', 'beta')]
    await persistShards(shards, index, keys(index))
    expect(await persistShards(shards, [index[0]], ['/p/b.jsonl'])).toEqual(new Set())
    expect(await loadShards(shards)).toEqual([index[0]])
  })

  it('a failure between the temp write and the rename leaves the old shard intact and the key owed', async () => {
    const old = [entry('a', 'old text')]
    await persistShards(shards, old, keys(old))
    vi.spyOn(fs, 'rename').mockRejectedValue(errWithCode('EIO'))
    expect(await persistShards(shards, [entry('a', 'new text')], ['/p/a.jsonl'])).toEqual(new Set(['/p/a.jsonl']))
    expect(await loadShards(shards)).toEqual(old)
    // writeFileAtomic removes its own temp on a failure it survives.
    expect((await readdir(shards)).filter((f) => !f.endsWith('.json'))).toEqual([])
  })

  it('loading ignores a missing dir, a non-.json name (orphaned temp) and an unreadable shard', async () => {
    expect(await loadShards(shards)).toEqual([])
    await persistShards(shards, [entry('a', 'alpha')], ['/p/a.jsonl'])
    await writeFile(join(shards, 'x.json.123.tmp'), JSON.stringify(entry('t', 'temp')))
    await writeFile(join(shards, 'broken.json'), '{"sessionId":"a","tran')
    expect(await loadShards(shards)).toEqual([entry('a', 'alpha')])
  })

  it.skipIf(process.platform === 'win32')(
    'writes each shard 0600 — it holds transcript text (POSIX mode bits; Windows has none to check)',
    async () => {
      await persistShards(shards, [entry('a', 'x')], ['/p/a.jsonl'])
      expect((await stat(join(shards, shardFileName('/p/a.jsonl')))).mode & 0o777).toBe(0o600)
    }
  )
})

describe('loadPersistedIndex (legacy file)', () => {
  it('reads missing, truncated or non-array files as an empty index', async () => {
    const file = join(dir, 'transcript-index.json')
    expect(loadPersistedIndex(file)).toEqual([])
    await writeFile(file, '[{"sessionId":"a","tran')
    expect(loadPersistedIndex(file)).toEqual([])
    await writeFile(file, '{"not":"an array"}')
    expect(loadPersistedIndex(file)).toEqual([])
  })
})

describe('the refresh loop', () => {
  const sid = (n: number): string => `0123abcd-0000-4000-8000-${String(n).padStart(12, '0')}`
  let cfg: string
  let proj: string
  let shardDir: string
  let legacyFile: string
  let mod: typeof import('./transcript-index')
  let core: typeof import('./platform')

  /** Shard temps written: one per shard write attempt, landed or not. */
  let shardWrites: string[]
  /** Transcript files read in full (readTail's small-file path). */
  let transcriptReads: string[]
  beforeEach(async () => {
    vi.resetModules() // fresh module state: entries, pending, the in-flight refresh
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) // the 5-minute timer stays inert
    const platform = fakePlatform()
    core = await import('./platform') // the instance the freshly imported index module will read
    core.initPlatform(platform)
    shardDir = join(platform.userDataDir, 'transcript-index')
    legacyFile = join(platform.userDataDir, 'transcript-index.json')
    cfg = join(dir, 'claude-cfg')
    proj = join(cfg, 'projects', '-proj')
    await fs.mkdir(proj, { recursive: true })
    shardWrites = []
    transcriptReads = []
    const realWriteFile = fs.writeFile.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation((async (target: string, ...rest: unknown[]) => {
      if (String(target).startsWith(shardDir)) shardWrites.push(String(target))
      return (realWriteFile as (...a: unknown[]) => Promise<void>)(target, ...rest)
    }) as unknown as typeof fs.writeFile)
    const realReadFile = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementation((async (target: string, ...rest: unknown[]) => {
      if (String(target).endsWith('.jsonl')) transcriptReads.push(String(target))
      return (realReadFile as (...a: unknown[]) => Promise<unknown>)(target, ...rest)
    }) as unknown as typeof fs.readFile)
    mod = await import('./transcript-index')
  })
  afterEach(() => {
    vi.useRealTimers()
    core.resetPlatformForTests()
  })
  const accounts = () => [{ id: 'linked1', label: 'L', createdAt: 1, configDir: cfg }]
  const transcript = (n: number): string => join(proj, `${sid(n)}.jsonl`)
  async function makeTranscripts(count: number): Promise<void> {
    for (let n = 0; n < count; n++) {
      await writeFile(transcript(n), `{"type":"user","cwd":"/c","message":{"content":"t${n}"}}\n`)
    }
  }
  const shardMtime = async (n: number): Promise<number> =>
    (await stat(join(shardDir, shardFileName(transcript(n))))).mtimeMs

  it('a refresh that changed nothing writes no shard', async () => {
    await makeTranscripts(1)
    mod.initTranscriptIndex(accounts)
    await mod.refreshTranscriptIndex()
    expect(shardWrites).toHaveLength(1)
    await mod.refreshTranscriptIndex()
    await mod.refreshTranscriptIndex()
    expect(shardWrites).toHaveLength(1)
  })

  it('250 entries: one changed transcript rewrites one shard, a removed one deletes its shard', async () => {
    await makeTranscripts(250)
    mod.initTranscriptIndex(accounts)
    await mod.refreshTranscriptIndex()
    expect(shardWrites).toHaveLength(250)
    const before = await Promise.all([0, 1, 2, 249].map(shardMtime))
    shardWrites = []

    const later = new Date(Date.now() + 60_000)
    await utimes(transcript(1), later, later)
    await mod.refreshTranscriptIndex()
    expect(shardWrites).toHaveLength(1)
    expect(shardWrites[0]).toContain(shardFileName(transcript(1)))
    expect(await shardMtime(0)).toBe(before[0])
    expect(await shardMtime(249)).toBe(before[3])

    await rm(transcript(2))
    await mod.refreshTranscriptIndex()
    const files = await readdir(shardDir)
    expect(files).toHaveLength(249)
    expect(files).not.toContain(shardFileName(transcript(2)))

    const reloaded = await loadShards(shardDir)
    expect(reloaded.map((e) => e.sessionId).sort()).toEqual(
      Array.from({ length: 250 }, (_, n) => sid(n)).filter((s) => s !== sid(2))
    )
    expect(reloaded.find((e) => e.sessionId === sid(1))?.mtime).toBe(Math.floor((await stat(transcript(1))).mtimeMs))
  })

  it('a shard write that failed stays owed and is written on the next refresh, then not again', async () => {
    await makeTranscripts(2)
    const target = join(shardDir, shardFileName(transcript(0)))
    let failNext = true
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation((async (from: string, to: string) => {
      if (failNext && String(to) === target) {
        failNext = false
        throw errWithCode('EIO')
      }
      return realRename(from, to)
    }) as unknown as typeof fs.rename)
    mod.initTranscriptIndex(accounts)
    await mod.refreshTranscriptIndex()
    expect(shardWrites).toHaveLength(2)
    expect((await loadShards(shardDir)).map((e) => e.sessionId)).toEqual([sid(1)])
    // Nothing on disk changed, but the shard that is missing is still owed.
    await mod.refreshTranscriptIndex()
    expect(shardWrites).toHaveLength(3)
    expect((await loadShards(shardDir)).map((e) => e.sessionId).sort()).toEqual([sid(0), sid(1)])
    await mod.refreshTranscriptIndex()
    expect(shardWrites).toHaveLength(3)
  })

  it('migrates the legacy file: loads N, writes N shards, deletes it, and re-reads no unchanged transcript', async () => {
    const N = 5
    await makeTranscripts(N)
    const legacy: TranscriptIndexEntry[] = []
    for (let n = 0; n < N; n++) {
      legacy.push({
        sessionId: sid(n),
        transcriptPath: transcript(n),
        cwd: '/c',
        mtime: Math.floor((await stat(transcript(n))).mtimeMs),
        title: `legacy ${n}`,
        text: `legacy text ${n}`
      })
    }
    await writeFile(legacyFile, JSON.stringify(legacy))
    mod.initTranscriptIndex(accounts) // the launch refresh starts at once; it must wait for the load
    await mod.refreshTranscriptIndex()
    expect(transcriptReads).toEqual([])
    expect(shardWrites).toHaveLength(N)
    await expect(stat(legacyFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await loadShards(shardDir)).sort(byId)).toEqual(legacy)
    expect(mod.searchTranscripts('legacy text 3').map((h) => h.sessionId)).toEqual([sid(3)])
  })

  it('a refresh asked for while one is running joins it instead of scanning again', async () => {
    await makeTranscripts(1)
    const root = join(cfg, 'projects')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const realReaddir = fs.readdir.bind(fs)
    let rootScans = 0
    vi.spyOn(fs, 'readdir').mockImplementation((async (p: string, ...rest: unknown[]) => {
      if (String(p) === root) {
        rootScans++
        await gate
      }
      return (realReaddir as (...a: unknown[]) => Promise<unknown>)(p, ...rest)
    }) as unknown as typeof fs.readdir)
    mod.initTranscriptIndex(accounts) // starts the launch refresh, held at the linked root
    await vi.waitFor(() => expect(rootScans).toBe(1))
    const a = mod.refreshTranscriptIndex()
    const b = mod.refreshTranscriptIndex()
    vi.advanceTimersByTime(5 * 60 * 1000) // the interval firing mid-scan joins it too
    release()
    await Promise.all([a, b])
    expect(rootScans).toBe(1)
    expect(shardWrites).toHaveLength(1)
  })
})
