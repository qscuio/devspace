import assert from "node:assert/strict";
import { createNotebookLmEnvironment, mapNotebookLmError, NotebookLmClientError } from "./notebooklm.js";

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
assert.equal(mapNotebookLmError(new Error("NotebookLM session expired")).code, "auth_state_stale");
assert.equal(mapNotebookLmError(new Error("Target page, context or browser has been closed")).code, "browser_failed");
assert.equal(mapNotebookLmError(new Error("profile is already in use")).code, "browser_profile_locked");
assert.equal(mapNotebookLmError(new Error("Login required")).code, "not_authenticated");

const cause = new Error("NotebookLM session expired");
const mapped = mapNotebookLmError(cause);
const structuredError = new NotebookLmClientError(mapped, cause);
assert.ok(structuredError instanceof Error);
assert.equal(structuredError.code, "auth_state_stale");
assert.equal(structuredError.repairHint, mapped.repairHint);
assert.equal(structuredError.cause, cause);
assert.match(structuredError.message, /^auth_state_stale:/);
