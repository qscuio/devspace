import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { readHistorySource, scanHistorySources } from "./qnote-history.js";

const root = mkdtempSync(join(tmpdir(), "devspace-qnote-history-test-"));

const codexDir = join(root, ".codex", "memories", "rollout_summaries");
mkdirSync(codexDir, { recursive: true });
writeFileSync(join(codexDir, "session.jsonl"), "{\"event\":\"response\",\"text\":\"Codex lesson\"}\n");

const chatgptDir = join(root, "chatgpt-export");
mkdirSync(chatgptDir, { recursive: true });
writeFileSync(
  join(chatgptDir, "conversations.json"),
  JSON.stringify([{ title: "Exported ChatGPT Conversation", mapping: {} }]),
);

const browserDir = join(root, "browser");
mkdirSync(browserDir, { recursive: true });
const historyPath = join(browserDir, "History");
const db = new Database(historyPath);
db.exec(`
  create table urls(id integer primary key, url text, title text, last_visit_time integer);
  insert into urls(url, title, last_visit_time)
  values('https://chatgpt.com/c/abc123', 'ChatGPT - VLAN debug', 13300000000000000);
`);
db.close();

const scan = await scanHistorySources({
  root,
  sources: ["codex", "chatgpt", "browser"],
  limit: 20,
});

assert.equal(scan.root, root);
assert.ok(scan.candidates.some((candidate) => candidate.source === "codex"));
assert.ok(scan.candidates.some((candidate) => candidate.source === "chatgpt"));
assert.ok(scan.candidates.some((candidate) => candidate.source === "browser"));

const chatgpt = scan.candidates.find((candidate) => candidate.source === "chatgpt");
assert.equal(chatgpt?.title, "Exported ChatGPT Conversation");
const chatgptRead = await readHistorySource({ id: chatgpt!.id, root, maxBytes: 4096 });
assert.match(chatgptRead.content, /Exported ChatGPT Conversation/);

const browser = scan.candidates.find((candidate) => candidate.source === "browser");
assert.equal(browser?.kind, "browser_history");
assert.match(browser?.notes ?? "", /metadata-only/);
const browserRead = await readHistorySource({ id: browser!.id, root, maxBytes: 4096 });
assert.match(browserRead.content, /https:\/\/chatgpt.com\/c\/abc123/);
assert.match(browserRead.content, /VLAN debug/);
