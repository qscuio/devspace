import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";
import { normalizeTeamDomain, type CloudflareAccessConfig } from "./cloudflare-access.js";

export type ToolMode = "minimal" | "full" | "codex";
export type ExtraToolMode = "compact" | "split";
export type WidgetMode = "off" | "changes" | "full";
const DEFAULT_NOTEBOOKLM_COMMAND = "npx";
const DEFAULT_NOTEBOOKLM_ARGS = [
  "-y",
  "-p",
  "notebooklm-mcp@1.2.1",
  "-p",
  "@modelcontextprotocol/sdk@1.28.0",
  "notebooklm-mcp",
];
const DEFAULT_NOTEBOOKLM_SESSION_TTL_SECONDS = 900;
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_QNOTE_REPO_URL = "git@github.com:qscuio/qnote.git";
const DEFAULT_QNOTE_ALLOWED_DIRS = [
  "knowledge",
  "lessons",
  "skills",
  "misc",
  "chatgpt",
  "claude",
  "codex",
  "cursor",
  "browser",
  "notebooklm",
  "dsrt",
  "simulation",
  "tools",
  "broadcom",
  "linux",
];

export interface NotebookLmConfig {
  enabled: boolean;
  command: string;
  args: string[];
  rawTools: boolean;
  dataDir: string;
  sessionTtlSeconds: number;
}

export interface QnoteConfig {
  enabled: boolean;
  dir: string;
  repoUrl: string;
  branch: string;
  autoPush: boolean;
  allowedDirs: string[];
}

export interface ServerConfig {
  host: string;
  port: number;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  extraToolMode: ExtraToolMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  artifactsEnabled: boolean;
  artifactMaxFileBytes: number;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: boolean;
  agentDir: string;
  notebooklm: NotebookLmConfig;
  qnote: QnoteConfig;
  logging: LoggingConfig;
  cloudflareAccess: CloudflareAccessConfig;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => normalizeConfigPath(root));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => normalizeConfigPath(root));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function normalizeConfigPath(value: string): string {
  const expanded = expandHomePath(value);
  const isWindowsAbsolute = /^[A-Za-z]:[\\/]/.test(expanded) || /^\\\\[^\\]/.test(expanded);
  return isWindowsAbsolute ? win32.normalize(expanded) : resolve(expanded);
}

function parseToolMode(env: NodeJS.ProcessEnv, fileValue: ToolMode | undefined): ToolMode {
  const mode = env.DEVSPACE_TOOL_MODE;
  if (mode === "minimal" || mode === "full" || mode === "codex") return mode;
  if (mode) throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${mode}`);

  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS) ? "minimal" : "full";
  }
  if (fileValue === "minimal" || fileValue === "full" || fileValue === "codex") {
    return fileValue;
  }
  return "minimal";
}

function parseExtraToolMode(value: string | undefined): ExtraToolMode {
  if (!value || value === "compact") return "compact";
  if (value === "split") return "split";

  throw new Error(`Invalid DEVSPACE_EXTRA_TOOL_MODE: ${value}`);
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseNotebookLmConfig(
  env: NodeJS.ProcessEnv,
  fileValue: {
    enabled?: boolean;
    command?: string;
    args?: string[];
    rawTools?: boolean;
    dataDir?: string;
    sessionTtlSeconds?: number;
  } | undefined,
  stateDir: string,
): NotebookLmConfig {
  return {
    enabled: env.DEVSPACE_NOTEBOOKLM === undefined
      ? fileValue?.enabled ?? true
      : parseBoolean(env.DEVSPACE_NOTEBOOKLM),
    command: env.DEVSPACE_NOTEBOOKLM_COMMAND?.trim() || fileValue?.command || DEFAULT_NOTEBOOKLM_COMMAND,
    args: parseStringList(
      env.DEVSPACE_NOTEBOOKLM_ARGS,
      fileValue?.args ?? DEFAULT_NOTEBOOKLM_ARGS,
    ),
    rawTools: env.DEVSPACE_NOTEBOOKLM_RAW_TOOLS === undefined
      ? fileValue?.rawTools ?? false
      : parseBoolean(env.DEVSPACE_NOTEBOOKLM_RAW_TOOLS),
    dataDir: normalizeConfigPath(
      env.DEVSPACE_NOTEBOOKLM_DATA_DIR ?? fileValue?.dataDir ?? join(stateDir, "notebooklm"),
    ),
    sessionTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS ?? fileValue?.sessionTtlSeconds?.toString(),
      DEFAULT_NOTEBOOKLM_SESSION_TTL_SECONDS,
      "DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS",
    ),
  };
}

function parseQnoteConfig(
  env: NodeJS.ProcessEnv,
  fileValue: {
    enabled?: boolean;
    dir?: string;
    repoUrl?: string;
    branch?: string;
    autoPush?: boolean;
    allowedDirs?: string[];
  } | undefined,
  stateDir: string,
): QnoteConfig {
  return {
    enabled: env.DEVSPACE_QNOTE === undefined
      ? fileValue?.enabled ?? true
      : parseBoolean(env.DEVSPACE_QNOTE),
    dir: normalizeConfigPath(env.DEVSPACE_QNOTE_DIR ?? fileValue?.dir ?? join(stateDir, "qnote")),
    repoUrl: env.DEVSPACE_QNOTE_REPO_URL?.trim() || fileValue?.repoUrl || DEFAULT_QNOTE_REPO_URL,
    branch: env.DEVSPACE_QNOTE_BRANCH?.trim() || fileValue?.branch || "main",
    autoPush: env.DEVSPACE_QNOTE_AUTO_PUSH === undefined
      ? fileValue?.autoPush ?? true
      : parseBoolean(env.DEVSPACE_QNOTE_AUTO_PUSH),
    allowedDirs: parseStringList(
      env.DEVSPACE_QNOTE_ALLOWED_DIRS,
      fileValue?.allowedDirs ?? DEFAULT_QNOTE_ALLOWED_DIRS,
    ),
  };
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
  };
}

function parseCloudflareAccessConfig(
  env: NodeJS.ProcessEnv,
  fileValue: {
    enabled?: boolean;
    teamDomain?: string;
    audience?: string[];
    allowedEmails?: string[];
  } | undefined,
): CloudflareAccessConfig {
  const enabled = env.DEVSPACE_CLOUDFLARE_ACCESS === undefined
    ? fileValue?.enabled ?? false
    : parseBoolean(env.DEVSPACE_CLOUDFLARE_ACCESS);
  const teamDomain = normalizeTeamDomain(
    env.DEVSPACE_CLOUDFLARE_ACCESS_TEAM_DOMAIN ?? fileValue?.teamDomain ?? "",
  );
  const audience = parseStringList(
    env.DEVSPACE_CLOUDFLARE_ACCESS_AUD,
    fileValue?.audience ?? [],
  );
  const allowedEmails = parseStringList(
    env.DEVSPACE_CLOUDFLARE_ACCESS_ALLOWED_EMAILS,
    fileValue?.allowedEmails ?? [],
  );

  if (enabled && !teamDomain) {
    throw new Error("DEVSPACE_CLOUDFLARE_ACCESS_TEAM_DOMAIN is required when Cloudflare Access is enabled.");
  }
  if (enabled && audience.length === 0) {
    throw new Error("DEVSPACE_CLOUDFLARE_ACCESS_AUD is required when Cloudflare Access is enabled.");
  }

  return {
    enabled,
    teamDomain: teamDomain || undefined,
    audience,
    allowedEmails,
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value) return "off";
  if (value === "off" || value === "changes" || value === "full") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const stateDir = normalizeConfigPath(
    env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir(),
  );
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  return {
    host,
    port,
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    toolMode: parseToolMode(env, files.config.toolMode),
    extraToolMode: parseExtraToolMode(env.DEVSPACE_EXTRA_TOOL_MODE ?? files.config.extraToolMode),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS ?? files.config.widgets),
    stateDir,
    worktreeRoot: normalizeConfigPath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot()),
    artifactsEnabled:
      env.DEVSPACE_ARTIFACTS === undefined
        ? files.config.artifactsEnabled === true
        : parseBoolean(env.DEVSPACE_ARTIFACTS),
    artifactMaxFileBytes: parsePositiveInteger(
      env.DEVSPACE_ARTIFACT_MAX_FILE_BYTES ?? numberConfigValue(files.config.artifactMaxFileBytes),
      DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      "DEVSPACE_ARTIFACT_MAX_FILE_BYTES",
    ),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined
      ? files.config.skillsEnabled ?? true
      : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents:
      env.DEVSPACE_SUBAGENTS === undefined
        ? files.config.subagents === true
        : parseBoolean(env.DEVSPACE_SUBAGENTS),
    agentDir: normalizeConfigPath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir()),
    notebooklm: parseNotebookLmConfig(env, files.config.notebooklm, stateDir),
    qnote: parseQnoteConfig(env, files.config.qnote, stateDir),
    logging: parseLoggingConfig(env),
    cloudflareAccess: parseCloudflareAccessConfig(env, files.config.cloudflareAccess),
  };
}

function numberConfigValue(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
