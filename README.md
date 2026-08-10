<div align="center">

<img src="assets/cog.ico" width="120" alt="Cog">

# Cog

A programming language for agent systems and ordinary programs.

[![CI](https://github.com/justpainful/cog/actions/workflows/ci.yml/badge.svg)](https://github.com/justpainful/cog/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)

</div>

## Overview

Cog gives agent behavior its own syntax instead of representing everything as JSON, YAML or library calls. The language includes a parser, interpreter, CLI and a compiler path for lowering agent declarations into data that another runtime can load.

It can run normal Cog programs directly and can also compile agent definitions against a host capability model.

## Example

```cog
intent tickets {
  verb open {
    needs no @channel("ticket-@user.name")

    make channel "ticket-@user.name" under @category("Tickets") {
      hide @everyone
      show @user [read, write, history]
    }

    then {
      panel at @made {
        button "Close" danger -> close(@made)
      }
    }
  }
}

on member.joins {
  count members up by 1
  post @channel("welcome") "welcome @user.mention"
}
```

## Commands

| Command | Purpose |
|---|---|
| `cog run app.cog` | Execute a Cog program |
| `cog build app.cog` | Compile agent declarations for a host runtime |
| `cog check app.cog` | Parse and validate without changing anything |

Example build:

```bash
cog build systems/*.cog --ids ids.json --out registry.json
```

The generated output is data. Cog does not need to remain running after a host has loaded the result.

## Language

Cog uses its own vocabulary for binding, functions, control flow, modules and agent behavior.

| Area | Syntax |
|---|---|
| Binding | `hold` `carry` |
| Functions | `verb` `give` |
| Flow | `when` `otherwise` `each` `repeat` `stop` `next` |
| Data | `shape` `yes` `no` `none` |
| Modules | `bring` `share` |
| Failure | `attempt` `rescue` `fail` |
| Agent | `intent` `on` `every` `needs` `make` `then` |
| Effects | `say` `post` `tell` `note` `grant` `show` `hide` `count` |

`@` identifies entities and interpolation such as `@user`, `@made` and `@channel("welcome")`.

## Project layout

```text
src/              lexer, parser, interpreter, lowering and CLI
std/              standard library written in Cog
tests/            language test suite
editor/vscode/    VS Code extension and grammar
scripts/          editor and Windows tooling
SPEC.md           language reference
GRAMMAR.ebnf      grammar
CAPABILITIES.md   current capabilities and limits
```

## Design

The interpreter is tree-walking and favors correctness and language development over raw execution speed.

Agent compilation is capability based. A host describes what it supports and Cog validates declarations against that model before producing output.

Unicode identifiers and strings are supported. Keywords remain English.

## License

[MIT](LICENSE)  
Copyright © 2026 Faisal Saud