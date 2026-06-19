import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolNaming, "short");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_NAMING: "short" }).toolNaming, "short");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_NAMING: "legacy" }).toolNaming, "legacy");
assert.equal(loadConfig(baseEnv).minimalTools, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).minimalTools, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).minimalTools, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "0" }).minimalTools, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "1" }).minimalTools, true);
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).shellEnabled, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SHELL: "0" }).shellEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SHELL: "1" }).shellEnabled, true);
assert.equal(loadConfig(baseEnv).notebooklm.enabled, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM: "0" }).notebooklm.enabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM: "1" }).notebooklm.enabled, true);
assert.equal(loadConfig(baseEnv).notebooklm.command, "npx");
assert.deepEqual(loadConfig(baseEnv).notebooklm.args, [
  "-y",
  "-p",
  "notebooklm-mcp@1.2.1",
  "-p",
  "@modelcontextprotocol/sdk@1.28.0",
  "notebooklm-mcp",
]);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM_COMMAND: "node" }).notebooklm.command,
  "node",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM_ARGS: "server.js,--stdio" }).notebooklm.args,
  ["server.js", "--stdio"],
);
assert.equal(loadConfig(baseEnv).notebooklm.rawTools, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM_RAW_TOOLS: "1" }).notebooklm.rawTools, true);
assert.equal(loadConfig(baseEnv).notebooklm.sessionTtlSeconds, 900);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS: "120" }).notebooklm.sessionTtlSeconds,
  120,
);
assert.match(loadConfig(baseEnv).notebooklm.dataDir, /notebooklm$/);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM_DATA_DIR: "C:\\tmp\\notebooklm-data" }).notebooklm.dataDir,
  "C:\\tmp\\notebooklm-data",
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_NOTEBOOKLM_SESSION_TTL_SECONDS: 0/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_NAMING: "invalid" }),
  /Invalid DEVSPACE_TOOL_NAMING: invalid/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
    shellEnabled: false,
    skillsEnabled: false,
    toolMode: "full",
    toolNaming: "legacy",
    widgets: "off",
    notebooklm: {
      enabled: false,
      command: "node",
      args: ["local-notebooklm.js"],
      rawTools: true,
      dataDir: "C:\\tmp\\persisted-notebooklm",
      sessionTtlSeconds: 120,
    },
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.equal(fileConfig.shellEnabled, false);
assert.equal(fileConfig.skillsEnabled, false);
assert.equal(fileConfig.minimalTools, false);
assert.equal(fileConfig.toolNaming, "legacy");
assert.equal(fileConfig.widgets, "off");
assert.deepEqual(fileConfig.notebooklm, {
  enabled: false,
  command: "node",
  args: ["local-notebooklm.js"],
  rawTools: true,
  dataDir: "C:\\tmp\\persisted-notebooklm",
  sessionTtlSeconds: 120,
});
assert.equal(fileConfig.cloudflareAccess.enabled, false);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);
assert.equal(loadConfig({ DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_SHELL: "1" }).shellEnabled, true);

const accessConfig = loadConfig({
  ...baseEnv,
  DEVSPACE_CLOUDFLARE_ACCESS: "1",
  DEVSPACE_CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://example.cloudflareaccess.com/",
  DEVSPACE_CLOUDFLARE_ACCESS_AUD: "aud-one,aud-two",
  DEVSPACE_CLOUDFLARE_ACCESS_ALLOWED_EMAILS: "qscuio@gmail.com",
}).cloudflareAccess;
assert.deepEqual(accessConfig, {
  enabled: true,
  teamDomain: "example.cloudflareaccess.com",
  audience: ["aud-one", "aud-two"],
  allowedEmails: ["qscuio@gmail.com"],
});

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_CLOUDFLARE_ACCESS: "1" }),
  /DEVSPACE_CLOUDFLARE_ACCESS_TEAM_DOMAIN is required/,
);
