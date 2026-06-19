import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { CloudflareAccessVerifier, normalizeTeamDomain } from "./cloudflare-access.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const kid = "test-key";
const publicJwk = {
  ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
  kid,
  alg: "RS256",
  use: "sig",
};

const config = {
  enabled: true,
  teamDomain: "team.cloudflareaccess.com",
  audience: ["app-aud"],
  allowedEmails: ["qscuio@gmail.com"],
};

const verifier = new CloudflareAccessVerifier(config, async () => ({
  ok: true,
  status: 200,
  async json() {
    return { keys: [publicJwk] };
  },
}));

const now = new Date("2026-06-19T00:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

const identity = await verifier.verify(
  signToken({
    iss: "https://team.cloudflareaccess.com",
    aud: ["app-aud"],
    email: "qscuio@gmail.com",
    sub: "user-subject",
    exp: nowSeconds + 60,
  }),
  now,
);
assert.deepEqual(identity, {
  email: "qscuio@gmail.com",
  subject: "user-subject",
});

await assert.rejects(
  () =>
    verifier.verify(
      signToken({
        iss: "https://team.cloudflareaccess.com",
        aud: ["other-aud"],
        email: "qscuio@gmail.com",
        exp: nowSeconds + 60,
      }),
      now,
    ),
  /invalid Cloudflare Access audience/,
);

await assert.rejects(
  () =>
    verifier.verify(
      signToken({
        iss: "https://team.cloudflareaccess.com",
        aud: ["app-aud"],
        email: "other@example.com",
        exp: nowSeconds + 60,
      }),
      now,
    ),
  /Cloudflare Access email is not allowed/,
);

await assert.rejects(
  () =>
    verifier.verify(
      signToken({
        iss: "https://team.cloudflareaccess.com",
        aud: ["app-aud"],
        email: "qscuio@gmail.com",
        exp: nowSeconds - 1,
      }),
      now,
    ),
  /expired Cloudflare Access token/,
);

assert.equal(normalizeTeamDomain("https://team.cloudflareaccess.com/"), "team.cloudflareaccess.com");
assert.equal(normalizeTeamDomain("team.cloudflareaccess.com"), "team.cloudflareaccess.com");

function signToken(payload: Record<string, unknown>): string {
  const encodedHeader = encodePart({ alg: "RS256", kid, typ: "JWT" });
  const encodedPayload = encodePart(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

function encodePart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
