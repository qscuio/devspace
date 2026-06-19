# NotebookLM UX Layer Design

## Goal

Make DevSpace's NotebookLM integration useful for users with many notebooks by adding a stable UX layer for discovery, metadata management, exact notebook selection, and source-grounded research. The integration should improve the user interface without making DevSpace depend on NotebookLM reliability for normal workspace tools.

## Current State

DevSpace currently exposes `notebooklm_*` tools by default and lazily bridges to the upstream `notebooklm-mcp` stdio server. This keeps the blast radius small: if NotebookLM browser automation fails, DevSpace workspace, file, and shell tools still work.

The upstream `notebooklm_list_notebooks` tool lists only the local MCP library. It does not discover notebooks that already exist in the user's Google NotebookLM account. The current bridge can ask a user-provided `notebook_url`, but users with many notebooks need discovery, names, aliases, tags, and exact selection.

## User Experience

The model-facing tool surface should move from raw upstream tools to a smaller, task-oriented interface:

- `notebooklm_status`: report auth state, upstream health, browser profile location, known notebook count, and repair suggestions.
- `notebooklm_discover`: scan the signed-in NotebookLM account for existing notebooks and import or update local metadata.
- `notebooklm_library`: list, search, update, tag, alias, select, and remove local notebook metadata.
- `notebooklm_research`: ask a question against an explicitly selected notebook or a confirmed best candidate.

Exact notebook selection must remain first-class. Users can query by:

- `notebook_id`: stable local library ID.
- `notebook_url`: direct NotebookLM URL for ad-hoc use.
- `notebook_name`: exact or fuzzy name match.
- `alias`: short user-defined handle, such as `dnx`, `strataxgs`, or `sdk`.
- `tags` or `topics`: metadata-based lookup.

If a query matches multiple notebooks or no notebook confidently, DevSpace should return candidates and ask the user to choose. It should not silently choose a low-confidence notebook for technical research.

## Discovery Workflow

`notebooklm_discover` is best-effort because it depends on NotebookLM's web UI rather than a stable public API.

The workflow:

1. Call DevSpace auth preflight first.
2. If unauthenticated, return a clear status with the next action: run `notebooklm_status` or auth setup.
3. Open the NotebookLM home/library page through the existing browser profile.
4. Extract visible notebook cards with title and URL.
5. Merge discovered records into DevSpace's local NotebookLM library.
6. Optionally enrich records by asking each notebook a short metadata question, bounded by a user-provided limit.
7. Return imported, updated, skipped, and failed counts with per-notebook diagnostics.

Discovery should support:

- `mode`: `scan` or `scan_and_enrich`.
- `limit`: maximum notebooks to inspect.
- `include_existing`: whether to refresh already-known notebook metadata.
- `tag`: optional tag applied to all imported notebooks.

## Authentication And Browser Profile Stability

The integration should treat repeated Google re-authentication prompts as a
recoverable product problem, not as normal user friction. DevSpace should own
the deployment-level profile policy and make it visible in `notebooklm_status`.

Default profile layout:

```text
<DEVSPACE_STATE_DIR>/notebooklm/browser-profile
<DEVSPACE_STATE_DIR>/notebooklm/browser-state
```

The UX layer should pass environment variables to upstream `notebooklm-mcp` so
browser data lives under the DevSpace state directory rather than an implicit
platform default. This makes VPS deployments predictable, backupable, and easier
to inspect.

Auth workflow:

1. `notebooklm_status` checks whether the upstream reports authenticated.
2. If authenticated, it also performs a lightweight page check when requested
   with `verify_browser: true`, because saved cookies can exist but no longer
   work against Google.
3. `notebooklm_research` and `notebooklm_discover` run a cheap auth preflight
   before doing expensive browser work.
4. If auth fails, tools return `not_authenticated` with one next action instead
   of repeatedly attempting doomed browser calls.
5. `notebooklm_status` should expose a repair action plan:
   - close conflicting Chrome/Chromium processes if the profile is locked.
   - run auth setup in visible-browser mode.
   - preserve library metadata while clearing only browser state when needed.

To reduce surprise re-authentication:

- Use one stable profile directory per DevSpace deployment.
- Avoid launching multiple upstream browser instances against the same profile.
- Serialize NotebookLM browser operations by default, or use isolated cloned
  profiles only when explicitly configured.
- Surface profile path, last auth check time, and last auth failure reason in
  `notebooklm_status`.

The system should not store Google passwords. It only persists browser cookies
and profile state created by the user's manual Google login.

## Local Library Model

Store DevSpace-managed NotebookLM metadata separately from upstream browser state. The default location should be under DevSpace state, for example:

```text
<DEVSPACE_STATE_DIR>/notebooklm/library.json
```

Each record should include:

```json
{
  "id": "local stable id",
  "url": "https://notebooklm.google.com/notebook/...",
  "name": "Broadcom DNX SDK",
  "aliases": ["dnx", "bcm-dnx"],
  "description": "Short user-visible summary",
  "topics": ["Broadcom DNX", "SDK", "Traffic Management"],
  "tags": ["broadcom", "sdk"],
  "source": "discovered | manual",
  "lastDiscoveredAt": "ISO timestamp",
  "lastEnrichedAt": "ISO timestamp"
}
```

The library should be owned by DevSpace UX code, not by the upstream package. Raw upstream `add_notebook` can still be used as an implementation detail only if it helps compatibility.

## Research Workflow

`notebooklm_research` should accept:

- `question`: required.
- `notebook`: optional selector string matching ID, name, alias, tag, or URL.
- `notebook_id`, `notebook_url`: explicit selectors for clients that prefer structured fields.
- `strategy`: `exact`, `auto`, or `confirm`.
- `conversation`: optional DevSpace-managed conversation key for follow-up questions.
- `show_browser`: optional debugging aid.

Behavior:

- If `notebook_url` is provided, ask that URL directly.
- If an exact `notebook_id` or alias is provided, ask that notebook.
- If a fuzzy selector has one high-confidence match, ask that notebook and include the chosen notebook in the response.
- If multiple candidates match, return a candidate list and ask the user to choose.
- If no candidate matches, suggest running discovery or asking by URL.
- If a previous upstream `session_id` times out or is rejected, automatically create a new upstream session and retry once.

Responses should include:

- chosen notebook name and URL.
- answer text.
- DevSpace conversation key and upstream session status if upstream provides one.
- warning/repair hint if upstream fails.

## Session Management

Users should not need to manage raw NotebookLM `session_id` values. DevSpace
should maintain a small session registry keyed by notebook and optional
conversation name:

```text
<DEVSPACE_STATE_DIR>/notebooklm/sessions.json
```

Each session record should include:

```json
{
  "conversation": "default",
  "notebookId": "local notebook id",
  "notebookUrl": "https://notebooklm.google.com/notebook/...",
  "upstreamSessionId": "session id returned by notebooklm-mcp",
  "createdAt": "ISO timestamp",
  "lastUsedAt": "ISO timestamp",
  "messageCount": 4
}
```

Before a research call, DevSpace should reuse a recent session for follow-up
context. If the upstream session is older than the configured TTL, missing, or
rejected by the upstream server, DevSpace should transparently start a new
upstream session and retry the question once. The response should include a
short note such as `session_refreshed: true` so the model can explain that the
conversation context may have restarted.

Session controls should be explicit but simple:

- `notebooklm_status` reports active session count and oldest session age.
- `notebooklm_research` accepts `fresh_session: true` to force a clean session.
- `notebooklm_library action="clear_sessions"` clears sessions by notebook,
  conversation, or all NotebookLM sessions.

## Error Handling

NotebookLM failures should be isolated and actionable. The UX layer should translate upstream failures into clear states:

- `not_authenticated`: run auth setup.
- `auth_state_stale`: saved browser state exists but Google requires login again.
- `browser_profile_locked`: another browser process is using the profile.
- `browser_failed`: browser automation failed; suggest cleanup or non-headless auth.
- `notebook_not_found`: selector did not match library records.
- `ambiguous_notebook`: multiple records matched; return candidates.
- `session_expired`: upstream session expired; DevSpace refreshed it and retried, or retry failed.
- `upstream_unavailable`: upstream MCP server could not start or respond.
- `rate_limited_or_blocked`: NotebookLM UI appears blocked or rate limited.

Normal DevSpace workspace tools must continue to work when any of these states occur.

## Implementation Boundaries

Keep three focused modules:

- `src/notebooklm.ts`: upstream stdio client lifecycle and raw tool calls.
- `src/notebooklm-library.ts`: DevSpace-owned metadata storage, matching, and updates.
- `src/notebooklm-tools.ts`: user-facing MCP tool registration and orchestration.

`src/server.ts` should only call a single registration function, rather than carrying NotebookLM workflow logic inline.

## Testing

Tests should not require a real Google account or NotebookLM UI.

Required test coverage:

- config defaults keep NotebookLM enabled and allow `DEVSPACE_NOTEBOOKLM=0`.
- tools are registered by default and hidden when disabled.
- discovery imports fake notebook cards into the local library.
- discovery updates existing records without duplicating URLs.
- research by exact ID uses the expected URL.
- research by alias uses the expected URL.
- research with ambiguous fuzzy match returns candidates instead of asking upstream.
- research reuses a recent DevSpace-managed upstream session.
- research retries once with a fresh upstream session when the previous session is expired or rejected.
- `fresh_session: true` bypasses the saved session.
- auth preflight returns `not_authenticated` before discovery or research tries browser automation.
- stale auth state produces a repair plan without deleting notebook metadata.
- profile lock errors produce a clear close-browser recommendation.
- upstream failure returns structured repair guidance.

Manual verification remains useful for real browser automation but should not be required for CI.

## Rollout

Keep the raw upstream bridge initially, but prefer the UX-layer tools in server instructions. Once the UX layer is stable, hide raw tools behind `DEVSPACE_NOTEBOOKLM_RAW_TOOLS=1` or remove them from the default surface.

The default experience should be:

1. `notebooklm_status`
2. `notebooklm_discover mode=scan_and_enrich limit=20`
3. `notebooklm_library query="dnx"`
4. `notebooklm_research notebook="dnx" question="How do I trap OAM packets to CPU?"`

## Design Decisions

- Discovery uses a DevSpace-owned browser helper behind a narrow interface because the upstream package does not expose account-level notebook discovery. The helper must be isolated from the rest of DevSpace and covered by fake-browser tests.
- Enriched metadata is stored only in the DevSpace library. Upstream `notebooklm-mcp` library storage remains an implementation detail and should not be the source of truth.
- After UX-layer tools land, raw upstream bridge tools are hidden by default and can be re-enabled with `DEVSPACE_NOTEBOOKLM_RAW_TOOLS=1` for debugging.
