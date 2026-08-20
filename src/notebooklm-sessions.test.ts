import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookLmSessionStore } from "./notebooklm-sessions.js";

async function readSessionRecords(dataDir: string): Promise<Array<{
  conversation: string;
  notebookId: string;
  notebookUrl: string;
  upstreamSessionId: string;
  createdAt: string;
  lastUsedAt: string;
  messageCount: number;
}>> {
  return JSON.parse(await readFile(join(dataDir, "sessions.json"), "utf8")) as Array<{
    conversation: string;
    notebookId: string;
    notebookUrl: string;
    upstreamSessionId: string;
    createdAt: string;
    lastUsedAt: string;
    messageCount: number;
  }>;
}

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

const concurrentDataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-session-concurrent-test-"));
const concurrentStore = new NotebookLmSessionStore(concurrentDataDir, 900);
await Promise.all([
  concurrentStore.saveSession({
    notebookId: "abc",
    notebookUrl: "https://notebooklm.google.com/notebook/abc",
    conversation: "default",
    upstreamSessionId: "up-1",
    now,
  }),
  concurrentStore.saveSession({
    notebookId: "def",
    notebookUrl: "https://notebooklm.google.com/notebook/def",
    conversation: "debug",
    upstreamSessionId: "up-2",
    now,
  }),
]);
assert.equal((await concurrentStore.stats()).activeSessions, 2);

const repeatedDataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-session-repeated-test-"));
const repeatedStore = new NotebookLmSessionStore(repeatedDataDir, 900);
await repeatedStore.saveSession({
  notebookId: "abc",
  notebookUrl: "https://notebooklm.google.com/notebook/abc",
  upstreamSessionId: "up-1",
  now,
});
await repeatedStore.saveSession({
  notebookId: "abc",
  notebookUrl: "https://notebooklm.google.com/notebook/abc",
  upstreamSessionId: "up-2",
  now: new Date("2026-06-19T10:03:00.000Z"),
});
const [repeatedRecord] = await readSessionRecords(repeatedDataDir);
assert.equal(repeatedRecord?.createdAt, "2026-06-19T10:00:00.000Z");
assert.equal(repeatedRecord?.lastUsedAt, "2026-06-19T10:03:00.000Z");
assert.equal(repeatedRecord?.messageCount, 2);
assert.equal(repeatedRecord?.upstreamSessionId, "up-2");

const touchDataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-session-touch-test-"));
const touchStore = new NotebookLmSessionStore(touchDataDir, 900);
await touchStore.saveSession({
  notebookId: "abc",
  notebookUrl: "https://notebooklm.google.com/notebook/abc",
  upstreamSessionId: "up-1",
  now,
});
assert.equal((await touchStore.getReusableSession({
  notebookId: "abc",
  notebookUrl: "https://notebooklm.google.com/notebook/abc",
  now: new Date("2026-06-19T10:05:00.000Z"),
}))?.lastUsedAt, "2026-06-19T10:05:00.000Z");
assert.equal((await touchStore.getReusableSession({
  notebookId: "abc",
  notebookUrl: "https://notebooklm.google.com/notebook/abc",
  now: new Date("2026-06-19T10:19:00.000Z"),
}))?.upstreamSessionId, "up-1");
const [touchedRecord] = await readSessionRecords(touchDataDir);
assert.equal(touchedRecord?.lastUsedAt, "2026-06-19T10:19:00.000Z");
assert.equal(touchedRecord?.messageCount, 3);
