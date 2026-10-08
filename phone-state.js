'use strict';

const pick = (o, keys) => Object.fromEntries(
  keys.split(' ').filter(k => o && o[k] !== undefined).map(k => [k, o[k]])
);
const rows = (items, keys) => (items || []).map(o => pick(o, keys));

// Keep the phone's existing fields and complete actionable arrays. The full
// state and its collectors stay shared with desktop and the stream.
function phoneState(s) {
  return {
    ...pick(s, 'at location deadlines invites todos notify tailnet nudges setup'),
    calendar: { events: s.calendar?.events || [] },
    projects: { projects: rows((s.projects?.projects || []).filter(p => p.brief),
      'id title brief status source sourceFrom sourceUrl sourceReceivedAt updated priority') },
    briefFeedback: pick(s.briefFeedback, 'completed rejected skipped'),
    briefIntake: { items: rows(s.briefIntake?.items, 'projectId source from url receivedAt') },
    ai: { sessions: rows(s.ai?.sessions, 'live project tool did prompt started last') },
    delegations: { runs: rows(s.delegations?.runs,
      'id status kind model title started finished undoneAt archivedAt undoable') },
    ledger: { now: s.ledger?.now },
    journalToday: s.journalToday,
    github: { reviews: rows(s.github?.reviews, 'url updatedAt title repo number') },
    notifyHistory: rows(s.notifyHistory, 'ok event time title message')
  };
}

module.exports = { phoneState };
