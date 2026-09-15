import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WINDOWS_SESSION_HOST_EXECUTABLE } from '../core/session-host-launcher'

const require = createRequire(import.meta.url)
const stageSessionHostExecutable = require('../../scripts/stage-session-host-executable.cjs') as {
  (context: unknown, copy?: (...args: string[]) => Promise<void>): Promise<void>
  SESSION_HOST_EXECUTABLE: string
}

describe('Windows session-host packaging', () => {
  it('stages the executable name the runtime resolves', () => {
    expect(stageSessionHostExecutable.SESSION_HOST_EXECUTABLE).toBe(WINDOWS_SESSION_HOST_EXECUTABLE)
  })

  it('copies the packaged app executable to the launcher name', async () => {
    const appOutDir = await mkdtemp(path.join(tmpdir(), 'nodeterm-session-host-package-'))
    await writeFile(path.join(appOutDir, 'nodeterm.exe'), 'electron executable')

    await stageSessionHostExecutable({
      appOutDir,
      packager: { platform: { name: 'windows' }, appInfo: { productFilename: 'nodeterm' } }
    })

    expect(await readFile(path.join(appOutDir, WINDOWS_SESSION_HOST_EXECUTABLE), 'utf8')).toBe(
      'electron executable'
    )
  })

  it('does nothing for non-Windows packages', async () => {
    let copied = false
    await stageSessionHostExecutable(
      {
        appOutDir: '/bundle',
        packager: { platform: { name: 'linux' }, appInfo: { productFilename: 'nodeterm' } }
      },
      async () => {
        copied = true
      }
    )

    expect(copied).toBe(false)
  })
})
