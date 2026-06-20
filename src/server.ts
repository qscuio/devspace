import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import type { Request, Response } from "express";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig, type WidgetMode } from "./config.js";
import { createCloudflareAccessMiddleware } from "./cloudflare-access.js";
import {
  logEvent,
  requestIp,
  requestPath,
  commandPreview,
  sessionIdPrefix,
} from "./logger.js";
import {
  editFileTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  runShellTool,
  writeFileTool,
} from "./pi-tools.js";
import { SingleUserOAuthProvider } from "./oauth-provider.js";
import { createReviewCheckpointManager } from "./review-checkpoints.js";
import { formatPathForPrompt } from "./skills.js";
import { sendToolProgress } from "./tool-progress.js";
import { createWorkspaceStore } from "./workspace-store.js";
import { formatAgentsPath, WorkspaceRegistry } from "./workspaces.js";
import {
  createNotebookLmClient,
  type NotebookLmClientFactory,
} from "./notebooklm.js";
import {
  createNotebookLmAuthRefreshManager,
  NotebookLmAuthRefreshError,
  type NotebookLmAuthRefreshManager,
} from "./notebooklm-auth-refresh.js";
import { defaultNotebookLmBrowserStatePath } from "./notebooklm-discovery.js";
import { registerNotebookLmTools } from "./notebooklm-tools.js";
import { registerQnoteTools } from "./qnote-tools.js";

type Transport = StreamableHTTPServerTransport;
const WORKSPACE_APP_URI = "ui://devspace/workspace-app.html";
const WORKSPACE_APP_MANIFEST_ENTRY = "workspace-app.html";
const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const EDIT_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};
const SHELL_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
}

interface ServerDependencies {
  notebookLmAuthRefreshManager?: NotebookLmAuthRefreshManager;
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface WorkspaceAppManifestEntry {
  file: string;
  css?: string[];
  isEntry?: boolean;
}

type WorkspaceAppManifest = Record<string, WorkspaceAppManifestEntry>;

interface DiffStats {
  additions: number;
  removals: number;
}

type ToolWidgetKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

interface ToolDefinitionMeta extends Record<string, unknown> {
  ui: {
    resourceUri: string;
    visibility: ["model"];
  };
}

type EmptyToolDefinitionMeta = Record<string, unknown> & {
  "ui/resourceUri"?: string;
};

interface ToolWidgetDescriptorMeta {
  _meta: ToolDefinitionMeta | EmptyToolDefinitionMeta;
}

function shouldAttachWidget(mode: WidgetMode, kind: ToolWidgetKind): boolean {
  switch (mode) {
    case "off":
      return false;
    case "changes":
      return kind === "workspace" || kind === "show_changes";
    case "full":
      return true;
  }
}

function toolWidgetDescriptorMeta(
  config: ServerConfig,
  kind: ToolWidgetKind,
): ToolWidgetDescriptorMeta {
  if (!shouldAttachWidget(config.widgets, kind)) return { _meta: {} };

  return {
    _meta: {
      ui: {
        resourceUri: WORKSPACE_APP_URI,
        visibility: ["model"],
      },
    },
  };
}

interface ToolNames {
  openWorkspace: "open_workspace";
  read: "read_file" | "read";
  write: "write_file" | "write";
  edit: "edit_file" | "edit";
  grep: "grep_files" | "grep";
  glob: "find_files" | "glob";
  ls: "list_directory" | "ls";
  shell: "run_shell" | "bash";
}

interface ToolLogFields {
  tool: string;
  workspaceId?: string;
  path?: string;
  workingDirectory?: string;
  command?: string;
  commandLength?: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

function toolNamesFor(config: ServerConfig): ToolNames {
  return config.toolNaming === "short"
    ? {
        openWorkspace: "open_workspace",
        read: "read",
        write: "write",
        edit: "edit",
        grep: "grep",
        glob: "glob",
        ls: "ls",
        shell: "bash",
      }
    : {
        openWorkspace: "open_workspace",
        read: "read_file",
        write: "write_file",
        edit: "edit_file",
        grep: "grep_files",
        glob: "find_files",
        ls: "list_directory",
        shell: "run_shell",
      };
}

function serverInstructions(config: ServerConfig, toolNames: ToolNames): string {
  const search = config.minimalTools
    ? config.shellEnabled
      ? `Use ${toolNames.shell} with rg/find/ls for search. `
      : `Use ${toolNames.read} for direct reads. `
    : `Use ${toolNames.read}/${toolNames.grep}/${toolNames.glob}/${toolNames.ls} for inspection. `;
  const changes = config.widgets === "changes" ? "Call show_changes after related edits. " : "";
  const extras = [
    config.notebooklm.enabled ? (config.extraToolMode === "compact" ? "Use notebooklm action research/status/discover/library." : "NotebookLM tools are best-effort.") : "",
    config.qnote.enabled ? (config.extraToolMode === "compact" ? "Use qnote action history/capture/search/read/sync." : "Use qnote_history to inspect AI history; store distilled notes with qnote_capture.") : "",
  ].filter(Boolean).join(" ");

  return `DevSpace exposes local workspaces. Call ${toolNames.openWorkspace} once per folder, reuse workspaceId, read returned instructions/skills when relevant. Prefer ${toolNames.edit} for targeted edits and ${toolNames.write} for full rewrites. ${search}${changes}${extras}`;
}
function resultOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return {
    result: z
      .string()
      .describe("Result text."),
    ...extra,
  };
}

function registerNotebookLmAuthRefreshRoutes(
  app: ReturnType<typeof createMcpExpressApp>,
  config: ServerConfig,
  manager: NotebookLmAuthRefreshManager,
): void {
  app.get("/notebooklm/auth-refresh", (_req, res) => {
    res.type("html").send(notebookLmAuthRefreshForm());
  });

  app.post(
    "/notebooklm/auth-refresh",
    express.urlencoded({ extended: false, limit: "16kb" }),
    (req, res) => {
      const ownerToken = typeof req.body?.owner_token === "string" ? req.body.owner_token : "";
      if (!safeStringEquals(ownerToken, config.oauth.ownerToken)) {
        res.status(401).type("html").send(notebookLmAuthRefreshForm("Owner password is incorrect."));
        return;
      }

      const uploadToken = manager.createUploadToken();
      res.type("html").send(notebookLmAuthRefreshUploadPage(uploadToken));
    },
  );

  app.post(
    "/notebooklm/auth-refresh/upload",
    express.json({ limit: "2mb" }),
    async (req, res) => {
      try {
        const body = isRecord(req.body) ? req.body : {};
        const token = typeof body.token === "string" ? body.token : "";
        const state = "state" in body ? body.state : undefined;
        const result = await manager.uploadState({ token, body: state });
        res.json({
          ok: true,
          cookies: result.cookies,
          origins: result.origins,
        });
      } catch (error) {
        if (error instanceof NotebookLmAuthRefreshError) {
          res.status(error.status).json({
            ok: false,
            code: error.code,
            message: error.message,
          });
          return;
        }
        throw error;
      }
    },
  );
}

function notebookLmAuthRefreshForm(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NotebookLM Auth Refresh</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 20px; line-height: 1.5; }
    label { display: block; font-weight: 600; margin-bottom: 8px; }
    input { box-sizing: border-box; width: 100%; padding: 10px 12px; font: inherit; }
    button { margin-top: 14px; padding: 10px 14px; font: inherit; }
    .error { color: #b00020; }
    code { word-break: break-all; }
  </style>
</head>
<body>
  <h1>NotebookLM Auth Refresh</h1>
  <p>Enter the DevSpace owner password to create a one-time upload token for a fresh NotebookLM browser state.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/notebooklm/auth-refresh">
    <label for="owner_token">Owner password</label>
    <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Create upload token</button>
  </form>
</body>
</html>`;
}

function notebookLmAuthRefreshUploadPage(uploadToken: {
  token: string;
  expiresAt: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NotebookLM Upload Token</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 760px; margin: 48px auto; padding: 0 20px; line-height: 1.5; }
    code, pre { word-break: break-all; white-space: pre-wrap; }
    pre { background: #f6f8fa; padding: 14px; border-radius: 6px; }
  </style>
</head>
<body>
  <h1>NotebookLM Upload Token</h1>
  <p>This token expires at <code>${escapeHtml(uploadToken.expiresAt)}</code> and can be used once.</p>
  <pre>${escapeHtml(JSON.stringify({
    uploadUrl: "/notebooklm/auth-refresh/upload",
    token: uploadToken.token,
  }, null, 2))}</pre>
  <p>Upload JSON as <code>{"token":"...","state":{...storage_state_json...}}</code>.</p>
</body>
</html>`;
}

function safeStringEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const workspaceSkillOutputSchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string(),
});

const workspaceAgentsFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const workspaceAvailableAgentsFileOutputSchema = z.object({
  path: z.string(),
});

const reviewFileOutputSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  type: z.enum(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  additions: z.number(),
  removals: z.number(),
});

const reviewSummaryOutputSchema = z.object({
  files: z.number(),
  additions: z.number(),
  removals: z.number(),
});

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function requestLogFields(req: Request, config: ServerConfig): Record<string, unknown> {
  return {
    ip: requestIp(req, config.logging.trustProxy),
    host: req.header("host"),
    userAgent: req.header("user-agent"),
    origin: req.header("origin"),
    referer: req.header("referer"),
    contentLength: req.header("content-length"),
  };
}

function logToolCall(config: ServerConfig, fields: ToolLogFields): void {
  if (!config.logging.toolCalls) return;

  const { command, ...safeFields } = fields;
  logEvent(config.logging, fields.success ? "info" : "warn", "tool_call", {
    ...safeFields,
    commandPreview: config.logging.shellCommands && command ? commandPreview(command) : undefined,
  });
}

function contentText(content: ToolContent[]): string {
  return content
    .filter(
      (item): item is { type: "text"; text: string } => item.type === "text",
    )
    .map((item) => item.text)
    .join("\n");
}

function toolErrorPreview(content: ToolContent[]): string | undefined {
  const text = contentText(content).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function logFailedToolResponse(
  config: ServerConfig,
  fields: Omit<ToolLogFields, "success" | "durationMs" | "error">,
  content: ToolContent[],
  startedAt: number,
): void {
  logToolCall(config, {
    ...fields,
    success: false,
    durationMs: Math.round(performance.now() - startedAt),
    error: toolErrorPreview(content),
  });
}

function textBlock(text: string): ToolContent {
  return { type: "text", text };
}

function textSummary(content: ToolContent[]): {
  lines: number;
  characters: number;
} {
  const text = contentText(content);
  return {
    lines: text.length === 0 ? 0 : text.split("\n").length,
    characters: text.length,
  };
}

function contentLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.slice(0, -1).split("\n").length
    : content.split("\n").length;
}

function countDiffStats(diff: string | undefined): DiffStats {
  if (!diff) return { additions: 0, removals: 0 };

  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

function reviewResultText(review: {
  result: string;
  patch?: string;
}): string {
  const patch = review.patch?.trimEnd();
  if (!patch) return review.result;
  return `${review.result}\n\n\`\`\`diff\n${patch}\n\`\`\``;
}

function newFilePatch(path: string, content: string): string {
  const lines =
    content.length === 0
      ? []
      : content.endsWith("\n")
        ? content.slice(0, -1).split("\n")
        : content.split("\n");
  const hunkLength = lines.length;
  const hunkRange = hunkLength === 0 ? "+0,0" : `+1,${hunkLength}`;
  const body = lines.map((line) => `+${line}`).join("\n");

  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 ${hunkRange} @@`,
    body,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function assetBaseUrl(config: ServerConfig): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}/mcp-app-assets`;
}

function uiManifestUrl(): URL {
  return new URL("../dist/ui/.vite/manifest.json", import.meta.url);
}

let workspaceAppManifestCache: WorkspaceAppManifest | null = null;
let workspaceAppAssetsVerified = false;

function readWorkspaceAppManifest(): WorkspaceAppManifest {
  workspaceAppManifestCache ??= JSON.parse(
    readFileSync(uiManifestUrl(), "utf8"),
  ) as WorkspaceAppManifest;
  return workspaceAppManifestCache;
}

function getWorkspaceAppManifestEntry(): WorkspaceAppManifestEntry {
  const manifest = readWorkspaceAppManifest();
  const entry = manifest[WORKSPACE_APP_MANIFEST_ENTRY];

  if (!entry?.file) {
    throw new Error(`Missing ${WORKSPACE_APP_MANIFEST_ENTRY} in UI manifest.`);
  }

  return entry;
}

function assetUrl(baseUrl: string, assetPath: string): string {
  return `${baseUrl}/${assetPath.replace(/^\/+/, "")}`;
}

function criticalShellStyles(): string {
  return `:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;background:transparent;color:#f5f5f6}*{box-sizing:border-box}html,body{margin:0;background:transparent;overflow:hidden}.shell{width:100%;padding:0;overflow:hidden}.critical-card{width:100%;min-height:86px;border:1px solid color-mix(in srgb,#3a3a40 86%,transparent);border-radius:8px;background:color-mix(in srgb,#28282d 92%,transparent);color:#f5f5f6}.critical-header{display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:12px;min-height:64px;padding:10px 14px}.critical-icon{display:grid;width:38px;height:38px;place-items:center;border:1px solid color-mix(in srgb,#3a3a40 55%,transparent);border-radius:8px;background:linear-gradient(180deg,color-mix(in srgb,#3a3a42 72%,transparent),color-mix(in srgb,#17181c 90%,transparent));color:#f5f5f6}.critical-icon svg{width:19px;height:19px}.critical-main{display:grid;min-width:0;gap:3px}.critical-title{font-size:13px;font-weight:600}.critical-label{overflow:hidden;color:#d6d6dc;font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;text-overflow:ellipsis;white-space:nowrap}.critical-badge{display:inline-flex;align-items:center;min-height:24px;padding:0 9px;border:1px solid color-mix(in srgb,#3a3a40 80%,transparent);border-radius:999px;background:color-mix(in srgb,#17181c 42%,transparent);color:#d6d6dc;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}.critical-body{display:grid;gap:10px;padding:0 14px 14px}.critical-line{color:#b7b7bf;font-size:13px}.critical-progress-bar{position:relative;overflow:hidden;height:4px;border-radius:999px;background:color-mix(in srgb,#3a3a40 64%,transparent)}.critical-progress-bar span{position:absolute;top:0;bottom:0;left:-35%;width:35%;border-radius:inherit;background:color-mix(in srgb,#f5f5f6 72%,transparent);animation:critical-progress-slide 1.35s ease-in-out infinite}@keyframes critical-progress-slide{0%{transform:translateX(0)}100%{transform:translateX(385%)}}@media (prefers-color-scheme:light){:root{color:#17181c}.critical-card{border-color:#d6d6dc;background:#fff;color:#17181c}.critical-icon{background:#f7f7f8;color:#17181c}.critical-label,.critical-badge{color:#4b4b55}.critical-line{color:#5d5d66}.critical-progress-bar{background:#e5e5e8}.critical-progress-bar span{background:#6f6f78}}`;
}

function criticalShellMarkup(): string {
  return `<section class="critical-card" data-critical-shell>
        <div class="critical-header">
          <span class="critical-icon" aria-hidden="true">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"><circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" /></svg>
          </span>
          <span class="critical-main">
            <span class="critical-title">Starting DevSpace tool</span>
            <span class="critical-label">Loading tool progress...</span>
          </span>
          <span class="critical-badge">starting</span>
        </div>
        <div class="critical-body">
          <div class="critical-line">Preparing the tool card...</div>
          <div class="critical-progress-bar" aria-hidden="true"><span></span></div>
        </div>
      </section>`;
}

export function workspaceAppHtml(config: ServerConfig): string {
  const baseUrl = assetBaseUrl(config);
  const entry = getWorkspaceAppManifestEntry();
  const scriptUrl = assetUrl(baseUrl, entry.file);
  const stylesheets = (entry.css ?? [])
    .map(
      (stylesheet) =>
        [
          `    <link rel="preload" as="style" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
          `    <link rel="stylesheet" crossorigin href="${assetUrl(baseUrl, stylesheet)}" />`,
        ].join("\n"),
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DevSpace Workspace</title>
    <style id="devspace-critical-shell">${criticalShellStyles()}</style>
    <link rel="modulepreload" crossorigin href="${scriptUrl}" />
${stylesheets}
    <script type="module" crossorigin src="${scriptUrl}"></script>
  </head>
  <body>
    <main id="app" class="shell">
      ${criticalShellMarkup()}
    </main>
  </body>
</html>`;
}

function appCsp(config: ServerConfig): {
  resourceDomains: string[];
  connectDomains: string[];
} {
  const publicBaseUrl = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    resourceDomains: [publicBaseUrl],
    connectDomains: [publicBaseUrl],
  };
}

function uiBuildDirectory(): string {
  return fileURLToPath(new URL("../dist/ui", import.meta.url));
}

function uiAssetsDirectory(): string {
  return fileURLToPath(new URL("../dist/ui/assets", import.meta.url));
}

function setAssetHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

async function assertWorkspaceAppAssets(): Promise<void> {
  if (workspaceAppAssetsVerified) return;
  const entry = getWorkspaceAppManifestEntry();
  const candidates = [entry.file, ...(entry.css ?? [])].map(
    (assetPath) => new URL(`../dist/ui/${assetPath}`, import.meta.url),
  );

  for (const candidate of candidates) {
    await access(candidate);
  }
  workspaceAppAssetsVerified = true;
}

export function createMcpServer(
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
  reviewCheckpoints: ReturnType<typeof createReviewCheckpointManager>,
  notebookLmClientFactory: NotebookLmClientFactory = () => createNotebookLmClient(config.notebooklm),
): McpServer {
  const toolNames = toolNamesFor(config);
  const server = new McpServer(
    {
      name: "devspace",
      title: "DevSpace",
      version: "0.1.0",
      description:
        "Secure local coding workspace for MCP clients. Provides workspace-scoped file, search, edit, write, and shell tools.",
    },
    {
      instructions: serverInstructions(config, toolNames),
    },
  );

  registerNotebookLmTools(server, config, notebookLmClientFactory);
  registerQnoteTools(server, config);

  registerAppResource(
    server,
    "DevSpace Diff Card",
    WORKSPACE_APP_URI,
    {
      description: "Interactive card for viewing DevSpace file diffs.",
      _meta: {
        ui: {
          csp: appCsp(config),
        },
      },
    },
    async () => {
      await assertWorkspaceAppAssets();
      return {
        contents: [
          {
            uri: WORKSPACE_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: workspaceAppHtml(config),
            _meta: {
              ui: {
                csp: appCsp(config),
              },
            },
          },
        ],
      };
    },
  );

  registerAppTool(
    server,
    "open_workspace",
    {
      title: "Open workspace",
      description:
        "Open a project and return a workspaceId plus relevant instructions/skills.",
      inputSchema: {
        path: z
          .string()
          .describe("Project path inside an allowed root."),
        mode: z
          .enum(["checkout", "worktree"])
          .optional()
          .describe("checkout or isolated worktree."),
        baseRef: z
          .string()
          .optional()
          .describe("Worktree base ref."),
      },
      outputSchema: {
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["checkout", "worktree"]),
        sourceRoot: z.string().optional(),
        worktree: z
          .object({
            path: z.string(),
            baseRef: z.string(),
            baseSha: z.string(),
            dirtySource: z.boolean(),
            detached: z.boolean(),
            managed: z.boolean(),
          })
          .optional(),
        agentsFiles: z.array(workspaceAgentsFileOutputSchema),
        availableAgentsFiles: z.array(workspaceAvailableAgentsFileOutputSchema),
        skills: z.array(workspaceSkillOutputSchema),
        skillDiagnostics: z.array(z.unknown()),
        instruction: z.string(),
      },
      ...toolWidgetDescriptorMeta(config, "workspace"),
      annotations: { readOnlyHint: true },
    },
    async ({ path, mode, baseRef }, extra) => {
      const startedAt = performance.now();
      await sendToolProgress(extra, {
        progress: 1,
        total: 4,
        message: "Opening workspace",
      });
      const { workspace, agentsFiles, availableAgentsFiles } = await workspaces.openWorkspace({ path, mode, baseRef });
      await sendToolProgress(extra, {
        progress: 2,
        total: 4,
        message: "Preparing review checkpoint",
      });
      void reviewCheckpoints.initializeWorkspace({
        workspaceId: workspace.id,
        root: workspace.root,
      });
      await sendToolProgress(extra, {
        progress: 3,
        total: 4,
        message: "Loading workspace instructions",
      });
      const visibleSkills = workspace.skills
        .filter((skill) => !skill.disableModelInvocation)
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          path: formatPathForPrompt(skill.filePath),
        }));
      const loadedAgentsFiles = agentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
        content: file.content,
      }));
      const availableAgentsFileOutputs = availableAgentsFiles.map((file) => ({
        path: formatAgentsPath(file.path, workspace.root),
      }));
      const instruction = config.skillsEnabled
        ? "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file. When a task matches an available skill in skills, read its path before proceeding."
        : "Use this workspaceId in all subsequent tool calls for this project. Do not call open_workspace again for this same folder unless this workspaceId stops working, the user asks to reopen, or you switch to a different folder/worktree. Follow loaded agentsFiles instructions. Before working under a path listed in availableAgentsFiles, read that instruction file.";
      const resultContent: ToolContent[] = [
        {
          type: "text" as const,
          text: [
            `Opened workspace ${workspace.id}`,
            `Root: ${workspace.root}`,
            `Mode: ${workspace.mode}`,
            loadedAgentsFiles.length > 0
              ? `Loaded project instructions: ${loadedAgentsFiles.map((file) => file.path).join(", ")}`
              : undefined,
            availableAgentsFileOutputs.length > 0
              ? `Available nested instructions: ${availableAgentsFileOutputs.map((file) => file.path).join(", ")}`
              : undefined,
            visibleSkills.length > 0
              ? `Available skills: ${visibleSkills.map((skill) => skill.name).join(", ")}`
              : undefined,
            instruction,
          ].filter(Boolean).join("\n"),
        },
      ];
      logToolCall(config, {
        tool: "open_workspace",
        workspaceId: workspace.id,
        path: workspace.root,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      await sendToolProgress(extra, {
        progress: 4,
        total: 4,
        message: "Workspace opened",
      });

      return {
        content: resultContent,
        _meta: {
          tool: "open_workspace",
          card: {
            workspaceId: workspace.id,
            root: workspace.root,
            path: workspace.root,
            summary: {
              agentsFiles: loadedAgentsFiles.length,
              availableAgentsFiles: availableAgentsFileOutputs.length,
              skills: visibleSkills.length,
              skillDiagnostics: workspace.skillDiagnostics.length,
            },
          },
        },
        structuredContent: {
          workspaceId: workspace.id,
          root: workspace.root,
          mode: workspace.mode,
          sourceRoot: workspace.sourceRoot,
          worktree: workspace.worktree,
          agentsFiles: loadedAgentsFiles,
          availableAgentsFiles: availableAgentsFileOutputs,
          skills: visibleSkills,
          skillDiagnostics: workspace.skillDiagnostics,
          instruction,
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.read,
    {
      title: "Read file",
      description:
        "Read a workspace file or advertised skill/instruction file.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("workspaceId."),
        path: z
          .string()
          .describe("Path to read."),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Start line."),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max lines."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "read"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, ...input }, extra) => {
      const startedAt = performance.now();
      await sendToolProgress(extra, {
        progress: 1,
        total: 2,
        message: `Reading ${input.path}`,
      });
      const workspace = workspaces.getWorkspace(workspaceId);
      const readPath = workspaces.resolveReadPath(workspace, input.path);
      const response = await readFileTool(
        { ...input, path: readPath.absolutePath },
        {
          cwd: workspace.root,
          root: workspace.root,
          readRoots: readPath.readRoots,
        },
      );

      if (response.isError) {
        await sendToolProgress(extra, {
          progress: 2,
          total: 2,
          message: "Read failed",
        });
        logFailedToolResponse(config, {
          tool: toolNames.read,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }
      workspaces.markReadPathLoaded(workspace, readPath);

      const summary = {
        ...textSummary(response.content),
        offset: input.offset ?? 1,
        limited: input.limit !== undefined,
      };
      logToolCall(config, {
        tool: toolNames.read,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      await sendToolProgress(extra, {
        progress: 2,
        total: 2,
        message: "Read complete",
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.read,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.write,
    {
      title: "Write file",
      description:
        `Create or overwrite a workspace file. Prefer ${toolNames.edit} for targeted changes.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("workspaceId."),
        path: z
          .string()
          .describe("Path to write."),
        content: z.string().describe("New file content."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "write"),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }, extra) => {
      const startedAt = performance.now();
      await sendToolProgress(extra, {
        progress: 1,
        total: 3,
        message: `Writing ${input.path}`,
      });
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await writeFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        await sendToolProgress(extra, {
          progress: 3,
          total: 3,
          message: "Write failed",
        });
        logFailedToolResponse(config, {
          tool: toolNames.write,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const patch = newFilePatch(input.path, input.content);
      await sendToolProgress(extra, {
        progress: 2,
        total: 3,
        message: "Preparing write diff",
      });
      const stats = countDiffStats(patch);
      const summary = {
        ...stats,
        lines: contentLineCount(input.content),
        characters: input.content.length,
      };
      logToolCall(config, {
        tool: toolNames.write,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      await sendToolProgress(extra, {
        progress: 3,
        total: 3,
        message: "Write complete",
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.write,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              content: response.content,
              patch,
            },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
    },
  );

  registerAppTool(
    server,
    toolNames.edit,
    {
      title: "Edit file",
      description:
        `Edit a workspace file by exact text replacement.`,
      inputSchema: {
        workspaceId: z
          .string()
          .describe("workspaceId."),
        path: z
          .string()
          .describe("Path to edit."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe("Exact text to replace."),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: resultOutputSchema({
        status: z.literal("applied"),
      }),
      ...toolWidgetDescriptorMeta(config, "edit"),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, ...input }, extra) => {
      const startedAt = performance.now();
      await sendToolProgress(extra, {
        progress: 1,
        total: 3,
        message: `Editing ${input.path}`,
      });
      const workspace = workspaces.getWorkspace(workspaceId);
      workspaces.resolvePath(workspace, input.path);
      const response = await editFileTool(input, {
        cwd: workspace.root,
        root: workspace.root,
      });

      if (response.isError) {
        await sendToolProgress(extra, {
          progress: 3,
          total: 3,
          message: "Edit failed",
        });
        logFailedToolResponse(config, {
          tool: toolNames.edit,
          workspaceId,
          path: input.path,
        }, response.content, startedAt);
        return response;
      }

      const stats = countDiffStats(
        response.details?.patch ?? response.details?.diff,
      );
      await sendToolProgress(extra, {
        progress: 2,
        total: 3,
        message: "Preparing edit diff",
      });
      const summary = {
        ...stats,
        editCount: input.edits.length,
      };
      const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
      const editContent = [textBlock(editResultText)];
      logToolCall(config, {
        tool: toolNames.edit,
        workspaceId,
        path: input.path,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      await sendToolProgress(extra, {
        progress: 3,
        total: 3,
        message: "Edit complete",
      });

      return {
        content: editContent,
        _meta: {
          tool: toolNames.edit,
          card: {
            workspaceId,
            path: input.path,
            summary,
            payload: {
              diff: response.details?.diff,
              patch: response.details?.patch,
            },
          },
        },
        structuredContent: {
          status: "applied",
          result: contentText(editContent),
        },
      };
    },
  );

  registerAppTool(
    server,
    "show_changes",
    {
      title: "Show changes",
      description:
        "Show workspace changes since the last checkpoint.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("workspaceId."),
        since: z
          .enum(["last_shown", "workspace_open"])
          .optional()
          .describe("Diff base."),
        markReviewed: z
          .boolean()
          .optional()
          .describe("Advance checkpoint."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "show_changes"),
      annotations: { readOnlyHint: true },
    },
    async ({ workspaceId, since, markReviewed }, extra) => {
      const startedAt = performance.now();
      await sendToolProgress(extra, {
        progress: 1,
        total: 3,
        message: "Collecting workspace changes",
      });
      const workspace = workspaces.getWorkspace(workspaceId);
      const review = await reviewCheckpoints.reviewChanges({
        workspaceId,
        root: workspace.root,
        since: since ?? "last_shown",
        markReviewed: markReviewed ?? true,
        includePatch: config.widgets === "off",
      });

      const content = [textBlock(reviewResultText(review))];
      await sendToolProgress(extra, {
        progress: 2,
        total: 3,
        message: config.widgets === "off" ? "Formatting diff text" : "Preparing review card",
      });
      logToolCall(config, {
        tool: "show_changes",
        workspaceId,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      await sendToolProgress(extra, {
        progress: 3,
        total: 3,
        message: "Changes ready",
      });

      const result = {
        content,
        structuredContent: {
          result: contentText(content),
        },
      };

      if (config.widgets === "off") return result;

      return {
        ...result,
        _meta: {
          tool: "show_changes",
          card: {
            workspaceId,
            summary: review.summary,
            files: review.files,
            payload: review.patchId
              ? {
                  reviewPayloadUrl: new URL(`/review-payloads/${review.patchId}`, config.publicBaseUrl).toString(),
                }
              : undefined,
          },
        },
      };
    },
  );

  if (!config.minimalTools) {
    registerAppTool(
      server,
      toolNames.grep,
      {
        title: config.toolNaming === "short" ? "Grep" : "Grep files",
        description:
          "Search workspace file contents.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("workspaceId."),
          pattern: z.string().describe("Pattern."),
          path: z
            .string()
            .optional()
            .describe("Optional scope."),
          include: z.string().optional().describe("Include glob."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, extra) => {
        const startedAt = performance.now();
        await sendToolProgress(extra, {
          progress: 1,
          total: 2,
          message: `Searching ${input.path ?? "."}`,
        });
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await grepFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          await sendToolProgress(extra, {
            progress: 2,
            total: 2,
            message: "Search failed",
          });
          logFailedToolResponse(config, {
            tool: toolNames.grep,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.grep,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        await sendToolProgress(extra, {
          progress: 2,
          total: 2,
          message: "Search complete",
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.grep,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.glob,
      {
        title: config.toolNaming === "short" ? "Glob" : "Find files",
        description:
          "Find workspace files by glob.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("workspaceId."),
          pattern: z.string().describe("Glob."),
          path: z
            .string()
            .optional()
            .describe("Optional scope."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "search"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, extra) => {
        const startedAt = performance.now();
        await sendToolProgress(extra, {
          progress: 1,
          total: 2,
          message: `Finding files in ${input.path ?? "."}`,
        });
        const workspace = workspaces.getWorkspace(workspaceId);
        if (input.path) workspaces.resolvePath(workspace, input.path);
        const response = await findFilesTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          await sendToolProgress(extra, {
            progress: 2,
            total: 2,
            message: "Find files failed",
          });
          logFailedToolResponse(config, {
            tool: toolNames.glob,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = {
          pattern: input.pattern,
          scope: input.path ?? ".",
          ...textSummary(response.content),
        };
        logToolCall(config, {
          tool: toolNames.glob,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        await sendToolProgress(extra, {
          progress: 2,
          total: 2,
          message: "Find files complete",
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.glob,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );

    registerAppTool(
      server,
      toolNames.ls,
      {
        title: config.toolNaming === "short" ? "Ls" : "List directory",
        description:
          "List a workspace directory.",
        inputSchema: {
          workspaceId: z
            .string()
            .describe("workspaceId."),
          path: z
            .string()
            .describe("Directory path."),
        },
        outputSchema: resultOutputSchema(),
        ...toolWidgetDescriptorMeta(config, "directory"),
        annotations: { readOnlyHint: true },
      },
      async ({ workspaceId, ...input }, extra) => {
        const startedAt = performance.now();
        await sendToolProgress(extra, {
          progress: 1,
          total: 2,
          message: `Listing ${input.path}`,
        });
        const workspace = workspaces.getWorkspace(workspaceId);
        workspaces.resolvePath(workspace, input.path);
        const response = await listDirectoryTool(input, {
          cwd: workspace.root,
          root: workspace.root,
        });

        if (response.isError) {
          await sendToolProgress(extra, {
            progress: 2,
            total: 2,
            message: "List directory failed",
          });
          logFailedToolResponse(config, {
            tool: toolNames.ls,
            workspaceId,
            path: input.path,
          }, response.content, startedAt);
          return response;
        }

        const summary = textSummary(response.content);
        logToolCall(config, {
          tool: toolNames.ls,
          workspaceId,
          path: input.path,
          success: true,
          durationMs: Math.round(performance.now() - startedAt),
        });
        await sendToolProgress(extra, {
          progress: 2,
          total: 2,
          message: "List directory complete",
        });

        return {
          ...response,
          _meta: {
            tool: toolNames.ls,
            card: {
              workspaceId,
              path: input.path,
              summary,
              payload: { content: response.content },
            },
          },
          structuredContent: {
            result: contentText(response.content),
          },
        };
      },
    );
  }

  if (config.shellEnabled) {
    registerAppTool(
      server,
      toolNames.shell,
      {
      title: config.toolNaming === "short" ? "Bash" : "Run shell",
      description: config.minimalTools
        ? "Run read-only shell inspection or build/test commands in a workspace."
        : "Run build/test/git/package commands in a workspace.",
      inputSchema: {
        workspaceId: z
          .string()
          .describe("workspaceId."),
        command: z
          .string()
          .describe("Command to run."),
        workingDirectory: z
          .string()
          .optional()
          .describe("Optional cwd."),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout seconds."),
      },
      outputSchema: resultOutputSchema(),
      ...toolWidgetDescriptorMeta(config, "shell"),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
      async ({ workspaceId, workingDirectory, ...input }, extra) => {
      const startedAt = performance.now();
      await sendToolProgress(extra, {
        progress: 1,
        total: 2,
        message: "Running shell command",
      });
      const workspace = workspaces.getWorkspace(workspaceId);
      const cwd = workspaces.resolveWorkingDirectory(
        workspace,
        workingDirectory,
      );
      const response = await runShellTool(input, {
        cwd,
        root: workspace.root,
      });

      if (response.isError) {
        await sendToolProgress(extra, {
          progress: 2,
          total: 2,
          message: "Shell command failed",
        });
        logFailedToolResponse(config, {
          tool: toolNames.shell,
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: input.command,
          commandLength: input.command.length,
        }, response.content, startedAt);
        return response;
      }

      const summary = {
        command: input.command,
        workingDirectory: workingDirectory ?? ".",
        ...textSummary(response.content),
      };
      logToolCall(config, {
        tool: toolNames.shell,
        workspaceId,
        workingDirectory: workingDirectory ?? ".",
        command: input.command,
        commandLength: input.command.length,
        success: true,
        durationMs: Math.round(performance.now() - startedAt),
      });
      await sendToolProgress(extra, {
        progress: 2,
        total: 2,
        message: "Shell command complete",
      });

      return {
        ...response,
        _meta: {
          tool: toolNames.shell,
          card: {
            workspaceId,
            path: workingDirectory,
            summary,
            payload: { content: response.content },
          },
        },
        structuredContent: {
          result: contentText(response.content),
        },
      };
      },
    );
  }

  return server;
}

export function createServer(config = loadConfig(), deps: ServerDependencies = {}): RunningServer {
  const allowedHosts = config.allowedHosts.includes("*")
    ? undefined
    : Array.from(new Set([config.host, ...config.allowedHosts]));
  const app = createMcpExpressApp({
    host: config.host,
    ...(allowedHosts ? { allowedHosts } : {}),
  });
  const transports = new Map<string, Transport>();
  const mcpUrl = new URL("/mcp", config.publicBaseUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);
  const oauthProvider = new SingleUserOAuthProvider(
    config.oauth,
    mcpUrl,
    join(config.stateDir, "oauth-clients.json"),
    join(config.stateDir, "oauth-tokens.json"),
  );
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "devspace"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });
  const workspaceStore = createWorkspaceStore(config.stateDir);
  const workspaces = new WorkspaceRegistry(config, workspaceStore);
  const reviewCheckpoints = createReviewCheckpointManager();
  const notebookLmAuthRefreshManager = deps.notebookLmAuthRefreshManager ?? createNotebookLmAuthRefreshManager({
    statePath: defaultNotebookLmBrowserStatePath(),
  });

  if (config.logging.trustProxy) {
    app.set("trust proxy", 1);
  }

  app.use(createCloudflareAccessMiddleware(config.cloudflareAccess, config.logging));

  app.use((req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    res.locals.requestId = requestId;

    res.on("finish", () => {
      const path = requestPath(req);
      if (!config.logging.requests) return;
      if (
        !config.logging.assets &&
        (path.startsWith("/mcp-app-assets") || path.startsWith("/assets"))
      ) {
        return;
      }

      logEvent(config.logging, "info", "http_request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...requestLogFields(req, config),
      });
    });

    next();
  });

  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      issuer: new URL(config.publicBaseUrl).href,
      authorization_endpoint: new URL("/authorize", config.publicBaseUrl).href,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint: new URL("/token", config.publicBaseUrl).href,
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      scopes_supported: config.oauth.scopes,
      revocation_endpoint: new URL("/revoke", config.publicBaseUrl).href,
      revocation_endpoint_auth_methods_supported: ["client_secret_post"],
      registration_endpoint: new URL("/register", config.publicBaseUrl).href,
    });
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.publicBaseUrl),
      baseUrl: new URL(config.publicBaseUrl),
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "DevSpace",
    }),
  );

  app.options("/mcp-app-assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/mcp-app-assets",
    express.static(uiBuildDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.options("/assets/{*asset}", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.use(
    "/assets",
    express.static(uiAssetsDirectory(), {
      immutable: true,
      maxAge: "1y",
      fallthrough: false,
      setHeaders: setAssetHeaders,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "devspace" });
  });

  app.options("/review-payloads/:id", (_req, res) => {
    setAssetHeaders(res);
    res.sendStatus(204);
  });

  app.get("/review-payloads/:id", async (req, res) => {
    setAssetHeaders(res);
    const patch = await reviewCheckpoints.readReviewPatch(req.params.id);
    if (patch === undefined) {
      res.status(404).json({ ok: false, error: "review payload not found" });
      return;
    }
    res.json({ ok: true, patch });
  });

  registerNotebookLmAuthRefreshRoutes(app, config, notebookLmAuthRefreshManager);

  app.all("/mcp", async (req, res) => {
    const requestId = res.locals.requestId as string | undefined;
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (res.headersSent) return;

    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })) {
      logEvent(config.logging, "warn", "auth_denied", {
        requestId,
        method: req.method,
        path: requestPath(req),
        reason: "invalid_oauth_resource",
        ...requestLogFields(req, config),
      });
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    logEvent(config.logging, "debug", "mcp_request", {
      requestId,
      method: req.method,
      sessionIdPresent: Boolean(sessionId),
      sessionIdPrefix: sessionIdPrefix(sessionId),
      isInitialize: initializeRequest,
    });

    try {
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
            logEvent(config.logging, "info", "mcp_session_created", {
              requestId,
              sessionIdPrefix: sessionIdPrefix(newSessionId),
              ...requestLogFields(req, config),
            });
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) {
            transports.delete(closedSessionId);
            logEvent(config.logging, "info", "mcp_session_closed", {
              sessionIdPrefix: sessionIdPrefix(closedSessionId),
            });
          }
        };

        const server = createMcpServer(config, workspaces, reviewCheckpoints);
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logEvent(config.logging, "error", "mcp_request_error", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  return { app, config };
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) return false;

  const modulePath = await realpath(fileURLToPath(import.meta.url));
  const entrypointPath = await realpath(process.argv[1]);
  return modulePath === entrypointPath;
}

if (await isMainModule()) {
  const { app, config } = createServer();
  app.listen(config.port, config.host, () => {
    console.log(
      `devspace listening on http://${config.host}:${config.port}/mcp`,
    );
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log("auth: oauth owner-token flow required");
    console.log(`shell tool: ${config.shellEnabled ? "enabled" : "disabled"}`);
    console.log(`cloudflare access: ${config.cloudflareAccess.enabled ? "required" : "not required"}`);
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(`request logging: ${config.logging.requests ? "enabled" : "disabled"}`);
    console.log(`asset logging: ${config.logging.assets ? "enabled" : "disabled"}`);
    console.log(`trust proxy: ${config.logging.trustProxy ? "enabled" : "disabled"}`);
  });
}
