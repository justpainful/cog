// Discord's HTTP API, directly.
//
// Not a wrapper around a library that wraps the API. The reason is not purity:
// a wrapper decides for you what an object is, caches it, and then quietly
// serves you a stale copy. An agent that acts on a stale copy does damage and
// reports success. So there is no object model here and no cache — a read is a
// read, and anything that looks like state is asked for again.
//
// What is here instead is the part libraries usually leave to you: rate limits
// that are respected per route rather than globally, retries that distinguish
// "try again" from "this will never work", and an audit reason on every
// mutation so the server's own log says who did what and why.

const API = 'https://discord.com/api/v10';

/** Discord buckets by route, and a route is the path with the ids taken out. */
const bucketOf = (method, path) =>
  `${method} ${path
    .replace(/\/\d{15,}/g, '/:id')
    // The three major parameters keep their id: Discord buckets on them.
    .replace(/^\/(channels|guilds|webhooks)\/:id/, '/$1/{major}')}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Rest {
  #token;
  #buckets = new Map();
  #globalUntil = 0;
  #calls = 0;

  constructor(token) {
    if (!token) throw new Error('no bot token — set DISCORD_TOKEN, or pass one to discord.use');
    this.#token = token;
  }

  get calls() {
    return this.#calls;
  }

  /**
   * A reason ends up in the server's audit log, and HTTP headers are Latin-1.
   * An Arabic reason or an em dash throws inside fetch itself, which surfaces
   * as an incomprehensible error a long way from the cause.
   */
  static reasonHeader(reason) {
    return reason ? { 'X-Audit-Log-Reason': encodeURIComponent(String(reason).slice(0, 512)) } : {};
  }

  async call(method, path, { body, reason, query, attempt = 0 } = {}) {
    const bucket = bucketOf(method, path);
    const now = Date.now();

    // Wait out anything we already know about before spending a request to
    // find out again.
    const until = Math.max(this.#buckets.get(bucket) ?? 0, this.#globalUntil);
    if (until > now) await sleep(until - now);

    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bot ${this.#token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Cog (https://github.com/justpainful/cog, 0.1)',
        ...Rest.reasonHeader(reason),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.#calls++;

    // Record what the response says about the future, whether it succeeded or
    // not — the headers are the only reliable source and they come on both.
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));
    if (remaining === 0 && Number.isFinite(resetAfter)) {
      this.#buckets.set(bucket, Date.now() + resetAfter * 1000);
    }

    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after') ?? 1) * 1000;
      if (response.headers.get('x-ratelimit-global') === 'true') {
        this.#globalUntil = Date.now() + retry;
      } else {
        this.#buckets.set(bucket, Date.now() + retry);
      }
      if (attempt >= 4) {
        throw Object.assign(new Error(`rate limited on ${bucket}, gave up after five tries`), {
          name: 'RateLimited',
        });
      }
      return this.call(method, path, { body, reason, query, attempt: attempt + 1 });
    }

    // 5xx is Discord having a moment. 4xx is us being wrong, and repeating it
    // will not make it right.
    if (response.status >= 500 && attempt < 3) {
      await sleep(2 ** attempt * 500);
      return this.call(method, path, { body, reason, query, attempt: attempt + 1 });
    }

    if (response.status === 204) return null;

    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const problem = new Error(
        `${method} ${path} — ${response.status} ${payload?.message ?? response.statusText}`,
      );
      problem.name = 'DiscordError';
      problem.detail = { status: response.status, code: payload?.code ?? null, errors: payload?.errors ?? null };
      throw problem;
    }
    return payload;
  }

  get(path, options) {
    return this.call('GET', path, options);
  }

  post(path, body, options) {
    return this.call('POST', path, { ...options, body });
  }

  patch(path, body, options) {
    return this.call('PATCH', path, { ...options, body });
  }

  put(path, body, options) {
    return this.call('PUT', path, { ...options, body });
  }

  delete(path, options) {
    return this.call('DELETE', path, options);
  }

  /**
   * Everything behind a paginated endpoint, in order.
   *
   * Libraries usually make you write this loop, and people write it wrong: they
   * stop at the first page and report a partial answer as a whole one. An agent
   * that believes a server has fifty members when it has four hundred will make
   * decisions nobody can explain afterwards.
   */
  async all(path, { limit = 1000, pageSize = 100, after = '0', query = {} } = {}) {
    const out = [];
    let cursor = after;
    while (out.length < limit) {
      const page = await this.get(path, {
        query: { ...query, limit: Math.min(pageSize, limit - out.length), after: cursor },
      });
      if (!page?.length) break;
      out.push(...page);
      cursor = page.at(-1).user?.id ?? page.at(-1).id;
      if (page.length < pageSize) break;
    }
    return out;
  }
}
