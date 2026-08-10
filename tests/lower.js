// Lowering tests. Agent declarations paired with the rows they must produce,
// and the things a row cannot hold paired with the refusal they must give.

import { parse } from '../src/parser.js';
import { lower } from '../src/lower.js';
import { CogError } from '../src/errors.js';

let passed = 0;
let failed = 0;
let group = '';

const describe = (name) => {
  group = name;
  console.log(`\n${name}`);
};

const IDS = {
  guild: '900000000000000000',
  'channel:welcome': '111',
  'channel:log': '222',
  'category:Tickets': '333',
  'role:Operator': '444',
};

// A verb only becomes a row inside an intent, so a source that is nothing but
// verbs gets one put around it. Every expectation below is keyed "t.something"
// for that reason.
const build = (source, ids = IDS) => {
  const text = /^\s*verb\b/.test(source) ? `intent t {\n${source}\n}` : source;
  return lower(parse(text, 'test.cog'), { file: 'test.cog', source: text, ids });
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}   [${group}]${detail ? `\n          ${detail}` : ''}`);
  }
};

/** The first action a source produces, or the whole document with a selector. */
const gives = (name, source, expected, pick = (doc) => doc.actions[0]) => {
  let actual;
  try {
    actual = pick(build(source));
  } catch (e) {
    check(name, false, `threw: ${e.message}`);
    return;
  }
  check(name, same(actual, expected), `expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`);
};

const refuses = (name, source, fragment) => {
  try {
    build(source);
    check(name, false, 'built without error');
  } catch (e) {
    const text = `${e.message} ${e.hint ?? ''}`;
    check(name, e instanceof CogError && (!fragment || text.includes(fragment)), `got: ${e.message}`);
  }
};

const action = (kind, params, extra = {}) => ({
  key: 't.greet', kind, params, requires: null, confirm: false, note: null, ...extra,
});

// --------------------------------------------------------------- the effects

describe('effects become action kinds');

gives('say answers the click',
  'verb greet { say "hello" }',
  action('reply', { content: 'hello', ephemeral: true }));

gives('say to everyone is not ephemeral',
  'verb greet { say "hello" to everyone }',
  action('reply', { content: 'hello', ephemeral: false }));

gives('post names its channel',
  'verb greet { post @channel("welcome") "hi" }',
  action('message_send', { channel_id: '111', content: 'hi' }));

gives('tell reaches a person',
  'verb greet { tell @user "hi" }',
  action('dm_send', { user_id: '{{user.id}}', content: 'hi' }));

gives('note is a log line',
  'verb greet { note "seen" }',
  action('log', { message: 'seen' }));

gives('react carries an emoji',
  'verb greet { react "👍" }',
  action('reaction_add', { emoji: '👍' }));

gives('grant with no one named acts on whoever clicked',
  'verb greet { grant @role("Operator") }',
  action('role_grant', { role_id: '444' }));

gives('revoke names the person',
  'verb greet { revoke @role("Operator") from @user }',
  action('role_revoke', { role_id: '444', user_id: '{{user.id}}' }));

gives('an embed becomes an embed',
  'verb greet { say embed { title "T" body "B" footer "F" } }',
  action('reply', { embed: { title: 'T', description: 'B', footer: 'F' }, ephemeral: true }));

// ----------------------------------------------------------------- structure

describe('structure');

gives('make channel',
  'verb greet { make channel "room" }',
  action('channel_create', { name: 'room', type: 'text' }));

gives('make category',
  'verb greet { make category "Group" }',
  action('channel_create', { name: 'Group', type: 'category' }));

gives('make role has no type',
  'verb greet { make role "Helper" }',
  action('role_create', { name: 'Helper' }));

gives('under becomes a parent',
  'verb greet { make channel "room" under @category("Tickets") }',
  action('channel_create', { name: 'room', type: 'text', parent_id: '333' }));

gives('show and hide become overwrites',
  'verb greet { make channel "room" { hide @everyone\nshow @user [read, write] } }',
  action('channel_create', {
    name: 'room',
    type: 'text',
    overwrites: [
      { id: '{{guild.id}}', type: 'role', deny: ['ViewChannel'] },
      { id: '{{user.id}}', type: 'member', allow: ['ViewChannel', 'SendMessages'] },
    ],
  }));

gives('a standalone show sets an overwrite here',
  'verb greet { show @role("Operator") [manage] }',
  action('overwrite_set', {
    channel_id: '{{channel.id}}',
    target_id: '444',
    target_type: 'role',
    allow: ['ManageChannels'],
  }));

gives('rename prefixes',
  'verb greet { rename @here prefix "closed-" }',
  action('channel_edit', { channel_id: '{{channel.id}}', name_prefix: 'closed-' }));

gives('a thread is created where it is told',
  'verb greet { thread "talk" at @channel("welcome") }',
  action('thread_create', { channel_id: '111', name: 'talk' }));

// ------------------------------------------------------------------ scoping

describe('what an effect lends to what follows it');

gives('make lends @made to the rest of its block',
  'verb greet { make channel "room"\nsay "made @made.mention" }',
  action('channel_create', {
    name: 'room',
    type: 'text',
    then: { kind: 'reply', params: { content: 'made {{created.mention}}', ephemeral: true } },
  }));

gives('an explicit then is left alone',
  'verb greet { make channel "room" then { say "a" }\nsay "b" }',
  action('sequence', {
    steps: [
      {
        kind: 'channel_create',
        params: { name: 'room', type: 'text', then: { kind: 'reply', params: { content: 'a', ephemeral: true } } },
      },
      { kind: 'reply', params: { content: 'b', ephemeral: true } },
    ],
  }));

gives('count lends @count to the rest of its block',
  'verb greet { count members up by 1\nsay "number @count" }',
  action('counter_bump', {
    key: 'members',
    by: 1,
    then: { kind: 'reply', params: { content: 'number {{counter.value}}', ephemeral: true } },
  }));

gives('a counter is declared by being used',
  'verb greet { count members up by 1 }',
  [{ key: 'members', value: 0 }],
  (doc) => doc.counters);

gives('several statements become a sequence',
  'verb greet { say "a"\npost @channel("log") "b" }',
  action('sequence', {
    steps: [
      { kind: 'reply', params: { content: 'a', ephemeral: true } },
      { kind: 'message_send', params: { channel_id: '222', content: 'b' } },
    ],
  }));

// --------------------------------------------------------------- parameters

describe('parameters arrive from a button');

gives('a parameter is an argument slot',
  'verb greet(target) { rename target prefix "x-" }',
  action('channel_edit', { channel_id: '{{arg.0}}', name_prefix: 'x-' }));

gives('a parameter mentions as a channel',
  'verb greet(target) { say "closed @target.mention" }',
  action('reply', { content: 'closed <#{{arg.0}}>', ephemeral: true }));

refuses('a parameter has no name to read',
  'verb greet(target) { say "@target.name" }',
  'arrives as an id');

refuses('a default has nowhere to live',
  'verb greet(target = 1) { say "x" }',
  'has a default');

// ---------------------------------------------------------------- predicates

describe('needs becomes requires');

gives('a role guard',
  'verb greet { needs @user has @role("Operator")\nsay "in" }',
  { type: 'has_role', role_id: '444' },
  (doc) => doc.actions[0].requires);

gives('an absent channel',
  'verb greet { needs no @channel("welcome")\nsay "in" }',
  { type: 'channel_absent', name: 'welcome' },
  (doc) => doc.actions[0].requires);

gives('the owner',
  'verb greet { needs @user is @owner\nsay "in" }',
  { type: 'is_guild_owner' },
  (doc) => doc.actions[0].requires);

gives('two conditions joined',
  'verb greet { needs @user is @owner and @user has @role("Operator")\nsay "in" }',
  { type: 'all', of: [{ type: 'is_guild_owner' }, { type: 'has_role', role_id: '444' }] },
  (doc) => doc.actions[0].requires);

gives('when becomes a branch',
  'verb greet { when @user has @role("Operator") { say "yes" } otherwise { say "no" } }',
  action('branch', {
    if: { type: 'has_role', role_id: '444' },
    then: { kind: 'reply', params: { content: 'yes', ephemeral: true } },
    else: { kind: 'reply', params: { content: 'no', ephemeral: true } },
  }));

refuses('needs belongs at the top',
  'verb greet { say "a"\nneeds @user is @owner }',
  'goes first');

refuses('a when in an agent verb asks the host',
  'verb greet { when 1 < 2 { say "a" } }',
  'asks the host a question');

// -------------------------------------------------------------- events, time

describe('events and schedules');

gives('an event becomes a trigger',
  'on member.joins { post @channel("welcome") "hi" }',
  [{ key: 'on_member_joins', event: 'member_join', filter: {}, action_key: 'on_member_joins', enabled: true, note: null }],
  (doc) => doc.triggers);

gives('a filter is carried across',
  'on message.posted when starts "!help" and at @channel("welcome") { post @channel("log") "asked" }',
  { starts_with: '!help', channel_id: '111' },
  (doc) => doc.triggers[0].filter);

gives('a daily schedule is cron',
  'every day at 00:03 { post @channel("log") "tick" }',
  '3 0 * * *',
  (doc) => doc.schedules[0].cron);

gives('a weekday schedule is cron',
  'every monday at 09:30 { post @channel("log") "tick" }',
  '30 9 * * 1',
  (doc) => doc.schedules[0].cron);

gives('a short interval is cron',
  'every 15m { post @channel("log") "tick" }',
  '*/15 * * * *',
  (doc) => doc.schedules[0].cron);

refuses('an interval cron cannot express',
  'every 7m { post @channel("log") "tick" }',
  'cannot be written as a host schedule');

refuses('an event the host never reports',
  'on member.dances { post @channel("log") "x" }',
  'is not an event this host reports');

refuses('a filter the event never supplies',
  'on member.joins when contains "hi" { post @channel("log") "x" }',
  'means nothing for this event');

refuses('say has nobody to answer',
  'on member.joins { say "hi" }',
  'nothing here was pressed');

// ------------------------------------------------------------------ panels

describe('panels and components');

const panel = build('intent t {\n  verb open { panel at @here { button "Close" danger -> close } }\n  verb close { say "shut" }\n}');

check('a button declares a component', panel.components.length === 1);
check('the component points at the verb', panel.components[0].action_key === 't.close');
check('the component keeps the label', panel.components[0].spec.label === 'Close');
check('the key is short enough for a custom_id', panel.components[0].key.length <= 10);
check('the panel refers to the component',
  panel.actions[0].params.buttons[0].component_key === panel.components[0].key);

refuses('a button pointing nowhere',
  'verb greet { panel at @here { button "X" -> missing } }',
  'there is no verb called');

// ------------------------------------------------------------------ naming

describe('names and ids');

gives('an intent prefixes its verbs',
  'intent t { verb greet { say "a" } }',
  't.greet',
  (doc) => doc.actions[0].key);

gives('a verb outside an intent is an ordinary function, not a row',
  'on member.joins { post @channel("welcome") "hi" }\nverb helper(x) { give x + 1 }',
  ['on_member_joins'],
  (doc) => doc.actions.map((a) => a.key));

gives('the guild id is carried',
  'verb greet { say "a" }',
  '900000000000000000',
  (doc) => doc.guild_id);

refuses('a name with no id', 'verb greet { post @channel("nowhere") "x" }', 'could not be turned into an id');
refuses('an entity the host lacks', 'verb greet { post @nonsense "x" }', 'not something this host provides');
refuses('a permission that is not real', 'verb greet { show @user [teleport] }', 'is not a permission');
refuses('two things with one name', 'verb greet { say "a" }\nverb greet { say "b" }', 'both called');

// ----------------------------------------------------------- what cannot go

describe('what a row cannot hold');

refuses('a binding', 'verb greet { hold x = 1 }', 'no equivalent in a stored row');
refuses('a loop', 'verb greet { repeat 3 times { say "a" } }', 'no equivalent in a stored row');
refuses('arithmetic', 'verb greet { say "n" }\nverb other { post @channel("log") 1 * 2 }', 'cannot be worked out');
refuses('a verb called with arguments', 'verb a { say "x" }\nverb b { a(1) }', 'cannot be passed anything');

describe('nothing to build');
check('a program with no agent layer produces no rows',
  build('hold x = 1\nnote x').actions.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
