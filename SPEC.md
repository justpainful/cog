# The Cog Language Specification

**Version 0.1.** This document was written before the parser, so the grammar
was decided rather than discovered. It has been kept in step since: every code
block below is lexed and parsed by the test suite, and the reserved-word lists
in §14 are generated from the implementation.

---

## Contents

1. [Design rules](#1-design-rules)
2. [Lexical structure](#2-lexical-structure)
3. [Values](#3-values)
4. [Bindings](#4-bindings)
5. [Expressions](#5-expressions)
6. [Control flow](#6-control-flow)
7. [Verbs](#7-verbs)
8. [Shapes](#8-shapes)
9. [Modules](#9-modules)
10. [Failure](#10-failure)
11. [The agent layer](#11-the-agent-layer)
12. [Entities](#12-entities)
13. [Lowering](#13-lowering)
14. [Reserved words](#14-reserved-words)
15. [Not in 0.1](#15-not-in-01)

---

## 1. Design rules

Four constraints shaped every decision below. They are recorded because a rule
you cannot recite gets broken by the next feature.

**Two strengths of keyword.** Reserving all 84 words makes the language
unusable — `carry count = 0` would be illegal, and so would naming anything
`title`, `body`, `line`, `role` or `day`. Only the words that structure a
program are reserved everywhere. The rest are **contextual**: they mean
something in the one position the grammar expects them, and are ordinary
identifiers anywhere else. This was found by writing the examples in this
document and watching them fail to parse.

**Structural keywords are Cog's own.** Nothing that declares, binds or
controls flow is borrowed. No `var`, `let`, `class`, `struct`, `func`,
`function`, `if`, `else`, `for`, `while`, `return`, `true`, `false`, `null`,
`import`, `as`, `in`, `with`, `where`. Every one of them has a Cog word instead,
and each is an ordinary English verb or noun so a program reads as a sentence
about what happens.

Six words are shared on purpose: `and`, `or`, `not`, `is`, `from` and `repeat`.
Inventing synonyms for the logical operators would make Cog stranger without
making it more distinctive, and a language that renames `and` is showing off
rather than designing. `tests/keywords.js` enforces that this list stays exactly
this long.

**One sigil.** `@` marks an entity or an interpolation, and nothing else marks
anything. A language with `$`, `&`, `#` and `%` makes the reader carry a table.

**Agent constructs are syntax.** `verb`, `intent`, `on`, `every` and `needs`
are grammar, not library calls, because they are what the language is for.

**Errors before execution — in the agent layer only, so far.** `cog build`
checks everything it lowers against the host's capability table: an effect the
host cannot perform, a permission name that is not real, a filter an event never
supplies, a button pointing at a verb that does not exist, two things claiming
one key.

Ordinary programs get none of that yet. An unbound name, a wrong argument count
and text added to a number are all caught, but at the moment they run and not
before. There is no semantic pass and no type checker; writing one is a stage of
its own and it has not been done.

---

## 2. Lexical structure

### 2.1 Comments

```cog
-- to end of line
```

There are no block comments. A commented-out region should be uncomfortable.

### 2.2 Identifiers

A letter or `_` followed by letters, digits or `_`. "Letter" means any Unicode
letter, so `عدد` and `número` are identifiers. Keywords are English and cannot
be used as identifiers.

Verbs may carry a dotted **path** — `tickets.open` — which names one verb, not
a field access. The distinction is positional: a path appears after `verb`, in
a call, or after `->`.

### 2.3 Numbers

```cog
42        3.5        1_000_000        0.001        1e6        1.5e-3
```

`_` is a visual separator and is ignored. There is one numeric type. An exponent
counts only when digits follow the `e`, so `5e` is a number and a name rather
than half a literal.

### 2.4 Text

Double quotes. Escapes: `\n`, `\r`, `\t`, `\"`, `\\`, `\@`.

```cog
"plain"
"line one\nline two"
"""
  a block of text
  keeping its line breaks
"""
```

Inside text, `@` starts an interpolation:

```cog
"hello @user.name"                -- a field path
"you are number @count"           -- a binding
"total: @(price * quantity)"      -- an expression, parenthesised
"reach me @@example"              -- @@ is a literal @
```

An interpolation that names nothing is a **compile error**, not an empty
string. A visible mistake beats a silent one.

### 2.5 Durations and clock times

```cog
30s   5m   2h   3d   1w         -- duration, in seconds
00:03   14:30   9:30            -- clock time, seconds since midnight
```

The hour may be one digit or two, because nine o'clock is written `9:00` and
insisting on the zero taught nobody anything. The minutes are always two.

Both are counts of seconds, so a clock and a duration can be compared and added
without a conversion. They did not start that way: a clock counted minutes while
a duration counted seconds, both arrived as bare numbers, and
`time.describe(14:30)` answered `"14m 30s"` with nothing able to notice. Two
literals in one family with different units and no runtime distinction is a trap
rather than a shorthand.

### 2.6 Booleans and absence

```cog
yes    no    none
```

`yes` and `no` are the booleans. `none` is the absence of a value.

---

## 3. Values

| Kind | Example | Notes |
|---|---|---|
| text | `"hello"` | Unicode, immutable |
| number | `42`, `3.5` | one numeric type |
| truth | `yes`, `no` | |
| none | `none` | |
| list | `[1, 2, 3]` | ordered, mixed kinds allowed |
| map | `[name: "kuroi", age: 3]` | `[:]` is the empty map |
| record | `Ticket(owner: @user)` | built from a `shape` |
| entity | `@channel("welcome")` | a handle on something in the host |
| verb | `verb (x) { give x + 1 }` | first class, closes over scope |

Lists and maps share `[` `]`, as in Swift: entries with `key:` make a map,
entries without make a list. `[]` is an empty list and `[:]` an empty map.
Mixing the two forms in one literal is an error.

Text, numbers, truth values and `none` are compared by value; lists, maps,
records and verbs by identity.

Text is immutable. A list is not: `items[0] = x` changes it in place, and so
does `items.add(x)`. That matters when a list is built an item at a time.
`plus` leaves the list alone and gives back a new one, which copies everything
on every pass and turns a loop over n items into n² of work. `add` changes the
list and gives it back:

```cog
carry out = []
each x of xs { out.add(x) }        -- cheap
each x of xs { out = out + [x] }   -- the same answer, quadratically slower
```

At ten items the difference is invisible. At twenty thousand it is ten times the
running time, and it keeps growing.

---

## 4. Bindings

```cog
hold limit = 10          -- cannot be reassigned
carry count = 0          -- can
count = count + 1
```

`hold` is the default choice; `carry` is for values that genuinely change.
Reassigning a `hold` is a compile error. Both are block-scoped, and shadowing
an outer name in an inner block is allowed.

Reading a name before it is bound is an error rather than `none` — but a
runtime one. `cog check` will not find it, because nothing yet walks the tree
looking for names that are never bound.

---

## 5. Expressions

### 5.1 Operators, loosest first

| Level | Operators | Associativity |
|---|---|---|
| 1 | `or` | left |
| 2 | `and` | left |
| 3 | `is` `isnt` `<` `>` `<=` `>=` | none — chaining is an error |
| 4 | `+` `-` | left |
| 5 | `*` `/` `%` | left |
| 6 | `not` `-` (unary) | right |
| 7 | `.` `[]` `()` | left |

Logic is words, comparison is symbols. `is` and `isnt` compare values; there is
no separate identity operator.

`+` concatenates text and adds numbers. Text plus number is an error — say
`"n: @count"` instead, which is clearer anyway.

### 5.2 Access

```cog
person.name          -- field
items[0]             -- index, zero-based
scores["kuroi"]      -- map key
greet("world")       -- call
```

Indexing out of range gives `none`. Reading a missing map key gives `none`.
Reading a missing *field* of a record is a compile error, because a shape
declares its fields and a typo is knowable.

---

## 6. Control flow

### 6.1 when / otherwise

```cog
when count > 10 {
  note "many"
} otherwise when count > 0 {
  note "some"
} otherwise {
  note "none at all"
}
```

`when` is also an expression:

```cog
hold label = when count > 0 { "some" } otherwise { "none" }
```

Only `no` and `none` are falsy. Zero and empty text are true, because "is this
list empty" should be written as `items.size is 0`.

Inside an agent verb, `when` asks the host a question instead, so its test is a
predicate (§11.2):

```cog
when @user has @role("Operator") {
  say "go ahead"
} otherwise {
  say "not for you"
}
```

A test is read as a predicate when it opens with `no @…` or when `has` sits
between two entities. `out.has(x)` is a list asking itself a question and stays
an ordinary expression, which is why the rule looks at what surrounds `has`
rather than at the word alone.

### 6.2 each

```cog
each item of items {
  note item
}

each key, value of scores {
  note "@key = @value"
}
```

### 6.3 repeat

```cog
repeat until count is 10 {
  count = count + 1
}

repeat 5 times {
  note "again"
}
```

### 6.4 stop and next

`stop` leaves the nearest loop; `next` starts its next iteration.

---

## 7. Verbs

```cog
verb greet(name) {
  give "hello " + name
}

verb tally(items, start) {
  carry total = start
  each n of items { total = total + n }
  give total
}
```

A verb without `give` yields `none`. Parameters may have defaults, and a
default is evaluated at call time:

```cog
verb greet(name, greeting = "hello") {
  give greeting + " " + name
}
```

Verbs are values and close over the scope they were written in:

```cog
hold double = verb (n) { give n * 2 }
hold results = items.map(double)
```

Calling with the wrong number of arguments is a compile error when the target
is known statically, which it is for every named verb.

---

## 8. Shapes

```cog
shape Ticket {
  owner
  opened = no
  tags = []
}

hold t = Ticket(owner: @user)
note t.owner
```

Fields are named at construction. Missing fields without a default is an error;
unknown fields are an error. Records are immutable — `change` produces a copy:

```cog
hold closed = t.change(opened: yes)
```

Shapes carry data. They have no methods and no inheritance: behaviour lives in
verbs, which is the whole premise of the language.

---

## 9. Modules

One file is one module. `share` makes a name public; everything else is private.

```cog
-- std/text.cog
share verb upper(s) {
  give s.uppercase
}

-- app.cog
bring text "std/text"
note text.upper("hi")
```

Paths starting `std/` resolve to the standard library; others resolve relative
to the importing file. Import cycles are an error.

Reading a name a module does not share is an error naming the module and listing
what it does share. A module knows every name it exports, so a typo is knowable
before the call rather than something to meet as `none` a line later.

---

## 10. Failure

```cog
attempt {
  hold data = parse(input)
  note data.name
} rescue problem {
  note "could not read it: @problem.message"
}

fail "the ticket has no owner"
```

`fail` raises with a message. `rescue` binds a record with `message` and
`where`. There is no exception hierarchy in 0.1 — a message and a location
cover the cases this language has.

---

## 11. The agent layer

Everything above is an ordinary language and runs under `cog run`. This section
describes constructs that `cog build` lowers onto a host runtime.

### 11.1 intent

```cog
intent tickets {
  verb open {
    say "opening"
  }
  verb close(target) {
    rename target prefix "closed-"
  }
}
```

An `intent` groups verbs under a name and becomes their key prefix:
`tickets.open`. It is the unit a reader should be able to hold in their head:
one goal and the verbs that serve it.

**An agent verb is a verb inside an `intent`, and only that.** A verb at the top
level of a file is an ordinary function: it can loop, it can hold values, it can
return, and `cog build` walks straight past it. That line is what lets one file
be a program and a system at once without either half constraining the other.

### 11.2 needs

A guard, checked before the verb runs and before every nested verb it calls.

```cog
needs @user has @role("Operator")
needs no @channel("ticket-@user.name")
needs @user is @owner
needs @here is @channel("ticket-open")
needs @user has @role("Operator") and not @channel("archive")
```

Predicates fail closed: an unmet guard stops the verb and the reason is what
the person who triggered it is told.

### 11.3 Effects

| Statement | Meaning |
|---|---|
| `say "…"` | answer the person who triggered this, privately |
| `say "…" to everyone` | answer publicly |
| `post @channel(x) "…"` | send to a channel |
| `post @channel(x) embed { title "…" body "…" colour blue }` | send a card |
| `post @channel(x) "…" embed { … } mentioning` | text and a card, allowed to ping |
| `tell @user "…"` | direct message |
| `note "…"` | write to the log |
| `make channel "name" under @category(x) topic "…" { … }` | create, with permissions |
| `thread "name" at @channel(x)` | create a thread |
| `rename target to "name"` / `prefix "x"` / `suffix "x"` | rename |
| `rename @guild to "name"` | rename the server |
| `grant @role(x) to @user` / `revoke @role(x) from @user` | roles |
| `show @user [read, write]` / `hide @everyone` | permissions |
| `react "👀"` | react to the message in context |
| `count name up by 1 padded 3` | bump a persistent counter |
| `panel at @channel(x) "…" { button "Label" style "🔒" -> verb(args) }` | post controls |
| `ask "Title" { line "reason" } then verb` | open a form, then run a verb |
| `presence watching "the Registry"` | what the bot appears to be doing |

A `post` does not ping anybody unless it says `mentioning`. A row that runs on
every join could otherwise mention a hundred people at once, and defaulting the
loud way round is not a thing anyone asks for twice.

Colours are named by the host: `green`, `red`, `blue`, `yellow`, `orange`,
`purple`, `grey`, `black`, `white`, `blurple`. Any number also works, for a
colour with no name.

### 11.3b ask

A box someone types into, and the verb that reads what they typed.

```cog
verb start {
  ask "Open a ticket" {
    line "Subject" required
    paragraph "What happened"
  } then open
}

verb open {
  post @channel("ticket-log") "@field.subject — @field.what_happened"
  say "thanks"
}
```

`line` is one line and `paragraph` is several. The title is optional. Each
answer arrives under its label, lowercased with the spaces turned to
underscores, and is read as `@field.<name>` in the verb that follows. Two labels
that slug to the same name is an error, since one answer would silently replace
the other.

The slug keeps letters in every script, so an Arabic label produces an Arabic
name. Where that reads badly, `named` says what to call the answer and `max`
says how much someone may type:

```cog
ask "اسم السيرفر" {
  line "الاسم الجديد" named name max 100 required
} then rename_guild_do
```

A host limits how many fields fit in one box, and Cog refuses at build time
rather than dropping the extras.

### 11.4 then and @made

A creating statement may carry a `then` block. Inside it, `@made` is the thing
just created.

```cog
make channel "ticket-@user.name" under @category("Tickets") {
  hide @everyone
  show @user [read, write, history]
}
then {
  panel at @made {
    button "Close" danger -> close(@made)
  }
  say "your ticket is @made.mention"
}
```

`@made` outside a `then` is a compile error.

A statement that introduces a name lends it only to its own `then`, so when one
of them has no `then`, it takes the rest of its block as one. These two are the
same system:

```cog
count members up by 1
post @channel("welcome") "you are number @count"
```

```cog
count members up by 1 then {
  post @channel("welcome") "you are number @count"
}
```

This applies to `make`, `thread` and `count`, the three statements that bind
`@made` or `@count`. Reading order and scope then say the same thing, which is
the point: a line below `count` can talk about the count.

### 11.5 on

```cog
on member.joins {
  post @channel("welcome") "welcome @user.mention"
}

on message.posted when contains "cog" {
  react "👀"
}

on message.posted when at @channel("support") and from @role("Operator") {
  note "an operator spoke in support"
}
```

The event names and the filter keys each event supports come from the host's
capability table. A filter an event cannot supply is a compile error rather
than a trigger that never fires.

Messages the agent itself sent never fire an event. That is a runtime
guarantee, not something a filter can switch off.

### 11.6 every

```cog
every day at 00:03 { post @channel("command-log") "── @today ──" }
every 5m                { note "tick" }
every monday at 09:00   { post @channel("team") "week planning" }
```

A scheduled block has nobody to answer, so `say` and `ask` are compile errors
inside one.

---

## 12. Entities

An entity is a handle on something in the host runtime.

```
@user                  the person who triggered this
@here                  the channel it happened in
@made                  the thing just created (inside `then` only)
@everyone              the default role
@owner                 the owner of the host space
@channel("welcome")    by name
@role("Operator")      by name
@category("Tickets")   by name
@guild                 the host space itself
@today  @now  @count   current date, timestamp, the counter last bumped
```

Entities carry fields: `.id`, `.name`, `.mention`. Which fields exist depends
on the entity, and the resolver knows.

Resolution by name happens when the program runs, not when it is built, so a
channel created later still resolves. A name that does not resolve is a runtime
failure with a message naming what was looked for.

---

## 13. Lowering

`cog build` turns agent declarations into a document the host loads. Nothing
from Cog is alive at the other end: the output is data, and once it is loaded
the system runs with no Cog anywhere in it.

```
cog build systems/tickets.cog --ids ids.json --out tickets.json
```

The mapping is deliberately boring:

| Cog | becomes |
|---|---|
| `verb` inside an `intent` | an action, keyed `intent.verb` |
| statement sequence | a `sequence` action |
| `needs` | the action's guard |
| `when` inside an agent verb | a `branch` action |
| `on` | a trigger |
| `every` | a schedule |
| `panel` | a component per button, plus the action that posts them |
| a verb parameter | an argument slot the button fills |
| `@user.mention` and friends | a host placeholder |
| `@channel("x")` | an id, taken from `--ids` |

### 13.1 Names and ids

A stored row cannot look a name up, so every `@channel("x")`, `@category("x")`
and `@role("x")` needs an id. They come from a JSON file:

```json
{
  "guild": "1535979812860993617",
  "category:Tickets": "…",
  "role:Operator": "…",
  "channel:ticket-log": "…"
}
```

A build with a name it cannot resolve fails, and lists every unresolved name at
once rather than one per attempt. `cog check` does not require the file, because
a missing id is a fact about the server rather than about the source.

### 13.2 What cannot cross

**What cannot be lowered is a compile error.** A row holds fixed values in a
fixed shape, so `hold`, `carry`, `each`, `repeat`, `attempt` and `give` have no
equivalent inside an agent verb, and neither does arithmetic on anything the
build cannot already see. Joining text with `+` is folded and survives.

Saying so at build time is the whole reason the compiler exists. The alternative
is a row that stores cleanly and fails under someone's finger.

---

## 14. Reserved words

### Reserved everywhere

These 33 structure a program. Using one as a name is an error.

```
and        attempt    bring      carry      each       every      fail
give       hold       intent     is         isnt       make       needs
next       no         none       not        of         on         or
otherwise  repeat     rescue     shape      share      stop       then
times      until      verb       when       yes
```

### Contextual

Meaningful only where the grammar expects them, and ordinary identifiers
everywhere else. `note "hi"` is an effect; `note` is also a fine name for a
variable holding a note.

All 84 words together, generated from GRAMMAR.ebnf and checked by
`tests/keywords.js`:

```
and ask at attempt body bring button by
carry category channel colour command contains count danger
day each embed every everyone fail footer friday
from give grant has hide hold intent is
isnt line make max mentioning monday month named
needs next no none not note of on
or otherwise padded panel paragraph post prefix presence
primary react rename repeat required rescue revoke role
saturday say secondary shape share show starts stop
success suffix sunday tell then thread thursday times
title to topic tuesday under until up verb
wednesday when yes
```

**None of these declares, binds or controls flow using a borrowed word.** The
words other languages use for that work — `var` `let` `class` `struct` `func`
`function` `if` `else` `for` `while` `return` `true` `false` `null` `import`
`as` `in` `with` `where` `open` — are not keywords in Cog. Some are perfectly
good identifiers: `verb open` in section 11.1 declares a verb named `open`, and
that is the point of not reserving the word.

Six of them are also keywords elsewhere: `and`, `or`, `not`, `from` (Python),
`is` (Python and Swift) and `repeat` (Swift). That is the complete overlap,
checked by `tests/keywords.js` against the keyword sets of C, Java, JavaScript,
Python, Rust, Go and Swift on every build. Adding a seventh fails CI until it is
renamed or justified.

## 14b. Known rough edges

Found while building the editor grammar against this document. Recorded rather
than quietly left for someone to trip over.

- **`[14:30]` is ambiguous.** A clock time is one lexical token, so a map keyed
  `14` with the value `30` cannot be written without a space: `[14 : 30]`. The
  lexer resolves it as a time. Now that a one-digit hour is allowed, this
  reaches `[9:30]` as well. Acceptable, and worth knowing.
- **`x --1` is a comment.** Line comments start with `--` and unary minus
  exists, so `x - -1` needs the space. Unavoidable given both features.
- **`no` carries two meanings**: the boolean, and absence in
  `needs no @channel(x)`. Position separates them, but a reader has to know.
- **`has` carries two meanings.** `out.has(x)` asks a list a question;
  `@user has @role(x)` asks the host one. A `when` decides which it is reading
  by what surrounds the word, described in §6.1. Both readings are useful and
  neither name was worth giving up.
- **A verb parameter cannot be called `verb`.** It is reserved everywhere, so
  the higher-order methods in `std/list` name theirs `f` or `key` instead. The
  documentation reads slightly worse for it, and reserving the word is still
  right.
- **Permission names and colours are not defined here.** `read`, `write`,
  `history` and `blue` appear in section 11 examples and come from the host's
  capability table, the same place event names come from. This document should
  say so where it introduces them, and currently does not.

Closed since this list was written: text can name a carriage return with `\r`,
numbers can carry an exponent, a clock hour may be one digit, `ask` lowers onto
a host, and a list can be built in linear time with `add`.

## 15. Not in 0.1

Named and postponed on purpose, so their absence is a decision rather than an
oversight:

- **Types.** No annotations, no checker. The resolver catches names and arities;
  the rest is a runtime error. Worth revisiting once real programs exist.
- **Concurrency.** No tasks, no async. Effects run in order.
- **Arabic keywords.** Identifiers and text are Unicode from day one. Keyword
  synonyms are a lexer table away and are not being added before the English
  core is settled.
- **A package manager.** `bring` handles `std/` and relative paths only.
- **Bytecode.** The interpreter walks the tree. If speed ever matters, that is
  a VM behind the same front end, not a rewrite.
