import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NotebookLmConfig } from "./config.js";

export interface NotebookLmClient {
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type NotebookLmClientFactory = () => NotebookLmClient;

class StdioNotebookLmClient implements NotebookLmClient {
  private client?: Client;
  private transport?: StdioClientTransport;
  private connecting?: Promise<Client>;

  constructor(private readonly config: NotebookLmConfig) {}

  async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    const client = await this.ensureClient();
    return await client.callTool({ name, arguments: args }, CallToolResultSchema) as CallToolResult;
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
