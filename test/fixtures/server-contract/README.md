# Server contract fixtures

`routes.json` records status, Content-Type and recursive keys/types from the real
`server.js` at `c985d1c`, under the synthetic world in
`test/helpers/sandbox-server.cjs`. It contains no response values. Array entries
are the distinct item shapes, so membership, ordering and lengths may change.
Empty arrays and nulls are deliberately characterised as they appear in this
fixture, rather than inferred from a live account.

`tools.json` pins the ordered MCP tool names. Origin, JSON-RPC and named SSE
broadcasts use the existing handler marker seam with real draft/Stash tools.
The sandbox daemon rejects all non-GET/HEAD/OPTIONS requests with 503 before
Origin, auth or MCP dispatch. Tests pin that ordering separately. No job-enabled
daemon is booted.

Run the guarded suite before changing an expectation:

```sh
node --require ./test/helpers/isolate.cjs --test test/server-contract.test.js
```

Review a failure against the old implementation. For an approved contract
change, edit only its affected expectation and explain why. Never regenerate
these files from personal data or turn failures into automatic snapshot updates.
Research's held MCP version-negotiation patch will require updating the small
table in the initialise test; today's default/echo behaviour is intentional here.

When extraction creates callable server helpers, replace the marker slices in
`test/helpers/server-handler.cjs` with imports. Keep the real child-process GET,
auth, jobs-off, static and initial-stream checks intact.
