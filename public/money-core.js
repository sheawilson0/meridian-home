'use strict';
/* Money maths for the Money tab (3 Oct 2026). Pure functions, no I/O, so the
   page, the daemon (money.js), the MCP server (scripts/money-mcp.js) and the
   demo all read the same numbers. Loaded as a plain script in the browser
   (window.MoneyCore) and with require() in Node.

   A transaction is { id, date:'YYYY-MM-DD', time, type, name, category,
   amount (GBP, negative = out), local:{amount,currency}?, notes, account }.
   Each one gets a kind:
     income    money earned (Monzo's Income category, or a salary rule)
     spend     everything bought; refunds are spend with a positive amount
     pot       moved to or from a Monzo pot
     internal  moved between your own accounts
     invest    paid into Trading 212, a LISA and the like */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MoneyCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 86400e3;
  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => { d = d instanceof Date ? d : new Date(d); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const noon = (iso) => new Date(iso + 'T12:00:00');
  const addDays = (iso, n) => isoDay(new Date(noon(iso).getTime() + n * DAY));
  const daysBetween = (a, b) => Math.round((noon(b) - noon(a)) / DAY);
  const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const low = (s) => String(s || '').toLowerCase().trim();

  const DEFAULT_RULES = { salary: [], internal: [], invest: ['trading 212', 'moneybox', 'vanguard', 'freetrade', 'nutmeg', 'plum', 'chip '], categories: {}, ignore: [] };

  function rulesOf(r) {
    const out = { ...DEFAULT_RULES, ...(r || {}) };
    for (const k of ['salary', 'internal', 'invest', 'ignore']) out[k] = (Array.isArray(out[k]) ? out[k] : []).map(low).filter(Boolean);
    const cats = {};
    for (const [k, v] of Object.entries(out.categories || {})) if (v) cats[low(k)] = String(v);
    out.categories = cats;
    return out;
  }
  const hit = (name, list) => { const n = low(name); return list.some((x) => n === x || n.includes(x)); };

  function kindOf(tx, rules) {
    if (hit(tx.name, rules.ignore)) return 'ignore';
    if (tx.type === 'Pot transfer') return 'pot';
    if (hit(tx.name, rules.internal)) return 'internal';
    if (hit(tx.name, rules.invest)) return 'invest';
    if (tx.amount > 0 && (tx.category === 'Income' || hit(tx.name, rules.salary))) return 'income';
    return 'spend';
  }
  const categoryOf = (tx, rules) => rules.categories[low(tx.name)] || tx.category || 'General';
  const isSalary = (tx, rules) => tx.amount > 0 && rules.salary.length > 0 && hit(tx.name, rules.salary);

  // Adds kind and the final category to every transaction, oldest first.
  // extra.context is what Owner has said about payments (context.json): a note,
  // a category, "one-off" / "normal" / "leave out", a trip. extra.plans holds
  // payment plans (plans.json): rent paid by the term is matched to its
  // instalment and spread evenly over the days it pays for, as synthetic rows.
  function prepare(txs, rawRules, extra = {}) {
    const rules = rulesOf(rawRules); const ctx = extra.context || {}; const notes = ctx.tx || {};
    let out = (txs || []).filter((t) => t && t.date && Number.isFinite(Number(t.amount)))
      .map((t) => {
        const x = { ...t, amount: Number(t.amount), kind: kindOf(t, rules), cat: categoryOf(t, rules), salary: isSalary(t, rules) };
        const c = notes[t.id];
        if (c) {
          if (c.cat) x.cat = c.cat;
          if (c.note) x.myNote = c.note;
          if (c.tag === 'one-off') x.oneOff = true; else if (c.tag === 'normal') x.oneOff = false; else if (c.tag === 'leave-out') x.kind = 'ignore';
          if (c.trip) x.tripSet = c.trip;
          if (c.feel) x.feel = c.feel;
          if (Array.isArray(c.split) && c.split.length) x.split = c.split;
        }
        return x;
      })
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    // Salary is what lands on a payday; the same employer paying back expenses is just money in.
    const days = new Set(paydays(out)); for (const t of out) if (t.salary && !days.has(t.date)) t.salary = false;
    out = out.concat(spreadPlans(out, extra.plans));
    out.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    // Trips: set by hand, or a holiday-ish payment (Holidays category, or paid in
    // another currency) inside a trip's dates.
    const trips = (ctx.trips || []).filter((x) => x && x.id && x.from);
    for (const t of out) {
      if (t.synthetic) continue;
      if (t.tripSet) { t.trip = t.tripSet === 'none' ? null : t.tripSet; continue; }
      if (t.kind !== 'spend') continue;
      const abroad = t.local && /^(Eating out|Transport|Groceries|Shopping|Entertainment|Holidays)$/.test(t.cat);
      const hit = trips.find((x) => t.date >= x.from && t.date <= (x.to || x.from) && (t.cat === 'Holidays' || abroad));
      if (hit) t.trip = hit.id;
    }
    // Someone paying Owner back: money in from a person named in a split, about
    // what they owe, after the purchase. It ticks the split off and counts as
    // money back on that purchase, not as income.
    const used = new Set((extra.receivables || []).flatMap(c => (c.history || []).map(h => h.transactionId).filter(Boolean)));
    for (const t of out) {
      if (!t.split) continue; t.split = t.split.map((x) => ({ ...x }));
      for (const x of t.split) {
        if (x.settled) continue; const who = low(x.who).split(/\s+/)[0]; if (who.length < 3) continue;
        const back = out.find((r) => !r.synthetic && r.amount > 0 && !used.has(r.id) && r.date >= t.date && daysBetween(t.date, r.date) <= 180 && low(r.name).includes(who) && Math.abs(r.amount - x.amount) <= 1);
        if (!back) continue;
        used.add(back.id); x.settled = true; x.auto = { date: back.date, name: back.name, amount: back.amount, id: back.id };
        back.repays = { who: x.who, for: t.myNote || t.name, txId: t.id };
        if (back.kind === 'income' || back.kind === 'internal') { back.kind = 'spend'; back.cat = t.cat; }
      }
    }
    return out;
  }

  // Each instalment of a plan is matched to the payment that paid it (same
  // payee, amount within £1, near the due date) and then counted a day at a
  // time across the dates it covers, instead of all on the day it left.
  function spreadPlans(prepared, plans) {
    const rows = [];
    for (const plan of Object.values(plans || {})) {
      if (!plan || !Array.isArray(plan.instalments)) continue;
      const payee = low(plan.payee); const income = plan.kind === 'income'; const sign = income ? 1 : -1;
      for (const ins of plan.instalments) {
        const amount = Number(ins.amount); if (!ins.from || !ins.to || !(amount > 0)) continue;
        const near = (t) => Math.abs(daysBetween(ins.due || ins.from, t.date)) <= 75;
        // The real payment, if it went through this account, is noted but not counted twice.
        const paid = prepared.find((t) => (income ? t.amount > 0 && t.kind !== 'pot' : t.kind === 'spend') && !t.planned && payee && low(t.name).includes(payee) && Math.abs(Math.abs(t.amount) - amount) <= 1 && near(t));
        if (paid) { paid.kind = 'planned'; paid.planned = { plan: plan.name, from: ins.from, to: ins.to, income }; }
        const n = Math.max(1, daysBetween(ins.from, ins.to)); const per = amount / n; const cat = plan.category || (income ? 'Income' : 'Rent');
        for (let i = 0; i < n; i++) rows.push({ id: `plan:${plan.id || payee}:${ins.from}:${i}`, date: addDays(ins.from, i), time: '00:00', type: 'Spread', name: plan.name || 'Rent', category: cat, cat, amount: sign * per, kind: income ? 'income' : 'spend', synthetic: true, oneOff: false, salary: false, plan: plan.id || payee });
      }
    }
    return rows;
  }
  const isLump = (t) => (t.oneOff != null ? t.oneOff : t.amount <= -LUMP);

  // Paydays, oldest first. Several salary payments on one day count once; a
  // small one (expenses paid back) or one within 20 days of the last isn't a payday.
  function paydays(prepared) {
    const by = new Map(); for (const t of prepared) if (t.salary) by.set(t.date, (by.get(t.date) || 0) + t.amount);
    const typical = median([...by.values()]); const out = [];
    for (const [d, v] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (v < typical * 0.5) continue;
      if (out.length && daysBetween(out[out.length - 1], d) < 20) continue;
      out.push(d);
    }
    return out;
  }
  function payInterval(days) {
    if (days.length < 2) return 30;
    const gaps = days.slice(1).map((d, i) => daysBetween(days[i], d)).filter((g) => g >= 20 && g <= 40);
    return gaps.length ? median(gaps) : 30;
  }
  function median(xs) { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; }

  const PERIODS = [
    { id: 'payday', label: 'Since payday' },
    { id: 'month', label: 'This month' },
    { id: 'last', label: 'Last month' },
    { id: '90d', label: '3 months' },
    { id: 'all', label: 'All' },
  ];

  // {from, to, prev:{from,to}, label, end} for a period, inclusive dates.
  // end is when the period will finish (for "at this rate" maths).
  function periodSpan(id, prepared, today) {
    today = today || isoDay(new Date());
    const first = prepared.length ? prepared[0].date : today;
    const [y, m] = today.split('-').map(Number);
    const monthStart = (yy, mm) => `${yy}-${pad(mm)}-01`;
    const monthEnd = (yy, mm) => isoDay(new Date(yy, mm, 0, 12));
    if (id === 'payday') {
      const pd = paydays(prepared).filter((d) => d <= today);
      if (pd.length) {
        const from = pd[pd.length - 1]; const n = daysBetween(from, today);
        const prevFrom = pd.length > 1 ? pd[pd.length - 2] : addDays(from, -payInterval(pd));
        const end = addDays(from, payInterval(pd) - 1);
        return { id, from, to: today, end, prev: { from: prevFrom, to: addDays(prevFrom, Math.min(n, daysBetween(prevFrom, from) - 1)) }, label: 'since payday', prevLabel: 'the same point last pay month' };
      }
      id = 'month';
    }
    if (id === 'month') {
      const from = monthStart(y, m); const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y;
      const prevTo = isoDay(new Date(py, pm - 1, Math.min(Number(today.slice(8)), new Date(py, pm, 0).getDate()), 12));
      return { id, from, to: today, end: monthEnd(y, m), prev: { from: monthStart(py, pm), to: prevTo }, label: 'this month', prevLabel: 'the same point last month' };
    }
    if (id === 'last') {
      const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y; const ppm = pm === 1 ? 12 : pm - 1; const ppy = pm === 1 ? py - 1 : py;
      return { id, from: monthStart(py, pm), to: monthEnd(py, pm), end: monthEnd(py, pm), prev: { from: monthStart(ppy, ppm), to: monthEnd(ppy, ppm) }, label: 'last month', prevLabel: 'the month before' };
    }
    // One calendar month picked from the month-by-month chart: 'm:2026-08'.
    const mm = /^m:(\d{4})-(\d{2})$/.exec(id);
    if (mm) {
      const yy = Number(mm[1]), mo = Number(mm[2]); const py = mo === 1 ? yy - 1 : yy, pm = mo === 1 ? 12 : mo - 1;
      const end = monthEnd(yy, mo); const to = end < today ? end : today;
      return { id, from: monthStart(yy, mo), to, end, prev: { from: monthStart(py, pm), to: monthEnd(py, pm) }, label: 'in ' + MONTHS[mo - 1] + ' ' + yy, prevLabel: MONTHS[pm - 1] };
    }
    if (id === '90d') {
      const from = addDays(today, -89);
      return { id, from, to: today, end: today, prev: { from: addDays(from, -90), to: addDays(from, -1) }, label: 'the last 3 months', prevLabel: 'the 3 months before' };
    }
    return { id: 'all', from: first, to: today, end: today, prev: null, label: 'since ' + first, prevLabel: '' };
  }

  // The same day next month, or its last day when that month is shorter.
  function nextMonth(iso) { const [y, m, d] = iso.split('-').map(Number); const last = new Date(y, m + 1, 0).getDate(); return isoDay(new Date(y, m, Math.min(d, last), 12)); }
  const within = (t, span) => t.date >= span.from && t.date <= span.to;
  const LUMP = 200;

  // Totals for one window. spent is a positive number: purchases less refunds.
  function summarize(prepared, span) {
    const s = { from: span.from, to: span.to, lumps: 0, planned: 0, spreadIn: 0, trips: new Map(), earned: 0, salary: 0, otherIn: 0, spent: 0, refunds: 0, saved: 0, invested: 0, internal: 0, count: 0, cats: new Map(), merchants: new Map(), sources: new Map(), pots: new Map(), dests: new Map(), biggest: null };
    for (const t of prepared) {
      if (!within(t, span) || t.kind === 'ignore') continue;
      if (!t.synthetic) s.count++;
      const a = t.amount;
      if (t.kind === 'income') { s.earned += a; if (t.salary) s.salary += a; else if (t.synthetic) s.spreadIn += a; else s.otherIn += a; bump(s.sources, t.name, a); continue; }
      if (t.kind === 'pot') { s.saved -= a; bump(s.pots, t.name, -a); continue; }
      if (t.kind === 'invest') { s.invested -= a; bump(s.dests, t.name, -a); continue; }
      if (t.kind === 'internal') { s.internal += a; continue; }
      if (t.kind === 'planned') { if (a < 0) s.planned -= a; continue; }
      s.spent -= a; if (a > 0 && !t.synthetic) s.refunds += a; if (a < 0 && isLump(t)) s.lumps -= a;
      if (t.trip) bump(s.trips, t.trip, -a);
      const c = s.cats.get(t.cat) || { name: t.cat, spent: 0, count: 0 }; c.spent -= a; if (!t.synthetic) c.count++; s.cats.set(t.cat, c);
      const mk = t.name || 'Unknown'; const mm = s.merchants.get(mk) || { name: mk, cat: t.cat, spent: 0, count: 0, spread: !!t.synthetic }; mm.spent -= a; if (!t.synthetic) mm.count++; s.merchants.set(mk, mm);
      if (a < 0 && !t.synthetic && (!s.biggest || a < s.biggest.amount)) s.biggest = t;
    }
    const out = {
      from: s.from, to: s.to, count: s.count,
      earned: r2(s.earned), salary: r2(s.salary), otherIn: r2(s.otherIn), spent: r2(s.spent), refunds: r2(s.refunds), saved: r2(s.saved), invested: r2(s.invested), internal: r2(s.internal),
      left: r2(s.earned - s.spent), lumps: r2(s.lumps), steady: r2(s.spent - s.lumps), planned: r2(s.planned),
      spread: r2(prepared.filter((t) => t.synthetic && t.kind === 'spend' && within(t, span)).reduce((x, t) => x - t.amount, 0)), spreadIn: r2(s.spreadIn),
      trips: [...s.trips].map(([id, v]) => ({ id, spent: r2(v) })),
      categories: [...s.cats.values()].map((c) => ({ ...c, spent: r2(c.spent) })).sort((a, b) => b.spent - a.spent),
      merchants: [...s.merchants.values()].map((c) => ({ ...c, spent: r2(c.spent) })).sort((a, b) => b.spent - a.spent),
      sources: [...s.sources].map(([name, v]) => ({ name, amount: r2(v) })).sort((a, b) => b.amount - a.amount),
      pots: [...s.pots].map(([name, v]) => ({ name, amount: r2(v) })).sort((a, b) => b.amount - a.amount),
      destinations: [...s.dests].map(([name, v]) => ({ name, amount: r2(v) })).sort((a, b) => b.amount - a.amount),
      biggest: s.biggest ? { name: s.biggest.name, amount: r2(-s.biggest.amount), date: s.biggest.date, cat: s.biggest.cat } : null,
    };
    return out;
  }
  function bump(map, k, v) { map.set(k || 'Unknown', (map.get(k || 'Unknown') || 0) + v); }

  // Spending per day in a window, split into the given categories plus Other.
  function daily(prepared, span, cats) {
    const keep = new Set(cats);
    const days = []; for (let d = span.from; d <= span.to; d = addDays(d, 1)) days.push({ date: d, v: {} });
    const at = new Map(days.map((x) => [x.date, x]));
    for (const t of prepared) {
      if (t.kind !== 'spend' || !within(t, span)) continue;
      const b = at.get(t.date); if (!b) continue;
      const k = keep.has(t.cat) ? t.cat : 'Other';
      b.v[k] = r2((b.v[k] || 0) - t.amount);
    }
    for (const b of days) for (const k of Object.keys(b.v)) if (b.v[k] < 0) b.v[k] = 0; // a refund day shows as nothing, not a dip
    return days;
  }

  // One row per calendar month: earned, spent, saved, invested.
  function monthly(prepared, today) {
    today = today || isoDay(new Date());
    const by = new Map();
    for (const t of prepared) {
      if (t.kind === 'ignore' || t.kind === 'planned' || t.date > today) continue;
      const k = t.date.slice(0, 7); const m = by.get(k) || { month: k, earned: 0, spent: 0, saved: 0, invested: 0, movedIn: 0 };
      if (t.kind === 'internal') { if (t.amount > 0) m.movedIn += t.amount; by.set(k, m); continue; }
      if (t.kind === 'income') m.earned += t.amount; else if (t.kind === 'pot') m.saved -= t.amount; else if (t.kind === 'invest') m.invested -= t.amount; else m.spent -= t.amount;
      by.set(k, m);
    }
    return [...by.values()].sort((a, b) => a.month.localeCompare(b.month)).map((m) => ({ month: m.month, earned: r2(m.earned), spent: r2(m.spent), saved: r2(m.saved), invested: r2(m.invested), left: r2(m.earned - m.spent),
      // Money moved over from your own accounts and straight into pots isn't new saving.
      movedIn: r2(m.movedIn), putAway: r2(Math.max(0, m.saved + m.invested - m.movedIn)) }));
  }

  // Things that come round again: the same merchant, a similar amount, a
  // steady gap. Monthly, weekly or yearly. Varying shops (groceries) drop out
  // because their amounts don't hold steady.
  function recurring(prepared, today) {
    today = today || isoDay(new Date());
    const by = new Map();
    for (const t of prepared) if (t.kind === 'spend' && t.amount < 0 && !t.synthetic) { const k = low(t.name); if (!k) continue; (by.get(k) || by.set(k, []).get(k)).push(t); }
    const out = [];
    for (const list of by.values()) {
      if (list.length < 2) continue;
      // The latest run of similar amounts: a price rise starts a new run.
      const amts = list.map((t) => -t.amount); const typical = median(amts.slice(-4));
      const steady = list.filter((t) => Math.abs(-t.amount - typical) <= Math.max(1, typical * 0.2));
      if (steady.length < 2) continue;
      const dates = [...new Set(steady.map((t) => t.date))];
      if (dates.length < 2) continue;
      const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d)); const g = median(gaps);
      const every = g >= 26 && g <= 35 ? 'month' : g >= 6 && g <= 8 ? 'week' : g >= 350 && g <= 380 ? 'year' : null;
      if (!every) continue;
      if (every === 'month' && dates.length < 2) continue;
      if (every === 'week' && dates.length < 4) continue;
      const ok = gaps.filter((x) => Math.abs(x - g) <= (every === 'week' ? 2 : every === 'month' ? 6 : 20)).length;
      if (ok < Math.max(1, gaps.length * 0.6)) continue;
      const last = dates[dates.length - 1]; const step = every === 'week' ? 7 : every === 'year' ? 365 : Math.round(g);
      const next = every === 'month' ? nextMonth(last) : addDays(last, step);
      const lapsed = daysBetween(next, today) > (every === 'week' ? 10 : every === 'month' ? 12 : 45);
      const amount = r2(median(steady.slice(-3).map((t) => -t.amount)));
      const t0 = list[list.length - 1];
      out.push({ name: t0.name, cat: t0.cat, amount, every, monthly: r2(every === 'week' ? amount * 52 / 12 : every === 'year' ? amount / 12 : amount), last, next, count: steady.length, lapsed });
    }
    return out.sort((a, b) => (a.lapsed - b.lapsed) || b.monthly - a.monthly);
  }

  // Plain sentences worth a glance. No model involved, nothing leaves the Mac.
  function insights(prepared, span, s, prev, opts = {}) {
    const fmt = opts.fmt || ((v) => '£' + Math.round(v).toLocaleString('en-GB'));
    const tips = [];
    const today = span.to; const elapsed = daysBetween(span.from, today) + 1; const total = daysBetween(span.from, span.end) + 1;
    if (span.end > today && elapsed >= 3 && s.spent > 0) {
      // One-off lumps (rent, a holiday) are counted once, not spread across the month.
      const lumps = prepared.filter((t) => t.kind === 'spend' && t.amount < 0 && isLump(t) && within(t, span)).reduce((a, t) => a - t.amount, 0);
      const pace = Math.max(0, s.spent - lumps) / elapsed * total + lumps;
      tips.push({ k: 'pace', text: `At this rate you'll spend about <b>${fmt(pace)}</b> by ${span.id === 'payday' ? 'next payday' : 'the end of the month'}.` + (s.earned ? ` You've earned ${fmt(s.earned)} so far.` : '') });
    }
    if (prev && prev.categories) {
      // Compared without one-off lumps, so a term's rent doesn't read as "Rent is up".
      const steady = (sp) => { const m = new Map(); if (!sp) return null; for (const t of prepared) if (t.kind === 'spend' && !t.synthetic && within(t, sp) && !(t.amount < 0 && isLump(t))) m.set(t.cat, (m.get(t.cat) || 0) - t.amount); return m; };
      const nowM = steady(span), wasM = steady(opts.prevSpan);
      const before = wasM || new Map(prev.categories.map((c) => [c.name, c.spent]));
      const cur = (c) => (wasM ? nowM.get(c.name) || 0 : c.spent);
      const moves = s.categories.map((c) => ({ name: c.name, now: cur(c), was: before.get(c.name) || 0 })).filter((c) => c.now - c.was > 40 && c.now > c.was * 1.25).sort((a, b) => (b.now - b.was) - (a.now - a.was));
      if (moves[0]) tips.push({ k: 'up', text: `<b>${esc(moves[0].name)}</b> is up ${fmt(moves[0].now - moves[0].was)} on ${opts.prevLabel || 'before'} (${fmt(moves[0].now)} against ${fmt(moves[0].was)}).` });
      const downs = [...new Set([...before.keys(), ...s.categories.map((c) => c.name)])].map((name) => ({ name, now: wasM ? nowM.get(name) || 0 : (s.categories.find((c) => c.name === name)?.spent || 0), was: before.get(name) || 0 })).filter((c) => c.was - c.now > 40).sort((a, b) => (b.was - b.now) - (a.was - a.now));
      if (downs[0]) tips.push({ k: 'down', text: `<b>${esc(downs[0].name)}</b> is down ${fmt(downs[0].was - downs[0].now)} on ${opts.prevLabel || 'before'}.` });
    }
    if (s.categories[0] && s.spent > 0) tips.push({ k: 'top', text: `<b>${esc(s.categories[0].name)}</b> is ${Math.round(s.categories[0].spent / s.spent * 100)}% of your spending ${span.label}.` });
    if (s.biggest && s.biggest.amount >= 50) tips.push({ k: 'big', text: `Biggest single payment: <b>${esc(s.biggest.name)}</b>, ${fmt(s.biggest.amount)} on ${shortDate(s.biggest.date)}.` });
    const subs = opts.recurring || [];
    const live = subs.filter((x) => !x.lapsed);
    if (live.length) tips.push({ k: 'subs', text: `Regular payments come to about <b>${fmt(live.reduce((a, x) => a + x.monthly, 0))}</b> a month across ${live.length} things.` });
    if (s.earned > 0 && (s.saved + s.invested) / s.earned >= 0.05) tips.push({ k: 'saved', text: `You put away <b>${Math.round((s.saved + s.invested) / s.earned * 100)}%</b> of what you earned ${span.label}.` });
    return tips;
  }
  // Needs keep life running; wants are choices. Everything else is "other".
  const NEEDS = ['Rent', 'Bills', 'Groceries', 'Transport', 'Personal care', 'Houdemoold', 'Education'];
  const WANTS = ['Eating out', 'Entertainment', 'Shopping', 'Holidays', 'Hobbies', 'Gifts', 'Gym', 'AI', 'Family', 'Charity'];
  const groupOf = (cat) => (NEEDS.includes(cat) ? 'need' : WANTS.includes(cat) ? 'want' : 'other');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const shortDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Portfolio value per day from the daily snapshots, plus what you'd paid in.
  function portfolioSeries(history) {
    return (history || []).filter((h) => h && h.date && Number.isFinite(Number(h.value))).sort((a, b) => a.date.localeCompare(b.date));
  }

  return { DEFAULT_RULES, PERIODS, spreadPlans, isLump, groupOf, NEEDS, WANTS, rulesOf, kindOf, prepare, paydays, payInterval, periodSpan, summarize, daily, monthly, recurring, insights, portfolioSeries, isoDay, addDays, daysBetween, shortDate, median };
});
