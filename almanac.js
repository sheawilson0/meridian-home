'use strict';
const runtime = require('./runtime');
const jobsEnabled = () => runtime.connectorEnabled('almanac');
const { CACHE_DIR } = runtime;
// Almanac: a handful of outside things that change day by day (Earth View,
// Wada colours, Wikimedia featured feed, Belfast sky, DSCOVR Earth, a poem,
// the moon, a typeface). Zero dependencies, no API keys. Each source fails on
// its own and falls back to its last good value (stale: true). Images are
// fetched server-side once per day and served from cache/almanac/img so the
// dashboard never hotlinks.
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { checkPublicUrl, publicLookup } = require('./public-network');

const UA = 'Meridian/1.0 (personal dashboard; Belfast)';
const PLACE = { name: 'Belfast', lat: 54.597, lon: -5.930, timeZone: 'Europe/London' };
const TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 3;
const KEEP_DAYS = 14;
const SKY_TTL_MS = 30 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
const DATASET_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ITEM_ORDER = ['earthView', 'colours', 'picture', 'onThisDay', 'article', 'sky', 'earth', 'poem', 'moon', 'typeface'];
const IMAGE_KEYS = new Map([['earthview', 'earthView'], ['picture', 'picture'], ['earth', 'earth'], ['article', 'article']]);
const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
const URLS = {
  earthView: 'https://raw.githubusercontent.com/limhenry/earthview/master/earthview.json',
  colours: 'https://raw.githubusercontent.com/mattdesl/dictionary-of-colour-combinations/master/colors.json',
  feed: d => `https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${d.replace(/-/g, '/')}`,
  feedFallback: d => `https://en.wikipedia.org/api/rest_v1/feed/featured/${d.replace(/-/g, '/')}`,
  sky: 'https://api.open-meteo.com/v1/forecast?latitude=54.597&longitude=-5.930'
    + '&current=temperature_2m,apparent_temperature,weather_code,cloud_cover,is_day,wind_speed_10m,precipitation'
    + '&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max'
    + '&hourly=temperature_2m,weather_code,cloud_cover,precipitation_probability&forecast_days=2&timezone=Europe%2FLondon',
  epic: 'https://epic.gsfc.nasa.gov/api/natural',
  epicImage: (date, image) => `https://epic.gsfc.nasa.gov/archive/natural/${date.replace(/-/g, '/')}/jpg/${image}.jpg`,
  poems: n => `https://poetrydb.org/linecount/${n}`,
};

// ------------------------------------------------------------------ fetching

function fetchRaw(url, { timeout = TIMEOUT_MS, maxBytes = 30 * 1024 * 1024, accept = '*/*' } = {}) {
  const deadline = Date.now() + timeout;
  const hop = (href, hops) => new Promise((resolve, reject) => {
    let u;
    try { u = new URL(href); } catch { reject(new Error('bad URL')); return; }
    if (u.protocol !== 'https:') { reject(new Error(`refusing ${u.protocol} URL`)); return; }
    try { checkPublicUrl(u); } catch (error) { reject(error); return; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new Error(`timed out after ${timeout / 1000} s (${u.host})`)); return; }
    const req = https.get(u, { lookup: publicLookup, headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br', Accept: accept } }, res => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); clearTimeout(timer);
        if (hops >= MAX_REDIRECTS) { reject(new Error(`too many redirects (${u.host})`)); return; }
        let next;
        try { next = new URL(res.headers.location, u).href; } catch { reject(new Error(`bad redirect (${u.host})`)); return; }
        resolve(hop(next, hops + 1));
        return;
      }
      if (status < 200 || status >= 300) { res.resume(); clearTimeout(timer); reject(new Error(`HTTP ${status} from ${u.host}`)); return; }
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      const body = encoding.includes('gzip') ? res.pipe(zlib.createGunzip())
        : encoding === 'deflate' ? res.pipe(zlib.createInflate())
        : encoding === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = []; let size = 0;
      body.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { clearTimeout(timer); reject(new Error(`response too large (${u.host})`)); req.destroy(); }
        else chunks.push(chunk);
      });
      body.on('end', () => { clearTimeout(timer); resolve({ status, headers: res.headers, body: Buffer.concat(chunks), url: u.href }); });
      body.on('error', err => { clearTimeout(timer); reject(err); });
      res.on('error', err => { clearTimeout(timer); reject(err); });
      res.on('close', () => { if (!res.complete) { clearTimeout(timer); reject(new Error(`connection closed early (${u.host})`)); } });
    });
    const timer = setTimeout(() => { reject(new Error(`timed out after ${timeout / 1000} s (${u.host})`)); req.destroy(); }, remaining);
    req.on('error', err => { clearTimeout(timer); reject(err); });
  });
  return hop(url, 0);
}

function sniffImage(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', ...jpegSize(buf) };
    if (buf.readUInt32BE(0) === 0x89504e47) return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf.toString('ascii', 0, 4) === 'GIF8') return { ext: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') return { ext: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { ext: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
      return { ext: 'webp' };
    }
    if (buf.toString('ascii', 4, 8) === 'ftyp' && /^avi[fs]$/.test(buf.toString('ascii', 8, 12))) return { ext: 'avif' };
  } catch { /* fall through: not an image we understand */ }
  return null;
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return {};
}

// ------------------------------------------------------------------ dates and picks

function londonDate(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PLACE.timeZone }).format(at);
}
function isIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}
function dayNumber(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function shiftDate(date, days) {
  return new Date((dayNumber(date) + days) * 86400000).toISOString().slice(0, 10);
}
function hashInt(value) {
  return crypto.createHash('sha256').update(String(value)).digest().readUIntBE(0, 6);
}
// Deterministic by date: each run of n days walks a seeded shuffle of the
// list, so nothing repeats until everything has had its turn.
function dailyIndex(date, salt, n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('nothing to pick from');
  const day = dayNumber(date);
  const cycle = Math.floor(day / n);
  const order = Array.from({ length: n }, (_, i) => [hashInt(`${salt}:${cycle}:${i}`), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return order[((day % n) + n) % n][1];
}

function parseMapLink(map) {
  const m = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z/.exec(String(map || ''));
  return m ? { lat: +m[1], lon: +m[2], zoom: +m[3] } : {};
}
function pickEarthView(list, date) {
  const usable = (Array.isArray(list) ? list : []).filter(e => e && /^https:\/\//.test(e.image || ''));
  if (!usable.length) throw new Error('Earth View list is empty');
  const id = e => Number((/(\d+)\.jpg/.exec(e.image) || [])[1]) || 0;
  usable.sort((a, b) => id(a) - id(b) || String(a.image).localeCompare(String(b.image)));
  const entry = usable[dailyIndex(date, 'earthview', usable.length)];
  const region = String(entry.region || '').trim(), country = String(entry.country || '').trim();
  return { id: id(entry), region, country, place: [region, country].filter(Boolean).join(', ') || 'Somewhere on Earth', ...parseMapLink(entry.map), mapUrl: entry.map || null, source: entry.image };
}

function inkFor([r, g, b]) {
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#111111' : '#ffffff';
}
function pickColours(colors, date) {
  const byCombo = new Map();
  for (const c of Array.isArray(colors) ? colors : []) for (const id of c.combinations || []) {
    if (!byCombo.has(id)) byCombo.set(id, []);
    byCombo.get(id).push(c);
  }
  const ids = [...byCombo.keys()].filter(id => byCombo.get(id).length >= 2 && byCombo.get(id).length <= 4).sort((a, b) => a - b);
  if (!ids.length) throw new Error('colour dictionary is empty');
  const number = ids[dailyIndex(date, 'wada', ids.length)];
  const colours = byCombo.get(number).map(c => ({ name: c.name, hex: c.hex, rgb: c.rgb, cmyk: c.cmyk, ink: inkFor(c.rgb || [0, 0, 0]) }));
  return { number, size: colours.length, colours };
}

// ------------------------------------------------------------------ text helpers

function plain(text) { return String(text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
function shorten(text, max = 300) {
  const clean = plain(text);
  if (clean.length <= max) return clean;
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*(?=\s|$)/g) || [];
  let out = '';
  for (const s of sentences) { if ((out + s).length > max) break; out += s; }
  out = out.trim();
  return out || clean.slice(0, max).replace(/\s+\S*$/, '') + '…';
}
function stripPictured(text) {
  return plain(text).replace(/\s*\((?:[^()]*\s)?pictured\)/gi, '').replace(/\s+([,.;:])/g, '$1');
}

const GRIM = /\b(kill(?:ed|ing|s)?|dead|deaths|died|murder(?:ed|s)?|massacres?d?|shooting|shot|bomb(?:ed|ing|ings|s)?|genocide|executed|execution|stampede|suicide|terror(?:ist|ism)?|crash(?:ed|es)?|disaster|injur(?:ed|ies|ing)|casualties|wounded|hijack(?:ed|ing)?)\b/i;
const EVENTISH = /\b(event|battle|siege|war|treaty|case|match|protest|gathering|disaster|shooting|collision|attack|election|eruption|earthquake|mission|launch|coup|uprising|revolt|rebellion|riot|massacre|movement|expedition|proclamation|declaration|convention|referendum|strike|summit|landing|flight|premiere|festival)\b/i;
const PERSON = /\((?:born\s+)?c?\.?\s*\d{3,4}\s*[–-]\s*\d{0,4}\s*\)|\(born\b/i;

// Wikipedia does not mark the bold article in the feed; score the linked pages.
function mainPage(event) {
  const year = String(Math.abs(Number(event.year) || 0));
  const text = String(event.text || '').toLowerCase();
  let best = null, bestScore = -Infinity;
  (event.pages || []).forEach((page, i) => {
    const title = page.titles?.normalized || String(page.title || '').replace(/_/g, ' ');
    const description = String(page.description || '');
    const bare = title.replace(/\s*\([^)]*\)\s*$/, '').toLowerCase();
    let score = -i * 0.1;
    if (new RegExp(`^${year}(?!\\d)`).test(description)) score += 4;
    else if (description.includes(year)) score += 1;
    if (title.includes(year)) score += 2;
    if (EVENTISH.test(description)) score += 3;
    if (PERSON.test(description)) score -= 1;
    const short = bare.split(',')[0].trim();
    const at = bare && text.includes(bare) ? text.indexOf(bare) : short.length >= 4 ? text.indexOf(short) : -1;
    if (at >= 0) score += at < text.length / 3 ? 1.5 : 1;
    if (bare && text.startsWith(bare + ':')) score -= 3;
    if (score > bestScore) { best = { title, link: page.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page.title || title).replace(/ /g, '_'))}` }; bestScore = score; }
  });
  return best;
}
function century(year) { return year > 0 ? Math.ceil(year / 100) : -Math.ceil(-year / 100); }
function yearLabel(year) { return year < 0 ? `${-year} BC` : String(year); }
function pickOnThisDay(events, date, count = 3) {
  const all = (Array.isArray(events) ? events : [])
    .filter(e => Number.isInteger(e?.year) && e.text)
    .map(e => ({ year: e.year, text: stripPictured(e.text), source: e }));
  if (!all.length) throw new Error('no on-this-day events');
  let pool = all.filter(e => e.text.length >= 25 && e.text.length <= 170);
  if (pool.length < count) pool = all;
  const calm = pool.filter(e => !GRIM.test(e.text));
  if (calm.length >= count) pool = calm;
  const groups = new Map();
  for (const e of pool) { const c = century(e.year); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(e); }
  const centuries = [...groups.keys()].sort((a, b) => a - b);
  const chosenCenturies = centuries.length <= count ? centuries
    : [...new Set(Array.from({ length: count }, (_, i) => centuries[Math.round(i * (centuries.length - 1) / (count - 1))]))];
  const picked = [];
  for (const c of chosenCenturies) {
    const group = groups.get(c);
    picked.push(group[hashInt(`${date}:otd:${c}`) % group.length]);
  }
  const rest = pool.filter(e => !picked.includes(e)).sort((a, b) => hashInt(`${date}:${a.year}:${a.text}`) - hashInt(`${date}:${b.year}:${b.text}`));
  while (picked.length < count && rest.length) picked.push(rest.shift());
  return picked.sort((a, b) => a.year - b.year).map(e => {
    const page = mainPage(e.source);
    return { year: e.year, yearLabel: yearLabel(e.year), text: e.text, title: page?.title || null, link: page?.link || null };
  });
}

function pickPoem(poems, date) {
  const usable = (Array.isArray(poems) ? poems : []).filter(p => {
    const lines = Array.isArray(p?.lines) ? p.lines : [];
    const filled = lines.filter(l => l.trim()).length;
    return p.title && p.author && filled >= 4 && filled <= 16 && lines.length <= 20
      && lines.every(l => l.length <= 72 && !/[a-z]-$/i.test(l.trim())) && String(p.title).length <= 90;
  }).sort((a, b) => `${a.author}\u0000${a.title}`.localeCompare(`${b.author}\u0000${b.title}`));
  if (!usable.length) return null;
  const p = usable[hashInt(`${date}:poem`) % usable.length];
  const lines = p.lines.map(l => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return { title: plain(p.title), author: plain(p.author), lines, lineCount: lines.filter(l => l.trim()).length };
}

// ------------------------------------------------------------------ weather

const WMO = {
  0: ['Clear sky', 'clear'], 1: ['Mainly clear', 'clear'], 2: ['Partly cloudy', 'cloud'], 3: ['Overcast', 'cloud'],
  45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'drizzle'], 53: ['Drizzle', 'drizzle'], 55: ['Heavy drizzle', 'drizzle'],
  56: ['Light freezing drizzle', 'drizzle'], 57: ['Freezing drizzle', 'drizzle'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
  66: ['Light freezing rain', 'rain'], 67: ['Freezing rain', 'rain'],
  71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
  80: ['Light showers', 'showers'], 81: ['Showers', 'showers'], 82: ['Heavy showers', 'showers'],
  85: ['Light snow showers', 'snow'], 86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'thunder'], 96: ['Thunderstorm with hail', 'thunder'], 99: ['Thunderstorm with heavy hail', 'thunder'],
};
function weather(code) {
  const n = code === null || code === undefined || code === '' ? NaN : Number(code);
  const [label, kind] = Number.isInteger(n) && Object.hasOwn(WMO, n) ? WMO[n] : ['Unknown', 'unknown'];
  return { code: Number.isFinite(n) ? n : null, label, kind };
}
function wmoLabel(code) { return weather(code).label; }

function clock(localIso) { const m = /T(\d{2}:\d{2})/.exec(String(localIso || '')); return m ? m[1] : null; }
function minutesBetween(a, b) {
  const t = s => { const m = /T(\d{2}):(\d{2})/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
  const x = t(a), y = t(b);
  return x == null || y == null ? null : y - x;
}
function buildSky(json) {
  const c = json?.current, d = json?.daily || {}, h = json?.hourly || {};
  if (!c || !Array.isArray(d.time)) throw new Error('Open-Meteo returned no forecast');
  const r = v => (typeof v === 'number' ? Math.round(v) : null);
  const day = i => {
    if (!d.time[i]) return null;
    const daylight = minutesBetween(d.sunrise?.[i], d.sunset?.[i]);
    return {
      date: d.time[i], high: r(d.temperature_2m_max?.[i]), low: r(d.temperature_2m_min?.[i]), ...weather(d.weather_code?.[i]),
      rainChance: d.precipitation_probability_max?.[i] ?? null, sunrise: clock(d.sunrise?.[i]), sunset: clock(d.sunset?.[i]),
      daylight: daylight == null ? null : `${Math.floor(daylight / 60)}h ${String(daylight % 60).padStart(2, '0')}m`,
    };
  };
  const times = Array.isArray(h.time) ? h.time : [];
  let start = times.findIndex(t => t.slice(0, 13) === String(c.time || '').slice(0, 13));
  if (start < 0) start = 0;
  const hours = times.slice(start, start + 12).map((t, j) => {
    const i = start + j;
    return { time: clock(t), temp: r(h.temperature_2m?.[i]), ...weather(h.weather_code?.[i]), cloud: h.cloud_cover?.[i] ?? null, rainChance: h.precipitation_probability?.[i] ?? null };
  });
  const now = {
    time: c.time, temp: c.temperature_2m ?? null, feelsLike: c.apparent_temperature ?? null, ...weather(c.weather_code),
    cloud: c.cloud_cover ?? null, isDay: c.is_day === 1, windKmh: c.wind_speed_10m ?? null, precipitationMm: c.precipitation ?? null,
  };
  const today = day(0), tomorrow = day(1);
  const feels = r(now.feelsLike), temp = r(now.temp);
  let summary = `${now.label}, ${temp}°C`;
  if (feels != null && temp != null && Math.abs(feels - temp) >= 2) summary += ` (feels like ${feels}°C)`;
  if (today) summary += `. High ${today.high}°, low ${today.low}°`;
  return { place: PLACE.name, summary: summary + '.', now, today, tomorrow, hours, credit: 'Weather data by Open-Meteo.com (CC BY 4.0)', source: 'https://open-meteo.com/' };
}

// ------------------------------------------------------------------ moon (Meeus, Astronomical Algorithms ch. 47-49)

const RAD = Math.PI / 180;
const SYNODIC = 29.530588861;
const DELTA_T_DAYS = 69 / 86400; // TT - UT, close enough for the 2020s
const PLANETARY = [[251.88, 0.016321, 0.000165], [251.83, 26.651886, 0.000164], [349.42, 36.412478, 0.000126], [84.66, 18.206239, 0.000110],
  [141.74, 53.303771, 0.000062], [207.14, 2.453732, 0.000060], [154.84, 7.306860, 0.000056], [34.52, 27.261239, 0.000047],
  [207.19, 0.121824, 0.000042], [291.34, 1.844379, 0.000040], [161.72, 24.198154, 0.000037], [239.56, 25.513099, 0.000035], [331.55, 3.592518, 0.000023]];
const jdOf = d => d.getTime() / 86400000 + 2440587.5;
const dateOfJd = jd => new Date(Math.round((jd - 2440587.5) * 86400000));

function truePhase(lunation, phase) {
  const k = lunation + phase;
  const T = k / 1236.85, T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.000000150 * T3 + 0.00000000073 * T4;
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const M = (2.5534 + 29.10535670 * k - 0.0000014 * T2 - 0.00000011 * T3) * RAD;
  const Mp = (201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4) * RAD;
  const F = (160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4) * RAD;
  const O = (124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3) * RAD;
  const s = Math.sin, cos = Math.cos;
  let c;
  if (phase === 0 || phase === 0.5) {
    const full = phase === 0.5;
    c = (full ? -0.40614 : -0.40720) * s(Mp) + (full ? 0.17302 : 0.17241) * E * s(M) + (full ? 0.01614 : 0.01608) * s(2 * Mp)
      + (full ? 0.01043 : 0.01039) * s(2 * F) + (full ? 0.00734 : 0.00739) * E * s(Mp - M) - (full ? 0.00515 : 0.00514) * E * s(Mp + M)
      + (full ? 0.00209 : 0.00208) * E * E * s(2 * M) - 0.00111 * s(Mp - 2 * F) - 0.00057 * s(Mp + 2 * F) + 0.00056 * E * s(2 * Mp + M)
      - 0.00042 * s(3 * Mp) + 0.00042 * E * s(M + 2 * F) + 0.00038 * E * s(M - 2 * F) - 0.00024 * E * s(2 * Mp - M) - 0.00017 * s(O)
      - 0.00007 * s(Mp + 2 * M) + 0.00004 * s(2 * Mp - 2 * F) + 0.00004 * s(3 * M) + 0.00003 * s(Mp + M - 2 * F) + 0.00003 * s(2 * Mp + 2 * F)
      - 0.00003 * s(Mp + M + 2 * F) + 0.00003 * s(Mp - M + 2 * F) - 0.00002 * s(Mp - M - 2 * F) - 0.00002 * s(3 * Mp + M) + 0.00002 * s(4 * Mp);
  } else {
    c = -0.62801 * s(Mp) + 0.17172 * E * s(M) - 0.01183 * E * s(Mp + M) + 0.00862 * s(2 * Mp) + 0.00804 * s(2 * F) + 0.00454 * E * s(Mp - M)
      + 0.00204 * E * E * s(2 * M) - 0.00180 * s(Mp - 2 * F) - 0.00070 * s(Mp + 2 * F) - 0.00040 * s(3 * Mp) - 0.00034 * E * s(2 * Mp - M)
      + 0.00032 * E * s(M + 2 * F) + 0.00032 * E * s(M - 2 * F) - 0.00028 * E * E * s(Mp + 2 * M) + 0.00027 * E * s(2 * Mp + M) - 0.00017 * s(O)
      - 0.00005 * s(Mp - M - 2 * F) + 0.00004 * s(2 * Mp + 2 * F) - 0.00004 * s(Mp + M + 2 * F) + 0.00004 * s(Mp - 2 * M) + 0.00003 * s(Mp + M - 2 * F)
      + 0.00003 * s(3 * M) + 0.00002 * s(2 * Mp - 2 * F) + 0.00002 * s(Mp - M + 2 * F) - 0.00002 * s(3 * Mp + M);
    const W = 0.00306 - 0.00038 * E * cos(M) + 0.00026 * cos(Mp) - 0.00002 * cos(Mp - M) + 0.00002 * cos(Mp + M) + 0.00002 * cos(2 * F);
    c += phase === 0.25 ? W : -W;
  }
  let extra = 0.000325 * s((299.77 + 0.107408 * k - 0.009173 * T2) * RAD);
  for (const [a, b, coef] of PLANETARY) extra += coef * s((a + b * k) * RAD);
  return dateOfJd(jde + c + extra - DELTA_T_DAYS);
}

const PHASES = [[0, 'new', 'New moon'], [0.25, 'firstQuarter', 'First quarter'], [0.5, 'full', 'Full moon'], [0.75, 'lastQuarter', 'Last quarter']];
function moonEvents(at) {
  const k0 = Math.floor((jdOf(at) - 2451550.09766) / SYNODIC);
  const events = [];
  for (let k = k0 - 2; k <= k0 + 2; k++) for (const [phase, type, name] of PHASES) events.push({ type, name, at: truePhase(k, phase) });
  return events.sort((a, b) => a.at - b.at);
}
function illumination(at) {
  const T = (jdOf(at) + DELTA_T_DAYS - 2451545) / 36525;
  const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + T ** 3 / 545868 - T ** 4 / 113065000;
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + T ** 3 / 24490000;
  const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + T ** 3 / 69699 - T ** 4 / 14712000;
  const sd = x => Math.sin(x * RAD);
  const i = 180 - D - 6.289 * sd(Mp) + 2.100 * sd(M) - 1.274 * sd(2 * D - Mp) - 0.658 * sd(2 * D) - 0.214 * sd(2 * Mp) - 0.110 * sd(D);
  return (1 + Math.cos(i * RAD)) / 2;
}
function moonPhase(at = new Date()) {
  const events = moonEvents(at);
  const before = events.filter(e => e.at <= at), after = events.filter(e => e.at > at);
  const last = before[before.length - 1];
  const prevNew = [...before].reverse().find(e => e.type === 'new');
  const nextOf = type => { const e = after.find(x => x.type === type); return { date: londonDate(e.at), at: e.at.toISOString(), inDays: Math.round((e.at - at) / 864e5 * 10) / 10 }; };
  const today = londonDate(at);
  const event = events.find(e => londonDate(e.at) === today);
  const between = { new: 'Waxing crescent', firstQuarter: 'Waxing gibbous', full: 'Waning gibbous', lastQuarter: 'Waning crescent' };
  return {
    phase: event ? event.name : between[last.type],
    illumination: Math.round(illumination(at) * 100),
    age: Math.round((at - prevNew.at) / 864e5 * 10) / 10,
    waxing: last.type === 'new' || last.type === 'firstQuarter',
    nextFull: nextOf('full'),
    nextNew: nextOf('new'),
    computedAt: at.toISOString(),
    credit: 'Computed locally (Meeus, Astronomical Algorithms)',
  };
}

// ------------------------------------------------------------------ typeface of the day
// Every family and weight set below returned 200 from fonts.googleapis.com/css2 on 2026-10-01.

const TYPEFACES = [
  ['Instrument Serif', 'serif', '400', 'Rodrigo Fuenzalida, Jordan Egstad', 'Condensed editorial serif for big, tight headlines.'],
  ['Fraunces', 'serif', '100..900', 'Undercase Type', 'Soft, wonky old-style display serif; warm headlines with personality.'],
  ['Newsreader', 'serif', '200..800', 'Production Type', 'Screen-first text serif with optical sizes for long-form reading.'],
  ['Young Serif', 'serif', '400', 'Bastien Sozeau', 'Heavy old-style serif for punchy, bookish titles.'],
  ['Gloock', 'serif', '400', 'Duarte Pinto', 'High-contrast display serif for sharp, elegant headlines.'],
  ['Libre Caslon Text', 'serif', '400;700', 'Pablo Impallari', 'Caslon tuned for screens; classic, trustworthy body copy.'],
  ['Cormorant', 'serif', '300..700', 'Christian Thalmann', 'Display Garamond with dramatic contrast for luxe editorial titles.'],
  ['EB Garamond', 'serif', '400..800', 'Georg Duffner', 'Faithful Garamond revival for literary body text.'],
  ['Playfair Display', 'serif', '400..900', 'Claus Eggers Sørensen', 'Transitional high-contrast serif for magazine headlines.'],
  ['IBM Plex Serif', 'serif', '100;200;300;400;500;600;700', 'Mike Abbink, Bold Monday', 'Engineered serif that pairs cleanly with Plex Sans and Mono.'],
  ['Bodoni Moda', 'serif', '400..900', 'Owen Earl', 'Didone with optical sizes; fashion-grade contrast.'],
  ['Literata', 'serif', '200..900', 'TypeTogether', 'E-reader serif with optical sizes for comfortable long reads.'],
  ['Source Serif 4', 'serif', '200..900', 'Frank Grießhammer', 'Workhorse text serif with optical sizes for UI and documents.'],
  ['Crimson Pro', 'serif', '200..900', 'Jacques Le Bailly', 'Book serif with a calm rhythm for essays and reports.'],
  ['Spectral', 'serif', '200;300;400;500;600;700;800', 'Production Type', 'Elegant screen serif for refined long-form text.'],
  ['Zilla Slab', 'serif', '300;400;500;600;700', 'Typotheque', 'Friendly slab with contemporary flair for headings and UI.'],
  ['DM Serif Display', 'serif', '400', 'Colophon Foundry', 'Low-x-height display serif for compact, stylish titles.'],
  ['Besley', 'serif', '400..900', 'Owen Earl', 'Clarendon revival; sturdy, charming headlines.'],
  ['Alegreya', 'serif', '400..900', 'Huerta Tipográfica', 'Calligraphic text serif with a lively literary rhythm.'],
  ['Yeseva One', 'serif', '400', 'Jovanny Lemonad', 'Curvy high-contrast display serif for single words and logos.'],
  ['Kalnia', 'serif', '100..700', 'Frida Medrano', 'Flamboyant high-contrast display with swashy terminals.'],
  ['Abril Fatface', 'display', '400', 'TypeTogether', 'Ultra-bold Didone for poster-scale statements.'],
  ['Bricolage Grotesque', 'sans-serif', '200..800', 'Mathieu Triay', 'Characterful grotesque with optical sizes for friendly brand headlines.'],
  ['Inter Tight', 'sans-serif', '100..900', 'Rasmus Andersson', 'Tightly spaced Inter for display-sized UI and headings.'],
  ['Space Grotesk', 'sans-serif', '300..700', 'Florian Karsten', 'Quirky grotesk spun out of Space Mono; techy brand voice.'],
  ['Familjen Grotesk', 'sans-serif', '400..700', null, 'Swedish grotesk with idiosyncratic details for headlines.'],
  ['Hanken Grotesk', 'sans-serif', '100..900', null, 'Clean, geometric-leaning grotesk for neutral UI.'],
  ['Schibsted Grotesk', 'sans-serif', '400..900', 'Bakken & Bæck', 'Newsroom grotesk for robust headlines and dense layouts.'],
  ['Syne', 'sans-serif', '400..800', 'Bonjour Monde', 'Art-centre display sans that gets wilder as it gets bolder.'],
  ['Unbounded', 'display', '200..900', 'NaN', 'Wide, rounded display sans for loud, futuristic headlines.'],
  ['Big Shoulders', 'display', '100..900', 'Patric King', 'Condensed, Chicago-inspired display for signage and posters.'],
  ['Darker Grotesque', 'sans-serif', '300..900', null, 'Slim, high-waisted grotesque for stylish large type.'],
  ['Epilogue', 'sans-serif', '100..900', 'Etcetera Type Co', 'Grotesque with geometric bones; versatile from UI to headlines.'],
  ['Sora', 'sans-serif', '100..800', 'Jonathan Barnbrook, Julián Moncada', 'Wide, techy geometric sans for product and data UI.'],
  ['Manrope', 'sans-serif', '200..800', 'Mikhail Sharanda', 'Semi-condensed modern sans for clean interfaces.'],
  ['Onest', 'sans-serif', '100..900', null, 'Even, open grotesque for highly legible interfaces.'],
  ['Geologica', 'sans-serif', '100..900', 'Monokrom', 'Geometric sans with sharpness and cursive axes to play with.'],
  ['Gabarito', 'sans-serif', '400..900', null, 'Chunky geometric sans for bold, friendly headings.'],
  ['Figtree', 'sans-serif', '300..900', 'Erik Kennedy', 'Clean, friendly geometric sans for product UI.'],
  ['Archivo', 'sans-serif', '100..900', 'Omnibus-Type', 'Grotesque with a width axis, from condensed headlines to tables.'],
  ['Anybody', 'display', '100..900', 'Etcetera Type Co', 'Huge width range, ultra-condensed to ultra-expanded display.'],
  ['Chivo', 'sans-serif', '100..900', 'Omnibus-Type', 'Confident grotesque for strong headlines and UI.'],
  ['DM Sans', 'sans-serif', '100..1000', 'Colophon Foundry', 'Low-contrast geometric sans for small UI text.'],
  ['Plus Jakarta Sans', 'sans-serif', '200..800', 'Tokotype', 'Modern geometric sans for crisp brand and UI work.'],
  ['Instrument Sans', 'sans-serif', '400..700', null, 'Precise neo-grotesk companion to Instrument Serif.'],
  ['Funnel Display', 'display', '300..800', 'NORD ID', 'Display sans with a funnel-shaped quirk in its joins.'],
  ['Red Hat Display', 'sans-serif', '300..900', 'MCKL', 'Geometric-humanist display sans for confident headings.'],
  ['Atkinson Hyperlegible', 'sans-serif', '400;700', 'Braille Institute', 'Letterforms drawn to stay distinct for low-vision readers.'],
  ['Mona Sans', 'sans-serif', '200..900', 'GitHub, Degarism Studio', 'Strong, versatile grotesk with a wide width range.'],
  ['DM Mono', 'monospace', '300;400;500', 'Colophon Foundry', 'Soft, low-contrast mono for code snippets and labels.'],
  ['Spline Sans Mono', 'monospace', '300..700', 'Eben Sorkin, Mirko Velimirović', 'Grotesque-flavoured mono for UI labels and data.'],
  ['JetBrains Mono', 'monospace', '100..800', 'JetBrains', 'Tall x-height coding mono built for long sessions.'],
  ['Overpass Mono', 'monospace', '300..700', 'Delve Fonts', 'Highway-sign-inspired mono for technical labels.'],
  ['IBM Plex Mono', 'monospace', '100;200;300;400;500;600;700', 'Mike Abbink, Bold Monday', 'Characterful mono for code, captions and data.'],
  ['Space Mono', 'monospace', '400;700', 'Colophon Foundry', 'Retro-futurist mono for editorial and tech accents.'],
  ['Fragment Mono', 'monospace', '400', null, 'Helvetica-flavoured mono for neat, neutral code and labels.'],
  ['Martian Mono', 'monospace', '100..800', 'Evil Martians', 'Wide, robust mono for dev tools and dashboards.'],
  ['Geist Mono', 'monospace', '100..900', 'Vercel, Basement Studio', 'Clean, Swiss-leaning mono from the Geist family.'],
  ['Azeret Mono', 'monospace', '100..900', 'Displaay', 'Geometric mono with crisp shapes for data-heavy UI.'],
  ['Major Mono Display', 'display', '400', 'Emre Parlak', 'Geometric monospaced display with mixed-case quirks.'],
  ['Rubik Mono One', 'display', '400', 'Hubert & Fischer', 'Chunky, rounded mono display for loud labels.'],
  ['Bagel Fat One', 'display', '400', null, 'Puffy, ultra-bold display for playful headlines.'],
  ['Dela Gothic One', 'display', '400', 'artakana', 'Heavy gothic display with Japanese roots; poster punch.'],
  ['Climate Crisis', 'display', '400', 'Daniel Coull, Eino Korkala', 'Variable font that melts along a YEAR axis; data storytelling.'],
  ['Shrikhand', 'display', '400', 'Jonny Pinhorn', 'Bold, Gujarati-inspired italic display for joyful headlines.'],
  ['Bungee', 'display', '400', 'David Jonathan Ross', 'Urban vertical-signage display built for layered, chromatic type.'],
  ['Tilt Warp', 'display', '400', 'Andy Clymer', 'Display type that tilts in 3D; motion-friendly headlines.'],
  ['Silkscreen', 'display', '400;700', 'Jason Kottke', 'Crisp pixel font for small retro UI labels.'],
].map(([family, category, weights, designer, note]) => {
  const q = family.replace(/ /g, '+');
  const cssUrl = weights === '400' ? `https://fonts.googleapis.com/css2?family=${q}&display=swap` : `https://fonts.googleapis.com/css2?family=${q}:wght@${weights}&display=swap`;
  return { family, category, ...(designer ? { designer } : {}), weights, cssUrl, specimenUrl: `https://fonts.google.com/specimen/${q}`, note };
});
function pickTypeface(date, offset = 0) {
  return TYPEFACES[(dailyIndex(date, 'typeface', TYPEFACES.length) + offset) % TYPEFACES.length];
}

// ------------------------------------------------------------------ image route validation

function parseImageRequest(pathname, params) {
  const m = /^\/api\/almanac\/image\/([a-z]{1,16})$/.exec(String(pathname || ''));
  if (!m || !IMAGE_KEYS.has(m[1])) return null;
  const d = params && typeof params.get === 'function' ? params.get('d') : null;
  if (d !== null && d !== undefined && !isIsoDate(d)) return null;
  return { key: m[1], date: d || null };
}

// ------------------------------------------------------------------ the almanac

function createAlmanac({ dir = path.join(CACHE_DIR, 'almanac'), fetch = fetchRaw, now = () => new Date(), log = (...args) => console.error(...args) } = {}) {
  const imgDir = path.join(dir, 'img');
  const dataDir = path.join(dir, 'data');
  let current = null; // { date, generatedAt, items, meta }
  let lastGood = null; // newest good value per item, across days
  let inflight = null;
  let prunedFor = null;

  const fetchJson = async url => JSON.parse((await fetch(url, { accept: 'application/json' })).body.toString('utf8'));

  async function writeAtomic(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  }

  // Source lists rarely change; keep a copy and only re-download weekly.
  async function dataset(name, url) {
    const file = path.join(dataDir, `${name}.json`);
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && now() - stat.mtimeMs < DATASET_TTL_MS) {
      try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { /* re-download */ }
    }
    try {
      const json = await fetchJson(url);
      await writeAtomic(file, JSON.stringify(json));
      return json;
    } catch (error) {
      if (stat) return JSON.parse(await fsp.readFile(file, 'utf8'));
      throw error;
    }
  }

  async function saveImage(date, key, url) {
    const res = await fetch(url, { accept: 'image/jpeg,image/png;q=0.9,image/webp;q=0.8,image/*;q=0.5', maxBytes: 25 * 1024 * 1024 });
    const info = sniffImage(res.body);
    if (!info) throw new Error(`not an image (${new URL(url).host})`);
    const base = `${date}-${key}`;
    await writeAtomic(path.join(imgDir, `${base}.${info.ext}`), res.body);
    for (const ext of Object.keys(MIME)) if (ext !== info.ext) await fsp.rm(path.join(imgDir, `${base}.${ext}`), { force: true });
    return { url: `/api/almanac/image/${key}?d=${date}`, type: MIME[info.ext], width: info.width || null, height: info.height || null, bytes: res.body.length };
  }

  async function firstImage(date, key, urls) {
    let lastError = new Error('no image URL');
    for (const url of urls.filter(Boolean)) {
      try { return await saveImage(date, key, url); } catch (error) { lastError = error; }
    }
    throw lastError;
  }

  // Wikimedia only renders standard thumbnail widths (1600 is refused), so ask for the nearest.
  function wikimediaSizes(thumb, originalWidth) {
    if (!thumb) return [];
    const src = String(thumb).replace(/\?.*$/, '');
    const sized = w => (/\/\d+px-[^/]+$/.test(src) ? src.replace(/\/\d+px-([^/]+)$/, `/${w}px-$1`) : null);
    return [...[1920, 1280].filter(w => !originalWidth || originalWidth >= w).map(sized), src];
  }

  const sources = {
    async earthView(ctx) {
      const pick = pickEarthView(await dataset('earthview', URLS.earthView), ctx.date);
      const image = await saveImage(ctx.date, 'earthview', pick.source);
      const { source, ...rest } = pick;
      return { ...rest, image, credit: 'Google Earth View · imagery © Google and its data providers', source: 'https://github.com/limhenry/earthview' };
    },
    async colours(ctx) {
      return { ...pickColours(await dataset('wada-colours', URLS.colours), ctx.date), credit: 'Sanzo Wada, A Dictionary of Color Combinations · data by Matt DesLauriers', source: 'https://github.com/mattdesl/dictionary-of-colour-combinations' };
    },
    async picture(ctx) {
      const img = (await ctx.feed()).image;
      if (!img?.thumbnail?.source && !img?.image?.source) throw new Error('no picture of the day in the feed');
      const image = await firstImage(ctx.date, 'picture', wikimediaSizes(img.thumbnail?.source, img.image?.width));
      const fileTitle = String(img.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
      const description = shorten(img.description?.text || img.description?.html, 420);
      const artist = plain(img.artist?.text || img.artist?.html) || null;
      const license = img.license ? { name: img.license.type || img.license.code || null, url: img.license.url || null } : null;
      return {
        title: plain(img.structured?.captions?.en) || shorten(description, 90) || fileTitle,
        description, artist, credit: plain(img.credit?.text || img.credit?.html) || null, license,
        attribution: [artist, license?.name, 'via Wikimedia Commons'].filter(Boolean).join(', '),
        filePage: img.file_page || null, image, original: img.image ? { url: img.image.source, width: img.image.width, height: img.image.height } : null,
      };
    },
    async onThisDay(ctx) {
      const [, month, day] = ctx.date.split('-').map(Number);
      const monthName = new Date(Date.UTC(2000, month - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
      return {
        events: pickOnThisDay((await ctx.feed()).onthisday, ctx.date),
        credit: 'Wikipedia, CC BY-SA 4.0',
        source: `https://en.wikipedia.org/wiki/Wikipedia:Selected_anniversaries/${monthName}_${day}`,
      };
    },
    async article(ctx) {
      const tfa = (await ctx.feed()).tfa;
      if (!tfa) throw new Error('no featured article in the feed');
      let image = null;
      if (tfa.thumbnail?.source) {
        try { image = await saveImage(ctx.date, 'article', tfa.thumbnail.source.replace(/\?.*$/, '')); }
        catch (error) { log(`almanac article image: ${error.message}`); }
      }
      const title = tfa.titles?.normalized || plain(tfa.displaytitle) || String(tfa.title || '').replace(/_/g, ' ');
      return {
        title, description: tfa.description || null, extract: shorten(tfa.extract, 320),
        link: tfa.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(String(tfa.title || title).replace(/ /g, '_'))}`,
        image, credit: image ? 'Wikipedia, CC BY-SA 4.0 · image via Wikimedia' : 'Wikipedia, CC BY-SA 4.0',
      };
    },
    async sky() { return buildSky(await fetchJson(URLS.sky)); },
    async earth(ctx) {
      const frames = (await fetchJson(URLS.epic)).filter(f => f?.image && f?.date && Number.isFinite(f?.centroid_coordinates?.lon));
      if (!frames.length) throw new Error('EPIC returned no frames');
      const gap = f => Math.abs(((f.centroid_coordinates.lon - PLACE.lon + 540) % 360) - 180);
      const frame = frames.reduce((best, f) => (gap(f) < gap(best) ? f : best));
      const day = frame.date.slice(0, 10);
      if (!isIsoDate(day) || !/^[\w-]+$/.test(frame.image)) throw new Error('unexpected EPIC frame');
      const image = await saveImage(ctx.date, 'earth', URLS.epicImage(day, frame.image));
      const p = frame.dscovr_j2000_position;
      return {
        takenAt: frame.date.replace(' ', 'T') + 'Z', caption: frame.caption || null,
        centroid: { lat: frame.centroid_coordinates.lat, lon: frame.centroid_coordinates.lon },
        distanceKm: p ? Math.round(Math.hypot(p.x, p.y, p.z) / 1000) * 1000 : null,
        image, credit: 'NASA EPIC Team · NOAA DSCOVR', source: 'https://epic.gsfc.nasa.gov/',
      };
    },
    async poem(ctx) {
      const first = 4 + dailyIndex(ctx.date, 'poem-lines', 13);
      let lastError = null;
      for (let step = 0; step < 4; step++) {
        const n = 4 + ((first - 4 + step * 5) % 13);
        try {
          const list = await fetchJson(URLS.poems(n));
          const poem = pickPoem(list, ctx.date);
          if (poem) return { ...poem, credit: `${poem.author} · public domain, via PoetryDB`, source: 'https://poetrydb.org/' };
        } catch (error) { lastError = error; }
      }
      throw lastError || new Error('no short poem found');
    },
    async typeface(ctx) {
      for (let offset = 0; offset < 5; offset++) {
        const face = pickTypeface(ctx.date, offset);
        try { await fetch(face.cssUrl, { accept: 'text/css', maxBytes: 512 * 1024 }); return { ...face, credit: 'Google Fonts' }; }
        catch (error) {
          if (!/^HTTP 4\d\d/.test(error.message)) return { ...face, verified: false, credit: 'Google Fonts' };
          log(`almanac typeface ${face.family}: ${error.message}`);
        }
      }
      throw new Error('Google Fonts refused five families in a row');
    },
  };
  const SOURCE_KEYS = Object.keys(sources);

  function context(date) {
    let feed;
    return {
      date,
      feed: () => (feed ||= fetchJson(URLS.feed(date)).catch(error => {
        log(`almanac feed: ${error.message}; trying the Wikipedia REST mirror`);
        return fetchJson(URLS.feedFallback(date));
      })),
    };
  }

  async function readDay(date) {
    try { return JSON.parse(await fsp.readFile(path.join(dir, `${date}.json`), 'utf8')); } catch { return null; }
  }

  async function loadHistory() {
    lastGood = {};
    const files = (await fsp.readdir(dir).catch(() => [])).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
    const staleOnly = {};
    for (const f of files) {
      const day = await readDay(f.slice(0, 10));
      for (const [key, item] of Object.entries(day?.items || {})) {
        if (!item || item.error || key === 'moon') continue;
        if (!item.stale && !lastGood[key]) lastGood[key] = item;
        else if (item.stale && !staleOnly[key]) staleOnly[key] = item;
      }
    }
    for (const [key, item] of Object.entries(staleOnly)) if (!lastGood[key]) lastGood[key] = item;
  }

  function isDue(key, day, t) {
    const item = day.items[key], meta = day.meta[key] || {};
    if (!item) return true;
    if (item.error || item.stale) return !meta.failedAt || t - Date.parse(meta.failedAt) >= RETRY_MS;
    if (key === 'sky') return !meta.fetchedAt || t - Date.parse(meta.fetchedAt) >= SKY_TTL_MS;
    return false;
  }

  function present(day, t) {
    const items = {};
    for (const key of ITEM_ORDER) {
      if (key === 'moon') {
        try { items.moon = moonPhase(t); } catch (error) { items.moon = { error: error.message }; }
      } else items[key] = day.items[key] || { error: 'not fetched yet' };
    }
    return { date: day.date, generatedAt: day.generatedAt, items };
  }

  async function prune(today) {
    if (prunedFor === today) return;
    prunedFor = today;
    const cutoff = shiftDate(today, -(KEEP_DAYS - 1));
    for (const [folder, pattern] of [[dir, /^(\d{4}-\d{2}-\d{2})\.json$/], [imgDir, /^(\d{4}-\d{2}-\d{2})-[a-z]+\.[a-z]+$/]]) {
      for (const f of await fsp.readdir(folder).catch(() => [])) {
        const m = pattern.exec(f);
        if ((m && m[1] < cutoff) || f.endsWith('.tmp')) await fsp.rm(path.join(folder, f), { force: true }).catch(() => {});
      }
    }
  }

  async function refresh(force) {
    const t = now();
    const date = londonDate(t);
    if (!lastGood) await loadHistory();
    if (!current || current.date !== date) {
      const saved = await readDay(date);
      current = { date, generatedAt: saved?.generatedAt || null, items: {}, meta: saved?.meta || {} };
      for (const key of SOURCE_KEYS) if (saved?.items?.[key]) current.items[key] = saved.items[key];
    }
    if (!jobsEnabled()) {
      for (const key of SOURCE_KEYS) if (!current.items[key] && lastGood[key]) current.items[key] = { ...lastGood[key], stale: true };
      return current;
    }
    const keys = SOURCE_KEYS.filter(key => force || isDue(key, current, t));
    if (!keys.length) return current;
    const ctx = context(date);
    const results = await Promise.allSettled(keys.map(key => sources[key](ctx)));
    const stamp = now().toISOString();
    keys.forEach((key, i) => {
      const result = results[i];
      if (result.status === 'fulfilled') {
        const item = { ...result.value, fetchedAt: stamp };
        current.items[key] = item;
        current.meta[key] = { fetchedAt: stamp };
        lastGood[key] = item;
        return;
      }
      const message = String(result.reason?.message || result.reason || 'failed');
      log(`almanac ${key}: ${message}`);
      const previous = current.items[key] && !current.items[key].error ? current.items[key] : lastGood[key];
      current.items[key] = previous ? { ...previous, stale: true, staleReason: message } : { error: message };
      current.meta[key] = { ...current.meta[key], failedAt: stamp, error: message };
    });
    current.generatedAt = stamp;
    try {
      await writeAtomic(path.join(dir, `${date}.json`), JSON.stringify({ ...present(current, t), meta: current.meta }, null, 1) + '\n');
      await prune(date);
    } catch (error) { log(`almanac persist: ${error.message}`); }
    return current;
  }

  async function getAlmanac({ force = false } = {}) {
    if (!inflight) inflight = refresh(force).finally(() => { inflight = null; });
    let day;
    try { day = await inflight; }
    catch (error) {
      log(`almanac: ${error.message}`);
      day = current || { date: londonDate(now()), generatedAt: null, items: {}, meta: {} };
    }
    return present(day, now());
  }

  async function findImage(ref) {
    const dates = [];
    if (ref.date) dates.push(ref.date);
    else {
      const u = current?.items?.[IMAGE_KEYS.get(ref.key)]?.image?.url;
      const d = u && new URL(u, 'http://x').searchParams.get('d');
      if (d && isIsoDate(d)) dates.push(d);
      dates.push(londonDate(now()));
    }
    for (const date of dates) for (const ext of Object.keys(MIME)) {
      const file = path.join(imgDir, `${date}-${ref.key}.${ext}`);
      if (path.dirname(file) !== imgDir) continue;
      if (await fsp.stat(file).then(s => s.isFile(), () => false)) return { file, ext };
    }
    if (ref.date) return null;
    const newest = (await fsp.readdir(imgDir).catch(() => []))
      .filter(f => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${ref.key}\\.(${Object.keys(MIME).join('|')})$`).test(f)).sort().pop();
    return newest ? { file: path.join(imgDir, newest), ext: newest.split('.').pop() } : null;
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }

  async function handle(req, res, url = new URL(req.url, 'http://x')) {
    const p = url.pathname;
    if (p !== '/api/almanac' && !p.startsWith('/api/almanac/')) return false;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' }); return true; }
      if (p === '/api/almanac') {
        const force = ['1', 'true'].includes(url.searchParams.get('force'));
        const body = JSON.stringify(await getAlmanac({ force }));
        send(res, 200, req.method === 'HEAD' ? undefined : body, { 'Content-Type': 'application/json; charset=utf-8' });
        return true;
      }
      const ref = parseImageRequest(p, url.searchParams);
      const found = ref && await findImage(ref);
      if (!found) { send(res, 404, 'no such almanac image', { 'Content-Type': 'text/plain' }); return true; }
      const bytes = await fsp.readFile(found.file);
      res.writeHead(200, { 'Content-Type': MIME[found.ext], 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      log(`almanac route: ${error.message}`);
      send(res, 500, JSON.stringify({ error: 'almanac unavailable' }), { 'Content-Type': 'application/json' });
    }
    return true;
  }

  // Optional: keep the cache warm so page loads never wait (weather every 30 min).
  function start(intervalMs = SKY_TTL_MS) {
    if (!jobsEnabled()) return () => {};
    const tick = () => { getAlmanac().catch(error => log(`almanac refresh: ${error.message}`)); };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { getAlmanac, handle, start };
}

const almanac = createAlmanac();

module.exports = {
  getAlmanac: almanac.getAlmanac,
  handle: almanac.handle,
  start: almanac.start,
  createAlmanac,
  // exposed for tests
  TYPEFACES, dailyIndex, londonDate, isIsoDate, pickEarthView, pickColours, pickOnThisDay, pickPoem, pickTypeface,
  weather, wmoLabel, buildSky, moonPhase, moonEvents, illumination, parseImageRequest, sniffImage, mainPage, fetchRaw,
};
