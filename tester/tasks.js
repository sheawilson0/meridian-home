'use strict';

// The tasks a tester is given (7 Oct 2026). Moderated: Owner is on a call and
// moves them on from the console; the card on the tester's screen follows.
// Self-paced: the tester moves on with Done or Skip and types their answers.
//
// Each task tries one thing Meridian claims to do for someone who works with
// several agents. `look` says where the answer is on the page, for Owner's notes
// and the replay; it's never shown to the tester. `ask: 'text'` adds a box for a
// typed answer; every task ends with the one-question ease rating (SEQ).

const TASKS = {
  first: { title: 'First look', text: 'Take a minute to look around this page without clicking anything. What do you think it’s for, and what would you look at first?', look: 'Whole page. Listen for: agents, to-dos, calendar, "dashboard".', seq: false },
  firstSelf: { title: 'First look', text: 'Take a minute to look around this page without clicking anything. In a sentence, what do you think it’s for?', ask: 'text', look: 'Whole page.', seq: false },
  agents: { title: 'Your agents', text: 'Find out what your AI agents are doing right now. Which one would you check on first, and why?', look: 'Agents strip along the bottom; Live now on Home; System → Agents.' },
  agentsSelf: { title: 'Your agents', text: 'Find out what your AI agents are doing right now. Which one would you check on first, and why?', ask: 'text', look: 'Agents strip along the bottom; Live now on Home; System → Agents.' },
  waiting: { title: 'Someone’s waiting', text: 'Priya is waiting on a reply from you. Find what she asked and where she asked it.', look: 'To do card: "Reply to Priya…" (Slack), its preview at the top of the card.' },
  handoff: { title: 'Hand it off', text: 'Hand “Review Leo’s onboarding PR” to an agent. When the agent has finished, find what it came back with. (It takes about a minute.)', look: 'Delegate on the to-do row (hover). Strip chip while it runs; “Report ready” on the row when done.' },
  yours: { title: 'Make it yours', text: 'Bring in three real things from your own week. Type them, paste a summary from ChatGPT, or add your calendar link.', look: 'Make it yours (task card button), or Settings → Accounts.', button: { label: 'Make it yours', href: '/connect' } },
  change: { title: 'Your call', text: 'If you could change one thing about this page so you’d use it at work, what would it be? Show where.', look: 'Open.', seq: false },
  changeSelf: { title: 'Your call', text: 'If you could change one thing about this page so you’d use it at work, what would it be?', ask: 'text', look: 'Open.', seq: false },
};

const SCRIPTS = {
  moderated: ['first', 'agents', 'waiting', 'handoff', 'yours', 'change'],
  self: ['firstSelf', 'agentsSelf', 'handoff', 'yours', 'changeSelf'],
};

// The questions at the end, the same for everyone so answers can be compared.
const FINAL = [
  { id: 'umux1', kind: 'scale', text: 'Meridian’s capabilities meet my requirements.', low: 'Strongly disagree', high: 'Strongly agree' },
  { id: 'umux2', kind: 'scale', text: 'Meridian is easy to use.', low: 'Strongly disagree', high: 'Strongly agree' },
  { id: 'agents', kind: 'choice', text: 'How many AI agents or assistants do you use in a normal week?', options: ['None', 'One', 'Two or three', 'Four or more'] },
  { id: 'which', kind: 'multi', text: 'Which ones?', options: ['ChatGPT', 'Codex', 'Claude', 'Copilot', 'Cursor', 'Gemini', 'Other'] },
  { id: 'use', kind: 'text', text: 'What would you use Meridian for, if anything?' },
  { id: 'confusing', kind: 'text', text: 'What was most confusing?' },
  { id: 'missing', kind: 'text', text: 'What’s missing before you’d use it at work?' },
  { id: 'week', kind: 'choice', text: 'Would you try it for a week?', options: ['Yes', 'Maybe', 'No'], why: true },
];

const SEQ = { text: 'Overall, how difficult or easy did you find this task?', low: 'Very difficult', high: 'Very easy' };

function script(mode) {
  return (SCRIPTS[mode] || SCRIPTS.moderated).map((id, i) => ({ n: i + 1, id, ...TASKS[id], seq: TASKS[id].seq !== false }));
}

// UMUX-Lite as a 0–100 score that lines up with SUS (Lewis, Utesch and Maher, 2013).
function umuxLite(a, b) {
  if (!(a >= 1 && a <= 7 && b >= 1 && b <= 7)) return null;
  return Math.round((0.65 * ((a + b - 2) * 100 / 12) + 22.9) * 10) / 10;
}

module.exports = { TASKS, SCRIPTS, FINAL, SEQ, script, umuxLite };
