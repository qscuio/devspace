import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNotebookLmAuthRefreshManager,
  NotebookLmAuthRefreshError,
} from "./notebooklm-auth-refresh.js";

const validState = {
  cookies: [
    {
      name: "SID",
      value: "secret",
      domain: ".google.com",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [
    {
      origin: "https://notebooklm.google.com",
      localStorage: [],
    },
  ],
};

const stateDir = mkdtempSync(join(tmpdir(), "devspace-notebooklm-auth-refresh-test-"));
const statePath = join(stateDir, "browser_state", "state.json");
const manager = createNotebookLmAuthRefreshManager({
  statePath,
  tokenTtlMs: 60_000,
  now: () => new Date("2026-06-20T00:00:00.000Z"),
});

const uploadToken = manager.createUploadToken();
assert.match(uploadToken.token, /^[A-Za-z0-9_-]{32,}$/);
assert.equal(uploadToken.expiresAt, "2026-06-20T00:01:00.000Z");

const upload = await manager.uploadState({
  token: uploadToken.token,
  body: validState,
});
assert.equal(upload.cookies, 1);
assert.equal(upload.origins, 1);
assert.equal(upload.path, statePath);
assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), validState);
if (process.platform !== "win32") {
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
} else {
  assert.ok(statSync(statePath).isFile());
}

await assert.rejects(
  manager.uploadState({
    token: uploadToken.token,
    body: validState,
  }),
  (error) =>
    error instanceof NotebookLmAuthRefreshError &&
    error.status === 410 &&
    error.code === "used_token",
);

const invalidToken = manager.createUploadToken();
await assert.rejects(
  manager.uploadState({
    token: invalidToken.token,
    body: { cookies: "not-an-array", origins: [] },
  }),
  (error) =>
    error instanceof NotebookLmAuthRefreshError &&
    error.status === 400 &&
    error.code === "invalid_state",
);

const expiredManager = createNotebookLmAuthRefreshManager({
  statePath: join(stateDir, "expired", "state.json"),
  tokenTtlMs: 1,
  now: () => new Date("2026-06-20T00:00:00.000Z"),
});
const expiredToken = expiredManager.createUploadToken();
expiredManager.setClock(() => new Date("2026-06-20T00:00:01.000Z"));
await assert.rejects(
  expiredManager.uploadState({
    token: expiredToken.token,
    body: validState,
  }),
  (error) =>
    error instanceof NotebookLmAuthRefreshError &&
    error.status === 410 &&
    error.code === "expired_token",
);
