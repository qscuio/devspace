import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createWorkspaceStore } from "./workspace-store.js";
import type { NotebookLmClient } from "./notebooklm.js";

const testRoot = mkdtempSync(join(tmpdir(), "devspace-metadata-budget-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(testRoot, "config"),
  DEVSPACE_STATE_DIR: join(testRoot, "state"),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
});
const fakeNotebooklm: NotebookLmClient = {
  async callTool() {
    return { content: [{ type: "text", text: "ok" }] };
  },
  async close() {},
};
const workspaces = new WorkspaceRegistry(config, createWorkspaceStore(config.stateDir));
const server = createMcpServer(
  config,
  workspaces,
  createReviewCheckpointManager(),
  new ProcessSessionManager(),
  [],
  [],
  () => fakeNotebooklm,
);
const client = new Client({ name: "devspace-test-client", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

try {
  const tools = await client.listTools();
  const metadataBytes = Buffer.byteLength(JSON.stringify(tools.tools), "utf8");
  assert.ok(
    metadataBytes <= 12_000,
    `tool metadata is too large: ${metadataBytes} bytes`,
  );
  const names = tools.tools.map((tool) => tool.name);
  assert.ok(names.includes("qnote"));
  assert.ok(names.includes("notebooklm"));
  assert.ok(!names.includes("qnote_search"));
  assert.ok(!names.includes("notebooklm_research"));

  const openWorkspace = tools.tools.find((tool) => tool.name === "open_workspace");
  assert.equal(openWorkspace?._meta?.["openai/toolInvocation/invoking"], "Opening workspace");
  assert.equal(openWorkspace?._meta?.["openai/toolInvocation/invoked"], "Opened workspace");

  const shell = tools.tools.find((tool) => tool.name === "bash");
  assert.equal(shell?._meta?.["openai/toolInvocation/invoking"], "Running shell");
  assert.equal(shell?._meta?.["openai/toolInvocation/invoked"], "Ran shell");
} finally {
  await client.close();
  await server.close();
}
