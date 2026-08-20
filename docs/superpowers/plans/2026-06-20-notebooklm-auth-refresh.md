# NotebookLM Auth Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a DevSpace-hosted NotebookLM browser-state refresh flow so stale Google auth can be repaired from a desktop link instead of SSH token copying.

**Architecture:** Keep NotebookLM auth-refresh logic isolated in a new module that owns one-time upload tokens, state-file validation, and safe writes. Wire small HTTP endpoints into `src/server.ts`, and point stale-auth repair hints at the endpoint.

**Tech Stack:** TypeScript, Express 5, Node fs/promises, existing DevSpace OAuth owner-token flow, existing NotebookLM workflow tests.

---

## File Structure

- Modify `src/notebooklm-discovery.ts`: keep the browser-based discovery adapter and exported path helper stable.
- Modify `src/notebooklm-workflows.ts`: return repair text that tells users to open the refresh flow when auth is stale.
- Create `src/notebooklm-auth-refresh.ts`: one-time token manager, upload validator, and atomic state writer.
- Create `src/notebooklm-auth-refresh.test.ts`: unit tests for token lifecycle and safe state upload.
- Modify `src/server.ts`: register `/notebooklm/auth-refresh` endpoints.
- Modify `src/server.test.ts`: exercise the HTTP upload path without real Google credentials.
- Modify `package.json`: add the new test file to `npm test`.

### Task 1: Browser Discovery Finish

**Files:**
- Modify: `src/notebooklm-discovery.ts`
- Modify: `src/notebooklm-tools.ts`
- Modify: `src/notebooklm-workflows.ts`
- Test: `src/notebooklm-discovery.test.ts`
- Test: `src/notebooklm-workflows.test.ts`

- [ ] **Step 1: Verify tests for discovery normalization**

Run: `npx tsx src/notebooklm-discovery.test.ts`

Expected: PASS with exit code 0.

- [ ] **Step 2: Verify workflow stale-auth repair hint**

Run: `npx tsx src/notebooklm-workflows.test.ts`

Expected: PASS with exit code 0.

- [ ] **Step 3: Commit discovery adapter**

```bash
git add package.json package-lock.json src/notebooklm-discovery.ts src/notebooklm-discovery.test.ts src/notebooklm-tools.ts src/notebooklm-workflows.ts
git commit -m "feat: add browser notebooklm discovery"
```

### Task 2: Auth-Refresh Unit

**Files:**
- Create: `src/notebooklm-auth-refresh.ts`
- Create: `src/notebooklm-auth-refresh.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing unit tests**

Add tests that create a manager with a temporary state path, call `createUploadToken`, upload a valid JSON state, assert the file is written, then assert the same token cannot be reused. Add invalid JSON and expired-token cases.

Run: `npx tsx src/notebooklm-auth-refresh.test.ts`

Expected: FAIL before implementation because `src/notebooklm-auth-refresh.ts` does not exist.

- [ ] **Step 2: Implement token manager and state writer**

The module should export `createNotebookLmAuthRefreshManager(options)` and methods:

```ts
createUploadToken(): { token: string; expiresAt: string };
uploadState(input: { token: string; body: unknown }): Promise<{ cookies: number; origins: number; path: string }>;
```

Validation requires an object body with `cookies` and `origins` arrays. The writer creates the parent directory, writes a temporary JSON file, renames it to the target state path, and applies mode `0600`.

- [ ] **Step 3: Run unit test**

Run: `npx tsx src/notebooklm-auth-refresh.test.ts`

Expected: PASS with exit code 0.

### Task 3: HTTP Endpoints

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Add HTTP test coverage**

Extend `src/server.test.ts` to request an upload token through a test-only manager, POST a valid browser state to the upload endpoint, and assert response status `200` with cookie and origin counts.

Run: `npm run build && npx tsx src/server.test.ts`

Expected: FAIL before server wiring because the route returns `404`.

- [ ] **Step 2: Wire routes**

Register:

- `GET /notebooklm/auth-refresh` returns a minimal HTML page with the upload URL and token metadata.
- `POST /notebooklm/auth-refresh/upload` accepts JSON body and one-time token.

Use `express.json({ limit: "2mb" })` only for this route group. Do not log uploaded cookie values.

- [ ] **Step 3: Run server test**

Run: `npm run build && npx tsx src/server.test.ts`

Expected: PASS with exit code 0.

### Task 4: Full Verification And Deployment

**Files:**
- Modify: deployment on `ubuntu@140.245.59.100`

- [ ] **Step 1: Run local verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 2: Commit implementation**

```bash
git add src/notebooklm-auth-refresh.ts src/notebooklm-auth-refresh.test.ts src/server.ts src/server.test.ts package.json package-lock.json
git commit -m "feat: add notebooklm auth refresh upload"
```

- [ ] **Step 3: Push branch**

Run: `git push origin codex/private-hardening`

Expected: push succeeds.

- [ ] **Step 4: Deploy on Ubuntu**

Run on `ubuntu@140.245.59.100 -p 65432`:

```bash
cd /home/ubuntu/devspace
git pull --ff-only
npm ci
npx patchright install chromium
npm run build
sudo systemctl restart devspace.service
```

Expected: service restarts cleanly.

- [ ] **Step 5: Verify deployment**

Run:

```bash
systemctl is-active devspace.service
systemctl is-active cloudflared.service
curl -fsS http://127.0.0.1:7676/healthz
```

Expected: both services are `active`; health response is `{"ok":true,"name":"devspace"}`.

## Self Review

The plan covers the approved design: one-time upload tokens, safe browser-state writes, HTTP upload route, stale-auth repair direction, tests, and Ubuntu deployment verification. It intentionally leaves the fully automatic desktop helper as a follow-up because the server upload endpoint is the required foundation and can be tested without browser credentials.
