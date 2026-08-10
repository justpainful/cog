// The gateway: a websocket, a heartbeat, and a way back in after a drop.
//
// This is the part people reach for a library to avoid, and it is about two
// hundred lines. What makes it worth owning is not the saving — it is that the
// events arriving here go straight into a queue the interpreter drains one at
// a time. A library would hand them to callbacks on its own schedule, and then
// two handlers can be halfway through changing the same thing at once.
//
// Resuming matters more than it looks. A bot that reconnects with a fresh
// session misses everything that happened while it was away and has no idea it
// did. Discord will replay those events over a resumed session, so the only
// correct thing to do with a session id is keep it.

const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  ACK: 11,
};

/** What a bot may be told about, by the name a Cog program uses. */
export const INTENTS = {
  guilds: 1 << 0,
  members: 1 << 1,
  moderation: 1 << 2,
  expressions: 1 << 3,
  integrations: 1 << 4,
  webhooks: 1 << 5,
  invites: 1 << 6,
  voice: 1 << 7,
  presence: 1 << 8,
  messages: 1 << 9,
  reactions: 1 << 10,
  typing: 1 << 11,
  content: 1 << 15,
  scheduled: 1 << 16,
  automod: 1 << 20,
  automod_execution: 1 << 21,
  polls: 1 << 24,
};

/** Discord's event names, in Cog's spelling. */
const EVENTS = {
  MESSAGE_CREATE: 'message.posted',
  MESSAGE_UPDATE: 'message.edited',
  MESSAGE_DELETE: 'message.deleted',
  GUILD_MEMBER_ADD: 'member.joins',
  GUILD_MEMBER_REMOVE: 'member.leaves',
  GUILD_MEMBER_UPDATE: 'member.changed',
  MESSAGE_REACTION_ADD: 'reaction.added',
  MESSAGE_REACTION_REMOVE: 'reaction.removed',
  CHANNEL_CREATE: 'channel.created',
  CHANNEL_UPDATE: 'channel.changed',
  CHANNEL_DELETE: 'channel.deleted',
  THREAD_CREATE: 'thread.created',
  GUILD_ROLE_CREATE: 'role.created',
  GUILD_ROLE_UPDATE: 'role.changed',
  GUILD_ROLE_DELETE: 'role.deleted',
  INTERACTION_CREATE: 'control.used',
  GUILD_BAN_ADD: 'member.banned',
  GUILD_BAN_REMOVE: 'member.unbanned',
  GUILD_UPDATE: 'guild.changed',
  VOICE_STATE_UPDATE: 'voice.changed',
  TYPING_START: 'typing.started',
};

export class Gateway {
  #socket = null;
  #heart = null;
  #sequence = null;
  #session = null;
  #resumeUrl = null;
  #closing = false;
  #backoff = 1000;
  #acked = true;

  constructor({ token, guildId, wanted = [], onEvent }) {
    this.token = token;
    this.guildId = guildId;
    this.onEvent = onEvent;
    this.intents = this.#intentsFor(wanted);
  }

  /**
   * Ask for what the program listens to and nothing else.
   *
   * A bot that asks for every intent is a bot that will one day be refused
   * verification for a reason nobody remembers. Working the number out from the
   * events a program actually handles is both smaller and self-explaining.
   */
  #intentsFor(wanted) {
    if (!wanted.length) return INTENTS.guilds | INTENTS.messages | INTENTS.content | INTENTS.members;

    const needed = new Set(['guilds']);
    for (const name of wanted) {
      if (name.startsWith('message.')) {
        needed.add('messages');
        needed.add('content');
      }
      if (name.startsWith('member.')) needed.add('members');
      if (name.startsWith('reaction.')) needed.add('reactions');
      if (name.startsWith('voice.')) needed.add('voice');
      if (name.startsWith('typing.')) needed.add('typing');
      if (name === 'member.banned' || name === 'member.unbanned') needed.add('moderation');
    }
    return [...needed].reduce((bits, name) => bits | INTENTS[name], 0);
  }

  async open() {
    return new Promise((resolve, reject) => {
      this.#connect(resolve, reject);
    });
  }

  #connect(resolve, reject) {
    const url = this.#session && this.#resumeUrl ? `${this.#resumeUrl}/?v=10&encoding=json` : GATEWAY;
    const socket = new WebSocket(url);
    this.#socket = socket;
    let settled = false;

    socket.addEventListener('message', (message) => {
      let packet;
      try {
        packet = JSON.parse(message.data);
      } catch {
        return;
      }
      if (packet.s !== null && packet.s !== undefined) this.#sequence = packet.s;

      switch (packet.op) {
        case OP.HELLO:
          this.#startHeart(packet.d.heartbeat_interval);
          if (this.#session) this.#send(OP.RESUME, {
            token: this.token,
            session_id: this.#session,
            seq: this.#sequence,
          });
          else this.#identify();
          break;

        case OP.ACK:
          this.#acked = true;
          break;

        case OP.HEARTBEAT:
          this.#send(OP.HEARTBEAT, this.#sequence);
          break;

        case OP.RECONNECT:
          socket.close(4000, 'told to reconnect');
          break;

        case OP.INVALID_SESSION:
          // `d` is whether the session can be resumed. When it cannot, the
          // session id is worse than useless: it will be rejected again.
          if (!packet.d) this.#session = null;
          setTimeout(() => socket.close(4000, 'invalid session'), 1000 + Math.random() * 4000);
          break;

        case OP.DISPATCH: {
          if (packet.t === 'READY') {
            this.#session = packet.d.session_id;
            this.#resumeUrl = packet.d.resume_gateway_url;
            this.#backoff = 1000;
            if (!settled) {
              settled = true;
              resolve({ user: packet.d.user?.username ?? '', session: this.#session });
            }
            break;
          }
          if (packet.t === 'RESUMED') {
            this.#backoff = 1000;
            break;
          }

          const name = EVENTS[packet.t];
          if (!name) break;
          // Another server's events are not this program's business.
          if (this.guildId && packet.d?.guild_id && packet.d.guild_id !== this.guildId) break;
          this.onEvent({ event: name, raw: packet.t, at: new Date().toISOString(), data: packet.d });
          break;
        }
      }
    });

    socket.addEventListener('close', () => {
      this.#stopHeart();
      if (this.#closing) return;
      if (!settled) {
        settled = true;
        reject?.(new Error('the gateway closed before it was ready'));
        return;
      }
      // Back off, but never so far that a bot is down for a quarter of an hour
      // because of one bad minute.
      setTimeout(() => this.#connect(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 60_000);
    });

    socket.addEventListener('error', () => {
      // A close always follows, and that is where reconnecting is handled.
    });
  }

  #identify() {
    this.#send(OP.IDENTIFY, {
      token: this.token,
      intents: this.intents,
      properties: { os: process.platform, browser: 'cog', device: 'cog' },
    });
  }

  #send(op, d) {
    if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify({ op, d }));
  }

  #startHeart(interval) {
    this.#stopHeart();
    this.#acked = true;
    // The jitter is Discord's own advice: a thousand bots that all restarted
    // together should not all heartbeat on the same millisecond.
    setTimeout(() => {
      this.#send(OP.HEARTBEAT, this.#sequence);
      this.#heart = setInterval(() => {
        // A missed acknowledgement means the connection is a zombie: it looks
        // open and delivers nothing. Closing it is what gets a resume.
        if (!this.#acked) {
          this.#socket?.close(4009, 'no heartbeat acknowledgement');
          return;
        }
        this.#acked = false;
        this.#send(OP.HEARTBEAT, this.#sequence);
      }, interval);
      this.#heart.unref?.();
    }, interval * Math.random()).unref?.();
  }

  #stopHeart() {
    if (this.#heart) clearInterval(this.#heart);
    this.#heart = null;
  }

  async close() {
    this.#closing = true;
    this.#stopHeart();
    this.#socket?.close(1000, 'done');
    this.#socket = null;
  }
}
