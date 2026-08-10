// Errors that point at the source.
//
// A compiler that says "unexpected token" and stops is a compiler you argue
// with. Every error here carries a position, prints the offending line, and
// puts a caret under the exact column — which costs a few lines once and is
// paid back every time somebody mistypes something.

export class CogError extends Error {
  constructor(message, { file = '<input>', line = 1, column = 1, length = 1, source = '', hint = null } = {}) {
    super(message);
    this.name = 'CogError';
    this.file = file;
    this.line = line;
    this.column = column;
    this.length = Math.max(1, length);
    this.source = source;
    this.hint = hint;
  }

  /** The message a person reads, with the line and a caret under the problem. */
  format() {
    const lines = this.source.split('\n');
    const text = lines[this.line - 1] ?? '';
    const gutter = String(this.line);
    const pad = ' '.repeat(gutter.length);

    const out = [
      `${this.file}:${this.line}:${this.column}  ${this.message}`,
      `${pad} |`,
      `${gutter} | ${text}`,
      `${pad} | ${' '.repeat(Math.max(0, this.column - 1))}${'^'.repeat(this.length)}`,
    ];
    if (this.hint) out.push(`${pad} |`, `${pad} = ${this.hint}`);
    return out.join('\n');
  }
}

export class LexError extends CogError {
  constructor(...args) {
    super(...args);
    this.name = 'LexError';
  }
}

export class ParseError extends CogError {
  constructor(...args) {
    super(...args);
    this.name = 'ParseError';
  }
}

export class ResolveError extends CogError {
  constructor(...args) {
    super(...args);
    this.name = 'ResolveError';
  }
}

/** Raised while a program runs, so it carries the position of the expression. */
export class RuntimeError extends CogError {
  constructor(...args) {
    super(...args);
    this.name = 'RuntimeError';
  }
}

/** Raised by the `fail` statement, and catchable by `rescue`. */
export class CogFailure extends CogError {
  constructor(message, position) {
    super(message, position);
    this.name = 'CogFailure';
  }
}
