// Install the Cog extension into VS Code and any fork of it.
//
//   node scripts/install-editor.js
//
// Copying a folder into ~/.vscode/extensions is not enough on current VS Code.
// It keeps an index at extensions.json and loads what that file lists, so an
// extension that is only on disk is invisible — which is exactly how a language
// ends up rendering as plain text with no error anywhere.
//
// The folder name matters too: every other extension is publisher.name-version,
// and matching that convention avoids surprises.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, 'editor', 'vscode');

const manifest = JSON.parse(readFileSync(join(SOURCE, 'package.json'), 'utf8'));
const { publisher, name, version } = manifest;
if (!publisher || !name || !version) {
  console.error('The extension manifest needs publisher, name and version.');
  process.exit(1);
}
const folder = `${publisher}.${name}-${version}`;
const id = `${publisher}.${name}`;

// Every editor that reads the VS Code extension layout.
const EDITORS = [
  { label: 'VS Code', dir: join(homedir(), '.vscode', 'extensions') },
  { label: 'VS Code Insiders', dir: join(homedir(), '.vscode-insiders', 'extensions') },
  { label: 'Cursor', dir: join(homedir(), '.cursor', 'extensions') },
  { label: 'Windsurf', dir: join(homedir(), '.windsurf', 'extensions') },
  { label: 'VSCodium', dir: join(homedir(), '.vscode-oss', 'extensions') },
];

let installed = 0;

for (const editor of EDITORS) {
  if (!existsSync(editor.dir)) continue;

  const target = join(editor.dir, folder);

  // Clear older versions and the unconventional name a first attempt may have left.
  for (const stale of [target, join(editor.dir, `${name}-${version}`), join(editor.dir, name)]) {
    if (existsSync(stale)) rmSync(stale, { recursive: true, force: true });
  }
  mkdirSync(target, { recursive: true });
  cpSync(SOURCE, target, { recursive: true });
  rmSync(join(target, 'sample.cog'), { force: true });

  // Register in the index, replacing any previous entry for this id.
  const indexPath = join(editor.dir, 'extensions.json');
  let index = [];
  if (existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
      if (Array.isArray(parsed)) index = parsed;
    } catch {
      console.warn(`  ${editor.label}: extensions.json is unreadable, writing a fresh one`);
    }
  }

  index = index.filter((e) => e?.identifier?.id !== id);
  index.push({
    identifier: { id },
    version,
    location: {
      $mid: 1,
      path: `/${target.replace(/\\/g, '/')}`,
      scheme: 'file',
    },
    relativeLocation: folder,
    metadata: {
      installedTimestamp: Date.now(),
      // Not from the marketplace, so say so rather than inventing a publisher id.
      source: 'vsix',
      targetPlatform: 'undefined',
      updated: false,
      private: false,
      isPreReleaseVersion: false,
      hasPreReleaseVersion: false,
      isApplicationScoped: false,
      isMachineScoped: false,
      isBuiltin: false,
      pinned: true,
    },
  });

  writeFileSync(indexPath, JSON.stringify(index));
  console.log(`  ${editor.label.padEnd(18)} ${target}`);
  installed++;
}

if (!installed) {
  console.error('No VS Code style editor found. Nothing installed.');
  process.exit(1);
}

console.log(`\nInstalled ${id} ${version} into ${installed} editor(s).`);
console.log('\nQuit the editor completely and reopen it — reloading the window is not enough,');
console.log('because the extension index is read once at startup.');
