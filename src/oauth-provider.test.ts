import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryOAuthClientsStore } from "./oauth-provider.js";

const stateDir = mkdtempSync(join(tmpdir(), "devspace-oauth-client-test-"));
const clientStorePath = join(stateDir, "oauth-clients.json");
const firstStore = new InMemoryOAuthClientsStore(["chatgpt.com"], clientStorePath);

const registered = firstStore.registerClient({
  client_name: "ChatGPT",
  redirect_uris: ["https://chatgpt.com/aip/g-some-id/oauth/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
});

const restartedStore = new InMemoryOAuthClientsStore(["chatgpt.com"], clientStorePath);
assert.deepEqual(restartedStore.getClient(registered.client_id), registered);
