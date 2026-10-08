# First run: current blockers and proposed path

A public v0.1 should start with `node server.js` on a fresh clone with Node 22, no config, no private files, no accounts and no optional tools. That is the acceptance criterion. It is not true of the current checkout.

## What is built tonight

- Scripts-only `package.json`: start, test, doctor and watch-mode dev. No dependencies or module-mode change.
- `config.example.json`: empty sources, non-personal paths and an explicit empty calendar identity; no live URLs, tokens or accounts. Pushes and Stash summaries are disabled.
- `scripts/doctor.js`: checks Node, config/backup/required shapes, loopback port and optional executables. It never starts a job, invokes a CLI, reads credentials, creates data, stops a process or contacts an external service. Exit 1 means a checked startup blocker; optional degradations are WARN rows.
- Portable setup/ledger path defaults and a calendar identity override preserving the owner's omitted-key default.

This is install groundwork, not an implemented onboarding screen. The observed fresh start fails at `brief-art.js`'s import of the ignored private collection, before config or the HTTP listener. Supplying the safe example alone still cannot fix that.

The perf-server agent owns boot switches. Their tested, separate-branch `MERIDIAN_JOBS=off` contract is loopback-only, cached/disk-only and rejects mutations with HTTP 503. It is suitable for safe read-only review after merging, not for an editable “Start empty” experience. Do not turn jobs on merely to make demo editing work, because today's collectors discover local user files and credentials.

## Proposed screen and lifecycle

No new design is specified here; use the existing dashboard's approved typography and controls when implementation is reviewed.

1. Parse/validate config before loading any optional connector. With no config and no data, bind loopback and serve a first-run gate; core assets/stores have no import-time dependence on personal files.
2. Offer **Explore with demo data** and **Start empty**. Explain that demo data is made up and neither choice connects accounts or scans the home directory.
3. Explore creates a separate, durable demo profile from `demo.js`/tester sandbox data. Use only synthetic data and assets. Disable network source fallthrough, CLI launches, recording and real account discovery. Label the profile as demo, and let the user reset/discard it. Choosing Start empty later creates a new profile rather than mixing fictional and real records.
4. Start empty atomically creates owner-only storage and empty to-dos, shelf, Stash, drafts, journal, projects, deadlines and classes. It asks for a display name and location/timezone only if needed. Nothing searches for an Obsidian vault, provider logs or work projects without explicit setup.
5. Save a versioned profile marker/config, separate from `data/` contents, so an upgraded existing owner's install bypasses onboarding. Missing new keys use legacy compatibility defaults for that owner profile only; public profiles use safe defaults.
6. Let `/connect` enable generic connectors one by one. Each shows prerequisites, data access, network destinations and expected cost. No calendar, finance, cloud voice, ntfy or client integration is enabled implicitly.
7. Offer the proposed owner passphrase/token setup before non-loopback access. Tailscale setup is optional and explicit. No first-run script modifies Serve/Funnel or installs a LaunchAgent.

Use a profile resolver (`legacy`, `empty`, `demo`) plus an explicit connector enable list. Avoid a large set of unrelated boot environment flags as the long-term user experience. Preserve the existing private config and data without rewriting it to the public example.

## Implementation order and tests

First remove import-time private-file reads and centralise validated paths/config. Then make the core server editable with connectors off; that is a different mode from perf-server's read-only job suppression. Then add the onboarding gate and demo/empty transitions.

Meaningful release checks:

- Clone into a path containing spaces; use a temporary HOME and empty data/config. `node server.js` serves setup without credentials, shell tools or outbound sockets.
- Start empty, create/complete a to-do, save/reorder a link, save a Stash note/file, create/edit/approve a draft, and add/read a journal entry; restart and verify persistence.
- Explore, edit/reset, restart, then switch to an empty profile. No demo record crosses into real data. No request falls through to the owner's backend.
- Old private config, old data and absent new fields preserve the owner's existing startup, classes, calendars, account identities, appearance and jobs. The first-run gate never appears over a valid legacy install.
- Missing Tailscale/gh/Claude/Codex/Chrome/swiftc yields clear optional statuses. Linux basic stores must be tested before claiming Linux support; macOS enrichment is explicitly optional.
- Jobs-off returns 503 for writes, opens no collectors/children/network, and honours isolated paths in every module. Confirm no reads/writes escape to default data/home paths.

`node --test test/` currently fails test discovery on Node 22.22.3. Use `npm test` or `node --test test/*.test.js`. The existing suite also depends on ignored private fixtures and wall-clock time; replace those dependencies with synthetic fixtures before a public CI gate.
