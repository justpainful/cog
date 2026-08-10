// What a host runtime can do.
//
// The agent layer is checked against this table rather than against anything
// hardcoded in the compiler, so pointing Cog at a different host is a new table
// and not a new compiler. Everything below describes Cognition, a Discord agent
// whose behaviour lives in a SQLite registry.
//
// If the host grows a primitive, one entry here teaches the language about it.
// If the language emits something the host has never heard of, that is a
// compile error naming what is missing rather than a row that fails on a click.

export const COGNITION = {
  name: 'cognition',
  description: 'A Discord server whose behaviour is registry rows.',

  // ---- effects: a Cog statement to a host action kind ----------------------
  effects: {
    Say: { kind: 'reply', needsInteraction: true },
    Post: { kind: 'message_send' },
    Tell: { kind: 'dm_send' },
    Note: { kind: 'log' },
    Make: { kind: { channel: 'channel_create', category: 'channel_create', role: 'role_create' } },
    Thread: { kind: 'thread_create' },
    Rename: { kind: 'channel_edit' },
    Grant: { kind: 'role_grant' },
    Revoke: { kind: 'role_revoke' },
    Permission: { kind: 'overwrite_set' },
    React: { kind: 'reaction_add' },
    Count: { kind: 'counter_bump' },
    Panel: { kind: 'panel_send' },
    Ask: { kind: 'modal_open', needsInteraction: true },
    When: { kind: 'branch' },
    Block: { kind: 'sequence' },
  },

  // ---- events: a Cog event name to a host trigger, and its filters ---------
  events: {
    'member.joins': { event: 'member_join', filters: ['from_bot'] },
    'member.leaves': { event: 'member_leave', filters: ['from_bot'] },
    'message.posted': {
      event: 'message_create',
      filters: ['channel_id', 'contains', 'starts_with', 'from_bot', 'has_role', 'author_id'],
    },
    'reaction.added': {
      event: 'reaction_add',
      filters: ['channel_id', 'emoji', 'from_bot', 'has_role'],
    },
    'channel.deleted': { event: 'channel_delete', filters: ['channel_id'] },
    'thread.created': { event: 'thread_create', filters: ['channel_id'] },
  },

  // ---- predicates ---------------------------------------------------------
  predicates: {
    has_role: { needs: ['role_id'] },
    is_guild_owner: { needs: [] },
    in_channel: { needs: ['channel_id'] },
    channel_exists: { needs: ['name'] },
    channel_absent: { needs: ['name'] },
    session_state: { needs: ['session_id', 'state'] },
    always: { needs: [] },
    never: { needs: [] },
  },

  // ---- permission names the host understands ------------------------------
  // Cog uses short English; the host uses Discord's names.
  permissions: {
    read: 'ViewChannel',
    write: 'SendMessages',
    history: 'ReadMessageHistory',
    manage: 'ManageChannels',
    attach: 'AttachFiles',
    embed: 'EmbedLinks',
    react: 'AddReactions',
    threads: 'CreatePublicThreads',
    speak: 'Speak',
    connect: 'Connect',
    mention: 'MentionEveryone',
    everything: 'Administrator',
  },

  // ---- entities, and the template each one lowers to ----------------------
  entities: {
    user: {
      id: '{{user.id}}',
      name: '{{user.name}}',
      mention: '{{user.mention}}',
      display: '{{user.display}}',
      bare: '{{user.id}}',
    },
    here: {
      id: '{{channel.id}}',
      name: '{{channel.name}}',
      mention: '{{channel.mention}}',
      bare: '{{channel.id}}',
    },
    made: {
      id: '{{created.id}}',
      name: '{{created.name}}',
      mention: '{{created.mention}}',
      bare: '{{created.id}}',
    },
    guild: { id: '{{guild.id}}', bare: '{{guild.id}}' },
    // @everyone is the role whose id is the guild's, which is Discord's own
    // arrangement rather than a trick of this compiler.
    everyone: { bare: '{{guild.id}}' },
    today: { bare: '{{today}}' },
    now: { bare: '{{now}}' },
    count: { bare: '{{counter.value}}' },
    owner: { bare: null }, // only meaningful inside a predicate
    // What someone typed into an ask. The field names are whatever that ask
    // called them, so this entity is open rather than a fixed list.
    field: { bare: null, open: '{{field.NAME}}' },
  },

  // ---- what an ask becomes ------------------------------------------------
  ask: {
    kind: 'modal_open',
    // Discord allows five inputs in one box and no more.
    maxFields: 5,
    shapes: { line: 'short', paragraph: 'paragraph' },
  },

  // Entities that name something and need an id resolved before the host can
  // act on them.
  namedEntities: ['channel', 'category', 'role'],

  // ---- schedules ----------------------------------------------------------
  schedule: {
    // A duration becomes a cron expression, so only the ones cron can express
    // are allowed. Saying so at compile time beats a schedule that never fires.
    fromDuration(seconds) {
      if (seconds % 60 !== 0) return null;
      const minutes = seconds / 60;
      // The interval has to divide its unit evenly. `*/7` is valid cron and
      // fires at 0, 7 … 56 and then waits four minutes, which is not what
      // "every 7m" says, so it is refused rather than approximated.
      if (minutes < 60) return 60 % minutes === 0 ? `*/${minutes} * * * *` : null;
      if (minutes % 60 !== 0) return null;
      const hours = minutes / 60;
      if (hours < 24) return 24 % hours === 0 ? `0 */${hours} * * *` : null;
      if (hours === 24) return '0 0 * * *';
      return null;
    },
    weekdays: { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 },
  },
};

/** Names an effect, for error messages that say what the host lacks. */
export function effectFor(host, nodeKind, what = null) {
  const entry = host.effects[nodeKind];
  if (!entry) return null;
  if (typeof entry.kind === 'string') return entry;
  const kind = entry.kind[what];
  return kind ? { ...entry, kind } : null;
}
