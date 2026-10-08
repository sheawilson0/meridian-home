'use strict';

// Drafts (4 Oct 2026): an email, Slack message, text or note that Owner and an
// agent (his ChatGPT Dot on a phone call, Claude, Codex) write together. The
// agent makes one with draft_create and it opens as a tab in the Mac app's
// side panel (/draft?id=…); Owner edits it there while they talk, presses
// Approve, and the agent reads it back with draft_get and sends it with its
// own tools. Meridian never sends anything itself: it holds the words.
//
// One JSON file, atomic writes, one write chain (as todos-store). Fields are
// plain strings so an agent and a textarea can both edit them without a
// schema fight. Every change bumps `rev` and is pushed to anyone watching
// that draft (/api/drafts/:id/stream), which is how the open tab sees the
// agent's edits live.
//
// Approval is per revision: `approvedRev` records what Owner approved, and an
// edit to the words afterwards drops the status back to drafting, so an agent
// can't send a version he hasn't seen.
//
// Agents reach it over MCP: POST /mcp here (JSON-RPC, stateless, the same
// tools as scripts/meridian-mcp.js, which is a stdio bridge to it).
//
// Notion pages (6 Oct): kind 'notion' is uni writing (weekly notes, lectures,
// reflections) that Owner and the agent shape here, then the agent publishes
// to Notion with its own tools and records the page's address in sentUrl.
// `where` says where it goes ("COURSE102 > Week 03" or a Notion page link).
//
// Nothing is thrown away (6 Oct): sent and published drafts stay, and Owner
// archives or deletes them himself. Every change to the words is kept in
// drafts-history/<id>.json beside the store as {rev, by, at, field, before,
// after}, so the page can show what the agent changed. A run of edits to one
// field by the same person within two minutes is one entry, so his typing
// doesn't make hundreds.
//
// Which account (8 Oct): an email has `from`, the account the agent will send
// it from ("Uni", or an address), and `fromWhy`, the agent's one-line reason
// ("Daniel is your tutor"). The agent picks it from who it's for and what it's
// about; Owner sees both beside To and can change it. It's part of the words,
// so changing it needs approving again.

const crypto = require('crypto');
const { SUPPORTED_VERSIONS, negotiateVersion, requestError, errorReply, toolDefinition } = require('./mcp-protocol');
const { bearer } = require('./mcp-grants');
const fsp = require('fs/promises');
const path = require('path');

const KINDS = ['email', 'slack', 'text', 'note', 'notion'];
const STATUSES = ['drafting', 'ready', 'sent'];
const TEXT_FIELDS = { title: 200, to: 1000, cc: 1000, bcc: 1000, subject: 300, from: 200, fromWhy: 300, where: 1000, space: 40, body: 60000 };
// The words: changing one of these after approval needs approving again.
const WORDS = ['to', 'cc', 'bcc', 'subject', 'from', 'where', 'body', 'kind'];
// Kept in the history: everything Owner or the agent writes.
const HISTORY_FIELDS = ['title', 'to', 'cc', 'bcc', 'subject', 'from', 'where', 'body'];
const MERGE_MS = 2 * 60 * 1000;

function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
const clean = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').slice(0, max);
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

// A page's first line, without its Markdown marks: the title when nobody gave one.
const firstLine = (body) => (String(body).split('\n').map((l) => l.replace(/^\s*(#+|[-*•]|\d+\.|- \[[ x]\])\s+/i, '').trim()).find(Boolean) || '').slice(0, 80);

// What the tab and lists call it when nobody has named it.
function autoTitle(d) {
  const to = oneLine(d.to).split(/[,;]/)[0].replace(/<[^>]*>/g, '').trim();
  if (d.kind === 'email') return oneLine(d.subject) || (to ? 'Email to ' + to : 'New email');
  if (d.kind === 'slack') return to ? 'Slack to ' + to : 'Slack message';
  if (d.kind === 'text') return to ? 'Text to ' + to : 'Text message';
  if (d.kind === 'notion') return firstLine(d.body) || (oneLine(d.where) ? 'Page for ' + oneLine(d.where) : 'Notion page');
  return firstLine(d.body).slice(0, 60) || 'Note';
}

// named: Owner or the agent gave it a title, rather than it being worked out.
function view(d) { return { ...d, title: d.title || autoTitle(d), named: Boolean(d.title) }; }

function createDrafts({ file, historyDir = path.join(path.dirname(file), 'drafts-history'), now = () => Date.now() }) {
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.then(() => {}, () => {}); return run; };
  const watchers = new Map(); // id -> Set(fn)

  async function read() {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      return { version: 1, drafts: Array.isArray(parsed.drafts) ? parsed.drafts : [] };
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return { version: 1, drafts: [] };
    }
  }
  async function write(data, check) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    try { check?.(); } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
    await fsp.rename(tmp, file);
  }
  const historyFile = (id) => path.join(historyDir, id.replace(/[^a-z0-9]/gi, '') + '.json');
  async function readHistory(id) {
    try { const h = JSON.parse(await fsp.readFile(historyFile(id), 'utf8')); return Array.isArray(h) ? h : []; }
    catch (e) { if (e.code !== 'ENOENT') throw e; return []; }
  }
  // changes: [{field, before, after}] from one update. Folds into the last
  // entry for that field when it's the same person, within MERGE_MS, and
  // nobody else has touched that field since.
  async function record(d, changes, by) {
    if (!changes.length) return;
    const h = await readHistory(d.id);
    const at = new Date(now()).toISOString();
    for (const c of changes) {
      let last = null;
      for (let i = h.length - 1; i >= 0; i--) if (h[i].field === c.field) { last = h[i]; break; }
      if (last && last.by === by && now() - Date.parse(last.at) < MERGE_MS) {
        Object.assign(last, { rev: d.rev, at, after: c.after });
        if (last.before === last.after) h.splice(h.indexOf(last), 1);
      } else h.push({ rev: d.rev, by, at, field: c.field, before: c.before, after: c.after });
    }
    await fsp.mkdir(historyDir, { recursive: true });
    const tmp = historyFile(d.id) + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(h) + '\n');
    await fsp.rename(tmp, historyFile(d.id));
  }

  function emit(d) { for (const fn of watchers.get(d.id) || []) { try { fn(view(d)); } catch { /* a closed stream */ } } }

  // The default list is what's live: not archived, and not sent more than a
  // day ago. archived: true is the other side (archived, or sent and older).
  async function list({ all = false, archived = false, limit = 50 } = {}) {
    const { drafts } = await read();
    const old = (d) => d.archived || (d.status === 'sent' && now() - Date.parse(d.updated) >= 864e5);
    return drafts.filter((d) => all || (archived ? old(d) : !old(d)))
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 50))).map(view);
  }

  async function get(id) {
    const d = (await read()).drafts.find((x) => x.id === id);
    if (!d) throw fail('no draft ' + id, 404);
    return view(d);
  }

  function create(input = {}, by = 'you', check) {
    return serial(async () => {
      const kind = KINDS.includes(input.kind) ? input.kind : 'email';
      const at = new Date(now()).toISOString();
      const d = { id: crypto.randomBytes(5).toString('hex'), kind, title: '', to: '', cc: '', bcc: '', subject: '', from: '', fromWhy: '', fromBy: '', body: '',
        where: '', space: '', status: 'drafting', approvedRev: null, rev: 1, created: at, updated: at, createdBy: clean(by, 40) || 'you', lastBy: clean(by, 40) || 'you', lastFields: [], sentAt: null, sentUrl: '', archived: false };
      for (const [k, max] of Object.entries(TEXT_FIELDS)) if (input[k] != null) d[k] = clean(input[k], max);
      if (d.from) d.fromBy = d.createdBy;
      const data = await read();
      data.drafts.unshift(d);
      await write(data, check);
      await record(d, HISTORY_FIELDS.filter((f) => d[f]).map((f) => ({ field: f, before: '', after: d[f] })), d.createdBy);
      return view(d);
    });
  }

  // patch: any of the text fields, kind, status. by: 'you' or the agent's name.
  function update(id, patch = {}, by = 'you', check) {
    return serial(async () => {
      const data = await read();
      const d = data.drafts.find((x) => x.id === id);
      if (!d) throw fail('no draft ' + id, 404);
      const changed = [], diffs = [];
      // A new account without a new reason: the old reason no longer applies.
      if (patch.from != null && patch.fromWhy == null && clean(patch.from, 200) !== (d.from ?? '')) patch = { ...patch, fromWhy: '' };
      for (const [k, max] of Object.entries(TEXT_FIELDS)) {
        if (patch[k] == null) continue;
        const v = clean(patch[k], max);
        if (v !== (d[k] ?? '')) { if (HISTORY_FIELDS.includes(k)) diffs.push({ field: k, before: d[k] ?? '', after: v }); d[k] = v; changed.push(k); if (k === 'from') d.fromBy = clean(by, 40) || 'you'; }
      }
      if (patch.archived != null && Boolean(patch.archived) !== Boolean(d.archived)) { d.archived = Boolean(patch.archived); changed.push('archived'); }
      if (patch.sentUrl != null) {
        const u = clean(patch.sentUrl, 2000).trim();
        if (u && !/^https:\/\//i.test(u)) throw fail('sentUrl must be an https address');
        if (u !== (d.sentUrl || '')) { d.sentUrl = u; changed.push('sentUrl'); }
      }
      if (patch.kind != null && KINDS.includes(patch.kind) && patch.kind !== d.kind) { d.kind = patch.kind; changed.push('kind'); }
      const words = changed.some((k) => WORDS.includes(k));
      let status = patch.status != null ? String(patch.status) : null;
      if (status != null && !STATUSES.includes(status)) throw fail('status must be drafting, ready or sent');
      if (status == null && words && d.status === 'ready') status = 'drafting';
      if (!changed.length && (status == null || status === d.status)) { check?.(); return view(d); }
      d.rev += 1;
      if (status != null && status !== d.status) {
        d.status = status;
        changed.push('status');
        if (status === 'ready') d.approvedRev = d.rev;
        if (status === 'sent') d.sentAt = new Date(now()).toISOString();
        if (status === 'drafting') d.approvedRev = null;
      }
      d.updated = new Date(now()).toISOString();
      d.lastBy = clean(by, 40) || 'you';
      d.lastFields = changed;
      await write(data, check);
      await record(d, diffs, d.lastBy);
      emit(d);
      return view(d);
    });
  }

  function remove(id) {
    return serial(async () => {
      const data = await read();
      const i = data.drafts.findIndex((x) => x.id === id);
      if (i < 0) throw fail('no draft ' + id, 404);
      data.drafts.splice(i, 1);
      await write(data);
      await fsp.rm(historyFile(id), { force: true });
      return { ok: true };
    });
  }

  async function history(id) {
    await get(id);
    return readHistory(id);
  }

  function watch(id, fn) {
    if (!watchers.has(id)) watchers.set(id, new Set());
    watchers.get(id).add(fn);
    return () => { const s = watchers.get(id); s?.delete(fn); if (s && !s.size) watchers.delete(id); };
  }

  return { list, get, create, update, remove, watch, history, autoTitle };
}

// ---------------------------------------------------------------- MCP tools

const FIELD_PROPS = {
  to: { type: 'string', description: 'Recipients. Email: comma-separated addresses, "Name <personal@example.com>" is fine. Slack: a #channel or a person. Text: a name or number.' },
  cc: { type: 'string', description: 'Email only, comma-separated.' },
  bcc: { type: 'string', description: 'Email only, comma-separated.' },
  subject: { type: 'string', description: 'Email only.' },
  from: { type: 'string', description: 'Email only: which of Owner\'s accounts to send it from, as a short name ("Uni", "Personal") or the address. Pick it from who it\'s for and what it\'s about (a tutor or anything about his course: his uni account), and send from exactly this account.' },
  fromWhy: { type: 'string', description: 'Email only: a few words on why you picked that account, shown to Owner beside it, e.g. "Daniel is your tutor".' },
  body: { type: 'string', description: 'The message itself, plain text. Blank lines between paragraphs. No markdown headings; "- " bullets are fine. For an email, include the greeting and sign-off. For a notion page, Markdown: "## " headings, "- " bullets and "- [ ] " to-dos are fine.' },
  title: { type: 'string', description: 'For a notion page or a note, the page title: set it, it is the big first line Owner sees. Left blank, Meridian uses the first line of the body. For other kinds, an optional name for the tab (defaults to the subject, "Text to Dad" and so on).' },
  where: { type: 'string', description: 'Notion pages only: where it will be published, as a Notion page link to put it under and/or words like "COURSE102 > Week 03".' },
  space: { type: 'string', description: 'Optional label to group drafts, e.g. "uni".' },
};

function summary(d) {
  return { id: d.id, kind: d.kind, title: d.title, to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, ...(d.kind === 'email' ? { from: d.from || '', fromWhy: d.fromWhy || '' } : {}), where: d.where || '', space: d.space || '', body: d.body, status: d.status,
    approved: d.status === 'ready' && d.approvedRev === d.rev, rev: d.rev, lastEditedBy: d.lastBy, lastChanged: d.lastFields, updated: d.updated,
    ...(d.sentUrl ? { sentUrl: d.sentUrl } : {}), ...(d.archived ? { archived: true } : {}) };
}

// hooks: open(draft) shows it in the Mac app's side panel; browse(url) opens a page there; addTodo(input).
function createTools(drafts, hooks = {}) {
  const tools = [
    { name: 'draft_create',
      description: 'Start a draft that Owner will see and edit in Meridian on his Mac, in a tab in the side panel. Use when he says something like "let\'s send my boss an email", "draft a Slack to the team" or "text my dad, let\'s do it in Meridian". Also for his uni writing (weekly notes, lecture notes, reflections) that will go into Notion: kind notion, with where set to its place in Notion. For an email, also set from (the account to send it from) and fromWhy, from who it is for and what it is about. Fill in what you know; leave the rest blank. Returns the draft with its id; keep the id for draft_get and draft_update.',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: KINDS, description: 'email (default), slack, text, notion for a page that will be published to Notion, or note for anything else' }, ...FIELD_PROPS, open: { type: 'boolean', description: 'Open it in the side panel now (default true).' } }, required: ['kind'] },
      async run(a, by, check) { const d = await drafts.create(a, by, check); if (a.open !== false) { check?.(); hooks.open?.(d); } return summary(d); } },
    { name: 'draft_get',
      description: 'Read a draft as it is right now, including Owner\'s own edits. ALWAYS call this right before sending or publishing: he may have changed the words while you were talking. approved is true only if he pressed Approve on exactly this version. Send exactly the to, cc, subject and body returned here (for a notion page: the title and body, under where).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(a) { return summary(await drafts.get(String(a.id || ''))); } },
    { name: 'draft_update',
      description: 'Change a draft while Owner watches: rewrite the body, fix the subject, add a recipient. Send only the fields you are changing; they replace the old values whole. He sees each change appear in his open tab. Editing the words after he approved clears the approval.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: KINDS }, ...FIELD_PROPS }, required: ['id'] },
      async run(a, by, check) { const { id, ...patch } = a; delete patch.status; return summary(await drafts.update(String(id || ''), patch, by, check)); } },
    { name: 'draft_mark_sent',
      description: 'Record that you sent the draft, or published it to Notion (after doing it with your own email, Slack, messaging or Notion tool). Meridian does not send anything itself. Pass url: the Notion page you made, or a link to the sent message if you have one.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string', description: 'https link to what you sent or published' } }, required: ['id'] },
      async run(a, by, check) { return summary(await drafts.update(String(a.id || ''), { status: 'sent', ...(a.url ? { sentUrl: a.url } : {}) }, by, check)); } },
    { name: 'draft_list',
      description: 'Recent drafts, newest first. Sent ones drop off after a day; archived: true lists those and the ones Owner archived (all his past uni pages are there).',
      inputSchema: { type: 'object', properties: { archived: { type: 'boolean' }, all: { type: 'boolean' }, limit: { type: 'number' } } },
      async run(a) { return { drafts: (await drafts.list({ all: !!a.all, archived: !!a.archived, limit: a.limit || 20 })).map(summary) }; } },
    { name: 'draft_history',
      description: 'What changed in a draft and who changed it, oldest first: each entry is {rev, by, at, field, before, after}. Use it to see which of your edits Owner kept, rewrote or put back.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(a) { return { history: await drafts.history(String(a.id || '')) }; } },
    { name: 'draft_open',
      description: 'Bring a draft up in the side panel of Meridian on Owner\'s Mac again (for example after he closed the tab).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async run(a, by, check) { const d = await drafts.get(String(a.id || '')); check?.(); hooks.open?.(d); return { opened: d.id }; } },
  ];
  if (hooks.browse) tools.push({ name: 'panel_open_url',
    description: 'Open a web page in a tab in the side panel of Meridian on Owner\'s Mac, beside his dashboard. Use it for a ChatGPT Space page you are both working on, a doc, or anything he asks to see. https only.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    async run(a) {
      let u; try { u = new URL(String(a.url || '')); } catch { throw fail('url must be an https address'); }
      if (u.protocol !== 'https:') throw fail('url must be an https address');
      hooks.browse(u.href); return { opened: u.href };
    } });
  if (hooks.overview) tools.unshift({ name: 'meridian_overview',
    description: 'What is on Owner\'s Meridian dashboard right now: his calendar for the next week, to-dos, deadlines, messages and requests waiting on him, open drafts, agents working, and anything broken. Read this first when he asks what\'s going on, what\'s next, or to help with his day.',
    inputSchema: { type: 'object', properties: {} },
    async run() { const { json, md } = await hooks.overview(); return { markdown: md, ...json }; } });
  if (hooks.addTodo) tools.push({ name: 'todo_add',
    description: 'Add something to Owner\'s Meridian to-do list.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, note: { type: 'string' }, priority: { type: 'string', enum: ['now', 'next', 'later'] } }, required: ['title'] },
    async run(a, by, check) { const t = await hooks.addTodo({ title: a.title, note: a.note, priority: a.priority }, check); return { added: t.title, id: t.id, priority: t.priority }; } });
  return tools;
}

// One JSON-RPC message (MCP over streamable HTTP, stateless, JSON replies).
// Returns the reply object, or null for a notification.
async function mcpMessage(tools, msg, by = 'agent', access) {
  const invalid = requestError(msg);
  if (invalid) return invalid;
  if (msg.id === undefined) return null;
  const id = msg.id;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const denied = e => ({ jsonrpc: '2.0', id, error: { code: e.rpcCode, message: e.message, data: e.data } });
  try { access?.check(); } catch (e) { if (e.rpcCode) return denied(e); throw e; }
  if (access) by = access.name;

  switch (msg.method) {
    case 'initialize': {
      // One line per connection, so a client's offered version is on record (ChatGPT doesn't document its own).
      const offered = msg.params?.protocolVersion, agreed = negotiateVersion(offered);
      if (!access) console.log(`mcp initialize: ${String(msg.params?.clientInfo?.name || 'unknown').slice(0, 60)} offered ${String(offered).slice(0, 20)}, agreed ${agreed}`);
      return reply({ protocolVersion: agreed, capabilities: { tools: {} },
        serverInfo: { name: 'meridian', version: '1.0.0' },
        instructions: 'Meridian is Owner\'s dashboard on his Mac. Use the draft tools to write an email, Slack message, text or Notion page together with him: create it, let him edit it in the side panel, call draft_get before sending, send or publish it with your own tools once he has approved it, then draft_mark_sent (with the link).' });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: tools.filter(t => !access || access.allows(t.name)).map(toolDefinition) });
    case 'tools/call': {
      const t = tools.find((x) => x.name === msg.params?.name);
      if (!t) return error(-32602, 'unknown tool ' + msg.params?.name);
      try {
        const args = msg.params?.arguments || {};
        const check = access ? () => access.check(t.name, args) : undefined;
        check?.();
        // A tool can hand back pictures as _images ([{ data: base64, mimeType }]), e.g. stash_get (stash-tools.js).
        const { _images: images = [], ...out } = (await t.run(args, by, check)) || {};
        access?.check(); // Do not return private content after revocation during an awaited read.
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }, ...images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))], structuredContent: out });
      } catch (e) {
        if (e.rpcCode) return denied(e);
        return reply({ content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }
    default: return error(-32601, 'method not found: ' + msg.method);
  }
}

// ---------------------------------------------------------------- HTTP

// /api/drafts…, and /mcp. Returns false for any other path. The caller has
// already checked the request is from this Mac, the tailnet or has the token.
//   GET    /api/drafts?all=1&archived=1&limit=   { drafts }
//   POST   /api/drafts                  { draft }   body: fields, open (bool)
//   GET    /api/drafts/:id              { draft }
//   PATCH  /api/drafts/:id              { draft }   body: fields, status, by
//   DELETE /api/drafts/:id
//   POST   /api/drafts/:id/open         shows it in the Mac app's side panel
//   GET    /api/drafts/:id/history      { history }  every change to the words
//   GET    /api/drafts/:id/stream       text/event-stream, `draft` on every change
//   POST   /mcp?as=Dot                  MCP JSON-RPC; `as` names the agent in the draft's "edited by"
//
// Tailscale Serve and Funnel both hand requests over from 127.0.0.1, which the
// daemon trusts. So a request that came from the internet (Funnel marks it,
// and its X-Forwarded-For isn't a tailnet address) needs the token as well,
// ?t= or a Bearer header, before it can touch a draft. That keeps /mcp safe
// to put on Funnel for a cloud agent.
function fromInternet(req) {
  if (req.headers['tailscale-funnel-request'] !== undefined) return true;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim().replace(/^::ffff:/, '');
  return Boolean(ip) && !/^(127\.|::1$|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|fd7a:115c:a1e0:)/i.test(ip);
}

function createRoutes(deps) {
  const handle = createHandler(deps);
  // Nothing thrown here may escape: an unhandled rejection takes the daemon down.
  return async (req, res, url) => {
    try { return await handle(req, res, url); } catch (e) {
      if (!res.headersSent) deps.sendJson(res, e.statusCode || 500, { ok: false, error: String(e.message || e) }); else res.end();
      return true;
    }
  };
}

const same = (given, token) => {
  const a = Buffer.from(String(given || '')), b = Buffer.from(String(token || ''));   // byte lengths: timingSafeEqual throws if they differ
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
};

// mcpToken (config.json) is the cloud agent's own secret: it opens /mcp and nothing else, so a ChatGPT connector
// never holds the dashboard's token. It can go in the path (/mcp/<mcpToken>), for connectors that drop query strings.
function createHandler({ drafts, tools, jsonBody, sendJson, open, token = '', mcpToken = '', grants }) {
  return async function handle(req, res, url) {
    let p = url.pathname;
    const pathToken = (p.match(/^\/mcp\/([A-Za-z0-9_-]{16,128})$/) || [])[1];
    if (pathToken) p = '/mcp';
    if (p !== '/mcp' && p !== '/api/drafts' && !p.startsWith('/api/drafts/')) return false;
    let access;
    if (p === '/mcp') {
      const header = bearer(req);
      const given = header !== undefined ? header : pathToken || url.searchParams.get('t');
      if (given !== undefined && given !== null) {
        if (!same(given, token) && !same(given, mcpToken)) {
          access = header !== undefined && grants ? grants.access(given) : null;
          if (!access) {
            const status = grants?.recognizes(given) || !fromInternet(req) ? 401 : 403;
            res.setHeader?.('WWW-Authenticate', 'Bearer error="invalid_token"');
            sendJson(res, status, { ok: false, error: 'forbidden' }); return true;
          }
        }
      } else if (fromInternet(req)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return true; }
    } else if (fromInternet(req)) {
      const given = pathToken || url.searchParams.get('t') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const ok = same(given, token) || (p === '/mcp' && same(given, mcpToken));
      if (!ok) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return true; }
    }
    if (p === '/mcp') {
      // GET: no event stream here (405 for clients that ask for one); a short note for a person or a link checker.
      if (req.method === 'GET' && !String(req.headers.accept || '').includes('text/event-stream')) {
        sendJson(res, 200, { name: 'meridian', mcp: 'POST JSON-RPC to this address', tools: tools.filter(t => !access || access.allows(t.name)).map((t) => t.name) }); return true;
      }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return true; }
      let body;
      try { body = JSON.parse(await rawText(req, 200000)); } catch { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return true; }
      const version = req.headers['mcp-protocol-version'];
      if (body?.method !== 'initialize' && version && !SUPPORTED_VERSIONS.includes(version)) {
        sendJson(res, 400, errorReply(body && (typeof body.id === 'string' || Number.isInteger(body.id)) ? body.id : null, -32600, 'use initialize with a supported protocol version')); return true;
      }
      const by = access ? access.name : clean(url.searchParams.get('as') || 'agent', 40);
      const batch = Array.isArray(body);
      const out = (await Promise.all((batch ? body : [body]).map((m) => mcpMessage(tools, m, by, access)))).filter(Boolean);
      if (!out.length) { res.writeHead(202); res.end(); return true; }
      const denied = out.find(r => r.error?.data?.httpStatus === 401 || r.error?.data?.httpStatus === 403);
      if (denied) {
        const { httpStatus, requiredScopes } = denied.error.data;
        res.setHeader?.('WWW-Authenticate', httpStatus === 403 ? `Bearer error="insufficient_scope", scope="${requiredScopes.join(' ')}"` : 'Bearer error="invalid_token"');
      }
      sendJson(res, denied ? denied.error.data.httpStatus : 200, batch ? out : out[0]);
      return true;
    }
    const m = p.match(/^\/api\/drafts(?:\/([a-f0-9]{6,20})(?:\/(open|stream|history))?)?$/);
    if (!m) { sendJson(res, 404, { ok: false, error: 'not found' }); return true; }
    const [, id, sub] = m;
    try {
      if (!id && req.method === 'GET') return sendJson(res, 200, { drafts: await drafts.list({ all: url.searchParams.has('all'), archived: url.searchParams.has('archived'), limit: url.searchParams.get('limit') }) }), true;
      if (!id && req.method === 'POST') {
        const b = await jsonBody(req, 250000);
        const d = await drafts.create(b, b.by || 'you');
        if (b.open) open(d);
        return sendJson(res, 201, { ok: true, draft: d }), true;
      }
      if (id && sub === 'history' && req.method === 'GET') return sendJson(res, 200, { history: await drafts.history(id) }), true;
      if (id && sub === 'open' && req.method === 'POST') { const d = await drafts.get(id); open(d); return sendJson(res, 200, { ok: true }), true; }
      if (id && sub === 'stream' && req.method === 'GET') {
        const d = await drafts.get(id);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const send = (x) => res.write('event: draft\ndata: ' + JSON.stringify(x) + '\n\n');
        res.write('retry: 3000\n\n');
        send(d);
        const stop = drafts.watch(id, send);
        const beat = setInterval(() => res.write(': hi\n\n'), 25000);
        req.on('close', () => { stop(); clearInterval(beat); });
        return true;
      }
      if (id && !sub && req.method === 'GET') return sendJson(res, 200, { draft: await drafts.get(id) }), true;
      if (id && !sub && req.method === 'PATCH') {
        const b = await jsonBody(req, 250000);
        return sendJson(res, 200, { ok: true, draft: await drafts.update(id, b, b.by || 'you') }), true;
      }
      if (id && !sub && req.method === 'DELETE') return sendJson(res, 200, await drafts.remove(id)), true;
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: String(e.message || e) });
    }
    return true;
  };
}

function rawText(req, limit) {
  return new Promise((resolve, reject) => {
    let s = ''; let over = false;
    req.on('data', (c) => { if (over) return; s += c; if (s.length > limit) { over = true; s = ''; } });
    req.on('end', () => (over ? reject(fail('too large', 413)) : resolve(s)));
    req.on('error', reject);
  });
}

module.exports = { createDrafts, createTools, createRoutes, mcpMessage, fromInternet, KINDS, autoTitle };
