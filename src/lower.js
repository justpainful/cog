// Agent declarations to a host runtime document.
//
// `cog run` executes a program. `cog build` does something different: it turns
// the agent layer into rows a running host can load, so a button works because a
// row exists, not because a process is executing anything. Nothing from Cog is
// alive at the other end — the output is data.
//
// That is also the limit. A row holds fixed values and a fixed shape, so the
// parts of the language that only exist while a program runs (bindings, loops,
// arithmetic on a variable) cannot cross over, and saying so at build time is
// better than a row that fails under someone's finger.
//
// Everything is checked against the capability table on the way through: an
// effect the host cannot perform, a filter an event never supplies, a permission
// name that is not real. Each is an error that names what is wrong.

import { ResolveError } from './errors.js';
import { COGNITION, effectFor } from './capability.js';

export function lower(
  program,
  { host = COGNITION, file = '<input>', source = '', ids = {}, requireIds = true } = {},
) {
  const actions = [];
  const triggers = [];
  const schedules = [];
  const components = [];
  const counters = new Set();
  const unresolved = new Map();
  const verbKeys = new Set();

  const fail = (message, node, hint = null) => {
    throw new ResolveError(message, {
      file,
      line: node?.line ?? 1,
      column: node?.column ?? 1,
      length: 1,
      source,
      hint,
    });
  };

  // An agent verb is one declared inside an intent. A verb at the top level of
  // a file is an ordinary function — it can be called, it can hold a loop, and
  // it is none of a host's business. That line is what lets one file be both a
  // program and a system without either half getting in the other's way.
  const collectVerbs = (body, prefix) => {
    for (const node of body) {
      const declared = node.kind === 'Share' ? node.declaration : node;
      if (declared?.kind === 'Verb') verbKeys.add(`${prefix}.${declared.name}`);
    }
  };
  for (const node of program.body) {
    if (node.kind === 'Intent') collectVerbs(node.body, node.name);
  }

  const verbKey = (name, prefix, node) => {
    if (prefix && verbKeys.has(`${prefix}.${name}`)) return `${prefix}.${name}`;
    if (verbKeys.has(name)) return name;
    return fail(`there is no verb called "${name}" that a host could run`, node,
      verbKeys.size
        ? `this file offers ${[...verbKeys].join(', ')}`
        : 'a verb a host can run lives inside an intent; one at the top level is an ordinary function');
  };

  /**
   * A named entity becomes an id, because a stored row cannot look a name up.
   * Names with no id are collected and reported together at the end: finding
   * them one build at a time would be miserable.
   */
  const resolveNamed = (kind, name, node) => {
    const key = `${kind}:${name}`;
    if (ids[key]) return String(ids[key]);
    if (!unresolved.has(key)) unresolved.set(key, { kind, name, line: node?.line, column: node?.column });
    return `<${key}>`;
  };

  // ---- expressions to templates --------------------------------------------

  /** The text a row will store, with host placeholders where values vary. */
  const text = (node, ctx) => {
    if (node === null || node === undefined) return null;
    switch (node.kind) {
      case 'Text':
        return node.parts
          .map((part) => {
            if (part.kind === 'literal') return part.value;
            if (part.path) return pathTemplate(part.path, part, ctx);
            return text(part.expression, ctx);
          })
          .join('');

      case 'Number': return String(node.value);
      case 'Truth': return node.value ? 'yes' : 'no';
      case 'None': return '';
      case 'Duration': return String(node.seconds);
      case 'Clock': return String(node.hours * 3600 + node.minutes * 60);
      case 'Entity': case 'Field': return entityTemplate(node, ctx);
      case 'Name': return pathTemplate([node.name], node, ctx);

      case 'Binary':
        if (node.operator === '+') return text(node.left, ctx) + text(node.right, ctx);
        return fail(`${node.operator} cannot be worked out while building`, node,
          'a value in a row has to be known when the row is written; joining text with + is the exception');

      default:
        return fail(`a ${node.kind} cannot be stored in a row`, node,
          'rows hold text, numbers and entities, not anything that has to be computed');
    }
  };

  /** A dotted path: a verb parameter, or an entity the host provides. */
  const pathTemplate = (path, node, ctx) => {
    const [head, ...rest] = path;

    if (ctx.params && head in ctx.params) {
      const slot = `{{arg.${ctx.params[head]}}}`;
      if (!rest.length || rest[0] === 'id') return slot;
      if (rest[0] === 'mention') return `<#${slot}>`;
      return fail(`"${head}" arrives as an id, and an id has no ${rest[0]}`, node,
        'a parameter carries .id and .mention');
    }

    const entity = host.entities[head];
    if (!entity) {
      return fail(`"@${head}" is not something this host provides`, node,
        `it provides ${Object.keys(host.entities).join(', ')}`);
    }
    // An open entity names things the source decides, such as the fields of an
    // ask, so any name is allowed and the ask itself is what has to agree.
    if (entity.open && rest.length) return entity.open.replace('NAME', rest.join('.'));
    if (!rest.length) {
      if (!entity.bare) return fail(`"@${head}" only means something inside a needs or a when`, node);
      return entity.bare;
    }
    const field = entity[rest[0]];
    if (!field) {
      return fail(`"@${head}" has no ${rest[0]}`, node,
        `it has ${Object.keys(entity).filter((k) => k !== 'bare').join(', ')}`);
    }
    return field;
  };

  /** An @entity node, with or without a field on the end. */
  const entityTemplate = (node, ctx, field = null) => {
    if (node.kind === 'Field') {
      if (node.target.kind === 'Name') return pathTemplate([node.target.name, node.name], node, ctx);
      return entityTemplate(node.target, ctx, node.name);
    }
    if (node.kind === 'Name') return pathTemplate(field ? [node.name, field] : [node.name], node, ctx);

    if (host.namedEntities.includes(node.name)) {
      if (!node.argument) return fail(`@${node.name} needs a name: @${node.name}("something")`, node);
      const id = resolveNamed(node.name, text(node.argument, ctx), node);
      if (!field || field === 'id') return id;
      if (field === 'mention') return node.name === 'role' ? `<@&${id}>` : `<#${id}>`;
      return fail(`@${node.name}(…).${field} cannot be read from a stored row`, node,
        'a row holds an id, so only .id and .mention come out of one');
    }

    if (node.argument) return fail(`@${node.name} does not take a name`, node);
    return pathTemplate(field ? [node.name, field] : [node.name], node, ctx);
  };

  // ---- predicates -----------------------------------------------------------

  const predicate = (node, ctx) => {
    switch (node.kind) {
      case 'PredAll': return { type: 'all', of: [predicate(node.left, ctx), predicate(node.right, ctx)] };
      case 'PredAny': return { type: 'any', of: [predicate(node.left, ctx), predicate(node.right, ctx)] };
      case 'PredNot': return { type: 'not', of: predicate(node.of, ctx) };

      case 'PredAbsent': case 'PredExists': {
        const entity = node.entity;
        const absent = node.kind === 'PredAbsent';
        if (entity.kind !== 'Entity' || entity.name !== 'channel') {
          return fail(`only a channel can be tested for being ${absent ? 'absent' : 'there'}`, node,
            `write: needs ${absent ? 'no ' : ''}@channel("name")`);
        }
        return { type: absent ? 'channel_absent' : 'channel_exists', name: text(entity.argument, ctx) };
      }

      case 'PredHas': {
        const role = node.object;
        if (role.kind !== 'Entity' || role.name !== 'role') {
          return fail('has asks about a role', node, 'write: needs @user has @role("Operator")');
        }
        return { type: 'has_role', role_id: entityTemplate(role, ctx) };
      }

      case 'PredIs': {
        const { subject, object } = node;
        if (object.kind === 'Entity' && object.name === 'owner') return { type: 'is_guild_owner' };
        if (subject.kind === 'Entity' && subject.name === 'here' && object.kind === 'Entity' && object.name === 'channel') {
          return { type: 'in_channel', channel_id: entityTemplate(object, ctx) };
        }
        return fail('this comparison means nothing to the host', node,
          'it knows @user is @owner and @here is @channel("name")');
      }

      default:
        return fail(`a ${node.kind} is not a question a host can answer`, node);
    }
  };

  // ---- statements to actions -------------------------------------------------

  /** A colour by name, or any number for one that has no name. */
  const colourOf = (node, ctx) => {
    if (node.kind === 'Name') {
      const known = host.colours[node.name];
      if (known === undefined) {
        return fail(`"${node.name}" is not a colour this host names`, node,
          `it names ${Object.keys(host.colours).join(', ')}, and any number also works`);
      }
      return known;
    }
    const value = Number(text(node, ctx));
    if (!Number.isFinite(value)) return fail('a colour is a name or a number', node);
    return value;
  };

  const embedOf = (node, ctx) => {
    const embed = {};
    if (node.fields.title) embed.title = text(node.fields.title, ctx);
    if (node.fields.body) embed.description = text(node.fields.body, ctx);
    if (node.fields.footer) embed.footer = text(node.fields.footer, ctx);
    if (node.fields.colour) embed.color = colourOf(node.fields.colour, ctx);
    return embed;
  };

  const messagePayload = (value, ctx) =>
    value.kind === 'Embed' ? { embed: embedOf(value, ctx) } : { content: text(value, ctx) };

  const permissionNames = (names, node) =>
    names.map((name) => {
      const real = host.permissions[name];
      if (!real) {
        return fail(`"${name}" is not a permission this host knows`, node,
          `it knows ${Object.keys(host.permissions).join(', ')}`);
      }
      return real;
    });

  const overwriteOf = (node, ctx) => {
    const perms = permissionNames(node.permissions, node);
    const isMember = node.who.kind === 'Entity' && node.who.name === 'user';
    return {
      id: entityTemplate(node.who, ctx),
      type: isMember ? 'member' : 'role',
      ...(node.mode === 'show' ? { allow: perms } : { deny: perms.length ? perms : ['ViewChannel'] }),
    };
  };

  // An effect that introduces a name only lends it to its own then block, which
  // is how the host scopes {{created.id}} and {{counter.value}}. So when one of
  // these has no then of its own, it takes the rest of its block as one, and
  // reading order and scope end up meaning the same thing.
  const BINDS = { Make: 'made', Thread: 'made', Count: 'count' };

  /** A block becomes one action, collapsing when it holds a single step. */
  const blockAction = (block, ctx) => {
    const steps = [];

    for (let i = 0; i < block.body.length; i++) {
      const statement = block.body[i];
      const rest = block.body.slice(i + 1);

      if (BINDS[statement.kind] && !statement.then && rest.length) {
        const action = statement2action(
          { ...statement, then: { kind: 'Block', line: rest[0].line, column: rest[0].column, body: rest } },
          ctx,
        );
        steps.push(action);
        break;
      }

      const action = statement2action(statement, ctx);
      if (action !== null) steps.push(action);
    }

    if (steps.length === 0) return { kind: 'log', params: { message: '' } };
    if (steps.length === 1 && typeof steps[0] === 'object') return steps[0];
    return { kind: 'sequence', params: { steps } };
  };

  const statement2action = (node, ctx) => {
    switch (node.kind) {
      case 'Needs':
        // Read by the verb it guards, which puts it on that action's requires.
        if (ctx.guardHere) return null;
        return fail('needs guards a whole verb, so it belongs at the top of one', node,
          'move it to the first line of the verb, or use when for a branch');

      case 'Say': {
        if (!ctx.interactive) {
          return fail('say answers whoever pressed something, and nothing here was pressed', node,
            'inside on or every, use post or tell');
        }
        return { kind: 'reply', params: { ...messagePayload(node.value, ctx), ephemeral: !node.everyone } };
      }

      case 'Post':
        return {
          kind: 'message_send',
          params: {
            channel_id: entityTemplate(node.target, ctx),
            ...messagePayload(node.value, ctx),
            ...(node.embed ? { embed: embedOf(node.embed, ctx) } : {}),
            ...(node.mentioning ? { allow_mentions: true } : {}),
          },
        };

      case 'Tell':
        return {
          kind: 'dm_send',
          params: { user_id: entityTemplate(node.target, ctx), ...messagePayload(node.value, ctx) },
        };

      case 'Note':
        return { kind: 'log', params: { message: text(node.value, ctx) } };

      case 'React':
        return { kind: 'reaction_add', params: { emoji: text(node.emoji, ctx) } };

      case 'Grant': case 'Revoke':
        return {
          kind: node.kind === 'Grant' ? 'role_grant' : 'role_revoke',
          params: {
            role_id: entityTemplate(node.role, ctx),
            ...(node.who ? { user_id: entityTemplate(node.who, ctx) } : {}),
          },
        };

      case 'Permission': {
        const { id, type, allow, deny } = overwriteOf(node, ctx);
        return {
          kind: 'overwrite_set',
          params: {
            channel_id: node.target ? entityTemplate(node.target, ctx) : host.entities.here.bare,
            target_id: id,
            target_type: type,
            ...(allow ? { allow } : { deny }),
          },
        };
      }

      case 'Rename': {
        const field = node.mode === 'to' ? 'name' : node.mode === 'prefix' ? 'name_prefix' : 'name_suffix';
        // Renaming the server is its own primitive, and it only takes a name.
        if (node.target.kind === 'Entity' && node.target.name === 'guild') {
          if (node.mode !== 'to') {
            return fail(`the server can be renamed to something, not ${node.mode}ed`, node,
              'write: rename @guild to "name"');
          }
          return { kind: 'guild_edit', params: { name: text(node.value, ctx) } };
        }
        return {
          kind: 'channel_edit',
          params: {
            channel_id: entityTemplate(node.target, ctx),
            [field]: text(node.value, ctx),
          },
        };
      }

      case 'Presence': {
        if (!host.activities.includes(node.activity)) {
          return fail(`"${node.activity}" is not something this host can appear to be doing`, node,
            `it knows ${host.activities.join(', ')}`);
        }
        if (node.activity === 'streaming' && !node.url) {
          return fail('streaming needs somewhere to be streaming from', node,
            'write: presence streaming "Cognition" at "https://…"');
        }
        return {
          kind: 'presence_set',
          params: {
            status: 'online',
            activities: [
              {
                activity: node.activity,
                text: text(node.text, ctx),
                ...(node.url ? { url: text(node.url, ctx) } : {}),
              },
            ],
          },
        };
      }

      case 'Thread': {
        const params = { channel_id: entityTemplate(node.target, ctx), name: text(node.name, ctx) };
        if (node.then) params.then = blockAction(node.then, ctx);
        return { kind: 'thread_create', params };
      }

      case 'Count': {
        counters.add(node.name);
        const params = { key: node.name, by: node.by ? Number(text(node.by, ctx)) : 1 };
        if (node.padded) params.pad = Number(text(node.padded, ctx));
        if (node.then) params.then = blockAction(node.then, ctx);
        return { kind: 'counter_bump', params };
      }

      case 'Make': {
        const effect = effectFor(host, 'Make', node.what);
        if (!effect) {
          return fail(`this host cannot make a ${node.what}`, node,
            `it can make ${Object.keys(host.effects.Make.kind).join(', ')}`);
        }
        const params = node.what === 'role'
          ? { name: text(node.name, ctx) }
          : { name: text(node.name, ctx), type: node.what === 'category' ? 'category' : 'text' };

        if (node.under) params.parent_id = entityTemplate(node.under, ctx);
        if (node.topic) params.topic = text(node.topic, ctx);
        if (node.permissions.length) params.overwrites = node.permissions.map((p) => overwriteOf(p, ctx));
        if (node.then) params.then = blockAction(node.then, ctx);
        return { kind: effect.kind, params };
      }

      case 'Panel': {
        const buttons = node.buttons.map((button) => {
          const label = button.label.map((p) => (p.kind === 'literal' ? p.value : '')).join('');
          if (!label) fail('a button label has to be plain text', node, 'a label is stored once and cannot vary per click');
          const target = verbKey(button.verb, ctx.prefix, node);
          const key = componentKey(target, label);
          if (!components.some((c) => c.key === key)) {
            components.push({ key, kind: 'button', action_key: target, spec: { label, style: button.style } });
          }
          return {
            label,
            style: button.style,
            ...(button.emoji ? { emoji: text(button.emoji, ctx) } : {}),
            component_key: key,
            args: button.args.map((a) => text(a.value, ctx)),
          };
        });
        return {
          kind: 'panel_send',
          params: {
            channel_id: entityTemplate(node.target, ctx),
            ...(node.message ? { content: text(node.message, ctx) } : {}),
            buttons,
          },
        };
      }

      case 'When': {
        if (!String(node.test.kind).startsWith('Pred')) {
          return fail('a when inside an agent verb asks the host a question', node.test,
            'write it as a predicate: when @user has @role("Operator") { … }');
        }
        const params = {
          if: predicate(node.test, ctx),
          then: blockAction(node.body, ctx),
        };
        if (node.alternate) {
          params.else = node.alternate.kind === 'When'
            ? statement2action(node.alternate, ctx)
            : blockAction(node.alternate, ctx);
        }
        return { kind: 'branch', params };
      }

      case 'Block': return blockAction(node, ctx);

      case 'ExpressionStatement': {
        const call = node.expression;
        if (call.kind === 'Call' && call.callee.kind === 'Name') {
          if (call.args.length) {
            return fail('a verb called from another verb cannot be passed anything', node,
              'arguments travel from a button, not between rows');
          }
          return verbKey(call.callee.name, ctx.prefix, node);
        }
        return fail('this statement does nothing a host can store', node);
      }

      // Everything the language does that only exists while a program runs.
      case 'Hold': case 'Carry': case 'Assign': case 'Each':
      case 'RepeatUntil': case 'RepeatTimes': case 'Attempt': case 'Give':
      case 'Fail': case 'Stop': case 'Next':
        return fail(`${node.kind.toLowerCase()} has no equivalent in a stored row`, node,
          'an agent verb becomes a fixed tree of actions; bindings and loops exist only while cog run is running');

      case 'Ask': {
        if (!ctx.interactive) {
          return fail('ask opens a box in front of whoever pressed something, and nothing here was pressed', node);
        }
        if (node.fields.length > host.ask.maxFields) {
          return fail(`this host takes ${host.ask.maxFields} fields in one ask, and this has ${node.fields.length}`, node,
            'split it into two asks, or drop a field');
        }
        const keys = new Set();
        const fields = node.fields.map((f) => {
          const label = f.label.map((p) => (p.kind === 'literal' ? p.value : '')).join('');
          if (!label) fail('an ask field needs a label that is plain text', f);
          // The name the answer arrives under is the label, slugged, unless the
          // ask said otherwise. It has to be stable, because the verb on the
          // other side reads @field.<name>. The slug keeps every letter in
          // every script, since a language with Unicode identifiers has no
          // business turning an Arabic label into nothing at all.
          const key = f.name ?? label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '');
          if (!key) {
            fail(`"${label}" leaves nothing to name the answer`, f,
              'give the field a label with letters in it, or say: named something');
          }
          if (keys.has(key)) fail(`two fields here are both read as @field.${key}`, f, 'give them different labels');
          keys.add(key);
          return {
            key,
            label,
            style: host.ask.shapes[f.shape],
            required: f.required,
            ...(f.max ? { max: Number(text(f.max, ctx)) } : {}),
          };
        });
        return {
          kind: host.ask.kind,
          params: {
            title: node.title ? text(node.title, ctx) : 'Input',
            fields,
            on_submit: verbKey(node.verb, ctx.prefix, node),
          },
        };
      }

      default:
        return fail(`a ${node.kind} cannot be lowered`, node);
    }
  };

  /**
   * A component key: short, because Discord allows a hundred characters for a
   * custom_id and the per-click arguments have to fit in there too, and legible,
   * because it is what appears in the Registry when someone goes looking.
   */
  const componentKey = (target, label) => {
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const short = `${slug(target.split('.').at(-1))}${slug(label)}`.slice(0, 10);
    const clash = components.find((c) => c.key === short && c.action_key !== target);
    if (short.length >= 4 && !clash) return short;

    let hash = 0;
    for (const ch of `${target}.${label}`) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return (short.slice(0, 6) || 'btn').padEnd(6, 'x') + hash.toString(36).slice(0, 4).padStart(4, '0');
  };

  // ---- declarations ---------------------------------------------------------

  const paramMap = (params, node) => {
    const map = {};
    params.forEach((p, i) => {
      if (p.fallback) {
        fail(`"${p.name}" has a default, and a stored row has nowhere to keep one`, node,
          'a verb a host runs takes its arguments from a button, which always supplies them');
      }
      map[p.name] = i;
    });
    return map;
  };

  const verbAction = (node, prefix) => {
    const key = `${prefix}.${node.name}`;
    const ctx = { interactive: true, prefix, params: paramMap(node.params, node), guardHere: true };

    const guards = node.body.body.filter((s) => s.kind === 'Needs');
    if (guards.length > 1) fail('a verb has one needs', guards[1], 'join the conditions with and');
    if (guards.length && node.body.body[0] !== guards[0]) {
      fail('needs goes first, because it decides whether the rest runs', guards[0]);
    }

    actions.push({
      key,
      ...blockAction(node.body, ctx),
      requires: guards.length ? predicate(guards[0].predicate, ctx) : null,
      confirm: false,
      note: null,
    });
  };

  const eventEntry = (name, node) => {
    const entry = host.events[name];
    if (!entry) {
      return fail(`"${name}" is not an event this host reports`, node,
        `it reports ${Object.keys(host.events).join(', ')}`);
    }
    return entry;
  };

  const filterFor = (node, entry, ctx) => {
    if (!node) return {};
    if (node.kind === 'FilterAll') {
      return node.terms.reduce((all, term) => ({ ...all, ...filterFor(term, entry, ctx) }), {});
    }
    const made = (() => {
      switch (node.kind) {
        case 'FilterContains': return { contains: text(node.value, ctx) };
        case 'FilterStarts': return { starts_with: text(node.value, ctx) };
        case 'FilterAt': return { channel_id: entityTemplate(node.entity, ctx) };
        case 'FilterFrom': return { has_role: entityTemplate(node.entity, ctx) };
        default: return fail(`a ${node.kind} is not a filter`, node);
      }
    })();

    for (const key of Object.keys(made)) {
      if (!entry.filters.includes(key)) {
        fail(`"${key}" means nothing for this event`, node,
          entry.filters.length ? `it filters on ${entry.filters.join(', ')}` : 'it takes no filters');
      }
    }
    return made;
  };

  const cronFor = (schedule, node) => {
    if (schedule.kind === 'EveryDuration') {
      const cron = host.schedule.fromDuration(schedule.seconds);
      if (!cron) {
        fail(`every ${schedule.text} cannot be written as a host schedule`, node,
          'the host schedules on cron, so an interval has to divide an hour or a day evenly');
      }
      return cron;
    }
    const { hours, minutes, period } = schedule;
    if (period === 'day') return `${minutes} ${hours} * * *`;
    if (period === 'month') return `${minutes} ${hours} 1 * *`;
    const day = host.schedule.weekdays[period];
    if (day === undefined) fail(`"${period}" is not a period this host understands`, node);
    return `${minutes} ${hours} * * ${day}`;
  };

  const boundKey = (prefix, suffix) => (prefix ? `${prefix}.${suffix}` : suffix);

  const declaration = (node, prefix = null) => {
    switch (node.kind) {
      case 'Intent':
        for (const inner of node.body) declaration(inner, node.name);
        return;

      case 'Share':
        return declaration(node.declaration, prefix);

      case 'Verb':
        // Only inside an intent. At the top level it is an ordinary function.
        if (prefix) verbAction(node, prefix);
        return;

      case 'Command': {
        // A slash command is a door, not a mechanism: the host registers the
        // name with Discord, and what comes through it is a row like any other.
        const { keyPrefix, actionPrefix, componentKind } = host.command;
        const key = `${actionPrefix}${node.name}`;
        const ctx = { interactive: true, prefix, params: paramMap(node.params, node), guardHere: true };

        const guards = node.body.body.filter((s) => s.kind === 'Needs');
        if (guards.length > 1) fail('a command has one needs', guards[1], 'join the conditions with and');

        actions.push({
          key,
          ...blockAction(node.body, ctx),
          requires: guards.length ? predicate(guards[0].predicate, ctx) : null,
          confirm: false,
          note: null,
        });
        components.push({
          key: `${keyPrefix}${node.name}`,
          kind: componentKind,
          action_key: key,
          spec: { name: node.name },
        });
        return;
      }

      case 'On': {
        const entry = eventEntry(node.event, node);
        const key = boundKey(prefix, `on_${node.event.replace('.', '_')}`);
        const ctx = { interactive: false, prefix, params: {}, guardHere: false };
        actions.push({ key, ...blockAction(node.body, ctx), requires: null, confirm: false, note: null });
        triggers.push({
          key,
          event: entry.event,
          filter: filterFor(node.filter, entry, ctx),
          action_key: key,
          enabled: true,
          note: null,
        });
        return;
      }

      case 'Every': {
        const cron = cronFor(node.schedule, node);
        const label = node.schedule.kind === 'EveryDuration'
          ? node.schedule.text
          : `${node.schedule.period}_${String(node.schedule.hours).padStart(2, '0')}${String(node.schedule.minutes).padStart(2, '0')}`;
        const key = boundKey(prefix, `every_${label}`);
        const ctx = { interactive: false, prefix, params: {}, guardHere: false };
        actions.push({ key, ...blockAction(node.body, ctx), requires: null, confirm: false, note: null });
        schedules.push({ key, cron, action_key: key, context: {}, enabled: true, note: null });
        return;
      }

      // Everything the ordinary language does is invisible to a host document.
      default:
        return;
    }
  };

  for (const node of program.body) declaration(node);

  // `cog check` lowers without an ids file, because the point of checking is to
  // find what is wrong with the source, and a missing id is a fact about the
  // server rather than about the file.
  if (unresolved.size && requireIds) {
    const first = [...unresolved.values()][0];
    const list = [...unresolved.values()]
      .map((u) => `    ${u.kind} "${u.name}"  (line ${u.line})`)
      .join('\n');
    throw new ResolveError(
      `${unresolved.size} name${unresolved.size === 1 ? '' : 's'} could not be turned into an id`,
      {
        file,
        line: first.line ?? 1,
        column: first.column ?? 1,
        length: 1,
        source,
        hint:
          `a stored row holds ids, not names:\n${list}\n` +
          '  pass them with --ids <file.json>, keyed "channel:name" to the id',
      },
    );
  }

  const duplicate = actions.map((a) => a.key).find((key, i, all) => all.indexOf(key) !== i);
  if (duplicate) {
    throw new ResolveError(`two things are both called "${duplicate}"`, {
      file, line: 1, column: 1, length: 1, source,
      hint: 'a host keys its rows by name, so each verb, on and every needs one of its own',
    });
  }

  return {
    exported_at: null, // stamped by the caller, so the same source builds the same document
    guild_id: ids.guild ? String(ids.guild) : null,
    actions,
    triggers,
    schedules,
    components,
    counters: [...counters].map((key) => ({ key, value: 0 })),
    // Only present when ids were not required, for a caller that wants to know
    // which names a build would still need.
    ...(unresolved.size ? { needs_ids: [...unresolved.keys()] } : {}),
  };
}
