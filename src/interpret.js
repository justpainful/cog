// The tree-walking interpreter.
//
// `cog run` executes a program here with no host runtime involved. Agent
// statements are the exception: they describe effects on something outside the
// program, so under `cog run` they refuse with a message naming `cog build`
// rather than pretending to do something.
//
// Control flow uses thrown signals rather than return codes. `give` from inside
// three nested blocks has to unwind them all, and threading a sentinel back
// through every eval site is how interpreters acquire bugs in the seams.

import { RuntimeError, CogFailure } from './errors.js';
import {
  NONE, makeShape, makeRecord, makeVerb, makeEntity,
  isRecord, isVerb, isEntity, isShape, isList, isMap, isText, isNumber,
  truthy, kindOf, show, equal,
} from './values.js';
import { installBuiltins, callMethod, hasMethod } from './builtins.js';

// Marks a Map as a module, so a missing name can name the module it is
// missing from. A plain map's missing key stays `none`.
const MODULE = Symbol('module');

// ---- control flow signals ---------------------------------------------------

class GiveSignal {
  constructor(value) {
    this.value = value;
  }
}
class StopSignal {}
class NextSignal {}

// ---- scopes -----------------------------------------------------------------

class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.values = new Map();
    this.fixed = new Set();
  }

  declare(name, value, { fixed = false } = {}) {
    this.values.set(name, value);
    if (fixed) this.fixed.add(name);
    else this.fixed.delete(name);
  }

  has(name) {
    return this.values.has(name) || (this.parent?.has(name) ?? false);
  }

  get(name) {
    if (this.values.has(name)) return this.values.get(name);
    if (this.parent) return this.parent.get(name);
    return undefined;
  }

  /** Assignment walks up to the scope that owns the name. */
  set(name, value) {
    if (this.values.has(name)) {
      if (this.fixed.has(name)) return { ok: false, reason: 'held' };
      this.values.set(name, value);
      return { ok: true };
    }
    if (this.parent) return this.parent.set(name, value);
    return { ok: false, reason: 'unbound' };
  }
}

// ---- the interpreter --------------------------------------------------------

export class Interpreter {
  /**
   * @param options.output  where `note` writes; defaults to stdout
   * @param options.load    resolves a `bring` path to source text
   */
  constructor({ output = (line) => console.log(line), load = null, file = '<input>', source = '' } = {}) {
    this.output = output;
    this.load = load;
    this.file = file;
    this.source = source;
    this.globals = new Scope();
    this.modules = new Map();
    this.loading = new Set();
    installBuiltins(this.globals);
  }

  fail(message, node, hint = null) {
    return new RuntimeError(message, {
      file: this.file,
      line: node?.line ?? 1,
      column: node?.column ?? 1,
      length: 1,
      source: this.source,
      hint,
    });
  }

  run(program) {
    const scope = new Scope(this.globals);
    // Verbs and shapes are hoisted, so a verb may call one declared below it.
    this.hoist(program.body, scope);
    for (const statement of program.body) this.exec(statement, scope);
    return scope;
  }

  hoist(body, scope) {
    for (const node of body) {
      if (node.kind === 'Verb') {
        scope.declare(node.name, makeVerb(node.name, node.params, node.body, scope), { fixed: true });
      } else if (node.kind === 'Shape') {
        scope.declare(node.name, makeShape(node.name, node.fields), { fixed: true });
      } else if (node.kind === 'Share') {
        this.hoist([node.declaration], scope);
      }
    }
  }

  // ---- statements -----------------------------------------------------------

  exec(node, scope) {
    switch (node.kind) {
      case 'Hold':
      case 'Carry': {
        if (scope.values.has(node.name)) {
          throw this.fail(`"${node.name}" is already bound in this block`, node, 'pick another name, or assign to it');
        }
        scope.declare(node.name, this.eval(node.value, scope), { fixed: node.kind === 'Hold' });
        return;
      }

      case 'Assign': return this.assign(node, scope);

      case 'ExpressionStatement': {
        this.eval(node.expression, scope);
        return;
      }

      case 'Verb': {
        scope.declare(node.name, makeVerb(node.name, node.params, node.body, scope), { fixed: true });
        return;
      }

      case 'Shape': {
        scope.declare(node.name, makeShape(node.name, node.fields), { fixed: true });
        return;
      }

      case 'Share': return this.exec(node.declaration, scope);

      case 'Bring': return this.bring(node, scope);

      case 'Block': {
        const inner = new Scope(scope);
        this.hoist(node.body, inner);
        for (const statement of node.body) this.exec(statement, inner);
        return;
      }

      case 'When': {
        if (truthy(this.eval(node.test, scope))) this.exec(node.body, scope);
        else if (node.alternate) this.exec(node.alternate, scope);
        return;
      }

      case 'Each': return this.each(node, scope);

      case 'RepeatUntil': {
        let guard = 0;
        while (!truthy(this.eval(node.test, scope))) {
          if (++guard > 10_000_000) throw this.fail('this loop has run ten million times and is probably stuck', node);
          try {
            this.exec(node.body, scope);
          } catch (signal) {
            if (signal instanceof StopSignal) break;
            if (!(signal instanceof NextSignal)) throw signal;
          }
        }
        return;
      }

      case 'RepeatTimes': {
        const count = this.eval(node.count, scope);
        if (!isNumber(count)) {
          throw this.fail(`repeat needs a number of times, found ${kindOf(count)}`, node.count);
        }
        for (let i = 0; i < count; i++) {
          try {
            this.exec(node.body, scope);
          } catch (signal) {
            if (signal instanceof StopSignal) break;
            if (!(signal instanceof NextSignal)) throw signal;
          }
        }
        return;
      }

      case 'Give': throw new GiveSignal(node.value ? this.eval(node.value, scope) : NONE);
      case 'Stop': throw new StopSignal();
      case 'Next': throw new NextSignal();

      case 'Fail': {
        const value = this.eval(node.value, scope);
        throw new CogFailure(show(value), {
          file: this.file, line: node.line, column: node.column, length: 1, source: this.source,
        });
      }

      case 'Attempt': return this.attempt(node, scope);

      case 'Note': {
        this.output(show(this.eval(node.value, scope)));
        return;
      }

      // Everything below describes an effect on a host runtime.
      case 'Say': case 'Post': case 'Tell': case 'Make': case 'Thread':
      case 'Rename': case 'Grant': case 'Revoke': case 'Permission':
      case 'React': case 'Count': case 'Panel': case 'Ask': case 'Needs':
      case 'Intent': case 'On': case 'Every': case 'Presence': case 'Command':
        throw this.fail(
          `"${this.effectName(node)}" acts on a host runtime, and cog run has none`,
          node,
          'use cog build to lower agent declarations onto a host, or cog check to validate them',
        );

      default:
        throw this.fail(`cannot execute a ${node.kind}`, node);
    }
  }

  effectName(node) {
    const names = {
      Say: 'say', Post: 'post', Tell: 'tell', Make: 'make', Thread: 'thread',
      Rename: 'rename', Grant: 'grant', Revoke: 'revoke', Permission: 'show/hide',
      React: 'react', Count: 'count', Panel: 'panel', Ask: 'ask', Needs: 'needs',
      Intent: 'intent', On: 'on', Every: 'every',
      Presence: 'presence', Command: 'command',
    };
    return names[node.kind] ?? node.kind;
  }

  assign(node, scope) {
    const value = this.eval(node.value, scope);
    const target = node.target;

    if (target.kind === 'Name') {
      const result = scope.set(target.name, value);
      if (result.reason === 'held') {
        throw this.fail(`"${target.name}" was held and cannot be reassigned`, node, 'use carry instead of hold if it needs to change');
      }
      if (result.reason === 'unbound') {
        throw this.fail(`"${target.name}" is not bound`, node, `write hold ${target.name} = … or carry ${target.name} = … first`);
      }
      return;
    }

    if (target.kind === 'Index') {
      const container = this.eval(target.target, scope);
      const index = this.eval(target.index, scope);
      if (isList(container)) {
        if (!isNumber(index)) throw this.fail(`a list index must be a number, found ${kindOf(index)}`, target.index);
        container[index] = value;
        return;
      }
      if (isMap(container)) {
        container.set(index, value);
        return;
      }
      throw this.fail(`cannot index into ${kindOf(container)}`, target);
    }

    if (target.kind === 'Field') {
      throw this.fail(
        'records cannot be changed in place',
        node,
        'use change to make a copy: hold updated = record.change(field: value)',
      );
    }

    throw this.fail('this cannot be assigned to', node);
  }

  each(node, scope) {
    const subject = this.eval(node.subject, scope);
    const iterate = (entries) => {
      for (const [key, value] of entries) {
        const inner = new Scope(scope);
        if (node.key) inner.declare(node.key, key);
        inner.declare(node.value, value);
        try {
          this.exec(node.body, inner);
        } catch (signal) {
          if (signal instanceof StopSignal) return;
          if (!(signal instanceof NextSignal)) throw signal;
        }
      }
    };

    if (isList(subject)) return iterate(subject.map((v, i) => [i, v]));
    if (isMap(subject)) return iterate([...subject]);
    if (isText(subject)) return iterate([...subject].map((c, i) => [i, c]));
    throw this.fail(`each needs a list, a map or text, found ${kindOf(subject)}`, node.subject);
  }

  attempt(node, scope) {
    try {
      this.exec(node.body, scope);
    } catch (problem) {
      // A give or a loop signal is control flow passing through, not a failure.
      if (problem instanceof GiveSignal || problem instanceof StopSignal || problem instanceof NextSignal) throw problem;
      if (!(problem instanceof CogFailure) && !(problem instanceof RuntimeError)) throw problem;

      const inner = new Scope(scope);
      const record = new Map([
        ['message', problem.message],
        ['where', `${problem.file}:${problem.line}:${problem.column}`],
      ]);
      inner.declare(node.binding, makeRecord(makeShape('Problem', [{ name: 'message' }, { name: 'where' }]), record), { fixed: true });
      this.exec(node.handler, inner);
    }
  }

  bring(node, scope) {
    if (!this.load) {
      throw this.fail(`cannot bring "${node.path}" — this interpreter has no module loader`, node);
    }
    if (this.modules.has(node.path)) {
      scope.declare(node.name, this.modules.get(node.path), { fixed: true });
      return;
    }
    if (this.loading.has(node.path)) {
      throw this.fail(`"${node.path}" imports itself, directly or through another module`, node);
    }

    const source = this.load(node.path, node);
    if (source === null || source === undefined) {
      throw this.fail(`cannot find module "${node.path}"`, node, 'paths starting std/ are the standard library; others are relative to this file');
    }

    this.loading.add(node.path);
    const exported = new Map();
    try {
      // A module gets its own interpreter so its file and source appear in its
      // own errors rather than the importer's.
      const child = new Interpreter({ output: this.output, load: this.load, file: node.path, source });
      child.modules = this.modules;
      child.loading = this.loading;

      const { parse } = parserRef;
      const ast = parse(source, node.path);
      const moduleScope = new Scope(child.globals);
      child.hoist(ast.body, moduleScope);
      for (const statement of ast.body) child.exec(statement, moduleScope);

      for (const declaration of ast.body) {
        if (declaration.kind !== 'Share') continue;
        const name = declaration.declaration.name;
        exported.set(name, moduleScope.get(name));
      }
    } finally {
      this.loading.delete(node.path);
    }

    exported[MODULE] = node.path;
    this.modules.set(node.path, exported);
    scope.declare(node.name, exported, { fixed: true });
  }

  // ---- expressions ----------------------------------------------------------

  eval(node, scope) {
    switch (node.kind) {
      case 'Number': return node.value;
      case 'Truth': return node.value;
      case 'None': return NONE;
      case 'Duration': return node.seconds;
      // Seconds since midnight, so a clock and a duration share one unit.
      // They were minutes and seconds respectively, both bare numbers, which
      // made time.describe(14:30) answer "14m 30s" with nothing to catch it.
      case 'Clock': return node.hours * 3600 + node.minutes * 60;

      case 'Text': return this.text(node, scope);

      case 'List': return node.items.map((item) => this.eval(item, scope));

      case 'Map': {
        const map = new Map();
        for (const entry of node.entries) {
          // A bare name as a map key is the key's text, as in Swift.
          const key = entry.key.kind === 'Name' ? entry.key.name : this.eval(entry.key, scope);
          map.set(key, this.eval(entry.value, scope));
        }
        return map;
      }

      case 'Name': {
        if (!scope.has(node.name)) {
          throw this.fail(`"${node.name}" is not bound`, node, this.suggest(node.name, scope));
        }
        return scope.get(node.name);
      }

      case 'Entity': return makeEntity(node.name, node.argument ? this.eval(node.argument, scope) : null);

      case 'VerbValue': return makeVerb(null, node.params, node.body, scope);

      case 'WhenValue': {
        const branch = truthy(this.eval(node.test, scope)) ? node.consequent : node.alternate;
        return this.blockValue(branch, scope);
      }

      case 'Unary': {
        const operand = this.eval(node.operand, scope);
        if (node.operator === 'not') return !truthy(operand);
        if (!isNumber(operand)) throw this.fail(`cannot negate ${kindOf(operand)}`, node);
        return -operand;
      }

      case 'Logical': {
        const left = this.eval(node.left, scope);
        if (node.operator === 'and') return truthy(left) ? this.eval(node.right, scope) : left;
        return truthy(left) ? left : this.eval(node.right, scope);
      }

      case 'Compare': return this.compare(node, scope);
      case 'Binary': return this.binary(node, scope);

      case 'Field': return this.field(node, scope);
      case 'Index': return this.index(node, scope);
      case 'Call': return this.call(node, scope);

      case 'PredHas': case 'PredIs': case 'PredExists': case 'PredAbsent':
      case 'PredAll': case 'PredAny': case 'PredNot':
        throw this.fail(
          'this asks a host runtime a question, and cog run has none',
          node,
          'predicates belong to the agent layer; use cog build to lower them onto a host',
        );

      default:
        throw this.fail(`cannot evaluate a ${node.kind}`, node);
    }
  }

  /** A block used as a value yields its last expression statement. */
  blockValue(block, scope) {
    const inner = new Scope(scope);
    this.hoist(block.body, inner);
    let last = NONE;
    for (const statement of block.body) {
      if (statement.kind === 'ExpressionStatement') last = this.eval(statement.expression, inner);
      else {
        this.exec(statement, inner);
        last = NONE;
      }
    }
    return last;
  }

  text(node, scope) {
    let out = '';
    for (const part of node.parts) {
      if (part.kind === 'literal') {
        out += part.value;
        continue;
      }
      out += show(this.interpolate(part, scope));
    }
    return out;
  }

  /**
   * A bare `@path` in text is a binding if one exists, and an entity otherwise.
   * Both readings appear in the specification and only one of them can be right
   * for any given program, so the presence of a binding decides.
   */
  interpolate(part, scope) {
    if (part.expression) return this.eval(part.expression, scope);

    const [head, ...rest] = part.path;
    const position = { line: part.line, column: part.column };

    let value;
    if (scope.has(head)) value = scope.get(head);
    else value = makeEntity(head, null);

    for (const name of rest) {
      value = this.readField(value, name, position);
    }
    return value;
  }

  compare(node, scope) {
    const left = this.eval(node.left, scope);
    const right = this.eval(node.right, scope);

    if (node.operator === 'is') return equal(left, right);
    if (node.operator === 'isnt') return !equal(left, right);

    // Ordering is defined for numbers and for text, and for nothing else —
    // comparing a list to a number is a mistake, not a question.
    const comparable = (isNumber(left) && isNumber(right)) || (isText(left) && isText(right));
    if (!comparable) {
      throw this.fail(
        `cannot compare ${kindOf(left)} with ${kindOf(right)} using ${node.operator}`,
        node,
        'ordering works on two numbers or two texts',
      );
    }
    switch (node.operator) {
      case '<': return left < right;
      case '>': return left > right;
      case '<=': return left <= right;
      case '>=': return left >= right;
      default: throw this.fail(`unknown comparison ${node.operator}`, node);
    }
  }

  binary(node, scope) {
    const left = this.eval(node.left, scope);
    const right = this.eval(node.right, scope);
    const op = node.operator;

    if (op === '+') {
      if (isNumber(left) && isNumber(right)) return left + right;
      if (isText(left) && isText(right)) return left + right;
      if (isList(left) && isList(right)) return [...left, ...right];
      // Deliberately not coercing: "n: @count" says what was meant.
      throw this.fail(
        `cannot add ${kindOf(left)} to ${kindOf(right)}`,
        node,
        isText(left) || isText(right) ? 'to build text from a value, interpolate it: "n: @value"' : null,
      );
    }

    if (!isNumber(left) || !isNumber(right)) {
      throw this.fail(`cannot use ${op} on ${kindOf(left)} and ${kindOf(right)}`, node);
    }
    switch (op) {
      case '-': return left - right;
      case '*': return left * right;
      case '/':
        if (right === 0) throw this.fail('cannot divide by zero', node);
        return left / right;
      case '%':
        if (right === 0) throw this.fail('cannot take a remainder by zero', node);
        return left % right;
      default: throw this.fail(`unknown operator ${op}`, node);
    }
  }

  field(node, scope) {
    const target = this.eval(node.target, scope);
    return this.readField(target, node.name, node);
  }

  readField(target, name, node) {
    if (isRecord(target)) {
      if (!target.values.has(name)) {
        throw this.fail(
          `${target.shape.name} has no field "${name}"`,
          node,
          `it has ${[...target.values.keys()].join(', ')}`,
        );
      }
      return target.values.get(name);
    }

    if (isMap(target)) {
      if (target.has(name)) return target.get(name);
      if (hasMethod(target, name)) return callMethod(this, target, name, [], node);

      // A module is a map of shared names and knows every one of them, so a
      // typo is knowable rather than something to discover as `none` later.
      if (target[MODULE]) {
        throw this.fail(
          `"${target[MODULE]}" does not share "${name}"`,
          node,
          `it shares ${[...target.keys()].sort().join(', ')}`,
        );
      }
      return NONE;
    }

    if (isEntity(target)) {
      // Entities are host handles. Under cog run there is no host, so a field
      // read produces a placeholder rather than a lie about a real value.
      return `@${target.name}.${name}`;
    }

    if (hasMethod(target, name)) return callMethod(this, target, name, [], node);

    throw this.fail(`${kindOf(target)} has no field "${name}"`, node);
  }

  index(node, scope) {
    const target = this.eval(node.target, scope);
    const key = this.eval(node.index, scope);

    if (isList(target)) {
      if (!isNumber(key)) throw this.fail(`a list index must be a number, found ${kindOf(key)}`, node.index);
      const at = key < 0 ? target.length + key : key;
      return at >= 0 && at < target.length ? target[at] : NONE;
    }
    if (isMap(target)) return target.has(key) ? target.get(key) : NONE;
    if (isText(target)) {
      if (!isNumber(key)) throw this.fail(`a text index must be a number, found ${kindOf(key)}`, node.index);
      return target[key] ?? NONE;
    }
    throw this.fail(`cannot index into ${kindOf(target)}`, node);
  }

  call(node, scope) {
    // A method call reads as a field access followed by a call, so it is
    // intercepted here where both halves are still visible.
    if (node.callee.kind === 'Field') {
      const target = this.eval(node.callee.target, scope);
      const name = node.callee.name;
      const args = node.args.map((a) => ({ name: a.name, value: this.eval(a.value, scope) }));

      if (isRecord(target) && name === 'change') return this.changeRecord(target, args, node);
      if (isMap(target) && target.has(name) && isVerb(target.get(name))) {
        return this.invoke(target.get(name), args, node);
      }
      if (hasMethod(target, name)) return callMethod(this, target, name, args, node);

      // Read the field only if one could plausibly hold a verb. Otherwise the
      // field error wins the race and reports a missing field for something
      // that was written as a call.
      if (isRecord(target) || isMap(target)) {
        const value = this.readField(target, name, node);
        if (isVerb(value)) return this.invoke(value, args, node);
      }
      throw this.fail(`${kindOf(target)} has no method "${name}"`, node);
    }

    const callee = this.eval(node.callee, scope);
    const args = node.args.map((a) => ({ name: a.name, value: this.eval(a.value, scope) }));

    if (isShape(callee)) return this.construct(callee, args, node);
    if (!isVerb(callee)) throw this.fail(`${kindOf(callee)} is not something you can call`, node);
    return this.invoke(callee, args, node);
  }

  construct(shape, args, node) {
    const values = new Map();
    const known = new Set(shape.fields.map((f) => f.name));

    for (const arg of args) {
      if (!arg.name) {
        throw this.fail(
          `${shape.name} is built with named fields`,
          node,
          `write ${shape.name}(${shape.fields[0]?.name ?? 'field'}: value)`,
        );
      }
      if (!known.has(arg.name)) {
        throw this.fail(`${shape.name} has no field "${arg.name}"`, node, `it has ${[...known].join(', ')}`);
      }
      values.set(arg.name, arg.value);
    }

    for (const field of shape.fields) {
      if (values.has(field.name)) continue;
      if (field.fallback) {
        values.set(field.name, this.eval(field.fallback, this.globals));
        continue;
      }
      throw this.fail(`${shape.name} needs a value for "${field.name}"`, node);
    }

    // Field order follows the shape, not the call, so records print predictably.
    const ordered = new Map(shape.fields.map((f) => [f.name, values.get(f.name)]));
    return makeRecord(shape, ordered);
  }

  changeRecord(record, args, node) {
    const values = new Map(record.values);
    for (const arg of args) {
      if (!arg.name) throw this.fail('change takes named fields', node, 'record.change(field: value)');
      if (!values.has(arg.name)) {
        throw this.fail(`${record.shape.name} has no field "${arg.name}"`, node, `it has ${[...values.keys()].join(', ')}`);
      }
      values.set(arg.name, arg.value);
    }
    return makeRecord(record.shape, values);
  }

  invoke(verb, args, node) {
    if (verb.native) {
      const positional = args.map((a) => a.value);
      if (verb.arity !== undefined && positional.length !== verb.arity) {
        throw this.fail(
          `${verb.name} takes ${verb.arity} argument${verb.arity === 1 ? '' : 's'}, given ${positional.length}`,
          node,
        );
      }
      return verb.native(positional, this, node);
    }

    const scope = new Scope(verb.closure);
    const positional = args.filter((a) => !a.name);
    const named = new Map(args.filter((a) => a.name).map((a) => [a.name, a.value]));

    if (positional.length > verb.params.length) {
      throw this.fail(
        `${verb.name ?? 'this verb'} takes ${verb.params.length} argument${verb.params.length === 1 ? '' : 's'}, given ${positional.length}`,
        node,
      );
    }

    verb.params.forEach((param, i) => {
      let value;
      if (i < positional.length) value = positional[i].value;
      else if (named.has(param.name)) value = named.get(param.name);
      else if (param.fallback) value = this.eval(param.fallback, scope);
      else {
        throw this.fail(`${verb.name ?? 'this verb'} needs a value for "${param.name}"`, node);
      }
      scope.declare(param.name, value);
    });

    for (const key of named.keys()) {
      if (!verb.params.some((p) => p.name === key)) {
        throw this.fail(`${verb.name ?? 'this verb'} has no parameter "${key}"`, node);
      }
    }

    try {
      this.exec(verb.body, scope);
    } catch (signal) {
      if (signal instanceof GiveSignal) return signal.value;
      if (signal instanceof StopSignal || signal instanceof NextSignal) {
        throw this.fail('stop and next only work inside a loop', node);
      }
      throw signal;
    }
    return NONE;
  }

  /** "did you mean" for an unbound name, using edit distance one or two. */
  suggest(name, scope) {
    const candidates = [];
    for (let s = scope; s; s = s.parent) candidates.push(...s.values.keys());
    const close = candidates.filter((c) => distance(c, name) <= 2 && c !== name);
    if (!close.length) return null;
    return `did you mean ${close.slice(0, 3).map((c) => `"${c}"`).join(' or ')}?`;
  }
}

function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

// Set by cli.js to avoid a cycle: the interpreter needs the parser only for
// `bring`, and the parser does not need the interpreter at all.
const parserRef = {};
export const useParser = (parse) => {
  parserRef.parse = parse;
};
