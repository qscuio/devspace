import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const testRoot = mkdtempSync(join(tmpdir(), "devspace-server-progress-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(testRoot, "config"),
  DEVSPACE_ALLOWED_ROOTS: testRoot,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
});
const workspaces = new WorkspaceRegistry(config, createWorkspaceStore(config.stateDir));
const server = createMcpServer(
  config,
  workspaces,
  createReviewCheckpointManager(),
);
const client = new Client({ name: "devspace-progress-test-client", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const progressEvents: Progress[] = [];

await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

try {
  await client.callTool(
    {
      name: "open_workspace",
      arguments: {
        path: testRoot,
      },
    },
    undefined,
    {
      onprogress(progress) {
        progressEvents.push(progress);
      },
    },
  );

  assert.ok(progressEvents.length >= 2);
  assert.equal(progressEvents[0]?.message, "Opening workspace");
  assert.equal(progressEvents.at(-1)?.message, "Workspace opened");
} finally {
  await client.close();
  await server.close();
}
