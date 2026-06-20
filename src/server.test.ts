import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { createNotebookLmAuthRefreshManager } from "./notebooklm-auth-refresh.js";
import { createServer } from "./server.js";

type ViteManifestEntry = {
  file?: string;
};

const testRoot = mkdtempSync(join(tmpdir(), "devspace-server-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(testRoot, "config"),
  DEVSPACE_STATE_DIR: join(testRoot, "state"),
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_TRUST_PROXY: "1",
});

const authRefreshStatePath = join(testRoot, "notebooklm-state", "state.json");
const authRefreshManager = createNotebookLmAuthRefreshManager({
  statePath: authRefreshStatePath,
  tokenTtlMs: 60_000,
  now: () => new Date("2026-06-20T00:00:00.000Z"),
});

const { app } = createServer(config, { notebookLmAuthRefreshManager: authRefreshManager });
assert.equal(app.get("trust proxy"), 1);

const manifest = JSON.parse(
  readFileSync(new URL("../dist/ui/.vite/manifest.json", import.meta.url), "utf8"),
) as Record<string, ViteManifestEntry>;
const appEntry = manifest["workspace-app.html"];
assert.ok(appEntry?.file, "workspace app manifest entry should include a JS file");

const httpServer = createHttpServer(app);
await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));

try {
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  const { port } = address as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const legacyAssetResponse = await fetch(`${baseUrl}/${appEntry.file}`);
  assert.equal(legacyAssetResponse.status, 200);
  assert.match(
    legacyAssetResponse.headers.get("access-control-allow-origin") ?? "",
    /\*/,
  );

  const openidDiscoveryResponse = await fetch(`${baseUrl}/.well-known/openid-configuration`);
  assert.equal(openidDiscoveryResponse.status, 200);
  const openidDiscovery = await openidDiscoveryResponse.json() as {
    issuer?: string;
    authorization_endpoint?: string;
    token_endpoint?: string;
  };
  assert.equal(openidDiscovery.issuer, `${config.publicBaseUrl}/`);
  assert.equal(openidDiscovery.authorization_endpoint, `${config.publicBaseUrl}/authorize`);
  assert.equal(openidDiscovery.token_endpoint, `${config.publicBaseUrl}/token`);

  const uploadToken = authRefreshManager.createUploadToken();
  const uploadResponse = await fetch(`${baseUrl}/notebooklm/auth-refresh/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: uploadToken.token,
      state: {
        cookies: [{ name: "SID", value: "secret", domain: ".google.com", path: "/" }],
        origins: [{ origin: "https://notebooklm.google.com", localStorage: [] }],
      },
    }),
  });
  assert.equal(uploadResponse.status, 200);
  assert.deepEqual(await uploadResponse.json(), {
    ok: true,
    cookies: 1,
    origins: 1,
  });
  assert.equal(JSON.parse(readFileSync(authRefreshStatePath, "utf8")).cookies.length, 1);
} finally {
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
}
