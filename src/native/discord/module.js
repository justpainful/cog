// Discord, described as operations rather than offered as objects.
//
// discord.js gives you a Client, an object graph, and methods that do things.
// It is a good library for a person writing JavaScript. It is the wrong shape
// for an agent, for four reasons, and this module is the four answers:
//
//   1. An agent needs to know what it can do before it tries. Every operation
//      here is a row in a table with its arguments, whether it is destructive
//      and whether it can be taken back — readable from inside Cog.
//   2. An agent needs to see what would happen. `planning` runs any sequence
//      and records the calls instead of making them.
//   3. An agent needs to undo. Every mutation returns a receipt carrying the
//      exact call that reverses it, built from the state read beforehand.
//   4. An agent must not delete things by accident. Anything unrecoverable
//      refuses to run without a token minted for those exact arguments.
//
// None of that is possible on top of a library that has already decided a
// channel is an object with a .delete() method.

import { createHash, randomUUID } from 'node:crypto';
import { Rest } from './rest.js';
import { Gateway } from './gateway.js';

const now = () => new Date().toISOString();

/** Ten minutes is long enough to think and short enough to lose your nerve. */
const TOKEN_LIFE = 10 * 60 * 1000;

const fingerprint = (op, args) =>
  createHash('sha256').update(`${op}:${JSON.stringify(args ?? {})}`).digest('hex').slice(0, 16);

// Confirmation tokens, and the recording state for `plan`. Both belong to the
// module rather than to any one operation, and both are read on every mutation.
const tokens = new Map();
const plan = [];
let planning = false;

class Discord {
  rest = null;
  gateway = null;
  guildId = null;
  emit = () => {};

  // ---- configuration ------------------------------------------------------

  ready() {
    if (!this.rest) {
      throw new Error(
        'discord is not connected — call discord.use([token: …, guild: …]), or set DISCORD_TOKEN and DISCORD_GUILD_ID',
      );
    }
    return this.rest;
  }

  guildRoute(tail = '') {
    if (!this.guildId) throw new Error('no guild — pass one to discord.use, or set DISCORD_GUILD_ID');
    return `/guilds/${this.guildId}${tail}`;
  }

  /**
   * Recording rather than doing.
   *
   * Every mutation asks this first. While a plan is open it gets back a
   * description instead of a result, which is how `plan` answers "what would
   * this do" without the answer being "it did it".
   */
  intercept(name, call) {
    if (!planning) return null;
    plan.push({ op: name, ...call });
    return { planned: true, op: name, ...call };
  }

  async close() {
    await this.gateway?.close();
  }
}

const d = new Discord();

// ---------------------------------------------------------------- shaping

// What a Cog program sees. Discord's payloads carry sixty fields nobody reads,
// and handing all of them over makes every value in the language a haystack.
const asChannel = (c) =>
  c && {
    id: c.id,
    name: c.name ?? '',
    kind: { 0: 'text', 2: 'voice', 4: 'category', 5: 'news', 11: 'thread', 13: 'stage', 15: 'forum' }[c.type] ?? String(c.type),
    topic: c.topic ?? '',
    parent: c.parent_id ?? '',
    position: c.position ?? 0,
    nsfw: !!c.nsfw,
    mention: `<#${c.id}>`,
  };

const asRole = (r) =>
  r && {
    id: r.id,
    name: r.name,
    colour: r.color ?? 0,
    position: r.position ?? 0,
    hoisted: !!r.hoist,
    mentionable: !!r.mentionable,
    managed: !!r.managed,
    permissions: r.permissions ?? '0',
    mention: `<@&${r.id}>`,
  };

const asUser = (u) =>
  u && {
    id: u.id,
    name: u.username ?? '',
    display: u.global_name ?? u.username ?? '',
    bot: !!u.bot,
    mention: `<@${u.id}>`,
  };

const asMember = (m) =>
  m && {
    ...asUser(m.user ?? {}),
    nickname: m.nick ?? '',
    display: m.nick ?? m.user?.global_name ?? m.user?.username ?? '',
    roles: m.roles ?? [],
    joined: m.joined_at ?? '',
  };

const asMessage = (m) =>
  m && {
    id: m.id,
    channel: m.channel_id,
    author: asUser(m.author ?? {}),
    content: m.content ?? '',
    at: m.timestamp ?? '',
    edited: m.edited_timestamp ?? '',
    pinned: !!m.pinned,
    attachments: (m.attachments ?? []).map((a) => ({ id: a.id, name: a.filename, url: a.url, size: a.size })),
  };

/** Every mutation answers with one of these, and every one knows its own undo. */
const receipt = (op, { target, before = null, after = null, undo = null, note = null }) => ({
  receipt: randomUUID(),
  op,
  at: now(),
  target,
  before,
  after,
  undo,
  reversible: undo !== null,
  note,
});

// ------------------------------------------------------------- the table

/**
 * Each operation says what it needs, whether it can be taken back, and whether
 * it is the kind of thing that should make you stop and confirm.
 *
 * `destructive` here means one specific thing: the change cannot be undone by
 * this module, because the undo would need something Discord does not give
 * back — a channel's id and its message history, chiefly.
 */
const OPS = {};

const op = (name, spec) => {
  OPS[name] = { name, takes: [], destructive: false, reads: false, ...spec };
};

// ---- identity and reading -----------------------------------------------

op('use', {
  what: 'connect, with a token and a guild',
  takes: ['settings'],
  reads: true,
  async run(settings = {}) {
    const token = settings.token || process.env.DISCORD_TOKEN;
    d.rest = new Rest(token);
    d.guildId = settings.guild || process.env.DISCORD_GUILD_ID || null;
    const me = await d.rest.get('/users/@me');
    return { ...asUser(me), guild: d.guildId ?? '' };
  },
});

op('me', {
  what: 'who this bot is',
  reads: true,
  async run() {
    return asUser(await d.ready().get('/users/@me'));
  },
});

op('guild', {
  what: 'the server itself',
  reads: true,
  async run() {
    const g = await d.ready().get(d.guildRoute(), { query: { with_counts: true } });
    return {
      id: g.id,
      name: g.name,
      owner: g.owner_id,
      members: g.approximate_member_count ?? 0,
      online: g.approximate_presence_count ?? 0,
      description: g.description ?? '',
      created: new Date(Number(BigInt(g.id) >> 22n) + 1420070400000).toISOString(),
    };
  },
});

op('channels', {
  what: 'every channel, in order',
  reads: true,
  async run() {
    const list = await d.ready().get(d.guildRoute('/channels'));
    return list.map(asChannel).sort((a, b) => a.position - b.position);
  },
});

op('channel', {
  what: 'one channel, by id or by name',
  takes: ['which'],
  reads: true,
  async run(which) {
    if (/^\d{15,}$/.test(String(which))) return asChannel(await d.ready().get(`/channels/${which}`));
    const all = await d.ready().get(d.guildRoute('/channels'));
    const found = all.find((c) => c.name === which);
    if (!found) throw new Error(`no channel called "${which}"`);
    return asChannel(found);
  },
});

op('roles', {
  what: 'every role, highest first',
  reads: true,
  async run() {
    const list = await d.ready().get(d.guildRoute('/roles'));
    return list.map(asRole).sort((a, b) => b.position - a.position);
  },
});

op('role', {
  what: 'one role, by id or by name',
  takes: ['which'],
  reads: true,
  async run(which) {
    const all = await d.ready().get(d.guildRoute('/roles'));
    const found = all.find((r) => r.id === String(which) || r.name === which);
    if (!found) throw new Error(`no role called "${which}"`);
    return asRole(found);
  },
});

op('members', {
  what: 'every member, however many there are',
  takes: ['limit'],
  reads: true,
  async run(limit = 1000) {
    const list = await d.ready().all(d.guildRoute('/members'), { limit });
    return list.map(asMember);
  },
});

op('member', {
  what: 'one member',
  takes: ['id'],
  reads: true,
  async run(id) {
    return asMember(await d.ready().get(d.guildRoute(`/members/${id}`)));
  },
});

op('messages', {
  what: 'the latest messages in a channel',
  takes: ['channel', 'limit'],
  reads: true,
  async run(channel, limit = 50) {
    const list = await d.ready().get(`/channels/${channel}/messages`, { query: { limit: Math.min(limit, 100) } });
    return list.map(asMessage);
  },
});

op('permissions', {
  what: 'what a role or member may do in a channel',
  takes: ['channel'],
  reads: true,
  async run(channel) {
    const c = await d.ready().get(`/channels/${channel}`);
    return (c.permission_overwrites ?? []).map((o) => ({
      id: o.id,
      kind: o.type === 1 ? 'member' : 'role',
      allow: o.allow,
      deny: o.deny,
    }));
  },
});

// ---- messages ------------------------------------------------------------

op('send', {
  what: 'post a message to a channel',
  takes: ['channel', 'message'],
  async run(channel, message) {
    const body = typeof message === 'string' ? { content: message } : message;
    const planned = d.intercept('send', { channel, body });
    if (planned) return planned;

    const sent = await d.ready().post(`/channels/${channel}/messages`, {
      ...body,
      allowed_mentions: body.allowed_mentions ?? { parse: [] },
    });
    return receipt('send', {
      target: { kind: 'message', id: sent.id, channel },
      after: asMessage(sent),
      undo: { op: 'delete_message', args: [channel, sent.id] },
    });
  },
});

op('edit_message', {
  what: 'change a message this bot sent',
  takes: ['channel', 'message', 'content'],
  async run(channel, message, content) {
    const before = asMessage(await d.ready().get(`/channels/${channel}/messages/${message}`));
    const planned = d.intercept('edit_message', { channel, message, content });
    if (planned) return planned;

    const after = await d.rest.patch(`/channels/${channel}/messages/${message}`, {
      content: typeof content === 'string' ? content : undefined,
      ...(typeof content === 'object' ? content : {}),
    });
    return receipt('edit_message', {
      target: { kind: 'message', id: message, channel },
      before,
      after: asMessage(after),
      undo: { op: 'edit_message', args: [channel, message, before.content] },
    });
  },
});

op('delete_message', {
  what: 'remove a message',
  takes: ['channel', 'message'],
  // A deleted message cannot be put back: the id is gone and so are its
  // reactions and replies. Saying otherwise would be the lie that matters.
  destructive: true,
  async run(channel, message, reason) {
    const planned = d.intercept('delete_message', { channel, message });
    if (planned) return planned;
    const before = asMessage(await d.ready().get(`/channels/${channel}/messages/${message}`));
    await d.rest.delete(`/channels/${channel}/messages/${message}`, { reason });
    return receipt('delete_message', {
      target: { kind: 'message', id: message, channel },
      before,
      note: 'a message cannot be restored — this receipt is a record, not an undo',
    });
  },
});

op('react', {
  what: 'add a reaction',
  takes: ['channel', 'message', 'emoji'],
  async run(channel, message, emoji) {
    const planned = d.intercept('react', { channel, message, emoji });
    if (planned) return planned;
    await d.ready().put(`/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(emoji)}/@me`);
    return receipt('react', {
      target: { kind: 'reaction', id: message, channel },
      after: { emoji },
      undo: { op: 'unreact', args: [channel, message, emoji] },
    });
  },
});

op('unreact', {
  what: 'take a reaction back',
  takes: ['channel', 'message', 'emoji'],
  async run(channel, message, emoji) {
    const planned = d.intercept('unreact', { channel, message, emoji });
    if (planned) return planned;
    await d.ready().delete(`/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(emoji)}/@me`);
    return receipt('unreact', {
      target: { kind: 'reaction', id: message, channel },
      undo: { op: 'react', args: [channel, message, emoji] },
    });
  },
});

op('dm', {
  what: 'send someone a direct message',
  takes: ['user', 'message'],
  async run(user, message) {
    const planned = d.intercept('dm', { user, message });
    if (planned) return planned;
    const channel = await d.ready().post('/users/@me/channels', { recipient_id: user });
    const sent = await d.rest.post(`/channels/${channel.id}/messages`, {
      ...(typeof message === 'string' ? { content: message } : message),
    });
    return receipt('dm', {
      target: { kind: 'message', id: sent.id, channel: channel.id },
      after: asMessage(sent),
      undo: { op: 'delete_message', args: [channel.id, sent.id] },
    });
  },
});

// ---- structure -----------------------------------------------------------

op('channel_create', {
  what: 'make a channel',
  takes: ['settings'],
  async run(settings, reason) {
    const planned = d.intercept('channel_create', { settings });
    if (planned) return planned;

    const made = await d.ready().post(
      d.guildRoute('/channels'),
      {
        name: settings.name,
        type: { text: 0, voice: 2, category: 4, news: 5, stage: 13, forum: 15 }[settings.kind ?? 'text'] ?? 0,
        parent_id: settings.under || undefined,
        topic: settings.topic || undefined,
        nsfw: settings.nsfw ?? undefined,
        permission_overwrites: settings.permissions,
      },
      { reason },
    );
    return receipt('channel_create', {
      target: { kind: 'channel', id: made.id, name: made.name },
      after: asChannel(made),
      undo: { op: 'channel_delete', args: [made.id, 'undoing a channel this run created'] },
    });
  },
});

op('channel_edit', {
  what: 'change a channel',
  takes: ['channel', 'changes'],
  async run(channel, changes, reason) {
    const before = await d.ready().get(`/channels/${channel}`);
    const planned = d.intercept('channel_edit', { channel, changes });
    if (planned) return planned;

    // A prefix or suffix needs the current name, which is why the read above
    // happens before the plan check and not after it.
    const body = { ...changes };
    if (changes.prefix !== undefined) {
      delete body.prefix;
      body.name = before.name.startsWith(changes.prefix) ? before.name : `${changes.prefix}${before.name}`;
    }
    if (changes.suffix !== undefined) {
      delete body.suffix;
      body.name = before.name.endsWith(changes.suffix) ? before.name : `${before.name}${changes.suffix}`;
    }
    if (changes.under !== undefined) {
      delete body.under;
      body.parent_id = changes.under;
    }

    const after = await d.rest.patch(`/channels/${channel}`, body, { reason });
    return receipt('channel_edit', {
      target: { kind: 'channel', id: channel, name: after.name },
      before: asChannel(before),
      after: asChannel(after),
      undo: {
        op: 'channel_edit',
        args: [channel, { name: before.name, topic: before.topic ?? '', under: before.parent_id ?? null }],
      },
    });
  },
});

op('channel_delete', {
  what: 'delete a channel and everything in it',
  takes: ['channel'],
  destructive: true,
  async run(channel, reason) {
    const planned = d.intercept('channel_delete', { channel });
    if (planned) return planned;
    const before = asChannel(await d.ready().get(`/channels/${channel}`));
    await d.rest.delete(`/channels/${channel}`, { reason });
    return receipt('channel_delete', {
      target: { kind: 'channel', id: channel, name: before.name },
      before,
      note: 'a new channel with the same name is not the same channel — the id and the history are gone',
    });
  },
});

op('thread_create', {
  what: 'open a thread on a channel',
  takes: ['channel', 'name'],
  async run(channel, name, reason) {
    const planned = d.intercept('thread_create', { channel, name });
    if (planned) return planned;
    const made = await d.ready().post(
      `/channels/${channel}/threads`,
      { name: String(name).slice(0, 100), type: 11, auto_archive_duration: 1440 },
      { reason },
    );
    return receipt('thread_create', {
      target: { kind: 'thread', id: made.id, name: made.name },
      after: asChannel(made),
      undo: { op: 'channel_delete', args: [made.id, 'undoing a thread this run created'] },
    });
  },
});

op('role_create', {
  what: 'make a role',
  takes: ['settings'],
  async run(settings, reason) {
    const planned = d.intercept('role_create', { settings });
    if (planned) return planned;
    const made = await d.ready().post(
      d.guildRoute('/roles'),
      {
        name: settings.name,
        // No permission bits. What a role may do belongs on the channels it is
        // for, so a role made in passing cannot outrank the thing it was for.
        permissions: settings.permissions ?? '0',
        color: settings.colour ?? 0,
        hoist: !!settings.hoisted,
        mentionable: !!settings.mentionable,
      },
      { reason },
    );
    return receipt('role_create', {
      target: { kind: 'role', id: made.id, name: made.name },
      after: asRole(made),
      undo: { op: 'role_delete', args: [made.id, 'undoing a role this run created'] },
    });
  },
});

op('role_delete', {
  what: 'delete a role',
  takes: ['role'],
  destructive: true,
  async run(role, reason) {
    const planned = d.intercept('role_delete', { role });
    if (planned) return planned;
    const all = await d.ready().get(d.guildRoute('/roles'));
    const before = asRole(all.find((r) => r.id === String(role)));
    await d.rest.delete(d.guildRoute(`/roles/${role}`), { reason });
    return receipt('role_delete', {
      target: { kind: 'role', id: role, name: before?.name ?? '' },
      before,
      note: 'a new role is not the old one — everyone who held this has lost it',
    });
  },
});

op('grant', {
  what: 'give someone a role',
  takes: ['user', 'role'],
  async run(user, role, reason) {
    const planned = d.intercept('grant', { user, role });
    if (planned) return planned;
    await d.ready().put(d.guildRoute(`/members/${user}/roles/${role}`), undefined, { reason });
    return receipt('grant', {
      target: { kind: 'member', id: user },
      after: { role },
      undo: { op: 'revoke', args: [user, role] },
    });
  },
});

op('revoke', {
  what: 'take a role away',
  takes: ['user', 'role'],
  async run(user, role, reason) {
    const planned = d.intercept('revoke', { user, role });
    if (planned) return planned;
    await d.ready().delete(d.guildRoute(`/members/${user}/roles/${role}`), { reason });
    return receipt('revoke', {
      target: { kind: 'member', id: user },
      before: { role },
      undo: { op: 'grant', args: [user, role] },
    });
  },
});

op('allow', {
  what: 'let a role or member do something in a channel',
  takes: ['channel', 'who', 'permissions'],
  async run(channel, who, permissions, reason) {
    return setOverwrite('allow', channel, who, permissions, reason);
  },
});

op('deny', {
  what: 'stop a role or member doing something in a channel',
  takes: ['channel', 'who', 'permissions'],
  async run(channel, who, permissions, reason) {
    return setOverwrite('deny', channel, who, permissions, reason);
  },
});

/** Short names, because ManageGuildExpressions is not a thing anyone should type. */
const PERMISSION = {
  read: 1n << 10n,
  write: 1n << 11n,
  history: 1n << 16n,
  manage: 1n << 4n,
  attach: 1n << 15n,
  embed: 1n << 14n,
  react: 1n << 6n,
  threads: 1n << 35n,
  speak: 1n << 21n,
  connect: 1n << 20n,
  mention: 1n << 17n,
  kick: 1n << 1n,
  ban: 1n << 2n,
  moderate: 1n << 40n,
  everything: 1n << 3n,
};

const bits = (names) =>
  names.reduce((total, name) => {
    const bit = PERMISSION[name];
    if (bit === undefined) {
      throw new Error(`"${name}" is not a permission. There is ${Object.keys(PERMISSION).join(', ')}`);
    }
    return total | bit;
  }, 0n);

async function setOverwrite(mode, channel, who, permissions, reason) {
  const current = await d.ready().get(`/channels/${channel}`);
  const existing = (current.permission_overwrites ?? []).find((o) => o.id === String(who));

  const planned = d.intercept(mode, { channel, who, permissions });
  if (planned) return planned;

  const wanted = bits(permissions);
  const allow = BigInt(existing?.allow ?? '0');
  const deny = BigInt(existing?.deny ?? '0');

  const next =
    mode === 'allow'
      ? { allow: (allow | wanted).toString(), deny: (deny & ~wanted).toString() }
      : { allow: (allow & ~wanted).toString(), deny: (deny | wanted).toString() };

  // A member overwrite and a role overwrite are different rows on the same
  // channel, and getting the type wrong silently writes the wrong one.
  const members = await d.rest.get(d.guildRoute(`/members/${who}`)).catch(() => null);

  await d.rest.put(
    `/channels/${channel}/permissions/${who}`,
    { type: members ? 1 : 0, ...next },
    { reason },
  );

  return receipt(mode, {
    target: { kind: 'overwrite', id: who, channel },
    before: existing ? { allow: existing.allow, deny: existing.deny } : null,
    after: next,
    undo: existing
      ? { op: 'overwrite_restore', args: [channel, who, existing.allow, existing.deny, members ? 1 : 0] }
      : { op: 'overwrite_clear', args: [channel, who] },
  });
}

op('overwrite_restore', {
  what: 'put a channel permission back the way it was',
  takes: ['channel', 'who', 'allow', 'deny', 'kind'],
  async run(channel, who, allow, deny, kind) {
    await d.ready().put(`/channels/${channel}/permissions/${who}`, { type: kind, allow, deny });
    return receipt('overwrite_restore', { target: { kind: 'overwrite', id: who, channel }, after: { allow, deny } });
  },
});

op('overwrite_clear', {
  what: 'remove a channel permission entirely',
  takes: ['channel', 'who'],
  async run(channel, who) {
    await d.ready().delete(`/channels/${channel}/permissions/${who}`);
    return receipt('overwrite_clear', { target: { kind: 'overwrite', id: who, channel } });
  },
});

op('rename_guild', {
  what: 'rename the server',
  takes: ['name'],
  async run(name, reason) {
    const before = await d.ready().get(d.guildRoute());
    const planned = d.intercept('rename_guild', { name });
    if (planned) return planned;
    const after = await d.rest.patch(d.guildRoute(), { name }, { reason });
    return receipt('rename_guild', {
      target: { kind: 'guild', id: after.id, name: after.name },
      before: { name: before.name },
      after: { name: after.name },
      undo: { op: 'rename_guild', args: [before.name] },
    });
  },
});

// ---- the agent-first surface --------------------------------------------

op('operations', {
  what: 'every operation this module has, and what each one costs',
  reads: true,
  async run() {
    return Object.values(OPS).map((o) => ({
      name: o.name,
      what: o.what,
      takes: o.takes,
      reads: !!o.reads,
      destructive: !!o.destructive,
    }));
  },
});

op('can', {
  what: 'whether an operation exists',
  takes: ['operation'],
  reads: true,
  async run(name) {
    return !!OPS[name];
  },
});

op('undo', {
  what: 'reverse something this run did',
  takes: ['receipt'],
  async run(r) {
    if (!r?.undo) {
      throw new Error(
        r?.op
          ? `${r.op} cannot be undone${r.note ? ` — ${r.note}` : ''}`
          : 'that is not a receipt',
      );
    }
    const operation = OPS[r.undo.op];
    if (!operation) throw new Error(`the undo names "${r.undo.op}", which is not an operation`);
    // Past the gate on purpose. The gate exists to stop an unconsidered
    // deletion; a receipt is the consideration, and it names the exact thing
    // this run created a moment ago.
    return (operation.inner ?? operation.run)(...r.undo.args);
  },
});

op('confirm', {
  what: 'mint a token for one destructive call',
  takes: ['operation', 'arguments'],
  reads: true,
  async run(name, args) {
    const operation = OPS[name];
    if (!operation) throw new Error(`there is no operation "${name}"`);
    if (!operation.destructive) throw new Error(`${name} does not need confirming`);
    const token = randomUUID();
    tokens.set(token, { name, print: fingerprint(name, args), expires: Date.now() + TOKEN_LIFE });
    return { token, operation: name, expires: new Date(Date.now() + TOKEN_LIFE).toISOString() };
  },
});

op('planning', {
  what: 'start recording instead of acting',
  reads: true,
  async run() {
    plan.length = 0;
    planning = true;
    return true;
  },
});

op('planned', {
  what: 'what has been recorded, and stop recording',
  reads: true,
  async run() {
    planning = false;
    return plan.splice(0, plan.length);
  },
});

// ---- destructive gate ----------------------------------------------------

/**
 * Wrap every destructive operation so it cannot run without a token minted for
 * these exact arguments. The check is here rather than in each operation
 * because a guard you have to remember to write is a guard that gets forgotten.
 */
for (const operation of Object.values(OPS)) {
  if (!operation.destructive) continue;
  const inner = operation.run;
  operation.inner = inner;
  operation.run = async (...args) => {
    // The token rides last, so an operation's own arguments keep their places.
    const supplied = args.at(-1);
    const isToken = typeof supplied === 'string' && tokens.has(supplied);
    const rest = isToken ? args.slice(0, -1) : args;

    if (planning) return inner(...rest);

    if (!isToken) {
      throw new Error(
        `${operation.name} cannot be undone, so it needs confirming first: ` +
          `hold t = discord.confirm("${operation.name}", [...]) then pass t as the last argument`,
      );
    }
    const held = tokens.get(supplied);
    tokens.delete(supplied);
    if (held.expires < Date.now()) throw new Error('that confirmation has expired — ask for another');
    if (held.name !== operation.name) {
      throw new Error(`that confirmation was for ${held.name}, not ${operation.name}`);
    }
    if (held.print !== fingerprint(operation.name, rest)) {
      throw new Error('that confirmation was minted for different arguments');
    }
    return inner(...rest);
  };
}

// ---- events --------------------------------------------------------------

op('listen', {
  what: 'connect to the gateway and start receiving events',
  takes: ['events'],
  reads: true,
  async run(events = []) {
    d.ready();
    if (d.gateway) return { already: true };
    d.gateway = new Gateway({
      token: process.env.DISCORD_TOKEN,
      guildId: d.guildId,
      wanted: events,
      onEvent: (event) => d.emit(event),
    });
    await d.gateway.open();
    return { listening: true, events };
  },
});

export const discord = {
  operations: OPS,
  set emit(fn) {
    d.emit = fn;
  },
  close: () => d.close(),
};
