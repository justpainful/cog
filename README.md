<div align="center">

<img src="assets/cog.ico" width="120" alt="Cog">

# Cog

**An agent-oriented programming language.**

Verbs, intents and events are syntax, not library calls. Cog has its own
interpreter, and a second backend that lowers agent declarations onto a live
runtime.

[![CI](https://github.com/justpainful/cog/actions/workflows/ci.yml/badge.svg)](https://github.com/justpainful/cog/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![Status](https://img.shields.io/badge/status-working-2ea44f)](CAPABILITIES.md)

</div>

---

> **Status: it works.** `cog run` executes programs, `cog build` compiles the
> agent layer onto a live runtime, and the system Cog was written for has been
> rewritten in it and compared against the running original row by row.
> [CAPABILITIES.md](CAPABILITIES.md) says what it is and is not good for.

## Why

Most agent frameworks describe behaviour in JSON or YAML. It works, and it
reads badly: an action is a nested object, a guard is a `{"type": "..."}`
literal, and a typo in a parameter name is stored happily and fails later in
front of whoever pressed the button.

Cog makes that behaviour a language, so a mistake is a compile error and a
system reads like a description of itself.

```cog
intent tickets {

  verb open {
    needs no @channel("ticket-@user.name")

    make channel "ticket-@user.name" under @category("Tickets") {
      hide @everyone
      show @user             [read, write, history]
      show @role("Operator") [read, write, manage]
    }

    then {
      panel at @made {
        button "Close" danger -> close(@made)
      }
      say "your ticket is @made.mention"
    }
  }
}

on member.joins {
  count members up by 1
  post @channel("welcome") "welcome @user.mention, you are number @count"
}

every day at 00:03 {
  post @channel("command-log") "── @today ──"
}
```

## Two backends, one language

| Command | What it does | Needs a host runtime |
|---|---|---|
| `cog run app.cog` | Executes the program in Cog's own interpreter | no |
| `cog build app.cog` | Lowers agent declarations to a host runtime document | yes |
| `cog check app.cog` | Parses and resolves, reports errors, changes nothing | no |

The first makes Cog a real language you can write ordinary programs in. The
second is what makes it worth having: agent declarations become configuration a
running system can load, validated against that system's actual capabilities.

```
cog build systems/*.cog --ids ids.json --out registry.json
5 files: 12 actions, 3 triggers, 1 schedule, 3 components, 1 counter → registry.json
```

Nothing from Cog is alive at the other end. The output is data: once the host
has loaded it, the buttons work because the rows exist, and Cog is not running
anywhere. A verb inside an `intent` becomes one of those rows; a verb at the top
level of a file stays an ordinary function that `cog build` walks past.

What a row cannot hold is a compile error rather than a surprise later. A loop
in an agent verb, a permission name the host has never heard of, a filter the
event does not supply, an interval cron cannot express — each is refused with
the reason, which is the whole argument for compiling this at all.

## The vocabulary

Nothing that declares, binds or controls flow is borrowed — no `var`, `let`,
`class`, `struct`, `func`, `if`, `for`, `while`, `return`, `in`, `with`, `as`.
Every word is an ordinary English verb or noun, so a program reads as prose
rather than as ceremony. The logical operators `and`, `or`, `not`, `is` and
`from` are shared with Python on purpose; renaming those would be showing off.

| | |
|---|---|
| **Binding** | `hold` immutable · `carry` mutable |
| **Functions** | `verb` · `give` |
| **Flow** | `when` / `otherwise` · `each … of` · `repeat until` · `stop` · `next` |
| **Data** | `shape` · `yes` `no` `none` |
| **Modules** | `bring` · `share` |
| **Failure** | `attempt` / `rescue` · `fail` |
| **Agent** | `intent` · `on` · `every` · `needs` · `make` · `then` |
| **Effects** | `say` · `post` · `tell` · `note` · `grant` · `show` / `hide` · `count` |
| **Controls** | `panel` / `button` · `ask` · `command` · `presence` |

`@` marks an entity or an interpolation — `@user`, `@channel("welcome")`,
`@made`, and `"hello @user.name"` inside a string. Write `@@` for a literal one.

## Design notes

- **Tree-walking interpreter.** Speed is not a goal. If it ever becomes one,
  that is a bytecode VM, not a rewrite.
- **A capability table, not hardcoded hosts.** The agent layer validates
  against a description of what the host runtime can do. Pointing Cog at a
  different host is a new table, not a new compiler.
- **Unicode identifiers and strings** from the start. Keywords are English.

## Layout

```
src/              lexer · parser · interpret · capability · lower · cli
std/              the standard library, written in Cog
tests/            629 of them, run by `npm test`
editor/vscode/    the extension and its TextMate grammar
scripts/          editor and Windows installers, icon tools
SPEC.md           the reference specification
GRAMMAR.ebnf      the grammar on its own
CAPABILITIES.md   what Cog is and is not good for
```

## License

[MIT](LICENSE) — Copyright © 2026 Faisal Saud
