// Does the engine agree with the reference?
//
//   node scripts/conform.js [stage]
//
// Two implementations of one language is a liability unless something checks
// they say the same thing. The JavaScript tree is the reference: it is finished,
// it has 629 tests behind it, and it is what the specification was written
// against. `engine/` is the real implementation — a binary with its own engine —
// and it is being built one stage at a time.
//
// Every stage is compared here against every .cog file in reach before the next
// stage starts. A front end that disagrees with itself produces a back end
// nobody can debug, and the disagreement is always cheaper to find now.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENGINE = join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'cog.exe' : 'cog');

if (!existsSync(ENGINE)) {
  console.error(`no engine at ${ENGINE}`);
  console.error('build it first:  cargo build --release --manifest-path engine/Cargo.toml');
  process.exit(2);
}

/** Every .cog file worth comparing: the examples, the library, the live systems. */
function sources() {
  const found = [];
  const sweep = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) sweep(path);
      else if (entry.name.endsWith('.cog') && !entry.name.startsWith('_')) found.push(path);
    }
  };
  sweep(join(ROOT, 'examples'));
  sweep(join(ROOT, 'std'));
  sweep(join(ROOT, 'tests'));
  // The systems that actually run, which are the files that matter most.
  sweep(resolve(ROOT, '..', 'Cognition', 'systems'));
  return found;
}

const run = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (problem) {
    return problem.stdout ?? `!! ${problem.message}`;
  }
};

/**
 * Both dumps reduced to what they are claiming: a position and a token kind.
 *
 * The two print their values differently on purpose — the reference prints
 * JavaScript, the engine prints Rust — and comparing the printing would be
 * comparing the two languages rather than the two lexers.
 */
const shape = (dump) =>
  dump
    .split('\n')
    .map((line) => line.match(/^\s*(\d+):(\d+)\s+([a-z]+)/))
    .filter(Boolean)
    .filter((m) => m[3] !== 'eof')
    .map((m) => `${m[1]}:${m[2]} ${m[3]}`);

const files = sources();
let disagreed = 0;
let compared = 0;

for (const file of files) {
  const reference = shape(run(process.execPath, [join(ROOT, 'src', 'cli.js'), 'tokens', file]));
  const engine = shape(run(ENGINE, ['tokens', file]));
  compared++;

  if (reference.length === 0 && engine.length === 0) {
    console.log(`  empty   ${file}`);
    continue;
  }

  const upTo = Math.max(reference.length, engine.length);
  let first = -1;
  for (let i = 0; i < upTo; i++) {
    if (reference[i] !== engine[i]) {
      first = i;
      break;
    }
  }

  if (first === -1) {
    console.log(`  agree   ${file}  (${reference.length} tokens)`);
  } else {
    disagreed++;
    console.log(`  DIFFER  ${file}`);
    console.log(`            token ${first + 1} of ${upTo}`);
    console.log(`            reference: ${reference[first] ?? '(ended)'}`);
    console.log(`            engine:    ${engine[first] ?? '(ended)'}`);
  }
}

console.log(`\n${compared} file(s) compared, ${disagreed} disagree`);
process.exit(disagreed ? 1 : 0);
