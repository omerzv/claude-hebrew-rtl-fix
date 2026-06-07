# Composer Direction Fix (v1.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Claude.ai composer (ProseMirror contenteditable) align correctly while typing Hebrew, using live strong-character counting with hysteresis, controlled by the existing א/A toggle.

**Architecture:** A new pure function `decideComposerDir` in `bidi_processor.js` (TDD'd in `test_bidi.js`); a document-level delegated `input` listener in `content_script.js` that applies `dir` + `data-hbf-composer` attributes only (never touching ProseMirror's children); CSS for the marker attribute; icons + version bump for sharing.

**Tech Stack:** Vanilla JS (MV3 content script), Node for unit tests (`node test_bidi.js`), Windows PowerShell + System.Drawing for icon generation. No dependencies.

**Spec:** `docs/superpowers/specs/2026-06-07-composer-direction-fix-design.md`

---

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `bidi_processor.js` | Modify | Add pure `decideComposerDir(text, prevDir, margin)` — all decision logic lives here |
| `test_bidi.js` | Modify | Add `decideComposerDir` test suite |
| `content_script.js` | Modify | Delegated input listener, per-editable WeakMap state, attribute application, toggle integration |
| `styles.css` | Modify | `[data-hbf-composer]` direction rules |
| `manifest.json` | Modify | `icons` key, version `1.1.0` |
| `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` | Create | Extension icons (generated) |
| `README.md` | Modify | Composer behavior section + manual test checklist |

Conventions to follow (already established in this codebase): IIFE modules, `hbf` prefix for all classes/attributes/storage keys, JSDoc on exported functions, no external dependencies, LF line endings.

---

### Task 1: `decideComposerDir` pure function (TDD)

**Files:**
- Modify: `bidi_processor.js` (add function + export, before the `const BidiProcessor = {` assembly near the bottom)
- Test: `test_bidi.js` (append suite before the final `if (failures)` block)

- [ ] **Step 1: Write the failing tests**

In `test_bidi.js`, insert immediately BEFORE the `console.log('idempotency / reconstruction');` line:

```js
console.log('decideComposerDir');
eq(B.decideComposerDir('ש', null), 'rtl', 'first Hebrew char sets rtl immediately');
eq(B.decideComposerDir('a', null), 'ltr', 'first Latin char sets ltr immediately');
eq(B.decideComposerDir('', null), null, 'empty → null');
eq(B.decideComposerDir('123 !?', 'rtl'), null, 'neutrals only → null even with prev');
eq(B.decideComposerDir('שש abcd', 'rtl'), 'rtl', 'prev rtl, ltr leads by 2 (<margin 3) → keeps rtl');
eq(B.decideComposerDir('שש abcde', 'rtl'), 'ltr', 'prev rtl, ltr leads by 3 (=margin) → flips to ltr');
eq(B.decideComposerDir('ab ששש', 'ltr'), 'ltr', 'prev ltr, rtl leads by 1 (<margin) → keeps ltr');
eq(B.decideComposerDir('ab ששששש', 'ltr'), 'rtl', 'prev ltr, rtl leads by 3 (=margin) → flips to rtl');
eq(B.decideComposerDir('שa', null), 'rtl', 'no prev, exact tie → rtl bias (consistent with messages)');
eq(B.decideComposerDir('שש a', 'rtl', 1), 'rtl', 'custom margin respected (ltr behind, stays)');
eq(B.decideComposerDir('ש aa', 'rtl', 1), 'ltr', 'custom margin 1: ltr leads by 1 → flips');
```

Count check for the margin tests: `'שש abcd'` → rtl=2, ltr=4, lead=2; `'שש abcde'` → rtl=2, ltr=5, lead=3; `'ab ששש'` → ltr=2, rtl=3, lead=1; `'ab ששששש'` → ltr=2, rtl=5, lead=3.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test_bidi.js`
Expected: crash with `TypeError: B.decideComposerDir is not a function` (the `eq` calls throw because the function doesn't exist yet).

- [ ] **Step 3: Implement the function**

In `bidi_processor.js`, insert immediately BEFORE the `/**` comment of the `revert` function:

```js
  /**
   * Decide the direction of a composer/contenteditable as the user types.
   * Same strong-character counting as messages, plus HYSTERESIS: once a
   * direction is established (`prevDir`), it only flips when the opposing
   * script's count exceeds the current one by at least `margin`. This
   * prevents alignment jitter while counts hover near 50/50 mid-typing.
   *
   * @param {string} text             full text of the editable
   * @param {'rtl'|'ltr'|null} prevDir previously applied direction, if any
   * @param {number} [margin=3]       strong-char lead required to flip
   * @returns {'rtl'|'ltr'|null} null when there are no strong chars at all
   *   (caller should remove dir and reset its prevDir state)
   */
  function decideComposerDir(text, prevDir, margin) {
    if (margin === undefined) margin = 3;
    const { rtl, ltr } = countStrong(text);
    if (rtl === 0 && ltr === 0) return null;
    if (!prevDir) return rtl >= ltr ? 'rtl' : 'ltr';
    if (prevDir === 'rtl') return ltr >= rtl + margin ? 'ltr' : 'rtl';
    return rtl >= ltr + margin ? 'rtl' : 'ltr';
  }

```

Then add `decideComposerDir,` to the `const BidiProcessor = {` object literal (after the `processBlock,` line).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test_bidi.js`
Expected: all lines `ok`, final line `All tests passed.`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add bidi_processor.js test_bidi.js
git commit -m "feat: add decideComposerDir with hysteresis to bidi processor"
```

---

### Task 2: Composer wiring in the content script

**Files:**
- Modify: `content_script.js`

No automated DOM test exists for this project (zero-dependency policy, no jsdom); verification is `node --check` + the manual checklist in Task 5.

- [ ] **Step 1: Add composer constants and state**

In `content_script.js`, after the `const DEBOUNCE_MS = 200; ...` line, add:

```js
  const COMPOSER_DEBOUNCE_MS = 150; // per spec §2

```

In the State section, after the `let finalized = new WeakSet();` declaration, add:

```js
  // Per-editable previous direction (hysteresis state). Keyed by element so
  // every contenteditable on the page tracks independently; recreated on
  // toggle-off (see setEnabled).
  let composerDirs = new WeakMap();
  let composerDebounce = null;
  let composerErrorLogged = false;
```

- [ ] **Step 2: Add the composer handler functions**

Insert a new section after the `scheduleProcess` function (before the `// MutationObserver` banner):

```js
  // ---------------------------------------------------------------------
  // Composer (contenteditable) direction — spec §2
  // ---------------------------------------------------------------------

  // Document-level delegation: input events bubble from any contenteditable,
  // so we never track the composer's lifecycle and React churn can't hurt us.
  function handleComposerInput(event) {
    try {
      const t = event.target;
      const editor =
        t && t.nodeType === 1 && t.closest
          ? t.closest('[contenteditable="true"]')
          : null;
      if (!editor) return;
      clearTimeout(composerDebounce);
      composerDebounce = setTimeout(
        () => updateComposerDir(editor),
        COMPOSER_DEBOUNCE_MS
      );
    } catch (err) {
      // Never block typing; log once.
      if (!composerErrorLogged) {
        composerErrorLogged = true;
        console.warn('[hebrew-bidi-fixer] composer handler error:', err);
      }
    }
  }

  // Attribute-only, always: we set dir/marker on the editable element and
  // never touch its children — ProseMirror owns that DOM. If the framework
  // strips the attribute, the next input event re-applies it (self-healing).
  function updateComposerDir(editor) {
    if (!enabled || !editor.isConnected) return;
    const prev = composerDirs.get(editor) || null;
    const dir = BP.decideComposerDir(editor.textContent || '', prev);
    if (dir) {
      composerDirs.set(editor, dir);
      if (editor.getAttribute('dir') !== dir) editor.setAttribute('dir', dir);
      if (editor.getAttribute('data-hbf-composer') !== dir) {
        editor.setAttribute('data-hbf-composer', dir);
      }
    } else {
      composerDirs.delete(editor);
      editor.removeAttribute('dir');
      editor.removeAttribute('data-hbf-composer');
    }
  }

  function attachComposerListener() {
    document.addEventListener('input', handleComposerInput, true);
  }

  function detachComposerListener() {
    document.removeEventListener('input', handleComposerInput, true);
    clearTimeout(composerDebounce);
  }

  function revertComposers() {
    document.querySelectorAll('[data-hbf-composer]').forEach((el) => {
      el.removeAttribute('dir');
      el.removeAttribute('data-hbf-composer');
    });
  }
```

- [ ] **Step 3: Wire into setEnabled and boot**

Replace the body of `setEnabled`'s `if (on) { ... } else { ... }` with:

```js
    if (on) {
      startObserver();
      attachComposerListener();
      processAll();
    } else {
      stopObserver();
      detachComposerListener();
      BP.revert(document.body);
      revertComposers();
      // revert() unwrapped every <bdi> and cleared the dir markers; reset
      // the gates so a re-enable runs the full passes again.
      finalized = new WeakSet();
      composerDirs = new WeakMap();
    }
```

In `boot`, replace:

```js
    if (enabled) {
      startObserver();
      processAll();
    }
```

with:

```js
    if (enabled) {
      startObserver();
      attachComposerListener();
      processAll();
    }
```

- [ ] **Step 4: Syntax check**

Run: `node --check content_script.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add content_script.js
git commit -m "feat: live composer direction via delegated input listener"
```

---

### Task 3: Composer CSS

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Add the rules**

Append to `styles.css`:

```css

/* Composer (contenteditable) direction — set by content_script via the
   data-hbf-composer marker. Direction only; NO unicode-bidi overrides
   inside an editable (caret-safety with ProseMirror). */
[data-hbf-composer='rtl'] {
  direction: rtl;
  text-align: right;
}

[data-hbf-composer='ltr'] {
  direction: ltr;
  text-align: left;
}
```

- [ ] **Step 2: Commit**

```bash
git add styles.css
git commit -m "feat: composer direction styles"
```

---

### Task 4: Icons + manifest bump

**Files:**
- Create: `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`
- Modify: `manifest.json`

- [ ] **Step 1: Generate icons (Windows PowerShell, System.Drawing)**

Run from the project root:

```powershell
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force icons | Out-Null
foreach ($size in 16,48,128) {
  $bmp = New-Object System.Drawing.Bitmap($size,$size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255,201,100,66))
  $g.FillEllipse($bg, 0, 0, $size-1, $size-1)
  $font = New-Object System.Drawing.Font('Arial', [Math]::Max(7, [int]($size * 0.45)), [System.Drawing.FontStyle]::Bold)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  $g.DrawString([char]0x05D0, $font, [System.Drawing.Brushes]::White, $rect, $fmt)
  $g.Dispose()
  $bmp.Save("icons\icon$size.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
Get-ChildItem icons
```

Expected: three PNG files listed (icon16.png, icon48.png, icon128.png), each a circle in the extension's accent color (#C96442) with a white א.

- [ ] **Step 2: Reference icons and bump version in manifest.json**

Change `"version": "1.0.0"` to `"version": "1.1.0"` and add after the `"description"` line:

```json
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
```

- [ ] **Step 3: Validate manifest**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 4: Commit**

```bash
git add icons manifest.json
git commit -m "feat: extension icons, bump to 1.1.0"
```

---

### Task 5: README — composer section + manual checklist

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the composer section**

Insert after the `## Using` section of `README.md`:

```markdown
## Composer (input box) direction

As of v1.1 the fix also applies to text you type. The composer's direction
is decided by the same strong-character counting used for messages,
re-evaluated 150 ms after each keystroke, with **hysteresis**: once a
direction is established it only flips when the other script takes a lead
of 3+ letters — so alignment doesn't jitter while counts hover near 50/50.
Only `dir` attributes are set; the editor's content is never modified.
The א/A button governs this too: toggling off restores native behavior.

### Manual test checklist

1. Type Hebrew into the composer → it right-aligns after the first letter.
2. Keep typing a mostly-Hebrew sentence with an English word → stays RTL.
3. Delete down to English-majority gradually → no flicker at the
   crossover; flips to LTR only once English clearly leads.
4. Toggle the א/A button off → composer returns to native (LTR) behavior;
   on → corrects again on the next keystroke.
5. Messages still render as before (regression check).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: composer direction behavior and manual test checklist"
```

---

## Final verification

- [ ] Run: `node test_bidi.js` → `All tests passed.`
- [ ] Run: `node --check content_script.js` and `node --check bidi_processor.js` → silent success
- [ ] Load unpacked in Chrome (`chrome://extensions` → reload the extension) and walk the manual checklist from Task 5
- [ ] `git log --oneline` shows the five feature commits on top of the initial commit
