// The value model.
//
// Values are plain JavaScript where the semantics line up and wrapped where
// they do not. Text, numbers and truth are JS strings, numbers and booleans;
// `none` is null. Lists are arrays and maps are Map, so key order is insertion
// order and a number key stays distinct from the text of that number.
//
// Records, verbs and entities are tagged objects, because the interpreter has
// to tell them apart and JS has no way to ask "is this a Cog record".

export const NONE = null;

export const RECORD = Symbol('record');
export const VERB = Symbol('verb');
export const ENTITY = Symbol('entity');
export const SHAPE = Symbol('shape');

export const makeShape = (name, fields) => ({ tag: SHAPE, name, fields });

export const makeRecord = (shape, values) => ({ tag: RECORD, shape, values });

export const makeVerb = (name, params, body, closure, { agent = false } = {}) => ({
  tag: VERB,
  name,
  params,
  body,
  closure,
  agent,
});

export const makeNative = (name, arity, fn) => ({ tag: VERB, name, native: fn, arity, params: [] });

export const makeEntity = (name, argument = null, fields = {}) => ({
  tag: ENTITY,
  name,
  argument,
  fields,
});

export const isRecord = (v) => v?.tag === RECORD;
export const isVerb = (v) => v?.tag === VERB;
export const isEntity = (v) => v?.tag === ENTITY;
export const isShape = (v) => v?.tag === SHAPE;
export const isList = (v) => Array.isArray(v);
export const isMap = (v) => v instanceof Map;
export const isText = (v) => typeof v === 'string';
export const isNumber = (v) => typeof v === 'number';
export const isTruth = (v) => typeof v === 'boolean';

/**
 * Only `no` and `none` are false.
 *
 * Zero and empty text are true on purpose: "is this list empty" should be
 * written `items.size is 0`, which says what it means, rather than `not items`,
 * which relies on knowing a coercion table.
 */
export const truthy = (v) => v !== false && v !== null && v !== undefined;

/** The name of a value's kind, for error messages. */
export function kindOf(v) {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'string') return 'text';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'truth';
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'map';
  if (v.tag === RECORD) return v.shape.name;
  if (v.tag === VERB) return 'verb';
  if (v.tag === ENTITY) return 'entity';
  if (v.tag === SHAPE) return 'shape';
  return 'value';
}

/**
 * How a value prints — from `note`, from interpolation, and in test output.
 * Text prints as itself with no quotes; everything else is unambiguous.
 */
export function show(v, seen = new Set()) {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return formatNumber(v);

  // A list that contains itself would otherwise recurse forever.
  if (seen.has(v)) return '…';
  const nested = new Set(seen).add(v);

  if (Array.isArray(v)) return `[${v.map((x) => quoted(x, nested)).join(', ')}]`;
  if (v instanceof Map) {
    if (v.size === 0) return '[:]';
    return `[${[...v].map(([k, val]) => `${show(k, nested)}: ${quoted(val, nested)}`).join(', ')}]`;
  }
  if (v.tag === RECORD) {
    const inner = [...v.values].map(([k, val]) => `${k}: ${quoted(val, nested)}`).join(', ');
    return `${v.shape.name}(${inner})`;
  }
  if (v.tag === VERB) return `verb ${v.name ?? '(anonymous)'}`;
  if (v.tag === ENTITY) return v.argument === null ? `@${v.name}` : `@${v.name}(${quoted(v.argument, nested)})`;
  if (v.tag === SHAPE) return `shape ${v.name}`;
  return String(v);
}

/** Inside a container, text is quoted so `[1]` and `["1"]` differ on sight. */
const quoted = (v, seen) => (typeof v === 'string' ? JSON.stringify(v) : show(v, seen));

function formatNumber(n) {
  if (Number.isInteger(n)) return String(n);
  // Trim the float noise that makes 0.1 + 0.2 unreadable, without pretending
  // the arithmetic was exact.
  const rounded = Number(n.toPrecision(15));
  return String(rounded);
}

/** Value equality for `is` and `isnt`. */
export function equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return a === b;

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k) || !equal(v, b.get(k))) return false;
    }
    return true;
  }
  if (isRecord(a) && isRecord(b)) {
    if (a.shape !== b.shape) return false;
    for (const [k, v] of a.values) {
      if (!equal(v, b.values.get(k))) return false;
    }
    return true;
  }
  if (isEntity(a) && isEntity(b)) return a.name === b.name && equal(a.argument, b.argument);
  return false;
}
