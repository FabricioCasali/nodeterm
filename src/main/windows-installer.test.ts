import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WINDOWS_SESSION_HOST_EXECUTABLE } from '../core/session-host-launcher'

const root = path.resolve(__dirname, '../..')
const installer = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

describe('Windows installer session boundary', () => {
  it('loads the custom NSIS include', () => {
    expect(pkg.build.nsis.include).toBe('build/installer.nsh')
  })

  it('uses the same sidecar name as the runtime launcher', () => {
    expect(installer).toContain(
      `!define SESSION_HOST_EXECUTABLE_FILENAME "${WINDOWS_SESSION_HOST_EXECUTABLE}"`
    )
  })

  it('kills the sidecar tree only after the app update confirmation', () => {
    const confirmation = installer.indexOf('MessageBox MB_OKCANCEL')
    const sidecarKill = installer.indexOf(
      'taskkill.exe" /T /F /IM "${SESSION_HOST_EXECUTABLE_FILENAME}'
    )
    expect(confirmation).toBeGreaterThan(-1)
    expect(sidecarKill).toBeGreaterThan(confirmation)
  })

  it('expands the current-user filter through cmd for per-user installs', () => {
    expect(installer).toContain(
      '`"$CmdPath" /C taskkill /T /F /IM "${SESSION_HOST_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`'
    )
  })

  it('aborts instead of overwriting a host it could not stop', () => {
    expect(installer).toContain('installation aborted')
    expect(installer).toContain('SetErrorLevel 1')
    expect(installer).toMatch(/SetErrorLevel 1\s+Quit/)
  })
})
