// Synchronous calls out of a synchronous interpreter.
//
// Cog's interpreter is a tree walker with no async anywhere, and that is worth
// keeping. Behaviour code that has to say `await` before every effect is
// behaviour code with a second, invisible subject — the event loop — and an
// agent describing what should happen has no business knowing about it.
//
// So the I/O goes somewhere else. A worker thread owns every socket and every
// request; the main thread posts a message, blocks on Atomics.wait, and reads
// the reply back with receiveMessageOnPort, which is synchronous. From inside
// Cog, `discord.send(…)` is an ordinary call that returns an ordinary value.
//
// What this buys, beyond looking nicer: one handler runs at a time, to
// completion. Two events cannot interleave halfway through changing the same
// thing. For a system whose whole point is that state is inspectable, that is
// a correctness property and not a convenience.
//
// What it costs: throughput. A blocked main thread is doing nothing else. That
// is the right trade here and would be the wrong one for a chat client.

import { Worker, receiveMessageOnPort, MessageChannel } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Int32Array[0] is the doorbell: 0 means "nothing waiting", 1 means "reply is
// on the port". Atomics.wait sleeps the thread properly rather than spinning.
const IDLE = 0;
const READY = 1;

export class Bridge {
  #worker = null;
  #port = null;
  #signal = null;
  #next = 1;
  #closed = false;

  /** Starts the worker on first use, so a program that never calls out pays nothing. */
  #open() {
    if (this.#worker) return;

    const shared = new SharedArrayBuffer(4);
    this.#signal = new Int32Array(shared);

    const { port1, port2 } = new MessageChannel();
    this.#port = port1;

    this.#worker = new Worker(join(HERE, 'worker.js'), {
      workerData: { port: port2, signal: shared },
      transferList: [port2],
      // Errors surface as a failed call rather than as an unhandled event on a
      // thread nobody is watching.
      stdout: false,
      stderr: false,
    });

    // Nothing here should keep the process alive on its own. The main thread
    // decides when the program is over.
    this.#worker.unref();
    this.#port.unref();
  }

  /**
   * Call an operation and wait for it.
   *
   * @param {string} module   which native module
   * @param {string} op       the operation on it
   * @param {any[]} args      already converted to plain JSON-able values
   * @param {number} timeout  milliseconds, or 0 to wait as long as it takes
   */
  call(module, op, args, { timeout = 60_000 } = {}) {
    if (this.#closed) throw new Error('this bridge has been closed');
    this.#open();

    const id = this.#next++;
    Atomics.store(this.#signal, 0, IDLE);
    this.#port.postMessage({ id, module, op, args });

    // A worker that dies mid-call would otherwise leave the main thread asleep
    // forever, so every wait has an end.
    const verdict = Atomics.wait(this.#signal, 0, IDLE, timeout === 0 ? Infinity : timeout);
    if (verdict === 'timed-out') {
      throw new Error(`${module}.${op} did not answer within ${timeout / 1000}s`);
    }

    const message = receiveMessageOnPort(this.#port);
    if (!message) throw new Error(`${module}.${op} was signalled but sent nothing back`);

    const reply = message.message;
    if (reply.id !== id) {
      throw new Error(`out of step: asked for ${id}, heard ${reply.id}`);
    }
    if (!reply.ok) {
      const error = new Error(reply.error.message);
      error.name = reply.error.name ?? 'HostError';
      error.detail = reply.error.detail ?? null;
      error.fromHost = true;
      throw error;
    }
    return reply.value;
  }

  /** True once the worker exists, which is the only way to know I/O happened. */
  get started() {
    return this.#worker !== null;
  }

  close() {
    this.#closed = true;
    if (!this.#worker) return;
    try {
      this.#port.postMessage({ id: 0, module: '', op: '__close__', args: [] });
    } catch {
      // The worker is already gone, which is the state we wanted anyway.
    }
    this.#worker.terminate();
    this.#worker = null;
    this.#port = null;
  }
}

/** One bridge per process. Native modules share it, as they share the worker. */
let shared = null;

export function bridge() {
  if (!shared) shared = new Bridge();
  return shared;
}

export function closeBridge() {
  if (shared) shared.close();
  shared = null;
}
