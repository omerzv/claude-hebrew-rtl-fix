/**
 * test_bidi.js — unit tests for the pure logic in bidi_processor.js.
 * Run with:  node test_bidi.js
 * No dependencies; DOM-touching functions are not tested here (they only
 * use standard DOM APIs and are exercised manually in the browser).
 */
'use strict';

const B = require('./bidi_processor.js');

let failures = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}\n        expected ${e}\n        got      ${a}`);
  }
}

console.log('detectDominantDirection');
eq(B.detectDominantDirection('שלום עולם'), 'rtl', 'pure Hebrew → rtl');
eq(B.detectDominantDirection('hello world'), 'ltr', 'pure English → ltr');
eq(B.detectDominantDirection('זהו משפט ארוך בעברית עם API בסוף'), 'rtl', 'Hebrew-dominant mixed → rtl');
eq(B.detectDominantDirection('A long English sentence with מילה inside'), 'ltr', 'English-dominant mixed → ltr');
eq(
  B.detectDominantDirection('API זה ראשי תיבות של ממשק תכנות יישומים'),
  'rtl',
  'starts English but Hebrew-dominant → rtl (first-strong would get this wrong)'
);
eq(B.detectDominantDirection('123 456.78 — !?'), null, 'neutrals only → null');
eq(B.detectDominantDirection(''), null, 'empty → null');
eq(B.detectDominantDirection('שלום היpe hell'), 'rtl', 'exact tie (6 vs 6) → rtl (Hebrew bias)');

console.log('countStrong');
eq(B.countStrong('אב ab1'), { rtl: 2, ltr: 2 }, 'counts both scripts, ignores digits');

console.log('segmentMinorityRuns — rtl block');
eq(
  B.segmentMinorityRuns('טקסט עם machine learning בתוכו', 'rtl'),
  [
    { text: 'טקסט עם ', isolate: false },
    { text: 'machine learning', isolate: true },
    { text: ' בתוכו', isolate: false },
  ],
  'multi-word English run absorbed into one isolate'
);
eq(
  B.segmentMinorityRuns('גרסה v2 חדשה', 'rtl'),
  [
    { text: 'גרסה ', isolate: false },
    { text: 'v2', isolate: true },
    { text: ' חדשה', isolate: false },
  ],
  'trailing attached digit absorbed (v2)'
);
eq(
  B.segmentMinorityRuns('שפת C++ היא מהירה', 'rtl'),
  [
    { text: 'שפת ', isolate: false },
    { text: 'C++', isolate: true },
    { text: ' היא מהירה', isolate: false },
  ],
  'trailing ++ absorbed (C++)'
);
eq(
  B.segmentMinorityRuns('מודל GPT-4 חזק', 'rtl'),
  [
    { text: 'מודל ', isolate: false },
    { text: 'GPT-4', isolate: true },
    { text: ' חזק', isolate: false },
  ],
  'hyphenated version absorbed (GPT-4)'
);
eq(
  B.segmentMinorityRuns('המילה word. ואז עוד', 'rtl'),
  [
    { text: 'המילה ', isolate: false },
    { text: 'word', isolate: true },
    { text: '. ואז עוד', isolate: false },
  ],
  'sentence period NOT absorbed'
);
eq(
  B.segmentMinorityRuns('רק עברית כאן', 'rtl'),
  [{ text: 'רק עברית כאן', isolate: false }],
  'no minority → single plain segment'
);
eq(
  B.segmentMinorityRuns('one שתיים three', 'ltr'),
  [
    { text: 'one ', isolate: false },
    { text: 'שתיים', isolate: true },
    { text: ' three', isolate: false },
  ],
  'Hebrew minority isolated inside LTR block'
);
eq(
  B.segmentMinorityRuns('English starts זה נגמר בעברית', 'rtl'),
  [
    { text: 'English starts', isolate: true },
    { text: ' זה נגמר בעברית', isolate: false },
  ],
  'minority run at string start'
);

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

console.log('idempotency / reconstruction');
{
  const input = 'טקסט עם some English v2 וגם C++ בסוף';
  const segs = B.segmentMinorityRuns(input, 'rtl');
  eq(segs.map((s) => s.text).join(''), input, 'segments reconstruct original text exactly');
}

if (failures) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
