'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const almanac = require('../almanac');
const { dailyIndex, pickEarthView, pickColours, pickTypeface, pickOnThisDay, pickPoem, TYPEFACES } = almanac;

const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from + 'T12:00:00Z') + i * 864e5).toISOString().slice(0, 10));

test('daily picks are deterministic and walk the whole list before repeating', () => {
  assert.equal(dailyIndex('2026-10-01', 'x', 50), dailyIndex('2026-10-01', 'x', 50));
  const n = 13;
  const start = days('2026-01-01', n).find(d => Math.floor(Date.parse(d) / 864e5) % n === 0);
  const picks = days(start, n).map(d => dailyIndex(d, 'poem-lines', n));
  assert.equal(new Set(picks).size, n);
  assert.ok(picks.every(i => i >= 0 && i < n));
  const month = days('2026-10-01', 31).map(d => dailyIndex(d, 'earthview', 1520));
  assert.ok(new Set(month).size === 31, 'no repeats within a month of Earth View');
  assert.throws(() => dailyIndex('2026-10-01', 'x', 0), RangeError);
});

test('Earth View pick ignores upstream order and parses the map link', () => {
  const list = [
    { country: 'Peru', region: 'Castilla Province', image: 'https://www.gstatic.com/prettyearth/assets/full/1797.jpg', map: 'https://www.google.com/maps/@-15.551956,-72.552052,15z/data=!3m1!1e3' },
    { country: 'Australia', region: '', image: 'https://www.gstatic.com/prettyearth/assets/full/1003.jpg', map: 'https://www.google.com/maps/@-10.040181,143.560709,12z/data=!3m1!1e3' },
    { country: 'Chile', region: 'Atacama', image: 'https://www.gstatic.com/prettyearth/assets/full/2001.jpg', map: 'https://www.google.com/maps/@-23.5,-68.2,13z/data=!3m1!1e3' },
  ];
  const a = pickEarthView(list, '2026-10-01');
  const b = pickEarthView([...list].reverse(), '2026-10-01');
  assert.deepEqual(a, b);
  const peru = days('2026-10-01', 3).map(d => pickEarthView(list, d)).find(p => p.id === 1797);
  assert.equal(peru.place, 'Castilla Province, Peru');
  assert.equal(peru.lat, -15.551956);
  assert.equal(peru.lon, -72.552052);
  assert.equal(peru.zoom, 15);
  assert.equal(pickEarthView(list.slice(1, 2), '2026-10-01').place, 'Australia');
});

test('Wada colour combination has 2 to 4 colours that all belong to it', () => {
  const colors = [
    { name: 'Hermosa Pink', hex: '#f9c1ce', rgb: [249, 193, 206], cmyk: [0, 30, 6, 0], combinations: [1, 2] },
    { name: 'Corinthian Pink', hex: '#f8b6ba', rgb: [248, 182, 186], cmyk: [0, 35, 15, 0], combinations: [1, 3] },
    { name: 'Black', hex: '#1d1d1d', rgb: [29, 29, 29], cmyk: [0, 0, 0, 100], combinations: [2, 3, 4] },
    { name: 'Lonely', hex: '#ffffff', rgb: [255, 255, 255], cmyk: [0, 0, 0, 0], combinations: [4] },
  ];
  const seen = new Set();
  for (const d of days('2026-10-01', 12)) {
    const pick = pickColours(colors, d);
    seen.add(pick.number);
    assert.deepEqual(pick, pickColours(colors, d));
    assert.ok(pick.size >= 2 && pick.size <= 4);
    for (const c of pick.colours) {
      assert.ok(colors.find(x => x.name === c.name).combinations.includes(pick.number));
      assert.match(c.ink, /^#(111111|ffffff)$/);
    }
  }
  assert.ok(seen.size >= 3, 'cycles through combinations');
  assert.equal(pickColours(colors, '2026-10-01').colours.find(c => c.name === 'Black')?.ink ?? '#ffffff', '#ffffff');
});

test('typeface list is curated, unique and picked by date', () => {
  assert.ok(TYPEFACES.length >= 60);
  assert.equal(new Set(TYPEFACES.map(t => t.family)).size, TYPEFACES.length);
  for (const t of TYPEFACES) {
    assert.ok(['serif', 'sans-serif', 'monospace', 'display'].includes(t.category), t.family);
    assert.match(t.cssUrl, /^https:\/\/fonts\.googleapis\.com\/css2\?family=[A-Za-z0-9+]+(:wght@[\d.;]+)?&display=swap$/);
    assert.ok(t.note.length > 10 && t.note.length < 90, t.family);
    if ('designer' in t) assert.ok(t.designer);
  }
  assert.equal(pickTypeface('2026-10-01'), pickTypeface('2026-10-01'));
  assert.notEqual(pickTypeface('2026-10-01'), pickTypeface('2026-10-02'));
  assert.equal(TYPEFACES.find(t => t.family === 'Fraunces').cssUrl, 'https://fonts.googleapis.com/css2?family=Fraunces:wght@100..900&display=swap');
  assert.equal(TYPEFACES.find(t => t.family === 'Gloock').cssUrl, 'https://fonts.googleapis.com/css2?family=Gloock&display=swap');
});

const page = (title, description) => ({ titles: { normalized: title }, description, content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/' + title.replace(/ /g, '_') } } });
const otd = [
  { year: 2022, text: 'Around 3,000 supporters invaded the pitch, causing a stampede that killed 135.', pages: [page('Kanjuruhan Stadium disaster', '2022 association football match disaster')] },
  { year: 2018, text: 'The International Court of Justice ruled that Chile need not restore Bolivia\'s access to the Pacific.', pages: [page('International Court of Justice', 'Judicial organ of the United Nations'), page('Obligation to Negotiate Access to the Pacific Ocean', 'International law case (decided 2018)')] },
  { year: 1975, text: 'In boxing, Muhammad Ali defeated Joe Frazier in a match known as the "Thrilla in Manila".', pages: [page('Muhammad Ali', 'American boxer and activist (1942–2016)'), page('Thrilla in Manila', '1975 boxing match at the Araneta Coliseum')] },
  { year: 1868, text: 'St Pancras railway station (pictured) in London opened to the public.', pages: [page('St Pancras railway station', 'Railway terminus in London, England'), page('High Speed 1', 'High-speed railway')] },
  { year: 1890, text: 'The U.S. Congress established Yosemite National Park.', pages: [page('John Muir', 'Scottish-American naturalist (1838–1914)'), page('United States Congress', 'Bicameral legislature'), page('Yosemite National Park', 'National park in California')] },
  { year: 959, text: 'Edgar acceded to the English throne upon the death of his brother Eadwig.', pages: [page('Edgar, King of England', 'King of the English from 959 to 975'), page('Eadwig', 'King of England from 955 to 959')] },
];

test('on this day picks three calm events from spread-out centuries with plain text and a main link', () => {
  const picks = pickOnThisDay(otd, '2026-10-01');
  assert.deepEqual(picks, pickOnThisDay(otd, '2026-10-01'));
  assert.equal(picks.length, 3);
  assert.deepEqual(picks.map(p => p.year), [...picks.map(p => p.year)].sort((a, b) => a - b));
  assert.equal(new Set(picks.map(p => Math.ceil(p.year / 100))).size, 3);
  assert.equal(picks[0].year, 959, 'oldest century is always represented');
  assert.ok(!picks.some(p => /killed/.test(p.text)), 'grim events are avoided when there are alternatives');
  for (const d of days('2026-10-01', 10)) {
    const st = pickOnThisDay(otd, d).find(p => p.year === 1868);
    if (st) assert.equal(st.text, 'St Pancras railway station in London opened to the public.');
  }
  assert.equal(almanac.mainPage(otd[2]).title, 'Thrilla in Manila');
  assert.equal(almanac.mainPage(otd[1]).title, 'Obligation to Negotiate Access to the Pacific Ocean');
  assert.equal(almanac.mainPage(otd[4]).title, 'Yosemite National Park');
  assert.equal(almanac.mainPage(otd[5]).title, 'Edgar, King of England');
});

test('poem pick keeps 4 to 16 lines and is stable for the day', () => {
  const poems = [
    { title: 'Short', author: 'A', lines: ['one', 'two', 'three'] },
    { title: 'Quatrain', author: 'B', lines: ['a', 'b', '', 'c', 'd'] },
    { title: 'Prose', author: 'C', lines: ['x'.repeat(100), 'b', 'c', 'd'] },
    { title: 'Octave', author: 'D', lines: Array.from({ length: 8 }, (_, i) => `line ${i}`) },
  ];
  const pick = pickPoem(poems, '2026-10-01');
  assert.deepEqual(pick, pickPoem([...poems].reverse(), '2026-10-01'));
  assert.ok(['Quatrain', 'Octave'].includes(pick.title));
  assert.ok(pick.lineCount >= 4 && pick.lineCount <= 16);
  assert.equal(pickPoem(poems.slice(0, 1), '2026-10-01'), null);
});

test('moon phases land on the known 2026 dates', () => {
  const at = iso => new Date(iso);
  const sept = almanac.moonPhase(at('2026-09-26T08:00:00Z'));
  assert.equal(sept.phase, 'Full moon');
  assert.ok(sept.illumination >= 99);
  const oct1 = almanac.moonPhase(at('2026-10-01T09:00:00Z'));
  assert.equal(oct1.phase, 'Waning gibbous');
  assert.equal(oct1.waxing, false);
  assert.equal(oct1.nextNew.date, '2026-10-10');
  assert.equal(oct1.nextFull.date, '2026-10-26');
  assert.ok(Math.abs(oct1.age - 20.2) < 0.2, `age ${oct1.age}`);
  assert.ok(oct1.illumination > 70 && oct1.illumination < 85, `illumination ${oct1.illumination}`);
  assert.equal(almanac.moonPhase(at('2026-10-26T20:00:00Z')).phase, 'Full moon');
  const newMoon = almanac.moonPhase(at('2026-10-10T12:00:00Z'));
  assert.equal(newMoon.phase, 'New moon');
  assert.ok(newMoon.illumination <= 1);
  assert.equal(almanac.moonPhase(at('2026-10-05T12:00:00Z')).phase, 'Waning crescent');
  assert.equal(almanac.moonPhase(at('2026-10-14T12:00:00Z')).phase, 'Waxing crescent');
  assert.equal(almanac.moonPhase(at('2026-10-18T12:00:00Z')).phase, 'First quarter');
  // Solar eclipses pin new moons to the minute: 8 Apr 2024 18:21 UTC, 12 Aug 2026 17:37 UTC.
  for (const [from, expected] of [['2024-04-01T00:00:00Z', '2024-04-08T18:21:00Z'], ['2026-08-01T00:00:00Z', '2026-08-12T17:37:00Z']]) {
    const next = almanac.moonPhase(at(from)).nextNew.at;
    assert.ok(Math.abs(Date.parse(next) - Date.parse(expected)) < 10 * 60e3, `${next} vs ${expected}`);
  }
});

test('WMO weather codes read as plain English', () => {
  const cases = { 0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 51: 'Light drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 80: 'Light showers', 82: 'Heavy showers', 95: 'Thunderstorm', 99: 'Thunderstorm with heavy hail' };
  for (const [code, label] of Object.entries(cases)) assert.equal(almanac.wmoLabel(Number(code)), label);
  assert.equal(almanac.wmoLabel('63'), 'Rain');
  for (const odd of [4, 999, null, undefined, '', 'rain']) assert.equal(almanac.wmoLabel(odd), 'Unknown');
  assert.deepEqual(almanac.weather(53), { code: 53, label: 'Drizzle', kind: 'drizzle' });
});

const meteo = {
  current: { time: '2026-10-01T23:00', temperature_2m: 14.7, apparent_temperature: 12.4, weather_code: 3, cloud_cover: 100, is_day: 0, wind_speed_10m: 13.3, precipitation: 0 },
  hourly: {
    time: Array.from({ length: 48 }, (_, i) => `2026-10-0${1 + Math.floor(i / 24)}T${String(i % 24).padStart(2, '0')}:00`),
    temperature_2m: Array.from({ length: 48 }, (_, i) => 10 + (i % 7)), weather_code: Array(48).fill(61), cloud_cover: Array(48).fill(90), precipitation_probability: Array(48).fill(40),
  },
  daily: { time: ['2026-10-01', '2026-10-02'], sunrise: ['2026-10-01T07:25', '2026-10-02T07:27'], sunset: ['2026-10-01T18:59', '2026-10-02T18:57'], temperature_2m_max: [16.7, 16.5], temperature_2m_min: [10.3, 11.9], weather_code: [3, 63], precipitation_probability_max: [30, 100] },
};

test('sky starts the hourly strip at the current hour', () => {
  const sky = almanac.buildSky(meteo);
  assert.equal(sky.place, 'Belfast');
  assert.equal(sky.hours[0].time, '23:00');
  assert.equal(sky.hours.length, 12);
  assert.equal(sky.hours[1].time, '00:00');
  assert.equal(sky.today.daylight, '11h 34m');
  assert.equal(sky.tomorrow.label, 'Rain');
  assert.equal(sky.summary, 'Overcast, 15°C (feels like 12°C). High 17°, low 10°.');
});

test('image routes accept only known keys and real dates', () => {
  const p = new URLSearchParams();
  for (const key of ['earthview', 'picture', 'earth', 'article']) assert.deepEqual(almanac.parseImageRequest(`/api/almanac/image/${key}`, p), { key, date: null });
  assert.deepEqual(almanac.parseImageRequest('/api/almanac/image/earth', new URLSearchParams('d=2026-10-01')), { key: 'earth', date: '2026-10-01' });
  for (const bad of ['/api/almanac/image/../../server.js', '/api/almanac/image/%2e%2e%2fconfig', '/api/almanac/image/EarthView', '/api/almanac/image/earthview.jpg',
    '/api/almanac/image/earthview/', '/api/almanac/image/constructor', '/api/almanac/image/', '/api/almanac/image/poem', '/api/almanac/images/earth']) {
    assert.equal(almanac.parseImageRequest(bad, p), null, bad);
  }
  for (const d of ['../../etc/passwd', '2026-13-01', '2026-02-30', '20261001', '2026-10-01/../x', '']) {
    assert.equal(almanac.parseImageRequest('/api/almanac/image/earth', new URLSearchParams({ d })), null, d);
  }
});

// A tiny valid PNG header: enough for type and size sniffing.
function png(width, height) {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b;
}

function fakeNet(down = new Set()) {
  const calls = [];
  const json = value => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(value)) });
  const fetch = async url => {
    calls.push(url);
    const host = new URL(url).host;
    if (down.has('all') || down.has(host)) throw new Error(`HTTP 503 from ${host}`);
    if (url.includes('earthview.json')) return json([{ country: 'Peru', region: 'Castilla Province', image: 'https://www.gstatic.com/prettyearth/assets/full/1797.jpg', map: 'https://www.google.com/maps/@-15.5,-72.5,15z' }]);
    if (url.includes('colors.json')) return json([{ name: 'A', hex: '#000000', rgb: [0, 0, 0], cmyk: [0, 0, 0, 100], combinations: [1] }, { name: 'B', hex: '#ffffff', rgb: [255, 255, 255], cmyk: [0, 0, 0, 0], combinations: [1] }]);
    if (host === 'api.wikimedia.org') return json({
      image: { title: 'File:Thing.jpg', thumbnail: { source: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Thing.jpg/960px-Thing.jpg?utm_source=x' }, image: { source: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Thing.jpg', width: 4000, height: 3000 }, artist: { text: 'Someone' }, credit: { text: 'Own work' }, license: { type: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0' }, description: { text: 'A thing, photographed.' } },
      tfa: { titles: { normalized: 'Thing' }, extract: 'Thing is a thing. It is notable.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Thing' } } },
      onthisday: otd,
    });
    if (host === 'api.open-meteo.com') return json(meteo);
    if (url.endsWith('/api/natural')) return json([{ image: 'epic_1b_20260928114330', date: '2026-09-28 11:38:42', caption: 'EPIC', centroid_coordinates: { lat: 5.1, lon: 0.2 }, dscovr_j2000_position: { x: 1.5e6, y: 0, z: 0 } }, { image: 'epic_1b_20260928005515', date: '2026-09-28 00:50:27', centroid_coordinates: { lat: 5.2, lon: 162.4 } }]);
    if (host === 'poetrydb.org') return json([{ title: 'Octave', author: 'D', lines: Array.from({ length: 8 }, (_, i) => `line ${i}`) }]);
    if (host === 'fonts.googleapis.com') return { status: 200, headers: {}, body: Buffer.from('@font-face{}') };
    if (/gstatic|upload\.wikimedia|epic\.gsfc/.test(host)) return { status: 200, headers: {}, body: png(1800, 1200) };
    throw new Error('unexpected ' + url);
  };
  return { fetch, calls };
}

function mockRes() {
  return { status: null, headers: null, body: null, headersSent: false, writeHead(s, h) { this.status = s; this.headers = h; this.headersSent = true; }, end(b) { this.body = b; } };
}

test('sources fail independently, fall back to the last good value, and images are served from cache', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almanac-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = Date.parse('2026-10-01T08:00:00Z');
  const down = new Set(['epic.gsfc.nasa.gov']);
  const net = fakeNet(down);
  const source = almanac.createAlmanac({ dir, fetch: net.fetch, now: () => new Date(time), log: () => {} });

  const [a, b] = await Promise.all([source.getAlmanac(), source.getAlmanac()]);
  assert.deepEqual(a, b);
  assert.equal(net.calls.filter(u => u.includes('open-meteo')).length, 1, 'concurrent calls share one refresh');
  assert.equal(a.date, '2026-10-01');
  assert.deepEqual(Object.keys(a.items), ['earthView', 'colours', 'picture', 'onThisDay', 'article', 'sky', 'earth', 'poem', 'moon', 'typeface']);
  assert.match(a.items.earth.error, /503/);
  assert.equal(a.items.earthView.place, 'Castilla Province, Peru');
  assert.equal(a.items.earthView.image.url, '/api/almanac/image/earthview?d=2026-10-01');
  assert.equal(a.items.picture.attribution, 'Someone, CC BY-SA 4.0, via Wikimedia Commons');
  assert.ok(net.calls.includes('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Thing.jpg/1920px-Thing.jpg'));
  assert.equal(a.items.onThisDay.events.length, 3);
  assert.equal(a.items.moon.phase, 'Waning gibbous');
  assert.ok(fs.existsSync(path.join(dir, '2026-10-01.json')));

  // Warm: nothing refetched within the half hour (not even the failed source);
  // then the weather refreshes and the failed source gets its retry.
  const before = net.calls.length;
  time += 10 * 60e3; await source.getAlmanac();
  assert.equal(net.calls.length, before);
  time += 25 * 60e3; await source.getAlmanac();
  const hosts = net.calls.slice(before).map(u => new URL(u).host).sort();
  assert.deepEqual(hosts, ['api.open-meteo.com', 'epic.gsfc.nasa.gov'], 'weather after 30 min, failed source after its 15 min back-off');

  // Next day, everything offline: yesterday's values come back marked stale.
  down.add('all');
  time = Date.parse('2026-10-02T08:00:00Z');
  const next = await source.getAlmanac();
  assert.equal(next.date, '2026-10-02');
  assert.equal(next.items.picture.stale, true);
  assert.match(next.items.picture.staleReason, /503/);
  assert.equal(next.items.picture.image.url, '/api/almanac/image/picture?d=2026-10-01');
  assert.equal(next.items.sky.stale, true);
  assert.match(next.items.earth.error, /503/);
  assert.ok(!next.items.colours.stale, 'cached colour dictionary still gives a fresh pick');
  assert.equal(next.items.typeface.verified, false);

  const res = mockRes();
  assert.equal(await source.handle({ method: 'GET' }, res, new URL('http://x/api/almanac/image/picture')), true);
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.headers['Cache-Control'], 'public, max-age=86400');
  assert.equal(res.body.length, 40);
  const missing = mockRes();
  await source.handle({ method: 'GET' }, missing, new URL('http://x/api/almanac/image/../config.json'));
  assert.equal(missing.status, 404);
  const other = mockRes();
  assert.equal(await source.handle({ method: 'GET' }, other, new URL('http://x/api/state')), false);
  assert.equal(other.status, null);
});

test('a malformed upstream redirect rejects without escaping the response callback', async (t) => {
  const { mockHttps } = require('./http-fixture');
  mockHttps(t, 'get', (res, req, ready) => {
    res.statusCode = 302; res.headers.location = 'https://[';
    ready(); res.complete = true; res.end();
  });
  await assert.rejects(almanac.fetchRaw('https://example.test/'), /bad redirect/);
});

test('portable profiles without a place omit sky and moon and never request weather', async t => {
  const runtime = require('../runtime');
  t.after(() => runtime.configure({ portable: false, connectors: {} }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almanac-place-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const net = fakeNet();
  runtime.configure({ portable: true, place: null, connectors: { almanac: { enabled: false } } });
  const source = almanac.createAlmanac({ dir, fetch: net.fetch, now: () => new Date('2026-10-01T08:00:00Z'), log: () => {} });
  const empty = await source.getAlmanac();
  assert.equal(net.calls.length, 0, 'an unconfigured fresh profile makes no outbound request');
  assert.equal(Object.hasOwn(empty.items, 'sky'), false);
  assert.equal(Object.hasOwn(empty.items, 'moon'), false);

  // A manually enabled almanac still supplies sources that do not need a place.
  runtime.updateConnectors({ almanac: { enabled: true } });
  const daily = await source.getAlmanac();
  assert.ok(daily.items.colours.colours.length);
  assert.ok(net.calls.length > 0);
  assert.equal(net.calls.some(url => new URL(url).host === 'api.open-meteo.com'), false);
  assert.equal(Object.hasOwn(daily.items, 'sky'), false);
  assert.equal(Object.hasOwn(daily.items, 'moon'), false);
});

test('portable weather and moon use the place, and cached weather never crosses places', async t => {
  const runtime = require('../runtime');
  t.after(() => runtime.configure({ portable: false, connectors: {} }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almanac-place-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = new Date('2026-10-01T00:30:00Z');
  const place = { name: 'New York', latitude: 40.7128, longitude: -74.006, timezone: 'America/New_York' };
  runtime.configure({ portable: true, place, connectors: { almanac: { enabled: true } } });
  const down = new Set(), net = fakeNet(down);
  const options = { dir, fetch: net.fetch, now: () => time, log: () => {} };
  const source = almanac.createAlmanac(options);
  const first = await source.getAlmanac();
  assert.equal(first.date, '2026-09-30');
  assert.equal(first.items.sky.place, 'New York');
  assert.equal(first.items.sky.today.sunrise, '07:25');
  assert.equal(first.items.sky.today.sunset, '18:59');
  const url = new URL(net.calls.find(url => new URL(url).host === 'api.open-meteo.com'));
  assert.equal(url.searchParams.get('latitude'), '40.7128');
  assert.equal(url.searchParams.get('longitude'), '-74.006');
  assert.equal(url.searchParams.get('timezone'), 'America/New_York');
  assert.deepEqual(first.items.moon, almanac.moonPhase(time, place.timezone));

  down.add('api.open-meteo.com');
  time = new Date('2026-10-02T00:30:00Z');
  const stale = await source.getAlmanac();
  assert.equal(stale.items.sky.place, place.name);
  assert.equal(stale.items.sky.stale, true, 'same-place fallback remains available across days');

  const changed = { name: 'Tokyo', latitude: 35.6762, longitude: 139.6503, timezone: 'Asia/Tokyo' };
  runtime.updateConnectors({ almanac: { enabled: true } }, changed);
  const unavailable = await source.getAlmanac();
  assert.match(unavailable.items.sky.error, /503/);
  assert.equal(unavailable.items.sky.place, undefined, 'previous-place forecast is not used as fallback');
  const restarted = await almanac.createAlmanac(options).getAlmanac();
  assert.equal(restarted.items.sky.place, undefined, 'disk history cannot restore previous-place weather');
  down.clear();
  const fresh = await source.getAlmanac({ force: true });
  assert.equal(fresh.items.sky.place, changed.name);
  assert.notEqual(fresh.items.moon.nextNew.date, almanac.moonPhase(time).nextNew.date);
  runtime.updateConnectors({ almanac: { enabled: true } }, null);
  const calls = net.calls.length;
  const removed = await source.getAlmanac();
  assert.equal(Object.hasOwn(removed.items, 'sky'), false);
  assert.equal(Object.hasOwn(removed.items, 'moon'), false);
  assert.equal(net.calls.length, calls, 'removing the place does not start another weather request');
});

test('legacy almanac retains the exact Belfast forecast URL and labels', async t => {
  const runtime = require('../runtime');
  runtime.configure({ portable: false, place: { name: 'Ignored' }, connectors: {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almanac-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const net = fakeNet();
  const daily = await almanac.createAlmanac({ dir, fetch: net.fetch, now: () => new Date('2026-10-01T08:00:00Z'), log: () => {} }).getAlmanac();
  assert.equal(daily.items.sky.place, 'Belfast');
  assert.equal(net.calls.find(url => new URL(url).host === 'api.open-meteo.com'),
    'https://api.open-meteo.com/v1/forecast?latitude=54.597&longitude=-5.930'
    + '&current=temperature_2m,apparent_temperature,weather_code,cloud_cover,is_day,wind_speed_10m,precipitation'
    + '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max'
    + '&hourly=temperature_2m,weather_code,cloud_cover,precipitation_probability&forecast_days=2&timezone=Europe%2FLondon');
});

test('outbound almanac user agent retains Belfast only for the legacy profile', async t => {
  const runtime = require('../runtime');
  const https = require('node:https');
  const { mockHttps } = require('./http-fixture');
  t.after(() => runtime.configure({ portable: false, connectors: {} }));
  mockHttps(t, 'get', (res, _req, ready) => { ready(); res.complete = true; res.end('{}'); });
  const send = https.get, headers = [];
  t.mock.method(https, 'get', (url, options, callback) => { headers.push(options.headers); return send(url, options, callback); });
  runtime.configure({ portable: false, connectors: {} });
  await almanac.fetchRaw('https://example.test/');
  runtime.configure({ portable: true, place: null, connectors: {} });
  await almanac.fetchRaw('https://example.test/');
  assert.equal(headers[0]['User-Agent'], 'Meridian/1.0 (personal dashboard; Belfast)');
  assert.equal(headers[1]['User-Agent'], 'Meridian/1.0 (personal dashboard)');
});
