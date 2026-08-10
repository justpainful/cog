// Source text to tokens.
//
// Newlines are insignificant, so there is no layout rule and no semicolons —
// statements are delimited by their own shape. That is a deliberate cost: the
// parser has to be written so every statement knows where it ends.
//
// Text literals are lexed into parts rather than a flat string, because `@name`
// inside text is an interpolation and the parser needs its position to report
// an error inside it. `@@` is a literal at-sign and must not be mistaken for
// one, which is the single easiest thing to get wrong here.

import { LexError } from './errors.js';
import { HARD } from './keywords.js';

export const T = {
  NUMBER: 'number',
  TEXT: 'text',
  DURATION: 'duration',
  CLOCK: 'clock',
  IDENT: 'ident',
  KEYWORD: 'keyword',
  ENTITY: 'entity',
  PUNCT: 'punct',
  OP: 'op',
  EOF: 'eof',
};

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ',', '.', ':']);
const DURATION_UNITS = new Set(['s', 'm', 'h', 'd', 'w']);

// Unicode-aware, so an identifier may be Arabic, Cyrillic or anything else.
const isLetter = (ch) => ch === '_' || /\p{L}/u.test(ch);
const isDigit = (ch) => ch >= '0' && ch <= '9';
const isIdentPart = (ch) => isLetter(ch) || isDigit(ch);

export function tokenize(source, file = '<input>') {
  const tokens = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const column = () => i - lineStart + 1;
  const here = (len = 1) => ({ file, line, column: column(), length: len, source });
  const at = (offset = 0) => source[i + offset];

  const fail = (message, hint = null, len = 1) => {
    throw new LexError(message, { ...here(len), hint });
  };

  const push = (type, value, startLine, startCol, extra = {}) => {
    tokens.push({ type, value, line: startLine, column: startCol, ...extra });
  };

  const newline = () => {
    line++;
    i++;
    lineStart = i;
  };

  while (i < source.length) {
    const ch = source[i];

    // whitespace
    if (ch === '\n') {
      newline();
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    // comment: -- to end of line. Checked before the `-` operator.
    if (ch === '-' && at(1) === '-') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }

    const startLine = line;
    const startCol = column();

    // clock time, before number, because 00:03 must not lex as 0 then 0 : 3.
    // One or two digits for the hour, since 9:00 is how people write nine and
    // requiring the zero taught nothing.
    if (isDigit(ch)) {
      const wide = isDigit(at(1)) && at(2) === ':' && isDigit(at(3)) && isDigit(at(4));
      const narrow = at(1) === ':' && isDigit(at(2)) && isDigit(at(3)) && !isDigit(at(4));
      if (wide || narrow) {
        const width = wide ? 5 : 4;
        const value = source.slice(i, i + width);
        const [hourText, minuteText] = value.split(':');
        const hours = Number(hourText);
        const minutes = Number(minuteText);
        if (hours > 23 || minutes > 59) {
          fail(`"${value}" is not a clock time`, 'hours are 0-23 and minutes are 00-59', width);
        }
        i += width;
        push(T.CLOCK, { hours, minutes }, startLine, startCol);
        continue;
      }
    }

    // number, and duration when a unit letter follows immediately
    if (isDigit(ch)) {
      let raw = '';
      while (i < source.length && (isDigit(source[i]) || source[i] === '_')) raw += source[i++];
      if (source[i] === '.' && isDigit(at(1))) {
        raw += source[i++];
        while (i < source.length && (isDigit(source[i]) || source[i] === '_')) raw += source[i++];
      }
      // An exponent, so a number too large or small to write out can still be
      // written. `1e6` only counts when a digit follows the e, which keeps
      // `5e` as the error it is rather than a silent 5.
      if (
        (source[i] === 'e' || source[i] === 'E') &&
        (isDigit(at(1)) || ((at(1) === '+' || at(1) === '-') && isDigit(at(2))))
      ) {
        raw += source[i++];
        if (source[i] === '+' || source[i] === '-') raw += source[i++];
        while (i < source.length && (isDigit(source[i]) || source[i] === '_')) raw += source[i++];
      }

      const value = Number(raw.replace(/_/g, ''));

      // A unit only counts when the next character cannot continue an
      // identifier, so `5m` is a duration and `5monkeys` is an error worth
      // reporting rather than a silent `5` followed by `monkeys`.
      if (source[i] && DURATION_UNITS.has(source[i]) && !isIdentPart(at(1) ?? '')) {
        const unit = source[i++];
        const seconds = value * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit];
        push(T.DURATION, { value, unit, seconds }, startLine, startCol);
        continue;
      }
      push(T.NUMBER, value, startLine, startCol);
      continue;
    }

    // text
    if (ch === '"') {
      const isBlock = at(1) === '"' && at(2) === '"';
      i += isBlock ? 3 : 1;
      // A block text starts on the line after the opening quotes, so that first
      // newline belongs to the layout rather than to the text.
      if (isBlock && source[i] === '\n') newline();
      const parts = [];
      let literal = '';

      const flush = () => {
        if (literal) {
          parts.push({ kind: 'literal', value: literal });
          literal = '';
        }
      };

      for (;;) {
        if (i >= source.length) {
          throw new LexError('this text is never closed', {
            file,
            line: startLine,
            column: startCol,
            length: 1,
            source,
            hint: isBlock ? 'a block text ends with """' : 'a text ends with "',
          });
        }

        if (isBlock && source[i] === '"' && at(1) === '"' && at(2) === '"') {
          i += 3;
          // And the closing quotes sit on their own line, so the newline that
          // put them there is layout too.
          literal = literal.replace(/\n[ \t]*$/, '');
          break;
        }
        if (!isBlock && source[i] === '"') {
          i++;
          break;
        }
        if (!isBlock && source[i] === '\n') {
          throw new LexError('this text is never closed', {
            file,
            line: startLine,
            column: startCol,
            length: 1,
            source,
            hint: 'use """ for text that spans lines',
          });
        }

        if (source[i] === '\\') {
          const esc = at(1);
          // \r earns its place because a file written on Windows ends its lines
          // with one, and text that cannot name a carriage return cannot say
          // what it is trimming.
          const map = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '@': '@' };
          if (!(esc in map)) fail(`\\${esc ?? ''} is not an escape`, 'the escapes are \\n \\r \\t \\" \\\\ \\@', 2);
          literal += map[esc];
          i += 2;
          continue;
        }

        if (source[i] === '@') {
          // @@ is a literal at-sign, not the start of an interpolation.
          if (at(1) === '@') {
            literal += '@';
            i += 2;
            continue;
          }

          const interpLine = line;
          const interpCol = column();
          i++; // past @

          if (source[i] === '(') {
            // @(expression) — take the balanced parenthesised source
            let depth = 0;
            const from = i;
            do {
              if (i >= source.length) {
                throw new LexError('this interpolation is never closed', {
                  file, line: interpLine, column: interpCol, length: 1, source,
                  hint: 'a @( needs a matching )',
                });
              }
              if (source[i] === '(') depth++;
              else if (source[i] === ')') depth--;
              else if (source[i] === '\n') newline();
              i++;
            } while (depth > 0);
            flush();
            parts.push({
              kind: 'interp',
              expression: source.slice(from + 1, i - 1),
              line: interpLine,
              column: interpCol,
            });
            continue;
          }

          if (!isLetter(source[i] ?? '')) {
            throw new LexError('nothing follows this @', {
              file, line: interpLine, column: interpCol, length: 1, source,
              hint: 'write @name, @name.field or @(expression). For a literal at-sign, write @@',
            });
          }

          let path = '';
          let named = false;
          while (i < source.length && isIdentPart(source[i])) path += source[i++];

          // A named entity: @channel("welcome") inside text. The parentheses are
          // taken as part of the interpolation, quotes and all, so the quote
          // inside does not end the text around it. Without this the only way
          // to name a channel in a sentence was @(@channel("x").mention), and
          // naming a channel in a sentence is most of what text is for.
          if (source[i] === '(') {
            let depth = 0;
            const from = i;
            do {
              if (i >= source.length) {
                throw new LexError('this interpolation is never closed', {
                  file, line: interpLine, column: interpCol, length: 1, source,
                  hint: 'a ( inside text needs a matching )',
                });
              }
              if (source[i] === '(') depth++;
              else if (source[i] === ')') depth--;
              else if (source[i] === '\n') newline();
              i++;
            } while (depth > 0);
            path += source.slice(from, i);
            named = true;
          }

          // dotted path, but only while a letter follows the dot
          while (source[i] === '.' && isLetter(at(1) ?? '')) {
            path += source[i++];
            while (i < source.length && isIdentPart(source[i])) path += source[i++];
          }
          flush();
          // A named entity keeps its @, because what follows has to be read as
          // an entity and not as a call to a verb of the same name.
          parts.push({
            kind: 'interp',
            expression: named ? `@${path}` : path,
            line: interpLine,
            column: interpCol,
          });
          continue;
        }

        if (source[i] === '\n') {
          literal += '\n';
          newline();
          continue;
        }

        literal += source[i++];
      }

      flush();
      push(T.TEXT, parts, startLine, startCol);
      continue;
    }

    // entity: @name, optionally @name("arg"), with .field chains handled by the parser
    if (ch === '@') {
      i++;
      if (!isLetter(source[i] ?? '')) {
        fail('nothing follows this @', 'an entity is written @user, @channel("name"), @made');
      }
      let name = '';
      while (i < source.length && isIdentPart(source[i])) name += source[i++];
      push(T.ENTITY, name, startLine, startCol);
      continue;
    }

    // identifier or keyword
    if (isLetter(ch)) {
      let name = '';
      while (i < source.length && isIdentPart(source[i])) name += source[i++];
      // Only the structurally reserved words become keyword tokens. Contextual
      // words stay identifiers and the parser recognises them by position.
      push(HARD.has(name) ? T.KEYWORD : T.IDENT, name, startLine, startCol);
      continue;
    }

    // arrow, before the minus operator
    if (ch === '-' && at(1) === '>') {
      i += 2;
      push(T.OP, '->', startLine, startCol);
      continue;
    }

    // two-character comparisons, before the one-character forms
    if ((ch === '<' || ch === '>') && at(1) === '=') {
      i += 2;
      push(T.OP, ch + '=', startLine, startCol);
      continue;
    }

    if ('+-*/%<>='.includes(ch)) {
      i++;
      push(T.OP, ch, startLine, startCol);
      continue;
    }

    if (PUNCT.has(ch)) {
      i++;
      push(T.PUNCT, ch, startLine, startCol);
      continue;
    }

    fail(
      `"${ch}" has no meaning here`,
      ch === '#' ? 'comments start with --' : ch === ';' ? 'statements do not need semicolons' : null,
    );
  }

  tokens.push({ type: T.EOF, value: null, line, column: column() });
  return tokens;
}

/** Compact one-line rendering of a token, for tests and error messages. */
export function describe(token) {
  switch (token.type) {
    case T.EOF: return 'end of file';
    case T.TEXT: return 'text';
    case T.NUMBER: return `number ${token.value}`;
    case T.DURATION: return `duration ${token.value.value}${token.value.unit}`;
    case T.CLOCK: return `time ${String(token.value.hours).padStart(2, '0')}:${String(token.value.minutes).padStart(2, '0')}`;
    case T.ENTITY: return `@${token.value}`;
    default: return `"${token.value}"`;
  }
}
