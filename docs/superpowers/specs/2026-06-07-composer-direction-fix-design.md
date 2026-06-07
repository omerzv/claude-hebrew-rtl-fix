# Composer Direction Fix — Design (v1.1)

**Date:** 2026-06-07
**Project:** Claude.ai Hebrew Bidi Fixer (`hebrowaddon`)
**Status:** Approved by user

## Goal

Extend the extension so the Claude.ai **composer** (the ProseMirror
contenteditable input box) aligns correctly while typing Hebrew, using the
same strong-character *counting* model as assistant messages — not the
browser's first-strong heuristic. Distribution target is informal sharing
(GitHub), so add minimal share-readiness polish (icons, version bump).

## Decisions made during brainstorming

| Question | Decision |
| --- | --- |
| Audience | Shared with friends/community via GitHub (no store packaging) |
| Scope | Composer fix + keep floating א/A button as the only control |
| Composer direction model | Live strong-character counting (not first-strong, not manual) |
| Jitter mitigation | Hysteresis margin + debounce |
| New settings UI | None — rejected popup, per-paragraph flip, keyboard shortcut |

## Non-goals

- Per-paragraph direction inside the composer (ProseMirror recreates child
  nodes constantly; deferred unless whole-draft direction proves annoying)
- Other AI sites (ChatGPT, Gemini, …)
- Official Arabic/Persian support (regex already covers ranges; untested)
- Any text-node mutation inside the composer — **attribute-only, always**

## Design

### 1. Pure logic — `bidi_processor.js`

New exported function:

```js
decideComposerDir(text, prevDir, margin = 3) // → 'rtl' | 'ltr' | null
```

- Reuses `countStrong(text)`.
- No strong characters → `null` (caller removes `dir`; composer reverts to
  native behavior; `prevDir` state resets).
- `prevDir == null` → plain majority (`rtl >= ltr ? 'rtl' : 'ltr'`), so the
  first strong character typed sets direction immediately.
- Otherwise **hysteresis**: return the opposite of `prevDir` only when the
  opposing script's count exceeds the current script's count by at least
  `margin` (3); else keep `prevDir`. Prevents alignment jitter while the
  counts hover near 50/50 mid-typing.

### 2. Wiring — `content_script.js`

- One `document.addEventListener('input', handler)` using **event
  delegation** — no composer lifecycle tracking; immune to React
  mount/replace churn.
- Handler: if `event.target.closest('[contenteditable="true"]')` matches,
  debounce 150 ms, then read the editor's `textContent`, call
  `decideComposerDir`, and set/remove `dir` and `data-hbf-composer` on the
  contenteditable element.
- **Deliberately matches any contenteditable on claude.ai** — the main
  composer and smaller editable fields (e.g., title rename) all benefit;
  each editable tracks its own `prevDir` (WeakMap keyed by element).
- Per-editable `prevDir` state lives in a `WeakMap<Element, 'rtl'|'ltr'>`;
  an entry resets when its `dir` is removed; the whole map is recreated
  when the fix is toggled off.
- If ProseMirror/React strips the attribute, the next input event
  re-applies it (self-healing; no observer needed).

### 3. Toggle integration

The existing floating א/A button governs both features:

- **Off:** detach the input listener, remove `dir`/`data-hbf-composer` from
  any composer, reset `prevDir` — in addition to the existing message
  revert.
- **On:** attach the listener; the composer corrects on the next keystroke.
- Persisted state key (`hbfEnabled`) is unchanged — one switch for all.

### 4. CSS — `styles.css`

```css
[data-hbf-composer='rtl'] { direction: rtl; text-align: right; }
[data-hbf-composer='ltr'] { direction: ltr; text-align: left; }
```

No `unicode-bidi` overrides inside the editor (caret-safety with
contenteditable).

### 5. Error handling & safety

- Degrades to a no-op when no composer matches; typing is never blocked.
- Handler body wrapped in try/catch; logs once (guard flag), never repeats.
- `BidiProcessor.revert()` continues to exclude `[contenteditable]`
  subtrees — the composer is never text-mutated by any code path.

### 6. Testing

- `test_bidi.js` gains a `decideComposerDir` suite:
  - first strong char sets direction immediately
  - empty / neutral-only text → null
  - below-margin opposition keeps `prevDir`
  - at/above-margin opposition flips
  - both transition directions (rtl→ltr, ltr→rtl)
- Manual checklist (added to README): type Hebrew → flips right; delete down
  to English-majority gradually → no jitter, flips only past the margin;
  toggle off → composer reverts to native behavior.

### 7. Share-readiness

- `icons/` 16/48/128 px (simple א/A glyph), referenced from the manifest.
- Version bump to `1.1.0`.
- README: composer behavior section + manual test checklist.
