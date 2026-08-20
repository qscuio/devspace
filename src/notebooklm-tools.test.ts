import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { ProcessSessionManager } from "./process-sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { createWorkspaceStore } from "./workspace-store.js";
import type { NotebookLmClient } from "./notebooklm.js";

const testRoot = mkdtempSync(join(tmpdir(), "devspace-notebooklm-tools-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: join(testRoot, "config"),
  DEVSPACE_NOTEBOOKLM_DATA_DIR: join(testRoot, "notebooklm"),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

function createTestClient(
  fakeNotebooklm: NotebookLmClient,
  env: Record<string, string> = {},
) {
  const config = loadConfig({ ...baseEnv, ...env });
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

  return { client, server, clientTransport, serverTransport };
}

const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
let closeCalls = 0;
const fakeNotebooklm: NotebookLmClient = {
  async callTool(name, args) {
    calls.push({ name, arguments: args });
    if (name === "get_health") {
      return {
        content: [{ type: "text", text: "healthy" }],
        structuredContent: { status: "ok", authenticated: true },
      };
    }
    if (name === "ask_question") {
      return {
        content: [{ type: "text", text: "This notebook contains example content." }],
        structuredContent: {
          session_id: "session-1",
          answer: "This notebook contains example content.",
        },
      };
    }
    return {
      content: [{ type: "text", text: `called ${name}` }],
      structuredContent: { ok: true, name },
    };
  },
  async close() {
    closeCalls += 1;
  },
};

{
  const { client, server, clientTransport, serverTransport } = createTestClient(fakeNotebooklm);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("notebooklm"));
    assert.ok(!toolNames.includes("notebooklm_status"));
    assert.ok(!toolNames.includes("notebooklm_discover"));
    assert.ok(!toolNames.includes("notebooklm_library"));
    assert.ok(!toolNames.includes("notebooklm_research"));
    assert.ok(!toolNames.includes("notebooklm_get_health"));
    assert.ok(!toolNames.includes("notebooklm_ask_question"));
    const researchTool = tools.tools.find((tool) => tool.name === "notebooklm");
    assert.equal(researchTool?.annotations?.readOnlyHint, false);
    assert.equal(researchTool?.annotations?.destructiveHint, false);
    assert.equal(researchTool?.annotations?.openWorldHint, true);

    const result = await client.callTool({
      name: "notebooklm",
      arguments: {
        action: "research",
        input: {
          question: "What is in this notebook?",
          notebook_url: "https://notebooklm.google.com/notebook/example",
        },
      },
    }) as CallToolResult;
    assert.equal(result.content[0]?.type, "text");
    assert.deepEqual(calls.at(-1), {
      name: "ask_question",
      arguments: {
        question: "What is in this notebook?",
        notebook_url: "https://notebooklm.google.com/notebook/example",
      },
    });

    const clearResult = await client.callTool({
      name: "notebooklm",
      arguments: {
        action: "library",
        input: {
          action: "clear_sessions",
          id: "example",
        },
      },
    }) as CallToolResult;
    assert.deepEqual(clearResult.structuredContent, {
      status: "ok",
      action: "clear_sessions",
      cleared: 1,
    });
  } finally {
    await client.close();
    await server.close();
  }
  assert.equal(closeCalls, 1);
}

{
  const { client, server, clientTransport, serverTransport } = createTestClient(
    fakeNotebooklm,
    { DEVSPACE_NOTEBOOKLM_RAW_TOOLS: "1", DEVSPACE_EXTRA_TOOL_MODE: "split" },
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(!toolNames.includes("notebooklm"));
    assert.ok(toolNames.includes("notebooklm_status"));
    assert.ok(toolNames.includes("notebooklm_research"));
    assert.ok(toolNames.includes("notebooklm_get_health"));
    assert.ok(toolNames.includes("notebooklm_ask_question"));
    assert.ok(toolNames.includes("notebooklm_list_notebooks"));
  } finally {
    await client.close();
    await server.close();
  }
}

{
  const { client, server, clientTransport, serverTransport } = createTestClient(
    fakeNotebooklm,
    { DEVSPACE_EXTRA_TOOL_MODE: "split" },
  );
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(!toolNames.includes("notebooklm"));
    assert.ok(toolNames.includes("notebooklm_status"));
    assert.ok(toolNames.includes("notebooklm_discover"));
    assert.ok(toolNames.includes("notebooklm_library"));
    assert.ok(toolNames.includes("notebooklm_research"));
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
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.ok(!toolNames.includes("notebooklm_status"));
    assert.ok(!toolNames.includes("notebooklm_research"));
    assert.ok(!toolNames.includes("notebooklm_get_health"));
    assert.ok(!toolNames.includes("notebooklm_ask_question"));
  } finally {
    await client.close();
    await server.close();
  }
}
