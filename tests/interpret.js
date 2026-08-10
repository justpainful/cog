// Interpreter tests. Programs paired with the output they must produce, and
// errors paired with the message they must give.

import { parse } from '../src/parser.js';
import { Interpreter, useParser } from '../src/interpret.js';
import { CogError } from '../src/errors.js';

useParser(parse);

let passed = 0;
let failed = 0;
let group = '';

const describe = (name) => {
  group = name;
  console.log(`\n${name}`);
};

/** Run a program and return everything `note` printed. */
const run = (source) => {
  const lines = [];
  const interpreter = new Interpreter({ output: (l) => lines.push(l), file: 'test.cog', source });
  interpreter.run(parse(source, 'test.cog'));
  return lines;
};

const gives = (name, source, expected) => {
  let actual;
  try {
    actual = run(source).join('\n');
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}   [${group}] — threw: ${e.message}`);
    return;
  }
  if (actual === expected) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}   [${group}]\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`);
  }
};

const refuses = (name, source, fragment) => {
  try {
    run(source);
    failed++;
    console.log(`  FAIL  ${name}   [${group}] — ran without error`);
  } catch (e) {
    const text = `${e.message} ${e.hint ?? ''}`;
    if (e instanceof CogError && (!fragment || text.includes(fragment))) {
      passed++;
      console.log(`  ok    ${name}`);
    } else {
      failed++;
      console.log(`  FAIL  ${name}   [${group}] — got: ${e.message}`);
    }
  }
};

// ---------------------------------------------------------------- values

describe('values print unambiguously');
gives('text', 'note "hi"', 'hi');
gives('number', 'note 42', '42');
gives('decimal', 'note 3.5', '3.5');
gives('float noise is trimmed', 'note 0.1 + 0.2', '0.3');
gives('truth', 'note yes\nnote no', 'yes\nno');
gives('none', 'note none', 'none');
gives('list quotes its text', 'note ["a", 1]', '["a", 1]');
gives('empty list', 'note []', '[]');
gives('map', 'note [a: 1]', '[a: 1]');
gives('empty map', 'note [:]', '[:]');
gives('a verb', 'verb f { }\nnote f', 'verb f');

describe('bindings');
gives('hold', 'hold x = 1\nnote x', '1');
gives('carry and assign', 'carry x = 1\nx = 2\nnote x', '2');
gives('shadowing in a block', 'hold x = 1\nwhen yes { hold x = 2\nnote x }\nnote x', '2\n1');
refuses('a held name cannot be reassigned', 'hold x = 1\nx = 2', 'cannot be reassigned');
refuses('an unbound name cannot be assigned', 'x = 1', 'is not bound');
refuses('an unbound name cannot be read', 'note x', 'is not bound');
refuses('rebinding in the same block', 'hold x = 1\nhold x = 2', 'already bound');
gives('a near miss is suggested', 'attempt { note conut } rescue e { note e.message }', '"conut" is not bound');

describe('arithmetic and comparison');
gives('precedence', 'note 1 + 2 * 3', '7');
gives('parens', 'note (1 + 2) * 3', '9');
gives('text joins', 'note "a" + "b"', 'ab');
gives('lists join', 'note [1] + [2]', '[1, 2]');
gives('comparison', 'note 1 < 2\nnote 2 is 2\nnote 2 isnt 3', 'yes\nyes\nyes');
gives('text compares', 'note "a" < "b"', 'yes');
gives('deep equality', 'note [1, [2]] is [1, [2]]', 'yes');
refuses('text plus number', 'note "a" + 1', 'cannot add');
refuses('divide by zero', 'note 1 / 0', 'divide by zero');
refuses('ordering mixed kinds', 'note 1 < "a"', 'cannot compare');

describe('truthiness');
// Only no and none are false. Zero and empty text are true on purpose.
gives('zero is true', 'when 0 { note "true" } otherwise { note "false" }', 'true');
gives('empty text is true', 'when "" { note "true" } otherwise { note "false" }', 'true');
gives('no is false', 'when no { note "true" } otherwise { note "false" }', 'false');
gives('none is false', 'when none { note "true" } otherwise { note "false" }', 'false');

describe('control flow');
gives('when otherwise', 'when 1 > 2 { note "a" } otherwise { note "b" }', 'b');
gives('otherwise when', 'when no { note "a" } otherwise when yes { note "b" }', 'b');
gives('when as a value', 'hold x = when yes { 1 } otherwise { 2 }\nnote x', '1');
gives('each over a list', 'each x of [1, 2] { note x }', '1\n2');
gives('each over a map', 'each k, v of [a: 1] { note "@k=@v" }', 'a=1');
gives('each over text', 'each c of "hi" { note c }', 'h\ni');
gives('repeat until', 'carry n = 0\nrepeat until n is 3 { n = n + 1 }\nnote n', '3');
gives('repeat times', 'repeat 2 times { note "x" }', 'x\nx');
gives('stop', 'each x of [1, 2, 3] { when x is 2 { stop }\nnote x }', '1');
gives('next', 'each x of [1, 2, 3] { when x is 2 { next }\nnote x }', '1\n3');
gives('and short-circuits', 'verb boom { fail "no" }\nnote no and boom()', 'no');
gives('or short-circuits', 'verb boom { fail "no" }\nnote yes or boom()', 'yes');

describe('verbs');
gives('call', 'verb add(a, b) { give a + b }\nnote add(1, 2)', '3');
gives('default parameter', 'verb f(a, b = 10) { give a + b }\nnote f(1)', '11');
gives('named argument', 'verb f(a, b) { give a + b }\nnote f(1, b: 2)', '3');
gives('no give yields none', 'verb f { }\nnote f()', 'none');
gives('closure captures', 'hold n = 5\nverb f { give n }\nnote f()', '5');
gives('anonymous verb', 'hold double = verb (n) { give n * 2 }\nnote double(4)', '8');
gives('recursion', 'verb fact(n) { when n <= 1 { give 1 }\ngive n * fact(n - 1) }\nnote fact(5)', '120');
// Verbs are hoisted, so one may call another declared below it.
gives('hoisting', 'note early()\nverb early { give "up" }', 'up');
refuses('too many arguments', 'verb f(a) { }\nnote f(1, 2)', 'takes 1 argument');
refuses('missing argument', 'verb f(a) { }\nnote f()', 'needs a value');
refuses('unknown named argument', 'verb f(a) { }\nnote f(a: 1, z: 2)', 'no parameter "z"');
refuses('calling a number', 'hold x = 1\nnote x()', 'not something you can call');

describe('shapes');
gives('construct and read', 'shape S { a }\nhold s = S(a: 1)\nnote s.a', '1');
gives('default field', 'shape S { a  b = 2 }\nnote S(a: 1).b', '2');
gives('print', 'shape S { a }\nnote S(a: 1)', 'S(a: 1)');
gives('change copies', 'shape S { a }\nhold s = S(a: 1)\nhold t = s.change(a: 2)\nnote s.a\nnote t.a', '1\n2');
gives('field order follows the shape', 'shape S { a  b }\nnote S(b: 2, a: 1)', 'S(a: 1, b: 2)');
refuses('unknown field on construct', 'shape S { a }\nnote S(z: 1)', 'no field "z"');
refuses('missing field', 'shape S { a }\nnote S()', 'needs a value for "a"');
refuses('positional construction', 'shape S { a }\nnote S(1)', 'named fields');
refuses('unknown field on read', 'shape S { a }\nnote S(a: 1).z', 'no field "z"');
refuses('records cannot be mutated', 'shape S { a }\nhold s = S(a: 1)\ns.a = 2', 'cannot be changed in place');

describe('collections');
gives('index', 'note [10, 20][1]', '20');
gives('negative index', 'note [10, 20][-1]', '20');
gives('out of range is none', 'note [1][5]', 'none');
gives('map lookup', 'note [a: 1]["a"]', '1');
gives('missing key is none', 'note [a: 1]["z"]', 'none');
gives('index assignment', 'hold xs = [1, 2]\nxs[0] = 9\nnote xs', '[9, 2]');
gives('size', 'note [1, 2].size\nnote "abc".size\nnote [a: 1].size', '2\n3\n1');
gives('sorted', 'note [3, 1, 2].sorted', '[1, 2, 3]');
gives('join', 'note ["a", "b"].join("-")', 'a-b');
gives('map method', 'note [1, 2].map(verb (n) { give n * 2 })', '[2, 4]');
gives('keep', 'note [1, 2, 3].keep(verb (n) { give n > 1 })', '[2, 3]');
gives('fold', 'note [1, 2, 3].fold(0, verb (a, b) { give a + b })', '6');
gives('text methods', 'note "Hi".lowercase\nnote "a,b".split(",")', 'hi\n["a", "b"]');
gives('number methods', 'note 3.7.rounded\nnote (0 - 4).absolute', '4\n4');
refuses('map needs a verb', 'note [1].map(2)', 'needs a verb');
refuses('unknown method', 'note [1].nope()', 'no method "nope"');

describe('text and interpolation');
gives('binding', 'hold n = 3\nnote "n is @n"', 'n is 3');
gives('expression', 'note "sum @(1 + 2)"', 'sum 3');
gives('literal at-sign', 'note "@@here"', '@here');
gives('at-sign beside an interpolation', 'hold x = 1\nnote "@@x is @x"', '@x is 1');
gives('field path', 'shape S { a }\nhold s = S(a: 7)\nnote "@s.a"', '7');
// With no binding of that name, a bare @path is an entity.
gives('unbound path is an entity', 'note "@user"', '@user');
gives('block text keeps its lines', 'note """a\nb"""', 'a\nb');

describe('failure');
gives('rescue catches fail', 'attempt { fail "bad" } rescue e { note e.message }', 'bad');
gives('rescue catches a runtime error', 'attempt { note 1 / 0 } rescue e { note "caught" }', 'caught');
gives('rescue exposes where', 'attempt { fail "x" } rescue e { note e.where.size > 0 }', 'yes');
gives('no failure skips the handler', 'attempt { note "fine" } rescue e { note "no" }', 'fine');
// A give passing through an attempt is control flow, not a failure to catch.
gives('give passes through attempt', 'verb f { attempt { give "out" } rescue e { give "caught" } }\nnote f()', 'out');

describe('agent statements refuse under cog run');
refuses('say', 'say "hi"', 'cog run has none');
refuses('post', 'post @here "hi"', 'cog run has none');
refuses('make', 'make channel "x"', 'cog run has none');
refuses('on', 'on member.joins { }', 'cog run has none');
refuses('every', 'every 5m { }', 'cog run has none');
refuses('the message names cog build', 'say "hi"', 'cog build');

describe('runaway protection');
refuses('an endless loop is stopped', 'repeat until no { }', 'ten million');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
