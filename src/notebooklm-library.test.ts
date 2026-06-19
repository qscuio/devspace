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
assert.equal(
  normalizeNotebookUrl("https://notebooklm.google.com/notebook/abc/"),
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
assert.equal(second.description, "Updated");
assert.equal(second.source, "discovered");
assert.deepEqual(second.tags.sort(), ["broadcom", "dnx", "sdk"]);
assert.deepEqual(second.topics.sort(), ["Broadcom DNX", "OAM", "Traffic Management"]);

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

const concurrentDataDir = mkdtempSync(
  join(tmpdir(), "devspace-notebooklm-library-concurrent-test-"),
);
const concurrentStore = new NotebookLmLibraryStore(concurrentDataDir);
await Promise.all([
  concurrentStore.upsert({
    url: "https://notebooklm.google.com/notebook/concurrent-a",
    name: "Concurrent A",
    source: "manual",
  }),
  concurrentStore.upsert({
    url: "https://notebooklm.google.com/notebook/concurrent-b",
    name: "Concurrent B",
    source: "manual",
  }),
]);
const concurrentRecords = await concurrentStore.list();
assert.equal(concurrentRecords.length, 2);
assert.deepEqual(
  concurrentRecords.map((record) => record.id).sort(),
  ["concurrent-a", "concurrent-b"],
);
