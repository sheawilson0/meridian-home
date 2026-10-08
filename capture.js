'use strict';

// Quick capture, with a short undo. Since 6 Oct 2026 a capture lands in Stash
// as a note (Stash is the one home for thoughts); config capture.to = "vault"
// puts it back to how it was, a Markdown file in the vault Inbox. Owner is
// trying this, so the switch stays.
//
// Stash: the id is the note's Stash id. Undo deletes it into Stash's 30-day
// trash, only within 30 minutes and only for a note that came from capture.
//
// Vault: a capture is capture-<stamp>.md, where the stamp (UTC, to the second)
// is also its id. Undo moves the file to data/trash/inbox/ rather than deleting
// it (launchd may not be allowed to write to ~/.Trash), only within 30 minutes,
// and only for a regular file Meridian wrote that is still directly in the Inbox.
//
// Undo goes by the id's shape, so a vault capture made before a switch can still
// be taken back after it.

const fsp = require('fs/promises');
const path = require('path');

const ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{1,2})?$/;
const STASH_ID_RE = /^[a-z0-9]{8,20}$/;
const LABEL = { stash: 'Saved to Stash', vault: 'Saved to your vault Inbox' };
const UNDO_MS = 30 * 60 * 1000;

function stampFor(date) { return date.toISOString().replace(/[:.]/g, '-').slice(0, 19); }

// The capture time an id encodes, or null for anything malformed.
function idTime(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const [, y, mo, d, h, mi, s] = id.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const back = new Date(t);
  return back.getUTCFullYear() === +y && back.getUTCMonth() === +mo - 1 && back.getUTCDate() === +d ? t : null;
}

function fail(message, statusCode) { return Object.assign(new Error(message), { statusCode }); }

// stash: () => the Stash store (a getter, because server.js makes it later).
// to: () => 'stash' or 'vault', read on every capture.
function createCapture({ inbox, trashDir, now = () => Date.now(), undoMs = UNDO_MS, stash = () => null, to = () => 'vault' }) {
  const where = () => (to() === 'stash' && stash() ? 'stash' : 'vault');

  async function capture(text) {
    const body = String(text || '').trim();
    if (!body) throw fail('empty', 400);
    if (where() === 'stash') {
      const r = await stash().addText({ text: body, kind: 'note', source: 'capture' });
      return { ok: true, id: r.item.id, where: 'stash', label: LABEL.stash, kind: r.item.kind, undoUntil: new Date(r.item.created + undoMs).toISOString() };
    }
    const d = new Date(now());
    const stamp = stampFor(d);
    const md = `---\ncaptured: ${d.toISOString()}\nsource: meridian\n---\n\n${body}\n`;
    await fsp.mkdir(inbox, { recursive: true });
    // Two captures in the same second get -2, -3 rather than overwriting.
    for (let n = 1; n < 100; n++) {
      const id = n === 1 ? stamp : `${stamp}-${n}`;
      const file = path.join(inbox, `capture-${id}.md`);
      try {
        await fsp.writeFile(file, md, { flag: 'wx' });
        return { ok: true, id, file, where: 'vault', label: LABEL.vault, undoUntil: new Date(d.getTime() + undoMs).toISOString() };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw fail('too many captures this second', 429);
  }

  async function undoStash(id) {
    const store = stash();
    if (!store) throw fail('Stash is not running', 503);
    let it;
    try { it = await store.get(id); } catch { throw fail('that capture is no longer in Stash', 404); }
    if (it.source !== 'capture') throw fail('that was not a quick capture', 409);
    if (it.deleted) throw fail('that capture is no longer in Stash', 404);
    if (now() - it.created > undoMs) throw fail('that capture is more than 30 minutes old, so it stays', 409);
    await store.remove(id);
    return { ok: true, id, trashed: 'stash' };
  }

  async function undo(id) {
    if (typeof id === 'string' && STASH_ID_RE.test(id)) return undoStash(id);
    const at = idTime(id);
    if (at === null) throw fail('bad capture id', 400);
    const age = now() - at;
    if (age > undoMs) throw fail('that capture is more than 30 minutes old, so it stays', 409);
    if (age < -60 * 1000) throw fail('bad capture id', 400);
    const name = `capture-${id}.md`;
    const file = path.join(inbox, name);
    let st;
    try { st = await fsp.lstat(file); } catch { throw fail('that capture is no longer in the Inbox', 404); }
    if (!st.isFile()) throw fail('not a capture file', 409);
    const [realInbox, realDir] = await Promise.all([fsp.realpath(inbox), fsp.realpath(path.dirname(file))]);
    if (realInbox !== realDir) throw fail('not in the Inbox', 409);
    const head = (await fsp.readFile(file, 'utf8')).slice(0, 400);
    if (!/^---\n[\s\S]*?^source: meridian$/m.test(head)) throw fail('that file was not captured by Meridian', 409);
    await fsp.mkdir(trashDir, { recursive: true });
    let dest = path.join(trashDir, name);
    for (let n = 2; n < 100; n++) {
      try { await fsp.access(dest); dest = path.join(trashDir, `capture-${id}.${n}.md`); } catch { break; }
    }
    try {
      await fsp.rename(file, dest);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fsp.copyFile(file, dest);
      await fsp.unlink(file);
    }
    return { ok: true, id, trashed: dest };
  }

  return { capture, undo };
}

module.exports = { createCapture, idTime, stampFor, ID_RE, UNDO_MS };
