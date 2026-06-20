import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createWorkspaceStore } from "./workspace-store.js";
import type { NotebookLmClient } from "./notebooklm.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const testRoot = mkdtempSync(join(tmpdir(), "devspace-qnote-tools-test-"));
const qnoteDir = join(testRoot, "qnote");
mkdirSync(qnoteDir, { recursive: true });
git(qnoteDir, ["init", "-b", "main"]);
git(qnoteDir, ["config", "user.email", "devspace@example.com"]);
git(qnoteDir, ["config", "user.name", "DevSpace Test"]);
await mkdir(join(qnoteDir, "knowledge"), { recursive: true });
writeFileSync(join(qnoteDir, "knowledge", "seed.md"), "# Seed\n\nFind me\n");
git(qnoteDir, ["add", "."]);
git(qnoteDir, ["commit", "-m", "initial"]);

const fakeNotebooklm: NotebookLmClient = {
  async callTool() {
    return { content: [{ type: "text", text: "ok" }] };
  },
  async close() {},
};

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(testRoot, "config"),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_NOTEBOOKLM: "0",
  DEVSPACE_QNOTE_DIR: qnoteDir,
  DEVSPACE_QNOTE_AUTO_PUSH: "0",
});
const workspaces = new WorkspaceRegistry(config, createWorkspaceStore(config.stateDir));
const server = createMcpServer(
  config,
  workspaces,
  createReviewCheckpointManager(),
  () => fakeNotebooklm,
);
const client = new Client({ name: "devspace-test-client", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

try {
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("qnote"));
  assert.ok(!toolNames.includes("qnote_search"));
  assert.ok(!toolNames.includes("qnote_read"));
  assert.ok(!toolNames.includes("qnote_capture"));
  assert.ok(!toolNames.includes("qnote_sync"));
  assert.ok(!toolNames.includes("qnote_history"));

  const compactSearch = await client.callTool({
    name: "qnote",
    arguments: { action: "search", input: { query: "Find me" } },
  }) as CallToolResult;
  assert.equal(compactSearch.structuredContent?.status, "ok");

  const compactCapture = await client.callTool({
    name: "qnote",
    arguments: {
      action: "capture",
      input: {
        destination: "knowledge/tool-capture.md",
        title: "Tool Capture",
        body: "A summarized lesson from a real session.",
        sync: false,
        push: false,
      },
    },
  }) as CallToolResult;
  assert.equal(compactCapture.structuredContent?.status, "ok");
} finally {
  await client.close();
  await server.close();
}

const splitConfig = loadConfig({
  DEVSPACE_CONFIG_DIR: join(testRoot, "split-config"),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_NOTEBOOKLM: "0",
  DEVSPACE_QNOTE_DIR: qnoteDir,
  DEVSPACE_QNOTE_AUTO_PUSH: "0",
  DEVSPACE_EXTRA_TOOL_MODE: "split",
});
const splitWorkspaces = new WorkspaceRegistry(splitConfig, createWorkspaceStore(splitConfig.stateDir));
const splitServer = createMcpServer(
  splitConfig,
  splitWorkspaces,
  createReviewCheckpointManager(),
  () => fakeNotebooklm,
);
const splitClient = new Client({ name: "devspace-test-client", version: "0.0.0" });
const [splitClientTransport, splitServerTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([splitServer.connect(splitServerTransport), splitClient.connect(splitClientTransport)]);

try {
  const tools = await splitClient.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  assert.ok(!toolNames.includes("qnote"));
  assert.ok(toolNames.includes("qnote_search"));
  assert.ok(toolNames.includes("qnote_read"));
  assert.ok(toolNames.includes("qnote_capture"));
  assert.ok(toolNames.includes("qnote_sync"));
  assert.ok(toolNames.includes("qnote_history"));

  const search = await splitClient.callTool({
    name: "qnote_search",
    arguments: { query: "Find me" },
  }) as CallToolResult;
  assert.equal(search.structuredContent?.status, "ok");

  const capture = await splitClient.callTool({
    name: "qnote_capture",
    arguments: {
      destination: "knowledge/tool-capture-split.md",
      title: "Tool Capture",
      body: "A second summarized lesson from a split-tool session.",
      sync: false,
      push: false,
    },
  }) as CallToolResult;
  assert.equal(capture.structuredContent?.status, "ok");
} finally {
  await splitClient.close();
  await splitServer.close();
}
