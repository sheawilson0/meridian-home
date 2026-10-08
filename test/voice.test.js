'use strict';

const test = require('node:test');
const assert = require('assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createVoice, sessionConfig, TOOLS } = require('../voice');
const VC = require('../public/voice/voice-core.js');

const draft = { id: 'abc123', kind: 'email', to: 'Sam', subject: 'Thursday', body: 'Hi Sam,\n\nSee you then.' };

test('GPT-Live session hands tools to the Sol backend, with the draft in its instructions', () => {
  const s = sessionConfig('live', { voice: 'meridian', draft, soul: 'Dry, warm.' });
  assert.equal(s.model, 'gpt-live-1');
  assert.equal(s.audio.output.voice, 'meridian');
  assert.equal(s.delegation.type, 'responses');
  assert.equal(s.delegation.responses.model, 'gpt-6.1-sol');
  assert.deepEqual(s.delegation.responses.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.ok(s.delegation.responses.tools.every((t) => t.type === 'function'));
  assert.match(s.delegation.responses.instructions, /See you then/);
  assert.match(s.instructions, /Dry, warm/);
});

test('Realtime session carries the tools itself; unknown voices fall back', () => {
  const s = sessionConfig('realtime', { voice: 'nobody', draft: null });
  assert.equal(s.type, 'realtime');
  assert.equal(s.model, 'gpt-realtime-2.1');
  assert.equal(s.audio.output.voice, 'marin');
  assert.equal(s.tools.length, TOOLS.length);
  assert.match(s.instructions, /No draft is open/);
  assert.throws(() => sessionConfig('nope'), /unknown engine/);
});

async function setup(over = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'voice-'));
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    if (url.endsWith('/v1/live/sessions')) return { ok: true, status: 201, text: async () => JSON.stringify({ session: { id: 'ls_1' }, transport: { sdp: 'answer-live' } }), headers: new Map() };
    return { ok: true, status: 201, text: async () => 'answer-rt', headers: { get: () => '/v1/realtime/calls/rtc_9' } };
  };
  const v = createVoice({ dataDir: dir, drafts: { get: async (id) => ({ ...draft, id }) }, env: {}, getKeychainKey: async () => 'sk-test', fetchImpl, ...over });
  return { v, sent, dir };
}

test('createSession keeps the key server-side and returns only the answer', async () => {
  const { v, sent } = await setup();
  const live = await v.createSession({ engine: 'live', voice: 'marin', draftId: 'abc123', sdp: 'offer' });
  assert.deepEqual([live.sdp, live.sessionId, live.by], ['answer-live', 'ls_1', 'Voice · Live']);
  assert.equal(sent[0].init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.transport, { type: 'webrtc', sdp: 'offer' });
  assert.ok(!JSON.stringify(live).includes('sk-test'));
  const rt = await v.createSession({ engine: 'realtime', sdp: 'offer' });
  assert.deepEqual([rt.sdp, rt.sessionId], ['answer-rt', 'rtc_9']);
  assert.equal(JSON.parse(sent[1].init.body.get('session')).model, 'gpt-realtime-2.1');
});

test('no key, bad input and the daily cap are refused before calling OpenAI', async () => {
  const none = await setup({ getKeychainKey: async () => '' });
  await assert.rejects(none.v.createSession({ engine: 'live', sdp: 'x' }), (e) => e.statusCode === 503);
  assert.equal(none.sent.length, 0);
  assert.equal((await none.v.status()).ready, false);
  const { v, sent } = await setup({ config: { dailyCalls: 2 } });
  await assert.rejects(v.createSession({ engine: 'live', sdp: '' }), /SDP/);
  await assert.rejects(v.createSession({ engine: 'shout', sdp: 'x' }), /unknown engine/);
  await v.createSession({ engine: 'live', sdp: 'x' });
  await v.createSession({ engine: 'live', sdp: 'x' });
  await assert.rejects(v.createSession({ engine: 'live', sdp: 'x' }), (e) => e.statusCode === 429);
  assert.equal(sent.length, 2);
  assert.equal((await v.status()).today.calls, 2);
});

test('usage is logged and counted in today\'s minutes', async () => {
  const { v } = await setup();
  await v.logUsage({ engine: 'live', seconds: 90 });
  await v.logUsage({ engine: 'realtime', seconds: 30, usage: { output_audio: 100 } });
  assert.equal((await v.status()).today.minutes, 2);
});

test('POSTs from another site are refused', async () => {
  const { v } = await setup();
  let out;
  const res = {};
  const sendJson = (_r, code, value) => { out = { code, value }; };
  const req = { method: 'POST', headers: { origin: 'https://evil.example', host: 'home.ts.net' } };
  await v.handle(req, res, new URL('http://x/api/voice/session'), { jsonBody: async () => ({}), sendJson });
  assert.equal(out.code, 403);
  assert.equal(await v.handle({ method: 'GET', headers: {} }, res, new URL('http://x/api/other'), { jsonBody: null, sendJson }), false);
});

// ---- the page's pure parts (public/voice/voice-core.js)

test('diff works in whole words', () => {
  const ops = VC.diff('the quick brown fox', 'the quick red fox');
  assert.deepEqual(ops, [{ t: '=', s: 'the quick ' }, { t: '-', s: 'brown' }, { t: '+', s: 'red' }, { t: '=', s: ' fox' }]);
  const join = (o, keep) => o.filter((x) => x.t === '=' || x.t === keep).map((x) => x.s).join('');
  for (const [a, b] of [['', 'hello'], ['hello', ''], ['a b c d', 'a x c y'], ['Hi Sam,\n\nThanks.', 'Hi Sam,\n\nThanks so much.\n\nBest']]) {
    const o = VC.diff(a, b);
    assert.equal(join(o, '-'), a); assert.equal(join(o, '+'), b);
  }
});

test('authorship credits each word to whoever last wrote it', () => {
  const history = [
    { rev: 1, by: 'you', at: '2026-10-06T10:00:00Z', field: 'body', before: '', after: 'Hi Sam, see you Thursday.' },
    { rev: 2, by: 'Voice · Live', at: '2026-10-06T10:01:00Z', field: 'body', before: 'Hi Sam, see you Thursday.', after: 'Hi Sam, looking forward to Thursday.' },
    { rev: 3, by: 'Dot', at: '2026-10-06T10:02:00Z', field: 'subject', before: '', after: 'x' },
  ];
  const spans = VC.authorship(history, 'body', 'Hi Sam, looking forward to Thursday. Best');
  const by = spans.map((s) => [s.by, s.text]);
  assert.deepEqual(by, [['you', 'Hi Sam, '], ['Voice · Live', 'looking forward to'], ['you', ' Thursday.'], ['you', ' Best']]);
  assert.ok(spans[3].pending);
  assert.match(VC.spansHTML(spans), /w-voice/);
  assert.equal(VC.who('Dot').cls, 'dot');
  assert.equal(VC.who('Claude').cls, 'agent');
});

test('rebase puts Owner\'s typing on top of the voice\'s edit unless they overlap', () => {
  const base = 'Hi Sam, see you Thursday. Best, Owner';
  const theirs = 'Hi Sam, looking forward to Thursday. Best, Owner';
  assert.equal(VC.rebase(base, 'Hi Sam, see you Thursday. Best wishes, Owner', theirs), 'Hi Sam, looking forward to Thursday. Best wishes, Owner');
  assert.equal(VC.rebase(base, 'Hello Sam, see you Thursday. Best, Owner', theirs), 'Hello Sam, looking forward to Thursday. Best, Owner');
  assert.equal(VC.rebase(base, 'Hi Sam, see you Friday. Best, Owner', 'Hi Sam, see you on Thursday. Best, Owner'), 'Hi Sam, see you on Friday. Best, Owner');
  assert.equal(VC.rebase(base, 'Hi Sam, see you Friday. Best, Owner', 'Hi Sam, see you Thursdays. Best, Owner'), null);
  assert.equal(VC.rebase(base, base, theirs), theirs);
  assert.equal(VC.rebase(base, 'x', base), 'x');
});
