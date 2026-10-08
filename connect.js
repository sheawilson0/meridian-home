'use strict';

// The Connect page's list (2 Oct 2026): what Meridian reads, whether it is
// there, and what to do if not. Things it can find on its own show as
// connected; anything else gets a paste box (calendars) or an "Ask an agent
// to set this up" button, which posts the `prompt` here to /api/delegate.
//
// Cheap checks only (a readdir or a stat each, plus values the daemon already
// holds), cached for a minute. Never returns a secret: calendar feeds come in
// already masked (host + "…"), and the ntfy topic is never read out.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const CACHE_MS = 60 * 1000;

function agoText(ms, now = Date.now()) {
  if (!ms) return '';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const shortDate = (iso) => { const d = new Date(String(iso).length === 10 ? iso + 'T12:00:00' : iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };

// Newest modified time among a folder's entries (one level), and how many.
async function folderPulse(dir, { limit = 600 } = {}) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return null; }
  let newest = 0;
  const list = names.filter((n) => !n.startsWith('.')).slice(0, limit);
  await Promise.all(list.map(async (n) => {
    try { const st = await fsp.stat(path.join(dir, n)); if (st.mtimeMs > newest) newest = st.mtimeMs; } catch { /* gone */ }
  }));
  return { count: list.length, newest };
}

// Same, but a log appended to inside a folder doesn't touch the folder's own
// time, so look inside the 40 most recent folders too (about 150 stats here).
async function deepPulse(dir, { folders = 40 } = {}) {
  const top = await folderPulse(dir);
  if (!top) return null;
  let names = [];
  try { names = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return top; }
  const dated = await Promise.all(names.slice(0, 600).map(async (n) => { try { return [n, (await fsp.stat(path.join(dir, n))).mtimeMs]; } catch { return [n, 0]; } }));
  dated.sort((a, b) => b[1] - a[1]);
  for (const [n] of dated.slice(0, folders)) {
    const inner = await folderPulse(path.join(dir, n), { limit: 400 });
    if (inner && inner.newest > top.newest) top.newest = inner.newest;
  }
  return top;
}

// ~/.codex/sessions/YYYY/MM/DD: the newest day folder, without walking files.
async function newestDatedFolder(dir) {
  try {
    const pick = async (d) => (await fsp.readdir(d)).filter((n) => /^\d+$/.test(n)).sort().pop();
    const y = await pick(dir); if (!y) return null;
    const m = await pick(path.join(dir, y)); if (!m) return { date: y };
    const d = await pick(path.join(dir, y, m));
    const day = d ? path.join(dir, y, m, d) : path.join(dir, y, m);
    const pulse = await folderPulse(day);
    return { date: `${y}-${m}${d ? '-' + d : ''}`, newest: pulse ? pulse.newest : 0 };
  } catch { return null; }
}

const CAL_HELP = {
  Google: 'Google Calendar: Settings → your calendar → Integrate calendar → Secret address in iCal format.',
  Outlook: 'Outlook: Settings → Calendar → Shared calendars → Publish a calendar → ICS.',
};
const CAL_WHAT = {
  Outlook: 'Work meetings in Up next, with Join buttons and reminders before they start.',
  Google: 'Personal plans in Up next, and invites you have not answered.',
};

function askPrompt(name, how) {
  return [
    `From Meridian's Connect page: set up "${name}" so Meridian can use it.`,
    how,
    `Work in ${__dirname} (read README.md first). Never print or paste config.json values, tokens or calendar links into files, logs or the report.`,
    'If it needs Owner to sign in, approve something or paste a secret, stop and write the exact steps for Owner in the report instead of guessing. Keep the change small, run node --check server.js and the tests, and say what to restart.',
  ].join('\n\n');
}

// facts -> the list. Pure, so it can be tested without a Mac.
function buildSources(f, now = Date.now()) {
  const out = [];
  const add = (s) => out.push({ action: null, detail: '', prompt: null, group: 'mac', ...s });

  // Agent logs
  const cl = f.claude;
  add(cl ? { id: 'claude-logs', name: 'Claude Code logs', what: 'Which agents are working now, what they did, and AI usage.', status: 'connected', detail: `${plural(cl.count, 'project')} · last active ${agoText(cl.newest, now)}` }
    : { id: 'claude-logs', name: 'Claude Code logs', what: 'Which agents are working now, what they did, and AI usage.', status: 'missing', detail: 'No ~/.claude/projects folder on this Mac.', action: 'agent', prompt: askPrompt('Claude Code logs', 'Meridian reads Claude Code session logs from ~/.claude/projects. Check whether Claude Code is installed on this Mac and where its logs are.') });
  const cx = f.codex;
  add(cx ? { id: 'codex-logs', name: 'Codex logs', what: 'Codex sessions in Live now and the journal, and AI usage.', status: 'connected', detail: `last session ${cx.newest ? agoText(cx.newest, now) : shortDate(cx.date)}` }
    : { id: 'codex-logs', name: 'Codex logs', what: 'Codex sessions in Live now and the journal, and AI usage.', status: 'missing', detail: 'No ~/.codex/sessions folder on this Mac.', action: 'agent', prompt: askPrompt('Codex logs', 'Meridian reads Codex session logs from ~/.codex/sessions. Check whether the Codex CLI is installed and has run on this Mac.') });

  // GitHub, through the gh CLI (github.js)
  const gh = f.github || {};
  if (!f.ghInstalled) add({ id: 'github', name: 'GitHub', what: 'Your pull requests, reviews waiting for you, and failing builds.', status: 'missing', detail: 'The GitHub CLI (gh) is not installed.', action: 'agent', prompt: askPrompt('GitHub', 'Meridian reads GitHub through the gh CLI (github.js). Install it with Homebrew if it is missing, then Owner has to run `gh auth login` once: give those steps.') });
  else if (gh.error && !gh.user) add({ id: 'github', name: 'GitHub', what: 'Your pull requests, reviews waiting for you, and failing builds.', status: 'error', detail: String(gh.error).slice(0, 140), action: 'agent', prompt: askPrompt('GitHub', `Meridian's GitHub check (github.js, gh api graphql) fails with: ${String(gh.error).slice(0, 200)}. Find out why; if gh needs signing in again, give Owner the steps.`) });
  else add({ id: 'github', name: 'GitHub', what: 'Your pull requests, reviews waiting for you, and failing builds.', status: 'connected', detail: gh.user ? `Signed in as ${gh.user} · ${plural((gh.prs || []).length, 'open PR')}${gh.at ? ' · checked ' + agoText(Date.parse(gh.at), now) : ''}` : 'Checking…' });

  // Tailscale
  const ts = f.tailnet || {};
  add(ts.host || ts.ip ? { id: 'tailscale', name: 'Tailscale', what: 'Opens Meridian and your dev servers from the other Mac and your phone.', status: 'connected', detail: ts.host ? `This Mac is ${String(ts.host).split('.')[0]} on your tailnet` : 'On your tailnet' }
    : { id: 'tailscale', name: 'Tailscale', what: 'Opens Meridian and your dev servers from the other Mac and your phone.', status: 'missing', detail: 'Tailscale is not running or not signed in.', action: 'agent', prompt: askPrompt('Tailscale', 'Meridian finds this Mac on the tailnet with `tailscale status --json` (TAILSCALE_BE_CLI=1 under launchd) and serves port 4980 over Tailscale HTTPS. Check Tailscale is installed and signed in, and that `tailscale serve` maps 443 to 127.0.0.1:4980.') });

  // Calendars, each feed and the class timetable
  const cals = f.calendars || { feeds: [], classes: null };
  for (const c of cals.feeds || []) {
    const kind = /google/i.test(c.host) ? 'Google' : /outlook|office/i.test(c.host) ? 'Outlook' : null;
    const where = c.source === 'config' ? 'set in config' : 'added here';
    const st = c.hidden ? 'connected' : c.ok === false ? 'error' : 'connected';
    add({
      id: 'calendar:' + c.id, group: 'calendar', name: `${c.label} calendar`, what: CAL_WHAT[kind] || 'Events in Up next.', status: st, color: c.color,
      detail: c.hidden ? `Hidden · ${where}` : c.ok === false ? `${c.error || 'Could not fetch it'} · ${where}` : c.ok ? `${plural(c.events || 0, 'event')} this week · checked ${agoText(c.at, now)} · ${where}` : `Not checked yet · ${where}`,
      action: c.ok === false ? 'paste' : null, help: kind ? CAL_HELP[kind] : null,
    });
  }
  for (const kind of ['Outlook', 'Google']) {
    const re = kind === 'Google' ? /google/i : /outlook|office/i;
    if ((cals.feeds || []).some((c) => re.test(c.host))) continue;
    add({ id: 'calendar-new:' + kind.toLowerCase(), group: 'calendar', name: `${kind} calendar`, what: CAL_WHAT[kind], status: 'missing', detail: 'Paste its ICS link.', action: 'paste', help: CAL_HELP[kind], label: kind });
  }
  const cl2 = cals.classes;
  if (cl2) {
    add(cl2.items && cl2.items.length
      ? { id: 'classes', group: 'calendar', name: 'Class timetable', what: 'Your classes in Up next. Never a reminder.', status: 'connected', color: cl2.color, detail: `${plural(cl2.items.length, 'class', 'classes')} a week · term ends ${shortDate(cl2.term.to)}${cl2.items.some((i) => i.estimated) ? ' · some times are guesses' : ''}${cl2.hidden ? ' · hidden' : ''}` }
      : { id: 'classes', group: 'calendar', name: 'Class timetable', what: 'Your classes in Up next. Never a reminder.', status: 'missing', detail: 'Add your weekly classes below.' });
  }

  // Phone pushes (ntfy)
  const n = f.notify;
  if (!n || !n.topic) add({ id: 'pushes', name: 'Phone pushes', what: 'Meeting reminders, finished agents and sites going down, on your phone.', status: 'missing', detail: 'No ntfy topic yet.', action: 'agent', prompt: askPrompt('Phone pushes', 'Meridian pushes through ntfy (config.json → notify: provider, url, topic, enabled). Create the notify block if it is missing (server.js ensureNotifyConfig does this on boot), then tell Owner to subscribe to the topic in the ntfy app. Do not write the topic into the report: say where to find it.') });
  else {
    const last = f.lastPush;
    const failed = last && last.ok === false && now - last.time < 86400000;
    add({ id: 'pushes', name: 'Phone pushes', what: 'Meeting reminders, finished agents and sites going down, on your phone.', status: failed ? 'error' : 'connected',
      detail: failed ? `The last push failed${last.status ? ' (HTTP ' + last.status + ')' : ''} · ${agoText(last.time, now)}` : n.enabled === false ? 'Set up, switched off. The bell on Home turns it on.' : `On, through ${n.provider || 'ntfy'}${last ? ' · last sent ' + agoText(last.time, now) : ''}`,
      action: failed ? 'agent' : null, prompt: failed ? askPrompt('Phone pushes', 'The last ntfy push from Meridian failed (data/notifications.json). Find out why without printing the topic.') : null });
  }

  // The nightly ledger
  const lg = f.ledger;
  if (!lg || !lg.date) add({ id: 'ledger', name: 'Nightly ledger', what: 'Where things stand (the line under the greeting) and the journal.', status: 'missing', detail: 'No ledger notes yet.', action: 'agent', prompt: askPrompt('Nightly ledger', 'Meridian reads the nightly ledger (config.json → ledger.dir, launchd job uk.example.meridian-ledger at 23:40). Check the job is loaded and has run.') });
  else {
    const days = Math.round((Date.parse(new Date(now).toISOString().slice(0, 10)) - Date.parse(lg.date)) / 86400000);
    const bad = days > 2 || (lg.exitStatus != null && lg.exitStatus !== 0);
    add({ id: 'ledger', name: 'Nightly ledger', what: 'Where things stand (the line under the greeting) and the journal.', status: bad ? 'error' : 'connected',
      detail: `Last note ${shortDate(lg.date)}${lg.schedule ? ' · runs at ' + lg.schedule : ''}${lg.exitStatus ? ' · last run failed (exit ' + lg.exitStatus + ')' : ''}`,
      action: bad ? 'agent' : null, prompt: bad ? askPrompt('Nightly ledger', `The nightly ledger's newest note is from ${lg.date}${lg.exitStatus ? ` and its launchd job last exited with ${lg.exitStatus}` : ''}. Find out why (logs/ in Meridian, launchctl print gui/$(id -u)/uk.example.meridian-ledger).`) : null });
  }

  // Outlook and Slack to-dos, from the Codex daily brief
  const bi = f.intake;
  if (!bi) add({ id: 'brief-intake', name: 'Outlook and Slack to-dos', what: 'Emails and messages that need you, picked out by the daily brief automation.', status: 'missing', detail: 'The daily brief has not written anything yet.', action: 'agent', prompt: askPrompt('Outlook and Slack to-dos', 'The Codex daily brief automation (~/.codex/automations/daily-brief) writes data/brief-intake.json. Check it is set up and when it last ran.') });
  else {
    const old = bi.updatedAt && now - Date.parse(bi.updatedAt) > 36 * 3600000;
    add({ id: 'brief-intake', name: 'Outlook and Slack to-dos', what: 'Emails and messages that need you, picked out by the daily brief automation.', status: old ? 'error' : 'connected',
      detail: `${plural(bi.items || 0, 'item')} · updated ${agoText(Date.parse(bi.updatedAt), now) || 'never'}${(bi.sources || []).length ? ' · ' + bi.sources.join(', ') : ''}`,
      action: old ? 'agent' : null, prompt: old ? askPrompt('Outlook and Slack to-dos', `data/brief-intake.json was last updated ${bi.updatedAt}. Check the Codex daily brief automation is still running.`) : null });
  }

  // Notes inbox (captures and fixes) and Chrome (link previews)
  add(f.inbox ? { id: 'inbox', name: 'Notes inbox', what: 'Where captures (>) and logged fixes are saved as notes.', status: 'connected', detail: 'Your vault Inbox folder' }
    : { id: 'inbox', name: 'Notes inbox', what: 'Where captures (>) and logged fixes are saved as notes.', status: 'missing', detail: 'The inbox folder in config.json does not exist.', action: 'agent', prompt: askPrompt('Notes inbox', 'config.json → vaultInbox points at a folder that does not exist. Find the Obsidian vault Inbox and say what the setting should be.') });
  add(f.chrome ? { id: 'chrome', name: 'Link previews', what: 'Screenshots of your links and dev servers on the shelf.', status: 'connected', detail: 'Google Chrome, headless' }
    : { id: 'chrome', name: 'Link previews', what: 'Screenshots of your links and dev servers on the shelf.', status: 'missing', detail: 'Google Chrome is not installed.', action: 'agent', prompt: askPrompt('Link previews', 'Meridian takes previews with headless Google Chrome at /Applications/Google Chrome.app. Install Chrome if it is missing.') });

  return out;
}

// deps: functions the daemon already has. Each may throw; a failing one
// becomes "missing" rather than breaking the page.
function createConnect(deps = {}) {
  const home = deps.home || os.homedir();
  const enabled = deps.enabled || (() => true);
  let cache = { at: 0, value: null };
  const safe = async (fn, fallback = null) => { try { return fn ? await fn() : fallback; } catch { return fallback; } };

  async function facts() {
    const [claude, codex, github, tailnet, calendars, notify, lastPush, ledger, intake, inbox] = await Promise.all([
      enabled('ai') ? deepPulse(path.join(home, '.claude', 'projects')) : null,
      enabled('ai') ? newestDatedFolder(path.join(home, '.codex', 'sessions')) : null,
      enabled('github') ? safe(deps.github) : null, enabled('tailscale') ? safe(deps.tailnet) : null, enabled('calendar') ? safe(deps.calendars) : null, enabled('notify') ? safe(deps.notify) : null, enabled('notify') ? safe(deps.lastPush) : null,
      enabled('ledger') ? safe(deps.ledger) : null, enabled('intake') ? safe(deps.intake) : null,
      safe(async () => (enabled('journalExport') && deps.inbox ? (await fsp.stat(deps.inbox)).isDirectory() : false), false),
    ]);
    return { claude, codex, github, ghInstalled: deps.ghBin ? fs.existsSync(deps.ghBin) : false, tailnet, calendars, notify, lastPush, ledger, intake, inbox, chrome: Boolean(deps.chrome) };
  }

  async function get({ force = false } = {}) {
    if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
    let sources = buildSources(await facts());
    if (deps.enabled) {
      const connector = id => id.startsWith('calendar') || id === 'classes' ? 'calendar' : ({ 'claude-logs': 'ai', 'codex-logs': 'ai', github: 'github', tailscale: 'tailscale', pushes: 'notify', ledger: 'ledger', 'brief-intake': 'intake', inbox: 'journalExport', chrome: 'previews' })[id];
      sources = sources.filter(source => enabled(connector(source.id)));
    }
    const value = { ok: true, at: Date.now(), sources };
    cache = { at: Date.now(), value };
    return value;
  }

  return { get, bust: () => { cache.at = 0; } };
}

module.exports = { createConnect, buildSources, askPrompt, CAL_HELP };
