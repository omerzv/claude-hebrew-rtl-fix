# Claude.ai Hebrew RTL Fix

[![Release](https://img.shields.io/github/v/release/omerzv/claude-hebrew-rtl-fix)](https://github.com/omerzv/claude-hebrew-rtl-fix/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

A tiny browser extension (Chrome + Firefox) that fixes broken Hebrew text on
[Claude.ai](https://claude.ai) — both in Claude's answers **and in the box
you type into**.

**🔒 Private by design:** zero network requests, zero dependencies, zero data
collection. ~600 lines of plain JavaScript you can read in ten minutes.

<div dir="rtl">

## 🇮🇱 בעברית

Claude.ai מציג עברית שבורה: טקסט מיושר לשמאל, נקודות שקופצות לצד הלא נכון,
ומונחים באנגלית כמו <code dir="ltr">C++</code> שמתהפכים באמצע משפט.
התוסף הזה מתקן את הכל — גם בתשובות של קלוד וגם בתיבת ההקלדה, כולל זיהוי
אוטומטי של כיוון תוך כדי הקלדה.

**התקנה:** הורידו את ה־ZIP מ־[Releases](https://github.com/omerzv/claude-hebrew-rtl-fix/releases/latest),
חלצו, פתחו <code dir="ltr">chrome://extensions</code>, הפעילו Developer mode
ולחצו Load unpacked. זהו — בלי הרשאות מיותרות, בלי שליחת מידע לשום מקום.

</div>

## What it fixes

| Without the extension | With it |
| --- | --- |
| Hebrew answers left-aligned | Right-aligned, like Hebrew should be |
| Periods/punctuation jump to the wrong end of sentences | Punctuation lands where it belongs |
| `C++`, `GPT-4`, English terms scrambled inside Hebrew text (`++C`) | Rendered intact via `<bdi>` isolation |
| List bullets/numbers stuck on the left of RTL lists | Bullets flip to the right |
| The input box stays LTR while you type Hebrew | Live direction detection as you type (v1.1) |
| Code blocks | Untouched — always LTR, as they should be |

## Install

### Chrome / Edge / Brave

1. Download the zip from the [latest release](https://github.com/omerzv/claude-hebrew-rtl-fix/releases/latest) and extract it (or `git clone` this repo)
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the extracted folder
5. Open [claude.ai](https://claude.ai) — done

### Firefox (115+)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and select `manifest.json`

(Temporary add-ons unload on restart; a signed permanent build is planned.)

## Using

- It just works — no setup. Hebrew messages render RTL automatically.
- A round **א/A** button floats at the bottom-right of claude.ai. Click to
  toggle the fix on/off live (no reload); the state persists.
- **Composer (v1.1):** the input box direction is decided by the same
  letter-counting used for messages, re-evaluated 150 ms after each input
  event, with **hysteresis** — once a direction is established it only flips
  when the other script's letter count leads by 3+, so alignment never
  jitters mid-sentence. Only `dir`/`data-hbf-composer` attributes are set;
  your text is never modified.

## How the detection works

Two layers, both implemented in `bidi_processor.js` (pure, testable logic):

1. **Block base direction** — for every text-bearing block (`p`, `li`,
   `h1`–`h6`, `td`, `th`, `blockquote`) inside an assistant message, count
   strong-directional characters (Hebrew range `U+0590–U+05FF` + presentation
   forms vs. Latin letters) and set `dir="rtl"` or `dir="ltr"` explicitly.
   Counting beats the browser's `dir="auto"` first-strong heuristic: a Hebrew
   paragraph that *starts* with an English word ("API זה ראשי תיבות…") would
   be misdetected by first-strong, but counting gets it right.

2. **Inline isolation with `<bdi>`** — runs of the minority script inside a
   block are wrapped in `<bdi>` (a *directional isolate*). This stops neutral
   characters around the run from being reordered by the outer base
   direction. Word-attached trailing symbols are absorbed into the isolate so
   tokens like `v2`, `C++`, `GPT-4`, `utf-8` stay intact.

`<code>` / `<pre>` blocks are never touched and are additionally pinned to
`direction: ltr` in CSS — code is always LTR.

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
  container node that React may replace on navigation.
- All processing is **idempotent**: re-running over already-processed nodes
  is a no-op, so overlapping mutations are harmless.
- The composer fix uses **document-level event delegation** — no composer
  lifecycle tracking at all, so React replacing the editor can't break it.

### Streaming handling

While a message streams (`data-is-streaming="true"`), only the cheap
block-level `dir` pass runs — React tolerates added attributes. `<bdi>`
wrapping rewrites text nodes, which could fight React's reconciler
mid-render, so it runs once per block after streaming completes. Mutations
are debounced (200 ms), and mutations caused by the extension itself are
filtered out to prevent feedback loops.

### Safety constraints

- `textarea` and `input` elements are never touched. For `[contenteditable]`,
  only `dir`/`data-hbf-composer` attributes are set on the element itself;
  its content and children are never modified.
- The toggle button is parented on `<html>`, *outside* React's root, so
  reconciliation can never remove it and we never corrupt Claude's vdom.
- Only the `storage` permission (persisting the toggle state); no host
  permissions beyond the claude.ai content-script match.

## Testing

```sh
node test_bidi.js
```

29 dependency-free unit tests covering dominant-direction detection
(including the first-strong edge case), minority-run segmentation (`C++`,
`GPT-4`, `v2`, sentence punctuation), composer hysteresis, and exact text
reconstruction.

<details>
<summary>Manual test checklist (browser)</summary>

1. Type a Hebrew letter in the composer and pause briefly → it right-aligns
   within ~150 ms.
2. Keep typing a mostly-Hebrew sentence with an English word → stays RTL.
3. Delete down to English-majority gradually → no flicker at the crossover;
   flips to LTR only once the English letter count exceeds the Hebrew count
   by 3 or more.
4. Toggle the א/A button off → composer returns to native (LTR) behavior;
   on → corrects again on the next keystroke.
5. Messages still render as before (regression check).

</details>

## Contributing

Issues and PRs welcome — especially:

- **Arabic / Persian support** (the regex ranges are already in place, needs testing)
- Support for more AI chat platforms
- A before/after GIF for this README 🙂

## License

[MIT](LICENSE)
