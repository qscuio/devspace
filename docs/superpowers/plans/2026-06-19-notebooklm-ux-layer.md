# NotebookLM UX Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a DevSpace-owned NotebookLM UX layer with account discovery, local notebook metadata, exact notebook selection, managed sessions, auth preflight, and stable user-facing tools.

**Architecture:** Keep upstream `notebooklm-mcp` behind `src/notebooklm.ts`, but move all user-facing behavior into focused DevSpace modules. Store NotebookLM library and session metadata under `<DEVSPACE_STATE_DIR>/notebooklm/`. Register high-level tools from `src/notebooklm-tools.ts` and keep raw bridge tools behind `DEVSPACE_NOTEBOOKLM_RAW_TOOLS=1`.

**Tech Stack:** TypeScript, Node fs APIs, `@modelcontextprotocol/sdk`, `zod/v4`, existing `tsx` assert-style tests, existing DevSpace MCP server registration patterns.

---

## File Structure

- Create `src/notebooklm-library.ts`: local metadata storage, URL normalization, stable IDs, search/match, merge, update, and clear-session routing helpers.
- Create `src/notebooklm-library.test.ts`: unit tests for metadata storage and matching.
- Create `src/notebooklm-sessions.ts`: DevSpace-managed upstream session registry and retry decision logic.
- Create `src/notebooklm-sessions.test.ts`: unit tests for session reuse, expiration, forced fresh sessions, and clear operations.
- Create `src/notebooklm-workflows.ts`: orchestration for status, discover, library actions, and research using injected upstream and discovery adapters.
- Create `src/notebooklm-workflows.test.ts`: unit tests for auth preflight, research routing, ambiguous candidates, session refresh retry, and discovery merge.
- Create `src/notebooklm-tools.ts`: MCP tool registration for high-level NotebookLM tools and optional raw tools.
- Modify `src/notebooklm.ts`: add profile env support, structured upstream error mapping, and fake-friendly interfaces.
- Modify `src/config.ts`, `src/user-config.ts`, `src/config.test.ts`: add `rawTools`, profile path, session TTL, and discovery defaults.
- Modify `src/server.ts`: remove inline NotebookLM registration and call `registerNotebookLmTools`.
- Modify `src/notebooklm-tools.test.ts`: update tool expectations from raw tools to UX-layer tools.
- Modify `package.json`: add new test files to `npm test`.
- Modify docs: `README.md`, `docs/configuration.md`, `docs/security.md`, and `docs/gotchas.md`.

## Task 1: NotebookLM Config Surface

**Files:**
- Modify: `src/config.ts`
- Modify: `src/user-config.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Add assertions to `src/config.test.ts` after the existing NotebookLM config assertions:

```ts
assert.equal(loadConfig(baseEnv).notebooklm.rawTools, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM_RAW_TOOLS: "1" }).notebooklm.rawTools, true);
assert.equal(loadConfig(baseEnv).notebooklm.sessionTtlSeconds, 900);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS: "120" }).notebooklm.sessionTtlSeconds,
  120,
);
assert.match(loadConfig(baseEnv).notebooklm.dataDir, /notebooklm$/);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM_DATA_DIR: "C:\\tmp\\notebooklm-data" }).notebooklm.dataDir,
  "C:\\tmp\\notebooklm-data",
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS: 0/,
);
```

- [ ] **Step 2: Run config test to verify failure**

Run:

```bash
npx tsx src/config.test.ts
```

Expected: FAIL because `rawTools`, `sessionTtlSeconds`, and `dataDir` are not present.

- [ ] **Step 3: Implement config fields**

Update `NotebookLmConfig` in `src/config.ts`:

```ts
export interface NotebookLmConfig {
  enabled: boolean;
  rawTools: boolean;
  command: string;
  args: string[];
  dataDir: string;
  sessionTtlSeconds: number;
}
```

Add:

```ts
function defaultNotebookLmDataDir(stateDir: string): string {
  return join(stateDir, "notebooklm");
}
```

Update `parseNotebookLmConfig` to accept `stateDir` and return:

```ts
return {
  enabled: env.DEVSPACE_NOTEBOOKLM === undefined
    ? fileValue?.enabled ?? true
    : parseBoolean(env.DEVSPACE_NOTEBOOKLM),
  rawTools: env.DEVSPACE_NOTEBOOKLM_RAW_TOOLS === undefined
    ? fileValue?.rawTools ?? false
    : parseBoolean(env.DEVSPACE_NOTEBOOKLM_RAW_TOOLS),
  command: env.DEVSPACE_NOTEBOOKLM_COMMAND?.trim() || fileValue?.command || DEFAULT_NOTEBOOKLM_COMMAND,
  args: parseStringList(env.DEVSPACE_NOTEBOOKLM_ARGS, fileValue?.args ?? DEFAULT_NOTEBOOKLM_ARGS),
  dataDir: resolve(expandHomePath(env.DEVSPACE_NOTEBOOKLM_DATA_DIR ?? fileValue?.dataDir ?? defaultNotebookLmDataDir(stateDir))),
  sessionTtlSeconds: parsePositiveInteger(
    env.DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS,
    fileValue?.sessionTtlSeconds ?? 900,
    "DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS",
  ),
};
```

Update `loadConfig` to compute `stateDir` before the return object and pass it into `parseNotebookLmConfig`.

Update `DevspaceUserConfig.notebooklm` in `src/user-config.ts`:

```ts
notebooklm?: {
  enabled?: boolean;
  rawTools?: boolean;
  command?: string;
  args?: string[];
  dataDir?: string;
  sessionTtlSeconds?: number;
};
```

- [ ] **Step 4: Run config test to verify pass**

Run:

```bash
npx tsx src/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/config.ts src/user-config.ts src/config.test.ts
git commit -m "feat: add NotebookLM UX config"
```

## Task 2: Local Notebook Library

**Files:**
- Create: `src/notebooklm-library.ts`
- Create: `src/notebooklm-library.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing library tests**

Create `src/notebooklm-library.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NotebookLmLibraryStore,
  normalizeNotebookUrl,
} from "./notebooklm-library.js";

const dataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-library-test-"));
const store = new NotebookLmLibraryStore(dataDir);

assert.equal(
  normalizeNotebookUrl("https://notebooklm.google.com/notebook/abc?pli=1#x"),
  "https://notebooklm.google.com/notebook/abc",
);

const first = await store.upsert({
  url: "https://notebooklm.google.com/notebook/abc?pli=1",
  name: "Broadcom DNX SDK",
  aliases: ["dnx"],
  description: "DNX docs",
  topics: ["Broadcom DNX", "Traffic Management"],
  tags: ["broadcom", "sdk"],
  source: "manual",
});
assert.equal(first.id, "abc");

const second = await store.upsert({
  url: "https://notebooklm.google.com/notebook/abc",
  name: "Broadcom DNX SDK Updated",
  aliases: ["jericho"],
  description: "Updated",
  topics: ["OAM"],
  tags: ["dnx"],
  source: "discovered",
});
assert.equal(second.id, "abc");
assert.deepEqual(second.aliases.sort(), ["dnx", "jericho"]);
assert.deepEqual(second.tags.sort(), ["broadcom", "dnx", "sdk"]);

const records = await store.list();
assert.equal(records.length, 1);
assert.equal(records[0]?.name, "Broadcom DNX SDK Updated");

assert.equal((await store.resolve({ notebook: "dnx" })).status, "matched");
assert.equal((await store.resolve({ notebook: "Broadcom" })).status, "matched");

await store.upsert({
  url: "https://notebooklm.google.com/notebook/def",
  name: "Broadcom StrataXGS SDK",
  aliases: ["strataxgs"],
  description: "Strata docs",
  topics: ["Broadcom StrataXGS"],
  tags: ["broadcom"],
  source: "manual",
});

const ambiguous = await store.resolve({ notebook: "Broadcom" });
assert.equal(ambiguous.status, "ambiguous");
assert.equal(ambiguous.candidates.length, 2);

assert.equal((await store.resolve({ notebook: "missing" })).status, "not_found");
```

Add `tsx src/notebooklm-library.test.ts` to `package.json` test script after `src/notebooklm-tools.test.ts`.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx tsx src/notebooklm-library.test.ts
```

Expected: FAIL because `src/notebooklm-library.ts` does not exist.

- [ ] **Step 3: Implement library store**

Create `src/notebooklm-library.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type NotebookSource = "manual" | "discovered";

export interface NotebookRecord {
  id: string;
  url: string;
  name: string;
  aliases: string[];
  description: string;
  topics: string[];
  tags: string[];
  source: NotebookSource;
  lastDiscoveredAt?: string;
  lastEnrichedAt?: string;
}

export interface NotebookUpsertInput {
  url: string;
  name: string;
  aliases?: string[];
  description?: string;
  topics?: string[];
  tags?: string[];
  source: NotebookSource;
  discoveredAt?: string;
  enrichedAt?: string;
}

export type NotebookResolveResult =
  | { status: "matched"; notebook: NotebookRecord }
  | { status: "ambiguous"; candidates: NotebookRecord[] }
  | { status: "not_found"; candidates: NotebookRecord[] };

export function normalizeNotebookUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function notebookIdFromUrl(value: string): string {
  const parsed = new URL(normalizeNotebookUrl(value));
  const id = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!id) throw new Error(`Notebook URL does not contain an id: ${value}`);
  return id;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function scoreNotebook(record: NotebookRecord, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  if (record.id.toLowerCase() === normalized) return 100;
  if (record.url.toLowerCase() === normalized) return 100;
  if (record.aliases.some((alias) => alias.toLowerCase() === normalized)) return 95;
  if (record.name.toLowerCase() === normalized) return 90;
  if (record.name.toLowerCase().includes(normalized)) return 70;
  if (record.tags.some((tag) => tag.toLowerCase() === normalized)) return 65;
  if (record.topics.some((topic) => topic.toLowerCase().includes(normalized))) return 55;
  return 0;
}

export class NotebookLmLibraryStore {
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, "library.json");
  }

  async list(): Promise<NotebookRecord[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as NotebookRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async upsert(input: NotebookUpsertInput): Promise<NotebookRecord> {
    const records = await this.list();
    const url = normalizeNotebookUrl(input.url);
    const id = notebookIdFromUrl(url);
    const existing = records.find((record) => record.id === id || record.url === url);
    const merged: NotebookRecord = {
      id,
      url,
      name: input.name,
      aliases: uniqueSorted([...(existing?.aliases ?? []), ...(input.aliases ?? [])]),
      description: input.description ?? existing?.description ?? "",
      topics: uniqueSorted([...(existing?.topics ?? []), ...(input.topics ?? [])]),
      tags: uniqueSorted([...(existing?.tags ?? []), ...(input.tags ?? [])]),
      source: input.source,
      lastDiscoveredAt: input.discoveredAt ?? existing?.lastDiscoveredAt,
      lastEnrichedAt: input.enrichedAt ?? existing?.lastEnrichedAt,
    };
    const next = existing
      ? records.map((record) => record.id === existing.id ? merged : record)
      : [...records, merged];
    await this.save(next);
    return merged;
  }

  async resolve(selector: { notebook?: string; notebookId?: string; notebookUrl?: string }): Promise<NotebookResolveResult> {
    const records = await this.list();
    const query = selector.notebookUrl
      ? normalizeNotebookUrl(selector.notebookUrl)
      : selector.notebookId ?? selector.notebook ?? "";
    const scored = records
      .map((record) => ({ record, score: scoreNotebook(record, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return { status: "not_found", candidates: [] };
    if (scored.length === 1 || scored[0]!.score >= scored[1]!.score + 20) {
      return { status: "matched", notebook: scored[0]!.record };
    }
    return { status: "ambiguous", candidates: scored.map((entry) => entry.record) };
  }

  private async save(records: NotebookRecord[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }
}
```

- [ ] **Step 4: Run library test to verify pass**

Run:

```bash
npx tsx src/notebooklm-library.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/notebooklm-library.ts src/notebooklm-library.test.ts package.json
git commit -m "feat: add NotebookLM library store"
```

## Task 3: Managed Session Registry

**Files:**
- Create: `src/notebooklm-sessions.ts`
- Create: `src/notebooklm-sessions.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing session tests**

Create `src/notebooklm-sessions.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookLmSessionStore } from "./notebooklm-sessions.js";

const dataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-session-test-"));
const store = new NotebookLmSessionStore(dataDir, 900);
const now = new Date("2026-06-19T10:00:00.000Z");

assert.equal(await store.getReusableSession({
  notebookId: "abc",
  notebookUrl: "https://notebooklm.google.com/notebook/abc",
  conversation: "default",
  now,
}), undefined);

await store.saveSession({
  notebookId: "abc",
  notebookUrl: "https://notebooklm.google.com/notebook/abc",
  conversation: "default",
  upstreamSessionId: "up-1",
  now,
});

assert.equal((await store.getReusableSession({
  notebookId: "abc",
  notebookUrl: "https://notebooklm.google.com/notebook/abc",
  conversation: "default",
  now: new Date("2026-06-19T10:05:00.000Z"),
}))?.upstreamSessionId, "up-1");

assert.equal(await store.getReusableSession({
  notebookId: "abc",
  notebookUrl: "https://notebooklm.google.com/notebook/abc",
  conversation: "default",
  now: new Date("2026-06-19T10:20:01.000Z"),
}), undefined);

await store.saveSession({
  notebookId: "abc",
  notebookUrl: "https://notebooklm.google.com/notebook/abc",
  conversation: "debug",
  upstreamSessionId: "up-2",
  now,
});

assert.equal((await store.stats()).activeSessions, 2);
await store.clear({ notebookId: "abc", conversation: "default" });
assert.equal((await store.stats()).activeSessions, 1);
await store.clear({});
assert.equal((await store.stats()).activeSessions, 0);
```

Add `tsx src/notebooklm-sessions.test.ts` to `package.json` test script.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx tsx src/notebooklm-sessions.test.ts
```

Expected: FAIL because `src/notebooklm-sessions.ts` does not exist.

- [ ] **Step 3: Implement session store**

Create `src/notebooklm-sessions.ts` with:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface NotebookSessionRecord {
  conversation: string;
  notebookId: string;
  notebookUrl: string;
  upstreamSessionId: string;
  createdAt: string;
  lastUsedAt: string;
  messageCount: number;
}

export class NotebookLmSessionStore {
  private readonly filePath: string;

  constructor(private readonly dataDir: string, private readonly ttlSeconds: number) {
    this.filePath = join(dataDir, "sessions.json");
  }

  async getReusableSession(input: {
    notebookId: string;
    notebookUrl: string;
    conversation?: string;
    now?: Date;
  }): Promise<NotebookSessionRecord | undefined> {
    const now = input.now ?? new Date();
    const conversation = input.conversation ?? "default";
    const record = (await this.list()).find((session) =>
      session.notebookId === input.notebookId &&
      session.notebookUrl === input.notebookUrl &&
      session.conversation === conversation
    );
    if (!record) return undefined;
    const ageSeconds = (now.getTime() - new Date(record.lastUsedAt).getTime()) / 1000;
    return ageSeconds <= this.ttlSeconds ? record : undefined;
  }

  async saveSession(input: {
    notebookId: string;
    notebookUrl: string;
    conversation?: string;
    upstreamSessionId: string;
    now?: Date;
  }): Promise<NotebookSessionRecord> {
    const now = (input.now ?? new Date()).toISOString();
    const conversation = input.conversation ?? "default";
    const records = await this.list();
    const existing = records.find((session) =>
      session.notebookId === input.notebookId &&
      session.notebookUrl === input.notebookUrl &&
      session.conversation === conversation
    );
    const nextRecord: NotebookSessionRecord = {
      conversation,
      notebookId: input.notebookId,
      notebookUrl: input.notebookUrl,
      upstreamSessionId: input.upstreamSessionId,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      messageCount: (existing?.messageCount ?? 0) + 1,
    };
    const next = existing
      ? records.map((record) => record === existing ? nextRecord : record)
      : [...records, nextRecord];
    await this.save(next);
    return nextRecord;
  }

  async clear(input: { notebookId?: string; conversation?: string }): Promise<number> {
    const records = await this.list();
    const next = records.filter((record) => {
      if (input.notebookId && record.notebookId !== input.notebookId) return true;
      if (input.conversation && record.conversation !== input.conversation) return true;
      return false;
    });
    await this.save(next);
    return records.length - next.length;
  }

  async stats(): Promise<{ activeSessions: number; oldestSessionAgeSeconds?: number }> {
    const records = await this.list();
    if (records.length === 0) return { activeSessions: 0 };
    const now = Date.now();
    const oldest = Math.max(...records.map((record) => now - new Date(record.createdAt).getTime()));
    return { activeSessions: records.length, oldestSessionAgeSeconds: Math.round(oldest / 1000) };
  }

  private async list(): Promise<NotebookSessionRecord[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as NotebookSessionRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async save(records: NotebookSessionRecord[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }
}
```

- [ ] **Step 4: Run session test to verify pass**

Run:

```bash
npx tsx src/notebooklm-sessions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/notebooklm-sessions.ts src/notebooklm-sessions.test.ts package.json
git commit -m "feat: manage NotebookLM sessions"
```

## Task 4: Upstream Client Stability And Profile Env

**Files:**
- Modify: `src/notebooklm.ts`
- Create: `src/notebooklm.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing upstream client tests**

Create `src/notebooklm.test.ts`:

```ts
import assert from "node:assert/strict";
import { createNotebookLmEnvironment, mapNotebookLmError } from "./notebooklm.js";

const env = createNotebookLmEnvironment({
  enabled: true,
  rawTools: false,
  command: "npx",
  args: ["notebooklm-mcp"],
  dataDir: "C:\\tmp\\devspace-notebooklm",
  sessionTtlSeconds: 900,
});

assert.equal(env.NOTEBOOKLM_MCP_DATA_DIR, "C:\\tmp\\devspace-notebooklm");
assert.equal(env.NOTEBOOK_PROFILE_STRATEGY, "single");
assert.equal(env.NOTEBOOK_CLEANUP_ON_STARTUP, "false");

assert.equal(mapNotebookLmError(new Error("missing Cloudflare Access token")).code, "upstream_unavailable");
assert.equal(mapNotebookLmError(new Error("Target page, context or browser has been closed")).code, "browser_failed");
assert.equal(mapNotebookLmError(new Error("profile is already in use")).code, "browser_profile_locked");
assert.equal(mapNotebookLmError(new Error("Login required")).code, "not_authenticated");
```

Add `tsx src/notebooklm.test.ts` to `package.json` test script.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx tsx src/notebooklm.test.ts
```

Expected: FAIL because exported helpers do not exist.

- [ ] **Step 3: Implement environment and error mapping**

In `src/notebooklm.ts`, add:

```ts
export interface NotebookLmMappedError {
  code:
    | "not_authenticated"
    | "auth_state_stale"
    | "browser_profile_locked"
    | "browser_failed"
    | "upstream_unavailable";
  message: string;
  repairHint: string;
}

export function createNotebookLmEnvironment(config: NotebookLmConfig): Record<string, string> {
  return {
    NOTEBOOKLM_MCP_DATA_DIR: config.dataDir,
    NOTEBOOK_PROFILE_STRATEGY: "single",
    NOTEBOOK_CLEANUP_ON_STARTUP: "false",
    NOTEBOOK_CLEANUP_ON_SHUTDOWN: "true",
  };
}

export function mapNotebookLmError(error: unknown): NotebookLmMappedError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("profile") && lower.includes("use")) {
    return { code: "browser_profile_locked", message, repairHint: "Close other Chrome/Chromium instances using the NotebookLM profile, then retry." };
  }
  if (lower.includes("login") || lower.includes("auth")) {
    return { code: "not_authenticated", message, repairHint: "Run notebooklm_status or notebooklm_setup_auth with a visible browser." };
  }
  if (lower.includes("browser") || lower.includes("page") || lower.includes("context")) {
    return { code: "browser_failed", message, repairHint: "Retry with visible browser or refresh the NotebookLM browser profile." };
  }
  return { code: "upstream_unavailable", message, repairHint: "Check that notebooklm-mcp can start and that Node/npm are available." };
}
```

Update `StdioClientTransport` construction:

```ts
env: {
  ...process.env,
  ...createNotebookLmEnvironment(this.config),
} as Record<string, string>,
```

Wrap `callTool` errors:

```ts
try {
  return await client.callTool({ name, arguments: args }, CallToolResultSchema) as CallToolResult;
} catch (error) {
  const mapped = mapNotebookLmError(error);
  throw new Error(`${mapped.code}: ${mapped.message}`);
}
```

- [ ] **Step 4: Run upstream client test to verify pass**

Run:

```bash
npx tsx src/notebooklm.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/notebooklm.ts src/notebooklm.test.ts package.json
git commit -m "feat: stabilize NotebookLM upstream client"
```

## Task 5: Workflow Layer

**Files:**
- Create: `src/notebooklm-workflows.ts`
- Create: `src/notebooklm-workflows.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing workflow tests**

Create `src/notebooklm-workflows.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookLmLibraryStore } from "./notebooklm-library.js";
import { NotebookLmSessionStore } from "./notebooklm-sessions.js";
import { NotebookLmWorkflows } from "./notebooklm-workflows.js";
import type { NotebookLmClient } from "./notebooklm.js";

const dataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-workflows-test-"));
const library = new NotebookLmLibraryStore(dataDir);
const sessions = new NotebookLmSessionStore(dataDir, 900);
const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];

const client: NotebookLmClient = {
  async callTool(name, args) {
    calls.push({ name, args });
    if (name === "get_health") {
      return { content: [{ type: "text", text: "ok" }], structuredContent: { authenticated: true, status: "ok" } };
    }
    if (name === "ask_question") {
      return {
        content: [{ type: "text", text: "answer" }],
        structuredContent: { session_id: args?.session_id ?? "new-session", answer: "answer" },
      };
    }
    return { content: [{ type: "text", text: "ok" }] };
  },
  async close() {},
};

const workflows = new NotebookLmWorkflows({ library, sessions, client, dataDir });
await library.upsert({
  url: "https://notebooklm.google.com/notebook/abc",
  name: "Broadcom DNX SDK",
  aliases: ["dnx"],
  description: "DNX docs",
  topics: ["DNX"],
  tags: ["broadcom"],
  source: "manual",
});
await library.upsert({
  url: "https://notebooklm.google.com/notebook/def",
  name: "Broadcom StrataXGS SDK",
  aliases: ["strataxgs"],
  description: "Strata docs",
  topics: ["StrataXGS"],
  tags: ["broadcom"],
  source: "manual",
});

const status = await workflows.status({});
assert.equal(status.status, "ok");
assert.equal(status.authenticated, true);
assert.equal(status.knownNotebooks, 2);

const ambiguous = await workflows.research({ question: "How?", notebook: "Broadcom" });
assert.equal(ambiguous.status, "ambiguous_notebook");
assert.equal(ambiguous.candidates?.length, 2);
assert.equal(calls.some((call) => call.name === "ask_question"), false);

const answer = await workflows.research({ question: "How?", notebook: "dnx" });
assert.equal(answer.status, "ok");
assert.equal(answer.notebook?.id, "abc");
assert.equal(calls.at(-1)?.args?.notebook_url, "https://notebooklm.google.com/notebook/abc");
assert.equal(answer.sessionRefreshed, true);

const followup = await workflows.research({ question: "Follow up", notebook: "dnx" });
assert.equal(followup.status, "ok");
assert.equal(calls.at(-1)?.args?.session_id, "new-session");
```

Add `tsx src/notebooklm-workflows.test.ts` to `package.json` test script.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npx tsx src/notebooklm-workflows.test.ts
```

Expected: FAIL because `src/notebooklm-workflows.ts` does not exist.

- [ ] **Step 3: Implement workflows**

Create `src/notebooklm-workflows.ts` with a `NotebookLmWorkflows` class that:

```ts
export class NotebookLmWorkflows {
  constructor(private readonly deps: {
    library: NotebookLmLibraryStore;
    sessions: NotebookLmSessionStore;
    client: NotebookLmClient;
    dataDir: string;
  }) {}
}
```

Implement:

- `status({ verifyBrowser?: boolean })`: calls `get_health`, reads notebook count and session stats, returns `{ status, authenticated, knownNotebooks, sessions, dataDir, repairPlan }`.
- `research(input)`: resolves notebook by URL/ID/selector, returns candidates on ambiguity, runs `get_health` preflight, reuses session unless `fresh_session`, calls `ask_question`, saves returned `session_id`, retries once without `session_id` when the first call fails with a session-related error.
- `library(input)`: supports `list`, `search`, and `clear_sessions` actions.
- `discover(input)`: initially uses an injected optional discoverer; if none is configured, returns `status: "browser_failed"` with a message that browser discovery is not wired yet. Task 7 wires the browser helper.

Use a response union with status strings from the spec. Keep all returned objects JSON-serializable.

- [ ] **Step 4: Run workflow test to verify pass**

Run:

```bash
npx tsx src/notebooklm-workflows.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/notebooklm-workflows.ts src/notebooklm-workflows.test.ts package.json
git commit -m "feat: add NotebookLM workflows"
```

## Task 6: User-Facing MCP Tools

**Files:**
- Create: `src/notebooklm-tools.ts`
- Modify: `src/server.ts`
- Modify: `src/notebooklm-tools.test.ts`

- [ ] **Step 1: Write failing MCP registration tests**

Replace `src/notebooklm-tools.test.ts` expectations with high-level tools:

```ts
assert.ok(toolNames.includes("notebooklm_status"));
assert.ok(toolNames.includes("notebooklm_discover"));
assert.ok(toolNames.includes("notebooklm_library"));
assert.ok(toolNames.includes("notebooklm_research"));
assert.ok(!toolNames.includes("notebooklm_get_health"));
assert.ok(!toolNames.includes("notebooklm_ask_question"));
```

Add a second config case with `DEVSPACE_NOTEBOOKLM_RAW_TOOLS: "1"` and assert raw tools are visible in that case.

Update the call assertion:

```ts
const result = await client.callTool({
  name: "notebooklm_research",
  arguments: {
    question: "What is in this notebook?",
    notebook_url: "https://notebooklm.google.com/notebook/example",
  },
}) as CallToolResult;
assert.equal(result.content[0]?.type, "text");
```

- [ ] **Step 2: Run MCP test to verify failure**

Run:

```bash
npx tsx src/notebooklm-tools.test.ts
```

Expected: FAIL because server still registers raw tools inline.

- [ ] **Step 3: Implement `src/notebooklm-tools.ts`**

Create a `registerNotebookLmTools` export:

```ts
export function registerNotebookLmTools(server: McpServer, config: ServerConfig, factory: NotebookLmClientFactory): void {
  if (!config.notebooklm.enabled) return;
  const dataDir = config.notebooklm.dataDir;
  const library = new NotebookLmLibraryStore(dataDir);
  const sessions = new NotebookLmSessionStore(dataDir, config.notebooklm.sessionTtlSeconds);
  const client = factory();
  const workflows = new NotebookLmWorkflows({ library, sessions, client, dataDir });

  server.registerTool(
    "notebooklm_status",
    {
      title: "NotebookLM status",
      description: "Report NotebookLM auth, profile, library, session, and repair status.",
      inputSchema: { verify_browser: z.boolean().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => formatToolResult(await workflows.status(args)),
  );

  server.registerTool(
    "notebooklm_discover",
    {
      title: "Discover NotebookLM notebooks",
      description: "Scan the signed-in NotebookLM account and import visible notebooks into DevSpace metadata.",
      inputSchema: {
        mode: z.enum(["scan", "scan_and_enrich"]).optional(),
        limit: z.number().int().positive().max(200).optional(),
        include_existing: z.boolean().optional(),
        tag: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => formatToolResult(await workflows.discover(args)),
  );

  server.registerTool(
    "notebooklm_library",
    {
      title: "Manage NotebookLM library",
      description: "List, search, update, tag, alias, remove, or clear sessions for DevSpace NotebookLM metadata.",
      inputSchema: {
        action: z.enum(["list", "search", "update", "remove", "clear_sessions"]).optional(),
        query: z.string().optional(),
        id: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        conversation: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => formatToolResult(await workflows.library(args)),
  );

  server.registerTool(
    "notebooklm_research",
    {
      title: "Research with NotebookLM",
      description: "Ask a source-grounded question against a selected NotebookLM notebook or confirmed candidate.",
      inputSchema: {
        question: z.string(),
        notebook: z.string().optional(),
        notebook_id: z.string().optional(),
        notebook_url: z.string().optional(),
        strategy: z.enum(["exact", "auto", "confirm"]).optional(),
        conversation: z.string().optional(),
        fresh_session: z.boolean().optional(),
        show_browser: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => formatToolResult(await workflows.research(args)),
  );

  if (config.notebooklm.rawTools) registerRawNotebookLmTools(server, client);
}
```

Use `zod/v4` schemas:

```ts
notebooklm_research inputSchema: {
  question: z.string(),
  notebook: z.string().optional(),
  notebook_id: z.string().optional(),
  notebook_url: z.string().optional(),
  strategy: z.enum(["exact", "auto", "confirm"]).optional(),
  conversation: z.string().optional(),
  fresh_session: z.boolean().optional(),
  show_browser: z.boolean().optional(),
}
```

Implement `formatToolResult(value)` as:

```ts
function formatToolResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: value as Record<string, unknown>,
  };
}
```

- [ ] **Step 4: Modify `src/server.ts`**

Remove inline `registerNotebookLmTools` from `src/server.ts`.

Import:

```ts
import { registerNotebookLmTools } from "./notebooklm-tools.js";
```

Keep this call in `createMcpServer`:

```ts
registerNotebookLmTools(server, config, notebookLmClientFactory);
```

- [ ] **Step 5: Run MCP test to verify pass**

Run:

```bash
npx tsx src/notebooklm-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/server.ts src/notebooklm-tools.ts src/notebooklm-tools.test.ts
git commit -m "feat: expose NotebookLM UX tools"
```

## Task 7: Account Discovery Adapter

**Files:**
- Create: `src/notebooklm-discovery.ts`
- Create: `src/notebooklm-discovery.test.ts`
- Modify: `src/notebooklm-workflows.ts`
- Modify: `src/notebooklm-workflows.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing discovery adapter tests**

Create `src/notebooklm-discovery.test.ts`:

```ts
import assert from "node:assert/strict";
import { extractNotebookCardsFromHtml } from "./notebooklm-discovery.js";

const html = `
  <a href="/notebook/abc"><span>Broadcom DNX SDK</span></a>
  <a href="https://notebooklm.google.com/notebook/def?pli=1"><span>StrataXGS</span></a>
  <a href="/notebook/abc"><span>Broadcom DNX SDK</span></a>
`;

const cards = extractNotebookCardsFromHtml(html, "https://notebooklm.google.com");
assert.deepEqual(cards, [
  { name: "Broadcom DNX SDK", url: "https://notebooklm.google.com/notebook/abc" },
  { name: "StrataXGS", url: "https://notebooklm.google.com/notebook/def" },
]);
```

Add `tsx src/notebooklm-discovery.test.ts` to `package.json` test script.

- [ ] **Step 2: Run discovery test to verify failure**

Run:

```bash
npx tsx src/notebooklm-discovery.test.ts
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement HTML extraction and discoverer interface**

Create `src/notebooklm-discovery.ts`:

```ts
export interface DiscoveredNotebookCard {
  name: string;
  url: string;
}

export interface NotebookLmDiscoverer {
  discover(input: { limit: number }): Promise<DiscoveredNotebookCard[]>;
}

export function extractNotebookCardsFromHtml(html: string, baseUrl: string): DiscoveredNotebookCard[] {
  const anchorPattern = /<a\b[^>]*href=["']([^"']*\/notebook\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const cards: DiscoveredNotebookCard[] = [];
  for (const match of html.matchAll(anchorPattern)) {
    const url = normalizeNotebookUrl(new URL(match[1]!, baseUrl).toString());
    if (seen.has(url)) continue;
    const text = match[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    seen.add(url);
    cards.push({ name: text, url });
  }
  return cards;
}
```

Import `normalizeNotebookUrl` from `src/notebooklm-library.ts`.

- [ ] **Step 4: Wire workflows discovery with injected discoverer**

Update `NotebookLmWorkflows` deps:

```ts
discoverer?: NotebookLmDiscoverer;
```

Implement `discover(input)`:

```ts
if (!this.deps.discoverer) {
  return { status: "browser_failed", message: "NotebookLM account discovery is not configured.", repairHint: "Ask by notebook URL or configure the discovery adapter." };
}
const cards = await this.deps.discoverer.discover({ limit: input.limit ?? 20 });
const imported = [];
for (const card of cards) {
  imported.push(await this.deps.library.upsert({
    url: card.url,
    name: card.name,
    aliases: [],
    description: "",
    topics: [],
    tags: input.tag ? [input.tag] : [],
    source: "discovered",
    discoveredAt: new Date().toISOString(),
  }));
}
return { status: "ok", imported: imported.length, notebooks: imported };
```

Add a workflow test with a fake discoverer returning two cards and assert library count becomes two.

- [ ] **Step 5: Run discovery and workflow tests**

Run:

```bash
npx tsx src/notebooklm-discovery.test.ts
npx tsx src/notebooklm-workflows.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/notebooklm-discovery.ts src/notebooklm-discovery.test.ts src/notebooklm-workflows.ts src/notebooklm-workflows.test.ts package.json
git commit -m "feat: discover NotebookLM notebooks"
```

## Task 8: Documentation And Gotchas

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/security.md`
- Modify: `docs/gotchas.md`
- Modify: `.env.example`

- [ ] **Step 1: Update docs**

Document:

- `notebooklm_status`, `notebooklm_discover`, `notebooklm_library`, `notebooklm_research`.
- `DEVSPACE_NOTEBOOKLM_RAW_TOOLS`.
- `DEVSPACE_NOTEBOOKLM_DATA_DIR`.
- `DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS`.
- Auth profile stability and repair path.
- Session auto-refresh behavior.
- Discovery is best-effort because NotebookLM has no stable public notebook-list API.

Add `.env.example` entries:

```text
# DEVSPACE_NOTEBOOKLM_RAW_TOOLS=0
# DEVSPACE_NOTEBOOKLM_DATA_DIR=/home/waishnav/.local/share/devspace/notebooklm
# DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS=900
```

- [ ] **Step 2: Run docs grep sanity checks**

Run:

```bash
rg -n "notebooklm_status|notebooklm_discover|notebooklm_research|DEVSPACE_NOTEBOOKLM_RAW_TOOLS|DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS" README.md docs .env.example
```

Expected: all new names appear in docs.

- [ ] **Step 3: Commit**

Run:

```bash
git add README.md docs/configuration.md docs/security.md docs/gotchas.md .env.example
git commit -m "docs: document NotebookLM UX tools"
```

## Task 9: Full Verification And Push

**Files:**
- No planned file edits.

- [ ] **Step 1: Run full typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 2: Run full tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run production build**

Run:

```bash
npm run build
```

Expected: PASS. Existing Vite chunk-size warnings are acceptable.

- [ ] **Step 4: Check git state**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: clean worktree and recent task commits visible.

- [ ] **Step 5: Push branch**

Run:

```bash
git push qscuio codex/private-hardening
```

Expected: push succeeds to `github.com:qscuio/devspace.git`.

## Self-Review Notes

- Spec coverage: discovery, local library, exact notebook selection, session auto-refresh, auth profile stability, error mapping, raw-tool hiding, and docs are covered by Tasks 1-8.
- Scope: this plan keeps real browser discovery behind a narrow adapter and tests HTML extraction/fake discovery. It does not require a real Google account in CI.
- Type consistency: the plan uses `NotebookLmConfig`, `NotebookLmClient`, `NotebookLmLibraryStore`, `NotebookLmSessionStore`, `NotebookLmWorkflows`, and `registerNotebookLmTools` consistently across tasks.
