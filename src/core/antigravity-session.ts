// Pure parsers for Antigravity's (`agy`) session JSONL (`~/.gemini/antigravity-cli/brain/<id>/
// .system_generated/logs/transcript_full.jsonl`).
//
// MEASURED against real `agy` 1.2.7 transcripts (Windows 11, 2026-10-14):
// - Every `PLANNER_RESPONSE` record carries `input_tokens: number`, optional
//   `cache_read_tokens: number`, and `output_tokens: number`.
// - The prompt context size on a step is `input_tokens + (cache_read_tokens ?? 0)`.
// - At turn 0 (`step_index: 0`), `USER_INPUT.content` includes
//   `<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to <Display Name>.`
//   and hook payloads also carry `modelName` (e.g. `gemini-4-argon-medium`).
//   `antigravityWindowFor` maps both spellings to the context window and returns `null` when
//   unknown.
import { antigravityParse, extractAntigravityModelSelection } from './context-link-render'
import { antigravityWindowFor } from './model-window'

export interface AntigravityTokens {
  usedTokens: number
  model: string | null
}

/** Hook-reported model per conversation. Bounded: the oldest entry goes first. */
const hookModels = new Map<string, string>()
const HOOK_MODELS_MAX = 512

/**
 * Record the model an Antigravity hook payload reported (`payload.modelName`) for ITS conversation.
 * Keyed by conversation on purpose: this used to be one global "last model", so a node showed
 * whatever model the most recent hook of ANY agy node had named (PAR-225).
 */
export function rememberAntigravityModel(
  model: string | null | undefined,
  conversationId: string | null | undefined
): void {
  const m = typeof model === 'string' ? model.trim() : ''
  const id = typeof conversationId === 'string' ? conversationId.trim() : ''
  if (!m || !id) return
  hookModels.delete(id)
  hookModels.set(id, m)
  if (hookModels.size > HOOK_MODELS_MAX) hookModels.delete(hookModels.keys().next().value as string)
}

/** The model the hooks of this conversation last named, or null — never another conversation's. */
export function antigravityModelFor(conversationId: string | null | undefined): string | null {
  return (typeof conversationId === 'string' && hookModels.get(conversationId)) || null
}

/** `ContextTail`'s parser for antigravity: the session's own hook-reported model wins. */
export function antigravitySessionContextParse(
  text: string | string[],
  conversationId?: string
): { used: number; window: number | null; model: string | null } | null {
  return antigravityContextParse(text, antigravityModelFor(conversationId))
}

export function resetAntigravityModelsForTests(): void {
  hookModels.clear()
}

/**
 * Scan an Antigravity transcript buffer for the last `PLANNER_RESPONSE` token usage and the latest
 * known model name (`fallbackModel` — the session's own hook-reported one — wins when provided,
 * else the transcript's `Model Selection`). Nothing known = null: no other session's model is
 * ever borrowed.
 */
export function pickAntigravityTokens(
  text: string | string[],
  fallbackModel?: string | null
): AntigravityTokens | null {
  const buf = Array.isArray(text) ? text.join('\n') : text
  let usedTokens: number | null = null
  let transcriptModel: string | null = null

  for (const rec of antigravityParse(buf).lines) {
    const rawRec = rec as Record<string, unknown>
    const inlineModel =
      typeof rawRec.modelName === 'string'
        ? rawRec.modelName.trim()
        : typeof rawRec.model === 'string'
          ? rawRec.model.trim()
          : ''
    if (inlineModel) transcriptModel = inlineModel

    if (rec.type === 'USER_INPUT') {
      const selected = extractAntigravityModelSelection(rec.content)
      if (selected) transcriptModel = selected
    } else if (rec.type === 'PLANNER_RESPONSE') {
      const input =
        typeof rec.input_tokens === 'number' && Number.isFinite(rec.input_tokens)
          ? rec.input_tokens
          : null
      const cached =
        typeof rec.cache_read_tokens === 'number' && Number.isFinite(rec.cache_read_tokens)
          ? rec.cache_read_tokens
          : 0
      if (input !== null && input >= 0 && cached >= 0 && input + cached > 0) {
        usedTokens = input + cached
      }
    }
  }

  if (usedTokens === null) return null
  const model = fallbackModel?.trim() || transcriptModel
  return { usedTokens, model: model || null }
}

/**
 * `ContextTail`'s `parse` callback for Antigravity transcripts (plus direct calculation when a
 * caller passes `fallbackModel`).
 */
export function antigravityContextParse(
  text: string | string[],
  fallbackModel?: string | null
): { used: number; window: number | null; model: string | null } | null {
  const tok = pickAntigravityTokens(text, fallbackModel)
  if (!tok) return null
  return {
    used: tok.usedTokens,
    window: antigravityWindowFor(tok.model),
    model: tok.model
  }
}
