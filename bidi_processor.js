/**
 * bidi_processor.js
 *
 * Pure bidi-detection / processing logic. No extension APIs, no globals
 * mutated except the single `BidiProcessor` namespace. Testable in
 * isolation under Node (`node test_bidi.js`) — DOM-touching functions
 * take elements as arguments and only use standard DOM APIs.
 *
 * Direction model (Unicode Bidirectional Algorithm, UAX #9):
 *  - Each block element gets an explicit base direction (`dir="rtl"|"ltr"`)
 *    chosen by counting strong-directional characters. Counting beats the
 *    browser's first-strong heuristic (`dir="auto"`) for mixed content:
 *    a Hebrew paragraph that *starts* with an English word would be
 *    misdetected by first-strong.
 *  - Inline runs of the minority script are wrapped in <bdi>, which is an
 *    inline directional ISOLATE (first-strong base direction, isolated from
 *    surroundings). This keeps neutral characters (punctuation, digits,
 *    spaces) adjacent to the run from being reordered by the outer base
 *    direction. <bdo> (a directional OVERRIDE that reverses character
 *    order) is intentionally NOT used.
 */
(function (root) {
  'use strict';

  // Strong RTL: Hebrew + Hebrew presentation forms. (Arabic ranges included
  // so Arabic content doesn't silently break, at zero cost.)
  const RTL_CHAR = /[֐-׿יִ-ﭏ؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/;
  // Strong LTR: Latin letters (covers English; accented Latin included).
  const LTR_CHAR = /[A-Za-zÀ-ɏ]/;

  const RTL_CHAR_G = new RegExp(RTL_CHAR.source, 'g');
  const LTR_CHAR_G = new RegExp(LTR_CHAR.source, 'g');

  /**
   * Count strong-directional characters in a string.
   * @returns {{rtl: number, ltr: number}}
   */
  function countStrong(text) {
    const rtl = (text.match(RTL_CHAR_G) || []).length;
    const ltr = (text.match(LTR_CHAR_G) || []).length;
    return { rtl, ltr };
  }

  /**
   * Decide the dominant base direction of a block of text.
   * @returns {'rtl'|'ltr'|null} null when there is no strong character at
   *   all (whitespace, digits, punctuation only) — leave such blocks alone.
   */
  function detectDominantDirection(text) {
    const { rtl, ltr } = countStrong(text);
    if (rtl === 0 && ltr === 0) return null;
    return rtl >= ltr ? 'rtl' : 'ltr';
  }

  /**
   * Split a string into segments of the minority script vs. everything else,
   * for <bdi>-wrapping. A "minority run" is a maximal substring that starts
   * and ends with a strong minority-direction character; neutral characters
   * (spaces, punctuation, digits) BETWEEN two minority strongs are absorbed
   * into the run so that e.g. "machine learning" or "C++ 17" stays one
   * isolate instead of three.
   *
   * @param {string} text
   * @param {'rtl'|'ltr'} blockDir  the base direction of the containing block
   * @returns {Array<{text: string, isolate: boolean}>}  ordered segments;
   *   `isolate: true` segments should be wrapped in <bdi>.
   */
  function segmentMinorityRuns(text, blockDir) {
    const minority = blockDir === 'rtl' ? LTR_CHAR : RTL_CHAR;
    const majority = blockDir === 'rtl' ? RTL_CHAR : LTR_CHAR;

    const segments = [];
    let plainStart = 0; // start of the current non-isolated stretch
    let i = 0;

    while (i < text.length) {
      if (minority.test(text[i])) {
        // Found the start of a minority run; find its end: the last strong
        // minority char reachable without crossing a strong majority char.
        let end = i; // index of last strong minority char seen
        let j = i + 1;
        while (j < text.length && !majority.test(text[j])) {
          if (minority.test(text[j])) end = j;
          j++;
        }
        // Absorb word-attached trailing digits/symbols into the isolate so
        // tokens like "v2", "C++", "GPT-4", "ES2024" stay one unit (in an
        // RTL paragraph an unisolated "C++" renders as "++C").
        let k = end + 1;
        while (k < text.length) {
          const c = text[k];
          if (/[0-9+#%]/.test(c)) {
            end = k;
            k++;
          } else if (
            /[.\-_/]/.test(c) &&
            k + 1 < text.length &&
            /[0-9A-Za-z+#]/.test(text[k + 1])
          ) {
            // word-internal punctuation ("3.5", "utf-8", "a/b") — only
            // absorbed when followed by more word characters, so sentence
            // punctuation stays outside the isolate.
            end = k;
            k++;
          } else {
            break;
          }
        }
        if (i > plainStart) {
          segments.push({ text: text.slice(plainStart, i), isolate: false });
        }
        segments.push({ text: text.slice(i, end + 1), isolate: true });
        plainStart = end + 1;
        i = end + 1;
      } else {
        i++;
      }
    }
    if (plainStart < text.length) {
      segments.push({ text: text.slice(plainStart), isolate: false });
    }
    return segments;
  }

  /**
   * True when an element must never be processed: code blocks (always LTR
   * by convention), already-isolated content, and editable areas.
   */
  function isProtected(el) {
    return !!(
      el.closest &&
      el.closest('code, pre, kbd, samp, [contenteditable], textarea, input, bdi, bdo')
    );
  }

  /**
   * Apply the base direction to a single block element.
   * Idempotent. Marks the element with `data-hbf-dir` for cleanup/toggle.
   * @returns {'rtl'|'ltr'|null} the direction applied
   */
  function applyBlockDirection(el) {
    if (isProtected(el)) return null;
    const dir = detectDominantDirection(el.textContent || '');
    if (!dir) return null;
    if (el.getAttribute('dir') !== dir) el.setAttribute('dir', dir);
    el.setAttribute('data-hbf-dir', dir);
    return dir;
  }

  /**
   * Wrap minority-script runs inside `el`'s text nodes with <bdi class="hbf-bdi">.
   * Skips protected subtrees and previously created <bdi> wrappers, so the
   * function is idempotent and safe to re-run after streaming appends text.
   *
   * @param {Element} el        block element whose dir is already set
   * @param {'rtl'|'ltr'} blockDir
   * @param {Document} doc      owner document (injected for testability)
   * @returns {number} how many <bdi> wrappers were created
   */
  function wrapMinorityRuns(el, blockDir, doc) {
    doc = doc || el.ownerDocument;
    const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || isProtected(p)) return 2 /* FILTER_REJECT */;
        return 1 /* FILTER_ACCEPT */;
      },
    });

    // Collect first — mutating while walking invalidates the walker.
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let created = 0;
    for (const node of textNodes) {
      const segments = segmentMinorityRuns(node.nodeValue, blockDir);
      if (!segments.some((s) => s.isolate)) continue;

      const frag = doc.createDocumentFragment();
      for (const seg of segments) {
        if (seg.isolate) {
          const bdi = doc.createElement('bdi');
          bdi.className = 'hbf-bdi';
          bdi.textContent = seg.text;
          frag.appendChild(bdi);
          created++;
        } else {
          frag.appendChild(doc.createTextNode(seg.text));
        }
      }
      node.parentNode.replaceChild(frag, node);
    }
    return created;
  }

  /**
   * Fully process one block element: set base dir, isolate minority runs.
   * @param {Element} el
   * @param {{wrapInline?: boolean}} [opts]  wrapInline=false applies only the
   *   block dir (used while a message is still streaming, so we never fight
   *   React's reconciler over text nodes mid-render).
   */
  function processBlock(el, opts) {
    const wrapInline = !opts || opts.wrapInline !== false;
    const dir = applyBlockDirection(el);
    if (dir && wrapInline) wrapMinorityRuns(el, dir, el.ownerDocument);
    return dir;
  }

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

  /**
   * Undo everything this processor did inside `root`: remove dir markers
   * and unwrap our <bdi> elements back into plain text.
   */
  function revert(rootEl) {
    rootEl.querySelectorAll('[data-hbf-dir]').forEach((el) => {
      el.removeAttribute('dir');
      el.removeAttribute('data-hbf-dir');
    });
    rootEl.querySelectorAll('bdi.hbf-bdi').forEach((bdi) => {
      bdi.replaceWith(bdi.ownerDocument.createTextNode(bdi.textContent));
    });
    // Merge adjacent text nodes created by unwrapping.
    rootEl.normalize();
  }

  const BidiProcessor = {
    RTL_CHAR,
    LTR_CHAR,
    countStrong,
    detectDominantDirection,
    segmentMinorityRuns,
    isProtected,
    applyBlockDirection,
    wrapMinorityRuns,
    processBlock,
    decideComposerDir,
    revert,
  };

  // Browser content script: attach to the page's global.
  root.BidiProcessor = BidiProcessor;
  // Node (tests): CommonJS export.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BidiProcessor;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
