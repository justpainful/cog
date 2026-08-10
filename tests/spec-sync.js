// The reserved-word list in SPEC.md is generated from GRAMMAR.ebnf. Editing one
// without the other makes the specification wrong about the language it
// specifies, which is the one thing a specification cannot be.
//
//   node tests/spec-sync.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LEXICAL_MARKER = '----------------------------------------------------------------- lexical';

const whole = readFileSync(join(ROOT, 'GRAMMAR.ebnf'), 'utf8');
const cut = whole.indexOf(LEXICAL_MARKER);
const grammar = cut === -1 ? whole : whole.slice(0, cut);

const keywords = [
  ...new Set(
    [...grammar.matchAll(/"([a-z][a-z_]*)"/g)].map((m) => m[1]).filter((w) => w.length > 1),
  ),
].sort();

const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
const section = spec.split('## 14. Reserved words')[1];
if (!section) {
  console.error('SPEC.md has no "## 14. Reserved words" section.');
  process.exit(1);
}
const fence = section.match(/```\n([\s\S]*?)```/);
if (!fence) {
  console.error('The reserved-words section has no fenced word list.');
  process.exit(1);
}

const listed = new Set(fence[1].split(/\s+/).filter(Boolean));
const missing = keywords.filter((k) => !listed.has(k));
const extra = [...listed].filter((k) => !keywords.includes(k));

if (missing.length) console.error(`in the grammar, missing from SPEC.md: ${missing.join(', ')}`);
if (extra.length) console.error(`listed in SPEC.md, not in the grammar: ${extra.join(', ')}`);

if (missing.length || extra.length) {
  console.error('\nRegenerate the list rather than editing it by hand.\n');
  process.exit(1);
}

console.log(`${keywords.length} keywords, spec and grammar agree`);
