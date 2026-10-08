'use strict';

// The tools-only handlers use the 2025 handshake, not the 2026 request lifecycle.
const SUPPORTED_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const requestId = (v) => typeof v === 'string' || Number.isInteger(v);
const errorReply = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// initialize offers one version. Echo it only when supported; otherwise offer our latest.
function negotiateVersion(version) {
  if (version === undefined) return '2025-06-18';   // existing bridges without params
  return SUPPORTED_VERSIONS.includes(version) ? version : SUPPORTED_VERSIONS[0];
}

function requestError(msg) {
  const id = object(msg) && requestId(msg.id) ? msg.id : null;
  if (!object(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string'
      || ('id' in msg && !requestId(msg.id))) return errorReply(id, -32600, 'invalid request');
  if (msg.id === undefined) return null;   // never answer or execute a notification
  if (msg.params !== undefined && !object(msg.params)) return errorReply(id, -32602, 'params must be an object');
  const version = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  if (msg.method !== 'initialize' && version !== undefined && !SUPPORTED_VERSIONS.includes(version)) {
    return errorReply(id, -32600, 'use initialize with a supported protocol version: ' + SUPPORTED_VERSIONS.join(', '));
  }
  if (msg.method === 'initialize' && msg.params?.protocolVersion !== undefined
      && typeof msg.params.protocolVersion !== 'string') return errorReply(id, -32602, 'protocolVersion must be a string');
  if (msg.method === 'tools/call' && (typeof msg.params?.name !== 'string'
      || (msg.params.arguments !== undefined && !object(msg.params.arguments)))) {
    return errorReply(id, -32602, 'tools/call needs a name and object arguments');
  }
  return null;
}

const READ = new Set(['meridian_overview', 'draft_get', 'draft_list', 'draft_history',
  'stash_search', 'stash_get', 'stash_spaces', 'money_snapshot', 'money_receivables',
  'money_overview', 'money_transactions', 'money_context', 'money_months',
  'money_regular_payments', 'money_portfolio']);
const WRITE = new Set(['draft_create', 'draft_update', 'draft_mark_sent', 'draft_open',
  'panel_open_url', 'todo_add', 'note_add', 'ask_add', 'event_add', 'deadline_add',
  'agent_status', 'money_receivable_write']);

function toolDefinition(tool) {
  const read = READ.has(tool.name), known = read || WRITE.has(tool.name);
  const annotations = {
    readOnlyHint: read,
    destructiveHint: !known || ['draft_update', 'draft_mark_sent', 'agent_status'].includes(tool.name),
    idempotentHint: read,
    openWorldHint: !known || tool.name === 'panel_open_url',
    ...tool.annotations,
  };
  // Keep public metadata, including future output schemas, without exposing implementation fields.
  const out = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations };
  for (const key of ['title', 'icons', 'outputSchema', '_meta']) if (tool[key] !== undefined) out[key] = tool[key];
  return out;
}

module.exports = { SUPPORTED_VERSIONS, negotiateVersion, requestError, errorReply, toolDefinition };
