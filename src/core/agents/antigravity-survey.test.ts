import { describe, expect, it } from 'vitest'
import { antigravitySurveyIn } from './antigravity-survey'

const STATUS = 'auto · Gemini 4 Hydrogen · medium'
const SURVEY = ["How's the CLI experience so far? Help us improve:", '[1] Good [2] Fine [3] Bad [0] Skip', STATUS].join('\n')

describe('antigravitySurveyIn', () => {
  it('reads the survey at the bottom of the visible screen', () => {
    expect(antigravitySurveyIn(['> earlier prompt', '  ok', '', SURVEY, ''].join('\n'))).toBe(true)
  })

  it('reads the options when drawn one per row', () => {
    const rows = ["How's the CLI experience so far?", '  [1] Good', '  [2] Fine', '  [3] Bad', '  [0] Skip', STATUS]
    expect(antigravitySurveyIn(rows.join('\n'))).toBe(true)
  })

  it('a normal chat screen is not the survey', () => {
    const chat = ['> Responda apenas: ok', '  ok', '─'.repeat(40), '>', '─'.repeat(40), `? for shortcuts${STATUS}`]
    expect(antigravitySurveyIn(chat.join('\n'))).toBe(false)
  })

  it('the heading alone, or the survey scrolled above the tail, is not the survey', () => {
    expect(antigravitySurveyIn(["How's the CLI experience so far?", STATUS].join('\n'))).toBe(false)
    const scrolled = [SURVEY, ...Array.from({ length: 20 }, (_, i) => `  line ${i}`)].join('\n')
    expect(antigravitySurveyIn(scrolled)).toBe(false)
  })

  it('an empty capture is not evidence of a dialog', () => {
    expect(antigravitySurveyIn('')).toBe(false)
  })
})
