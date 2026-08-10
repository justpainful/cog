// SPEC.md section 14 lists the reserved-everywhere words, then all of them.
// Both lists are generated from the implementation, and this checks they still
// match it — a specification that disagrees with the language it specifies is
// the one kind of bug a specification cannot have.
//
//   node tests/spec-sync.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { HARD, KEYWORDS } from '../src/keywords.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LEXICAL_MARKER = '----------------------------------------------------------------- lexical';

const whole = readFileSync(join(ROOT, 'GRAMMAR.ebnf'), 'utf8');
const cut = whole.indexOf(LEXICAL_MARKER);
const grammar = cut === -1 ? whole : whole.slice(0, cut);

const fromGrammar = new Set(
  [...grammar.matchAll(/"([a-z][a-z_]*)"/g)].map((m) => m[1]).filter((w) => w.length > 1),
);

const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
const section = spec.split('## 14. Reserved words')[1];
if (!section) {
  console.error('SPEC.md has no "## 14. Reserved words" section.');
  process.exit(1);
}

const fences = [...section.matchAll(/```\n([\s\S]*?)```/g)].map((f) =>
  f[1].split(/\s+/).filter(Boolean),
);
if (fences.length < 2) {
  console.error(`Section 14 should hold two word lists, found ${fences.length}.`);
  process.exit(1);
}

const [hardListed, allListed] = [new Set(fences[0]), new Set(fences[1])];

let failed = 0;
const compare = (label, expected, actual) => {
  const missing = [...expected].filter((w) => !actual.has(w));
  const extra = [...actual].filter((w) => !expected.has(w));
  if (missing.length) {
    console.error(`${label}: missing ${missing.join(', ')}`);
    failed++;
  }
  if (extra.length) {
    console.error(`${label}: should not list ${extra.join(', ')}`);
    failed++;
  }
  if (!missing.length && !extra.length) console.log(`${label}: ${actual.size} words, agrees`);
};

compare('reserved-everywhere list vs src/keywords.js HARD', HARD, hardListed);
compare('full list vs the grammar', fromGrammar, allListed);
compare('src/keywords.js vs the grammar', fromGrammar, KEYWORDS);

if (failed) {
  console.error('\nRegenerate the lists rather than editing them by hand.\n');
  process.exit(1);
}
