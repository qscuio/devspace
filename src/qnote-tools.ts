import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { createQnoteStore, type QnoteCaptureInput } from "./qnote.js";
import { iterateHistorySources, readHistorySource, scanHistorySources } from "./qnote-history.js";

type QnoteHistorySources = Array<"codex" | "claude" | "cursor" | "chatgpt" | "browser">;

export function registerQnoteTools(server: McpServer, config: ServerConfig): void {
  if (!config.qnote.enabled) return;

  const store = createQnoteStore(config.qnote);
  if (config.extraToolMode === "compact") {
    server.registerTool(
      "qnote",
      {
        title: "Qnote",
        description: "Qnote action: sync, search, read, capture, or history.",
        inputSchema: {
          action: z.enum(["sync", "search", "read", "capture", "history"]),
          input: z.record(z.string(), z.unknown()).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args) => {
        const { action, input = {} } = args as {
          action: "sync" | "search" | "read" | "capture" | "history";
          input?: Record<string, unknown>;
        };

        switch (action) {
          case "sync":
            return formatToolResult(await store.sync());
          case "search":
            return formatToolResult(await store.search(input as { query: string; limit?: number }));
          case "read":
            return formatToolResult(await store.read(input as { path: string; maxBytes?: number }));
          case "capture":
            return formatToolResult(await store.capture(input as unknown as QnoteCaptureInput));
          case "history":
            return formatToolResult(await runHistory(input as QnoteHistoryInput));
        }
      },
    );
    return;
  }

  server.registerTool(
    "qnote_sync",
    {
      title: "Sync qnote",
      description:
        "Clone or fast-forward qnote.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => formatToolResult(await store.sync()),
  );

  server.registerTool(
    "qnote_search",
    {
      title: "Search qnote",
      description: "Search qnote Markdown.",
      inputSchema: {
        query: z.string(),
        limit: z.number().int().positive().max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => formatToolResult(await store.search(args as { query: string; limit?: number })),
  );

  server.registerTool(
    "qnote_read",
    {
      title: "Read qnote",
      description: "Read a qnote file.",
      inputSchema: {
        path: z.string(),
        maxBytes: z.number().int().positive().max(512 * 1024).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => formatToolResult(await store.read(args as { path: string; maxBytes?: number })),
  );

  server.registerTool(
    "qnote_capture",
    {
      title: "Capture qnote",
      description:
        "Store summarized knowledge, lessons, or skills in qnote.",
      inputSchema: {
        destination: z.string().describe("Repo-relative Markdown path."),
        title: z.string(),
        body: z.string().describe("Summarized Markdown."),
        tags: z.array(z.string()).optional(),
        sourceId: z.string().optional(),
        sync: z.boolean().optional(),
        push: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) => formatToolResult(await store.capture(args as QnoteCaptureInput)),
  );

  server.registerTool(
    "qnote_history",
    {
      title: "Inspect AI history",
      description:
        "Scan/read/iterate local AI history. Continue nextOffset/nextCursor until complete.",
      inputSchema: {
        action: z.enum(["scan", "read", "iterate"]).optional(),
        id: z.string().optional(),
        root: z.string().optional(),
        sources: z.array(z.enum(["codex", "claude", "cursor", "chatgpt", "browser"])).optional(),
        limit: z.number().int().positive().max(10000).optional(),
        offset: z.number().int().nonnegative().optional(),
        maxBytes: z.number().int().positive().max(512 * 1024).optional(),
        cursor: z.union([
          z.string(),
          z.object({
            candidateIndex: z.number().int().nonnegative(),
            offset: z.number().int().nonnegative(),
          }),
        ]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      return formatToolResult(await runHistory(args as QnoteHistoryInput));
    },
  );
}

type QnoteHistoryInput = {
  action?: "scan" | "read" | "iterate";
  id?: string;
  root?: string;
  sources?: QnoteHistorySources;
  limit?: number;
  offset?: number;
  maxBytes?: number;
  cursor?: unknown;
};

async function runHistory(input: QnoteHistoryInput): Promise<unknown> {
  if ((input.action ?? "scan") === "read") {
    if (!input.id) throw new Error("qnote_history read requires id.");
    return readHistorySource(input as {
      id: string;
      root?: string;
      sources?: QnoteHistorySources;
      offset?: number;
      maxBytes?: number;
    });
  }
  if (input.action === "iterate") {
    return iterateHistorySources(input);
  }
  return scanHistorySources(input);
}

function formatToolResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: value as Record<string, unknown>,
  };
}
