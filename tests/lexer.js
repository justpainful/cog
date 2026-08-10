// Lexer tests. Every construct in SPEC.md §2, and every error it can raise.

import { tokenize, T } from '../src/lexer.js';
import { KEYWORDS, HARD, SOFT } from '../src/keywords.js';
import { LexError } from '../src/errors.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0;
let failed = 0;
let group = '';

const describe = (name) => {
  group = name;
  console.log(`\n${name}`);
};
const t = (name, cond) => {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}   [${group}]`);
  }
};
const lex = (src) => tokenize(src).filter((x) => x.type !== T.EOF);
const kinds = (src) => lex(src).map((x) => x.type);
const values = (src) => lex(src).map((x) => x.value);

const throws = (name, src, fragment) => {
  try {
    tokenize(src);
    failed++;
    console.log(`  FAIL  ${name}   [${group}] — no error raised`);
  } catch (e) {
    const ok = e instanceof LexError && (!fragment || e.message.includes(fragment) || (e.hint ?? '').includes(fragment));
    if (ok) {
      passed++;
      console.log(`  ok    ${name}`);
    } else {
      failed++;
      console.log(`  FAIL  ${name}   [${group}] — got: ${e.message}`);
    }
  }
};

// ------------------------------------------------------------------ basics

describe('whitespace and comments');
t('empty source', lex('').length === 0);
t('whitespace only', lex('   \n\t  \n').length === 0);
t('comment to end of line', lex('-- all of this\n42').length === 1);
t('comment does not eat the next line', values('-- x\n42')[0] === 42);
t('a comment is not a minus', lex('--x').length === 0);
t('minus is still an operator', values('1 - 2').join(' ') === '1 - 2');

describe('numbers');
t('integer', values('42')[0] === 42);
t('decimal', values('3.5')[0] === 3.5);
t('separators are ignored', values('1_000_000')[0] === 1000000);
t('leading zero decimal', values('0.001')[0] === 0.001);
// A trailing dot is a field access on a number, not part of the literal.
t('trailing dot is not consumed', kinds('42.').join(',') === 'number,punct');

describe('durations');
t('seconds', lex('30s')[0].value.seconds === 30);
t('minutes', lex('5m')[0].value.seconds === 300);
t('hours', lex('2h')[0].value.seconds === 7200);
t('days', lex('3d')[0].value.seconds === 86400 * 3);
t('weeks', lex('1w')[0].value.seconds === 604800);
// The unit must not swallow the start of an identifier.
t('5monkeys is not a duration', kinds('5monkeys').join(',') === 'number,ident');
t('5m followed by a word still lexes', kinds('5m ago').join(',') === 'duration,ident');

describe('clock times');
t('midnight-ish', JSON.stringify(lex('00:03')[0].value) === '{"hours":0,"minutes":3}');
t('afternoon', JSON.stringify(lex('14:30')[0].value) === '{"hours":14,"minutes":30}');
throws('rejects hour 24', '24:00', 'not a clock time');
throws('rejects minute 60', '12:60', 'not a clock time');
t('a bare number and colon still lex', kinds('1:2').join(',') === 'number,punct,number');

describe('identifiers and keywords');
t('identifier', kinds('total')[0] === T.IDENT);
t('keyword', kinds('hold')[0] === T.KEYWORD);
// \b matters: `household` must not lex as the keyword `hold`.
t('household is one identifier', lex('household').length === 1 && kinds('household')[0] === T.IDENT);
t('underscore starts an identifier', kinds('_x')[0] === T.IDENT);
t('digits inside an identifier', lex('a1b2').length === 1);
t('Arabic identifier', kinds('عدد')[0] === T.IDENT);
t('accented identifier', kinds('número')[0] === T.IDENT);
t('every hard keyword lexes as a keyword', [...HARD].every((k) => kinds(k)[0] === T.KEYWORD));
// Contextual words are identifiers to the lexer; the parser recognises them by
// position. Otherwise `carry count = 0` would be illegal.
t('every contextual word lexes as an identifier', [...SOFT].every((k) => kinds(k)[0] === T.IDENT));
t('a contextual word can be a name', kinds('count')[0] === T.IDENT);

describe('entities');
t('bare entity', lex('@user')[0].value === 'user');
t('entity type', kinds('@user')[0] === T.ENTITY);
t('entity with an argument opens a paren', kinds('@channel("x")').join(',') === 'entity,punct,text,punct');
t('field access is punctuation', kinds('@user.name').join(',') === 'entity,punct,ident');
throws('@ with nothing after it', '@ ', 'nothing follows');
throws('@ before a digit', '@1', 'nothing follows');

describe('text');
t('plain', lex('"hello"')[0].value[0].value === 'hello');
t('empty text', lex('""')[0].value.length === 0);
t('escape newline', lex('"a\\nb"')[0].value[0].value === 'a\nb');
t('escape quote', lex('"a\\"b"')[0].value[0].value === 'a"b');
t('escape backslash', lex('"a\\\\b"')[0].value[0].value === 'a\\b');
t('escape at-sign', lex('"a\\@b"')[0].value[0].value === 'a@b');
throws('unknown escape', '"a\\qb"', 'is not an escape');
throws('unterminated text', '"abc', 'never closed');
throws('newline inside plain text', '"a\nb"', 'never closed');
t('block text spans lines', lex('"""a\nb"""')[0].value[0].value === 'a\nb');
t('block text keeps quotes inside', lex('"""say "hi" """')[0].value[0].value.includes('"hi"'));

describe('interpolation');
const interp = (src) => lex(src)[0].value;
t('simple name', interp('"@count"')[0].expression === 'count');
t('dotted path', interp('"@user.name"')[0].expression === 'user.name');
t('mixed with literal', interp('"hi @user.name!"').map((p) => p.kind).join(',') === 'literal,interp,literal');
t('parenthesised expression', interp('"@(a + b)"')[0].expression === 'a + b');
t('nested parens survive', interp('"@(f(g(x)))"')[0].expression === 'f(g(x))');
// The one that is easiest to get wrong.
t('@@ is a literal at-sign', interp('"@@example"')[0].value === '@example');
t('@@ produces no interpolation', interp('"@@x"').every((p) => p.kind === 'literal'));
t('trailing dot is not part of the path', interp('"@user."')[0].expression === 'user');
throws('@ with nothing after it in text', '"@ "', 'nothing follows');
throws('unclosed @(', '"@(a + b"', 'never closed');
t('interpolation records its column', interp('"ab @x"')[1].column === 5);

describe('operators and punctuation');
t('arrow is one token', values('->')[0] === '->');
t('arrow is not minus then greater', lex('->').length === 1);
t('less-or-equal', values('<=')[0] === '<=');
t('greater-or-equal', values('>=')[0] === '>=');
t('bare comparisons', values('< > =').join('') === '<>=');
t('arithmetic', values('+ - * / %').join('') === '+-*/%');
t('brackets', kinds('{}[]()').every((k) => k === T.PUNCT));

describe('positions');
const pos = tokenize('hold x = 1\ncarry y = 2');
t('first token line', pos[0].line === 1);
t('first token column', pos[0].column === 1);
t('second line is line 2', pos.find((x) => x.value === 'carry').line === 2);
t('column resets each line', pos.find((x) => x.value === 'carry').column === 1);
t('column after a token', pos[1].column === 6);
const multi = tokenize('"""a\nb"""\n42');
t('block text advances the line count', multi.find((x) => x.value === 42).line === 3);

describe('errors carry a readable message');
try {
  tokenize('hold x = #');
} catch (e) {
  const out = e.format();
  t('names the file, line and column', out.includes('<input>:1:10'));
  t('shows the offending line', out.includes('hold x = #'));
  t('puts a caret under the column', out.split('\n')[3].trimEnd().endsWith('^'));
  t('offers a hint when it has one', out.includes('comments start with --'));
}
throws('semicolon is refused with a reason', 'hold x = 1;', 'do not need semicolons');

describe('a whole program lexes');
const sample = `
-- a small program
bring text "std/text"

shape Ticket {
  owner
  opened = no
}

verb tickets.open(name, greeting = "hello") {
  hold limit = 1_000
  carry count = 0
  each item of items {
    when count > 10 { stop } otherwise { count = count + 1 }
  }
  give "@greeting @name, you are @(count + 1)"
}

on member.joins when contains "hi" {
  count members up by 1
  post @channel("welcome") "welcome @user.mention"
}

every day at 00:03 { note "tick" }
`;
let tokens = null;
try {
  tokens = tokenize(sample, 'sample.cog');
  t('lexes without error', true);
} catch (e) {
  t(`lexes without error — ${e.message}`, false);
}
if (tokens) {
  t('ends with EOF', tokens[tokens.length - 1].type === T.EOF);
  // `@channel(...)` is an entity token. `@user.mention` sits inside text, so it
  // is an interpolation part and not a token at all — which is the distinction
  // the whole text-lexing path exists to make.
  t('one bare entity, not the one inside text',
    tokens.filter((x) => x.type === T.ENTITY).map((x) => x.value).join(',') === 'channel');
  t('the interpolated one is a text part',
    tokens.filter((x) => x.type === T.TEXT).some((x) => x.value.some((p) => p.expression === 'user.mention')));
  t('found the durations and clock', tokens.some((x) => x.type === T.CLOCK));
  t('no identifier is secretly a hard keyword', tokens.filter((x) => x.type === T.IDENT).every((x) => !HARD.has(x.value)));
}

describe('the spec examples lex');
const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
const blocks = [...spec.matchAll(/```cog\n([\s\S]*?)```/g)].map((m) => m[1]);
t('the spec has code blocks', blocks.length > 10);
let lexed = 0;
const broken = [];
for (const [n, block] of blocks.entries()) {
  try {
    tokenize(block, `SPEC.md#${n}`);
    lexed++;
  } catch (e) {
    broken.push(`block ${n}: ${e.message}`);
  }
}
t(`all ${blocks.length} spec examples lex`, broken.length === 0);
if (broken.length) for (const b of broken.slice(0, 5)) console.log(`         ${b}`);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
