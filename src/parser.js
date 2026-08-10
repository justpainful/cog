// Tokens to an abstract syntax tree.
//
// Recursive descent with one token of lookahead, matching GRAMMAR.ebnf rule for
// rule. Nodes are plain objects with a `kind`, a position, and whatever that
// kind needs — no class hierarchy, because the interpreter and the lowerer both
// want to switch on `kind` and neither wants to inherit anything.
//
// Newlines are insignificant, so every statement has to know where it ends by
// its own shape. That is why block-bodied statements are unambiguous here and
// why an expression statement stops as soon as it cannot continue.

import { tokenize, T, describe as describeToken } from './lexer.js';
import { ParseError } from './errors.js';
import { BUTTON_STYLES, MAKE_KINDS, WEEKDAYS, EMBED_FIELDS, HARD } from './keywords.js';

export function parse(source, file = '<input>') {
  const tokens = tokenize(source, file);
  let pos = 0;

  // ---------------------------------------------------------------- helpers

  const peek = (offset = 0) => tokens[Math.min(pos + offset, tokens.length - 1)];
  const at = (type, value) => {
    const tk = peek();
    return tk.type === type && (value === undefined || tk.value === value);
  };
  const atKeyword = (...words) => peek().type === T.KEYWORD && words.includes(peek().value);

  /**
   * Matches a word whether it arrived as a hard keyword or as a contextual
   * identifier. Every soft keyword is checked through this.
   */
  const atWord = (...words) => {
    const tk = peek();
    return (tk.type === T.KEYWORD || tk.type === T.IDENT) && words.includes(tk.value);
  };
  const wordAt = (offset, ...words) => {
    const tk = peek(offset);
    return (tk.type === T.KEYWORD || tk.type === T.IDENT) && words.includes(tk.value);
  };
  const expectWord = (word, hint) => {
    if (!atWord(word)) fail(`expected "${word}", found ${describeToken(peek())}`, hint);
    return advance();
  };
  const atPunct = (ch) => at(T.PUNCT, ch);
  const atOp = (ch) => at(T.OP, ch);

  const where = (tk = peek()) => ({
    file,
    line: tk.line,
    column: tk.column,
    length: String(tk.value ?? '').length || 1,
    source,
  });

  const fail = (message, hint = null, tk = peek()) => {
    throw new ParseError(message, { ...where(tk), hint });
  };

  const advance = () => tokens[pos++];

  const expect = (type, value, what, hint) => {
    if (!at(type, value)) {
      fail(
        `expected ${what ?? (value !== undefined ? `"${value}"` : type)}, found ${describeToken(peek())}`,
        hint,
      );
    }
    return advance();
  };

  const expectPunct = (ch, hint) => expect(T.PUNCT, ch, `"${ch}"`, hint);
  const expectKeyword = (word, hint) => expect(T.KEYWORD, word, `"${word}"`, hint);

  const node = (kind, tk, props) => ({ kind, line: tk.line, column: tk.column, ...props });

  /** An identifier, or a keyword used where a plain name is wanted. */
  const identName = (what) => {
    if (at(T.IDENT)) return advance().value;
    if (at(T.KEYWORD)) {
      fail(
        `"${peek().value}" is a keyword and cannot be used as ${what ?? 'a name'}`,
        'pick a different name',
      );
    }
    fail(`expected ${what ?? 'a name'}, found ${describeToken(peek())}`);
  };

  // ----------------------------------------------------------------- program

  const program = () => {
    const body = [];
    while (!at(T.EOF)) body.push(declaration());
    return { kind: 'Program', file, body };
  };

  const declaration = () => {
    if (atKeyword('bring')) return bringDecl();
    if (atKeyword('share')) return shareDecl();
    if (atKeyword('shape')) return shapeDecl();
    if (atKeyword('intent')) return intentDecl();
    if (atKeyword('verb') && !isAnonVerb()) return verbDecl();
    if (atKeyword('on')) return onDecl();
    if (atKeyword('every')) return everyDecl();
    return statement();
  };

  // `verb (` is an anonymous verb expression; `verb name` is a declaration.
  const isAnonVerb = () => peek(1).type === T.PUNCT && peek(1).value === '(';

  const bringDecl = () => {
    const tk = advance();
    const name = identName('a module name');
    const pathToken = expect(T.TEXT, undefined, 'a module path in quotes');
    const path = textParts(pathToken)
      .map((p) => (p.kind === 'literal' ? p.value : ''))
      .join('');
    if (!path) fail('a module path cannot be empty', null, pathToken);
    return node('Bring', tk, { name, path });
  };

  const shareDecl = () => {
    const tk = advance();
    if (atKeyword('verb')) return node('Share', tk, { declaration: verbDecl() });
    if (atKeyword('shape')) return node('Share', tk, { declaration: shapeDecl() });
    if (atKeyword('hold')) return node('Share', tk, { declaration: holdStmt() });
    fail('only a verb, a shape or a hold can be shared', 'write share verb, share shape or share hold');
  };

  const shapeDecl = () => {
    const tk = advance();
    const name = identName('a shape name');
    expectPunct('{');
    const fields = [];
    while (!atPunct('}')) {
      if (at(T.EOF)) fail('this shape is never closed', 'a shape body ends with }', tk);
      const fieldTk = peek();
      const fieldName = identName('a field name');
      let fallback = null;
      if (atOp('=')) {
        advance();
        fallback = expression();
      }
      fields.push(node('Field', fieldTk, { name: fieldName, fallback }));
    }
    expectPunct('}');
    return node('Shape', tk, { name, fields });
  };

  const verbDecl = () => {
    const tk = advance();
    const name = path('a verb name');
    let params = [];
    if (atPunct('(')) params = paramList();
    const body = block();
    return node('Verb', tk, { name, params, body });
  };

  const paramList = () => {
    expectPunct('(');
    const params = [];
    while (!atPunct(')')) {
      const tk = peek();
      const name = identName('a parameter name');
      let fallback = null;
      if (atOp('=')) {
        advance();
        fallback = expression();
      }
      params.push(node('Param', tk, { name, fallback }));
      if (atPunct(',')) advance();
      else break;
    }
    expectPunct(')');

    // A required parameter after an optional one can never be supplied
    // positionally, so it is a mistake rather than a style choice.
    let seenOptional = false;
    for (const p of params) {
      if (p.fallback) seenOptional = true;
      else if (seenOptional) {
        throw new ParseError(`"${p.name}" has no default but follows one that does`, {
          file, line: p.line, column: p.column, length: p.name.length, source,
          hint: 'move the parameters with defaults to the end',
        });
      }
    }
    return params;
  };

  const path = (what) => {
    const parts = [identName(what)];
    while (atPunct('.') && peek(1).type === T.IDENT) {
      advance();
      parts.push(advance().value);
    }
    return parts.join('.');
  };

  const intentDecl = () => {
    const tk = advance();
    const name = identName('an intent name');
    expectPunct('{');
    const body = [];
    while (!atPunct('}')) {
      if (at(T.EOF)) fail('this intent is never closed', 'an intent body ends with }', tk);
      if (atKeyword('verb')) body.push(verbDecl());
      else if (atKeyword('on')) body.push(onDecl());
      else if (atKeyword('every')) body.push(everyDecl());
      else fail('an intent holds verbs, on blocks and every blocks', `found ${describeToken(peek())}`);
    }
    expectPunct('}');
    return node('Intent', tk, { name, body });
  };

  const onDecl = () => {
    const tk = advance();
    const subject = identName('an event name');
    expectPunct('.', 'an event is written subject.happening, such as member.joins');
    const happening = identName('an event name');
    let filter = null;
    if (atKeyword('when')) {
      advance();
      filter = filterExpr();
    }
    const body = block();
    return node('On', tk, { event: `${subject}.${happening}`, filter, body });
  };

  const filterExpr = () => {
    const terms = [filterTerm()];
    while (atKeyword('and')) {
      advance();
      terms.push(filterTerm());
    }
    return terms.length === 1 ? terms[0] : { kind: 'FilterAll', terms };
  };

  const filterTerm = () => {
    const tk = peek();
    // cmpExpr, not expression: `and` separates filter terms here, so the value
    // must stop below the logical operators or it eats the next term.
    if (atWord('contains')) {
      advance();
      return node('FilterContains', tk, { value: cmpExpr() });
    }
    if (atWord('starts')) {
      advance();
      return node('FilterStarts', tk, { value: cmpExpr() });
    }
    if (atWord('at')) {
      advance();
      return node('FilterAt', tk, { entity: entityExpr() });
    }
    if (atWord('from')) {
      advance();
      return node('FilterFrom', tk, { entity: entityExpr() });
    }
    fail('expected a filter', 'filters are: contains "x", starts "x", at @channel(…), from @role(…)');
  };

  const everyDecl = () => {
    const tk = advance();
    const schedule = scheduleSpec();
    const body = block();
    return node('Every', tk, { schedule, body });
  };

  const scheduleSpec = () => {
    const tk = peek();
    if (at(T.DURATION)) {
      const d = advance();
      return node('EveryDuration', tk, { seconds: d.value.seconds, text: `${d.value.value}${d.value.unit}` });
    }
    if (atWord('day') || atWord('month') || ((peek().type === T.IDENT || peek().type === T.KEYWORD) && WEEKDAYS.has(peek().value))) {
      const word = advance().value;
      expectWord('at', 'a daily or weekly schedule needs a time, such as: every day at 00:03');
      const clock = expect(T.CLOCK, undefined, 'a time such as 00:03');
      return node('EveryAt', tk, { period: word, hours: clock.value.hours, minutes: clock.value.minutes });
    }
    fail(
      'expected a schedule',
      'schedules are: every 5m, every day at 00:03, every monday at 09:00, every month at 00:00',
    );
  };

  // -------------------------------------------------------------- statements

  const block = () => {
    const tk = expectPunct('{');
    const body = [];
    while (!atPunct('}')) {
      if (at(T.EOF)) fail('this block is never closed', 'a block ends with }', tk);
      body.push(declaration());
    }
    expectPunct('}');
    return node('Block', tk, { body });
  };

  const statement = () => {
    if (atKeyword('hold')) return holdStmt();
    if (atKeyword('carry')) return carryStmt();
    if (atKeyword('when')) return whenStmt();
    if (atKeyword('each')) return eachStmt();
    if (atKeyword('repeat')) return repeatStmt();
    if (atKeyword('give')) return giveStmt();
    if (atKeyword('stop')) return node('Stop', advance(), {});
    if (atKeyword('next')) return node('Next', advance(), {});
    if (atKeyword('attempt')) return attemptStmt();
    if (atKeyword('fail')) return failStmt();

    const agent = agentStmt();
    if (agent) return agent;

    return assignOrExpression();
  };

  const holdStmt = () => {
    const tk = advance();
    const name = identName('a name to hold');
    expect(T.OP, '=', '"="', 'a hold needs a value: hold name = value');
    return node('Hold', tk, { name, value: expression() });
  };

  const carryStmt = () => {
    const tk = advance();
    const name = identName('a name to carry');
    expect(T.OP, '=', '"="', 'a carry needs a starting value: carry name = value');
    return node('Carry', tk, { name, value: expression() });
  };

  const assignOrExpression = () => {
    const tk = peek();
    const target = expression();
    if (atOp('=')) {
      advance();
      if (!['Name', 'Field', 'Index'].includes(target.kind)) {
        fail('this cannot be assigned to', 'assign to a name, a field or an index', tk);
      }
      return node('Assign', tk, { target, value: expression() });
    }
    return node('ExpressionStatement', tk, { expression: target });
  };

  const whenStmt = () => {
    const tk = advance();
    const test = expression();
    const body = block();
    let alternate = null;
    if (atKeyword('otherwise')) {
      advance();
      alternate = atKeyword('when') ? whenStmt() : block();
    }
    return node('When', tk, { test, body, alternate });
  };

  const eachStmt = () => {
    const tk = advance();
    const first = identName('a loop name');
    let second = null;
    if (atPunct(',')) {
      advance();
      second = identName('a loop name');
    }
    expectKeyword('of', 'each walks a list or a map: each item of items');
    const subject = expression();
    return node('Each', tk, { key: second ? first : null, value: second ?? first, subject, body: block() });
  };

  const repeatStmt = () => {
    const tk = advance();
    if (atKeyword('until')) {
      advance();
      const test = expression();
      return node('RepeatUntil', tk, { test, body: block() });
    }
    const count = expression();
    expectKeyword('times', 'a counted loop is written: repeat 5 times { … }');
    return node('RepeatTimes', tk, { count, body: block() });
  };

  const giveStmt = () => {
    const tk = advance();
    // `give` with nothing after it yields none, so only take an expression when
    // one plausibly starts here.
    const value = startsExpression() ? expression() : null;
    return node('Give', tk, { value });
  };

  const attemptStmt = () => {
    const tk = advance();
    const body = block();
    expectKeyword('rescue', 'an attempt needs a rescue: attempt { … } rescue problem { … }');
    const binding = identName('a name for the problem');
    return node('Attempt', tk, { body, binding, handler: block() });
  };

  const failStmt = () => {
    const tk = advance();
    return node('Fail', tk, { value: expression() });
  };

  const startsExpression = () =>
    at(T.NUMBER) || at(T.TEXT) || at(T.DURATION) || at(T.CLOCK) || at(T.IDENT) || at(T.ENTITY) ||
    atPunct('(') || atPunct('[') ||
    atKeyword('yes', 'no', 'none', 'not', 'when', 'verb') ||
    atOp('-');

  // ---------------------------------------------------------- agent statements

  const agentStmt = () => {
    const tk = peek();

    // A contextual keyword only heads a statement when what follows could not
    // continue an expression. `note "hi"` is an effect; `note = 5`, `note.x` and
    // `note + 1` are an ordinary name that happens to be spelled like one.
    if (tk.type === T.IDENT) {
      const after = peek(1);
      const continues =
        (after.type === T.OP) ||
        (after.type === T.PUNCT && ['=', '.', '[', '(', ',', ')', '}', ']', ':'].includes(after.value));
      if (continues) return null;
    }

    // `count n up by 1` is the counter; anything else starting with `count` is a
    // name. The distinguishing token is `up`, two ahead.
    if (atWord('count') && !(peek(1).type === T.IDENT && wordAt(2, 'up'))) return null;

    if (atKeyword('needs')) {
      advance();
      return node('Needs', tk, { predicate: predicate() });
    }
    if (atWord('say')) {
      advance();
      const value = messageBody();
      let everyone = false;
      if (atWord('to')) {
        advance();
        expectWord('everyone', 'say … to everyone makes the answer public');
        everyone = true;
      }
      return node('Say', tk, { value, everyone });
    }
    if (atWord('post')) {
      advance();
      const target = entityExpr();
      return node('Post', tk, { target, value: messageBody() });
    }
    if (atWord('tell')) {
      advance();
      const target = entityExpr();
      return node('Tell', tk, { target, value: messageBody() });
    }
    if (atWord('note')) {
      advance();
      return node('Note', tk, { value: expression() });
    }
    if (atKeyword('make')) return makeStmt();
    if (atWord('thread')) {
      advance();
      const name = expression();
      expectWord('at', 'a thread needs a channel: thread "name" at @channel(…)');
      const target = entityExpr();
      const then = atKeyword('then') ? (advance(), block()) : null;
      return node('Thread', tk, { name, target, then });
    }
    if (atWord('rename')) {
      advance();
      const target = at(T.ENTITY) ? entityExpr() : node('Name', peek(), { name: identName('what to rename') });
      if (atWord('to')) {
        advance();
        return node('Rename', tk, { target, mode: 'to', value: expression() });
      }
      if (atWord('prefix')) {
        advance();
        return node('Rename', tk, { target, mode: 'prefix', value: expression() });
      }
      if (atWord('suffix')) {
        advance();
        return node('Rename', tk, { target, mode: 'suffix', value: expression() });
      }
      fail('rename needs to, prefix or suffix', 'rename @here prefix "closed-"');
    }
    if (atWord('grant')) {
      advance();
      const role = entityExpr();
      let who = null;
      if (atWord('to')) {
        advance();
        who = entityExpr();
      }
      return node('Grant', tk, { role, who });
    }
    if (atWord('revoke')) {
      advance();
      const role = entityExpr();
      let who = null;
      if (atWord('from')) {
        advance();
        who = entityExpr();
      }
      return node('Revoke', tk, { role, who });
    }
    if (atWord('show') || atWord('hide')) {
      const mode = advance().value;
      const who = entityExpr();
      const permissions = atPunct('[') ? permissionList() : [];
      let target = null;
      if (atWord('at')) {
        advance();
        target = entityExpr();
      }
      return node('Permission', tk, { mode, who, permissions, target });
    }
    if (atWord('react')) {
      advance();
      return node('React', tk, { emoji: expression() });
    }
    if (atWord('count')) {
      advance();
      const name = identName('a counter name');
      expectWord('up', 'a counter is bumped: count members up by 1');
      let by = null;
      if (atWord('by')) {
        advance();
        by = expression();
      }
      const then = atKeyword('then') ? (advance(), block()) : null;
      return node('Count', tk, { name, by, then });
    }
    if (atWord('panel')) return panelStmt();
    if (atWord('ask')) return askStmt();
    return null;
  };

  const messageBody = () => (atWord('embed') ? embedLiteral() : expression());

  const embedLiteral = () => {
    const tk = advance();
    expectPunct('{');
    const fields = {};
    while (!atPunct('}')) {
      if (at(T.EOF)) fail('this embed is never closed', 'an embed ends with }', tk);
      if (!atWord('title', 'body', 'colour', 'footer')) {
        fail('an embed holds title, body, colour and footer', `found ${describeToken(peek())}`);
      }
      const field = advance().value;
      if (field in fields) fail(`this embed already has a ${field}`);
      fields[field] = expression();
    }
    expectPunct('}');
    return node('Embed', tk, { fields });
  };

  const makeStmt = () => {
    const tk = advance();
    if (!((peek().type === T.IDENT || peek().type === T.KEYWORD) && MAKE_KINDS.has(peek().value))) {
      fail('make needs a kind', `make channel, make category or make role`);
    }
    const what = advance().value;
    const name = expression();
    let under = null;
    if (atWord('under')) {
      advance();
      under = entityExpr();
    }
    let permissions = [];
    if (atPunct('{')) {
      const open = advance();
      while (!atPunct('}')) {
        if (at(T.EOF)) fail('these permissions are never closed', 'the block ends with }', open);
        if (!atWord('show', 'hide')) {
          fail('a permission block holds show and hide lines', `found ${describeToken(peek())}`);
        }
        const permTk = peek();
        const mode = advance().value;
        const who = entityExpr();
        const list = atPunct('[') ? permissionList() : [];
        permissions.push(node('Permission', permTk, { mode, who, permissions: list, target: null }));
      }
      expectPunct('}');
    }
    const then = atKeyword('then') ? (advance(), block()) : null;
    return node('Make', tk, { what, name, under, permissions, then });
  };

  const permissionList = () => {
    expectPunct('[');
    const names = [];
    while (!atPunct(']')) {
      names.push(identName('a permission name'));
      if (atPunct(',')) advance();
      else break;
    }
    expectPunct(']');
    return names;
  };

  const panelStmt = () => {
    const tk = advance();
    expectWord('at', 'a panel needs a channel: panel at @here { … }');
    const target = entityExpr();
    expectPunct('{');
    const buttons = [];
    while (!atPunct('}')) {
      if (at(T.EOF)) fail('this panel is never closed', 'a panel ends with }', tk);
      const btnTk = expectWord('button', 'a panel holds button lines');
      const labelToken = expect(T.TEXT, undefined, 'a button label in quotes');
      let style = 'primary';
      if ((peek().type === T.IDENT || peek().type === T.KEYWORD) && BUTTON_STYLES.has(peek().value)) style = advance().value;
      expect(T.OP, '->', '"->"', 'a button points at a verb: button "Close" -> tickets.close');
      const verb = path('a verb name');
      let args = [];
      if (atPunct('(')) args = argumentList();
      buttons.push(node('Button', btnTk, { label: textParts(labelToken), style, verb, args }));
    }
    expectPunct('}');
    if (!buttons.length) fail('a panel with no buttons does nothing', 'add a button line', tk);
    return node('Panel', tk, { target, buttons });
  };

  const askStmt = () => {
    const tk = advance();
    expectPunct('{');
    const fields = [];
    while (!atPunct('}')) {
      if (at(T.EOF)) fail('this ask is never closed', 'an ask ends with }', tk);
      if (!atWord('line', 'paragraph')) {
        fail('an ask holds line and paragraph fields', `found ${describeToken(peek())}`);
      }
      const fieldTk = peek();
      const shape = advance().value;
      const labelToken = expect(T.TEXT, undefined, 'a field label in quotes');
      let required = false;
      if (atWord('required')) {
        advance();
        required = true;
      }
      fields.push(node('AskField', fieldTk, { shape, label: textParts(labelToken), required }));
    }
    expectPunct('}');
    expectKeyword('then', 'an ask hands off to a verb: ask { … } then tickets.open');
    const verb = path('a verb name');
    return node('Ask', tk, { fields, verb });
  };

  // -------------------------------------------------------------- predicates

  const predicate = () => {
    let left = predicateAnd();
    while (atKeyword('or')) {
      const tk = advance();
      left = node('PredAny', tk, { left, right: predicateAnd() });
    }
    return left;
  };

  const predicateAnd = () => {
    let left = predicateTerm();
    while (atKeyword('and')) {
      const tk = advance();
      left = node('PredAll', tk, { left, right: predicateTerm() });
    }
    return left;
  };

  const predicateTerm = () => {
    const tk = peek();
    if (atKeyword('not')) {
      advance();
      return node('PredNot', tk, { of: predicateTerm() });
    }
    if (atKeyword('no')) {
      advance();
      return node('PredAbsent', tk, { entity: entityExpr() });
    }
    if (atPunct('(')) {
      advance();
      const inner = predicate();
      expectPunct(')');
      return inner;
    }
    const subject = entityExpr();
    if (atWord('has')) {
      advance();
      return node('PredHas', tk, { subject, object: entityExpr() });
    }
    if (atKeyword('is')) {
      advance();
      return node('PredIs', tk, { subject, object: entityExpr() });
    }
    return node('PredExists', tk, { entity: subject });
  };

  // ------------------------------------------------------------- expressions

  const expression = () => orExpr();

  const orExpr = () => {
    let left = andExpr();
    while (atKeyword('or')) {
      const tk = advance();
      left = node('Logical', tk, { operator: 'or', left, right: andExpr() });
    }
    return left;
  };

  const andExpr = () => {
    let left = cmpExpr();
    while (atKeyword('and')) {
      const tk = advance();
      left = node('Logical', tk, { operator: 'and', left, right: cmpExpr() });
    }
    return left;
  };

  const CMP_OPS = new Set(['<', '>', '<=', '>=']);

  const cmpExpr = () => {
    const left = addExpr();
    const isCmp = (atKeyword('is', 'isnt')) || (at(T.OP) && CMP_OPS.has(peek().value));
    if (!isCmp) return left;

    const tk = advance();
    const operator = tk.value;
    const right = addExpr();

    // Chained comparison reads as maths and means something else, so it is
    // rejected rather than silently reinterpreted.
    if (atKeyword('is', 'isnt') || (at(T.OP) && CMP_OPS.has(peek().value))) {
      fail(
        'comparisons do not chain',
        'write it as two comparisons joined by and: a < b and b < c',
      );
    }
    return node('Compare', tk, { operator, left, right });
  };

  const addExpr = () => {
    let left = mulExpr();
    while (at(T.OP) && (peek().value === '+' || peek().value === '-')) {
      const tk = advance();
      left = node('Binary', tk, { operator: tk.value, left, right: mulExpr() });
    }
    return left;
  };

  const mulExpr = () => {
    let left = unary();
    while (at(T.OP) && ['*', '/', '%'].includes(peek().value)) {
      const tk = advance();
      left = node('Binary', tk, { operator: tk.value, left, right: unary() });
    }
    return left;
  };

  const unary = () => {
    if (atKeyword('not')) {
      const tk = advance();
      return node('Unary', tk, { operator: 'not', operand: unary() });
    }
    if (atOp('-')) {
      const tk = advance();
      return node('Unary', tk, { operator: '-', operand: unary() });
    }
    return postfix();
  };

  const postfix = () => {
    let target = primary();
    for (;;) {
      if (atPunct('.') && (peek(1).type === T.IDENT || peek(1).type === T.KEYWORD)) {
        const tk = advance();
        const name = advance().value;
        target = node('Field', tk, { target, name });
        continue;
      }
      if (atPunct('[')) {
        const tk = advance();
        const index = expression();
        expectPunct(']');
        target = node('Index', tk, { target, index });
        continue;
      }
      if (atPunct('(')) {
        const tk = peek();
        const args = argumentList();
        target = node('Call', tk, { callee: target, args });
        continue;
      }
      return target;
    }
  };

  const argumentList = () => {
    expectPunct('(');
    const args = [];
    while (!atPunct(')')) {
      const tk = peek();
      // A named argument is `name:`; a bare identifier followed by anything
      // else is an ordinary expression.
      if (at(T.IDENT) && peek(1).type === T.PUNCT && peek(1).value === ':') {
        const name = advance().value;
        advance();
        args.push(node('Argument', tk, { name, value: expression() }));
      } else {
        args.push(node('Argument', tk, { name: null, value: expression() }));
      }
      if (atPunct(',')) advance();
      else break;
    }
    expectPunct(')');

    let seenNamed = false;
    for (const a of args) {
      if (a.name) seenNamed = true;
      else if (seenNamed) {
        throw new ParseError('a positional argument cannot follow a named one', {
          file, line: a.line, column: a.column, length: 1, source,
          hint: 'put the positional arguments first',
        });
      }
    }
    return args;
  };

  const entityExpr = () => {
    if (!at(T.ENTITY)) fail(`expected an entity such as @user, found ${describeToken(peek())}`);
    const tk = advance();
    let argument = null;
    if (atPunct('(')) {
      advance();
      argument = expression();
      expectPunct(')');
    }
    let result = node('Entity', tk, { name: tk.value, argument });
    while (atPunct('.') && (peek(1).type === T.IDENT || peek(1).type === T.KEYWORD)) {
      const dot = advance();
      result = node('Field', dot, { target: result, name: advance().value });
    }
    return result;
  };

  /**
   * Turn a text token's interpolation parts into nodes.
   *
   * A bare `@path` is kept as a path and resolved later — as a binding if one
   * exists, otherwise as an entity. Sub-parsing it as an expression was wrong:
   * `"@count"` then hit the `count` statement keyword, and `count` is exactly
   * the sort of word that is both a keyword and a thing you interpolate.
   *
   * `@(expression)` is the general form and is parsed here, because it is
   * explicitly delimited and cannot collide with anything.
   */
  const textParts = (token) =>
    token.value.map((part) => {
      if (part.kind === 'literal') return part;

      const isPath = /^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(part.expression);
      if (isPath) {
        return {
          kind: 'interp',
          path: part.expression.split('.'),
          expression: null,
          line: part.line,
          column: part.column,
        };
      }

      const inner = parse(part.expression, `${file} (interpolation)`);
      const only = inner.body[0];
      if (!only || inner.body.length !== 1 || only.kind !== 'ExpressionStatement') {
        throw new ParseError('this interpolation is not an expression', {
          file, line: part.line, column: part.column, length: 1, source,
          hint: 'write @name, @name.field or @(expression)',
        });
      }
      return { kind: 'interp', path: null, expression: only.expression, line: part.line, column: part.column };
    });

  const primary = () => {
    const tk = peek();

    if (at(T.NUMBER)) return node('Number', advance(), { value: tk.value });
    if (at(T.DURATION)) {
      advance();
      return node('Duration', tk, { seconds: tk.value.seconds, text: `${tk.value.value}${tk.value.unit}` });
    }
    if (at(T.CLOCK)) {
      advance();
      return node('Clock', tk, { hours: tk.value.hours, minutes: tk.value.minutes });
    }
    if (at(T.TEXT)) {
      const token = advance();
      return node('Text', tk, { parts: textParts(token) });
    }
    if (atKeyword('yes')) return node('Truth', advance(), { value: true });
    if (atKeyword('no')) return node('Truth', advance(), { value: false });
    if (atKeyword('none')) return node('None', advance(), {});
    if (at(T.ENTITY)) return entityExpr();

    if (atKeyword('verb') && isAnonVerb()) {
      advance();
      const params = paramList();
      return node('VerbValue', tk, { params, body: block() });
    }

    if (atKeyword('when')) return whenValue();

    if (atPunct('[')) return listOrMap();

    if (atPunct('(')) {
      advance();
      const inner = expression();
      expectPunct(')');
      return inner;
    }

    if (at(T.IDENT)) return node('Name', advance(), { name: tk.value });

    if (at(T.KEYWORD)) {
      fail(
        `"${tk.value}" is a keyword and cannot start an expression`,
        'if you meant a name, pick a different word',
      );
    }

    fail(`expected a value, found ${describeToken(tk)}`);
  };

  // `when` as a value must have an `otherwise`, because an expression has to
  // produce something on every path. The statement form may omit it.
  const whenValue = () => {
    const tk = expectKeyword('when');
    const test = expression();
    const consequent = block();
    expectKeyword('otherwise', 'a when used as a value needs an otherwise — an expression must always produce something');
    const alternate = atKeyword('when') ? whenValue() : block();
    return node('WhenValue', tk, { test, consequent, alternate });
  };

  const listOrMap = () => {
    const tk = advance();

    if (atPunct(']')) {
      advance();
      return node('List', tk, { items: [] });
    }
    if (atPunct(':') && peek(1).type === T.PUNCT && peek(1).value === ']') {
      advance();
      advance();
      return node('Map', tk, { entries: [] });
    }

    const items = [];
    const entries = [];
    for (;;) {
      const first = expression();
      if (atPunct(':')) {
        advance();
        entries.push({ key: first, value: expression() });
      } else {
        items.push(first);
      }
      if (atPunct(',')) {
        advance();
        if (atPunct(']')) break; // trailing comma
        continue;
      }
      break;
    }
    expectPunct(']');

    if (items.length && entries.length) {
      fail(
        'this mixes list entries and map entries',
        'entries with a key make a map, entries without make a list — not both',
        tk,
      );
    }
    return entries.length
      ? node('Map', tk, { entries })
      : node('List', tk, { items });
  };

  const ast = program();
  return ast;
}
