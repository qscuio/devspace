import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type NotebookLmAuthRefreshErrorCode =
  | "invalid_token"
  | "expired_token"
  | "used_token"
  | "invalid_state";

export class NotebookLmAuthRefreshError extends Error {
  constructor(
    readonly status: number,
    readonly code: NotebookLmAuthRefreshErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NotebookLmAuthRefreshError";
  }
}

export interface NotebookLmAuthRefreshManagerOptions {
  statePath: string;
  tokenTtlMs?: number;
  now?: () => Date;
}

export interface NotebookLmAuthRefreshUploadToken {
  token: string;
  expiresAt: string;
}

export interface NotebookLmAuthRefreshUploadResult {
  cookies: number;
  origins: number;
  path: string;
}

interface UploadTokenRecord {
  expiresAtMs: number;
  used: boolean;
}

export class NotebookLmAuthRefreshManager {
  private readonly tokens = new Map<string, UploadTokenRecord>();
  private now: () => Date;

  constructor(private readonly options: Required<NotebookLmAuthRefreshManagerOptions>) {
    this.now = options.now;
  }

  setClock(now: () => Date): void {
    this.now = now;
  }

  createUploadToken(): NotebookLmAuthRefreshUploadToken {
    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now().getTime() + this.options.tokenTtlMs;
    this.tokens.set(token, { expiresAtMs, used: false });
    return {
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async uploadState(input: {
    token: string;
    body: unknown;
  }): Promise<NotebookLmAuthRefreshUploadResult> {
    const record = this.tokens.get(input.token);
    if (!record) {
      throw new NotebookLmAuthRefreshError(401, "invalid_token", "Invalid NotebookLM auth refresh token.");
    }
    if (record.used) {
      throw new NotebookLmAuthRefreshError(410, "used_token", "NotebookLM auth refresh token was already used.");
    }
    if (record.expiresAtMs <= this.now().getTime()) {
      this.tokens.delete(input.token);
      throw new NotebookLmAuthRefreshError(410, "expired_token", "NotebookLM auth refresh token expired.");
    }

    const state = validateBrowserState(input.body);
    await writeBrowserState(this.options.statePath, state);
    record.used = true;

    return {
      cookies: state.cookies.length,
      origins: state.origins.length,
      path: this.options.statePath,
    };
  }
}

export function createNotebookLmAuthRefreshManager(
  options: NotebookLmAuthRefreshManagerOptions,
): NotebookLmAuthRefreshManager {
  return new NotebookLmAuthRefreshManager({
    statePath: options.statePath,
    tokenTtlMs: options.tokenTtlMs ?? 10 * 60_000,
    now: options.now ?? (() => new Date()),
  });
}

function validateBrowserState(body: unknown): {
  cookies: unknown[];
  origins: unknown[];
  [key: string]: unknown;
} {
  if (!isRecord(body) || !Array.isArray(body.cookies) || !Array.isArray(body.origins)) {
    throw new NotebookLmAuthRefreshError(
      400,
      "invalid_state",
      "NotebookLM browser state must be a storage_state JSON object with cookies and origins arrays.",
    );
  }
  return body as {
    cookies: unknown[];
    origins: unknown[];
    [key: string]: unknown;
  };
}

async function writeBrowserState(statePath: string, state: unknown): Promise<void> {
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, statePath);
  await chmod(statePath, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
