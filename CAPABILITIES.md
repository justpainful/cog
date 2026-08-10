# What you can build with Cog

Written after the language could build the system it was designed for, not
before. Everything claimed here has been run.

Cog is two things at once, and the honest answer to "what can I build with it"
is different for each.

---

## The language

`cog run` executes a program. There is no host, no Discord, nothing to connect
to. What you get is a small language with an unremarkable feature list: values,
bindings, functions, closures, records, lists, maps, modules, exceptions.

The standard library is written in Cog, which is the useful measure of whether
a language can carry its own weight. Forty-four functions across four modules,
none of them reaching into the interpreter:

| Module | Functions | What it covers |
|---|---|---|
| `std/text` | 11 | slug, words, wrap, pad, title case, trim to length |
| `std/list` | 14 | unique, flatten, zip, chunk, group_by, sort, partition |
| `std/math` | 11 | clamp, round to places, gcd, power, sum, mean, median |
| `std/time` | 8 | describe a duration, clock arithmetic, format |

**Suited to:** text and data transformation, small command-line tools, rule
files that someone who is not a programmer has to read and edit, teaching
material where the syntax is meant to disappear.

**Not suited to:** anything with a performance requirement. It is a tree-walking
interpreter, which is roughly two orders of magnitude off a JIT and is not
apologising for it. Also no filesystem, no network, no concurrency, no FFI. A
program cannot open a file or make a request. That is a real limit and it rules
out most of what people mean by "a script".

The interpreter is under 800 lines. If speed ever matters, the upgrade is a
bytecode VM, not a rewrite.

---

## The agent layer

`cog build` is the part that is not like other languages.

An `intent` and its verbs, an `on` block, an `every` block: these do not run.
They compile into a document of rows that a host runtime loads, and after that
the host serves them with no Cog present anywhere. A button works because a row
exists.

This is what Cog is for, and it is worth being precise about what it buys:

**A row that is wrong fails at build time instead of under someone's finger.**
The system this language was built for stored behaviour as hand-written JSON.
A misspelled parameter stored perfectly and failed at the moment a person
clicked something. Every one of those is now a compile error naming the field:
an effect the host cannot perform, a permission name that is not real, a filter
the event never supplies, an interval cron cannot express, a button pointing at
a verb that does not exist, two things claiming one name.

**A host is a table, not a compiler.** `src/capability.js` describes one
runtime: its effects, events, filters, predicates, permission names, entity
templates, colours, and how a duration becomes a schedule. Pointing Cog at
Telegram, Slack, Matrix or a home-automation bus is a new table of under
two hundred lines. The lowering code does not know what Discord is.

### The proof

The system Cog was written for has twelve actions, three triggers, one schedule
and a counter, all of it written by hand as JSON over several weeks and running
in a real server the whole time.

Rewritten as five `.cog` files and compiled, the result is the same system:

```
16 the same, 0 differing, 0 undescribed
11 field(s) written differently to the same effect
```

Nothing in the running Registry is undescribed by the source. The eleven
differences are all one of: a host default written out explicitly, `@everyone`
resolved to the guild id by name instead of by number, `@made.mention` against
`<#{{created.id}}>` which renders identically, or an internal key the two
systems chose differently.

That comparison is a script, not a claim, and it exits non-zero when it fails.

### What it will not lower

A row holds fixed values in a fixed shape, so the parts of the language that
only exist while a program runs do not cross over: `hold`, `carry`, `each`,
`repeat`, `attempt`, `give`, and arithmetic on anything the build cannot
already see. Joining text with `+` folds at build time and survives.

This is a limit worth defending. A row that could run a loop would need an
interpreter at the other end, and then the host is running Cog, and the whole
point was that it does not have to.

---

## The honest summary

| | |
|---|---|
| **Best at** | describing what an agent should do, checked before it does it |
| **Good at** | small programs, text and data work, readable rule files |
| **Bad at** | speed, I/O, anything needing a library ecosystem |
| **Impossible** | files, network, threads, native code |

The specific thing Cog does that a general-purpose language does not: it knows
what the host can do, and it refuses to describe anything else. That is a
narrow advantage, and it is the only one worth having, because the alternative
is JSON that stores cleanly and breaks in front of a person.

---

## Building for a different host

Write a capability table. It needs:

- `effects` — a Cog statement kind to a host action kind
- `events` — a Cog event name to a host trigger, and the filters it supplies
- `predicates` — the questions the host can answer about state
- `permissions` — short names to whatever the host calls them
- `entities` — `@user`, `@here` and friends, and the placeholder each becomes
- `namedEntities` — the ones that need an id resolved at build time
- `colours`, `activities`, `ask`, `schedule` — the small surfaces
- `command` — how a named command reaches a row, if the host has them

`lower()` takes `{ host }`. Nothing else changes. If the new host cannot do
something Cog can say, the build says which statement and stops, which is the
same guarantee the first host gets.
