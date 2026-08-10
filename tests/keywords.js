// Checks the language's central claim, which is otherwise just a sentence
// somebody wrote once: no keyword that declares, binds or controls flow is
// borrowed from a mainstream language.
//
// The keyword set is read out of GRAMMAR.ebnf rather than kept in a list here,
// so adding a keyword to the grammar and forgetting to justify it fails the
// build instead of quietly weakening the claim.
//
//   node tests/keywords.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const KEYWORDS_OF = {
  C: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while',
  Java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while',
  JavaScript: 'await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield',
  Python: 'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
  Rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while',
  Go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  Swift: 'associatedtype class deinit enum extension func import init inout let open operator private protocol public static struct subscript typealias var where while as any catch false guard is nil repeat rethrows self super switch throw throws true try defer do else for if in return case default break continue fallthrough',
};

// The words whose job is declaring, binding or controlling flow. Borrowing one
// of these is what the design rule actually forbids.
const STRUCTURAL = new Set(
  'var let class struct func function if else for while return true false null import as in with where open def fn'.split(' '),
);

// Deliberate overlaps, each with the reason it is not worth renaming.
const ALLOWED = {
  and: 'logical operator; a renamed `and` is showing off',
  or: 'logical operator',
  not: 'logical operator',
  is: 'comparison reads as English and has no better word',
  from: 'preposition in `revoke @role from @user`',
  repeat: 'Swift spells its do-while `repeat`; Cog uses it as the loop head, and no other English word fits',
};

const whole = readFileSync(join(ROOT, 'GRAMMAR.ebnf'), 'utf8');

// Stop at the lexical section. Below that line the quoted terminals are
// duration suffixes and escape characters — "s", "m", "n", "t" — which are not
// keywords, and counting them made the generated word list nonsense.
const cut = whole.indexOf('(* ----------------------------------------------------------------- lexical *)');
const grammar = cut === -1 ? whole : whole.slice(0, cut);

const keywords = [
  ...new Set(
    [...grammar.matchAll(/"([a-z][a-z_]*)"/g)]
      .map((m) => m[1])
      .filter((w) => w.length > 1),
  ),
].sort();

if (keywords.length < 40) {
  console.error(`Only ${keywords.length} keywords found in GRAMMAR.ebnf — the extraction is probably broken.`);
  process.exit(1);
}

const shared = [];
for (const k of keywords) {
  const langs = Object.entries(KEYWORDS_OF)
    .filter(([, words]) => words.split(' ').includes(k))
    .map(([lang]) => lang);
  if (langs.length) shared.push({ word: k, langs });
}

let failed = 0;

console.log(`\n${keywords.length} keywords in the grammar\n`);

console.log('shared with mainstream languages:');
for (const { word, langs } of shared) {
  const ok = word in ALLOWED;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${word.padEnd(10)} ${langs.join(', ')}`);
  if (!ok) {
    failed++;
    console.log(`       ^ not in the allowed list. Rename it, or justify it in tests/keywords.js.`);
  }
}
if (!shared.length) console.log('  (none)');

const structural = keywords.filter((k) => STRUCTURAL.has(k));
console.log(`\nborrowed structural keywords: ${structural.length ? structural.join(', ') : 'none'}`);
if (structural.length) failed++;

// An allowance for a word no longer in the grammar is stale, and stale
// allowances are how the list stops meaning anything.
const unused = Object.keys(ALLOWED).filter((k) => !keywords.includes(k));
if (unused.length) {
  console.log(`\nstale allowances (no longer keywords): ${unused.join(', ')}`);
  failed++;
}

console.log(failed ? `\n${failed} problem(s)\n` : '\nthe claim holds\n');
process.exit(failed ? 1 : 0);
