import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig({
  DEVSPACE_CONFIG_DIR: "C:\\tmp\\devspace-server-test-config",
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  DEVSPACE_TRUST_PROXY: "1",
});

const { app } = createServer(config);
assert.equal(app.get("trust proxy"), 1);
