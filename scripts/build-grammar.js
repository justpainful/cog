// Generate the TextMate grammar from the language definition.
//
//   node scripts/build-grammar.js
//
// The grammar was hand-maintained for one afternoon and immediately drifted:
// it highlighted words that had stopped being keywords, and lost a word
// boundary during an edit so `shape` matched inside `shapes`. Generating it
// from src/keywords.js means the editor and the parser cannot disagree about
// what a keyword is.
//
// This file is also the artefact GitHub Linguist wants later, so it is worth
// having something that regenerates it rather than something someone edits.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARD } from '../src/keywords.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Longest first, so `otherwise` is not eaten by `or`.
const alt = (words) => [...words].sort((a, b) => b.length - a.length || a.localeCompare(b)).join('|');
const word = (words) => `\\b(${alt(words)})\\b`;

// ---- hard keywords, reserved everywhere ------------------------------------

const DECLARATION = ['verb', 'intent', 'shape', 'bring', 'share', 'on', 'every', 'hold', 'carry'];
const CONTROL = ['when', 'otherwise', 'each', 'of', 'repeat', 'until', 'times', 'give', 'stop', 'next', 'attempt', 'rescue', 'fail'];
const OPERATOR_WORD = ['and', 'or', 'not', 'is', 'isnt'];
const AGENT = ['needs', 'make', 'then'];
const LITERALS = ['yes', 'no', 'none'];

const covered = new Set([...DECLARATION, ...CONTROL, ...OPERATOR_WORD, ...AGENT, ...LITERALS]);
const missing = [...HARD].filter((w) => !covered.has(w));
const bogus = [...covered].filter((w) => !HARD.has(w));
if (missing.length) throw new Error(`hard keyword in no group: ${missing.join(', ')}`);
if (bogus.length) throw new Error(`group holds a word that is not hard: ${bogus.join(', ')}`);

// ---- contextual words, highlighted only where they are pinned ---------------

// An effect heads a statement, and in every real program a statement starts its
// own line. Anchoring here colours the agent layer without claiming a word
// anywhere it might be an ordinary name.
const EFFECT_HEADS = ['say', 'post', 'tell', 'note', 'grant', 'revoke', 'react', 'rename', 'thread', 'panel', 'ask', 'count', 'show', 'hide'];

// Prepositions that only ever appear between an effect and an entity.
const MODIFIERS = ['under', 'prefix', 'suffix', 'has', 'everyone', 'starts', 'contains'];

const MAKE_KINDS = ['channel', 'category', 'role'];
const STYLES = ['primary', 'secondary', 'success', 'danger'];
const PERIODS = ['day', 'month', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const grammar = {
  $schema: 'https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json',
  name: 'Cog',
  scopeName: 'source.cog',
  fileTypes: ['cog'],
  patterns: [
    { include: '#comments' },
    { include: '#embed-block' },
    { include: '#ask-block' },
    { include: '#panel-block' },
    { include: '#permission-list' },
    { include: '#strings' },
    { include: '#declarations' },
    { include: '#entities' },
    { include: '#constants' },
    { include: '#keywords' },
    { include: '#numbers' },
    { include: '#calls' },
    { include: '#operators' },
  ],
  repository: {
    comments: {
      match: '(--).*$',
      name: 'comment.line.double-dash.cog',
      captures: { 1: { name: 'punctuation.definition.comment.cog' } },
    },

    // ---- text --------------------------------------------------------------

    strings: { patterns: [{ include: '#string-block' }, { include: '#string-line' }] },

    'string-block': {
      begin: '"""',
      end: '"""',
      name: 'string.quoted.triple.cog',
      beginCaptures: { 0: { name: 'punctuation.definition.string.begin.cog' } },
      endCaptures: { 0: { name: 'punctuation.definition.string.end.cog' } },
      patterns: [{ include: '#string-inner' }],
    },
    'string-line': {
      begin: '"',
      end: '"',
      name: 'string.quoted.double.cog',
      beginCaptures: { 0: { name: 'punctuation.definition.string.begin.cog' } },
      endCaptures: { 0: { name: 'punctuation.definition.string.end.cog' } },
      patterns: [{ include: '#string-inner' }],
    },
    'string-inner': {
      patterns: [
        // @@ is a literal at-sign and must be consumed before the interpolation
        // rules, or the second @ is offered to them and starts a false one.
        { match: '@@', name: 'constant.character.escape.cog' },
        { match: '\\\\[nt"\\\\@]', name: 'constant.character.escape.cog' },
        { match: '\\\\.', name: 'invalid.illegal.unknown-escape.cog' },
        {
          begin: '@\\(',
          end: '\\)',
          name: 'meta.embedded.line.cog',
          beginCaptures: { 0: { name: 'punctuation.section.interpolation.begin.cog' } },
          endCaptures: { 0: { name: 'punctuation.section.interpolation.end.cog' } },
          patterns: [{ include: '$self' }],
        },
        {
          match: '(@)([\\p{L}_][\\p{L}\\p{N}_]*(?:\\.[\\p{L}_][\\p{L}\\p{N}_]*)*)',
          name: 'meta.embedded.line.cog',
          captures: {
            1: { name: 'punctuation.definition.interpolation.cog' },
            2: { name: 'variable.other.interpolated.cog' },
          },
        },
        { match: '@', name: 'invalid.illegal.empty-interpolation.cog' },
      ],
    },

    // ---- blocks where contextual words really are keywords -----------------

    'embed-block': {
      begin: '\\b(embed)\\s*(\\{)',
      end: '(\\})',
      beginCaptures: {
        1: { name: 'keyword.other.effect.cog' },
        2: { name: 'punctuation.section.block.begin.cog' },
      },
      endCaptures: { 1: { name: 'punctuation.section.block.end.cog' } },
      patterns: [
        { match: '\\b(title|body|colour|footer)\\b', name: 'variable.other.property.cog' },
        { include: '$self' },
      ],
    },
    'ask-block': {
      begin: '\\b(ask)\\s*(\\{)',
      end: '(\\})',
      beginCaptures: {
        1: { name: 'keyword.other.effect.cog' },
        2: { name: 'punctuation.section.block.begin.cog' },
      },
      endCaptures: { 1: { name: 'punctuation.section.block.end.cog' } },
      patterns: [
        { match: '\\b(line|paragraph)\\b', name: 'variable.other.property.cog' },
        { match: '\\b(required)\\b', name: 'storage.modifier.cog' },
        { include: '$self' },
      ],
    },
    'panel-block': {
      begin: '\\b(panel)\\s+(at)\\b',
      end: '(?<=\\})',
      beginCaptures: {
        1: { name: 'keyword.other.effect.cog' },
        2: { name: 'keyword.other.cog' },
      },
      patterns: [
        { match: '\\b(button)\\b', name: 'keyword.other.effect.cog' },
        { match: word(STYLES), name: 'support.type.cog' },
        { include: '$self' },
      ],
    },
    // A permission list is a fixed vocabulary supplied by the host, not free
    // identifiers, so it reads better as constants than as plain names.
    'permission-list': {
      begin: '(\\[)(?=\\s*[a-z]+(\\s*,\\s*[a-z]+)*\\s*\\])',
      end: '(\\])',
      beginCaptures: { 1: { name: 'punctuation.section.brackets.begin.cog' } },
      endCaptures: { 1: { name: 'punctuation.section.brackets.end.cog' } },
      patterns: [{ match: '\\b[a-z][a-zA-Z]*\\b', name: 'support.constant.permission.cog' }],
    },

    // ---- declarations ------------------------------------------------------

    declarations: {
      patterns: [
        {
          match: '\\b(verb)\\s+([\\p{L}_][\\p{L}\\p{N}_]*(?:\\.[\\p{L}_][\\p{L}\\p{N}_]*)*)',
          captures: { 1: { name: 'keyword.declaration.cog' }, 2: { name: 'entity.name.function.cog' } },
        },
        {
          match: '\\b(shape)\\s+([\\p{L}_][\\p{L}\\p{N}_]*)',
          captures: { 1: { name: 'keyword.declaration.cog' }, 2: { name: 'entity.name.type.cog' } },
        },
        {
          match: '\\b(intent)\\s+([\\p{L}_][\\p{L}\\p{N}_]*)',
          captures: { 1: { name: 'keyword.declaration.cog' }, 2: { name: 'entity.name.namespace.cog' } },
        },
        {
          match: '\\b(bring)\\s+([\\p{L}_][\\p{L}\\p{N}_]*)',
          captures: { 1: { name: 'keyword.declaration.cog' }, 2: { name: 'entity.name.namespace.cog' } },
        },
      ],
    },

    // ---- entities ----------------------------------------------------------

    entities: {
      match: '(@)([\\p{L}_][\\p{L}\\p{N}_]*)',
      captures: {
        1: { name: 'punctuation.definition.entity.cog' },
        2: { name: 'variable.language.entity.cog' },
      },
    },

    constants: { match: word(LITERALS), name: 'constant.language.cog' },

    // ---- keywords ----------------------------------------------------------

    keywords: {
      patterns: [
        { match: word(DECLARATION), name: 'keyword.declaration.cog' },
        { match: word(CONTROL), name: 'keyword.control.cog' },
        { match: word(OPERATOR_WORD), name: 'keyword.operator.word.cog' },
        { match: word(AGENT), name: 'keyword.other.effect.cog' },
        {
          match: `^\\s*(${alt(EFFECT_HEADS)})\\b`,
          captures: { 1: { name: 'keyword.other.effect.cog' } },
        },
        { match: word(MODIFIERS), name: 'keyword.other.cog' },
        { match: `(?<=\\bmake\\s{1,20})${word(MAKE_KINDS)}`, name: 'support.type.cog' },
        { match: `(?<=\\bevery\\s{1,20})${word(PERIODS)}`, name: 'support.constant.cog' },
        { match: `(?<=\\bneeds\\s{1,20})\\b(no)\\b`, name: 'keyword.operator.word.cog' },
        { match: '\\b(at|to|from|by|up)\\b(?=\\s+@)', name: 'keyword.other.cog' },
      ],
    },

    // ---- literals and the rest ---------------------------------------------

    numbers: {
      patterns: [
        { match: '\\b\\d{2}:\\d{2}\\b', name: 'constant.numeric.time.cog' },
        { match: '\\b\\d[\\d_]*(\\.\\d[\\d_]*)?[smhdw]\\b', name: 'constant.numeric.duration.cog' },
        { match: '\\b\\d[\\d_]*(\\.\\d[\\d_]*)?\\b', name: 'constant.numeric.cog' },
      ],
    },
    calls: {
      match: '([\\p{L}_][\\p{L}\\p{N}_]*)\\s*(?=\\()',
      captures: { 1: { name: 'entity.name.function.call.cog' } },
    },
    operators: { match: '->|<=|>=|[-+*/%<>=]', name: 'keyword.operator.cog' },
  },
};

const out = join(ROOT, 'editor', 'vscode', 'syntaxes', 'cog.tmLanguage.json');
writeFileSync(out, `${JSON.stringify(grammar, null, 2)}\n`);

// Compiling every pattern here means a broken regex fails the build rather than
// silently disabling one rule in the editor.
let count = 0;
const walk = (node) => {
  if (!node || typeof node !== 'object') return;
  for (const key of ['match', 'begin', 'end']) {
    if (typeof node[key] === 'string') {
      new RegExp(node[key], 'u');
      count++;
    }
  }
  Object.values(node).forEach(walk);
};
walk(grammar);

console.log(`wrote ${out}`);
console.log(`  ${HARD.size} hard keywords, ${count} patterns, all compile`);
