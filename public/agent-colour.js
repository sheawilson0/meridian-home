// Each agent's own colour (8 Oct 2026), so "Grokbot is editing" doesn't look
// like Dot. An agent is whatever name it connects as (/mcp?as=Grokbot); the
// known ones have a fixed colour and any other name always gets the same one
// from the palette. Used by /draft and /drafts.
(function () {
  const KNOWN = { dot: '#8ea2ff', grokbot: '#ef9a6c', muze: '#c99af2' };
  const PALETTE = ['#8ea2ff', '#ef9a6c', '#c99af2', '#6cc3b8', '#e7b85c', '#e98bb0'];
  window.agentColour = function (name) {
    const k = String(name || '').trim().toLowerCase();
    if (!k || k === 'agent' || k === 'you') return KNOWN.dot;
    if (KNOWN[k]) return KNOWN[k];
    let h = 0;
    for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };
})();
