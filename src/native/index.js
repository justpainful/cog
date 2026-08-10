// Native modules, as Cog sees them.
//
// A native module is an ordinary Cog module — `bring discord "discord"` binds
// something you read fields off and call verbs on, exactly like a module
// written in Cog. The difference is that the verbs cross a thread boundary and
// come back with the outside world in them.
//
// The whole of that crossing is here: names to operations, Cog values to plain
// ones and back. Nothing above this file knows a worker exists, and nothing
// below it knows what Cog is.

import { bridge } from './bridge.js';
import { NONE, makeVerb } from '../values.js';
import { CogFailure } from '../errors.js';

/** The modules a program may bring, and the operations each one answers to. */
const NATIVE = {
  discord: {
    what: 'Discord, as operations rather than objects',
    // The names are asked of the worker on first use rather than duplicated
    // here, so adding an operation is one edit and not two.
    load: () => bridge().call('discord', 'operations', []),
  },
};

export const isNative = (path) => Object.hasOwn(NATIVE, path);

/** A plain value becomes a Cog value: objects are maps, arrays are lists. */
export function toCog(value) {
  if (value === null || value === undefined) return NONE;
  if (Array.isArray(value)) return value.map(toCog);
  if (typeof value === 'object') {
    const map = new Map();
    for (const [k, v] of Object.entries(value)) map.set(k, toCog(v));
    return map;
  }
  return value;
}

/** And back, because the worker can only be sent things that survive cloning. */
export function fromCog(value) {
  if (value === NONE || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(fromCog);
  if (value instanceof Map) {
    const out = {};
    for (const [k, v] of value) out[String(k)] = fromCog(v);
    return out;
  }
  // A verb, a shape or an entity has no meaning on the other side of the
  // thread, and quietly sending `{}` would be worse than saying so.
  if (value?.tag) throw new Error(`a ${String(value.tag.description ?? 'value')} cannot be handed to a host operation`);
  return value;
}

/**
 * Build the module.
 *
 * Every operation becomes a native verb whose whole body is: convert, call,
 * convert back. The blocking happens inside `call`, which is why none of this
 * has to be written twice for the asynchronous case.
 */
export function nativeModule(path, MODULE) {
  const spec = NATIVE[path];
  if (!spec) return null;

  const exported = new Map();
  const operations = spec.load();

  for (const operation of operations) {
    const verb = makeVerb(`${path}.${operation.name}`, [], null, null);
    verb.native = (args, interpreter, node) => {
      try {
        return toCog(bridge().call(path, operation.name, args.map(fromCog)));
      } catch (problem) {
        // A host refusing something is an ordinary failure, catchable by
        // `attempt`. An agent that cannot rescue a refusal has to succeed at
        // everything it tries, which is not a thing that happens.
        throw new CogFailure(problem.message, {
          file: interpreter?.file ?? '<host>',
          line: node?.line ?? 1,
          column: node?.column ?? 1,
          length: 1,
          source: interpreter?.source ?? '',
        });
      }
    };
    // No arity check: an operation's later arguments are optional often enough
    // that enforcing a count here would be wrong more than it was right, and
    // the operation itself gives a better message than a number would.
    verb.what = operation.what;
    verb.destructive = operation.destructive;
    exported.set(operation.name, verb);
  }

  // Taking events out of the queue. These are not operations on the module —
  // they are how a program says "I am ready for the next thing", which is the
  // whole of Cog's concurrency story and deliberately the whole of it.
  const wait = makeVerb(`${path}.wait`, [], null, null);
  wait.native = (args) => nextEvent(args[0] ?? 0);
  wait.what = 'the next event, waiting up to this many seconds';
  exported.set('wait', wait);

  const pending = makeVerb(`${path}.pending`, [], null, null);
  pending.native = () => pendingEvents();
  pending.what = 'how many events are waiting to be taken';
  exported.set('pending', pending);

  // What the module is, readable from Cog without calling anything.
  exported.set('what', spec.what);
  exported[MODULE] = path;
  return exported;
}

/**
 * The next thing that happened, or none if nothing did within the wait.
 *
 * This is the other half of the design: the gateway keeps receiving while the
 * interpreter is busy, and the interpreter takes events one at a time when it
 * is ready. Nothing interleaves, so no handler ever sees the world change
 * underneath it halfway through.
 */
export function nextEvent(timeoutSeconds = 0) {
  const event = bridge().call('events', 'next', [timeoutSeconds * 1000], {
    timeout: timeoutSeconds > 0 ? timeoutSeconds * 1000 + 5000 : 0,
  });
  return toCog(event);
}

export function pendingEvents() {
  return bridge().call('events', 'pending', []);
}
