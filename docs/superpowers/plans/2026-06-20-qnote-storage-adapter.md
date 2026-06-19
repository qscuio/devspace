# Qnote Storage Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `qnote` as a DevSpace-managed private knowledge storage backend without turning the `qnote` repository into a package.

**Architecture:** Add a focused qnote module that shells out to Git for clone/pull/commit/push and uses filesystem reads/writes for Markdown. Add a separate read-only history-source module that discovers Claude/Codex/Cursor/ChatGPT/browser artifacts on the host where DevSpace runs. Register small MCP tools for search, read, sync, capture, and history scan/read. Writes default to `main` but stop on dirty state, non-fast-forward pulls, path traversal, duplicate hashes, or non-whitelisted destinations.

**Tech Stack:** TypeScript, Node fs/promises, child_process execFile, existing MCP tool registration, existing config loader.

---

### Task 1: Config Defaults

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `src/user-config.ts`

- [ ] **Step 1: Add failing config tests**

Run: `npx tsx src/config.test.ts`

Expected failure before implementation: `qnote` is missing from loaded config.

- [ ] **Step 2: Implement `QnoteConfig`**

Add config fields:

```ts
qnote: {
  enabled: boolean;
  dir: string;
  repoUrl: string;
  branch: string;
  autoPush: boolean;
  allowedDirs: string[];
}
```

Defaults:

```ts
enabled: true
dir: <DEVSPACE_STATE_DIR>/qnote
repoUrl: git@github.com:qscuio/qnote.git
branch: main
autoPush: true
allowedDirs: ["knowledge", "lessons", "skills", "misc", existing topic dirs]
```

- [ ] **Step 3: Verify config tests pass**

Run: `npx tsx src/config.test.ts`

Expected: PASS.

### Task 2: Qnote Store Core

**Files:**
- Create: `src/qnote.ts`
- Create: `src/qnote.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing unit tests**

Tests cover search, read, capture, duplicate content hash, path traversal rejection, dirty checkout rejection, and no-push capture.

Run: `npx tsx src/qnote.test.ts`

Expected failure before implementation: module not found.

- [ ] **Step 2: Implement qnote store**

Implement `createQnoteStore(config)` with methods:

```ts
status(): Promise<QnoteStatus>
sync(): Promise<QnoteSyncResult>
search(input): Promise<QnoteSearchResult>
read(input): Promise<QnoteReadResult>
capture(input): Promise<QnoteCaptureResult>
```

Capture writes Markdown frontmatter with `source_id`, `content_hash`, `captured_at`, and `tags`. It runs `git pull --ff-only` before writing and commits/pushes only when requested and safe.

- [ ] **Step 3: Verify qnote tests pass**

Run: `npx tsx src/qnote.test.ts`

Expected: PASS.

### Task 3: MCP Tool Registration

**Files:**
- Create: `src/qnote-tools.ts`
- Create: `src/qnote-history.ts`
- Create: `src/qnote-history.test.ts`
- Modify: `src/server.ts`
- Test: `src/qnote-tools.test.ts` or existing server/tool tests

- [ ] **Step 1: Add failing history-source tests**

Cover host-local discovery for:

- Codex: `~/.codex/memories/rollout_summaries`, `~/.codex/sessions`
- Claude: `~/.claude/projects`, `~/.claude`
- Cursor: `~/.cursor`, Windows Cursor workspace storage paths
- ChatGPT: official export directory containing `conversations.json`
- Browser profiles: Chrome/Edge/Firefox history databases as metadata sources for ChatGPT/Claude/Cursor web sessions

The browser profile adapter must report visits, titles, timestamps, and likely conversation IDs when available. It must describe browser History as metadata-only because full conversation content is normally server-side or stored in app-specific caches.

Run: `npx tsx src/qnote-history.test.ts`

Expected failure before implementation: module not found.

- [ ] **Step 2: Implement history scan/read helpers**

Implement:

```ts
scanHistorySources(input): Promise<QnoteHistoryScanResult>
readHistorySource(input): Promise<QnoteHistoryReadResult>
```

Scan returns bounded candidates with `id`, `source`, `path`, `kind`, `size`, `mtime`, `title`, and `notes`. Read returns bounded text/chunks from one candidate. This module is read-only and never uploads raw history automatically.

- [ ] **Step 3: Add failing tool registration test**

Verify `qnote_search`, `qnote_read`, `qnote_capture`, `qnote_sync`, and `qnote_history` are registered when qnote is enabled.

- [ ] **Step 4: Register tools**

Use small schemas and return structured JSON. Tool descriptions tell the model to summarize before `qnote_capture`; the tool stores the supplied summary, not raw hidden chat state. The `qnote_history` tool supports `scan` and `read` actions so clients can analyze Claude/Codex/Cursor/ChatGPT/browser histories before deciding what knowledge, lessons, or skills to capture.

- [ ] **Step 5: Verify tool tests pass**

Run related tests.

### Task 4: Verification And Deployment

**Files:**
- Modify: Ubuntu service environment if needed.

- [ ] **Step 1: Run local verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

- [ ] **Step 2: Commit and push**

Commit as `feat: add qnote storage tools` and push `codex/private-hardening` to `qscuio/devspace`.

- [ ] **Step 3: Deploy**

Pull on Ubuntu, build, restart `devspace.service`, and verify `qnote_sync` can either access the private repo or returns a clear setup error.
