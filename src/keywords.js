// The keyword set, in one place.
//
// tests/keywords.js checks this against GRAMMAR.ebnf and against the keyword
// lists of seven mainstream languages, so this file cannot drift from the
// specification without failing the build.

export const KEYWORDS = new Set([
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
  // agent effects
  'needs', 'make', 'then', 'say', 'post', 'tell', 'note',
  'grant', 'revoke', 'show', 'hide', 'react', 'count',
  'panel', 'button', 'ask', 'thread', 'rename',
  // prepositions and modifiers
  'at', 'to', 'from', 'under', 'by', 'up', 'prefix', 'suffix',
  'required', 'starts', 'contains', 'everyone', 'has',
  'line', 'paragraph',
  // embed fields
  'embed', 'title', 'body', 'colour', 'footer',
  // make kinds and button styles
  'channel', 'category', 'role',
  'primary', 'secondary', 'success', 'danger',
  // schedule words
  'day', 'month',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

/** Words that end a statement's own grammar, used by the parser to stop early. */
export const WEEKDAYS = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

export const BUTTON_STYLES = new Set(['primary', 'secondary', 'success', 'danger']);
export const MAKE_KINDS = new Set(['channel', 'category', 'role']);
