// Put `cog` on the PATH and teach Windows what a .cog file is.
//
//   node scripts/install-windows.js            report what would change
//   node scripts/install-windows.js --apply    make the changes
//   node scripts/install-windows.js --remove   undo them
//
// Everything written here lives under HKCU, so nothing needs administrator
// rights and nothing affects another account on this machine.
//
// The one rule worth stating: the ProgID `Cognition.SourceFile` may already
// exist with an icon somebody set by hand. This extends it and never replaces
// it — a DefaultIcon already there is left exactly as it is.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'src', 'cli.js');
const PROGID = 'Cognition.SourceFile';
const ICON = 'C:\\Program Files\\Cognition\\cog.ico';

const mode = process.argv.includes('--remove')
  ? 'remove'
  : process.argv.includes('--apply')
    ? 'apply'
    : 'report';

if (process.platform !== 'win32') {
  console.error('This script is for Windows. On another system, `npm link` puts cog on the PATH.');
  process.exit(2);
}

const reg = (args) => {
  try {
    return execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
};

const readKey = (key, value) => {
  const out = reg(['query', key, ...(value ? ['/v', value] : ['/ve'])]);
  if (!out) return null;
  const match = out.match(/REG_[A-Z_]+\s+(.*)/);
  return match ? match[1].trim() : null;
};

// ---------------------------------------------------------------- the plan

const node = process.execPath;
const openCommand = `"${node}" "${CLI}" run "%1" %*`;

const steps = [
  {
    what: `.cog files are ${PROGID}`,
    key: 'HKCU\\Software\\Classes\\.cog',
    value: null,
    data: PROGID,
  },
  {
    what: 'the name shown in Explorer',
    key: `HKCU\\Software\\Classes\\${PROGID}`,
    value: null,
    data: 'Cog Source File',
    // Cosmetic, and somebody may have chosen the wording. Theirs wins.
    keepExisting: true,
  },
  {
    what: 'the icon',
    key: `HKCU\\Software\\Classes\\${PROGID}\\DefaultIcon`,
    value: null,
    data: `${ICON},0`,
    // Somebody may have set this by hand. Theirs wins.
    keepExisting: true,
  },
  {
    what: 'double-click runs the file',
    key: `HKCU\\Software\\Classes\\${PROGID}\\shell\\open\\command`,
    value: null,
    data: openCommand,
  },
  {
    what: 'the right-click verb reads "Run with Cog"',
    key: `HKCU\\Software\\Classes\\${PROGID}\\shell\\open`,
    value: null,
    data: 'Run with &Cog',
  },
  {
    what: 'a second verb checks the file instead of running it',
    key: `HKCU\\Software\\Classes\\${PROGID}\\shell\\check`,
    value: null,
    data: '&Check with Cog',
  },
  {
    what: 'what that verb runs',
    key: `HKCU\\Software\\Classes\\${PROGID}\\shell\\check\\command`,
    value: null,
    data: `"${node}" "${CLI}" check "%1"`,
  },
];

// ------------------------------------------------------------------- report

if (!existsSync(CLI)) {
  console.error(`src/cli.js is missing from ${ROOT}. Run this from inside the repository.`);
  process.exit(2);
}
if (!existsSync(ICON)) {
  console.error(`note: no icon at ${ICON}, so Explorer will show a blank page until there is one.`);
}

const shim = resolve(process.env.APPDATA ?? '', 'npm', 'cog.cmd');
const onPath = existsSync(shim);

console.log(`cog        ${ROOT}`);
console.log(`node       ${node}`);
console.log(`command    ${onPath ? shim : 'not installed — run: npm link'}`);
console.log('');

for (const step of steps) {
  const current = readKey(step.key, step.value);
  const settled = current === step.data || (step.keepExisting && current);
  const state = settled ? 'ok   ' : current ? 'change' : 'add   ';
  console.log(`  ${state} ${step.what}`);
  if (current && !settled) console.log(`         was: ${current}`);
  if (!settled) console.log(`         now: ${step.data}`);
}

if (mode === 'report') {
  console.log('\nNothing was changed. Pass --apply to make it so, or --remove to undo it.');
  process.exit(0);
}

// -------------------------------------------------------------------- apply

if (mode === 'apply') {
  let failed = 0;
  for (const step of steps) {
    if (step.keepExisting && readKey(step.key, step.value)) continue;
    const out = reg(['add', step.key, '/ve', '/t', 'REG_SZ', '/d', step.data, '/f']);
    if (out === null) {
      console.error(`\nfailed to write ${step.key}`);
      failed++;
    }
  }
  console.log(failed ? `\n${failed} step(s) failed.` : '\nDone. A .cog file now runs on double-click.');
  if (!onPath) console.log('For the `cog` command itself, run: npm link');
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------------- remove

// Only what this script owns. The ProgID itself and its icon are left alone,
// because the icon may predate this script and removing it would undo somebody
// else's work.
const OURS = [
  `HKCU\\Software\\Classes\\${PROGID}\\shell`,
  'HKCU\\Software\\Classes\\.cog',
];

for (const key of OURS) {
  const out = reg(['delete', key, '/f']);
  console.log(`  ${out === null ? 'gone already' : 'removed     '} ${key}`);
}
console.log(`\nThe ${PROGID} entry and its icon were left in place; they may not be ours.`);
console.log('For the command, run: npm unlink -g cog-lang');
