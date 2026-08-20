import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { LoggingConfig } from "./logger.js";
import { logEvent, requestIp, requestPath } from "./logger.js";

export interface CloudflareAccessConfig {
  enabled: boolean;
  teamDomain?: string;
  audience: string[];
  allowedEmails: string[];
}

export interface VerifiedCloudflareAccessIdentity {
  email?: string;
  subject?: string;
}

type VerifiedCloudflareAccessConfig = Omit<CloudflareAccessConfig, "teamDomain"> & {
  teamDomain: string;
};

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iat?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
}

interface AccessJwk extends JsonWebKey {
  kid?: string;
}

interface JwksResponse {
  keys?: AccessJwk[];
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchImpl = (url: string) => Promise<FetchResponse>;

export class CloudflareAccessVerifier {
  private keys = new Map<string, KeyObject>();
  private keysExpiresAt = 0;

  constructor(
    private readonly config: VerifiedCloudflareAccessConfig,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  async verify(token: string, now = new Date()): Promise<VerifiedCloudflareAccessIdentity> {
    const { header, payload, signingInput, signature } = parseJwt(token);
    if (header.alg !== "RS256" || !header.kid) {
      throw new Error("unsupported Cloudflare Access token");
    }

    let key = await this.getKey(header.kid);
    if (!key) {
      await this.refreshKeys();
      key = this.keys.get(header.kid);
    }
    if (!key) {
      throw new Error("unknown Cloudflare Access signing key");
    }

    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    if (!verifier.verify(key, signature)) {
      throw new Error("invalid Cloudflare Access token signature");
    }

    validatePayload(payload, this.config, now);
    return { email: payload.email, subject: payload.sub };
  }

  private async getKey(kid: string): Promise<KeyObject | undefined> {
    if (Date.now() >= this.keysExpiresAt) {
      await this.refreshKeys();
    }
    return this.keys.get(kid);
  }

  private async refreshKeys(): Promise<void> {
    const response = await this.fetchImpl(`https://${this.config.teamDomain}/cdn-cgi/access/certs`);
    if (!response.ok) {
      throw new Error(`unable to fetch Cloudflare Access certs: HTTP ${response.status}`);
    }

    const body = response.json ? ((await response.json()) as JwksResponse) : {};
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid) continue;
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
    if (keys.size === 0) {
      throw new Error("Cloudflare Access certs response contained no signing keys");
    }

    this.keys = keys;
    this.keysExpiresAt = Date.now() + 60 * 60 * 1000;
  }
}

export function createCloudflareAccessMiddleware(
  config: CloudflareAccessConfig,
  logging: LoggingConfig,
): (req: Request, res: Response, next: NextFunction) => void {
  if (!config.enabled) {
    return (_req, _res, next) => next();
  }
  if (!config.teamDomain || config.audience.length === 0) {
    throw new Error("Cloudflare Access is enabled but teamDomain or audience is missing.");
  }

  const verifier = new CloudflareAccessVerifier({
    ...config,
    teamDomain: normalizeTeamDomain(config.teamDomain),
  });

  return (req, res, next) => {
    void verifier
      .verify(req.header("cf-access-jwt-assertion") ?? "")
      .then((identity) => {
        res.locals.cloudflareAccess = identity;
        next();
      })
      .catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        logEvent(logging, "warn", "cloudflare_access_denied", {
          method: req.method,
          path: requestPath(req),
          ip: requestIp(req, logging.trustProxy),
          host: req.header("host"),
          reason,
        });
        res.status(403).json({ error: "cloudflare_access_required" });
      });
  };
}

export function normalizeTeamDomain(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return new URL(trimmed).hostname;
  }
  return trimmed;
}

function parseJwt(token: string): {
  header: JwtHeader;
  payload: JwtPayload;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("missing Cloudflare Access token");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  return {
    header: parseJsonPart<JwtHeader>(encodedHeader, "header"),
    payload: parseJsonPart<JwtPayload>(encodedPayload, "payload"),
    signingInput: `${encodedHeader}.${encodedPayload}`,
    signature: Buffer.from(encodedSignature, "base64url"),
  };
}

function parseJsonPart<T>(value: string, name: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    throw new Error(`invalid Cloudflare Access token ${name}`);
  }
}

function validatePayload(
  payload: JwtPayload,
  config: VerifiedCloudflareAccessConfig,
  now: Date,
): void {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!payload.exp || payload.exp <= nowSeconds) {
    throw new Error("expired Cloudflare Access token");
  }
  if (payload.nbf && payload.nbf > nowSeconds) {
    throw new Error("Cloudflare Access token is not valid yet");
  }

  const expectedIssuer = `https://${config.teamDomain}`;
  if (payload.iss !== expectedIssuer && payload.iss !== `${expectedIssuer}/`) {
    throw new Error("invalid Cloudflare Access issuer");
  }

  const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!config.audience.some((audience) => tokenAudiences.includes(audience))) {
    throw new Error("invalid Cloudflare Access audience");
  }

  if (config.allowedEmails.length > 0) {
    const email = payload.email?.toLowerCase();
    const allowedEmails = config.allowedEmails.map((allowedEmail) => allowedEmail.toLowerCase());
    if (!email || !allowedEmails.includes(email)) {
      throw new Error("Cloudflare Access email is not allowed");
    }
  }
}
