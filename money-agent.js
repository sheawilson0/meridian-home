"use strict";
// Deliberately separate from Money browser sessions: no token can authorize a
// browser write route. Legacy grants retain read-only access.
const crypto = require('crypto');
const SCOPES = ['money.read', 'receivables.write'];
const ACTIONS = ['create', 'edit', 'link', 'settle', 'undo'];
function scopes(grant) {
  return grant.scopes === undefined ? ['money.read'] : (Array.isArray(grant.scopes) ? grant.scopes.filter(s => SCOPES.includes(s)) : []);
}
function principal(doc, token, now) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
  const h = crypto.createHash('sha256').update(token).digest();
  const hit = (doc.tokens || []).find(t => typeof t.h === 'string' && /^[a-f0-9]{64}$/i.test(t.h) && crypto.timingSafeEqual(h, Buffer.from(t.h, 'hex')));
  if (!hit || hit.revokedAt || (hit.expiresAt && (!Number.isFinite(Date.parse(hit.expiresAt)) || Date.parse(hit.expiresAt) <= now))) return null;
  return { name: String(hit.name || 'legacy').slice(0, 80), scopes: scopes(hit) };
}
function parseScopes(value) {
  const list = String(value || 'money.read').split(',');
  if (!list.length || list.some(s => !SCOPES.includes(s))) throw new Error('Scopes must be money.read and/or receivables.write');
  return [...new Set(list)];
}
function claimInput(body) {
  const allowed = ['action', 'id', 'who', 'amount', 'note', 'senderId', 'key'];
  if (!body || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)) || !ACTIONS.includes(body.action)) throw Object.assign(new Error('Unsupported receivable action or field'), { status: 400 });
  const fields = { create: ['action', 'who', 'amount', 'note', 'senderId', 'key'], edit: ['action', 'id', 'who', 'amount', 'note'], link: ['action', 'id', 'senderId'], settle: ['action', 'id'], undo: ['action', 'id'] };
  if (Object.keys(body).some(k => !fields[body.action].includes(k))) throw Object.assign(new Error('Unsupported field for this action'), { status: 400 });
  for (const k of ['id', 'who', 'note', 'senderId', 'key']) if (body[k] !== undefined && (typeof body[k] !== 'string' || body[k].length > (k === 'note' ? 400 : 120))) throw Object.assign(new Error('Invalid receivable field'), { status: 400 });
  if (body.action !== 'create' && (!body.id || !body.id.trim())) throw Object.assign(new Error('A claim ID is required'), { status: 400 });
  if (body.action === 'edit' && !['who', 'amount', 'note'].some(k => body[k] !== undefined)) throw Object.assign(new Error('Provide a claim field to edit'), { status: 400 });
  if (body.action === 'link' && !body.senderId) throw Object.assign(new Error('A verified sender ID is required'), { status: 400 });
  if (body.amount !== undefined && (typeof body.amount !== 'number' || !Number.isFinite(body.amount))) throw Object.assign(new Error('Amount must be a finite GBP number'), { status: 400 });
  return body;
}
module.exports = { SCOPES, ACTIONS, principal, parseScopes, claimInput };
