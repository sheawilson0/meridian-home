// Meridian widgets for Scriptable (iPhone), from Meridian's /api/widget.
//
// Home Screen, by size and Parameter:
//   small            the next meeting
//   small + "needs"  what needs you
//   small + "tell"   a red Tell button
//   medium           next meeting beside your to-dos
//   large            the day: next, what needs you, coming up, to-dos
// Lock Screen: rectangular, circular (how many need you) and inline.
// Needs Tailscale on, like Meridian. Shows the last copy if the Mac can't be reached.

const BASE = '__BASE__';
const C = {
  bg: new Color('#141415'), card: new Color('#1f1f22'), line: new Color('#ffffff', 0.08),
  ink: new Color('#f4f4f5'), body: new Color('#c3c3c8'), dim: new Color('#8e8e94'), dim2: new Color('#626268'),
  accent: new Color('#ff5247'), accentInk: new Color('#2b0503'), warn: new Color('#e2bd55'), good: new Color('#6cc39a'),
};
const serif = (s) => new Font('Georgia', s);
const serifItalic = (s) => new Font('Georgia-Italic', s);
const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), 'meridian-widget.json');

async function data() {
  try {
    const r = new Request(BASE + '/api/widget'); r.timeoutInterval = 8;
    const j = await r.loadJSON();
    if (j && j.at) { fm.writeString(cachePath, JSON.stringify(j)); return { ...j, fresh: true }; }
  } catch (e) { /* offline: the last copy */ }
  if (fm.fileExists(cachePath)) return { ...JSON.parse(fm.readString(cachePath)), fresh: false };
  return null;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const dayDiff = (ms) => { const a = new Date(ms); a.setHours(0, 0, 0, 0); const b = new Date(); b.setHours(0, 0, 0, 0); return Math.round((a - b) / 86400000); };
function dayWord(ms) { const n = dayDiff(ms); return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : DAYS[new Date(ms).getDay()] + ' ' + new Date(ms).getDate(); }
function soon(n) {
  if (!n) return '';
  const mins = Math.round((n.start - Date.now()) / 60000);
  if (mins <= 0) return 'On now';
  if (mins < 60) return `In ${mins} min`;
  if (mins < 180) return `In ${Math.floor(mins / 60)} h ${mins % 60 ? (mins % 60) + ' min' : ''}`.trim();
  return dayWord(n.start);
}
const plural = (n, one, many) => n === 1 ? one : many;

// --- small pieces
function text(stack, s, font, color, lines = 1) { const t = stack.addText(String(s)); t.font = font; t.textColor = color; t.lineLimit = lines; t.minimumScaleFactor = 0.85; return t; }
function dot(stack, color, size = 6) { const d = stack.addStack(); d.size = new Size(size, size); d.cornerRadius = size / 2; d.backgroundColor = color; return d; }
// The header every Home Screen widget shares: Meridian's red dot, a label, and what needs you on the right.
function header(w, label, d, { needs = true, compact = false } = {}) {
  const h = w.addStack(); h.centerAlignContent();
  dot(h, C.accent); h.addSpacer(6);
  text(h, label.toUpperCase(), Font.semiboldSystemFont(10.5), C.dim);
  h.addSpacer();
  if (needs && compact && d && d.needs.count) { dot(h, C.warn, 6); h.addSpacer(4); text(h, String(d.needs.count), Font.semiboldSystemFont(11), C.warn); }
  else if (needs && d && d.needs.count) {
    const b = h.addStack(); b.setPadding(2, 6, 2, 6); b.cornerRadius = 7; b.backgroundColor = new Color('#e2bd55', 0.16);
    text(b, `${d.needs.count} need${d.needs.count === 1 ? 's' : ''} you`, Font.semiboldSystemFont(10), C.warn);
  }
  return h;
}
// The day is already in the header, so this only says how soon when it's today.
function status(stack, n, size = 11.5) {
  const s = stack.addStack(); s.centerAlignContent();
  const today = dayDiff(n.start) === 0;
  if (n.notAccepted) { dot(s, C.warn, 5); s.addSpacer(5); text(s, today ? 'Not accepted · ' + soon(n).toLowerCase() : 'Not accepted', Font.mediumSystemFont(size), C.warn); }
  else if (today) text(s, soon(n), Font.mediumSystemFont(size), C.good);
  else if (n.end) text(s, `Until ${hm(n.end)}`, Font.systemFont(size), C.dim);
  return s;
}
function nextBlock(col, n, { time = 30, title = 14, lines = 2 } = {}) {
  if (!n) { text(col, 'Nothing booked', serifItalic(title + 2), C.ink, 2); text(col, 'this week', Font.systemFont(11.5), C.dim); return; }
  text(col, n.allDay ? 'All day' : hm(n.start), serif(time), C.ink);
  col.addSpacer(2);
  text(col, n.title, serifItalic(title), C.ink, lines);
  col.addSpacer(5);
  status(col, n);
}
function todoRow(col, t, size = 12.5) {
  const r = col.addStack(); r.centerAlignContent();
  const c = r.addStack(); c.size = new Size(11, 11); c.cornerRadius = 5.5; c.borderWidth = 1.2; c.borderColor = C.dim2;
  r.addSpacer(7);
  text(r, t, Font.systemFont(size), C.body, 1);
  return r;
}
function footer(w, d) {
  const f = w.addStack(); f.centerAlignContent();
  if (d.deadline) { const late = d.deadline.days <= 2; text(f, `${d.deadline.days === 0 ? 'Today' : d.deadline.days + 'd'}`, Font.semiboldSystemFont(11), late ? C.warn : C.dim); f.addSpacer(5); text(f, d.deadline.title.split(':')[0], Font.systemFont(11), late ? C.warn : C.dim, 1); }
  f.addSpacer();
  if (d.agents.working) { dot(f, C.good, 5); f.addSpacer(4); text(f, `${d.agents.working} working`, Font.systemFont(11), C.dim); }
  if (!d.fresh) { f.addSpacer(8); text(f, 'last copy', Font.systemFont(10), C.dim2); }
}

// --- the widgets
function small(w, d) {
  header(w, d.next ? dayWord(d.next.start) : 'Next', d, { compact: true });
  w.addSpacer();
  nextBlock(w, d.next, { time: 32, title: 14.5, lines: 2 });
  if (d.next && d.next.joinUrl && d.next.start - Date.now() < 15 * 60000) w.url = d.next.joinUrl;
}
function smallNeeds(w, d) {
  w.url = BASE + '/dashboard/phone#agents';
  header(w, 'Needs you', d, { needs: false });
  w.addSpacer();
  if (!d.needs.count) { text(w, 'Nothing', serifItalic(22), C.ink); text(w, 'needs you right now', Font.systemFont(12), C.dim, 2); return; }
  text(w, String(d.needs.count), serif(38), C.warn);
  w.addSpacer(2);
  text(w, d.needs.first.title, serifItalic(14), C.ink, 2);
  w.addSpacer(3);
  text(w, d.needs.first.why, Font.mediumSystemFont(11.5), C.dim);
}
function smallTell(w) {
  w.backgroundColor = C.accent; w.url = BASE + '/tell';
  const top = w.addStack(); top.centerAlignContent();
  text(top, 'MERIDIAN', Font.semiboldSystemFont(10.5), new Color('#2b0503', 0.6));
  top.addSpacer();
  const plus = top.addStack(); plus.size = new Size(30, 30); plus.cornerRadius = 15; plus.backgroundColor = new Color('#2b0503', 0.14); plus.centerAlignContent();
  const p = SFSymbol.named('plus'); p.applyFont(Font.boldSystemFont(15)); const img = plus.addImage(p.image); img.tintColor = C.accentInk; img.imageSize = new Size(15, 15);
  w.addSpacer();
  text(w, 'Tell', serifItalic(34), C.accentInk);
  text(w, 'Meridian', serifItalic(22), C.accentInk);
}
function medium(w, d) {
  const row = w.addStack(); row.topAlignContent();
  // Left: the next meeting.
  const left = row.addStack(); left.layoutVertically(); left.size = new Size(124, 0); left.url = d.next && d.next.joinUrl && d.next.start - Date.now() < 15 * 60000 ? d.next.joinUrl : BASE + '/dashboard/phone';
  const lh = left.addStack(); lh.centerAlignContent(); dot(lh, C.accent); lh.addSpacer(6); text(lh, (d.next ? dayWord(d.next.start) : 'Next').toUpperCase(), Font.semiboldSystemFont(10.5), C.dim);
  left.addSpacer();
  nextBlock(left, d.next, { time: 30, title: 14, lines: 2 });
  row.addSpacer(12);
  const rule = row.addStack(); rule.size = new Size(1, 126); rule.backgroundColor = C.line;
  row.addSpacer(12);
  // Right: what needs you, then to-dos.
  const right = row.addStack(); right.layoutVertically(); right.url = BASE + '/dashboard/phone';
  const rh = right.addStack(); rh.centerAlignContent();
  text(rh, `TO DO · ${d.todos.open}`, Font.semiboldSystemFont(10.5), C.dim); rh.addSpacer();
  if (d.needs.count) { dot(rh, C.warn, 5); rh.addSpacer(4); text(rh, `${d.needs.count}`, Font.semiboldSystemFont(10.5), C.warn); }
  right.addSpacer(8);
  for (const t of d.todos.top.slice(0, 4)) { todoRow(right, t); right.addSpacer(6); }
  if (!d.todos.top.length) text(right, 'Nothing on the list', serifItalic(14), C.body);
  right.addSpacer();
  if (d.deadline) { const late = d.deadline.days <= 2; const f = right.addStack(); f.centerAlignContent(); text(f, d.deadline.days === 0 ? 'Today' : d.deadline.days + 'd', Font.semiboldSystemFont(11), late ? C.warn : C.dim); f.addSpacer(5); text(f, d.deadline.title.split(':')[0], Font.systemFont(11), late ? C.warn : C.dim, 1); }
}
function large(w, d) {
  const now = new Date();
  header(w, `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()]} ${now.getDate()}`, d);
  w.addSpacer(10);
  const top = w.addStack(); top.topAlignContent();
  const nb = top.addStack(); nb.layoutVertically();
  text(nb, (d.next ? dayWord(d.next.start) : 'Next').toUpperCase(), Font.semiboldSystemFont(10), C.dim2);
  nb.addSpacer(2);
  nextBlock(nb, d.next, { time: 34, title: 16, lines: 2 });
  w.addSpacer(12);
  const needs = (d.needs.items || []).filter((n) => !(d.next && n.title === d.next.title));
  if (needs.length) {
    const box = w.addStack(); box.layoutVertically(); box.setPadding(9, 11, 9, 11); box.cornerRadius = 12; box.backgroundColor = new Color('#e2bd55', 0.09); box.url = BASE + '/dashboard/phone#agents';
    for (const n of needs.slice(0, 2)) { const r = box.addStack(); r.centerAlignContent(); dot(r, C.warn, 6); r.addSpacer(7); text(r, n.title, Font.mediumSystemFont(12.5), C.ink, 1); r.addSpacer(); text(r, n.why, Font.systemFont(11), C.warn); box.addSpacer(4); }
    w.addSpacer(12);
  }
  if (d.later && d.later.length) {
    text(w, 'COMING UP', Font.semiboldSystemFont(10), C.dim2); w.addSpacer(5);
    for (const e of d.later.slice(0, 3)) { const r = w.addStack(); r.centerAlignContent(); const t = r.addStack(); t.size = new Size(78, 0); const dd = dayDiff(e.start); text(t, `${dd === 0 ? 'Today' : dd === 1 ? 'Tmrw' : DAYS[new Date(e.start).getDay()]} ${hm(e.start)}`, Font.regularMonospacedSystemFont(11), C.dim); r.addSpacer(6); text(r, e.title, Font.systemFont(12.5), C.body, 1); w.addSpacer(4); }
    w.addSpacer(8);
  }
  text(w, `TO DO · ${d.todos.open}`, Font.semiboldSystemFont(10), C.dim2); w.addSpacer(6);
  for (const t of d.todos.top.slice(0, 3)) { todoRow(w, t); w.addSpacer(5); }
  w.addSpacer();
  footer(w, d);
}

// --- Lock Screen
function lock(w, d, fam) {
  if (!d) { text(w, 'Meridian offline', Font.systemFont(12), C.ink); return; }
  if (fam === 'accessoryCircular') {
    w.addAccessoryWidgetBackground = true;
    const s = w.addStack(); s.layoutVertically(); s.centerAlignContent();
    s.addSpacer();
    const n = text(s, d.needs.count ? String(d.needs.count) : '✓', Font.boldRoundedSystemFont(d.needs.count ? 24 : 20), C.ink); n.centerAlignText();
    const l = text(s, d.needs.count ? 'need you' : 'all clear', Font.mediumSystemFont(9), C.ink); l.centerAlignText();
    s.addSpacer();
    return;
  }
  if (fam === 'accessoryInline') { text(w, d.next ? `${hm(d.next.start)} ${d.next.title}` : 'Nothing booked', Font.systemFont(12), C.ink); return; }
  // Rectangular: three short lines, read at a glance.
  if (d.next) {
    const a = w.addStack(); a.centerAlignContent();
    text(a, d.next.allDay ? 'All day' : hm(d.next.start), Font.boldRoundedSystemFont(14), C.ink); a.addSpacer(5);
    text(a, d.next.title, Font.semiboldSystemFont(13), C.ink, 1);
    text(w, `${soon(d.next)}${d.next.notAccepted ? ' · not accepted' : ''}`, Font.systemFont(12), C.ink);
  } else text(w, 'Nothing booked', Font.semiboldSystemFont(13), C.ink);
  const bits = [];
  if (d.needs.count) bits.push(`${d.needs.count} need${d.needs.count === 1 ? 's' : ''} you`);
  if (d.agents.working) bits.push(`${d.agents.working} working`);
  if (!bits.length && d.deadline) bits.push(`${d.deadline.days}d · ${d.deadline.title.split(':')[0]}`);
  text(w, bits.join(' · ') || 'All clear', Font.systemFont(12), C.ink);
}

async function build() {
  const fam = config.widgetFamily || 'medium';
  const param = (args.widgetParameter || '').trim().toLowerCase();
  const w = new ListWidget();
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  w.url = BASE + '/dashboard/phone';
  if (param === 'tell' && !fam.startsWith('accessory')) { w.setPadding(14, 15, 14, 15); smallTell(w); return w; }
  const d = await data();
  if (fam.startsWith('accessory')) { w.setPadding(0, 0, 0, 0); lock(w, d, fam); return w; }
  w.backgroundColor = C.bg;
  w.setPadding(14, 15, 14, 15);
  if (!d) { header(w, 'Meridian', null); w.addSpacer(); text(w, 'Can’t reach the Home Mac. Is Tailscale on?', Font.systemFont(13), C.body, 3); return w; }
  if (fam === 'small') { if (param === 'needs') smallNeeds(w, d); else small(w, d); }
  else if (fam === 'large' || fam === 'extraLarge') large(w, d);
  else medium(w, d);
  return w;
}

const widget = await build();
if (config.runsInWidget || config.runsInAccessoryWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
