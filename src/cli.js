#!/usr/bin/env node
// The cog command.
//
//   cog run <file>      execute the program
//   cog check <file>    parse and report problems, change nothing
//   cog tokens <file>   dump the token stream, for debugging the lexer
//   cog ast <file>      dump the syntax tree
//
// `cog build` lowers agent declarations onto a host runtime and is not written
// yet; asking for it says so rather than doing something surprising.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './parser.js';
import { tokenize } from './lexer.js';
import { Interpreter, useParser } from './interpret.js';
import { CogError } from './errors.js';

useParser(parse);

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STD = join(ROOT, 'std');

const [, , command, ...rest] = process.argv;

const USAGE = `cog — an agent-oriented language

  cog run <file>      execute a program
  cog check <file>    parse and report problems, changing nothing
  cog tokens <file>   print the token stream
  cog ast <file>      print the syntax tree
`;

if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(USAGE);
  process.exit(command ? 0 : 1);
}

if (command === 'build') {
  console.error('cog build is not written yet.');
  console.error('It will lower agent declarations onto a host runtime; for now, cog check validates them.');
  process.exit(2);
}

const files = rest.filter((a) => !a.startsWith('-'));
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
      console.log(`${name}: ok — ${summary || 'empty'}`);
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

process.exit(failures ? 1 : 0);
