'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runtime = require('../runtime');
const firstRun = require('../first-run');
const { validatePlace } = require('../place');
const place = { name: 'Edinburgh', latitude: 55.953, longitude: -3.188, timezone: 'Europe/London' };

test('place config validates numeric ranges, names and IANA timezones', () => {
  assert.equal(validatePlace(null), null);
  assert.equal(validatePlace(undefined), null);
  assert.deepEqual(validatePlace(place), place);
  assert.deepEqual(validatePlace({ ...place, latitude: 0, longitude: 0, timezone: 'UTC' }), { ...place, latitude: 0, longitude: 0, timezone: 'UTC' });
  for (const [key, value] of [['latitude', 91], ['latitude', -91], ['latitude', NaN], ['latitude', '55.953'], ['longitude', 181], ['longitude', -181], ['longitude', Infinity], ['timezone', '+01:00'], ['timezone', 'Not/A_Zone'], ['name', ''], ['name', 'A\nB']]) {
    assert.throws(() => validatePlace({ ...place, [key]: value }));
  }
  for (const value of [[], 'Belfast', {}, { ...place, unknown: true }]) assert.throws(() => validatePlace(value));
  for (const [latitude, longitude] of [[90, 180], [-90, -180]]) assert.doesNotThrow(() => validatePlace({ ...place, latitude, longitude }));
});

test('portable boot publishes validated place and rejects bad config, legacy ignores place', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-place-'));
  t.after(() => { runtime.configure({ portable: false, connectors: {} }); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'config.json');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.example.json')));
  // Keep every prerequisite path in this synthetic profile.
  for (const [section, keys] of Object.entries({ board: ['dir'], brain: ['graphPath'], ledger: ['dir'], exampleappFeedback: ['stateFile', 'cli'], journal: ['vaultDir'] })) {
    for (const key of keys) config[section][key] = path.join(root, 'missing');
  }
  const oldData = runtime.DATA_DIR;
  runtime.DATA_DIR = path.join(root, 'data');
  t.after(() => { runtime.DATA_DIR = oldData; });
  const put = value => fs.writeFileSync(file, JSON.stringify(value));
  put({ ...config, place });
  firstRun.load(file);
  assert.deepEqual(runtime.configuredPlace(), place);
  const { createSetup } = require('../setup-api');
  const setup = createSetup({ config: firstRun.load(file), file, queue: (_file, change) => change(), onChange: name => {
    assert.equal(name, 'almanac');
    assert.equal(runtime.configuredPlace().name, 'Tokyo');
  } });
  const enabled = await setup.update('almanac', { enabled: true, settings: { name: 'Tokyo', latitude: '35.6762', longitude: '139.6503', timezone: 'Asia/Tokyo' } });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.configured, true);
  assert.deepEqual(runtime.configuredPlace(), { name: 'Tokyo', latitude: 35.6762, longitude: 139.6503, timezone: 'Asia/Tokyo' });
  assert.equal(JSON.parse(fs.readFileSync(file)).connectors.almanac.enabled, true);
  put({ ...config, place: { ...place, timezone: 'Invalid/Zone' } });
  assert.throws(() => firstRun.load(file), /IANA/);
  const legacy = { ...config, place: { timezone: 'Invalid/Zone' } };
  delete legacy.profile;
  put(legacy);
  assert.deepEqual(firstRun.load(file), legacy);
  assert.equal(runtime.portableProfile(), false);
  assert.equal(runtime.configuredPlace(), null);
});


test('existing dashboard and phone labels keep the legacy Belfast fallback and use portable place names', () => {
  const vm = require('node:vm');
  const command = fs.readFileSync(path.join(__dirname, '../public/command.js'), 'utf8');
  const phone = fs.readFileSync(path.join(__dirname, '../public/phone.js'), 'utf8');
  const desktopLabel = command.match(/const placeName=\(\)=>[^;]+;/)[0];
  const phoneLabel = phone.match(/S\?\.location\?\.name \|\| \(S\?\.setup \? 'Outside' : 'Belfast'\)/)[0];
  for (const [state, expected] of [[{}, 'Belfast'], [{ setup: {}, location: { name: '' } }, 'Outside'], [{ setup: {}, location: { name: 'Tokyo' } }, 'Tokyo']]) {
    assert.equal(vm.runInNewContext(desktopLabel + 'placeName()', { state }), expected);
    assert.equal(vm.runInNewContext(phoneLabel, { S: state }), expected);
  }
});
