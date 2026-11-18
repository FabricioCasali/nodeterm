// Background index of all Claude session transcripts under ~/.claude/projects AND every managed
// LOCAL account's {userData}/claude-accounts/<id>/projects. Built on launch + refreshed every 5
// min, incrementally by mtime, and persisted to userData so a relaunch doesn't cold re-scan.
// Search runs in-memory over the index. Read-only and local.
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { platform } from './platform'
import type { ClaudeAccount } from '../shared/types'
import { accountConfigDir, normalizeLinkedConfigDir } from './claude-accounts-core'
import { SESSION_ID_RE } from './transcript-reader'
import { sweepStaleTempFiles, writeFileAtomic } from './fs-atomic'
import {
  extractEntryFields,
  planRefresh,
  searchEntries,
  type ScanFile,
  type TranscriptIndexEntry,
  type TranscriptHit
} from './transcript-index-core'

export const TRANSCRIPT_INDEX_REFRESH_MS = 5 * 60 * 1000
const READ_CAP_BYTES = 5 * 1024 * 1024 // mirror transcript-reader: never read more than the tail

let entries: TranscriptIndexEntry[] = []
// Transcript paths whose shard on disk differs from memory (write it, or delete it if the entry is
// gone). A key leaves only when its write/delete landed, so a failed one is retried next refresh.
let pending = new Set<string>()
// The first refresh waits for the shards to load; an empty index would cold re-read every file.
let loaded: Promise<void> = Promise.resolve()
let timer: NodeJS.Timeout | undefined
let accountsGetter: (() => ClaudeAccount[]) | undefined

/** The single-file index this module wrote before shards; migrated once, then deleted. */
function legacyIndexFilePath(): string {
  return path.join(platform().userDataDir, 'transcript-index.json')
}

function indexDirPath(): string {
  return path.join(platform().userDataDir, 'transcript-index')
}

export function shardFileName(transcriptPath: string): string {
  return `${createHash('sha1').update(transcriptPath).digest('hex')}.json`
}

// Every LOCAL transcript root to index: the system default plus each managed LOCAL account's
// projects dir. Remote accounts (a `host` set) live on another host's fs → not scanned here.
function projectsRoots(): string[] {
  return accountRoots().map((r) => r.root)
}

function accountRoots(): Array<{ root: string; accountId?: string }> {
  const roots: Array<{ root: string; accountId?: string }> = [
    { root: path.join(os.homedir(), '.claude', 'projects') }
  ]
  const userData = platform().userDataDir
  for (const acct of accountsGetter?.() ?? []) {
    if (acct.host || acct.pending) continue
    try {
      // A LINKED account indexes the user's OWN dir. Re-validated here rather than
      // trusted — settings.json is hand-editable — and an unusable value falls back to the managed
      // path, which simply contributes an absent root.
      const dir = normalizeLinkedConfigDir(acct.configDir) ?? accountConfigDir(userData, acct.id)
      roots.push({ root: path.join(dir, 'projects'), accountId: acct.id })
    } catch {
      /* invalid account id → skip that root (fail-open) */
    }
  }
  return roots
}

// Walk each root's <projectDir>/<sessionId>.jsonl, returning {sessionId, path, mtime}. Fail-open
// per root (a missing/unreadable account dir just contributes nothing).
async function scanTranscripts(): Promise<ScanFile[]> {
  const out: ScanFile[] = []
  for (const root of projectsRoots()) {
    let dirs: string[]
    try {
      dirs = await fs.promises.readdir(root)
    } catch {
      continue
    }
    for (const d of dirs) {
      let files: string[]
      try {
        files = await fs.promises.readdir(path.join(root, d))
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue
        const sessionId = f.slice(0, -'.jsonl'.length)
        if (!SESSION_ID_RE.test(sessionId)) continue
        const p = path.join(root, d, f)
        try {
          const st = await fs.promises.stat(p)
          out.push({ sessionId, transcriptPath: p, mtime: Math.floor(st.mtimeMs) })
        } catch {
          /* skip */
        }
      }
    }
  }
  return out
}

async function readTail(filePath: string): Promise<string> {
  try {
    const st = await fs.promises.stat(filePath)
    if (st.size > READ_CAP_BYTES) {
      const fd = await fs.promises.open(filePath, 'r')
      try {
        const { buffer } = await fd.read({
          position: st.size - READ_CAP_BYTES,
          length: READ_CAP_BYTES,
          buffer: Buffer.alloc(READ_CAP_BYTES)
        })
        const s = buffer.toString('utf8')
        const nl = s.indexOf('\n')
        return nl >= 0 ? s.slice(nl + 1) : s
      } finally {
        await fd.close()
      }
    }
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

/** Read the legacy single-file index. Anything unreadable is an empty index. */
export function loadPersistedIndex(file: string): TranscriptIndexEntry[] {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? (data as TranscriptIndexEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Read every shard in `dir`. A missing dir, a non-`.json` name (an orphaned temp) or an unreadable
 * shard contributes nothing: the next refresh re-reads that transcript.
 */
export async function loadShards(dir: string): Promise<TranscriptIndexEntry[]> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const out: TranscriptIndexEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const e = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'))
      if (e && typeof e.transcriptPath === 'string' && typeof e.sessionId === 'string') out.push(e)
    } catch {
      /* skip */
    }
  }
  return out
}

/**
 * Write the shard of each key present in `index` and delete the shard of each key absent from it.
 * Resolves to the keys whose write/delete did not land (never throws).
 *
 * One file per transcript so a refresh rewrites only what changed: the whole index stringified at
 * once was ~45 MB of synchronous work on the main thread. Each shard goes through temp + rename
 * (a reader sees the old shard or the new one) at 0600, because it holds transcript text.
 */
export async function persistShards(
  dir: string,
  index: TranscriptIndexEntry[],
  keys: Iterable<string>
): Promise<Set<string>> {
  const byPath = new Map(index.map((e) => [e.transcriptPath, e]))
  const failed = new Set<string>()
  try {
    await fs.promises.mkdir(dir, { recursive: true })
  } catch {
    return new Set(keys)
  }
  for (const key of keys) {
    const file = path.join(dir, shardFileName(key))
    const e = byPath.get(key)
    try {
      if (e) await writeFileAtomic(file, JSON.stringify(e), { mode: 0o600 })
      else await fs.promises.rm(file, { force: true })
    } catch {
      failed.add(key)
    }
  }
  return failed
}

async function loadIndex(): Promise<void> {
  const dir = indexDirPath()
  const legacy = legacyIndexFilePath()
  if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
    entries = loadPersistedIndex(legacy)
    pending = await persistShards(dir, entries, entries.map((e) => e.transcriptPath))
    await fs.promises.rm(legacy, { force: true }).catch(() => {})
    return
  }
  entries = await loadShards(dir)
}

// One refresh at a time. A cold scan of a large tree can outlast the interval, and two overlapping
// runs would race their persists (and the `pending` set) as well as reading every file twice.
let refreshing: Promise<void> | undefined
/** Rescan and persist if owed — what launch and the 5-minute timer run. A call while a refresh is
 *  in flight joins it rather than starting a second scan. */
export function refreshTranscriptIndex(): Promise<void> {
  refreshing ??= refreshOnce().finally(() => {
    refreshing = undefined
  })
  return refreshing
}

async function refreshOnce(): Promise<void> {
  await loaded
  const scan = await scanTranscripts()
  const { toRead, keep } = planRefresh(entries, scan)
  const fresh: TranscriptIndexEntry[] = [...keep]
  for (const f of toRead) {
    const text = await readTail(f.transcriptPath)
    const { cwd, title, text: body } = extractEntryFields(text)
    fresh.push({
      sessionId: f.sessionId,
      transcriptPath: f.transcriptPath,
      cwd,
      mtime: f.mtime,
      title,
      text: body
    })
  }
  // Owed shards: every re-read entry, and every prior entry the scan dropped.
  const keptPaths = new Set(keep.map((e) => e.transcriptPath))
  for (const f of toRead) pending.add(f.transcriptPath)
  for (const e of entries) if (!keptPaths.has(e.transcriptPath)) pending.add(e.transcriptPath)
  entries = fresh
  if (pending.size) pending = await persistShards(indexDirPath(), entries, pending)
}

export function searchTranscripts(query: string): TranscriptHit[] {
  const roots = accountRoots()
  return searchEntries(entries, query, undefined, (p) =>
    roots.find((r) => p.startsWith(r.root + path.sep))?.accountId
  )
}

export function initTranscriptIndex(getAccounts?: () => ClaudeAccount[]): void {
  accountsGetter = getAccounts
  loaded = loadIndex().catch(() => {})
  // Collect the legacy ownerless `<file>.tmp` shape once it is a day old. A pid-bearing temp left by
  // a crash inside writeFileAtomic is deliberately NOT collected (fs-atomic cannot prove its writer
  // dead across PID namespaces), so such an orphan stays until removed by hand.
  void sweepStaleTempFiles(legacyIndexFilePath())
  void refreshTranscriptIndex()
  timer = setInterval(() => void refreshTranscriptIndex(), TRANSCRIPT_INDEX_REFRESH_MS)
  if (timer.unref) timer.unref()
}
