# Meridian tests

Use Node 22 or later. The app and the unit suite need no npm packages, account credentials, private data, or running Meridian server.

```sh
node --test test/
```

`test/index.js` makes that exact directory command work on Node 22. It discovers every top-level `*.test.js`, runs each in a separate process, and reports its pass/fail counts, skipped tests and elapsed milliseconds. Processes run sequentially to keep memory and timer pressure down. An optional machine-readable file report:

```sh
MERIDIAN_TEST_REPORT=/tmp/meridian-tests.json node --test test/
```

The runner strips inherited environment variables, gives each process a temporary home and data workspace, and preloads `test/helpers/isolate.cjs`. The guard refuses application `data/`, `cache/`, `logs/`, `config.json`, personal home files outside the checkout, outbound sockets, port 4980, external agent/system commands, and writes outside the temporary fixture workspace. Existing HTTP route tests listen on ephemeral loopback ports. Temporary workspaces are removed on process exit. This guard is a test safety net, not a security sandbox for untrusted code.

For one file, keep the same guard:

```sh
node --require ./test/helpers/isolate.cjs --test test/tell.test.js
```

The ledger collector fixture needs Python 3, and the unified-diff fixture needs `/usr/bin/diff`. Those cases skip with a reason when the tools are absent. The fixture data under `test/fixtures/ledger/` is synthetic. Icon tests stub the private painting collection and do not compile Swift. No test needs Owner's machine. Date tests run in Europe/London through the isolation preload.

`server-contract.test.js` boots the real daemon with `MERIDIAN_SANDBOX=1`, a synthetic data/config/cache root, a fixed date and an available loopback port in 5160–5169. Its GET/auth/static/initial SSE checks run in the default suite. The jobs-off gate is checked before Origin/MCP dispatch; those hidden contracts and named broadcasts additionally use the current handler seam without boot or collectors. See [contract expectations](fixtures/server-contract/README.md). The fixture checks for unchanged files, no child commands, outbound requests or job timers, and stops its servers in teardown.

For optional before/after WebKit PNG comparisons of command/phone/editor flows, see [the visual baseline workflow](e2e/README.md). That harness boots the same isolated fixture and stays outside `npm test`.

## Browser smoke, dev only

The optional harness uses an existing `playwright-core` installation and its Chromium/WebKit binaries. Install these in your own tooling directory, not as app runtime dependencies. If the package or a requested browser binary is absent, the harness prints an explicit skip. Launch failures for other reasons fail the run.

Start a read-only proxy in one terminal, using your isolated server's URL as upstream:

```sh
node scripts/dev/read-only-proxy.cjs --port 5160 --upstream http://127.0.0.1:YOUR_SANDBOX_PORT
```

On Owner's overnight setup, use the supplied read-only proxy instead:

```sh
node /Users/example/Meridian-overnight/_board/dev-proxy.js \
  --root /Users/example/Meridian-overnight/qa/public --port 5160
```

Then run, pointing `PLAYWRIGHT_CORE_PATH` at the dev installation if it is not resolvable locally:

```sh
PLAYWRIGHT_CORE_PATH=/path/to/tooling/node_modules/playwright-core \
  node test/e2e/smoke.mjs --base-url http://127.0.0.1:5160
```

The default URL is the dev proxy at port 5160. The default matrix is Chromium and WebKit at 1280×800, 390×844 and 375×844. Browsers run one at a time, headless, and close in `finally`. Reports and PNGs go to a unique temporary directory, or set `--output /path/outside/checkout`.

The harness visits the dashboard's visible tabs, opens/closes the command palette, Settings → Customise, capture and a Stash item, exercises Stash's no-match search, clicks phone tabs, loads an existing draft and `/drafts`, `/stash-sort?lab`, the brief, Connect, quick to-dos, classic dashboard and Story. Empty datasets explicitly skip Stash-item and existing-draft checks. It never visits bare `/draft`, which creates a draft. An empty draft body is valid; the check requires an editor, not invented content.

Every page uses `?lab`. A browser request guard also blocks every method except GET/HEAD, including frames and popups, and refuses off-origin navigation. The proxy independently blocks writes. Service workers are blocked so they cannot bypass request interception. It does not submit, approve, delete, save, refresh credentials, or send anything. A GET endpoint that itself has side effects remains the upstream server's responsibility; use an isolated sandbox for third-party deployments.

Normal runs fail on console errors, page errors, unhandled rejections, HTTP error responses, missing meaningful content, navigation that loses lab, or horizontal overflow. Missing favicons and locked Money's HTTP 401 currently produce failures worth distinguishing from JavaScript errors in `results.json`. Do not treat a reported smoke failure as a failed unit suite.

To repeat selected matrix entries or simulate an API outage:

```sh
node test/e2e/smoke.mjs --browser webkit --widths 375
node test/e2e/smoke.mjs --fault api-500 --widths 1280,390
node test/e2e/smoke.mjs --fault disconnect --widths 1280,390
```

`api-500` stubs API reads with HTTP 500. `disconnect` interrupts the connection, reloads the shell with API reads blocked, checks the cached dashboard and connection status, then checks SSE reconnect. Deliberately injected HTTP/resource errors are retained as expected network errors in fault reports; unhandled errors and failed render assertions still fail. The proxy's `--latency 1000` option can additionally delay API reads. Stop the proxy with Ctrl-C when finished.
