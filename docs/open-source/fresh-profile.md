# Editable first run

With Node 22 installed, run `node server.js` and open `http://127.0.0.1:4980/command`.
No config, artwork, account or optional CLI is needed. To-dos, Stash notes and files,
drafts, links, journal entries and dashboard preferences use the existing HTTP stores.
Their edits and deletions survive a restart.

A missing config and missing backup create a version-1 `empty` profile from
`config.example.json`, with every optional connector off. The server writes config
and backup atomically, with mode 0600, on first boot. This preserves the safe profile
marker over restarts, including when a stranger has other tools installed later.
Local requests retain the existing loopback trust and Origin check; no write token
is required or generated. Portable profiles listen only on loopback.

An existing config without the profile marker keeps the legacy defaults, jobs,
routes and state structure. A remaining backup is recovered as an existing install,
not replaced with empty defaults. Neither owner data nor owner config is migrated
by this change. Invalid portable config shapes fail before optional modules load.

`MERIDIAN_CONFIG`, `MERIDIAN_DATA` and `MERIDIAN_PORT` retain their meanings.
Without overrides, data stays in `<checkout>/data` for both profiles. This is a
conservative first release choice: `runtime.defaultDataDir()` is the single place
to adopt a platform data directory later. When selecting a separate data directory,
select a separate parent too, because cache, logs, audit and delegation storage sit
beside it. Select the config path separately. Relative overrides resolve against
working directory. Hand-editing config requires a restart; the setup API below
applies supported connector changes live.

`MERIDIAN_JOBS=off` and `MERIDIAN_SANDBOX=1` remain read-only. They still reject
writes with 503 and suppress external work. They are separate from an editable
portable profile whose connectors are disabled.

## Local demo

Run `npm run demo`, or `MERIDIAN_DEMO=1 node server.js`. Change the port with
`MERIDIAN_PORT` if another Meridian is running. The demo ignores the config and data
path overrides, creates its own temporary profile, and seeds the existing fictional
world from `demo.js`. Core edits use the same real stores as an empty profile.
`/api/demo/*` also reaches those isolated editable stores. No account discovery,
collector or enrichment is enabled. Normal exit, Ctrl-C and SIGTERM discard the
profile. SIGKILL cannot run cleanup, so an interrupted OS process can leave a
`meridian-demo-*` directory in the system temporary directory, never in real storage.
The original owner `/api/demo/*` recording mode is unchanged.

## Setup information and connector opt-in

Only portable profiles add `state.setup`, with `fresh`, `demo`, and a connector map.
Each connector has `enabled`, `configured` and `reason`. `fresh` means the primary
config was absent at this boot. These are small startup prerequisite checks, not
proof an account is signed in. They run no CLI or network request. Reasons contain
no secret values. No onboarding screen is included.

For an optional connector, use the setup API, or set
`connectors.<name>.enabled` to `true` in the profile config, supply the corresponding
settings/tool/file below, and restart. Account credentials still use each module's
existing setup. Explicit enablement permits that module's account/tool lookup.
Missing prerequisites keep the connector off.
The dashboard and Connect source list omit disabled optional data. Core file writes,
local settings, inbound HTTP/SSE and Stash save debouncing remain available.

### Setup API

These routes exist only on portable profiles. A legacy config receives 404 for
both routes and keeps the existing `/api/state` structure. Jobs-off and sandbox
portable profiles receive 503 for both routes. Reads require the existing
dashboard authorisation; writes also use its Origin check and require JSON.

`GET /api/setup` returns `{fresh, demo, connectors}`. Every connector has
`{enabled, configured, reason, needs, live, platform}`. `needs` contains explicit
fields with `key`, `label`, `kind`, `required` and optional `placeholder`/`help`.
Kinds are `url`, `path`, `text`, `secret`, `bool` or `list`; `platform` is `any` or
`darwin`. The field definitions and their copy live in `setup-schema.js`.
No saved settings, feed URLs, topics or credentials are returned. `configured`
means local prerequisites are present, not that an account login has been tested.

`PUT /api/setup/connectors/:name` accepts `{enabled, settings}`. `enabled` must
be a boolean; omitted `settings` means keep existing settings. Supplied fields
replace those fields, leaving other settings unchanged. Lists are JSON arrays of
strings. Unknown connectors return 404; unknown fields, wrong types, invalid
URLs and missing required fields when enabling return 400. A missing CLI or
folder leaves the requested switch saved, with `enabled:false`, `configured:false`
and a reason explaining the missing prerequisite.

| Connector | Accepted settings | Requirement |
| --- | --- | --- |
| `calendar` | `icsUrls`: list of ICS URLs | At least one supplied/configured URL or a saved feed |
| `github` | `account`: text | Account name and installed gh; sign in separately |
| `git` | `roots`: list of paths | At least one existing folder and installed git |
| `notify` | `topic`: secret; optional `url`: HTTPS URL | Private ntfy topic; enabling also sets notify.enabled |
| `almanac` | `name`, `latitude`, `longitude`, `timezone`: text | All four place fields; coordinates are saved as numbers |
| All others | `{}` | Existing files, tools or configuration in the inventory below |

For example, connect a calendar without restarting:

```http
PUT /api/setup/connectors/calendar
Content-Type: application/json

{"enabled":true,"settings":{"icsUrls":["https://example.com/calendar.ics"]}}
```

Calendar settings use the existing config feed format and calendar URL validator.
Supplying `icsUrls` replaces the config feed list and clears the older `icsUrl`;
it does not remove feeds saved through `POST /api/calendars`. That core API remains
the way to add a labelled, coloured feed, after which enable calendar with
`{"enabled":true,"settings":{}}`. Feed URLs remain masked in its responses.
HTTPS and webcal URLs are accepted. Portable profiles also accept HTTP feeds on
literal loopback addresses (`127.0.0.1` or `[::1]`), including redirects; other HTTP
addresses and file URLs are refused. Legacy calendars remain HTTPS-only.

A successful PUT atomically replaces each of the config and `.bak` files with
the same validated JSON, mode 0600, using the first-run writer. Updates are queued
with other config writes. Each file rename is atomic; the pair is not a single
filesystem transaction. The in-memory connector profile then changes and a state
refresh is queued. The response is the connector's new status, without settings.

Calendar, GitHub, AI sessions, AI usage, Git, Tailscale, link metadata, previews,
Tell, to-do ranking, delegations, almanac, notifications and nudges can switch live.
Their refresh/history/reminder timers start once on enable and stop on disable.
Already running requests or agent work may finish. `artwork`,
`heartHealth`, `money`, `voice` and `stashSummary` retain boot-time constructors
or workers: their status has `live:false` and PUT adds `needsRestart:true`.
Live connectors omit `needsRestart`. Manual configuration for connectors with
`needs:[]` still uses the existing tools and config format.

Portable profiles have no default place. Set `place` in config to
`{"name":"Tokyo","latitude":35.6762,"longitude":139.6503,"timezone":"Asia/Tokyo"}`,
or use the almanac setup fields:

```http
PUT /api/setup/connectors/almanac
Content-Type: application/json

{"enabled":true,"settings":{"name":"Tokyo","latitude":"35.6762","longitude":"139.6503","timezone":"Asia/Tokyo"}}
```

Setup saves these values under `place`, leaving other connector settings alone.
Latitude must be from -90 to 90, longitude from -180 to 180, and timezone must be
an IANA timezone accepted by `Intl.DateTimeFormat`. Supply a complete place on
its first save; later settings can change individual fields. Omitted settings
retain the place, including when disabling the connector. Use `place:null` in
config to remove it. The dashboard and phone receive its name as
`state.location.name`, including while almanac network access is off.

Weather, sunrise/sunset and local moon dates use that place. Without one, sky
and moon items are omitted and no weather request runs. Other enabled almanac
sources still work; daily picks use UTC until a place is set. Weather caches and
stale fallbacks are kept separate by place. The weather call sends coordinates
and timezone to Open-Meteo through the existing public-network guard, only when
the almanac connector is enabled. There is no place lookup endpoint in this
release. Configs without a profile marker retain the original Belfast weather,
moon timezone, request URL and user agent without a config change or migration.

There is no demo-data creation API. `npm run demo` remains the isolated demo.

| Connector / job | Needs / configuration | Enabled by | Off state | macOS only |
| --- | --- | --- | --- | --- |
| Board | Existing `board.dir` Markdown directory | `board` | Empty cards; no directory enumeration | No |
| Preferences | Approved `preferences.sources` files, coordinated with the public config migration | `preferences` | Empty sources; no content reads | No |
| AI sessions | Claude/Codex session directories in HOME | `ai` | Empty sessions; no log scan | No |
| Fleet probes / annotation | `fleet.services`/`sites` URLs; optional lsof and launchctl | `fleet` | Empty services/sites/agents; no probes or process calls | launchd portion |
| Git / commit pulse | Existing `git.roots`; git CLI | `git` | Empty repositories; no git child | No |
| Brain summary/search | `brain.graphPath` JSON file | `brain` | Empty summary/search; no graph worker | No |
| Threads | `threads.url`, optional `threads.configPath` token file | `threads` | Empty tasks; no fetch/token read | No |
| ICS calendar refresh | Config feed or saved calendar feed | `calendar` | Empty events; no HTTPS refresh; classes start empty | No |
| Ledger reads / journal import | Existing `ledger.dir` | `ledger`; legacy sync remains in the owner refresh | Empty ledger; no external directory reads/import | No; external scheduler may be launchd |
| Meeting notes | Existing `meetings.dir` | `meetings` | Empty notes | No |
| Drift | LifeOS/AGENTS.md in HOME | `drift` | Empty strays; no LifeOS scan | No |
| Delegation / feedback / backfill / undo | Configured Claude or Codex CLI | `delegations` | Empty runs; connector actions return 503 | No; optional `open` command is Mac only |
| Intake sync / learning | Selected-data `brief-intake.json`, supplied by an external automation | `intake`; legacy sync remains in the owner refresh | No automation/home lookup or learning job; empty on fresh data | No |
| ExampleApp feedback | Explicit runner state file and CLI | `exampleappFeedback` | Empty feedback; no runner | No |
| Campaign Snapshot | Explicit `campaignSnapshot.dashboardUrl` | `campaignSnapshot` | Null metrics; no fetch | No |
| Heart Health | Explicit collector pack configuration/CLI, coordinated with oss3 | `heartHealth` | `configured:false`; no analytics children | No |
| Tailnet discovery / sharing | Tailscale CLI and a signed-in account | `tailscale` | No discovery, interface bind or share mutation | No; app binary is Mac only |
| Local server discovery / stop | lsof | `localServers` | Empty servers; no listener scan, probe or process signal | No |
| System information | df | `system` | Empty system data; no child | No |
| GitHub polling | gh CLI, `github.account`, and a login | `github` | Empty GitHub; no gh or login lookup | No |
| Link health / title / favicons | Explicit public/private URL access | `linkMetadata` | Saved links remain; metadata unavailable, favicon monograms | No |
| Chrome previews / thumbnail conversion | Chrome app, optional sips | `previews` | Existing cache only; no browser child | Current adapter |
| Curated artwork / icon refresh | Optional selected-data collection and artwork image source | `artwork` | Null art, missing image 404, neutral SVG icon; no throw/job | Icon generation is Mac only |
| Almanac / image / weather refresh | Public network access; no account | `almanac` | Cached/empty almanac; no outbound fetch | No |
| Usage ledger scans / FX / history child | Provider log directories and optional helper tools; existing plan files | `aiUsage` | Saved ledger only; no scan, FX fetch, history child or timer | Optional enrichments |
| Money refresh / advice | Existing money credentials and account setup; adviser CLI | `money` | No refresh/adviser job; existing local lock/settings remain | No |
| Tell planning / reminders | Claude CLI | `tell` | No planner or reminder job; local stores still editable | No |
| To-do ranking | Claude CLI | `todoRank` | Cached/empty ranking; no CLI or debounce job | No |
| Voice sessions / key lookup | OPENAI_API_KEY, or explicitly selected Keychain service | `voice` | Unconfigured status; no key lookup/session | Keychain portion |
| Stash enrichment | Explicit URL access; optional Vision and Quick Look helpers | `stashEnrichment` | Text/link/file writes remain; no enrichment, no endless pending flag | Vision/Quick Look portions |
| Stash summaries | Explicit engine plus installed Claude/command CLI | `stashSummary` | Notes remain unchanged; no summary timer/child | No |
| Push / held-ping release | `notify.enabled:true` and nonempty topic | `notify` | No ntfy sends or release timer | No |
| Meeting nudges | `nudges.enabled:true`; calendar/intake events | `nudges` | No nudge timer/records/push | No |
| Journal vault exports | Existing `journal.vaultDir` | `journalExport` | Journal remains in its own JSON store; no vault export | No |
| State refresh schedule | At least one enabled connector | Portable boot; configured refresh interval | Refresh only on reads/core mutations | No |
| SSE / core writes | Local client | Always available; jobs-off still refuses writes | No external service or agent; core save timers are allowed | No |

Missing launchctl, lsof, Keychain/security, Swift, Quick Look, Chrome and macOS app
paths are skipped. Native Linux installation remains a release verification task;
the automated tests here run on macOS with an empty tool path and home.
