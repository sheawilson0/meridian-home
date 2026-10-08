# Configuration reference

Audit of the code on `overnight/oss`, 8 October 2026. This documents implemented reads, including legacy personal defaults. It is not a claim that a fresh clone can already boot. The private config was not read or copied.

`server.js` reads `<checkout>/config.json` once at startup into `CONFIG`. An unreadable or invalid primary file falls back to `config.json.bak`. If neither exists, startup fails. There is no schema, deep default merge, environment interpolation or general `~` expansion. Edits to disk require a restart. Settings callbacks described as “read every time” read the in-memory object, not the file. Notification API edits update that object and persist it with a backup.

`config.example.json` supplies non-personal placeholders, required nested shapes, disabled pushes and disabled Stash summaries. Empty values are intentional. Keep the resulting `config.json` private. The example does not disable every legacy collector, remove seeded classes or supply the missing artwork collection; see [first run](first-run.md).

## Boot switches from perf-server

These belong to the separate perf-server change, not this branch's implementation. Their final BOARD NOTE reports the contract tested on that branch, including 3/3 sandbox safety tests. They become available here after the coordinator merges that change.

| Variable | Type / default | Intended effect |
| --- | --- | --- |
| `MERIDIAN_PORT` | Integer string; `config.port`, then `4980` | Override the listener and self-request port. |
| `MERIDIAN_CONFIG` | Path; `<checkout>/config.json` | Select private config and its adjacent `.bak`. |
| `MERIDIAN_DATA` | Directory; `<checkout>/data` | Isolate mutable data. Cache, logs, audit, delegations and default ledger live beside that directory. Use a separate parent directory too, not two data directories sharing a parent. |
| `MERIDIAN_JOBS=off` | Literal switch; jobs normally on | Loopback-only cached/disk mode, no collectors, child processes or outbound requests. Writes are refused with HTTP 503. This is a review mode, not an editable “Start empty” install. |
| `MERIDIAN_SANDBOX=1` | Literal switch; unset | The same loopback/read-only jobs-off boundary, regardless of MERIDIAN_JOBS. Does not create an editable demo/empty profile. |

Relative boot override paths are resolved against the process working directory in the perf-server runtime. `doctor.js` recognises the selected config and loopback port. It does not start the server or claim that the overrides are implemented on this branch. It recognises the runtime.js integration by inspecting source without importing guards, checks the selected artwork path when present, and treats an absent catalogue as optional only in merged jobs-off/sandbox mode. Source recognition is not a runtime isolation test.

## Server and trust

“No default” means the code does not supply a safe value. Parent objects listed here contain the documented leaves below.

| Key | Type | Current default / omission | Purpose and reader |
| --- | --- | --- | --- |
| `port` | Integer, 1–65535 | `4980` via `||` | HTTP listeners, origin guard, self HTTP calls and fleet self-protection; `server.js`. `0` is not an ephemeral-port request. |
| `refreshSeconds` | Positive number | `45` via `||` | State refresh interval; `server.js`. Zero cannot disable refresh. |
| `machine` | String | No default | Passed into `/api/state`; `server.js`. Does not select where jobs run. |
| `location` | Object | No default | Passed into `/api/state`; `server.js`. |
| `location.name` | String | Phone falls back to the legacy city | Read by `public/phone.js`. The desktop and `almanac.js` still hardcode their weather location. Other location fields are not config-driven weather settings yet. |
| `token` | String, secret | Unset denies non-trusted requests | Broad dashboard/API token; `server.js`, passed to `drafts.js`. Local/tailnet access bypasses it. See [security](security.md). |
| `mcpToken` | String, secret | Unset | Separate cloud MCP token; `server.js` passes it to `drafts.js`. It opens `/mcp`, not all APIs. |

## Local sources and optional personal collectors

| Key | Type | Current default / omission | Purpose and reader |
| --- | --- | --- | --- |
| `board` | Object | Required, unguarded | Legacy Markdown board connector; `server.js`. |
| `board.dir` | Path string | No default | Enumerate board cards, read card files, update delegated card state; `server.js`. Missing directories return a collector error. |
| `fleet` | Object | Required, unguarded | Health checks and launchd integration; `server.js`. |
| `fleet.services` | Array of objects | `[]` only if parent exists | Local services to probe; `server.js`, `fleet-pause.js`. |
| `fleet.sites` | Array of objects | `[]` only if parent exists | Sites to probe; `server.js`, `fleet-pause.js`. |
| `fleet.services[].name`, `fleet.sites[].name` | String | No default | Stable lookup/display name for probes and pause matching; `server.js`, `fleet-pause.js`. |
| `fleet.services[].url`, `fleet.sites[].url` | HTTP(S) URL string | No default | Probe URL; `server.js`. Other fields are carried through as display metadata, not independent required configuration. |
| `git` | Object | Required, unguarded | Git status collector; `server.js`. |
| `git.roots` | Array of strings | No default | Repository roots to scan; `server.js`. This reader replaces `~` with the home path. Use `[]` to avoid a scan. |
| `brain` | Object | Required by reads | Legacy graph integration; `server.js`. |
| `brain.graphPath` | Path string | No default | JSON graph file used for summary and search; `server.js`. |
| `threads` | Object | Required, unguarded URL read | Legacy local Threads integration; `server.js`. |
| `threads.url` | URL string | No default | Base URL for `/api/tasks`; `server.js`. `""` yields a failed optional fetch, not an enabled connector. |
| `threads.configPath` | Path string | No default | Reads another app's `.token` for the Threads request; `server.js`. Its read is caught when missing. |
| `vaultInbox` | Path string | No default; needed for journal path derivation | Capture/feedback Markdown output; `server.js`, passed to `capture.js` and `connect.js`. Prefer explicit private directories; capture defaults to Stash. |
| `ledger` | Object | Optional | Nightly Markdown source; `server.js`. |
| `ledger.dir` | Path string | `<checkout>/ledger` | Ledger reads and journal sync; `server.js`. |
| `ledger.schedule` | String or null | `null` | Display metadata; `server.js`. Does not schedule a job. The shipped shell/LaunchAgent still uses a fixed 23:40 schedule. |
| `meetings` | Object | Optional | Read-only meeting-note source; `server.js`. |
| `meetings.dir` | Path string | Missing/empty returns no notes | Directory of meeting Markdown files; `server.js`. |
| `tailscale` | Object | Optional | Tailscale discovery fallback; `server.js`. |
| `tailscale.hostname` | Hostname string | Discover from `tailscale status`; otherwise null | Links, origin checks and icon matching; `server.js`, passed to `brief-icon.js`. Does not authenticate a user. |
| `exampleappFeedback` | Object | `{}` | Personal feedback runner integration; `server.js`. |
| `exampleappFeedback.stateFile` | Path string | Empty, no implicit home lookup | Read runner queue/results; `server.js`. Explicit configuration is required. |
| `exampleappFeedback.cli` | Path string | Empty, disabled | CLI for feedback decisions; `server.js`. Empty string disables the runner. |
| `exampleappFeedback.node` | Executable path string | `process.execPath` | Node executable for that connector; `server.js`. |
| `campaignSnapshot` | Object | `{}` | Personal campaign metrics connector; `server.js`. |
| `campaignSnapshot.dashboardUrl` | HTTP(S) URL string | Empty/unset disables the fetch | JSON endpoint to fetch; `server.js`. |
| `campaignSnapshot.dashboardPage` | URL string | `dashboardUrl` | Link shown with the metrics; `server.js`. |
| `campaignSnapshot.refreshMinutes` | Positive number | `10` via `Number(...) ||` | Metrics cache lifetime; `server.js`. |

## Calendars and journal

| Key | Type | Current default / omission | Purpose and reader |
| --- | --- | --- | --- |
| `calendar` | Object | `{}` | Published ICS sources; `server.js`, passed to `calendars-store.js`. |
| `calendar.icsUrl` | String or feed object | Unset | Single feed. Object accepts `url`, `label`; same shape as `icsUrls[]`. |
| `calendar.icsUrls` | Array of strings or feed objects | `[]` | Additional feeds; `server.js`. Strings get host-derived labels. Non-array truthy values can throw. |
| `calendar.icsUrls[].url`, `calendar.icsUrl.url` | HTTPS/webcal URL string, secret | Required for object entries | Published calendar feed; `calendars-store.js`. Store privately, never in docs/logs. |
| `calendar.icsUrls[].label`, `calendar.icsUrl.label` | String | Guessed from host | Config feed label; `calendars-store.js`. Feed colour/visibility overrides live in `data/calendars.json`. |
| `calendar.workEmail` | String | Legacy owner's work address via `??` | Calendar response identity; `server.js`. Set `""` to omit that identity, keeping `selfEmails` and inferred Google owners. The private checkout retains its legacy fallback; the public exporter changes it to empty. Add the owner value to private config before changing that fallback. |
| `calendar.selfEmails` | Array of strings | `[]` | Additional attendee identities; `server.js` passes them to `calendar-ics.js`. Feed owner addresses are inferred separately. |
| `calendar.windowDays` | Positive number | `7` via `||` | ICS expansion/upcoming horizon; `server.js`, passed to `calendar-ics.js`. |
| `calendar.refreshMinutes` | Positive number | `10` via `||` | Calendar refresh cache lifetime; `server.js`. |
| `journal` | Object | Optional | Journal sync/classification; `server.js`. |
| `journal.vaultDir` | Path string | Sibling of `vaultInbox`: `Journal/daybook` | Markdown daybook exports; `server.js`. Without this key, a missing `vaultInbox` causes a path type error. |
| `journal.tracks` | Object | `{}` | Classifier overrides; `server.js`. |
| `journal.tracks.uni` | Array of regex strings | Generic uni keywords in `DEFAULT_TRACK_RULES` | Case-insensitive rules checked first; `server.js`. `[]` disables those matches; invalid regex throws. |
| `journal.tracks.work` | Array of regex strings | Generic client/Outlook/Slack keywords | Work rules checked after uni; unmatched items become personal; `server.js`. `[]` disables those matches. |

Classes are **not** config.json keys. New `data/calendars.json.classes` starts empty. Valid existing timetables load without rewriting their items, term or tutor fields. The timezone is fixed to `Europe/London`, also outside config.json.

## Notifications, captures and agents

| Key | Type | Current default / omission | Purpose and reader |
| --- | --- | --- | --- |
| `notify` | Object | Auto-created when `.topic` is falsy | Push settings; `server.js`, `pings.js`. See the warning below. |
| `notify.provider` | String | `ntfy` | Display/status metadata; `server.js`. No alternate provider dispatch is implemented. |
| `notify.url` | HTTPS base URL string | `https://ntfy.sh` | JSON push endpoint; `server.js`. |
| `notify.topic` | String, secret | Random `meridian-` topic at boot | ntfy topic. Missing/empty causes the entire notify object to be replaced and `enabled:true`, even if you supplied `enabled:false`. |
| `notify.enabled` | Boolean | Enabled unless exactly `false` | Suppresses pushes; `server.js`. Supply a non-empty placeholder topic plus `false` for current-code local diagnostics. |
| `notify.events` | Array of strings | Auto-created `delegation`, `fleet`, `deadline` | Legacy kinds filter; `pings.js`; edited by `server.js`. An empty array disables legacy kinds only, not all new kinds. |
| `notify.muted` | Array of strings | `[]` | Muted kinds: `needs`, `meeting`, `tell`, `reminder`, `delegation`, `fleet`, `deadline`; `pings.js`. UI edits cannot mute `reminder`. |
| `notify.quiet` | Object | `{on:true, from:"23:00", to:"08:00"}` | Quiet-hours policy; `pings.js`. Server local time, not the almanac timezone. |
| `notify.quiet.on` | Boolean | True unless exactly `false` | Enable quiet hours; `pings.js`. |
| `notify.quiet.from`, `notify.quiet.to` | `HH:MM` strings | `23:00`, `08:00` | Cross-midnight supported; `pings.js`. Reminders and priority 5 bypass quiet hours. |
| `nudges` | Object | Default settings below | Meeting reminders; `meeting-nudges.js`, selected by `server.js`. |
| `nudges.enabled` | Boolean | `true` | Enable reminder generation. Pushes also need enabled notify settings. |
| `nudges.minutes` | Array of numbers, 0–180 | `[10,1]` | Lead times. Invalid/empty arrays fall back to the default; duplicates removed. |
| `nudges.skip` | Array of regex strings | `[]` | Meeting exclusions; `meeting-nudges.js`. Empty array removes exclusions. |
| `capture` | Object | Optional | Capture destination; `server.js`, passed to `capture.js`. |
| `capture.to` | `"stash"` or `"vault"` | `"stash"` | Where notes go. `"vault"` requires a usable `vaultInbox`. |
| `stash` | Object | Optional | Stash AI access/settings; `server.js`. |
| `stash.agentHiddenSpaces` | Array of strings | `["private"]` | Names hidden from Stash MCP; `stash-tools.js`. `[]` exposes every space through its tools. This is not file/API encryption or a separate user boundary. |
| `stash.summary` | Object | `{}` | Optional note summariser; `stash-summary.js`. |
| `stash.summary.engine` | `"claude"`, `"command"`, `"off"` | `"claude"` | Missing/unknown values use Claude; `stash-summary.js`. Public empty installs should use `off`. |
| `stash.summary.model` | String | `"haiku"` | Existing Claude summariser's CLI model; `stash-summary.js`. This documents current code, not a recommendation to change model policy. |
| `stash.summary.command` | Array of executable/argument strings | No command, summaries return null | For engine `command`, note/instructions on stdin, summary on stdout; `stash-summary.js`. Do not expose config writes to untrusted users. |
| `delegations.sandboxPreviews` | Boolean or `"scripts-off"` | Off unless exactly `true` or `"scripts-off"` | Opt-in CSP sandbox and nosniff for delegation HTML/SVG/XML responses; `server.js`. `true` keeps scripts, popups, forms and modals with an opaque origin. `"scripts-off"` uses bare `sandbox` for static mockups. Storage/cookies and same-origin API reads are unavailable to preview scripts; the native bridge checks frame origin too. Edit config and restart the daemon, then reload previews. This does not isolate network requests or privileged pages navigated to later. |
| `tell` | Object | Optional | Tell and to-do ranking model; `server.js`. |
| `tell.model` | String | `"sonnet"` | CLI model passed to `tell.js` and `todo-rank.js`. No runtime validation against the dashboard model registry. |
| `voice` | Object | `{}` | Voice session limits; `server.js` passes it to `voice.js`. |
| `voice.dailyCalls` | Positive number | `12` via `Number(...) ||` | New sessions per UTC day; `voice.js`. Counter is in memory and resets on restart. |
| `voice.maxMinutes` | Positive number | `15` via `Number(...) ||` | Limit advertised to the voice browser; `voice.js`, `public/voice/voice-page.js`. Zero cannot disable voice. |
| `voice.idleMinutes` | Positive number | `3` via `Number(...) ||` | Idle limit advertised to browser; same readers. No server auth policy. |

The voice API key comes from `OPENAI_API_KEY`, then macOS Keychain service `meridian-openai`. Neither the key nor the service name is a config.json key today. Doctor deliberately does not read either. The ledger/model registry, Money accounts, timetable and UI Spaces have separate files, not additional hidden config.json keys.

## Silent assumptions to remove before v0.1

1. Missing `config.json` and `.bak` cannot reach a setup screen. Invalid JSON falls back without schema validation.
2. `board`, `fleet`, `git.roots`, `brain`, `threads`, and `vaultInbox` are used without a complete safe schema/default layer. Some collectors catch failures or retain stale state; the missing shapes are still not a supported empty install.
3. Fleet arrays must contain objects with stable `name` and URL values; calendar feeds must have usable URL strings. Journal regex arrays must be valid. `null`, strings instead of arrays, and malformed objects are not consistently rejected at boot.
4. `brief-art.js` imports ignored `data/brief-art/collection.json` before the config read. No private file should be required just to start core.
5. Missing notify.topic overrides an explicit disable. New installs need opt-in pushes.
6. Machine labels, weather location, usernames, calendars/classes, personal prompts and account attribution remain embedded elsewhere. `config.example.json` does not cure those defaults.
7. Several modules own `__dirname/data` paths and independent schedules. A boot override must reach all of them and restore exported functions; it must not merely move server.js's file constants.
8. Unknown config keys are ignored silently. Proposed connector settings, owner profile, timezone, auth mode and `voice.keychainService` are proposals, not supported keys.

A separate drafts-e change adds sender account choices, documented from their BOARD NOTE. It is not read on this branch until that change is merged:

| Key | Type | Default | Reader |
| --- | --- | --- | --- |
| `drafts` | Object | Optional | `server.js`, passed to `drafts.js` in drafts-e's change. |
| `drafts.accounts` | Array of objects | `[]` | Email account choices; `drafts.js`. No accounts are seeded. |
| `drafts.accounts[].id` | String | No default | Stable account identifier; `drafts.js`. |
| `drafts.accounts[].label` | String | No default | Display label; `drafts.js`. |

Use `"drafts": { "accounts": [] }` in a public profile after merging. Do not infer or copy live sender accounts.

## Optional private defaults

| Key | Type | Default | Reader |
| --- | --- | --- | --- |
| `preferences.sources` | Array of `{path,scope,label,headings}` | `[]` | Approved preferences catalogue in `server.js`. `~/` resolves under the selected home; relative paths under the checkout. No request can choose a path. |
| `journal.areas` | String array | Uni, Work, Meridian, Personal | `journal-store.js`, only when stored areas are absent/empty. |
| `journal.areaAliases` | Array of `[regex,label]` | Meridian and Personal aliases | Ledger heading canonicalisation in `server.js`. |
| `links.categories` | String array | Work, Meridian, Tools, Personal | `links-store.js`, only when stored categories are absent/empty. |
| `links.categoryRules` | Array of `[regex,label]` | Meridian alias | Local-server classification in `server.js`. |
| `money.approvedClaims` | `{version,claims}` | `{}`, creates nothing | Manual seed action only. Claims accept `key,who,amount,note,senderNames,category`; existing seed versions remain idempotent. Never ship real records. |
| `money.agentUrl` | URL string | Local loopback in setup helper | User-run private Money setup, supplies the generated runner URL. Existing runners remain unchanged. |
| `heartHealth` | Object | `{}`, disabled | Optional campaign collector. Explicit `project,scope,hostname,cli,from,dashboardUrl,answersFrom` retain an owner's integration. No project is inferred. |

Move existing owner defaults into private config before merging. The coordinator's compatibility values are private evidence, never public examples. Keep any existing explicit overrides.
