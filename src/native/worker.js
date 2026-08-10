// The thread that is allowed to touch the outside world.
//
// Everything asynchronous lives here: HTTP, websockets, timers, rate-limit
// waits. The interpreter never sees any of it. A request arrives as a message,
// is awaited here, and the answer is put back on the port before the doorbell
// is rung — so by the time the main thread wakes, the value is already there.
//
// Nothing in this file knows what Cog is. It takes {module, op, args} and
// returns a value, which is the whole contract.

import { parentPort, workerData } from 'node:worker_threads';
import { discord } from './discord/module.js';

const { port, signal } = workerData;
const doorbell = new Int32Array(signal);

/** Native modules, by the name a Cog program brings them under. */
const MODULES = { discord };

/**
 * Events the host produced while nobody was asking. The gateway does not wait
 * for permission to receive, so anything that arrives between calls queues here
 * and `events.next` hands them over one at a time, in order.
 */
const inbox = [];
let waiting = null;

export function deliver(event) {
  inbox.push(event);
  if (waiting) {
    const resolve = waiting;
    waiting = null;
    resolve();
  }
}

/** Blocks the worker, not the main thread, until something arrives. */
async function nextEvent(timeoutMs) {
  if (inbox.length) return inbox.shift();
  await new Promise((resolve) => {
    waiting = resolve;
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (waiting === resolve) {
          waiting = null;
          resolve();
        }
      }, timeoutMs).unref();
    }
  });
  return inbox.length ? inbox.shift() : null;
}

const answer = (id, ok, payload) => {
  port.postMessage(ok ? { id, ok: true, value: payload } : { id, ok: false, error: payload });
  Atomics.store(doorbell, 0, 1);
  Atomics.notify(doorbell, 0);
};

port.on('message', async ({ id, module, op, args }) => {
  if (op === '__close__') {
    for (const m of Object.values(MODULES)) await m.close?.();
    process.exit(0);
  }

  try {
    // The event queue is not a module — it is how the host talks back, and
    // every module feeds the same one.
    if (module === 'events') {
      if (op === 'next') return answer(id, true, await nextEvent(args[0] ?? 0));
      if (op === 'pending') return answer(id, true, inbox.length);
      if (op === 'drain') {
        const all = inbox.splice(0, inbox.length);
        return answer(id, true, all);
      }
      throw new Error(`the event queue has no operation "${op}"`);
    }

    const target = MODULES[module];
    if (!target) throw new Error(`there is no native module "${module}"`);

    const operation = target.operations[op];
    if (!operation) {
      throw new Error(
        `"${module}" has no operation "${op}". It has ${Object.keys(target.operations).join(', ')}`,
      );
    }

    answer(id, true, await operation.run(...args));
  } catch (problem) {
    answer(id, false, {
      name: problem.name ?? 'HostError',
      message: problem.message ?? String(problem),
      detail: problem.detail ?? null,
    });
  }
});

// Give every module the one channel it has for pushing events upward.
for (const m of Object.values(MODULES)) m.emit = deliver;

parentPort?.unref?.();
