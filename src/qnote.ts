import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, opendir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { QnoteConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface QnoteStatus {
  status: "ok" | "missing";
  exists: boolean;
  clean?: boolean;
  branch?: string;
  head?: string;
  dir: string;
}

export interface QnoteSearchInput {
  query: string;
  limit?: number;
}

export interface QnoteSearchResult {
  status: "ok";
  matches: Array<{
    path: string;
    title?: string;
    preview: string;
  }>;
}

export interface QnoteReadInput {
  path: string;
  maxBytes?: number;
}

export interface QnoteReadResult {
  status: "ok";
  path: string;
  content: string;
  truncated: boolean;
}

export interface QnoteCaptureInput {
  destination: string;
  title: string;
  body: string;
  tags?: string[];
  sourceId?: string;
  sync?: boolean;
  push?: boolean;
}

export type QnoteCaptureResult =
  | {
      status: "ok";
      path: string;
      commit: string;
      pushed: boolean;
      contentHash: string;
    }
  | {
      status: "duplicate";
      duplicatePath: string;
      contentHash: string;
    };

export interface QnoteSyncResult {
  status: "ok";
  action: "cloned" | "pulled" | "already_present";
  dir: string;
}

export interface QnoteStore {
  status(): Promise<QnoteStatus>;
  sync(): Promise<QnoteSyncResult>;
  search(input: QnoteSearchInput): Promise<QnoteSearchResult>;
  read(input: QnoteReadInput): Promise<QnoteReadResult>;
  capture(input: QnoteCaptureInput): Promise<QnoteCaptureResult>;
}

export function createQnoteStore(config: QnoteConfig): QnoteStore {
  return new FileQnoteStore(config);
}

class FileQnoteStore implements QnoteStore {
  constructor(private readonly config: QnoteConfig) {}

  async status(): Promise<QnoteStatus> {
    if (!existsSync(this.config.dir)) {
      return { status: "missing", exists: false, dir: this.config.dir };
    }

    const branch = await this.git(["branch", "--show-current"]).catch(() => "");
    const head = await this.git(["rev-parse", "--short", "HEAD"]).catch(() => "");
    const clean = (await this.git(["status", "--porcelain"]).catch(() => "")).trim() === "";
    return {
      status: "ok",
      exists: true,
      clean,
      branch: branch.trim() || undefined,
      head: head.trim() || undefined,
      dir: this.config.dir,
    };
  }

  async sync(): Promise<QnoteSyncResult> {
    if (!existsSync(this.config.dir)) {
      if (!this.config.repoUrl) {
        throw new Error("qnote repository is missing and repoUrl is empty.");
      }
      await mkdir(dirname(this.config.dir), { recursive: true });
      await execFileAsync("git", [
        "clone",
        "--branch",
        this.config.branch,
        this.config.repoUrl,
        this.config.dir,
      ]);
      return { status: "ok", action: "cloned", dir: this.config.dir };
    }

    await this.assertClean();
    if (await this.hasRemote()) {
      await this.git(["pull", "--ff-only"]);
      return { status: "ok", action: "pulled", dir: this.config.dir };
    }

    return { status: "ok", action: "already_present", dir: this.config.dir };
  }

  async search(input: QnoteSearchInput): Promise<QnoteSearchResult> {
    await this.ensureRepoAvailable();
    const query = input.query.toLowerCase();
    const matches: QnoteSearchResult["matches"] = [];
    const limit = input.limit ?? 20;

    for await (const filePath of walkMarkdown(this.config.dir)) {
      const content = await readFile(filePath, "utf8");
      const index = content.toLowerCase().indexOf(query);
      if (index === -1) continue;
      matches.push({
        path: toRepoPath(this.config.dir, filePath),
        title: firstMarkdownTitle(content),
        preview: previewAround(content, index),
      });
      if (matches.length >= limit) break;
    }

    return { status: "ok", matches };
  }

  async read(input: QnoteReadInput): Promise<QnoteReadResult> {
    await this.ensureRepoAvailable();
    const absolutePath = this.resolveRepoPath(input.path, false);
    const maxBytes = input.maxBytes ?? 128 * 1024;
    const content = await readFile(absolutePath, "utf8");
    return {
      status: "ok",
      path: toRepoPath(this.config.dir, absolutePath),
      content: content.length > maxBytes ? content.slice(0, maxBytes) : content,
      truncated: content.length > maxBytes,
    };
  }

  async capture(input: QnoteCaptureInput): Promise<QnoteCaptureResult> {
    await this.assertRepoExists();
    const destination = this.resolveRepoPath(input.destination, true);
    const repoPath = toRepoPath(this.config.dir, destination);
    this.assertAllowedDestination(repoPath);
    await this.assertClean();

    if (input.sync !== false) {
      await this.sync();
      await this.assertClean();
    }

    const contentHash = sha256(input.body);
    const duplicatePath = await this.findContentHash(contentHash);
    if (duplicatePath) {
      return {
        status: "duplicate",
        duplicatePath,
        contentHash,
      };
    }

    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, renderCapture(input, contentHash), "utf8");
    await this.git(["add", repoPath]);
    await this.git(["commit", "-m", `qnote: capture ${basename(repoPath, ".md")}`]);
    const commit = await this.git(["rev-parse", "--short", "HEAD"]);
    const shouldPush = input.push ?? this.config.autoPush;
    if (shouldPush) await this.git(["push", "origin", this.config.branch]);

    return {
      status: "ok",
      path: repoPath,
      commit: commit.trim(),
      pushed: shouldPush,
      contentHash,
    };
  }

  private async assertRepoExists(): Promise<void> {
    if (!existsSync(this.config.dir)) {
      throw new Error(`qnote repository does not exist: ${this.config.dir}`);
    }
    await this.git(["rev-parse", "--is-inside-work-tree"]);
  }

  private async ensureRepoAvailable(): Promise<void> {
    if (!existsSync(this.config.dir)) {
      await this.sync();
      return;
    }

    await this.assertRepoExists();
  }

  private async assertClean(): Promise<void> {
    const dirty = (await this.git(["status", "--porcelain"])).trim();
    if (dirty) {
      throw new Error("qnote checkout is dirty; refusing to write until it is clean.");
    }
  }

  private async hasRemote(): Promise<boolean> {
    const remotes = (await this.git(["remote"]).catch(() => "")).trim();
    return remotes.length > 0;
  }

  private resolveRepoPath(inputPath: string, forWrite: boolean): string {
    if (!inputPath || isAbsolute(inputPath)) {
      throw new Error(`qnote path is outside qnote repository: ${inputPath}`);
    }
    const absolutePath = resolve(this.config.dir, inputPath);
    const relationship = relative(this.config.dir, absolutePath);
    if (
      relationship === "" ||
      relationship.startsWith("..") ||
      relationship === ".." ||
      relationship.includes(`..${sep}`)
    ) {
      throw new Error(`qnote path is outside qnote repository: ${inputPath}`);
    }
    if (forWrite && !absolutePath.endsWith(".md")) {
      throw new Error("qnote capture destination must be a Markdown file.");
    }
    return absolutePath;
  }

  private assertAllowedDestination(repoPath: string): void {
    const firstSegment = repoPath.split("/")[0] ?? "";
    if (!this.config.allowedDirs.includes(firstSegment)) {
      throw new Error(`qnote destination is not in an allowed qnote directory: ${repoPath}`);
    }
  }

  private async findContentHash(contentHash: string): Promise<string | undefined> {
    const needle = `content_hash: ${contentHash}`;
    for await (const filePath of walkMarkdown(this.config.dir)) {
      const content = await readFile(filePath, "utf8");
      if (content.includes(needle)) return toRepoPath(this.config.dir, filePath);
    }
    return undefined;
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.config.dir,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  }
}

async function* walkMarkdown(root: string): AsyncGenerator<string> {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const directory = await opendir(current);
    for await (const entry of directory) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        yield absolutePath;
      }
    }
  }
}

function toRepoPath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

function firstMarkdownTitle(content: string): string | undefined {
  return content.split(/\r?\n/).find((line) => line.startsWith("# "))?.slice(2).trim();
}

function previewAround(content: string, index: number): string {
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + 160);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function renderCapture(input: QnoteCaptureInput, contentHash: string): string {
  const tags = input.tags ?? [];
  const frontmatter = [
    "---",
    `title: ${yamlScalar(input.title)}`,
    input.sourceId ? `source_id: ${yamlScalar(input.sourceId)}` : undefined,
    `content_hash: ${contentHash}`,
    `captured_at: ${new Date().toISOString()}`,
    `tags: [${tags.map(yamlScalar).join(", ")}]`,
    "---",
    "",
  ].filter((line): line is string => line !== undefined);

  return `${frontmatter.join("\n")}${input.body.trim()}\n`;
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}
