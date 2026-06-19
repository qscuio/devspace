import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NotebookLmConfig } from "./config.js";

export interface NotebookLmClient {
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type NotebookLmClientFactory = () => NotebookLmClient;

export interface NotebookLmMappedError {
  code:
    | "not_authenticated"
    | "auth_state_stale"
    | "browser_profile_locked"
    | "browser_failed"
    | "upstream_unavailable";
  message: string;
  repairHint: string;
}

export function createNotebookLmEnvironment(config: NotebookLmConfig): Record<string, string> {
  return {
    NOTEBOOKLM_MCP_DATA_DIR: config.dataDir,
    NOTEBOOK_PROFILE_STRATEGY: "single",
    NOTEBOOK_CLEANUP_ON_STARTUP: "false",
    NOTEBOOK_CLEANUP_ON_SHUTDOWN: "true",
  };
}

export function mapNotebookLmError(error: unknown): NotebookLmMappedError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("profile") && lower.includes("use")) {
    return {
      code: "browser_profile_locked",
      message,
      repairHint: "Close other Chrome/Chromium instances using the NotebookLM profile, then retry.",
    };
  }
  if (lower.includes("login") || lower.includes("auth")) {
    return {
      code: "not_authenticated",
      message,
      repairHint: "Run notebooklm_status or notebooklm_setup_auth with a visible browser.",
    };
  }
  if (lower.includes("browser") || lower.includes("page") || lower.includes("context")) {
    return {
      code: "browser_failed",
      message,
      repairHint: "Retry with visible browser or refresh the NotebookLM browser profile.",
    };
  }
  return {
    code: "upstream_unavailable",
    message,
    repairHint: "Check that notebooklm-mcp can start and that Node/npm are available.",
  };
}

class StdioNotebookLmClient implements NotebookLmClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<Client>;

  constructor(private readonly config: NotebookLmConfig) {}

  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const client = await this.ensureClient();
      return await client.callTool({ name, arguments: args }, CallToolResultSchema) as CallToolResult;
    } catch (error) {
      const mapped = mapNotebookLmError(error);
      throw new Error(`${mapped.code}: ${mapped.message}`);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    await client?.close();
    await transport?.close();
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = this.connect();
    try {
      this.client = await this.connecting;
      return this.client;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<Client> {
    const client = new Client({
      name: "devspace-notebooklm-bridge",
      version: "0.1.0",
    });
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: {
        ...process.env,
        ...createNotebookLmEnvironment(this.config),
      } as Record<string, string>,
      stderr: "pipe",
    });
    await client.connect(transport);
    this.transport = transport;
    return client;
  }
}

export function createNotebookLmClient(config: NotebookLmConfig): NotebookLmClient {
  return new StdioNotebookLmClient(config);
}
