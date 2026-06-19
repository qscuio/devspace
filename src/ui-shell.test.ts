import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { workspaceAppHtml } from "./server.js";

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: "C:\\tmp\\devspace-ui-shell-test-config",
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_PUBLIC_BASE_URL: "https://devspace.example.test",
});

const html = workspaceAppHtml(config);

assert.match(html, /<style id="devspace-critical-shell">/);
assert.match(html, /Starting DevSpace tool/);
assert.match(html, /class="critical-progress-bar"/);
assert.match(html, /rel="modulepreload"/);
assert.match(html, /rel="preload" as="style"/);
assert.match(html, /rel="stylesheet"/);
assert.match(html, /data-critical-shell/);

const manifest = JSON.parse(
  readFileSync(new URL("../dist/ui/.vite/manifest.json", import.meta.url), "utf8"),
) as Record<string, { file?: string }>;
const entryFile = manifest["workspace-app.html"]?.file;
assert.ok(entryFile);

const entryBundle = readFileSync(new URL(`../dist/ui/${entryFile}`, import.meta.url), "utf8");
assert.equal(entryBundle.includes("@pierre/diffs"), false);
assert.ok(Buffer.byteLength(entryBundle, "utf8") < 380_000);
