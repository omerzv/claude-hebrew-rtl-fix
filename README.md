# Claude.ai Hebrew Bidi Fixer

A Manifest V3 browser extension (Chrome + Firefox) that fixes Hebrew–English
bidirectional text rendering in Claude.ai assistant messages. Fully
client-side — **zero network requests, zero dependencies, zero data
collection**.

## The problem

Claude.ai renders all message content with an LTR base direction. Under the
[Unicode Bidirectional Algorithm](https://www.unicode.org/reports/tr9/) a
paragraph's *base direction* decides where neutral characters (punctuation,
digits, spaces) attach and how text aligns. A Hebrew paragraph rendered with
an LTR base direction gets left-aligned text, periods jumping to the wrong
end of sentences, and embedded English/numeric tokens (`C++`, `GPT-4`)
scrambled.

## How the fix works

Two layers, both implemented in `bidi_processor.js` (pure, testable logic):

1. **Block base direction** — for every text-bearing block (`p`, `li`,
   `h1`–`h6`, `td`, `th`, `blockquote`) inside an assistant message, count
   strong-directional characters (Hebrew range `U+0590–U+05FF` + presentation
   forms vs. Latin letters) and set `dir="rtl"` or `dir="ltr"` explicitly.
   Counting beats the browser's `dir="auto"` first-strong heuristic: a Hebrew
   paragraph that *starts* with an English word ("API זה ראשי תיבות…") would
   be misdetected by first-strong, but counting gets it right.

2. **Inline isolation with `<bdi>`** — runs of the minority script inside a
   block are wrapped in `<bdi>` (a *directional isolate*, ≈ `span dir="auto"`
   with `unicode-bidi: isolate`). This stops neutral characters around the
   run from being reordered by the outer base direction. Word-attached
   trailing symbols are absorbed into the isolate so tokens like `v2`,
   `C++`, `GPT-4`, `utf-8` stay intact. (`<bdo>` — a directional *override*
   that reverses character order — is deliberately not used; it's for
   displaying text against its natural order, not for fixing it.)

`<code>` / `<pre>` blocks are never touched and are additionally pinned to
`direction: ltr` in CSS — code is always LTR.

### Why not an off-the-shelf library?

- `rtl-detect` detects direction from *locale names*, not text content.
- `bidi-js` implements the full UBA — overkill when the browser already runs
  the UBA; we only need strong-character classification (~10 lines of regex).
- Existing extensions (Smart-RTL-Fixer, Now2ai-RTL-Fixer) are whole products,
  not embeddable libraries, and rely on blanket `dir="auto"` which mishandles
  the first-strong edge case above.

## Architecture

| File                | Role                                                            |
| ------------------- | --------------------------------------------------------------- |
| `manifest.json`     | MV3 manifest; content script on `https://claude.ai/*` only      |
| `bidi_processor.js` | Pure detection/segmentation/wrapping logic (Node-testable)      |
| `content_script.js` | MutationObserver orchestration, streaming handling, composer direction, toggle UI |
| `styles.css`        | Toggle button, RTL alignment, code-block, and composer CSS      |
| `test_bidi.js`      | Unit tests for the pure logic — `node test_bidi.js`             |

### Resilience to Claude.ai DOM changes

Claude.ai is a React SPA with hashed, frequently-churning class names, so:

- Assistant messages are found via a **fallback chain** of selectors:
  `div[data-is-streaming]` (most stable across redesigns) →
  `.font-claude-response` → `.font-claude-message` → finally any rendered
  blocks under `<main>`. If one hook disappears, the next takes over.
- The observer watches `document.body` (subtree) instead of pinning a chat
  container node that React may replace on navigation (it's an SPA — the
  content script loads once per tab, not per conversation).
- All processing is **idempotent**: re-running over already-processed nodes
  is a no-op, so overlapping mutations are harmless.

### Streaming handling

While a message streams (`data-is-streaming="true"`), only the cheap
block-level `dir` pass runs — React tolerates added attributes. `<bdi>`
wrapping rewrites text nodes, which could fight React's reconciler
mid-render, so it runs once per block after streaming completes. Mutations
are debounced (200 ms) to ride out streaming churn, and mutations caused by
the extension itself are filtered out to prevent feedback loops.

### Safety constraints

- `textarea` and `input` elements are never touched. For `[contenteditable]`,
  only `dir`/`data-hbf-composer` attributes are set on the element itself;
  its content and children are never modified.
- The toggle button is parented on `<html>`, *outside* React's root, so
  reconciliation can never remove it and we never corrupt Claude's vdom.
- Only `storage` permission (persisting the toggle state); no host
  permissions beyond the claude.ai content-script match.

## Installing (developer mode)

### Chrome / Edge / Brave

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. Open [claude.ai](https://claude.ai) — Hebrew messages should now render RTL

### Firefox (115+)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` in this folder

(Temporary add-ons unload when Firefox restarts; for a permanent install the
extension must be signed or loaded in Firefox Developer Edition with
`xpinstall.signatures.required = false`.)

## Using

A round **א/A** button floats at the bottom-right of claude.ai. Click it to
toggle the fix on/off live — disabling unwraps every `<bdi>` and removes all
`dir` attributes, restoring the page exactly as it was. The state persists
across reloads via `chrome.storage.local`.

## Composer (input box) direction

As of v1.1 the fix also applies to text you type. The composer's direction
is decided by the same strong-character counting used for messages,
re-evaluated 150 ms after each input event (typing, paste, drag-drop), with
**hysteresis**: once a direction is established it only flips when the
other script's letter count exceeds the current one by 3 or more — so
alignment doesn't jitter while counts hover near 50/50. Only the `dir` and
`data-hbf-composer` attributes are set on the editor element; its content
is never modified. The א/A button governs this too: toggling off restores
native behavior.

### Manual test checklist

1. Type a Hebrew letter and pause briefly → the composer right-aligns
   within ~150 ms.
2. Keep typing a mostly-Hebrew sentence with an English word → stays RTL.
3. Delete down to English-majority gradually → no flicker at the
   crossover; flips to LTR only once the English letter count exceeds
   the Hebrew count by 3 or more.
4. Toggle the א/A button off → composer returns to native (LTR) behavior;
   on → corrects again on the next keystroke.
5. Messages still render as before (regression check).

## Testing the pure logic

```sh
node test_bidi.js
```

Covers dominant-direction detection (including the first-strong edge case),
minority-run segmentation (`C++`, `GPT-4`, `v2`, sentence punctuation), and
exact text reconstruction.
