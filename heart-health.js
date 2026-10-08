'use strict';
const runtime = require('./runtime');
const JOBS_ENABLED = runtime.connectorEnabled('heartHealth');
const { DATA_DIR } = runtime;

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execute } = require('./process-runner');
const { createSources } = require('./refresh');

function londonDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function shiftDay(day, amount) {
  const date = new Date(day + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
function midnight(day) {
  const zone = new Intl.DateTimeFormat('en', { timeZone: 'Europe/London', timeZoneName: 'longOffset' })
    .formatToParts(new Date(day + 'T00:00:00Z')).find(part => part.type === 'timeZoneName').value;
  return day + 'T00:00:00' + (zone === 'GMT' ? '+00:00' : zone.replace('GMT', ''));
}
function reportingWindow(now = new Date(), from = londonDay(now)) {
  const today = londonDay(now);
  return { from, to: today, until: now.toISOString(), live: true };
}
function summarise(views, events, devices, window, now = new Date(), { dashboardUrl = '', answersFrom = '' } = {}) {
  for (const result of [views, events, devices]) {
    if (!Array.isArray(result.summary) || !Array.isArray(result.data)) throw new Error('Incomplete analytics response');
  }
  const total = (rows, field) => rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
  const count = name => total(events.summary.filter(row => row.event_name === name), 'vercel_analytics_event_count_sum');
  const stats = {
    pageviews: total(views.summary, 'vercel_analytics_pageview_count_sum'),
    starts: count('heart_health_start'), completes: count('heart_health_complete'), outbound: count('heart_health_outbound'),
    mobile: total(devices.summary.filter(row => row.device_type === 'mobile'), 'vercel_analytics_pageview_count_sum'),
  };
  const answers = {
    awareness: { yes: count('heart_health_awareness_yes'), no: count('heart_health_awareness_no') },
    nextStep: { support: count('heart_health_next_support'), solo: count('heart_health_next_solo'), notReady: count('heart_health_next_not_ready') },
    completed: count('heart_health_questions_complete'),
  };
  const daily = [];
  for (let day = window.from; day <= window.to; day = shiftDay(day, 1)) {
    const rows = events.data.filter(row => londonDay(new Date(row.timestamp)) === day);
    const event = name => total(rows.filter(row => row.event_name === name), 'vercel_analytics_event_count_sum');
    daily.push({ day, pageviews: total(views.data.filter(row => londonDay(new Date(row.timestamp)) === day), 'vercel_analytics_pageview_count_sum'),
      starts: event('heart_health_start'), completes: event('heart_health_complete'), outbound: event('heart_health_outbound') });
  }
  return { configured: true, generatedAt: now.toISOString(), window, stats, daily, answers, dashboardUrl,
    tracking: { analyticsFrom: window.from, answersFrom, launchDayIncludesTesting: true } };
}
function createCollector({ file = path.join(DATA_DIR, 'heart-health.json'), query, now = () => new Date(), timers, project = '', scope = '', hostname = '', dashboardUrl = '', cli = '', from = '', answersFrom = '' } = {}) {
  const configured = Boolean(query || (project && scope && hostname && cli && from));
  let cached = null, pending = null, attemptedAt = null, error = null, retryAfter = null;
  try { cached = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const sources = createSources({ now: () => now().getTime(), timers, onError: (_name, cause) => {
    const details = String(cause?.stdout || '') + String(cause?.stderr || '') + String(cause?.message || '');
    if (details.includes('rate_limited')) retryAfter = Date.parse(midnight(shiftDay(londonDay(now()), 1)));
    error = details.includes('rate_limited')
      ? 'Vercel’s daily reporting quota is reached. Showing the last verified figures.'
      : 'Live refresh unavailable. Showing the last successful figures.';
  } });
  sources.observe('heartHealth', { lastSuccess: cached?.generatedAt ? Date.parse(cached.generatedAt) : null });
  query ||= async (metric, extra, window) => {
    const result = await execute(process.execPath, [cli.startsWith('~/') ? path.join(os.homedir(), cli.slice(2)) : cli, 'metrics', metric,
      '--project', project, '--scope', scope, '--prod',
      '--since', midnight(window.from), '--until', window.until, '--granularity', '1d',
      '--bucket-timezone', 'Europe/London', '--filter', `request_hostname eq '${hostname}' and request_path eq '/'`,
      '--limit', '50', '--json', ...extra], { timeout: 45000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:' + (process.env.PATH || '') } });
    return JSON.parse(result.stdout);
  };
  function refresh() {
    if (!JOBS_ENABLED || !configured) return Promise.resolve();
    if (pending) return pending;
    if (retryAfter !== null) {
      if (now().getTime() < retryAfter) return Promise.resolve();
      retryAfter = null;
    } else if (attemptedAt !== null && now().getTime() - attemptedAt < 10 * 60 * 1000) return Promise.resolve();
    attemptedAt = now().getTime();
    const window = reportingWindow(now(), from || londonDay(now()));
    pending = sources.collect('heartHealth', async () => {
      const results = await Promise.all([
        query('vercel.analytics_pageview.count', [], window),
        query('vercel.analytics_event.count', ['--group-by', 'event_name'], window),
        query('vercel.analytics_pageview.count', ['--group-by', 'device_type'], window),
      ]);
      const next = summarise(...results, window, now(), { dashboardUrl, answersFrom });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2) + '\n');
      fs.renameSync(file + '.tmp', file);
      cached = next;
      error = null;
      retryAfter = null;
      return next;
    }, { deadline: attemptedAt + 45000, fallback: cached, retained: Boolean(cached) })
      .finally(() => { pending = null; });
    return pending;
  }
  function collect() {
    if (runtime.portableProfile() && !JOBS_ENABLED) return { configured: false };
    if (!configured) return { configured: false, dashboardUrl: '', stale: false, error: null };
    if (JOBS_ENABLED && (attemptedAt === null || now().getTime() - attemptedAt >= 10 * 60 * 1000)) void refresh();
    return { ...(cached || { configured: true, dashboardUrl }),
      stale: Boolean(error || (cached && (cached.window.to !== londonDay(now()) || now().getTime() - Date.parse(cached.generatedAt) > 10 * 60 * 1000))),
      error: error || (!cached ? 'Fetching Heart Health analytics.' : null) };
  }
  return { collect, refresh, source: () => sources.snapshot().heartHealth };
}
module.exports = { createCollector, summarise, reportingWindow, midnight };
