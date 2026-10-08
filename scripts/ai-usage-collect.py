#!/usr/bin/env python3
"""Collect AI coding token metadata only. No prompts, responses, credentials or chat bodies.

A copy of data/ai-usage/history/sol-2026-10-01/collect_usage.py (the Sol collector),
with these changes for Meridian's nightly history job (scripts/ai-usage-history.js):

  --since YYYY-MM-DD  Skip files last modified before the day before `since`, and drop
                      events whose UTC date is before that day. The one-day margin keeps
                      every event of local day `since`; the caller trims to local days.
  --end-date          Inclusive UTC-date cutoff. Defaults to today.
  --exports           Also count downloaded chat exports in ~/Downloads (titles and
                      message counts only). Off by default; the history job never needs it.
  No 2026-01-01 floor, so the collector keeps working next year.
  Codex events carry `plan_type` when the token_count payload's rate_limits has one.
  Null token counts are read as 0 instead of crashing.

Runs on Python 3.9 (both Macs). Usage:
  python3 scripts/ai-usage-collect.py --since 2026-09-21 > events.json
  ssh macbook-1 'python3 - --since 2026-09-21' < scripts/ai-usage-collect.py > events.json
"""
import argparse
import hashlib
import json
import socket
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


def count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def collect(home=None, end_date=None, since=None, exports=False):
    started = time.time()
    home = Path(home or Path.home())
    end_date = end_date or date.today().isoformat()
    floor, min_mtime = '', 0.0
    if since:
        margin = date.fromisoformat(since) - timedelta(days=1)
        floor = margin.isoformat()
        min_mtime = time.mktime(margin.timetuple())  # local midnight, the day before `since`
    roots = []
    for profile in sorted(home.glob('.claude*')):
        if (profile / 'projects').is_dir():
            roots.append((profile / 'projects', 'Claude Code', profile.name))
    desktop = home / 'Library/Application Support/Claude'
    for folder in ['local-agent-mode-sessions', 'claude-code-sessions', 'claude-code']:
        if (desktop / folder).is_dir():
            roots.extend((p, 'Claude Code', 'Claude Desktop') for p in (desktop / folder).glob('**/projects') if p.parent.name == '.claude')
    for profile in sorted(home.glob('.codex*')):
        for name in ['sessions', 'archived_sessions']:
            if (profile / name).is_dir():
                roots.append((profile / name, 'Codex', profile.name))
    events = {}
    inventory = []
    malformed = 0
    inherited_tokens_excluded = 0
    skipped_files = 0
    for root, provider, profile in roots:
        files = list(root.rglob('*.jsonl'))
        scanned = 0
        for path in files:
            if min_mtime:
                try:
                    if path.stat().st_mtime < min_mtime:
                        skipped_files += 1
                        continue
                except OSError:
                    continue
            scanned += 1
            session, cwd, model, previous, forked = path.stem, '', 'unknown', None, False
            try:
                with path.open('rb') as source:
                    for line in source:
                        if not any(term in line for term in [b'"usage"', b'"token_count"', b'"session_meta"', b'"turn_context"']):
                            continue
                        try:
                            row = json.loads(line)
                        except (ValueError, UnicodeError):
                            malformed += 1
                            continue
                        if not isinstance(row, dict):
                            continue
                        timestamp = row.get('timestamp') or ''
                        if not isinstance(timestamp, str):
                            timestamp = ''
                        if provider == 'Claude Code':
                            message = row.get('message') or {}
                            if not isinstance(message, dict):
                                continue
                            usage = message.get('usage') or {}
                            if row.get('type') != 'assistant' or not isinstance(usage, dict) or not usage:
                                continue
                            model = message.get('model') or 'unknown'
                            if model.startswith('<'):
                                continue
                            sid = row.get('sessionId') or session
                            cache = usage.get('cache_creation') or {}
                            if not isinstance(cache, dict):
                                cache = {}
                            tokens = [count(usage.get('input_tokens')), count(usage.get('cache_read_input_tokens')),
                                      count(usage.get('cache_creation_input_tokens')), count(usage.get('output_tokens'))]
                            key = 'claude:' + (message.get('id') or hashlib.sha256(line).hexdigest())
                            event = {'key': key, 'provider': provider, 'profile': profile, 'session': sid,
                                     'timestamp': timestamp, 'cwd': row.get('cwd', ''), 'model': model, 'tokens': tokens,
                                     'cache_write_1h': count(cache.get('ephemeral_1h_input_tokens')),
                                     'geo': usage.get('inference_geo'), 'speed': usage.get('speed')}
                        else:
                            payload = row.get('payload') or {}
                            if not isinstance(payload, dict):
                                continue
                            if row.get('type') == 'session_meta':
                                session = payload.get('id', session)
                                cwd = payload.get('cwd', cwd)
                                model = payload.get('model', model)
                                forked = bool(payload.get('forked_from_id') or payload.get('parent_thread_id'))
                                continue
                            if row.get('type') == 'turn_context':
                                model = payload.get('model', model)
                                cwd = payload.get('cwd', cwd)
                                continue
                            info = payload.get('info') or {}
                            if not isinstance(info, dict):
                                continue
                            totals = info.get('total_token_usage') or {}
                            if payload.get('type') != 'token_count' or not isinstance(totals, dict) or not totals:
                                continue
                            fields = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens']
                            current = [count(totals.get(k)) for k in fields]
                            if previous is None and forked:
                                last = info.get('last_token_usage') or {}
                                if not isinstance(last, dict):
                                    last = {}
                                delta = [count(last.get(k)) for k in fields]
                                inherited_tokens_excluded += max(0, current[0] + current[3] - delta[0] - delta[3])
                            elif previous is None or current[0] < previous[0]:
                                delta = current
                            else:
                                delta = [max(0, a - b) for a, b in zip(current, previous)]
                            previous = current
                            tokens = [max(0, delta[0] - delta[1]), delta[1], delta[2], delta[3]]
                            fingerprint = json.dumps([timestamp, model, totals], sort_keys=True).encode()
                            key = 'codex:' + hashlib.sha256(fingerprint).hexdigest()
                            limits = payload.get('rate_limits')
                            plan_type = limits.get('plan_type') if isinstance(limits, dict) else None
                            event = {'key': key, 'provider': provider, 'profile': profile, 'session': session,
                                     'timestamp': timestamp, 'cwd': cwd, 'model': model, 'tokens': tokens,
                                     'cache_write_1h': 0, 'geo': None, 'speed': info.get('service_tier'),
                                     'plan_type': plan_type if isinstance(plan_type, str) and plan_type else None}
                        if not timestamp or not floor <= timestamp[:10] <= end_date or not sum(tokens):
                            continue
                        # Claude may repeat a message ID with more complete streaming usage.
                        existing = events.get(key)
                        if existing is None or sum(tokens) > sum(existing['tokens']):
                            events[key] = event
            except OSError:
                malformed += 1
        inventory.append({'root': str(root), 'provider': provider, 'files': len(files), 'scanned': scanned})
    conversation_exports = collect_exports(home, end_date) if exports else []
    return {'host': socket.gethostname(), 'collector': 'meridian-ai-usage-collect/1', 'period_end': end_date,
            'since': since, 'generated_at': datetime.now(timezone.utc).isoformat(),
            'scan_ms': int((time.time() - started) * 1000), 'inventory': inventory,
            'skipped_files': skipped_files, 'malformed_lines': malformed,
            'inherited_tokens_excluded': inherited_tokens_excluded,
            'events': list(events.values()), 'conversation_exports': conversation_exports}


def collect_exports(home, end_date):
    exports = []
    for path in (home / 'Downloads').glob('**/conversations.json'):
        try:
            data = json.loads(path.read_text())
            if not isinstance(data, list):
                continue
            for chat in data:
                if not isinstance(chat, dict):
                    continue
                if 'chat_messages' in chat:
                    provider = 'Claude'
                    messages = chat.get('chat_messages') or []
                    dated = [m for m in messages if '2026-01-01' <= m.get('created_at', '')[:10] <= end_date]
                    roles = [m.get('sender') for m in dated]
                    record = {'id': chat.get('uuid'), 'title': chat.get('name'),
                              'created_at': chat.get('created_at'), 'updated_at': chat.get('updated_at')}
                elif isinstance(chat.get('mapping'), dict):
                    provider = 'ChatGPT'

                    def iso(value):
                        return datetime.fromtimestamp(value, timezone.utc).isoformat() if isinstance(value, (int, float)) else ''
                    messages = [node.get('message') for node in chat['mapping'].values() if isinstance(node, dict) and isinstance(node.get('message'), dict)]
                    dated = [m for m in messages if '2026-01-01' <= iso(m.get('create_time'))[:10] <= end_date]
                    roles = [(m.get('author') or {}).get('role') for m in dated]
                    record = {'id': chat.get('id') or chat.get('conversation_id'), 'title': chat.get('title'),
                              'created_at': iso(chat.get('create_time')), 'updated_at': iso(chat.get('update_time'))}
                else:
                    continue
                if not dated:
                    continue
                exports.append({**record, 'provider': provider,
                                'user_messages': sum(role in ['human', 'user'] for role in roles),
                                'assistant_messages': sum(role == 'assistant' for role in roles), 'path': str(path)})
        except (OSError, ValueError):
            pass
    return exports


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--home')
    parser.add_argument('--since', help='YYYY-MM-DD: skip older files and events (keeps a one-day margin)')
    parser.add_argument('--end-date', default=None, help='Inclusive UTC YYYY-MM-DD cutoff, default today')
    parser.add_argument('--exports', action='store_true', help='Also count chat exports found in ~/Downloads')
    args = parser.parse_args()
    if args.since:
        date.fromisoformat(args.since)
    print(json.dumps(collect(args.home, args.end_date, args.since, args.exports), separators=(',', ':')))
