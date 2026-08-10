# Cog for VS Code

Syntax highlighting for the [Cog](../../SPEC.md) language: comments, all 84
reserved words grouped by role, entities (`@user`, `@channel("x").name`), text
with escapes and `@` interpolation, numbers, durations, clock times, verb and
shape names, calls and operators.

There is no language server and no extension code — this is a grammar and a
language configuration, nothing else. No dependencies, no build step.

## Install

Copy this folder into your VS Code extensions directory, named
`cog-0.0.1`:

```powershell
$dest = "$env:USERPROFILE\.vscode\extensions\cog-0.0.1"
New-Item -ItemType Directory -Force $dest
Copy-Item -Recurse -Force .\* $dest
```

Or, from a shell that speaks POSIX:

```sh
cp -r . "$USERPROFILE/.vscode/extensions/cog-0.0.1"
```

**Reload the window afterwards** — `Developer: Reload Window` from the command
palette, or just restart VS Code. VS Code only scans the extensions directory at
startup, so a freshly copied folder is invisible until it does.

Open any `.cog` file to check it took. `sample.cog` in this folder exercises
every construct in the specification and is the quickest way to see whether the
grammar is behaving.

## Contents

| File | What it is |
|---|---|
| `package.json` | extension manifest: language id, extensions, grammar, icon |
| `language-configuration.json` | comments, brackets, auto-closing, word pattern, indentation |
| `syntaxes/cog.tmLanguage.json` | the TextMate grammar (`source.cog`) |
| `icons/cog.png` | language icon, extracted from `assets/cog.ico` |
| `sample.cog` | a file that uses every construct, for eyeballing the grammar |

## Inspecting scopes

`Developer: Inspect Editor Tokens and Scopes` shows the scope stack under the
cursor. That is the fastest way to tell whether a change to the grammar did what
you meant.

## Licence

MIT.
