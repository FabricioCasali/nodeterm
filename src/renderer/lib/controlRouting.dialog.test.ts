import { expect, it, vi } from 'vitest'
import { controlListingDialogs, controlListingText, storedNodeListing } from './controlRouting'

const trust = '─'.repeat(100) + '\n Accessing workspace:\n ~/project\n Yes, I trust this folder\n Enter to confirm · Esc to cancel'

it('shows current Claude folder trust without changing the status store', async () => {
  const nodes = [{ id: 'claude', agentId: 'claude' }, { id: 'codex', agentId: 'codex' }]
  const rows = storedNodeListing(nodes)
  const capture = vi.fn(async () => trust)
  const decorated = await controlListingDialogs(rows, nodes, capture)
  expect(controlListingText(decorated)).toContain('NEEDS YOU [dialog: folder-trust]')
  expect(rows[0].launchState).toBe('unconfirmed')
  expect(capture).toHaveBeenCalledExactlyOnceWith('claude')
})

it('does not turn unreadable capture, ordinary text, or onboarding into a trust dialog', async () => {
  const nodes = [{ id: 'claude', agentId: 'claude' }]
  const rows = storedNodeListing(nodes)
  for (const capture of [async () => { throw new Error('unavailable') }, async () => 'Yes, I trust this folder', async () => 'Choose how to log in']) {
    expect(await controlListingDialogs(rows, nodes, capture)).toEqual(rows)
  }
})
