# Security for a personal install

Current Meridian is a trusted personal tool, not a public service or multi-user application. This document describes the code audited on 8 October 2026, the dashboard MCP grants added afterwards, and remaining release work.

Run it on a machine and network you control. Keep the dashboard private. A person who can use the normal dashboard/API can see work context and invoke powerful actions, including starting agents, changing data, controlling local processes, pausing macOS jobs and changing Tailscale Serve mappings. The separate Money passcode does not protect the rest of Meridian.

## What authorisation means today

`server.js` has `isLoopback()`, `isTailnet()`, `allowedOrigin()` and `authorized()`:

- Loopback IPv4/IPv6 clients are trusted unless `drafts.js.fromInternet()` identifies forwarded internet/Funnel traffic.
- Direct IPv4 clients in `100.64.0.0/10` are treated as tailnet clients. There is no per-person identity or application-level tailnet allowlist. Access must be constrained by actual Tailscale ACLs and host network controls.
- Other general requests need the broad `config.token` in `?t=` or `X-Meridian-Token`.
- Tailscale Funnel is distinguished with its header and forwarded client address. `drafts.js` also checks `X-Forwarded-For` and recognises Tailscale IPv6 prefixes. Direct general IPv6 tailnet access is not the same code path as the IPv4 trust check.
- For legacy cloud MCP, `config.mcpToken` can authenticate `/mcp` using a query/path token or Bearer header. It opens every dashboard MCP tool, but does not open all dashboard APIs. New clients should use a scoped grant instead, as described below.
- Mutating routes pass an Origin guard. Missing Origin is allowed for scripts and clients. An allowed Origin is not a user login, and this policy does not stop a trusted local process.

The server binds loopback plus local IPv4 addresses beginning with `100.`. Binding discovery is broader than the `100.64/10` authorisation check. An interface/IP prefix alone is not proof of Tailscale identity.

Some display/image routes, including the daily-art path before the central auth guard, are exceptions to the general check. Audit early-handled Almanac/icon/art routes before claiming all data requires auth. Demo mode also uses real display-source fallthroughs; it is not a process security boundary.

## Per-agent dashboard MCP grants

Give each agent its own grant with only the permissions it needs. A grant's owner-assigned name supplies draft/history and Stash-note attribution; `?as=` cannot override it. A token authenticates the agent label, not the person who typed a prompt. Money keeps its separate grant store and financial scopes. Dashboard grants do not unlock Money, the general REST API, grant administration or the tester MCP.

| Scope | Dashboard tools |
| --- | --- |
| `read` | `meridian_overview`, `draft_get`, `draft_list`, `draft_history`, `stash_search`, `stash_get`, `stash_spaces` |
| `draft-write` | `draft_create`, `draft_update`, `draft_mark_sent`, `note_add` |
| `todo-write` | `todo_add` |
| `host-control` | `draft_open`, `panel_open_url` |

Scopes are independent: write permission does not imply read permission. `draft_create` also needs `host-control` if `open` is omitted or true. A grant without that scope must pass `open:false`; the server rejects the call before creating anything rather than silently changing its behaviour. `host-control` here only opens a draft or an HTTPS panel, with the existing URL validation. It grants no shell, process, sharing or configuration powers. `draft_mark_sent` records a receipt, it does not send anything or approve a draft.

These are tool-family grants, not per-document or per-space permissions. `read` covers the dashboard overview, all drafts/history and the Stash items already visible to agents. The existing hidden-space/deleted-item exclusions and text redaction still apply. Add resource constraints before sharing only selected drafts or Stash spaces with outsiders.

From the checkout, create a grant against the same data directory used by the daemon. The CLI works with the server stopped:

```sh
node scripts/mcp-grant.js create --name Dot --scopes read,draft-write --expires 30d --data-dir /path/to/meridian-data
node scripts/mcp-grant.js list --data-dir /path/to/meridian-data
node scripts/mcp-grant.js revoke <id> --data-dir /path/to/meridian-data
```

`--expires` accepts positive minutes, hours or days, such as `30m`, `12h` or `30d`. Omit it for no expiry. `--data-dir` defaults to `MERIDIAN_DATA`, then the checkout's `data/`. Creation returns `{grant,token}` once. Save the token in the client's private environment or secret store; it cannot be retrieved later. Revoke and create a replacement if it is lost. List/revoke return metadata only: `{id,name,scopes,createdAt,expiresAt,lastUsedAt,revokedAt}`.

The daemon stores `mcp-grants.json` in its data directory with mode `0600`. It contains only metadata and a SHA-256 hash of each randomly generated 256-bit token. SHA-256 is appropriate for this high-entropy secret, following Money's grant design; human passwords would require a slow salted password hash such as scrypt. Verification compares fixed-size hashes with `crypto.timingSafeEqual`. Atomic writes and an exclusive lock coordinate CLI/server changes. If an interrupted write leaves `mcp-grants.json.lock`, stop grant writers and remove that lock only after confirming none is running. Corrupt grant data fails closed and is not replaced with an empty store.

The local/private dashboard admin API uses the same owner authorisation and write-Origin guard as other dashboard writes. It rejects internet/Funnel traffic and grant credentials:

```text
GET    /api/mcp/grants          -> {grants: [...], scopes: [...]}
POST   /api/mcp/grants          <- {name, scopes: [...], expiresAt: ISO-date-or-null}
                               -> {grant, token} (201, shown once)
DELETE /api/mcp/grants/<id>     -> {grant}
```

There is no settings UI yet. All these responses use `Cache-Control: no-store`. Names are limited to 40 characters. Grants are checked on every request and again at tool dispatch, so expiry or API/CLI revocation takes effect without restarting the daemon. Queued draft/to-do commits and awaited reads recheck access; work already performed cannot be undone by revocation. `tools/list` and diagnostic GET list only allowed tools. Denied calls return HTTP 403 with a JSON-RPC error naming the missing scope and a `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` challenge. Revoked/expired grant credentials return 401.

### Configure clients

Send a scoped token as `Authorization: Bearer <token>` to `/mcp`. Bearer credentials take precedence over query/path credentials. A grant is rejected in `?t=` and `/mcp/<token>`, including on loopback and the tailnet. The existing `config.token`, `config.mcpToken`, URL forms and credential-free trusted local/tailnet clients retain their legacy all-tool access and `?as=` attribution. This compatibility mode means a local/tailnet agent that omits its grant can still use owner access. Use a correctly classified remote boundary and OS/network isolation for untrusted agents; grants alone do not protect against a process with the owner's filesystem access or a trusted proxy that hides caller identity.

For Claude Code, configure Streamable HTTP with a Bearer header in your private MCP configuration:

```json
{
  "mcpServers": {
    "meridian": {
      "type": "http",
      "url": "https://your-private-host/mcp",
      "headers": { "Authorization": "Bearer ${MERIDIAN_TOKEN}" }
    }
  }
}
```

Set `MERIDIAN_TOKEN` in the environment before starting Claude Code. Claude also supports `claude mcp add --transport http meridian https://your-private-host/mcp --header "Authorization: Bearer <token>"`; keep secrets out of shared project config and shell history. [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp).

For Codex, set the environment variable before starting the client and use its HTTP token setting:

```toml
[mcp_servers.meridian]
url = "https://your-private-host/mcp"
bearer_token_env_var = "MERIDIAN_TOKEN"
```

The equivalent registration is `codex mcp add meridian --url https://your-private-host/mcp --bearer-token-env-var MERIDIAN_TOKEN`. For either CLI's existing stdio bridge, keep `node /path/to/Meridian/scripts/meridian-mcp.js` and supply `MERIDIAN_URL` and `MERIDIAN_TOKEN` in its private environment. The bridge forwards the token in a Bearer header and preserves scope-denial errors. `MERIDIAN_AGENT` affects only legacy attribution. `codex mcp login` requires OAuth, which these grants do not implement. [Codex MCP settings](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [CLI registration](https://learn.chatgpt.com/docs/cli/reference).

For ChatGPT, the current custom MCP configuration offers OAuth or no authentication and cannot present a custom API key/header. A direct scoped static-token setup is therefore unavailable. Keep an existing Dot owner-token URL unchanged during migration; do not put a new grant token in that URL. A separately secured gateway could authenticate its own connector and add the scoped Bearer header upstream, but this round does not build or configure one. Native scoped ChatGPT access needs a later OAuth flow. [ChatGPT custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server), [authentication limitations](https://developers.openai.com/plugins/build/auth).

OAuth would add protected-resource and authorisation-server discovery, owner consent, PKCE, audience-bound access/refresh tokens, client registration and incremental permission requests. These manually issued grants do not claim OAuth/MCP authorisation compliance; their scope challenges deliberately omit discovery metadata for a server that does not exist. See the [MCP authorisation specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Deployment choices

| Setup | What the operator needs to know |
| --- | --- |
| One local user, loopback only | Every process running as a local client can reach trusted APIs. Browser origin checks are a useful extra layer, not protection from local malware or another local user. |
| Private Tailscale access | Restrict tailnet membership and ACLs to the intended owner/devices. Serve exposes the owner's whole capability set, not a read-only dashboard role. Keep HTTPS and device account security intact. |
| A general reverse proxy/container tunnel | A proxy connecting from loopback may be trusted as local if it does not provide the headers Meridian expects. An unrelated public proxy can therefore bypass token checks. Do not expose the current daemon behind one without a dedicated tested auth boundary. |
| Tailscale Funnel/public internet | Do not expose the live personal daemon. Query/path tokens can leak through history, logs, copied links and monitoring. Funnel header handling does not make agent execution, filesystem previews and personal state a public product. |
| Hosted demo | Use the separate tester sandbox or a dedicated synthetic-only service with no credentials, home-file access, shell/process controls or live backend. Consent recording, retention and deletion need their own policy. |

## Sensitive capability and data boundaries

| Surface | Consequence of access | Release requirement |
| --- | --- | --- |
| `/api/state`, stream, agent overview, journal, board/meeting docs, preferences, links and previews | Work context, conversations, filenames, repository paths, meetings, projects and private network links become visible. | Owner auth, narrow read scopes, redaction and explicit enabled local sources. Do not log entire state. |
| Dogfood, `/api/delegate`, Tell agent plans and connector setup prompts | Launches CLIs with filesystem access; prompts may contain untrusted notes/pages. Agents can change code/data. | Opt-in agent execution, fixed allowed workspaces, explicit confirmation for high-impact actions and clear receipts. Shell/agent capability must not follow from a read token. |
| Local stop/share/unshare, fleet pause/resume | Can stop processes, change launchd jobs or alter private sharing. | Separate host-control scope; disabled for public/demo clients. Never expose a broad self-service admin API on the internet. |
| Stash links, favicons, page titles, screenshots and ICS fetches | Server can reach destinations the requesting browser cannot, including local/tailnet services. Private link capture is intentional today. | If any access becomes untrusted, isolate fetching and enforce destination/redirect/DNS policy. Tester ICS restrictions do not automatically apply to core fetches. |
| Stash files, thumbnails and hero uploads | Private files, uploaded documents and stored active content. | File type/size limits, correct isolation headers, authenticated access and reviewed path containment. Hidden MCP spaces do not protect the general REST/file API. |
| Drafts and MCP | Read or alter messages before sending; a token can expose files via tools. Scoped grants bind attribution; legacy `?as=` remains caller-supplied. | Keep grants narrow and revocable; add resource constraints and preserve approval tied to the exact revision. Meridian does not send drafts, but an external agent may have sending tools. |
| Money | Bank transaction/portfolio data, refresh credentials and financial agent output. | Keep separate lock/cookie and files, least-privilege read-only provider credentials, finance-specific scoped agent access and separate audit. |
| Voice, summaries, ranking, Tell, ledger automation | Can send selected personal text/context to AI providers and incur costs. Some CLIs inherit environment/logins. | Opt in per feature; explain which data leaves the machine; enforce real quotas and timeouts. Presence of a CLI/key is not consent. |
| ntfy pushes | Titles and summary text go to a push server/topic; the topic functions as a capability secret. | Disabled until explicit subscription/setup. Fix boot auto-enrolment before public first run. |
| Tester recording/PostHog | Session playback and participant-derived content; optional third-party telemetry. | Recording only after consent, deletion/retention policy, synthetic default world and separate admin auth. No recording in ordinary installs. |

Private state includes `config.json`, `.bak`, `data/`, caches, ledger/meeting Markdown, delegations/logs, uploaded artwork/photos, tester records, account metadata, soul files and external home-directory session logs. Never include these in a release archive, issue attachment or screenshot. An ignore rule protects future commits, not past history. History review and credential rotation are a separate task, not performed by this OSS audit.

The Money cookie uses its own lock/password flow and throttling. That flow is a useful reference for a general owner login, but its own scope and deployment assumptions need review before reuse. Voice daily call counts are in memory, and browser-enforced session limits alone are not a reliable server spending boundary.

## Proposed first-run owner auth

For a supported non-tailnet setup, make loopback the initial bind and require a one-time setup action before listening more broadly. Do not write a default password/token to `config.example.json`.

1. Generate a one-time random setup token using `crypto.randomBytes`, shown once to the local terminal. Do not put it in normal access logs. Limit its lifetime and use; refuse remote setup.
2. Let the owner set a passphrase. Store a salted `crypto.scrypt` verifier in an owner-only auth file, with restrictive permissions and atomic writes. Never retain the plaintext passphrase. Short numeric passcodes need particularly strict rate limits; prefer a passphrase or a long random access token.
3. Create random, revocable sessions with server-side expiry. Use HttpOnly, SameSite cookies and Secure over HTTPS. Add CSRF/origin protections for browser writes. Login throttling must persist across process restarts.
4. Require owner auth on every privileged API, stream, static private document and tool. Public exceptions should be an explicit, reviewed allowlist of non-personal assets. Reject forged forwarding headers; trust only a configured proxy boundary.
5. Bind to a network interface only after auth is configured and explicitly enabled. Require TLS via a supported trusted proxy. Keep the current tailnet-only owner profile available, with a deliberate choice about whether it bypasses application auth.
6. Extend the dashboard grants above with selected-draft/Stash constraints, OAuth and a deliberate migration away from implicit local owner access. Preserve their token hashes, expiry/revocation and verified agent attribution.
7. Recovery must be a documented local CLI action, not a remote unauthenticated reset. Preserve Money's separate lock and finance scopes.

Before shipping, test unauthenticated GET/POST/streams/files, session expiry/logout/revocation, CSRF, forwarded-header spoofing, reverse-proxy loopback bypass, rate-limit persistence, uploaded active content, private fetch destinations and profile/storage isolation. Dashboard grant filtering, denials, expiry/revocation and legacy compatibility have fixture tests; broader owner auth remains a release gate.
