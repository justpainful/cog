// Parser tests. Every production in GRAMMAR.ebnf, and the errors that matter.

import { parse } from '../src/parser.js';
import { ParseError } from '../src/errors.js';
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
// Conditions are thunks so a throw inside one is a failed test rather than a
// dead test run.
const t = (name, cond) => {
  let ok = false;
  let why = '';
  try {
    ok = typeof cond === 'function' ? cond() : cond;
  } catch (e) {
    why = ` — threw: ${e.message}`;
  }
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}   [${group}]${why}`);
  }
};
const first = (src) => parse(src).body[0];
const kindOf = (src) => first(src).kind;

const throws = (name, src, fragment) => {
  try {
    parse(src);
    failed++;
    console.log(`  FAIL  ${name}   [${group}] — parsed without error`);
  } catch (e) {
    const text = `${e.message} ${e.hint ?? ''}`;
    if (e instanceof ParseError && (!fragment || text.includes(fragment))) {
      passed++;
      console.log(`  ok    ${name}`);
    } else {
      failed++;
      console.log(`  FAIL  ${name}   [${group}] — got: ${e.message}`);
    }
  }
};

// ---------------------------------------------------------------- bindings

describe('bindings');
t('hold', () => kindOf('hold x = 1') === 'Hold');
t('carry', () => kindOf('carry x = 1') === 'Carry');
t('hold keeps the name', () => first('hold limit = 10').name === 'limit');
t('assignment', () => kindOf('x = 1') === 'Assign');
t('field assignment', () => first('a.b = 1').target.kind === 'Field');
t('index assignment', () => first('a[0] = 1').target.kind === 'Index');
throws('hold needs a value', 'hold x', 'hold name = value');
throws('cannot assign to a call', 'f() = 1', 'cannot be assigned');
throws('cannot bind a keyword', 'hold verb = 1', 'is a keyword');

describe('expressions');
t('number', () => first('42').expression.kind === 'Number');
t('text', () => first('"hi"').expression.kind === 'Text');
t('truth', () => first('yes').expression.value === true);
t('none', () => first('none').expression.kind === 'None');
t('duration', () => first('5m').expression.seconds === 300);
t('list', () => first('[1, 2]').expression.items.length === 2);
t('empty list', () => first('[]').expression.kind === 'List');
t('map', () => first('[a: 1]').expression.kind === 'Map');
t('empty map', () => first('[:]').expression.kind === 'Map');
t('trailing comma in a list', () => first('[1, 2,]').expression.items.length === 2);
throws('list and map cannot mix', '[1, a: 2]', 'not both');

describe('operator precedence');
const expr = (src) => first(src).expression;
t('times binds tighter than plus', () => expr('1 + 2 * 3').right.kind === 'Binary');
t('parens override', () => expr('(1 + 2) * 3').left.kind === 'Binary');
t('and binds tighter than or', () => expr('a or b and c').right.operator === 'and');
t('comparison is below arithmetic', () => expr('1 + 1 is 2').kind === 'Compare');
t('not is unary', () => expr('not a').kind === 'Unary');
t('unary minus', () => expr('-a').operator === '-');
// Chaining reads as maths and means something else, so it is refused.
throws('comparisons do not chain', 'a < b < c', 'do not chain');
throws('is does not chain', 'a is b is c', 'do not chain');

describe('access');
t('field', () => expr('a.b').kind === 'Field');
t('index', () => expr('a[0]').kind === 'Index');
t('call', () => expr('f(1)').kind === 'Call');
t('chained', () => expr('a.b[0].c(1)').kind === 'Call');
t('named argument', () => expr('f(name: 1)').args[0].name === 'name');
t('positional argument', () => expr('f(1)').args[0].name === null);
throws('positional cannot follow named', 'f(a: 1, 2)', 'cannot follow a named');

describe('control flow');
t('when', () => kindOf('when a { }') === 'When');
t('when otherwise', () => first('when a { } otherwise { }').alternate.kind === 'Block');
t('when otherwise when', () => first('when a { } otherwise when b { }').alternate.kind === 'When');
t('when as a value', () => first('hold x = when a { 1 } otherwise { 2 }').value.kind === 'WhenValue');
t('nested when as a value', () => first('hold x = when a { 1 } otherwise when b { 2 } otherwise { 3 }').value.alternate.kind === 'WhenValue');
throws('when-value needs otherwise', 'hold x = when a { 1 }', 'needs an otherwise');
t('each', () => kindOf('each x of xs { }') === 'Each');
t('each with a key', () => first('each k, v of m { }').key === 'k');
throws('each needs of', 'each x in xs { }', 'each item of items');
t('repeat until', () => kindOf('repeat until a { }') === 'RepeatUntil');
t('repeat times', () => kindOf('repeat 5 times { }') === 'RepeatTimes');
throws('repeat needs until or times', 'repeat 5 { }', 'repeat 5 times');
t('stop', () => kindOf('stop') === 'Stop');
t('next', () => kindOf('next') === 'Next');
t('give with a value', () => first('give 1').value.kind === 'Number');
t('give with nothing', () => first('give').value === null);
t('attempt rescue', () => kindOf('attempt { } rescue e { }') === 'Attempt');
throws('attempt needs rescue', 'attempt { }', 'needs a rescue');
t('fail', () => kindOf('fail "bad"') === 'Fail');

describe('verbs and shapes');
t('verb', () => kindOf('verb f { }') === 'Verb');
t('verb with params', () => first('verb f(a, b) { }').params.length === 2);
t('dotted verb name', () => first('verb a.b { }').name === 'a.b');
t('default parameter', () => first('verb f(a = 1) { }').params[0].fallback.kind === 'Number');
// A required parameter after an optional one can never be given positionally.
throws('required cannot follow optional', 'verb f(a = 1, b) { }', 'move the parameters with defaults');
t('anonymous verb', () => expr('verb (x) { give x }').kind === 'VerbValue');
t('shape', () => kindOf('shape S { a b }') === 'Shape');
t('shape field default', () => first('shape S { a = 1 }').fields[0].fallback.kind === 'Number');

describe('modules');
t('bring', () => kindOf('bring text "std/text"') === 'Bring');
t('bring keeps the path', () => first('bring text "std/text"').path === 'std/text');
t('share a verb', () => first('share verb f { }').declaration.kind === 'Verb');
t('share a shape', () => first('share shape S { }').declaration.kind === 'Shape');
throws('cannot share an arbitrary statement', 'share when a { }', 'only a verb, a shape or a hold');

describe('entities');
t('bare', () => expr('@user').kind === 'Entity');
t('with an argument', () => expr('@channel("x")').argument.kind === 'Text');
t('field on an entity', () => expr('@user.name').kind === 'Field');
t('chained fields', () => expr('@user.name.length').kind === 'Field');

describe('interpolation becomes an expression');
t('bare path is kept as a path', () => expr('"@count"').parts[0].path.join('.') === 'count');
t('dotted path is kept as a path', () => expr('"@user.name"').parts[0].path.join('.') === 'user.name');
t('parenthesised', () => expr('"@(1 + 2)"').parts[0].expression.kind === 'Binary');
t('literal at-sign stays literal', () => expr('"@@x"').parts.every((p) => p.kind === 'literal'));

describe('agent layer');
t('intent', () => kindOf('intent t { verb a { } }') === 'Intent');
t('intent holds verbs', () => first('intent t { verb a { } }').body[0].kind === 'Verb');
throws('intent holds only declarations', 'intent t { hold x = 1 }', 'holds verbs');
t('on', () => kindOf('on member.joins { }') === 'On');
t('on records the event', () => first('on member.joins { }').event === 'member.joins');
t('on with a filter', () => first('on message.posted when contains "x" { }').filter.kind === 'FilterContains');
t('on with two filters', () => first('on message.posted when contains "x" and at @channel("y") { }').filter.kind === 'FilterAll');
throws('on needs a dotted event', 'on member { }', 'subject.happening');
t('every duration', () => first('every 5m { }').schedule.kind === 'EveryDuration');
t('every day at', () => first('every day at 00:03 { }').schedule.hours === 0);
t('every weekday at', () => first('every monday at 09:00 { }').schedule.period === 'monday');
throws('every needs a schedule', 'every { }', 'expected a schedule');
throws('every day needs a time', 'every day { }', 'needs a time');

describe('agent statements');
t('needs', () => kindOf('needs @user has @role("x")') === 'Needs');
t('needs no', () => first('needs no @channel("x")').predicate.kind === 'PredAbsent');
t('needs is', () => first('needs @user is @owner').predicate.kind === 'PredIs');
t('needs and', () => first('needs @user has @role("a") and @user has @role("b")').predicate.kind === 'PredAll');
t('needs not', () => first('needs not @channel("x")').predicate.kind === 'PredNot');
t('say', () => kindOf('say "hi"') === 'Say');
t('say to everyone', () => first('say "hi" to everyone').everyone === true);
t('post', () => kindOf('post @here "hi"') === 'Post');
t('post an embed', () => first('post @here embed { title "t" body "b" }').value.kind === 'Embed');
throws('embed fields are fixed', 'post @here embed { nope "x" }', 'title, body, colour and footer');
throws('embed cannot repeat a field', 'post @here embed { title "a" title "b" }', 'already has a title');
t('tell', () => kindOf('tell @user "hi"') === 'Tell');
t('note', () => kindOf('note "hi"') === 'Note');
t('make channel', () => first('make channel "x"').what === 'channel');
t('make under', () => first('make channel "x" under @category("y")').under.kind === 'Entity');
t('make with permissions', () => first('make channel "x" { hide @everyone }').permissions.length === 1);
t('make with a permission list', () => first('make channel "x" { show @user [read, write] }').permissions[0].permissions.length === 2);
t('make then', () => first('make channel "x" then { note "y" }').then.kind === 'Block');
throws('make needs a kind', 'make "x"', 'make channel');
t('thread', () => kindOf('thread "x" at @here') === 'Thread');
t('rename to', () => first('rename @here to "x"').mode === 'to');
t('rename prefix', () => first('rename @here prefix "closed-"').mode === 'prefix');
throws('rename needs a mode', 'rename @here "x"', 'to, prefix or suffix');
t('grant', () => kindOf('grant @role("x")') === 'Grant');
t('grant to', () => first('grant @role("x") to @user').who.kind === 'Entity');
t('revoke from', () => first('revoke @role("x") from @user').who.kind === 'Entity');
t('show', () => first('show @user [read]').mode === 'show');
t('hide', () => first('hide @everyone').mode === 'hide');
t('react', () => kindOf('react "👀"') === 'React');
t('count', () => first('count members up by 1').name === 'members');
t('count then', () => first('count n up then { note "x" }').then.kind === 'Block');
t('count without up is just a name', () => kindOf('count n by 1') === 'ExpressionStatement');
t('count up with no by', () => first('count members up').name === 'members');
t('panel', () => first('panel at @here { button "a" -> f }').buttons.length === 1);
t('button style', () => first('panel at @here { button "a" danger -> f }').buttons[0].style === 'danger');
t('button args', () => first('panel at @here { button "a" -> f(@made) }').buttons[0].args.length === 1);
throws('panel needs buttons', 'panel at @here { }', 'no buttons does nothing');
throws('panel needs at', 'panel @here { button "a" -> f }', 'panel at @here');
t('ask', () => first('ask { line "why" required } then f').fields[0].required === true);
throws('ask needs then', 'ask { line "why" }', 'hands off to a verb');

describe('errors point at the source');
try {
  parse('hold x = 1\nwhen {\n');
} catch (e) {
  const out = e.format();
  t('names line 2', () => out.includes(':2:'));
  t('shows the line', () => out.includes('when {'));
  t('has a caret', () => out.includes('^'));
}

describe('the spec examples parse');
const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf8');
const blocks = [...spec.matchAll(/```cog\n([\s\S]*?)```/g)].map((m) => m[1]);
const broken = [];
for (const [n, block] of blocks.entries()) {
  try {
    parse(block, `SPEC.md#${n}`);
  } catch (e) {
    broken.push(`block ${n}: ${e.message}\n${block.split('\n').slice(0, 3).join('\n')}`);
  }
}
t(`all ${blocks.length} spec examples parse`, broken.length === 0);
for (const b of broken.slice(0, 6)) console.log(`         ${b.replace(/\n/g, '\n         ')}`);

describe('the README example parses');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const rblocks = [...readme.matchAll(/```cog\n([\s\S]*?)```/g)].map((m) => m[1]);
let rbroken = null;
for (const [n, block] of rblocks.entries()) {
  try {
    parse(block, `README#${n}`);
  } catch (e) {
    rbroken = `block ${n}: ${e.message}`;
  }
}
t(`all ${rblocks.length} README examples parse`, rbroken === null);
if (rbroken) console.log(`         ${rbroken}`);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
