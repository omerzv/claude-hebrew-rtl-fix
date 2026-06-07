/**
 * content_script.js — Claude.ai Hebrew Bidi Fixer
 *
 * Orchestration layer: watches Claude.ai's dynamic DOM with a debounced
 * MutationObserver, finds assistant-message blocks, and hands each one to
 * BidiProcessor (loaded before this file, see manifest.json).
 *
 * Resilience strategy (Claude.ai is a React SPA with hashed class churn):
 *  - Several independent selectors for assistant messages, newest first;
 *    the first that matches anything wins, and a broad <main> fallback
 *    keeps the extension working even if all known hooks disappear.
 *  - We observe document.body (subtree) rather than pinning a specific
 *    chat-container node that React may replace wholesale on navigation.
 *  - All work is debounced and idempotent, so re-running over the same
 *    nodes is cheap and harmless.
 *
 * Streaming strategy: while a message streams (data-is-streaming="true")
 * we only set block-level `dir` — cheap, and React tolerates attribute
 * additions. <bdi> wrapping rewrites text nodes, which can fight React's
 * reconciler mid-render, so it runs only once streaming has finished.
 */
(function () {
  'use strict';

  const BP = globalThis.BidiProcessor;
  if (!BP) {
    console.warn('[hebrew-bidi-fixer] BidiProcessor missing; aborting.');
    return;
  }

  // ---------------------------------------------------------------------
  // Selectors
  // ---------------------------------------------------------------------

  // Assistant-message containers, in order of preference. data-is-streaming
  // has been the most stable hook across Claude.ai redesigns; the
  // font-claude-* classes cover older/newer builds.
  const ASSISTANT_CONTAINER_SELECTORS = [
    'div[data-is-streaming]',
    '.font-claude-response',
    '.font-claude-message',
  ];

  // Last-resort fallback: process rendered-markdown blocks anywhere in the
  // main column. Never matches the composer (contenteditable is excluded
  // by BidiProcessor.isProtected and again in collectBlocks).
  const FALLBACK_SCOPE = 'main';

  // Text-bearing block elements to process inside a message. ul/ol are
  // included so list markers flip to the right side of RTL lists (the dir
  // on the list element is what moves the bullet, not the dir on the li).
  const BLOCK_SELECTOR =
    'p, li, ul, ol, h1, h2, h3, h4, h5, h6, td, th, blockquote';

  const DEBOUNCE_MS = 200; // rides out React streaming churn (see README)
  const COMPOSER_DEBOUNCE_MS = 150; // per spec §2

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  let enabled = true;
  let observer = null;
  let debounceTimer = null;

  // Blocks already bdi-wrapped (final pass done). WeakSet so React swapping
  // nodes out never leaks memory. Recreated on disable (see setEnabled).
  let finalized = new WeakSet();

  // Per-editable previous direction (hysteresis state). Keyed by element so
  // every contenteditable on the page tracks independently; recreated on
  // toggle-off (see setEnabled).
  let composerDirs = new WeakMap();
  let composerDebounce = null;
  let composerErrorLogged = false;

  // ---------------------------------------------------------------------
  // Core processing
  // ---------------------------------------------------------------------

  function findAssistantContainers() {
    for (const sel of ASSISTANT_CONTAINER_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length) return Array.from(found);
    }
    const fallback = document.querySelector(FALLBACK_SCOPE);
    return fallback ? [fallback] : [];
  }

  /**
   * Streaming state of the message containing `container`.
   * @returns {'streaming'|'done'|'unknown'}  'unknown' means we're in the
   *   broad <main> fallback with no data-is-streaming hook available.
   */
  function streamingState(container) {
    const host = container.closest('[data-is-streaming]');
    if (!host) return 'unknown';
    return host.getAttribute('data-is-streaming') === 'true'
      ? 'streaming'
      : 'done';
  }

  function collectBlocks(container) {
    const blocks = container.querySelectorAll(BLOCK_SELECTOR);
    return Array.from(blocks).filter(
      (el) =>
        // Never touch the composer or anything else editable.
        !el.closest('[contenteditable]') &&
        // Code is always LTR; isProtected also guards inner text nodes,
        // but skipping whole blocks here is cheaper.
        !el.closest('pre, code')
    );
  }

  function processAll() {
    if (!enabled) return;
    for (const container of findAssistantContainers()) {
      const state = streamingState(container);
      for (const block of collectBlocks(container)) {
        if (state === 'streaming') {
          // Cheap pass: base direction only. Re-runs as text grows.
          BP.processBlock(block, { wrapInline: false });
        } else if (!finalized.has(block)) {
          BP.processBlock(block, { wrapInline: true });
          // Only mark done when we KNOW streaming ended. In the 'unknown'
          // fallback we keep reprocessing (idempotent: existing <bdi>
          // content is skipped, only new text nodes get wrapped) so text
          // appended later is never missed.
          if (state === 'done') finalized.add(block);
        }
      }
    }
  }

  function scheduleProcess() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processAll, DEBOUNCE_MS);
  }

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

  // ---------------------------------------------------------------------
  // MutationObserver
  // ---------------------------------------------------------------------

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      // Ignore mutations we caused ourselves (dir attrs / bdi wrappers),
      // otherwise we'd self-trigger forever.
      const relevant = mutations.some((m) => {
        if (m.type === 'attributes') {
          return m.attributeName === 'data-is-streaming';
        }
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.matches && n.matches('bdi.hbf-bdi, .hbf-toggle')) continue;
            return true;
          }
          return m.removedNodes.length > 0;
        }
        return true; // characterData — streaming text
      });
      if (relevant) scheduleProcess();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-is-streaming'],
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(debounceTimer);
  }

  // ---------------------------------------------------------------------
  // Enable / disable
  // ---------------------------------------------------------------------

  function setEnabled(on, persist) {
    enabled = on;
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
    updateToggleUi();
    if (persist) {
      try {
        chrome.storage.local.set({ hbfEnabled: on });
      } catch (_) {
        /* storage unavailable (e.g. orphaned context) — non-fatal */
      }
    }
  }

  // ---------------------------------------------------------------------
  // Toggle button UI
  // ---------------------------------------------------------------------

  let toggleBtn = null;

  function updateToggleUi() {
    if (!toggleBtn) return;
    toggleBtn.classList.toggle('hbf-off', !enabled);
    toggleBtn.setAttribute('aria-pressed', String(enabled));
    toggleBtn.title = enabled
      ? 'Hebrew bidi fix: ON (click to disable)'
      : 'Hebrew bidi fix: OFF (click to enable)';
  }

  function injectToggle() {
    if (document.querySelector('.hbf-toggle')) return;
    toggleBtn = document.createElement('button');
    toggleBtn.className = 'hbf-toggle';
    toggleBtn.type = 'button';
    toggleBtn.textContent = 'א/A';
    toggleBtn.addEventListener('click', () => setEnabled(!enabled, true));
    // Fixed-position floating button: deliberately NOT parented inside
    // Claude's React tree, so reconciliation can never remove it and we
    // never corrupt their vdom.
    document.documentElement.appendChild(toggleBtn);
    updateToggleUi();
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  function boot(savedEnabled) {
    enabled = savedEnabled !== false; // default ON
    injectToggle();
    if (enabled) {
      startObserver();
      attachComposerListener();
      processAll();
    }
    updateToggleUi();
  }

  try {
    chrome.storage.local.get({ hbfEnabled: true }, (res) => {
      boot(res && res.hbfEnabled);
    });
  } catch (_) {
    boot(true);
  }
})();
