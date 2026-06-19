import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotebookLmLibraryStore } from "./notebooklm-library.js";
import { NotebookLmSessionStore } from "./notebooklm-sessions.js";
import { NotebookLmWorkflows } from "./notebooklm-workflows.js";
import { NotebookLmClientError, type NotebookLmClient } from "./notebooklm.js";

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

const discoveryDataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-workflows-discovery-test-"));
const discoveryLibrary = new NotebookLmLibraryStore(discoveryDataDir);
const discoverySessions = new NotebookLmSessionStore(discoveryDataDir, 900);
const discoveryWorkflows = new NotebookLmWorkflows({
  library: discoveryLibrary,
  sessions: discoverySessions,
  client,
  dataDir: discoveryDataDir,
  discoverer: {
    async discover(input) {
      assert.equal(input.limit, 20);
      return [
        { name: "Broadcom DNX SDK", url: "https://notebooklm.google.com/notebook/abc" },
        { name: "StrataXGS", url: "https://notebooklm.google.com/notebook/def" },
      ];
    },
  },
});
const discoveryResult = await discoveryWorkflows.discover({ tag: "broadcom" });
assert.equal(discoveryResult.status, "ok");
assert.equal(discoveryResult.imported, 2);
assert.equal((await discoveryLibrary.list()).length, 2);
assert.deepEqual((await discoveryLibrary.list()).map((record) => record.tags), [["broadcom"], ["broadcom"]]);

const missingDiscovery = await workflows.discover({});
assert.equal(missingDiscovery.status, "browser_failed");
assert.equal(missingDiscovery.message, "NotebookLM account discovery is not configured.");

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
assert.equal(followup.sessionRefreshed, false);
assert.equal(JSON.parse(readFileSync(join(dataDir, "sessions.json"), "utf8"))[0]?.messageCount, 2);

const directUrlDataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-workflows-direct-url-test-"));
const directUrlLibrary = new NotebookLmLibraryStore(directUrlDataDir);
const directUrlSessions = new NotebookLmSessionStore(directUrlDataDir, 900);
const directUrlCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
const directUrlClient: NotebookLmClient = {
  async callTool(name, args) {
    directUrlCalls.push({ name, args });
    if (name === "get_health") {
      return { content: [{ type: "text", text: "ok" }], structuredContent: { authenticated: true, status: "ok" } };
    }
    if (name === "ask_question") {
      return {
        content: [{ type: "text", text: "answer" }],
        structuredContent: { session_id: "url-session", answer: "answer" },
      };
    }
    return { content: [{ type: "text", text: "ok" }] };
  },
  async close() {},
};
const directUrlWorkflows = new NotebookLmWorkflows({
  library: directUrlLibrary,
  sessions: directUrlSessions,
  client: directUrlClient,
  dataDir: directUrlDataDir,
});
const directUrlAnswer = await directUrlWorkflows.research({
  question: "How?",
  notebook_url: "https://notebooklm.google.com/notebook/xyz",
});
assert.equal(directUrlAnswer.status, "ok");
assert.equal(directUrlAnswer.notebook?.id, "xyz");
assert.equal(directUrlCalls.at(-1)?.args?.notebook_url, "https://notebooklm.google.com/notebook/xyz");

const failureDataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-workflows-failure-test-"));
const failureLibrary = new NotebookLmLibraryStore(failureDataDir);
const failureSessions = new NotebookLmSessionStore(failureDataDir, 900);
const failureClient: NotebookLmClient = {
  async callTool(name) {
    if (name === "get_health") {
      return { content: [{ type: "text", text: "ok" }], structuredContent: { authenticated: true, status: "ok" } };
    }
    if (name === "ask_question") {
      throw new NotebookLmClientError({
        code: "browser_failed",
        message: "browser closed",
        repairHint: "Retry with visible browser.",
      }, new Error("browser closed"));
    }
    return { content: [{ type: "text", text: "ok" }] };
  },
  async close() {},
};
const failureWorkflows = new NotebookLmWorkflows({
  library: failureLibrary,
  sessions: failureSessions,
  client: failureClient,
  dataDir: failureDataDir,
});
const failureNotebook = await failureLibrary.upsert({
  url: "https://notebooklm.google.com/notebook/abc",
  name: "Broadcom DNX SDK",
  aliases: ["dnx"],
  description: "DNX docs",
  topics: ["DNX"],
  tags: ["broadcom"],
  source: "manual",
});
await failureSessions.saveSession({
  notebookId: failureNotebook.id,
  notebookUrl: failureNotebook.url,
  upstreamSessionId: "existing-session",
});

const failure = await failureWorkflows.research({ question: "How?", notebook: "dnx" });
assert.equal(failure.status, "browser_failed");
assert.equal(failure.notebook?.id, "abc");
assert.equal(failure.repairPlan?.code, "browser_failed");
assert.match(failure.repairPlan?.message ?? "", /browser closed/);
assert.equal(JSON.parse(readFileSync(join(failureDataDir, "sessions.json"), "utf8"))[0]?.messageCount, 1);

const retryDataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-workflows-retry-test-"));
const retryLibrary = new NotebookLmLibraryStore(retryDataDir);
const retrySessions = new NotebookLmSessionStore(retryDataDir, 900);
const retryCalls: Array<{ name: string; args?: Record<string, unknown> }> = [];
const retryClient: NotebookLmClient = {
  async callTool(name, args) {
    retryCalls.push({ name, args });
    if (name === "get_health") {
      return { content: [{ type: "text", text: "ok" }], structuredContent: { authenticated: true, status: "ok" } };
    }
    if (name === "ask_question" && args?.session_id) {
      throw new Error("expired session");
    }
    if (name === "ask_question") {
      return {
        content: [{ type: "text", text: "answer" }],
        structuredContent: { session_id: "retry-session", answer: "answer" },
      };
    }
    return { content: [{ type: "text", text: "ok" }] };
  },
  async close() {},
};
const retryWorkflows = new NotebookLmWorkflows({
  library: retryLibrary,
  sessions: retrySessions,
  client: retryClient,
  dataDir: retryDataDir,
});
const retryNotebook = await retryLibrary.upsert({
  url: "https://notebooklm.google.com/notebook/abc",
  name: "Broadcom DNX SDK",
  aliases: ["dnx"],
  description: "DNX docs",
  topics: ["DNX"],
  tags: ["broadcom"],
  source: "manual",
});
await retrySessions.saveSession({
  notebookId: retryNotebook.id,
  notebookUrl: retryNotebook.url,
  upstreamSessionId: "stale-session",
});

const retried = await retryWorkflows.research({ question: "Retry?", notebook: "dnx" });
const retryAskCalls = retryCalls.filter((call) => call.name === "ask_question");
assert.equal(retried.status, "ok");
assert.equal(retryAskCalls.length, 2);
assert.equal(retryAskCalls[0]?.args?.session_id, "stale-session");
assert.equal(retryAskCalls[1]?.args?.session_id, undefined);

const healthyDataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-workflows-healthy-test-"));
const healthyLibrary = new NotebookLmLibraryStore(healthyDataDir);
const healthySessions = new NotebookLmSessionStore(healthyDataDir, 900);
const healthyClient: NotebookLmClient = {
  async callTool(name, args) {
    if (name === "get_health") {
      return { content: [{ type: "text", text: "ok" }], structuredContent: { authenticated: true, status: "healthy" } };
    }
    if (name === "ask_question") {
      return {
        content: [{ type: "text", text: "answer" }],
        structuredContent: { session_id: args?.session_id ?? "healthy-session", answer: "answer" },
      };
    }
    return { content: [{ type: "text", text: "ok" }] };
  },
  async close() {},
};
const healthyWorkflows = new NotebookLmWorkflows({
  library: healthyLibrary,
  sessions: healthySessions,
  client: healthyClient,
  dataDir: healthyDataDir,
});
await healthyLibrary.upsert({
  url: "https://notebooklm.google.com/notebook/abc",
  name: "Broadcom DNX SDK",
  aliases: ["dnx"],
  description: "DNX docs",
  topics: ["DNX"],
  tags: ["broadcom"],
  source: "manual",
});
assert.equal((await healthyWorkflows.status({})).status, "ok");
assert.equal((await healthyWorkflows.research({ question: "Healthy?", notebook: "dnx" })).status, "ok");

const nonErrorDataDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-workflows-non-error-test-"));
const nonErrorLibrary = new NotebookLmLibraryStore(nonErrorDataDir);
const nonErrorSessions = new NotebookLmSessionStore(nonErrorDataDir, 900);
const nonErrorClient: NotebookLmClient = {
  async callTool(name) {
    if (name === "get_health") {
      return { content: [{ type: "text", text: "ok" }], structuredContent: { authenticated: true, status: "ok" } };
    }
    if (name === "ask_question") throw "upstream string failure";
    return { content: [{ type: "text", text: "ok" }] };
  },
  async close() {},
};
const nonErrorWorkflows = new NotebookLmWorkflows({
  library: nonErrorLibrary,
  sessions: nonErrorSessions,
  client: nonErrorClient,
  dataDir: nonErrorDataDir,
});
await nonErrorLibrary.upsert({
  url: "https://notebooklm.google.com/notebook/abc",
  name: "Broadcom DNX SDK",
  aliases: ["dnx"],
  description: "DNX docs",
  topics: ["DNX"],
  tags: ["broadcom"],
  source: "manual",
});
const nonErrorFailure = await nonErrorWorkflows.research({ question: "How?", notebook: "dnx" });
assert.equal(nonErrorFailure.status, "upstream_unavailable");
assert.equal(nonErrorFailure.repairPlan?.code, "upstream_unavailable");
assert.match(nonErrorFailure.repairPlan?.message ?? "", /upstream string failure/);
