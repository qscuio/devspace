import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createWorkspaceStore } from "./workspace-store.js";
import type { NotebookLmClient } from "./notebooklm.js";

const baseEnv = {
  DEVSPACE_CONFIG_DIR: "C:\\tmp\\devspace-notebooklm-tools-test-config",
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

function createTestClient(fakeNotebooklm: NotebookLmClient) {
  const config = loadConfig(baseEnv);
  const workspaces = new WorkspaceRegistry(config, createWorkspaceStore(config.stateDir));
  const server = createMcpServer(
    config,
    workspaces,
    createReviewCheckpointManager(),
    () => fakeNotebooklm,
  );
  const client = new Client({ name: "devspace-test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  return { client, server, clientTransport, serverTransport };
}

const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
const fakeNotebooklm: NotebookLmClient = {
  async callTool(name, args) {
    calls.push({ name, arguments: args });
    return {
      content: [{ type: "text", text: `called ${name}` }],
      structuredContent: { ok: true, name },
    };
  },
  async close() {},
};

{
  const { client, server, clientTransport, serverTransport } = createTestClient(fakeNotebooklm);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("notebooklm_get_health"));
    assert.ok(toolNames.includes("notebooklm_ask_question"));
    assert.ok(toolNames.includes("notebooklm_list_notebooks"));

    const result = await client.callTool({
      name: "notebooklm_ask_question",
      arguments: {
        question: "What is in this notebook?",
        notebook_url: "https://notebooklm.google.com/notebook/example",
      },
    }) as CallToolResult;
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text, "called ask_question");
    assert.deepEqual(calls.at(-1), {
      name: "ask_question",
      arguments: {
        question: "What is in this notebook?",
        notebook_url: "https://notebooklm.google.com/notebook/example",
      },
    });
  } finally {
    await client.close();
    await server.close();
  }
}

{
  const config = loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM: "0" });
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
    assert.ok(!toolNames.includes("notebooklm_get_health"));
    assert.ok(!toolNames.includes("notebooklm_ask_question"));
  } finally {
    await client.close();
    await server.close();
  }
}
