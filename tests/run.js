// Test entry point. More suites join this list as the compiler grows.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = ['keywords.js', 'spec-sync.js', 'lexer.js', 'parser.js', 'interpret.js', 'lower.js', 'std.js'];

let failed = 0;
for (const suite of SUITES) {
  const path = join(HERE, suite);
  if (!existsSync(path)) continue;
  const res = spawnSync(process.execPath, [path], { stdio: 'inherit' });
  if (res.status !== 0) failed++;
}

if (failed) {
  console.error(`\n${failed} suite(s) failed\n`);
  process.exit(1);
}
console.log('all suites passed');
