// PAR-161: armed nodes in a project that is not on screen start through the #925 headless start,
// and through nothing else. Pinned at source level because the effect closes over Canvas's refs.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')

function cascadeBlock(): string {
  const start = SRC.indexOf('// ---- PAR-161: armed nodes in projects that are NOT on screen ----')
  expect(start).toBeGreaterThan(-1)
  const end = SRC.indexOf('\n  }, [bgCascade,', start)
  expect(end).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('background cascade wiring', () => {
  it('starts what is ready only through the existing headless start', () => {
    const block = cascadeBlock()
    expect(block).toContain('backgroundLaunches(')
    expect(block).toContain('startNodesHeadlessRef.current(b.project, b.nodes)')
    // Never another way of starting a node, and never a tab switch.
    for (const banned of ['launchCommand(', 'launchHeadless(', 'setActiveProject', 'travelToProject', 'switchProject', 'reopenProject'])
      expect(block).not.toContain(banned)
  })

  it('is desktop only and skips what another starter owns', () => {
    const block = cascadeBlock()
    expect(block).toContain("isBrowserRuntime() ? ''")
    expect(block).toContain('headlessInFlightRef.current.has(id)')
    expect(block).toContain('launchInFlight.current.has(id)')
    expect(block).toContain('bgDeclinedRef.current.has(id)')
  })

  it('re-evaluates on the waited-on stations, not the whole status map', () => {
    expect(SRC).toContain('}, [bgCascade, bgStatusSig, bgHandoverSig, bgSuccessSig, bgSetupSig, setupDoneForGroup])')
    expect(cascadeBlock()).not.toMatch(/useAgentStatus\(\(s\) => s\.byId\)/)
  })

  it('the canvas loop skips a node a headless start owns', () => {
    expect(SRC).toContain('!launchInFlight.current.has(f.id) && !headlessInFlightRef.current.has(f.id)')
  })
})
