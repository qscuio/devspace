import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import { NotebookLmLibraryStore } from "./notebooklm-library.js";
import { NotebookLmSessionStore } from "./notebooklm-sessions.js";
import {
  NotebookLmWorkflows,
  type NotebookLmDiscoverInput,
  type NotebookLmLibraryInput,
  type NotebookLmResearchInput,
  type NotebookLmStatusInput,
} from "./notebooklm-workflows.js";
import { BrowserNotebookLmDiscoverer } from "./notebooklm-discovery.js";
import type { NotebookLmClient, NotebookLmClientFactory } from "./notebooklm.js";

type NotebookLmLibraryToolInput = Omit<NotebookLmLibraryInput, "action"> & {
  action?: NotebookLmLibraryInput["action"] | "update" | "remove";
  id?: string;
  aliases?: string[];
  tags?: string[];
};

export function registerNotebookLmTools(
  server: McpServer,
  config: ServerConfig,
  factory: NotebookLmClientFactory,
): void {
  if (!config.notebooklm.enabled) return;

  const dataDir = config.notebooklm.dataDir;
  const library = new NotebookLmLibraryStore(dataDir);
  const sessions = new NotebookLmSessionStore(dataDir, config.notebooklm.sessionTtlSeconds);
  const managedClient = createManagedNotebookLmClient(factory);
  registerNotebookLmCleanup(server, managedClient.close);
  const workflows = new NotebookLmWorkflows({
    library,
    sessions,
    client: managedClient.client,
    dataDir,
    discoverer: new BrowserNotebookLmDiscoverer(),
  });

  server.registerTool(
    "notebooklm_status",
    {
      title: "NotebookLM status",
      description: "Report NotebookLM auth, profile, library, session, and repair status.",
      inputSchema: { verify_browser: z.boolean().optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => formatToolResult(await workflows.status(args as NotebookLmStatusInput)),
  );

  server.registerTool(
    "notebooklm_discover",
    {
      title: "Discover NotebookLM notebooks",
      description:
        "Scan the signed-in NotebookLM account and import visible notebooks into DevSpace metadata.",
      inputSchema: {
        mode: z.enum(["scan", "scan_and_enrich"]).optional(),
        limit: z.number().int().positive().max(200).optional(),
        include_existing: z.boolean().optional(),
        tag: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => formatToolResult(await workflows.discover(args as NotebookLmDiscoverInput)),
  );

  server.registerTool(
    "notebooklm_library",
    {
      title: "Manage NotebookLM library",
      description:
        "List, search, update, tag, alias, remove, or clear sessions for DevSpace NotebookLM metadata.",
      inputSchema: {
        action: z.enum(["list", "search", "update", "remove", "clear_sessions"]).optional(),
        query: z.string().optional(),
        id: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        tags: z.array(z.string()).optional(),
        conversation: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => formatToolResult(await runLibraryWorkflow(workflows, args as NotebookLmLibraryToolInput)),
  );

  server.registerTool(
    "notebooklm_research",
    {
      title: "Research with NotebookLM",
      description:
        "Ask a source-grounded question against a selected NotebookLM notebook or confirmed candidate.",
      inputSchema: {
        question: z.string(),
        notebook: z.string().optional(),
        notebook_id: z.string().optional(),
        notebook_url: z.string().optional(),
        strategy: z.enum(["exact", "auto", "confirm"]).optional(),
        conversation: z.string().optional(),
        fresh_session: z.boolean().optional(),
        show_browser: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => formatToolResult(await workflows.research(args as NotebookLmResearchInput)),
  );

  if (config.notebooklm.rawTools) registerRawNotebookLmTools(server, managedClient.client);
}

function createManagedNotebookLmClient(factory: NotebookLmClientFactory): {
  client: NotebookLmClient;
  close: () => Promise<void>;
} {
  let client: NotebookLmClient | undefined;
  let closePromise: Promise<void> | undefined;
  const getClient = () => {
    client ??= factory();
    return client;
  };
  const close = async () => {
    if (closePromise) {
      await closePromise;
      return;
    }
    if (!client) return;

    const closingClient = client;
    client = undefined;
    closePromise = closingClient.close().finally(() => {
      closePromise = undefined;
    });
    await closePromise;
  };

  return {
    client: {
      callTool(name, args) {
        return getClient().callTool(name, args);
      },
      close,
    },
    close,
  };
}

function registerNotebookLmCleanup(
  server: McpServer,
  cleanup: () => Promise<void>,
): void {
  const originalClose = server.close.bind(server);
  let closePromise: Promise<void> | undefined;
  server.close = async () => {
    closePromise ??= (async () => {
      try {
        await originalClose();
      } finally {
        await cleanup();
      }
    })();
    await closePromise;
  };

  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    previousOnClose?.();
    void cleanup();
  };
}

async function runLibraryWorkflow(
  workflows: NotebookLmWorkflows,
  input: NotebookLmLibraryToolInput,
): Promise<unknown> {
  if (input.action === "update" || input.action === "remove") {
    return {
      status: "unsupported_action",
      action: input.action,
      message: `NotebookLM library action '${input.action}' is not implemented yet.`,
    };
  }

  const { id, ...workflowInput } = input;
  return workflows.library({
    ...workflowInput,
    notebookId: workflowInput.notebookId ?? workflowInput.notebook_id ?? id,
  } as NotebookLmLibraryInput);
}

function formatToolResult(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: value as Record<string, unknown>,
  };
}

function registerRawNotebookLmTools(server: McpServer, client: NotebookLmClient): void {
  const callNotebookLm = (name: string, args?: Record<string, unknown>) =>
    client.callTool(name, args);

  server.registerTool(
    "notebooklm_get_health",
    {
      title: "NotebookLM health",
      description:
        "Check NotebookLM MCP health, authentication state, active sessions, and configuration.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => callNotebookLm("get_health"),
  );

  server.registerTool(
    "notebooklm_setup_auth",
    {
      title: "NotebookLM setup auth",
      description:
        "Open NotebookLM Google authentication in a browser window and save the browser state. The user enters Google credentials directly.",
      inputSchema: {
        show_browser: z.boolean().optional(),
        browser_options: z.unknown().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => callNotebookLm("setup_auth", args),
  );

  server.registerTool(
    "notebooklm_list_notebooks",
    {
      title: "List NotebookLM notebooks",
      description: "List notebooks saved in the NotebookLM MCP library.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => callNotebookLm("list_notebooks"),
  );

  server.registerTool(
    "notebooklm_add_notebook",
    {
      title: "Add NotebookLM notebook",
      description:
        "Add a NotebookLM notebook share URL to the local NotebookLM MCP library with metadata.",
      inputSchema: {
        url: z.string(),
        name: z.string(),
        description: z.string(),
        topics: z.array(z.string()),
        tags: z.array(z.string()).optional(),
        use_cases: z.array(z.string()).optional(),
        content_types: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => callNotebookLm("add_notebook", args),
  );

  server.registerTool(
    "notebooklm_ask_question",
    {
      title: "Ask NotebookLM",
      description:
        "Ask a question against a NotebookLM notebook URL, notebook ID, or active notebook. Use for best-effort source-grounded research from user-provided notebooks.",
      inputSchema: {
        question: z.string(),
        notebook_url: z.string().optional(),
        notebook_id: z.string().optional(),
        session_id: z.string().optional(),
        show_browser: z.boolean().optional(),
        browser_options: z.unknown().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => callNotebookLm("ask_question", args),
  );
}
