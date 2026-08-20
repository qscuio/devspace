import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { createMcpServer } from "./server.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);
const testRoot = mkdtempSync(join(tmpdir(), "devspace-show-changes-text-test-"));
const workspaceRoot = join(testRoot, "repo");
mkdirSync(workspaceRoot, { recursive: true });

await git(workspaceRoot, ["init"]);
await git(workspaceRoot, ["config", "user.email", "devspace@example.com"]);
await git(workspaceRoot, ["config", "user.name", "DevSpace Test"]);
writeFileSync(join(workspaceRoot, "README.md"), "hello\n");
await git(workspaceRoot, ["add", "README.md"]);
await git(workspaceRoot, ["commit", "-m", "initial"]);

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(testRoot, "config"),
  DEVSPACE_STATE_DIR: join(testRoot, "state"),
  DEVSPACE_ALLOWED_ROOTS: testRoot,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
});
assert.equal(config.widgets, "off");

const workspaces = new WorkspaceRegistry(config, createWorkspaceStore(config.stateDir));
const reviewCheckpoints = createReviewCheckpointManager();
const server = createMcpServer(
  config,
  workspaces,
  reviewCheckpoints,
);
const client = new Client({ name: "devspace-show-changes-test", version: "0.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

try {
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "show_changes"));

  const opened = await client.callTool({
    name: "open_workspace",
    arguments: { path: workspaceRoot },
  }) as CallToolResult;
  const workspaceId = opened.structuredContent?.workspaceId;
  if (typeof workspaceId !== "string") throw new Error("open_workspace did not return a workspaceId.");
  const checkedWorkspaceId: string = workspaceId;

  await reviewCheckpoints.initializeWorkspace({ workspaceId: checkedWorkspaceId, root: workspaceRoot });
  await writeFile(join(workspaceRoot, "README.md"), "hello\nworld\n");

  const changes = await client.callTool({
    name: "show_changes",
    arguments: { workspaceId: checkedWorkspaceId, markReviewed: false },
  }) as CallToolResult;
  const text = changes.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.match(text, /Changed 1 file/);
  assert.match(text, /```diff/);
  assert.match(text, /world/);
  assert.equal((changes._meta as { card?: unknown } | undefined)?.card, undefined);
} finally {
  await client.close();
  await server.close();
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
