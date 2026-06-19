import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { createQnoteStore, type QnoteCaptureInput } from "./qnote.js";
import { readHistorySource, scanHistorySources } from "./qnote-history.js";

export function registerQnoteTools(server: McpServer, config: ServerConfig): void {
  if (!config.qnote.enabled) return;

  const store = createQnoteStore(config.qnote);

  server.registerTool(
    "qnote_sync",
    {
      title: "Sync qnote",
      description:
        "Clone or fast-forward the private qnote storage repository. Refuses dirty checkouts and non-fast-forward updates.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => formatToolResult(await store.sync()),
  );

  server.registerTool(
    "qnote_search",
    {
      title: "Search qnote",
      description: "Search Markdown notes stored in the private qnote repository.",
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
      description: "Read one Markdown note from qnote by repository-relative path.",
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
        "Store a summarized knowledge note, lesson, or skill in qnote. Summarize and deduplicate with qnote_search before using this; do not upload raw chat transcripts unless the user explicitly asks.",
      inputSchema: {
        destination: z.string().describe("Repository-relative Markdown path under an allowed qnote directory."),
        title: z.string(),
        body: z.string().describe("Already summarized Markdown content to store."),
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
        "Scan or read host-local Claude, Codex, Cursor, ChatGPT export, and browser history sources before summarizing useful knowledge into qnote_capture. Browser history is metadata-only; use ChatGPT official export for full ChatGPT conversation content.",
      inputSchema: {
        action: z.enum(["scan", "read"]).optional(),
        id: z.string().optional(),
        root: z.string().optional(),
        sources: z.array(z.enum(["codex", "claude", "cursor", "chatgpt", "browser"])).optional(),
        limit: z.number().int().positive().max(200).optional(),
        maxBytes: z.number().int().positive().max(512 * 1024).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const input = args as {
        action?: "scan" | "read";
        id?: string;
        root?: string;
        sources?: Array<"codex" | "claude" | "cursor" | "chatgpt" | "browser">;
        limit?: number;
        maxBytes?: number;
      };
      if ((input.action ?? "scan") === "read") {
        if (!input.id) throw new Error("qnote_history read requires id.");
        return formatToolResult(await readHistorySource(input as { id: string; root?: string; sources?: typeof input.sources; maxBytes?: number }));
      }
      return formatToolResult(await scanHistorySources(input));
    },
  );
}

function formatToolResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: value as Record<string, unknown>,
  };
}
