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
