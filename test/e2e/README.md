# Refactor visual baselines

`scripts/dev/visual-baseline.cjs` is an optional WebKit capture/compare harness
for splitting `server.js` and `public/command.js`. It boots the real server in
sandbox mode through the same synthetic fixture helper as the server contract
suite. No live daemon, personal data, credentials or external network are used.
It is separate from `npm test` and adds no package dependency.

Use an existing dev-only `playwright-core` installation with its matching WebKit
browser binary. If either is missing, the script prints `SKIP` and exits 0 before
starting a server. Other launch or capture failures exit 1. A skip is not a
visual verification result.

## Before and after a refactor

Keep the output outside the checkout. The directory must be empty, and baseline
and comparison directories must differ. Commit the harness and expectations,
never the PNGs or capture manifests.

Before changing the application, on the refactor's base revision:

```sh
PLAYWRIGHT_CORE_PATH=/path/to/dev-tools/node_modules/playwright-core \
  node scripts/dev/visual-baseline.cjs --output /tmp/meridian-before
```

After the refactor, in the same environment:

```sh
PLAYWRIGHT_CORE_PATH=/path/to/dev-tools/node_modules/playwright-core \
  node scripts/dev/visual-baseline.cjs \
  --output /tmp/meridian-after --compare /tmp/meridian-before
```

Use the identical harness and fixture on both revisions. If introducing the
harness on an older base, copy only the dev/test helper files into that isolated
checkout. Do not change the daemon or connect either run to live state.

Every shot reports changed pixels, percentage and mean absolute RGBA channel
difference in `manifest.json`. Comparison decodes both PNGs in WebKit and counts
pixels with any changed channel, with no tolerance or masks. Any changed pixel,
changed dimensions, missing/failed baseline shot, removed shot, page error or
unexpected network write makes the command exit 1. Review both PNGs before
accepting a difference. Do not overwrite the baseline just to make a check pass.

The manifest refuses comparisons across different browser versions, platforms,
clock/timezone/locale, fixture versions or scale factors. It records each shot's
viewport, URL, focus, text selection, scroll, blocked external origins and image
hash. These interaction fields support review; pixel comparison alone does not
test keyboard behaviour, caret preservation or scroll after an SSE update.

## Captured states, 33 shots

| Surface | States | Size |
| --- | --- | --- |
| Command tabs | Home, Shelf, Stash, AI usage, Money (locked), Dogfood, Journal, System, Brief | 1440 × 900 |
| Command overlays | Settings, all five Customise pages, palette, capture, add link, log fix, shortcuts, add Stash, Stash detail | 1440 × 900 |
| Demo route | Command Home with `?demo=1&lab=1` | 1440 × 900 |
| Phone | Today, Tell sheet, Everything else drawer | 390 × 844 |
| Command on phone | Sidebar drawer | 390 × 844 |
| Editors/library | Existing `/draft?id=…`, `/drafts`, `/stash-sort` | Both sizes |

Each shot uses a fresh browser context with empty storage. The fixture carries
saved appearance preferences, a draft, links, to-dos, deadlines, intake, journal,
text/link/colour Stash records, a local painting and cached fictional weather.
The sandbox deliberately leaves collector-backed services empty and Money
locked. Demo Home additionally exercises the richer demo state and routing.
This is a deterministic extraction baseline, not a visual verdict on populated
accounts or a screenshot of every state a user can reach.

Browser and server dates are fixed at `2026-10-08T11:00:00Z`, in Europe/London,
with en-GB locale, reduced motion and device scale factor 1. Timers still run so
normal loading/focus work completes. Screenshots disable animations and hide the
caret. Visible images are decoded and fonts settled before capture. A reduced
motion baseline does not verify the normal moving planets or native app bridge.

Every navigation, including frames, retains `?lab=1`. The browser blocks all
external requests, service workers and network writes. The child daemon also
has the unit filesystem/process/network guard and the sandbox probe. External
font/image URLs therefore use their existing fallbacks; capture on the same OS
and WebKit installation to keep fallback font rasterisation comparable. Expected
resource errors, such as the locked Money 401 or missing favicon, are not page
errors and do not invalidate an otherwise rendered screenshot.

The script owns its temporary data/config/home/cache, finds a free loopback port
in 5160–5169, closes all contexts/browser and stops the child in `finally`. It
also closes the browser on SIGINT/SIGTERM and then cleans up the sandbox. The
manifest records zero child commands, outbound requests and job timers from the
daemon probe; an unexpected effect or daemon error fails the run. It
never accepts an upstream URL, so it cannot accidentally compare against the
personal daemon. Run one harness at a time on this shared machine.
