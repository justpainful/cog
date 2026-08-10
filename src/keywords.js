// The keyword set, split by how strongly it is reserved.
//
// Writing the spec's own examples proved that reserving all 84 words makes the
// language unusable: `carry count = 0` failed because `count` heads the counter
// statement, and the same would have been true of `title`, `body`, `line`,
// `role` and `day`. Those are ordinary variable names, and a language that
// forbids them is not one you would choose.
//
// So only the words that structure a program are reserved everywhere. The rest
// are contextual: they mean something in the one position the grammar expects
// them, and are ordinary identifiers anywhere else.

/** Reserved everywhere. Using one as a name is an error. */
export const HARD = new Set([
  // declaration and structure
  'verb', 'intent', 'shape', 'bring', 'share', 'on', 'every',
  // binding
  'hold', 'carry',
  // control flow
  'when', 'otherwise', 'each', 'of', 'repeat', 'until', 'times',
  'give', 'stop', 'next', 'attempt', 'rescue', 'fail',
  // logical operators
  'and', 'or', 'not', 'is', 'isnt',
  // literal constants
  'yes', 'no', 'none',
  // the agent constructs that introduce a block or a guard
  'needs', 'make', 'then',
]);

/**
 * Meaningful only where the grammar expects them. `note` heads a statement, and
 * is also a perfectly good name for a variable holding a note.
 */
export const SOFT = new Set([
  // effect heads
  'say', 'post', 'tell', 'note', 'grant', 'revoke', 'show', 'hide',
  'react', 'count', 'panel', 'button', 'ask', 'thread', 'rename', 'presence',
  // A slash command reads as a declaration but is not reserved: the grammar
  // only sees it where a name and a block follow.
  'command',
  // prepositions and modifiers
  'at', 'to', 'from', 'under', 'by', 'up', 'prefix', 'suffix',
  'required', 'starts', 'contains', 'everyone', 'has', 'line', 'paragraph',
  'topic', 'padded', 'mentioning', 'named', 'max',
  // embed fields
  'embed', 'title', 'body', 'colour', 'footer',
  // make kinds and button styles
  'channel', 'category', 'role',
  'primary', 'secondary', 'success', 'danger',
  // schedule words
  'day', 'month',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

/** Every word the language knows, for the spec and for tooling. */
export const KEYWORDS = new Set([...HARD, ...SOFT]);

export const WEEKDAYS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

export const BUTTON_STYLES = new Set(['primary', 'secondary', 'success', 'danger']);
export const MAKE_KINDS = new Set(['channel', 'category', 'role']);
export const EMBED_FIELDS = new Set(['title', 'body', 'colour', 'footer']);
