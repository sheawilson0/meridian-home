'use strict';
// Local claims only. Bank transactions are immutable input; sender IDs must
// come from the bank import, never merchant rules or a guessed display name.
const crypto = require('crypto');
const cents = v => Math.round(Number(v) * 100);
const norm = v => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const senderId = t => String(t.counterpartyId || '').trim();
function senderOptions(txs) {
  const grouped = new Map();
  for (const t of txs) {
    if (!(t.amount > 0) || !senderId(t)) continue;
    const id = senderId(t); const x = grouped.get(id) || { id, names: [], transactionIds: [] };
    if (!x.names.includes(t.name)) x.names.push(t.name);
    x.transactionIds.push(t.id); grouped.set(id, x);
  }
  return [...grouped.values()];
}
function create(doc, input, txs, at) {
  const who = String(input.who || '').trim().slice(0, 80);
  const amount = cents(input.amount);
  if (!who || !Number.isFinite(amount) || amount <= 0 || amount > 1e10) fail('Enter a name and a positive GBP amount');
  const duplicate = doc.claims.find(c => (input.key && c.key === input.key) || (!c.settled && norm(c.who) === norm(who) && cents(c.amount) === amount && (input.key || norm(c.note) === norm(input.note))));
  if (duplicate) { if (input.key && !duplicate.key) duplicate.key = input.key; return duplicate; }
  const selected = input.senderId && senderOptions(txs).find(s => s.id === input.senderId);
  if (input.senderId && !selected) fail('Choose a sender present in the bank import');
  const claim = { id: crypto.randomUUID(), ...(input.key ? { key: input.key } : {}), who, amount: amount / 100, currency: 'GBP', note: String(input.note || '').trim().slice(0, 400), createdAt: at, effectiveFrom: at, excludedTransactionIds: txs.map(t => t.id), settled: false, history: [], rejectedTransactionIds: [], sender: selected ? { id: selected.id, name: selected.names.join(' / '), verifiedAt: at, evidenceTransactionIds: selected.transactionIds } : null };
  doc.claims.push(claim); return claim;
}
function seed(doc, txs, at, approved = {}) {
  if (!approved.version || !Array.isArray(approved.claims) || !approved.claims.length || doc.approvedSeedVersion === approved.version) return doc;
  for (const record of approved.claims) {
    const names = new Set((record.senderNames || []).map(norm));
    const ids = [...new Set(txs.filter(t => t.amount > 0 && names.has(norm(t.name)) && (!record.category || t.category === record.category) && senderId(t)).map(senderId))];
    create(doc, { key: record.key, who: record.who, amount: record.amount, note: record.note, senderId: ids.length === 1 ? ids[0] : undefined }, txs, at);
  }
  doc.approvedSeedVersion = approved.version;
  return doc;
}
function reconcile(doc, txs, context = {}) {
  const used = new Set(doc.claims.flatMap(c => c.history.map(h => h.transactionId).filter(Boolean)));
  const credits = txs.filter(t => t.id && t.amount > 0 && !used.has(t.id));
  const eligible = (c, t) => !c.excludedTransactionIds.includes(t.id) && !c.rejectedTransactionIds.includes(t.id) && Date.parse(t.firstSeenAt) > Date.parse(c.effectiveFrom) && Date.parse(t.date + 'T' + (t.time || '00:00') + ':00Z') > Date.parse(c.effectiveFrom);
  const posted = t => t.currency === 'GBP' && /^(posted|settled|completed)$/i.test(t.status || '') && /^(faster payment|bank transfer|transfer)$/i.test(t.type || '');
  const open = doc.claims.filter(c => !c.settled);
  for (const c of open) {
    c.review = [];
    for (const t of credits.filter(t => !used.has(t.id) && eligible(c, t))) {
      const sameSender = !!c.sender && senderId(t) === c.sender.id;
      const exact = cents(t.amount) === cents(c.amount);
      if (!sameSender && !exact) continue;
      if (!sameSender) { c.review.push({ transactionId: t.id, reason: 'Sender unverified or different' }); continue; }
      if (t.salary || /salary|payroll|wages/i.test(t.notes || t.description || '')) { c.review.push({ transactionId: t.id, reason: 'Looks like ordinary salary; review required' }); continue; }
      if (!posted(t)) { c.review.push({ transactionId: t.id, reason: 'Posting status, currency or transfer type needs verification' }); continue; }
      if (!exact) { c.review.push({ transactionId: t.id, reason: 'Amount differs; review partial payment or salary' }); continue; }
      const others = open.filter(o => eligible(o, t) && cents(o.amount) === cents(t.amount) && (!o.sender || o.sender.id === senderId(t)));
      const payments = credits.filter(r => eligible(c, r) && posted(r) && senderId(r) === c.sender.id && cents(r.amount) === cents(c.amount));
      // A credit potentially paying an existing split must never be reused.
      const splitCandidate = Object.values(context.tx || {}).some(v => (v.split || []).some(s => !s.settled && cents(s.amount) === cents(t.amount) && norm(t.name).includes(norm(s.who).split(' ')[0])));
      if (others.length !== 1 || payments.length !== 1 || splitCandidate) { c.review.push({ transactionId: t.id, reason: 'Multiple possible claims or payments' }); continue; }
      c.settled = true; c.matchedTransactionId = t.id; c.settledAt = t.firstSeenAt;
      c.history.push({ action: 'auto-settle', at: t.firstSeenAt, transactionId: t.id, senderId: senderId(t), amount: t.amount }); used.add(t.id);
      c.review = []; break;
    }
  }
  return doc;
}
function act(doc, input, txs, at) {
  const c = doc.claims.find(c => c.id === input.id); if (!c) fail('Claim not found');
  if (input.action === 'edit') {
    if (c.settled) fail('Undo settlement before editing the claim');
    const who = input.who === undefined ? c.who : String(input.who || '').trim().slice(0, 80);
    const amount = input.amount === undefined ? cents(c.amount) : cents(input.amount);
    if (!who || !Number.isFinite(amount) || amount <= 0 || amount > 1e10) fail('Enter a name and a positive GBP amount');
    const before = { who: c.who, amount: c.amount, note: c.note };
    c.who = who; c.amount = amount / 100;
    if (input.note !== undefined) c.note = String(input.note || '').trim().slice(0, 400);
    // Editing the claim cannot make an earlier imported payment eligible.
    c.effectiveFrom = at; c.excludedTransactionIds = [...new Set([...c.excludedTransactionIds, ...txs.map(t => t.id)])]; c.review = [];
    c.history.push({ action: 'edit', at, before, after: { who: c.who, amount: c.amount, note: c.note } });
  } else if (input.action === 'settle') {
    if (!c.settled) { c.settled = true; c.settledAt = at; c.history.push({ action: 'manual-settle', at }); }
  } else if (input.action === 'undo') {
    if (c.settled) { c.history.push({ action: 'undo', at, transactionId: c.matchedTransactionId || null }); if (c.matchedTransactionId) c.rejectedTransactionIds.push(c.matchedTransactionId); c.settled = false; c.effectiveFrom = at; delete c.settledAt; delete c.matchedTransactionId; }
  } else if (input.action === 'link') {
    if (c.settled) fail('Undo settlement before changing the sender');
    const s = senderOptions(txs).find(s => s.id === input.senderId); if (!s) fail('Choose a sender present in the bank import');
    c.sender = { id: s.id, name: s.names.join(' / '), verifiedAt: at, evidenceTransactionIds: s.transactionIds };
    c.history.push({ action: 'verify-sender', at, senderId: s.id });
  } else fail('Unknown claim action');
  return doc;
}
module.exports = { create, seed, reconcile, act, senderOptions };
