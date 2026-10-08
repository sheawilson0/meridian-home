# Software licence and asset audit

Audit date: 8 October 2026. No root LICENSE file has been added. The software licence is the owner's decision; the font and recorder notices already present do not license the whole app. This document records evidence and unresolved provenance, not a claim that every asset is cleared.

## Vendored fonts, verified

All font binaries found under public/ are in `public/design/type/fonts/`:

| File | Size | Source evidence | Licence |
| --- | --- | --- | --- |
| `Doto-VF.woff2` | 8,740 bytes | Byte-identical to upstream `Doto[ROND,wght].woff2` in the local meridian-type source checkout. | SIL OFL 1.1, Doto Project Authors. |
| `MeridianDot-VF.woff2` | 9,552 bytes | Byte-identical to the Meridian Dot fork's build/distribution file. | SIL OFL 1.1, Doto plus Meridian changes. |
| `MeridianBlob-Pixel.woff2` | 20,120 bytes | Byte-identical to the Meridian Blob Pixel build/distribution file. | SIL OFL 1.1, derived dot drawings. |
| `MeridianBlob-Round.woff2` | 16,072 bytes | Byte-identical to the Meridian Blob Round build/distribution file. | SIL OFL 1.1, derived dot drawings. |

Total: 54,484 bytes. SHA-256 comparisons are recorded in the private audit evidence, not assumed from filenames. The fork README/build sources describe the Doto-derived drawings and renamed families. The local fork's OFL includes both upstream and 2026 fork copyright. This branch adds the missing fork copyright line to the vendored OFL, preserving the licence text. The upstream notice declares no Reserved Font Name.

Keep `OFL.txt` with all four files, preserve upstream and fork credits, and keep the font software/derivatives under OFL. The font licence does not force the app's source code into OFL. Bundling/redistribution is allowed under its conditions; selling the font by itself is not. [Official SIL OFL 1.1](https://openfontlicense.org/open-font-license-official-text/).

Most UI fonts are **remote Google Fonts CSS**, not vendored binaries. Current production references include Fraunces, Outfit, IBM Plex Mono, Newsreader, Space Grotesk, Space Mono, DM Sans, Geist Mono, Schibsted Grotesk, Inter Tight and Doto; archived boards include more families. A public release needs a versioned per-family manifest if self-hosting them. Do not label every remote font as covered by the vendored Doto OFL. Remote font requests also disclose a visitor's network metadata to the provider, and offline core should have documented fallback fonts. [Google Fonts licensing FAQ](https://developers.google.com/fonts/faq).

## Recorder

`tester/public/vendor/rrweb/` contains:

- `record-2.1.7.min.js`
- `rrweb-player-2.1.7.min.js`
- `rrweb-player-2.1.7.min.css`
- `LICENSE`

The vendored notice is MIT, copyright 2018 rrweb contributors, matching the upstream project licence. Keep the notice with distributed recorder/player files and review bundled component notices when updating the vendored bundle. rrweb belongs to the optional usability-testing service, not normal personal-install recording. [rrweb upstream licence](https://github.com/rrweb-io/rrweb/blob/main/LICENSE).

## Planet and moon textures

The ten bundled WebP maps are derivatives of Solar System Scope / INOVE’s 2K downloads, used under CC BY 4.0. They were resized to 1024 px wide and converted to WebP at quality 82. Surface maps are 1024×512; Saturn’s ring is 1024×62 and preserves alpha. No seam retouching or colour changes were applied. Their total size is 601,100 bytes.

The original JPEG/PNG maps are excluded from this public snapshot; its loader uses only the bundled WebPs. The texture works are based on NASA data, which does not replace Solar System Scope / INOVE’s creator attribution. Preserve the credit and describe any further modifications. [Source downloads](https://www.solarsystemscope.com/textures/), [CC BY 4.0 terms](https://creativecommons.org/licenses/by/4.0/), [bundled notices](../../THIRD_PARTY_NOTICES.md).

## Icons and other imagery

| Assets | Evidence / current licence status | What remains |
| --- | --- | --- |
| `public/{meridian,dashboard,tell}-icon.svg` and dashboard/tell PNG sizes | App branding assets; no independent third-party licence found in the asset files. | Owner confirms authorship/rights and whether they share the app licence or have separate branding terms. |
| Inline outline icons in command/phone/draft/connect pages | No vendored icon package manifest or reliable upstream notice found. Shapes alone cannot prove Lucide/Feather provenance. | Establish authorship/source per reused icon set, preserve its notice or replace with cleared icons. Do not assign MIT/ISC by resemblance. |
| `public/source-marks.js`, matching inline Slack/Outlook marks in the brief | Third-party product logos; no source/permission notice bundled. | Record sources and applicable brand permissions. Software licence does not grant trademark rights or imply endorsement. |
| `public/img/hero-dusk.jpg`, `public/art-fallback.jpg`, `public/labs/icon-art/*` | No complete source/licence manifest found. | Trace exact image sources and rights or replace/exclude them. |
| `public/design/art-directions/img/*` | Historical artworks/reference imagery and current design captures. | Image-specific rights/source attribution, even where an underlying artwork is old. Keep research archive out of the default public artifact. |
| Design/labs/user-test/mobile/story screenshots and voice-coach examples | Owner/client/coursework/participant context and possibly third-party UI/media. | Privacy, consent and rights review; make new synthetic release screenshots. |
| Runtime Almanac imagery, poems, Wikimedia feed, Earth View, Wada colour dataset, NASA EPIC and artwork collection | Downloaded/cached content, not uniformly licensed app assets. Each upstream source/item has separate terms. | Store source/creator/licence metadata per item, obey feed/cache/display terms, keep caches out of source releases. Do not describe all feeds as public domain. |

The source repo is zero-dependency at runtime but not zero third-party material. External programs (Node, Tailscale, gh, Claude/Codex CLIs, Chrome, Swift/macOS frameworks, Scriptable) are prerequisites/adapters, not bundled code. Their availability, service terms and platform rights are separate from the project's software licence.

## Main licence options

| Choice | Practical trade-off for this self-hosted tool |
| --- | --- |
| MIT | Short, widely understood permissive grant. Others can use, modify, redistribute and sell forks if they retain the notice. Closed-source derivatives and hosted services are allowed; it does not require improvements to come back. [MIT text](https://opensource.org/license/mit). |
| Apache-2.0 | Permissive use like MIT, with an explicit contributor patent grant/termination rule, modification notices and NOTICE handling where applicable. More administrative text, useful if a broader contributor/commercial ecosystem is expected. No requirement that hosted changes be public. [Apache 2.0 text](https://www.apache.org/licenses/LICENSE-2.0.html). |
| AGPL-3.0 | Copyleft for derivatives/conveyed versions, with an additional source-offer obligation when users interact over a network with a modified version. Supports a goal of keeping hosted forks open; adds obligations and can limit adoption by companies that want proprietary integrations. It is not a ban on charging money. [GNU AGPLv3 text](https://www.gnu.org/licenses/agpl-3.0.html). |

Recommendation: MIT if the priority is people installing, adapting and contributing to a small personal tool with low friction. Choose Apache-2.0 if the explicit patent terms matter. Choose AGPL-3.0 if keeping modified hosted services open is a deliberate priority. None of these grants rights to private client content, trademarks or differently licensed assets. Confirm ownership and contribution rights, then add the chosen licence, software copyright and third-party notices before calling v0.1 open source.
