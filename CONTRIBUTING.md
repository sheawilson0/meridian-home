# Contributing to Meridian

Meridian is preparing for a public release. Editable first run is still incomplete. See [the architecture map](docs/open-source/architecture.md), [configuration reference](docs/open-source/config.md) and [security model](docs/open-source/security.md) before enabling integrations.

Use Node 22 or newer. There are no runtime npm dependencies, no frontend framework and no bundler. Keep runtime changes to Node built-ins and plain browser JavaScript. Preserve CommonJS; package.json intentionally has no `type` field.

## Local work

```sh
node scripts/doctor.js
npm test
node --check server.js
```

Doctor is read-only and may report expected fresh-clone blockers. Start/dev currently require private configuration and optional-file cleanup described in [first run](docs/open-source/first-run.md). Do not solve missing fixtures by copying an owner's data or credentials. `npm run dev` uses Node watch mode and restarts the daemon, so only use an isolated profile after the boot-isolation changes have been verified.

`npm test` runs `node --test test/`. The directory runner preloads `test/helpers/isolate.cjs` for every test process, with temporary home and storage directories and no external commands or services. Keep that guard for individual tests with `node --require ./test/helpers/isolate.cjs --test test/example.test.js`. Fixtures are synthetic and clocks are controlled. A green check must be a command you actually ran.

## Scope and review

Keep a change focused. Avoid unrelated formatting, dependency bumps, naming, copy or visual changes. Describe behaviour changes and show synthetic before/after screenshots for UI work. Do not capture personal dashboards, calendar entries, messages, employer/client work or live account balances. Open dashboard review pages with `?lab` so appearance experiments do not save into the owner's preferences; lab mode does not disable every other mutation.

Use small commits with a concrete purpose. In a pull request describe the trigger/problem, resulting behaviour, affected files, verification and remaining risks. New connectors should be optional, have redacted errors and synthetic fixtures, and fail without breaking core. Do not change auth or broaden network/file/shell access as a side effect of feature work.

## Data and compatibility

Keep config, backups, data, caches, uploads, journal/ledger entries, logs, delegated reports and tester recordings private. Do not paste calendar feed URLs, bearer tokens, account details or API keys into an issue, patch or screenshot. A local ignore file does not remove historical commits.

Preserve existing data shapes and the current owner's defaults. Data migrations should be versioned, backed up and reversible; never overwrite existing data with demo seeds. Missing optional tools must produce a useful degraded mode. Test the full flow when changing shared store operations, approval rules, undo semantics, SSE or paths.

Third-party assets keep their own licence notices. Follow [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the [asset/licensing audit](docs/open-source/licensing.md); do not assume a NASA-derived texture or inline SVG is licence-free. Application contributions use the project's MIT licence. No contributor licence agreement is required.

## Security reports

Follow [SECURITY.md](SECURITY.md) and GitHub's private vulnerability reporting. Do not open public issues containing exploit details or secrets. Do not test security against an owner's live daemon or alter Tailscale/LaunchAgents as part of a contribution check. Use temporary state and fixture services.
