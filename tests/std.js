// Standard library tests. Every shared verb in std/ is exercised here, with the
// empty, single, zero and negative cases spelled out for the ones that have
// them.
//
// The harness matches tests/interpret.js, with one addition: these programs
// need a module loader, so `run` supplies one that resolves std/ against the
// standard library beside this file. Loaded modules are cached across tests, so
// the four files are parsed once rather than once per assertion.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/parser.js';
import { Interpreter, useParser } from '../src/interpret.js';
import { CogError } from '../src/errors.js';

useParser(parse);

const HERE = dirname(fileURLToPath(import.meta.url));
const STD = join(HERE, '..', 'std');

/** The same resolution rule cli.js uses: std/ is the library, else relative. */
const load = (path) => {
  const candidate = path.startsWith('std/')
    ? join(STD, `${path.slice(4)}.cog`)
    : resolve(HERE, path.endsWith('.cog') ? path : `${path}.cog`);
  return existsSync(candidate) ? readFileSync(candidate, 'utf8') : null;
};

/** Every test gets all four modules under their usual names. */
const PRELUDE = [
  'bring text "std/text"',
  'bring list "std/list"',
  'bring math "std/math"',
  'bring time "std/time"',
  '',
].join('\n');

const MODULES = new Map();

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
  const whole = PRELUDE + source;
  const interpreter = new Interpreter({ output: (l) => lines.push(l), file: 'test.cog', source: whole, load });
  interpreter.modules = MODULES;
  interpreter.run(parse(whole, 'test.cog'));
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

// ---------------------------------------------------------------- the modules

describe('the modules load');
gives('all four answer', [
  'note text.slug("a b")',
  'note list.sum([1, 2])',
  'note math.sign(0 - 4)',
  'note time.describe(90)',
].join('\n'), 'a-b\n3\n-1\n1m 30s');
refuses('a name that is not shared is named as missing', 'note text.is_space', 'does not share "is_space"');
refuses('and the message lists what is shared', 'note text.is_space', 'it shares');
gives('one module may bring another', 'note time.clock_text(90m)', '01:30');
refuses('a module that is not there says so', 'bring nope "std/nope"\nnote nope', 'cannot find module');

// ------------------------------------------------------------------ std/text

describe('text.is_blank');
gives('empty text is blank', 'note text.is_blank("")', 'yes');
gives('whitespace is blank', 'note text.is_blank("  \\t")', 'yes');
gives('a word is not', 'note text.is_blank(" a ")', 'no');

describe('text.title');
gives('words are capitalised', 'note text.title("hello world")', 'Hello World');
gives('the rest of a word is lowered', 'note text.title("cog IS good")', 'Cog Is Good');
gives('whitespace is kept as it was', 'note "[@(text.title("  a   b "))]"', '[  A   B ]');
gives('an apostrophe does not start a word', 'note text.title("don\'t stop")', "Don't Stop");
gives('empty text', 'note "[@(text.title(""))]"', '[]');

describe('text.pad_left and text.pad_right');
gives('left', 'note text.pad_left("7", 3, "0")', '007');
gives('right', 'note "[@(text.pad_right("ab", 5, "."))]"', '[ab...]');
gives('the default filler is a space', 'note "[@(text.pad_left("x", 3))]"', '[  x]');
gives('text already wide enough is untouched', 'note text.pad_left("abcdef", 3)', 'abcdef');
gives('an exact fit is untouched', 'note text.pad_right("abc", 3, "-")', 'abc');
gives('a long filler is cut to fit', 'note text.pad_left("x", 5, "ab")', 'ababx');
gives('a width of zero', 'note "[@(text.pad_right("", 0))]"', '[]');
refuses('an empty filler', 'note text.pad_left("x", 3, "")', 'at least one character');

describe('text.count_of');
gives('counts occurrences', 'note text.count_of("banana", "an")', '2');
gives('none is zero', 'note text.count_of("banana", "z")', '0');
gives('does not overlap', 'note text.count_of("aaaa", "aa")', '2');
gives('the whole text', 'note text.count_of("aa", "aa")', '1');
refuses('an empty needle', 'note text.count_of("a", "")', 'something to look for');

describe('text.lines');
gives('splits on newlines', 'note text.lines("a\\nb")', '["a", "b"]');
gives('a trailing newline makes no empty line', 'note text.lines("a\\nb\\n")', '["a", "b"]');
gives('a blank line in the middle is kept', 'note text.lines("a\\n\\nb")', '["a", "", "b"]');
gives('empty text has no lines', 'note text.lines("")', '[]');
gives('one line without a newline', 'note text.lines("only")', '["only"]');

describe('text.words');
gives('splits on whitespace', 'note text.words("one two")', '["one", "two"]');
gives('runs of whitespace count once', 'note text.words("  one  \\t two ")', '["one", "two"]');
gives('empty text has no words', 'note text.words("")', '[]');
gives('whitespace alone has no words', 'note text.words("   ")', '[]');
gives('one word', 'note text.words("solo")', '["solo"]');

describe('text.strip_prefix and text.strip_suffix');
gives('prefix removed', 'note text.strip_prefix("std/text", "std/")', 'text');
gives('prefix absent changes nothing', 'note text.strip_prefix("abc", "z")', 'abc');
gives('suffix removed', 'note text.strip_suffix("file.cog", ".cog")', 'file');
gives('suffix absent changes nothing', 'note text.strip_suffix("file.cog", ".js")', 'file.cog');
gives('an empty prefix changes nothing', 'note text.strip_prefix("abc", "")', 'abc');
gives('stripping the whole text', 'note "[@(text.strip_suffix("abc", "abc"))]"', '[]');
gives('only one copy comes off', 'note text.strip_prefix("aabc", "a")', 'abc');

describe('text.truncate');
gives('long text is cut', 'note text.truncate("hello world", 8)', 'hello w…');
gives('short text is left alone', 'note text.truncate("hi", 8)', 'hi');
gives('an exact fit is left alone', 'note text.truncate("hello", 5)', 'hello');
gives('a custom ending', 'note text.truncate("hello world", 8, "...")', 'hello...');
gives('an ending as long as the room', 'note text.truncate("hello", 2)', 'h…');
gives('no room at all', 'note "[@(text.truncate("hello", 0))]"', '[]');
gives('an empty ending', 'note text.truncate("hello", 3, "")', 'hel');

describe('text.slug');
gives('spaces and punctuation become dashes', 'note text.slug("Hello, World!")', 'hello-world');
gives('runs collapse to one dash', 'note text.slug("a   ---   b")', 'a-b');
gives('the ends are trimmed', 'note text.slug("  spaced out  ")', 'spaced-out');
gives('digits survive', 'note text.slug("Cog 0.1 — the tour")', 'cog-0-1-the-tour');
gives('empty text', 'note "[@(text.slug(""))]"', '[]');
gives('punctuation alone', 'note "[@(text.slug("---"))]"', '[]');
gives('letters Cog cannot case-fold are kept', 'note text.slug("مرحبا بالعالم")', 'مرحبا-بالعالم');

// ------------------------------------------------------------------ std/list

describe('list.sum and list.product');
gives('sum', 'note list.sum([1, 2, 3])', '6');
gives('the sum of nothing is zero', 'note list.sum([])', '0');
gives('sum with negatives', 'note list.sum([5, 0 - 2, 0 - 3])', '0');
gives('one item', 'note list.sum([7])', '7');
gives('product', 'note list.product([2, 3, 4])', '24');
gives('the product of nothing is one', 'note list.product([])', '1');
gives('a zero swallows the product', 'note list.product([2, 0, 3])', '0');
refuses('text will not add', 'note list.sum(["a"])', 'cannot add');

describe('list.min and list.max');
gives('min', 'note list.min([3, 1, 2])', '1');
gives('max', 'note list.max([3, 1, 2])', '3');
gives('one item is both', 'note list.min([7])\nnote list.max([7])', '7\n7');
gives('negatives order properly', 'note list.min([0 - 1, 0 - 5, 2])', '-5');
gives('text orders too', 'note list.max(["ant", "bee"])', 'bee');
refuses('min of nothing', 'note list.min([])', 'min needs at least one item');
refuses('max of nothing', 'note list.max([])', 'max needs at least one item');
refuses('mixed kinds do not order', 'note list.min([1, "a"])', 'cannot compare');

describe('list.unique');
gives('repeats are dropped', 'note list.unique([1, 2, 1, 3, 2])', '[1, 2, 3]');
gives('order is the first appearance', 'note list.unique(["b", "a", "b"])', '["b", "a"]');
gives('nothing', 'note list.unique([])', '[]');
gives('already unique', 'note list.unique([1, 2])', '[1, 2]');
gives('deep equality decides', 'note list.unique([[1], [1], [2]])', '[[1], [2]]');

describe('list.flatten');
gives('one level comes off', 'note list.flatten([[1, 2], [3]])', '[1, 2, 3]');
gives('loose items are kept', 'note list.flatten([[1], 2])', '[1, 2]');
gives('deeper nesting stays', 'note list.flatten([[[1]], [2]])', '[[1], 2]');
gives('nothing', 'note list.flatten([])', '[]');
gives('empty lists vanish', 'note list.flatten([[], []])', '[]');

describe('list.zip');
gives('pairs up', 'note list.zip([1, 2], ["a", "b"])', '[[1, "a"], [2, "b"]]');
gives('stops at the shorter one', 'note list.zip([1, 2, 3], ["a"])', '[[1, "a"]]');
gives('with nothing', 'note list.zip([], [1, 2])', '[]');
gives('both empty', 'note list.zip([], [])', '[]');

describe('list.chunk');
gives('even pieces', 'note list.chunk([1, 2, 3, 4], 2)', '[[1, 2], [3, 4]]');
gives('a short last piece', 'note list.chunk([1, 2, 3], 2)', '[[1, 2], [3]]');
gives('pieces of one', 'note list.chunk([1, 2], 1)', '[[1], [2]]');
gives('a piece bigger than the list', 'note list.chunk([1, 2], 5)', '[[1, 2]]');
gives('nothing', 'note list.chunk([], 2)', '[]');
refuses('a size of zero', 'note list.chunk([1], 0)', 'at least one');
refuses('a negative size', 'note list.chunk([1], 0 - 2)', 'at least one');
refuses('a fractional size', 'note list.chunk([1], 1.5)', 'whole size');

describe('list.take and list.drop');
gives('take some', 'note list.take([1, 2, 3], 2)', '[1, 2]');
gives('take more than there are', 'note list.take([1, 2], 9)', '[1, 2]');
gives('take none', 'note list.take([1, 2], 0)', '[]');
gives('take a negative count', 'note list.take([1, 2], 0 - 1)', '[]');
gives('take from nothing', 'note list.take([], 3)', '[]');
gives('drop some', 'note list.drop([1, 2, 3], 1)', '[2, 3]');
gives('drop more than there are', 'note list.drop([1, 2], 9)', '[]');
gives('drop none', 'note list.drop([1, 2], 0)', '[1, 2]');
gives('drop a negative count', 'note list.drop([1, 2], 0 - 1)', '[1, 2]');
gives('take copies rather than sharing', 'hold xs = [1, 2]\nhold ys = list.take(xs, 2)\nys[0] = 9\nnote xs', '[1, 2]');
gives('drop copies rather than sharing', 'hold xs = [1, 2]\nhold ys = list.drop(xs, 0)\nys[0] = 9\nnote xs', '[1, 2]');
// The native drop asks a verb; this one counts. Both keep working.
gives('the native drop is untouched', 'note [1, 2, 3].drop(verb (n) { give n > 1 })', '[1]');

describe('list.index_of');
gives('finds it', 'note list.index_of([1, 2, 3], 2)', '1');
gives('the first appearance wins', 'note list.index_of(["a", "b", "a"], "a")', '0');
gives('missing is none', 'note list.index_of([1, 2], 9)', 'none');
gives('nothing to search', 'note list.index_of([], 1)', 'none');
gives('deep equality finds it', 'note list.index_of([[1], [2]], [2])', '1');

describe('list.count_where');
gives('counts the matches', 'note list.count_where([1, 2, 3, 4], verb (n) { give n % 2 is 0 })', '2');
gives('no match is zero', 'note list.count_where([1, 3], verb (n) { give n % 2 is 0 })', '0');
gives('nothing is zero', 'note list.count_where([], verb (n) { give yes })', '0');
gives('all of them', 'note list.count_where([1, 2], verb (n) { give yes })', '2');
// Zero and empty text are true in Cog, so a verb answering 0 answers yes.
gives('only no and none fail the test', 'note list.count_where([1, 2], verb (n) { give 0 })', '2');

describe('list.group_by');
gives('groups by the key', 'note list.group_by(["ant", "bee", "ape"], verb (w) { give w[0] })', '[a: ["ant", "ape"], b: ["bee"]]');
gives('nothing gives an empty map', 'note list.group_by([], verb (x) { give x })', '[:]');
gives('one group', 'note list.group_by([2, 4], verb (n) { give math.is_even(n) })', '[yes: [2, 4]]');
gives('order inside a group is kept', 'note list.group_by([3, 1, 4, 2], verb (n) { give when n > 2 { "big" } otherwise { "small" } })', '[big: [3, 4], small: [1, 2]]');
gives('a number key stays a number', 'note list.group_by([1, 2], verb (n) { give n % 2 })[1]', '[1]');

describe('list.sort_by');
gives('orders by the key', 'note list.sort_by(["ccc", "a", "bb"], verb (w) { give w.size })', '["a", "bb", "ccc"]');
gives('equal keys keep their order', 'note list.sort_by([["a", 1], ["b", 1], ["c", 0]], verb (p) { give p[1] })', '[["c", 0], ["a", 1], ["b", 1]]');
gives('nothing', 'note list.sort_by([], verb (x) { give x })', '[]');
gives('one item', 'note list.sort_by([5], verb (x) { give x })', '[5]');
gives('already ordered', 'note list.sort_by([1, 2, 3], verb (n) { give n })', '[1, 2, 3]');
gives('reversed', 'note list.sort_by([3, 2, 1], verb (n) { give n })', '[1, 2, 3]');
gives('negatives', 'note list.sort_by([1, 0 - 2, 0], verb (n) { give n })', '[-2, 0, 1]');
gives('the original is left alone', 'hold xs = [2, 1]\nnote list.sort_by(xs, verb (n) { give n })\nnote xs', '[1, 2]\n[2, 1]');

// ------------------------------------------------------------------ std/math

describe('math.clamp');
gives('inside the range', 'note math.clamp(5, 1, 10)', '5');
gives('below', 'note math.clamp(0, 1, 10)', '1');
gives('above', 'note math.clamp(11, 1, 10)', '10');
gives('on the edge', 'note math.clamp(1, 1, 10)\nnote math.clamp(10, 1, 10)', '1\n10');
gives('a range of one value', 'note math.clamp(5, 2, 2)', '2');
gives('negative bounds', 'note math.clamp(0 - 5, 0 - 2, 2)', '-2');
refuses('a low above the high', 'note math.clamp(1, 10, 2)', 'not above the high');

describe('math.sign');
gives('positive', 'note math.sign(2.5)', '1');
gives('negative', 'note math.sign(0 - 3)', '-1');
gives('zero', 'note math.sign(0)', '0');

describe('math.is_even and math.is_odd');
gives('even', 'note math.is_even(4)', 'yes');
gives('odd', 'note math.is_odd(3)', 'yes');
gives('zero is even', 'note math.is_even(0)\nnote math.is_odd(0)', 'yes\nno');
gives('negatives still work', 'note math.is_even(0 - 4)\nnote math.is_odd(0 - 3)', 'yes\nyes');
gives('a fraction is neither', 'note math.is_even(2.5)\nnote math.is_odd(2.5)', 'no\nno');

describe('math.gcd and math.lcm');
gives('gcd', 'note math.gcd(12, 18)', '6');
gives('gcd with zero is the other number', 'note math.gcd(0, 5)\nnote math.gcd(5, 0)', '5\n5');
gives('gcd of nothing but zero', 'note math.gcd(0, 0)', '0');
gives('gcd ignores sign', 'note math.gcd(0 - 12, 18)', '6');
gives('coprime numbers', 'note math.gcd(9, 4)', '1');
gives('lcm', 'note math.lcm(4, 6)', '12');
gives('lcm with zero is zero', 'note math.lcm(0, 5)\nnote math.lcm(5, 0)', '0\n0');
gives('lcm ignores sign', 'note math.lcm(0 - 4, 6)', '12');
refuses('gcd of fractions', 'note math.gcd(1.5, 2)', 'two whole numbers');

describe('math.factorial');
gives('zero', 'note math.factorial(0)', '1');
gives('one', 'note math.factorial(1)', '1');
gives('five', 'note math.factorial(5)', '120');
refuses('a negative', 'note math.factorial(0 - 1)', 'not negative');
refuses('a fraction', 'note math.factorial(2.5)', 'whole number');

describe('math.average and math.median');
gives('average', 'note math.average([1, 2, 3, 4])', '2.5');
gives('average of one', 'note math.average([7])', '7');
gives('average with negatives', 'note math.average([0 - 2, 2])', '0');
gives('median of an odd count', 'note math.median([3, 1, 2])', '2');
gives('median of an even count', 'note math.median([4, 1, 3, 2])', '2.5');
gives('median of one', 'note math.median([7])', '7');
gives('median does not need sorting first', 'note math.median([9, 1, 5])', '5');
refuses('average of nothing', 'note math.average([])', 'average needs at least one');
refuses('median of nothing', 'note math.median([])', 'median needs at least one');

describe('math.power');
gives('a whole exponent is exact', 'note math.power(2, 10)', '1024');
gives('an exponent of zero', 'note math.power(2, 0)', '1');
gives('zero to the zero is one', 'note math.power(0, 0)', '1');
gives('a negative exponent', 'note math.power(2, 0 - 2)', '0.25');
gives('a negative base', 'note math.power(0 - 2, 3)', '-8');
gives('zero to a positive power', 'note math.power(0, 3)', '0');
gives('zero to a fractional power', 'note math.power(0, 0.5)', '0');
gives('a fractional exponent that lands exactly', 'note math.power(9, 0.5)', '3');
// Through the logarithm, so this is checked to about fifteen digits rather
// than by its printed form.
gives('a fractional exponent agrees with sqrt', 'note (math.power(2, 0.5) - math.sqrt(2)).absolute < 0.0000000001', 'yes');
gives('an awkward fractional exponent', 'note (math.power(10, 0.3) - 1.9952623149688795).absolute < 0.0000000001', 'yes');
gives('a fractional exponent below one', 'note (math.power(0.5, 0.5) - 0.7071067811865476).absolute < 0.0000000001', 'yes');
refuses('a negative base with a fractional exponent', 'note math.power(0 - 4, 0.5)', 'negative number to a fractional');
refuses('zero to a negative exponent', 'note math.power(0, 0 - 1)', 'zero to a negative exponent');

describe('math.sqrt');
gives('a perfect square', 'note math.sqrt(4)', '2');
gives('zero', 'note math.sqrt(0)', '0');
gives('one', 'note math.sqrt(1)', '1');
gives('a fraction', 'note math.sqrt(0.25)', '0.5');
gives('a large square', 'note math.sqrt(1000000)', '1000');
gives('a small square', 'note math.sqrt(0.0001)', '0.01');
// Newton's method lands within a unit in the last place, so the check is that
// squaring it comes back.
gives('an irrational root squares back', 'note (math.sqrt(2) * math.sqrt(2) - 2).absolute < 0.0000000001', 'yes');
gives('another irrational root', 'note (math.sqrt(10) * math.sqrt(10) - 10).absolute < 0.0000000001', 'yes');
refuses('a negative', 'note math.sqrt(0 - 1)', 'not negative');

// ------------------------------------------------------------------ std/time

describe('time constructors match the duration literals');
gives('seconds', 'note time.seconds(30) is 30s', 'yes');
gives('minutes', 'note time.minutes(5) is 5m', 'yes');
gives('hours', 'note time.hours(2) is 2h', 'yes');
gives('days', 'note time.days(3) is 3d', 'yes');
gives('a duration is a count of seconds', 'note time.minutes(5)', '300');
gives('zero', 'note time.hours(0)', '0');
gives('a fraction of an hour', 'note time.hours(0.5)', '1800');
gives('a negative duration', 'note time.minutes(0 - 2)', '-120');

describe('time.as_minutes and time.as_hours');
gives('as_minutes', 'note time.as_minutes(2h)', '120');
gives('as_hours', 'note time.as_hours(90m)', '1.5');
gives('zero', 'note time.as_minutes(0)', '0');
gives('a part of a minute', 'note time.as_minutes(30)', '0.5');
gives('a negative duration', 'note time.as_hours(0 - 3600)', '-1');

describe('time.describe');
gives('zero', 'note time.describe(0)', '0s');
gives('seconds alone', 'note time.describe(30s)', '30s');
gives('minutes and seconds', 'note time.describe(90)', '1m 30s');
gives('hours and minutes', 'note time.describe(2h + 30m)', '2h 30m');
gives('an exact hour skips the rest', 'note time.describe(1h)', '1h');
gives('a whole day', 'note time.describe(1d)', '1d');
gives('every part at once', 'note time.describe(1d + 2h + 3m + 4)', '1d 2h 3m 4s');
gives('a gap in the middle', 'note time.describe(1h + 5)', '1h 5s');
gives('a negative duration keeps its sign', 'note time.describe(0 - 90)', '-1m 30s');
gives('a fraction of a second', 'note time.describe(1.5)', '1.5s');
gives('a week', 'note time.describe(1w)', '7d');

describe('time.clock_text');
gives('an afternoon time', 'note time.clock_text(14:30)', '14:30');
gives('a padded time', 'note time.clock_text(00:03)', '00:03');
gives('midnight', 'note time.clock_text(0)', '00:00');
gives('the last minute of the day', 'note time.clock_text(23:59)', '23:59');
gives('past the end of the day wraps', 'note time.clock_text(25h)', '01:00');
gives('a whole day wraps to midnight', 'note time.clock_text(24h)', '00:00');
gives('before midnight wraps back', 'note time.clock_text(0 - 30m)', '23:30');
gives('a fraction of a second is dropped', 'note time.clock_text(90m + 0.9)', '01:30');

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
