//! The keyword set, split by how strongly it is reserved.
//!
//! Writing the specification's own examples proved that reserving all of these
//! everywhere makes the language unusable: `carry count = 0` fails because
//! `count` heads the counter statement, and the same is true of `title`,
//! `body`, `line`, `role` and `day`. Those are ordinary variable names, and a
//! language that forbids them is not one anybody chooses.
//!
//! So only the words that structure a program are reserved everywhere. The rest
//! are contextual: they mean something in the one position the grammar expects
//! them, and are ordinary identifiers anywhere else. The lexer only turns the
//! hard ones into keywords; the parser recognises the soft ones by position.

/// Reserved everywhere. Using one as a name is an error.
pub const HARD: &[&str] = &[
    // declaration and structure
    "verb", "intent", "shape", "bring", "share", "on", "every",
    // binding
    "hold", "carry",
    // control flow
    "when", "otherwise", "each", "of", "repeat", "until", "times",
    "give", "stop", "next", "attempt", "rescue", "fail",
    // logical operators
    "and", "or", "not", "is", "isnt",
    // literal constants
    "yes", "no", "none",
    // the agent constructs that introduce a block or a guard
    "needs", "make", "then",
];

/// Meaningful only where the grammar expects them. `note` heads a statement and
/// is also a perfectly good name for a variable holding a note.
pub const SOFT: &[&str] = &[
    // effect heads
    "say", "post", "tell", "note", "grant", "revoke", "show", "hide",
    "react", "count", "panel", "button", "ask", "thread", "rename", "presence",
    // a slash command reads as a declaration but is not reserved: the grammar
    // only sees it where a name and a block follow
    "command",
    // prepositions and modifiers
    "at", "to", "from", "under", "by", "up", "prefix", "suffix",
    "required", "starts", "contains", "everyone", "has", "line", "paragraph",
    "topic", "padded", "mentioning", "named", "max",
    // embed fields
    "embed", "title", "body", "colour", "footer",
    // make kinds and button styles
    "channel", "category", "role",
    "primary", "secondary", "success", "danger",
    // schedule words
    "day", "month",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];

pub const WEEKDAYS: &[&str] =
    &["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

pub const BUTTON_STYLES: &[&str] = &["primary", "secondary", "success", "danger"];
pub const MAKE_KINDS: &[&str] = &["channel", "category", "role"];
pub const EMBED_FIELDS: &[&str] = &["title", "body", "colour", "footer"];

pub fn is_hard_keyword(word: &str) -> bool {
    HARD.contains(&word)
}

pub fn is_keyword(word: &str) -> bool {
    HARD.contains(&word) || SOFT.contains(&word)
}
