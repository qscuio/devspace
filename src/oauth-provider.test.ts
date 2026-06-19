import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Response } from "express";
import {
  InMemoryOAuthClientsStore,
  SingleUserOAuthProvider,
} from "./oauth-provider.js";

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

writeFileSync(clientStorePath, `\uFEFF${readFileSync(clientStorePath, "utf8")}`);
const restartedStore = new InMemoryOAuthClientsStore(["chatgpt.com"], clientStorePath);
assert.deepEqual(restartedStore.getClient(registered.client_id), registered);

const tokenStorePath = join(stateDir, "oauth-tokens.json");
const providerConfig = {
  ownerToken: "test-owner-token-that-is-long-enough",
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  scopes: ["devspace"],
  allowedRedirectHosts: ["chatgpt.com"],
};
const providerUrl = new URL("https://devspace.example.test/mcp");
const firstProvider = new SingleUserOAuthProvider(
  providerConfig,
  providerUrl,
  clientStorePath,
  tokenStorePath,
);
const client = await firstProvider.clientsStore.getClient(registered.client_id);
assert.ok(client);

const authParams = {
  redirectUri: "https://chatgpt.com/aip/g-some-id/oauth/callback",
  codeChallenge: "challenge",
  scopes: ["devspace"],
  state: "state",
  resource: providerUrl,
};
const redirectUrl = await authorizeWithOwnerToken(firstProvider, client, authParams);
const issuedCode = redirectUrl.searchParams.get("code");
assert.ok(issuedCode);
const issuedTokens = await firstProvider.exchangeAuthorizationCode(
  client,
  issuedCode,
  undefined,
  authParams.redirectUri,
  providerUrl,
);
assert.ok(issuedTokens.refresh_token);

writeFileSync(tokenStorePath, `\uFEFF${readFileSync(tokenStorePath, "utf8")}`);
const restartedProvider = new SingleUserOAuthProvider(
  providerConfig,
  providerUrl,
  clientStorePath,
  tokenStorePath,
);
const restartedClient = await restartedProvider.clientsStore.getClient(registered.client_id);
assert.ok(restartedClient);
const refreshedTokens = await restartedProvider.exchangeRefreshToken(
  restartedClient,
  issuedTokens.refresh_token,
  ["devspace"],
  providerUrl,
);
assert.ok(refreshedTokens.access_token);
assert.ok(refreshedTokens.refresh_token);
const retriedRefreshTokens = await restartedProvider.exchangeRefreshToken(
  restartedClient,
  issuedTokens.refresh_token,
  ["devspace"],
  providerUrl,
);
assert.ok(retriedRefreshTokens.access_token);
assert.ok(retriedRefreshTokens.refresh_token);

async function authorizeWithOwnerToken(
  provider: SingleUserOAuthProvider,
  client: typeof registered,
  params: typeof authParams,
): Promise<URL> {
  let location: string | undefined;
  const response = {
    req: {
      method: "POST",
      body: {
        owner_token: providerConfig.ownerToken,
      },
    },
    redirect(status: number, url: string) {
      assert.equal(status, 302);
      location = url;
    },
  } as unknown as Response;

  await provider.authorize(client, params, response);
  assert.ok(location);
  return new URL(location);
}
