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
