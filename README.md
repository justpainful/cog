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
[![Status](https://img.shields.io/badge/status-in%20design-orange)](SPEC.md)

</div>

---

> **Status: in design.** The specification is being written first, on purpose.
> Nothing here runs yet. Watch [SPEC.md](SPEC.md) — the language is settled
> there before a line of the interpreter is written.

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
      panel in @made {
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

## The vocabulary

Cog deliberately shares no keywords with the mainstream. Every word is an
ordinary English verb or noun, so a program reads as prose rather than as
ceremony.

| | |
|---|---|
| **Binding** | `hold` immutable · `carry` mutable |
| **Functions** | `verb` · `give` |
| **Flow** | `when` / `otherwise` · `each … in` · `repeat while` · `stop` · `next` |
| **Data** | `shape` · `yes` `no` `none` |
| **Modules** | `bring … as` · `share` |
| **Failure** | `attempt` / `rescue` · `fail` |
| **Agent** | `intent` · `on` · `every` · `needs` · `make` · `then` |
| **Effects** | `say` · `post` · `tell` · `note` · `grant` · `show` / `hide` · `count` |

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
src/     lexer · parser · ast · resolver · interpret · lower · cli
std/     the standard library, written in Cog where it can be
tests/   .cog programs paired with their expected output
editor/  VS Code extension and the TextMate grammar
SPEC.md  the reference specification
```

## License

[MIT](LICENSE) — Copyright © 2026 Faisal Saud
