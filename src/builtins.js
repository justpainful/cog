// Methods on built-in values, and the handful of global verbs.
//
// These are written in JavaScript because they are the operations Cog cannot
// express about itself — reading a character out of text, sorting a list. The
// standard library proper is written in Cog and sits on top of these.

import { RuntimeError } from './errors.js';
import {
  NONE, makeNative, isVerb, isList, isMap, isText, isNumber, isRecord,
  kindOf, show, equal, truthy,
} from './values.js';

const fail = (interp, message, node, hint = null) => {
  throw new RuntimeError(message, {
    file: interp.file,
    line: node?.line ?? 1,
    column: node?.column ?? 1,
    length: 1,
    source: interp.source,
    hint,
  });
};

/** Methods that take no arguments read as fields: `items.size`, `s.uppercase`. */
const TEXT_METHODS = {
  size: (s) => s.length,
  uppercase: (s) => s.toUpperCase(),
  lowercase: (s) => s.toLowerCase(),
  trimmed: (s) => s.trim(),
  reversed: (s) => [...s].reverse().join(''),
  empty: (s) => s.length === 0,

  has: (s, [needle]) => s.includes(needle),
  starts: (s, [prefix]) => s.startsWith(prefix),
  ends: (s, [suffix]) => s.endsWith(suffix),
  split: (s, [sep]) => s.split(sep),
  replace: (s, [from, to]) => s.split(from).join(to),
  slice: (s, [from, to]) => s.slice(from, to === undefined ? undefined : to),
  repeat: (s, [n]) => s.repeat(Math.max(0, n)),
  padded: (s, [width, filler = ' ']) => s.padStart(width, filler),
};

const LIST_METHODS = {
  size: (xs) => xs.length,
  empty: (xs) => xs.length === 0,
  first: (xs) => (xs.length ? xs[0] : NONE),
  last: (xs) => (xs.length ? xs[xs.length - 1] : NONE),
  reversed: (xs) => [...xs].reverse(),
  sorted: (xs) => [...xs].sort(compareValues),

  has: (xs, [v]) => xs.some((x) => equal(x, v)),
  join: (xs, [sep = ', ']) => xs.map((x) => show(x)).join(sep),
  slice: (xs, [from, to]) => xs.slice(from, to === undefined ? undefined : to),
  plus: (xs, [v]) => [...xs, v],
  without: (xs, [v]) => xs.filter((x) => !equal(x, v)),
  at: (xs, [i]) => (i >= 0 && i < xs.length ? xs[i] : NONE),
};

const MAP_METHODS = {
  size: (m) => m.size,
  empty: (m) => m.size === 0,
  keys: (m) => [...m.keys()],
  values: (m) => [...m.values()],
  pairs: (m) => [...m].map(([k, v]) => [k, v]),

  has: (m, [k]) => m.has(k),
  at: (m, [k]) => (m.has(k) ? m.get(k) : NONE),
  // Maps are mutable in place, but `with` copying keeps a returned map safe.
  with: (m, [k, v]) => new Map([...m, [k, v]]),
  without: (m, [k]) => new Map([...m].filter(([key]) => !equal(key, k))),
};

const NUMBER_METHODS = {
  rounded: (n) => Math.round(n),
  floor: (n) => Math.floor(n),
  ceiling: (n) => Math.ceil(n),
  absolute: (n) => Math.abs(n),
  text: (n) => show(n),
  whole: (n) => Number.isInteger(n),
};

/** Verb-taking methods need the interpreter to call back into Cog. */
const LIST_HIGHER_ORDER = {
  map: (interp, xs, [f], node) => xs.map((x) => interp.invoke(f, [{ name: null, value: x }], node)),
  keep: (interp, xs, [f], node) => xs.filter((x) => truthy(interp.invoke(f, [{ name: null, value: x }], node))),
  drop: (interp, xs, [f], node) => xs.filter((x) => !truthy(interp.invoke(f, [{ name: null, value: x }], node))),
  find: (interp, xs, [f], node) => xs.find((x) => truthy(interp.invoke(f, [{ name: null, value: x }], node))) ?? NONE,
  every: (interp, xs, [f], node) => xs.every((x) => truthy(interp.invoke(f, [{ name: null, value: x }], node))),
  some: (interp, xs, [f], node) => xs.some((x) => truthy(interp.invoke(f, [{ name: null, value: x }], node))),
  fold: (interp, xs, [start, f], node) =>
    xs.reduce((acc, x) => interp.invoke(f, [{ name: null, value: acc }, { name: null, value: x }], node), start),
};

function tableFor(value) {
  if (isText(value)) return TEXT_METHODS;
  if (isList(value)) return LIST_METHODS;
  if (isMap(value)) return MAP_METHODS;
  if (isNumber(value)) return NUMBER_METHODS;
  return null;
}

export function hasMethod(value, name) {
  if (isList(value) && name in LIST_HIGHER_ORDER) return true;
  const table = tableFor(value);
  return table ? name in table : false;
}

export function callMethod(interp, target, name, args, node) {
  const values = args.map((a) => (a.value !== undefined ? a.value : a));

  if (isList(target) && name in LIST_HIGHER_ORDER) {
    const f = values[0];
    if (name !== 'fold' && !isVerb(f)) {
      fail(interp, `${name} needs a verb, found ${kindOf(f)}`, node, `write items.${name}(verb (x) { give … })`);
    }
    if (name === 'fold' && !isVerb(values[1])) {
      fail(interp, 'fold needs a starting value and a verb', node, 'items.fold(0, verb (total, x) { give total + x })');
    }
    return LIST_HIGHER_ORDER[name](interp, target, values, node);
  }

  const table = tableFor(target);
  if (!table || !(name in table)) {
    fail(interp, `${kindOf(target)} has no method "${name}"`, node, suggestMethod(table, name));
  }

  try {
    return table[name](target, values);
  } catch (problem) {
    if (problem instanceof RuntimeError) throw problem;
    fail(interp, `${name} failed: ${problem.message}`, node);
  }
}

function suggestMethod(table, name) {
  if (!table) return null;
  const names = Object.keys(table);
  const close = names.filter((n) => n.startsWith(name[0]) || n.includes(name));
  return close.length ? `did you mean ${close.slice(0, 3).join(', ')}?` : `it has ${names.join(', ')}`;
}

/** Ordering for `sorted`: numbers then text, and anything else by its printout. */
function compareValues(a, b) {
  if (isNumber(a) && isNumber(b)) return a - b;
  if (isText(a) && isText(b)) return a < b ? -1 : a > b ? 1 : 0;
  return show(a) < show(b) ? -1 : 1;
}

export function installBuiltins(scope) {
  const define = (name, arity, fn) => scope.declare(name, makeNative(name, arity, fn), { fixed: true });

  define('size', 1, ([v], interp, node) => {
    if (isText(v) || isList(v)) return v.length;
    if (isMap(v)) return v.size;
    fail(interp, `size needs text, a list or a map, found ${kindOf(v)}`, node);
  });

  define('text', 1, ([v]) => show(v));

  define('number', 1, ([v], interp, node) => {
    if (isNumber(v)) return v;
    if (isText(v)) {
      const n = Number(v.trim());
      if (Number.isNaN(n)) fail(interp, `"${v}" is not a number`, node);
      return n;
    }
    fail(interp, `cannot read ${kindOf(v)} as a number`, node);
  });

  define('range', 2, ([from, to], interp, node) => {
    if (!isNumber(from) || !isNumber(to)) fail(interp, 'range needs two numbers', node);
    const out = [];
    if (from <= to) for (let i = from; i < to; i++) out.push(i);
    else for (let i = from; i > to; i--) out.push(i);
    return out;
  });

  define('kind', 1, ([v]) => kindOf(v));
}
