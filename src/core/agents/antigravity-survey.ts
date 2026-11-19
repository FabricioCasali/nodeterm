/**
 * The Antigravity CLI (`agy`) feedback survey — "How's the CLI experience so far?" with
 * `[1] Good [2] Fine [3] Bad [0] Skip` — owns the keyboard and fires no hook, so the node still
 * reads idle while it is up. A message pasted into it is swallowed and its Enter answers the menu.
 *
 * Closed set: the survey heading AND its `[0] Skip` option, both near the bottom of the VISIBLE
 * screen. Anything else (chat, other agy menus) is not this dialog and the write goes as before.
 */

/** Rows from the bottom of the visible screen the survey is looked for in. */
const TAIL_LINES = 15
const HEADING = "How's the CLI experience so far?"
const SKIP_OPTION = /\[0\]\s*Skip\b/

/** PURE. Is agy's feedback survey on this visible-screen capture? '' (no capture) is never one. */
export function antigravitySurveyIn(screen: string): boolean {
  const tail = screen.split('\n').filter((l) => l.trim() !== '').slice(-TAIL_LINES)
  return tail.some((l) => l.includes(HEADING)) && tail.some((l) => SKIP_OPTION.test(l))
}
