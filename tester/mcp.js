'use strict';

// "Connect your own agent" for testers (7 Oct 2026): an MCP server per tester,
// at /x/mcp/<agentToken>, so their Codex, ChatGPT or Claude can put things on
// their test copy of Meridian (their meetings, asks from people, to-dos) and
// say what it's working on, which shows in the agents strip as it happens.
// Everything lands in that tester's sandbox and nowhere else.
//
// JSON-RPC handling is drafts.js's mcpMessage, so it behaves like /mcp.

const { mcpMessage } = require('../drafts');
const { SUPPORTED_VERSIONS, requestError, errorReply } = require('../mcp-protocol');

const URGENCY = ['now', 'today', 'soon', 'later'];

function tools({ sandboxes, invite, name }) {
  const who = name || 'the person';
  return [
    { name: 'meridian_overview',
      description: `What is on ${who}'s Meridian dashboard right now: meetings in the next two days, to-dos, asks waiting on them, deadlines and agents at work. Read this first.`,
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      async run() { return overview(sandboxes, invite); } },
    { name: 'todo_add',
      description: `Add one of ${who}'s own to-dos to Meridian. For something another person asked them, use ask_add.`,
      inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'Short, starts with a verb' }, note: { type: 'string' }, urgency: { type: 'string', enum: URGENCY } }, required: ['title'] },
      async run(a, by) { const t = sandboxes.bring.todo(invite, { title: a.title, note: a.note, urgency: a.urgency, by }); return { added: t.title, id: t.id }; } },
    { name: 'ask_add',
      description: `Put something another person asked ${who} to do or answer into Meridian's inbox, with who asked and where (an email, a Slack or Teams message).`,
      inputSchema: { type: 'object', properties: {
        title: { type: 'string', description: 'The action, e.g. "Reply to Dan about the budget"' }, from: { type: 'string', description: 'Who asked' },
        source: { type: 'string', enum: ['outlook', 'slack', 'teams', 'email', 'chatgpt', 'other'] }, summary: { type: 'string', description: 'What they asked, in a sentence or two' },
        url: { type: 'string', description: 'https link to the message, if there is one' }, urgency: { type: 'string', enum: URGENCY }, reason: { type: 'string', description: 'Why it is urgent, one short sentence' },
        receivedAt: { type: 'string', description: 'ISO 8601' } }, required: ['title', 'from', 'source'] },
      async run(a) { const p = sandboxes.bring.ask(invite, a); return { added: p.title, id: p.id }; } },
    { name: 'event_add',
      description: `Put a meeting or call on ${who}'s Meridian calendar (Up next).`,
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 with offset' }, end: { type: 'string', description: 'ISO 8601 with offset' }, location: { type: 'string' }, joinUrl: { type: 'string' }, with: { type: 'string', description: 'Organiser or main person' } }, required: ['title', 'start'] },
      async run(a) { const e = sandboxes.bring.event(invite, { title: a.title, start: a.start, end: a.end, location: a.location, joinUrl: a.joinUrl, organizer: a.with, calendar: 'From your agent' }); return { added: e.title, start: new Date(e.ts).toISOString() }; } },
    { name: 'deadline_add',
      description: `Add a deadline (a thing due on a date) to ${who}'s Meridian.`,
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD' }, note: { type: 'string' } }, required: ['title', 'due'] },
      async run(a) { const d = sandboxes.bring.deadline(invite, a); return { added: d.title, due: d.due }; } },
    { name: 'agent_status',
      description: `Tell Meridian what you, the agent, are working on for ${who}, so it shows in their agents strip. Call it when you start, when something changes, and with status "done" when you finish (or "needs-you" when you're waiting on them).`,
      inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'Your name: Codex, Claude, ChatGPT, Copilot…' }, project: { type: 'string', description: 'The repo or project' }, doing: { type: 'string', description: 'What you are doing now, one line' }, asked: { type: 'string', description: 'What you were asked to do' }, status: { type: 'string', enum: ['working', 'done', 'needs-you'] } }, required: ['agent', 'doing'] },
      async run(a, by) { return sandboxes.bring.agent(invite, { agent: a.agent || by, project: a.project, doing: a.doing, asked: a.asked, status: a.status }); } },
    { name: 'note_add',
      description: `Keep a note in ${who}'s Meridian Stash.`,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async run(a) { const n = sandboxes.bring.note(invite, { text: a.text }); return { kept: n.id }; } },
  ];
}

function overview(sandboxes, invite) {
  const s = sandboxes.state(invite);
  const now = Date.now();
  const fb = new Set([...(s.briefFeedback.completed || []), ...(s.briefFeedback.rejected || [])]);
  const events = (s.calendar.events || []).filter((e) => e.end >= now && e.ts <= now + 2 * 86400000).map((e) => ({ title: e.title, start: new Date(e.ts).toISOString(), end: e.end ? new Date(e.end).toISOString() : null, calendar: e.calendar }));
  const todos = (s.todos || []).filter((t) => !t.done).map((t) => ({ title: t.title, priority: t.priority, agent: t.delegation ? `${t.delegation.model} (${t.delegation.status})` : null }));
  const asks = (s.projects.projects || []).filter((p) => p.brief && p.status !== 'done' && !fb.has('project:' + p.id)).map((p) => ({ title: p.title, from: p.sourceFrom, source: p.source }));
  const deadlines = (s.deadlines || []).filter((d) => !d.done).map((d) => ({ title: d.title, due: d.due }));
  const agents = (s.ai.sessions || []).filter((x) => x.live).map((x) => ({ agent: x.tool, project: x.project, doing: x.did }));
  const md = [
    `# ${s.tester.name ? s.tester.name + '’s' : 'This'} Meridian (a test copy)`,
    '', '## Next two days', ...(events.length ? events.map((e) => `- ${e.start.slice(0, 16).replace('T', ' ')} · ${e.title}`) : ['- Nothing']),
    '', '## To do', ...(todos.length ? todos.map((t) => `- ${t.title}${t.agent ? ` (agent: ${t.agent})` : ''}`) : ['- Nothing']),
    '', '## Waiting on them', ...(asks.length ? asks.map((a) => `- ${a.title} (from ${a.from || a.source})`) : ['- Nothing']),
    '', '## Deadlines', ...(deadlines.length ? deadlines.map((d) => `- ${d.due} · ${d.title}`) : ['- None']),
    '', '## Agents working', ...(agents.length ? agents.map((a) => `- ${a.agent}: ${a.doing}`) : ['- None']),
  ].join('\n');
  return { markdown: md, events, todos, asks, deadlines, agents };
}

// One request to /x/mcp/<token>. `rate` says yes or no to another call for this tester.
async function handleMcp({ req, res, body, sandboxes, invite, name, by, rate, sendJson }) {
  if (req.method === 'GET' && !String(req.headers.accept || '').includes('text/event-stream')) {
    sendJson(res, 200, { name: 'meridian-test', mcp: 'POST JSON-RPC to this address', tools: tools({ sandboxes, invite, name }).map((t) => t.name) }); return;
  }
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return; }
  const version = req.headers['mcp-protocol-version'];
  if (body?.method !== 'initialize' && version && !SUPPORTED_VERSIONS.includes(version)) {
    sendJson(res, 400, errorReply(body && (typeof body.id === 'string' || Number.isInteger(body.id)) ? body.id : null, -32600, 'use initialize with a supported protocol version')); return;
  }
  const list = tools({ sandboxes, invite, name });
  const batch = Array.isArray(body);
  const msgs = batch ? body.slice(0, 20) : [body];
  const out = [];
  for (const m of msgs) {
    const invalid = requestError(m);
    if (invalid) { out.push(invalid); continue; }
    if (m.id !== undefined && m.method === 'tools/call' && !rate()) { out.push({ jsonrpc: '2.0', id: m.id ?? null, result: { content: [{ type: 'text', text: 'Too many changes this hour for a test copy. Try again later.' }], isError: true } }); continue; }
    let r = await mcpMessage(list, m, by);
    if (r?.result && m && m.method === 'initialize') r = { ...r, result: { ...r.result, serverInfo: { name: 'meridian-test', version: '1.0.0' },
      instructions: `Meridian is ${name ? name + '’s' : 'this person’s'} dashboard for their day and their agents. This is a test copy for a usability study: nothing here is sent anywhere. Put their meetings (event_add), things people asked them (ask_add), their own to-dos (todo_add) and deadlines on it, and report what you're working on with agent_status.` } };
    if (r) out.push(r);
  }
  if (!out.length) { res.writeHead(202); res.end(); return; }
  sendJson(res, 200, batch ? out : out[0]);
}

module.exports = { handleMcp, tools, overview };
