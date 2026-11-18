import { readClaudeComposer, readClaudeDraft, readClaudeScreen } from './claude-screen'

export interface EnvelopeGuard {
  beforePaste(screen: string): boolean
  beforeSubmit(screen: string): boolean
}

export function claudeComposerEmpty(screen: string): boolean {
  return readClaudeScreen(screen).kind === 'prompt' && readClaudeComposer(screen) === 'empty'
}

export function claudeComposerMatches(screen: string, envelope: string): boolean {
  return readClaudeScreen(screen).kind === 'prompt' &&
    readClaudeDraft(screen) === envelope.replace(/\s/g, '')
}

export function envelopeGuardAllows(check: (screen: string) => boolean, screen: string | null): boolean {
  try { return screen !== null && check(screen) === true } catch { return false }
}
