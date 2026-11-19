import { describe, expect, it, vi } from 'vitest'
import { SessionHostSocketRequestQueue, usesSessionLane } from './socket-request-queue'

describe('session-host lane membership (PAR-241)', () => {
  it('keeps the pane probes out of the session lane, so input never waits behind PowerShell', () => {
    expect(usesSessionLane('paneCommand')).toBe(false)
    expect(usesSessionLane('messageOwnerV1')).toBe(false)
  })

  it('keeps every state-changing command ordered', () => {
    for (const cmd of [
      'attach', 'attachExisting', 'detach', 'write', 'resize', 'pause', 'resume', 'sendKeys',
      'sendKeysV2', 'messageEnvelopeV1', 'messagePasteReadyV1', 'terminateOwnerV1',
      'writeDetachedV1', 'executeLaunch', 'killSession', 'capture'
    ]) {
      expect(usesSessionLane(cmd), cmd).toBe(true)
    }
  })
})

describe('session-host per-socket request ordering', () => {
  it('does not let a same-name detach overtake a delayed attach', async () => {
    const queue = new SessionHostSocketRequestQueue()
    const order: string[] = []
    let releaseAttach!: () => void
    const attach = queue.enqueue(
      'same-name',
      () =>
        new Promise<void>((resolve) => {
          order.push('attach-start')
          releaseAttach = () => {
            order.push('attach-finish')
            resolve()
          }
        })
    )
    const detachTask = vi.fn(async () => {
      order.push('detach')
    })
    const detach = queue.enqueue('same-name', detachTask)

    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['attach-start'])
    expect(detachTask).not.toHaveBeenCalled()
    releaseAttach()
    await Promise.all([attach, detach])
    expect(order).toEqual(['attach-start', 'attach-finish', 'detach'])
  })

  it('keeps different session names concurrent', async () => {
    const queue = new SessionHostSocketRequestQueue()
    let releaseFirst!: () => void
    const first = queue.enqueue(
      'first',
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
    )
    const second = vi.fn(async () => {})

    await queue.enqueue('second', second)
    expect(second).toHaveBeenCalledOnce()
    releaseFirst()
    await first
  })
})
