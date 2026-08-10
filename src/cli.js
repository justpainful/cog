#!/usr/bin/env node
// The cog command.
//
//   cog run <file>      execute the program
//   cog build <file>    lower the agent layer onto a host runtime
//   cog check <file>    parse and report problems, change nothing
//   cog tokens <file>   dump the token stream, for debugging the lexer
//   cog ast <file>      dump the syntax tree
//
// run and build are two backends over one front end. run executes the program;
// build emits a document of rows that a host loads and then serves on its own,
// with no Cog anywhere in the picture.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './parser.js';
import { tokenize } from './lexer.js';
import { Interpreter, useParser } from './interpret.js';
import { lower } from './lower.js';
import { CogError } from './errors.js';

useParser(parse);

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STD = join(ROOT, 'std');

const [, , command, ...rest] = process.argv;

const USAGE = `cog — an agent-oriented language

  cog run <file>      execute a program
  cog build <file>    lower the agent layer onto a host runtime
  cog check <file>    parse and report problems, changing nothing
  cog tokens <file>   print the token stream
  cog ast <file>      print the syntax tree

build options
  --ids <file.json>   names to ids, keyed "channel:welcome", "role:Operator"
  --out <file.json>   write the document here instead of to the screen
  --stamp             record the build time in the document
`;

if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(USAGE);
  process.exit(command ? 0 : 1);
}

// Only these take a value. Knowing which ones do is what keeps
// `cog build --stamp thing.cog` from reading the file name as the flag's value.
const VALUED = new Set(['--ids', '--out']);

const option = (name) => {
  const at = rest.indexOf(`--${name}`);
  if (at === -1) return null;
  return VALUED.has(`--${name}`) ? rest[at + 1] ?? null : true;
};

const files = rest.filter((a, i) => !a.startsWith('-') && !(i > 0 && VALUED.has(rest[i - 1])));
if (!files.length) {
  console.error(`${command} needs a file.\n`);
  process.stdout.write(USAGE);
  process.exit(2);
}

/** Resolve a `bring` path: std/ against the standard library, else relative. */
const makeLoader = (fromFile) => (path) => {
  const candidate = path.startsWith('std/')
    ? join(STD, `${path.slice(4)}.cog`)
    : resolve(dirname(fromFile), path.endsWith('.cog') ? path : `${path}.cog`);
  return existsSync(candidate) ? readFileSync(candidate, 'utf8') : null;
};

let failures = 0;

// Several files build into one document, because a system is usually more than
// one file and a host loads a document rather than a directory.
const built = [];
let buildIds = {};
if (command === 'build') {
  const idsPath = option('ids');
  if (typeof idsPath === 'string') {
    const at = resolve(idsPath);
    if (!existsSync(at)) {
      console.error(`no ids file at ${at}`);
      process.exit(2);
    }
    buildIds = JSON.parse(readFileSync(at, 'utf8'));
  }
}

for (const name of files) {
  const file = resolve(name);
  if (!existsSync(file)) {
    console.error(`no file at ${file}`);
    failures++;
    continue;
  }
  const source = readFileSync(file, 'utf8');

  try {
    if (command === 'tokens') {
      for (const token of tokenize(source, name)) {
        console.log(`${String(token.line).padStart(4)}:${String(token.column).padEnd(4)} ${token.type.padEnd(9)} ${JSON.stringify(token.value)}`);
      }
      continue;
    }

    const ast = parse(source, name);

    if (command === 'ast') {
      console.log(JSON.stringify(ast, null, 2));
      continue;
    }

    if (command === 'check') {
      const counts = {};
      for (const node of ast.body) counts[node.kind] = (counts[node.kind] ?? 0) + 1;
      const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');

      // Anything in the agent layer is lowered as well, because that is where
      // the checking worth having happens: a permission that is not real or a
      // filter an event never supplies is caught here rather than under a
      // finger. Ids are not required, since a missing one is a fact about the
      // server and not about the file.
      const agentLayer = ast.body.some((n) => ['Intent', 'On', 'Every'].includes(n.kind));
      let note = '';
      if (agentLayer) {
        const document = lower(ast, { file: name, source, requireIds: false });
        const rows = document.actions.length + document.triggers.length + document.schedules.length;
        note = `, ${rows} row${rows === 1 ? '' : 's'}`;
        if (document.needs_ids) note += `, ${document.needs_ids.length} name(s) still need ids`;
      }
      console.log(`${name}: ok — ${summary || 'empty'}${note}`);
      continue;
    }

    if (command === 'build') {
      const document = lower(ast, { file: name, source, ids: buildIds });
      built.push({ name, document });
      continue;
    }

    if (command === 'run') {
      const interpreter = new Interpreter({
        file: name,
        source,
        load: makeLoader(file),
      });
      interpreter.run(ast);
      continue;
    }

    console.error(`unknown command "${command}"\n`);
    process.stdout.write(USAGE);
    process.exit(2);
  } catch (problem) {
    if (problem instanceof CogError) {
      console.error(problem.format());
    } else {
      console.error(`${name}: ${problem.message}`);
      if (process.env.COG_DEBUG) console.error(problem.stack);
    }
    failures++;
  }
}

if (command === 'build' && !failures) {
  const document = {
    exported_at: option('stamp') ? new Date().toISOString() : null,
    guild_id: buildIds.guild ? String(buildIds.guild) : null,
    actions: [],
    triggers: [],
    schedules: [],
    components: [],
    counters: [],
  };

  // Two files may bump the same counter, which is one counter. Two files
  // claiming the same action key is a collision, and it is worth saying which
  // files disagree rather than letting the later one win.
  const from = new Map();
  for (const { name, document: part } of built) {
    for (const table of ['actions', 'triggers', 'schedules', 'components']) {
      for (const row of part[table]) {
        const seen = from.get(`${table}:${row.key}`);
        if (seen) {
          console.error(`"${row.key}" is declared in both ${seen} and ${name}`);
          failures++;
          continue;
        }
        from.set(`${table}:${row.key}`, name);
        document[table].push(row);
      }
    }
    for (const counter of part.counters) {
      if (!document.counters.some((c) => c.key === counter.key)) document.counters.push(counter);
    }
  }

  const counts = [
    [document.actions.length, 'action'],
    [document.triggers.length, 'trigger'],
    [document.schedules.length, 'schedule'],
    [document.components.length, 'component'],
    [document.counters.length, 'counter'],
  ]
    .filter(([n]) => n)
    .map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`)
    .join(', ');

  if (!counts) {
    console.error('nothing to build — no file here declares an intent, on or every');
    failures++;
  } else if (!failures) {
    const out = option('out');
    const text = `${JSON.stringify(document, null, 2)}\n`;
    if (typeof out === 'string') {
      writeFileSync(resolve(out), text);
      console.log(`${files.length} file${files.length === 1 ? '' : 's'}: ${counts} → ${out}`);
    } else {
      process.stdout.write(text);
    }
  }
}

process.exit(failures ? 1 : 0);
