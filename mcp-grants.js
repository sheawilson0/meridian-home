'use strict';

// Dashboard grants use Money's random-token/hash pattern, with a separate store and audience.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCOPES = ['read', 'draft-write', 'todo-write', 'host-control'];
const TOOL_SCOPES = Object.freeze({
  meridian_overview: 'read', draft_get: 'read', draft_list: 'read', draft_history: 'read',
  stash_search: 'read', stash_get: 'read', stash_spaces: 'read',
  draft_create: 'draft-write', draft_update: 'draft-write', draft_mark_sent: 'draft-write', note_add: 'draft-write',
  todo_add: 'todo-write', draft_open: 'host-control', panel_open_url: 'host-control',
});
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const publicGrant = ({ id, name, scopes, createdAt, expiresAt, lastUsedAt, revokedAt }) =>
  ({ id, name, scopes: [...scopes], createdAt, expiresAt, lastUsedAt, revokedAt });

function parseScopes(value) {
  const list = typeof value === 'string' ? value.split(',').map(s => s.trim()) : value;
  if (!Array.isArray(list) || !list.length || list.some(s => !SCOPES.includes(s))) throw fail('Scopes must be read, draft-write, todo-write or host-control');
  return [...new Set(list)];
}

function requiredScopes(name, args = {}) {
  if (!Object.hasOwn(TOOL_SCOPES, name)) return null; // New tools need an explicit policy before grants can use them.
  return [TOOL_SCOPES[name], ...(name === 'draft_create' && args.open !== false ? ['host-control'] : [])];
}

function authError(status, required = [], missing = []) {
  const message = status === 401 ? 'Grant expired, revoked or invalid; ask the owner for a new token' :
    `Missing scope: ${missing.join(', ') || 'tool not granted'}${missing.includes('host-control') ? '; draft_create requires open:false without host-control' : ''}`;
  return Object.assign(fail(message, status), { rpcCode: status === 401 ? -32001 : -32003,
    data: { httpStatus: status, error: status === 401 ? 'invalid_token' : 'insufficient_scope', requiredScopes: required, missingScopes: missing } });
}

function bearer(req) {
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const match = typeof header === 'string' && header.match(/^Bearer\s+([^\s]+)\s*$/i);
  return match ? match[1] : ''; // A supplied invalid header must not fall back to owner access.
}

function createGrants({ dataDir, now = () => Date.now() }) {
  const file = path.join(dataDir, 'mcp-grants.json');
  const lockFile = file + '.lock';
  function read() {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc.version !== 1 || !Array.isArray(doc.grants) || doc.grants.some(g =>
        !g || typeof g.id !== 'string' || typeof g.name !== 'string' || !Array.isArray(g.scopes) ||
        g.scopes.some(s => !SCOPES.includes(s)) || typeof g.hash !== 'string' || !/^[a-f0-9]{64}$/.test(g.hash))) throw new Error('invalid grants');
      return doc;
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 1, grants: [] };
      throw fail('Dashboard grants could not be read safely', 503);
    }
  }
  // The CLI and daemon share this exclusive lock, so neither can overwrite a revocation.
  function change(fn) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    let lock;
    try { lock = fs.openSync(lockFile, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw fail('Another grant update is running, or was interrupted; no grant changed', 409); throw e; }
    const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    try {
      const doc = read();
      const result = fn(doc);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(doc, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      return result;
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      fs.closeSync(lock); fs.unlinkSync(lockFile);
    }
  }
  function find(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    // SHA-256 is sufficient for an opaque 256-bit secret, unlike a human password.
    const hash = crypto.createHash('sha256').update(token).digest();
    return read().grants.find(g => crypto.timingSafeEqual(hash, Buffer.from(g.hash, 'hex'))) || null;
  }
  const active = g => g && !g.revokedAt && (g.expiresAt === null ||
    (Number.isFinite(Date.parse(g.expiresAt)) && Date.parse(g.expiresAt) > now()));

  function create(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['name', 'scopes', 'expiresAt'].includes(k))) throw fail('Provide name, scopes and optional expiresAt');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 40 || /[\x00-\x1f\x7f]/.test(input.name)) throw fail('Name must be 1–40 characters without control characters');
    const scopes = parseScopes(input.scopes);
    const expiresAt = input.expiresAt == null ? null : input.expiresAt;
    if (expiresAt !== null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now())) throw fail('expiresAt must be a future date or null');
    const token = crypto.randomBytes(32).toString('base64url');
    return change(doc => {
      const grant = { id: crypto.randomBytes(8).toString('hex'), name: input.name.trim(), scopes,
        createdAt: new Date(now()).toISOString(), expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
        lastUsedAt: null, revokedAt: null, hash: crypto.createHash('sha256').update(token).digest('hex') };
      doc.grants.push(grant);
      return { grant: publicGrant(grant), token };
    });
  }
  function list() { return read().grants.map(publicGrant); }
  function revoke(id) {
    return change(doc => {
      const g = doc.grants.find(g => g.id === id);
      if (!g) throw fail('No grant with that id', 404);
      g.revokedAt ||= new Date(now()).toISOString();
      return publicGrant(g);
    });
  }
  function access(token) {
    const g = find(token);
    if (!active(g)) return null;
    change(doc => {
      const hit = doc.grants.find(x => x.id === g.id);
      if (!active(hit)) throw authError(401);
      hit.lastUsedAt = new Date(now()).toISOString();
    });
    const check = (name, args) => {
      const current = find(token);
      if (!active(current)) throw authError(401);
      if (name === undefined) return current;
      const required = requiredScopes(name, args);
      const missing = (required || []).filter(s => !current.scopes.includes(s));
      if (!required || missing.length) throw authError(403, required || [], missing);
      return current;
    };
    return { name: g.name, check, allows(name) {
      const current = check();
      return Object.hasOwn(TOOL_SCOPES, name) && current.scopes.includes(TOOL_SCOPES[name]);
    } };
  }

  async function handleAdmin(req, res, url, { jsonBody, sendJson }) {
    const match = url.pathname.match(/^\/api\/mcp\/grants(?:\/([a-f0-9]{16}))?$/);
    if (!match) return false;
    try {
      const id = match[1];
      if (!id && req.method === 'GET') sendJson(res, 200, { grants: list(), scopes: SCOPES });
      else if (!id && req.method === 'POST') sendJson(res, 201, create(await jsonBody(req, 8000)));
      else if (id && req.method === 'DELETE') sendJson(res, 200, { grant: revoke(id) });
      else { res.setHeader('Allow', match[1] ? 'DELETE' : 'GET, POST'); sendJson(res, 405, { ok: false, error: 'method not allowed' }); }
    } catch (e) { sendJson(res, e.statusCode || 500, { ok: false, error: e.statusCode ? e.message : 'Grant operation failed' }); }
    return true;
  }
  return { create, list, revoke, access, recognizes: token => Boolean(find(token)), handleAdmin };
}

module.exports = { SCOPES, TOOL_SCOPES, parseScopes, requiredScopes, authError, bearer, createGrants };
