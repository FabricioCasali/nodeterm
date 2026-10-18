import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { IUnicodeVersionProvider, Terminal } from '@xterm/xterm'

/**
 * Put xterm on the SAME character-width table as everything else in the stack.
 *
 * xterm.js ships Unicode **6** widths and makes them the default, and nothing here ever changed
 * that. Everyone else the bytes pass through is on a modern table: tmux measures with utf8proc,
 * and the agent CLIs measure with `string-width`/`wcwidth` built from current Unicode. The two
 * disagree about a whole class of characters — every emoji, and the symbols that gained Emoji
 * Presentation along the way:
 *
 *      ⭐ U+2B50   👍 U+1F44D   😄 U+1F604   🎉 U+1F389      xterm V6: 1     tmux/CLI: 2
 *      日 U+65E5   中 U+4E2D                                 xterm V6: 2     tmux/CLI: 2
 *
 * That single disagreement is what the 2026-08-05 device round reported, from both ends at once:
 *
 *  - **Overlap** (GPU / DOM renderers). xterm advances ONE cell for an emoji whose ink is nearly
 *    two, and those renderers let ink overhang, so the glyph lands on top of whatever the next
 *    cell holds.
 *  - **A fragment** (shared renderer). The same one-cell advance, but glyphgrid clips every glyph
 *    to its own cell — deliberately, since ink in the gutter would ghost into a neighbour's mip —
 *    so the overflow is cut instead of overlapping. ⭐ arrived as a sliver.
 *
 * Same cause, two symptoms, and NEITHER is a renderer bug: a renderer cannot draw a two-cell
 * character correctly while the buffer insists it is one cell wide. The glyphgrid fix that draws a
 * wide character across both of its cells (`GlyphAtlas.glyphFor`'s `half`) is the other half of
 * this one — it is what makes the second cell this table grants actually get painted.
 *
 * THE DEEPER SYMPTOM IS COLUMN ACCOUNTING, not looks. tmux keeps its own screen model and repaints
 * xterm by ABSOLUTE cursor position, so when tmux believes an emoji spans columns 12–13 and xterm
 * believes it spans 12 alone, the two models are shifted against each other for the rest of the
 * line. A partial repaint then writes at coordinates that mean different things on the two sides,
 * which can leave a column blank or doubled well away from the emoji that caused it. That is a
 * live candidate for the "a letter goes missing mid-word" report of the same device round — a
 * defect the blank-cell probe in `glyphgrid/feed.ts` stayed SILENT on, which is exactly what it
 * would do if the buffer cell were genuinely empty rather than mis-drawn.
 *
 * WHAT TO WATCH, because this cuts both ways. Agreement is the goal, not the number 11: if a host's
 * tmux were built WITHOUT utf8proc it would use a width-1 table and this would introduce the same
 * mismatch in the opposite direction. Homebrew and Debian both build tmux with utf8proc, so the
 * realistic case is the one this fixes; a host that misaligns AFTER this change is the case to
 * report, and the fix there is that host's tmux, not a return to Unicode 6.
 *
 * Applies to every renderer, so it is loaded at terminal construction rather than anywhere near
 * glyphgrid. Failure is non-fatal by design: a terminal on the old table renders as it did
 * yesterday, which is far better than a terminal that does not open.
 */
/**
 * The version name of the Unicode 11 table plus one rule: an emoji VARIATION SELECTOR (U+FE0F)
 * widens a one-cell character to two. `➡️` `⚠️` `❤️` are a width-1 base + VS16; Unicode 11 keeps
 * them at 1, while the agent CLIs (`string-width` measures `'➡️'` as 2) and Windows ConPTY put them
 * at 2. MEASURED on Windows 11 (build 26300, node-pty's system ConPTY): `➡️ABC` then `CSI 3 G` `Z`
 * comes back as `➡️ZBC`, i.e. ConPTY holds the emoji in columns 1–2.
 *
 * On a Windows pane the bytes reach us as ConPTY's repaint, positioned on ConPTY's columns, so on
 * the old table every cell after such an emoji was one column left of where the app and ConPTY
 * believe it is. A full repaint is written sequentially and looks right; the partial repaints a TUI
 * makes when it scrolls write at absolute columns and left the line garbled ("u a nenhum
 * dosodois") until a resize forced a full repaint.
 *
 * Only for panes behind ConPTY (`wantsVs16WideWidths`): tmux's handling of VS16 depends on its version
 * and was not measured, and the rule above (agreement, not a number) applies.
 */
export const VS16_WIDE_VERSION = '11-vs16'

const VS16 = 0xfe0f
// xterm's packed char-properties value: (state << 3) | (width << 1) | shouldJoin.
const widthOf = (props: number): number => (props >> 1) & 3

function vs16WideProvider(base: IUnicodeVersionProvider): IUnicodeVersionProvider {
  return {
    version: VS16_WIDE_VERSION,
    wcwidth: (cp) => base.wcwidth(cp),
    charProperties: (cp, preceding) =>
      cp === VS16 && preceding !== 0 && widthOf(preceding) === 1
        ? (2 << 1) | 1 // join the preceding cell and widen it to two
        : base.charProperties(cp, preceding)
  }
}

export function activateUnicode11(term: Terminal): void {
  try {
    // The addon registers its provider and keeps no handle to it, so capture one through a stand-in.
    let base: IUnicodeVersionProvider | null = null
    new Unicode11Addon().activate({
      unicode: { register: (p: IUnicodeVersionProvider) => (base = p) }
    } as unknown as Terminal)
    if (base) term.unicode.register(vs16WideProvider(base))
  } catch (err) {
    console.warn('[terminal] could not register the VS16-wide width table', err)
  }
  try {
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
  } catch (err) {
    console.warn('[terminal] could not activate Unicode 11 widths; staying on xterm’s default', err)
  }
}

/** True for a pane whose output is ConPTY's repaint: a Windows core, and not a remote tmux. */
export function wantsVs16WideWidths(corePlatform: string | null, remoteTmux: boolean): boolean {
  return corePlatform === 'win32' && !remoteTmux
}

/** Switch a terminal between the plain Unicode 11 table and the VS16-wide one. Never throws. */
export function applyVs16Widths(term: Terminal, on: boolean): void {
  try {
    const want = on && term.unicode.versions.includes(VS16_WIDE_VERSION) ? VS16_WIDE_VERSION : '11'
    if (term.unicode.activeVersion !== want && term.unicode.versions.includes(want)) {
      term.unicode.activeVersion = want
    }
  } catch {
    // A terminal on the plain table renders as it did before.
  }
}
