import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, opendir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import Database from "better-sqlite3";

export type QnoteHistorySource = "codex" | "claude" | "cursor" | "chatgpt" | "browser";

export interface QnoteHistoryCandidate {
  id: string;
  source: QnoteHistorySource;
  kind: "session_log" | "chatgpt_export" | "browser_history" | "history_file";
  path: string;
  size: number;
  mtime: string;
  title?: string;
  notes?: string;
}

export interface QnoteHistoryScanInput {
  root?: string;
  sources?: QnoteHistorySource[];
  limit?: number;
}

export interface QnoteHistoryScanResult {
  status: "ok";
  root: string;
  candidates: QnoteHistoryCandidate[];
}

export interface QnoteHistoryReadInput {
  id: string;
  root?: string;
  sources?: QnoteHistorySource[];
  maxBytes?: number;
}

export interface QnoteHistoryReadResult {
  status: "ok";
  candidate: QnoteHistoryCandidate;
  content: string;
  truncated: boolean;
}

export async function scanHistorySources(
  input: QnoteHistoryScanInput = {},
): Promise<QnoteHistoryScanResult> {
  const root = resolve(input.root ?? homedir());
  const sources = input.sources ?? ["codex", "claude", "cursor", "chatgpt", "browser"];
  const limit = input.limit ?? 50;
  const candidates: QnoteHistoryCandidate[] = [];

  for (const source of sources) {
    if (candidates.length >= limit) break;
    const remaining = limit - candidates.length;
    candidates.push(...(await scanSource(root, source, remaining, Boolean(input.root))));
  }

  candidates.sort((left, right) => right.mtime.localeCompare(left.mtime));
  return {
    status: "ok",
    root,
    candidates: candidates.slice(0, limit),
  };
}

export async function readHistorySource(
  input: QnoteHistoryReadInput,
): Promise<QnoteHistoryReadResult> {
  const scan = await scanHistorySources({
    root: input.root,
    sources: input.sources,
    limit: 500,
  });
  const candidate = scan.candidates.find((entry) => entry.id === input.id);
  if (!candidate) {
    throw new Error(`History source not found: ${input.id}`);
  }

  if (candidate.kind === "browser_history") {
    const content = await readBrowserHistory(candidate.path, input.maxBytes ?? 128 * 1024);
    return {
      status: "ok",
      candidate,
      content,
      truncated: false,
    };
  }

  const maxBytes = input.maxBytes ?? 128 * 1024;
  const content = await readFile(candidate.path, "utf8");
  return {
    status: "ok",
    candidate,
    content: content.length > maxBytes ? content.slice(0, maxBytes) : content,
    truncated: content.length > maxBytes,
  };
}

async function scanSource(
  root: string,
  source: QnoteHistorySource,
  limit: number,
  explicitRoot: boolean,
): Promise<QnoteHistoryCandidate[]> {
  switch (source) {
    case "codex":
      return candidatesFromFiles(source, "session_log", await collectKnownFiles(root, [
        [".codex", "memories", "rollout_summaries"],
        [".codex", "sessions"],
      ], [".jsonl", ".md", ".json"], limit));
    case "claude":
      return candidatesFromFiles(source, "session_log", await collectKnownFiles(root, [
        [".claude", "projects"],
        [".claude"],
      ], [".jsonl", ".md", ".txt"], limit));
    case "cursor":
      return candidatesFromFiles(source, "session_log", await collectKnownFiles(root, [
        [".cursor"],
        ["AppData", "Roaming", "Cursor", "User", "workspaceStorage"],
        [".config", "Cursor", "User", "workspaceStorage"],
      ], [".json", ".jsonl", ".md", ".txt", ".sqlite", ".db"], limit));
    case "chatgpt":
      return chatgptExportCandidates(root, explicitRoot, limit);
    case "browser":
      return browserHistoryCandidates(root, explicitRoot, limit);
  }
}

async function collectKnownFiles(
  root: string,
  pathSegments: string[][],
  extensions: string[],
  limit: number,
): Promise<string[]> {
  const files: string[] = [];
  for (const segments of pathSegments) {
    if (files.length >= limit) break;
    const dir = join(root, ...segments);
    if (!existsSync(dir)) continue;
    files.push(...(await collectFiles(dir, extensions, limit - files.length)));
  }
  return files;
}

async function collectFiles(
  root: string,
  extensions: string[],
  limit: number,
  maxDepth = 6,
): Promise<string[]> {
  const files: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop()!;
    if (current.depth > maxDepth) continue;
    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      if (files.length >= limit) break;
      if ([".git", "node_modules", "Cache", "Code Cache"].includes(entry.name)) continue;
      const filePath = join(current.path, entry.name);
      if (entry.isDirectory()) {
        stack.push({ path: filePath, depth: current.depth + 1 });
      } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
        files.push(filePath);
      }
    }
  }
  return files;
}

async function candidatesFromFiles(
  source: QnoteHistorySource,
  kind: QnoteHistoryCandidate["kind"],
  files: string[],
): Promise<QnoteHistoryCandidate[]> {
  return Promise.all(files.map((filePath) => candidateFromFile(source, kind, filePath)));
}

async function candidateFromFile(
  source: QnoteHistorySource,
  kind: QnoteHistoryCandidate["kind"],
  filePath: string,
  notes?: string,
): Promise<QnoteHistoryCandidate> {
  const metadata = await stat(filePath);
  return {
    id: stableId(source, filePath),
    source,
    kind,
    path: filePath,
    size: metadata.size,
    mtime: metadata.mtime.toISOString(),
    title: await inferTitle(filePath, kind),
    notes,
  };
}

async function chatgptExportCandidates(
  root: string,
  explicitRoot: boolean,
  limit: number,
): Promise<QnoteHistoryCandidate[]> {
  const files = explicitRoot
    ? await findNamedFiles(root, "conversations.json", limit)
    : [join(root, "Downloads", "conversations.json"), join(root, "chatgpt-export", "conversations.json")].filter(existsSync);

  return Promise.all(files.map((filePath) => candidateFromFile(
    "chatgpt",
    "chatgpt_export",
    filePath,
    "Full ChatGPT content is most reliable from the official export conversations.json.",
  )));
}

async function browserHistoryCandidates(
  root: string,
  explicitRoot: boolean,
  limit: number,
): Promise<QnoteHistoryCandidate[]> {
  const known = [
    ["AppData", "Local", "Google", "Chrome", "User Data", "Default", "History"],
    ["AppData", "Local", "Microsoft", "Edge", "User Data", "Default", "History"],
    [".config", "google-chrome", "Default", "History"],
    [".config", "microsoft-edge", "Default", "History"],
    ["Library", "Application Support", "Google", "Chrome", "Default", "History"],
  ].map((segments) => join(root, ...segments)).filter(existsSync);
  const firefox = await collectKnownFiles(root, [
    ["AppData", "Roaming", "Mozilla", "Firefox", "Profiles"],
    [".mozilla", "firefox"],
    ["Library", "Application Support", "Firefox", "Profiles"],
  ], ["places.sqlite"], limit);
  const recursive = explicitRoot ? await findBrowserHistoryFiles(root, limit) : [];
  const files = Array.from(new Set([...known, ...firefox, ...recursive])).slice(0, limit);

  return Promise.all(files.map((filePath) => candidateFromFile(
    "browser",
    "browser_history",
    filePath,
    "Browser history is metadata-only: URL, title, and visit times. Full chat content usually requires official exports or app logs.",
  )));
}

async function findNamedFiles(root: string, name: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop()!;
    if (current.depth > 5) continue;
    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      if (files.length >= limit) break;
      if ([".git", "node_modules", "Cache", "Code Cache"].includes(entry.name)) continue;
      const filePath = join(current.path, entry.name);
      if (entry.isDirectory()) {
        stack.push({ path: filePath, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name === name) {
        files.push(filePath);
      }
    }
  }
  return files;
}

async function findBrowserHistoryFiles(root: string, limit: number): Promise<string[]> {
  const names = new Set(["History", "places.sqlite"]);
  const files: string[] = [];
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop()!;
    if (current.depth > 5) continue;
    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      if (files.length >= limit) break;
      if ([".git", "node_modules", "Cache", "Code Cache"].includes(entry.name)) continue;
      const filePath = join(current.path, entry.name);
      if (entry.isDirectory()) {
        stack.push({ path: filePath, depth: current.depth + 1 });
      } else if (entry.isFile() && names.has(entry.name)) {
        files.push(filePath);
      }
    }
  }
  return files;
}

async function inferTitle(filePath: string, kind: QnoteHistoryCandidate["kind"]): Promise<string | undefined> {
  if (kind === "chatgpt_export") {
    try {
      const parsed = JSON.parse((await readFile(filePath, "utf8")).slice(0, 1024 * 1024)) as unknown;
      if (Array.isArray(parsed) && typeof parsed[0]?.title === "string") return parsed[0].title;
    } catch {
      return basename(filePath);
    }
  }

  return basename(filePath);
}

async function readBrowserHistory(filePath: string, maxBytes: number): Promise<string> {
  const tempPath = join(tmpdir(), `devspace-browser-history-${randomUUID()}.sqlite`);
  await mkdir(dirname(tempPath), { recursive: true });
  await copyFile(filePath, tempPath);

  try {
    const db = new Database(tempPath, { readonly: true, fileMustExist: true });
    try {
      const rows = browserRows(db);
      const content = rows
        .filter((row) => isRelevantBrowserUrl(row.url))
        .map((row) => `${row.lastVisitTime ?? ""}\t${row.title ?? ""}\t${row.url}`)
        .join("\n");
      const output = content || rows.map((row) => `${row.lastVisitTime ?? ""}\t${row.title ?? ""}\t${row.url}`).join("\n");
      return output.length > maxBytes ? output.slice(0, maxBytes) : output;
    } finally {
      db.close();
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

function browserRows(db: Database.Database): Array<{ url: string; title?: string; lastVisitTime?: number }> {
  const tables = db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;
  if (tables.some((table) => table.name === "urls")) {
    return db.prepare("select url, title, last_visit_time as lastVisitTime from urls order by last_visit_time desc limit 200")
      .all() as Array<{ url: string; title?: string; lastVisitTime?: number }>;
  }
  if (tables.some((table) => table.name === "moz_places")) {
    return db.prepare("select url, title, last_visit_date as lastVisitTime from moz_places order by last_visit_date desc limit 200")
      .all() as Array<{ url: string; title?: string; lastVisitTime?: number }>;
  }
  return [];
}

function isRelevantBrowserUrl(url: string): boolean {
  return /chatgpt\.com|chat\.openai\.com|claude\.ai|cursor\.com|notebooklm\.google\.com/.test(url);
}

function stableId(source: QnoteHistorySource, filePath: string): string {
  return createHash("sha256").update(`${source}:${resolve(filePath)}`).digest("base64url").slice(0, 24);
}

export function formatHistoryPath(root: string, filePath: string): string {
  const relationship = relative(root, filePath);
  return relationship && !relationship.startsWith("..")
    ? relationship.split(sep).join("/")
    : filePath;
}
