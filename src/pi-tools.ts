import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveAllowedPath } from "./roots.js";
import { getShellConfig } from "./shell-config.js";

const execFileAsync = promisify(execFile);

type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResponse<TDetails = unknown> = {
  content: McpContent[];
  details?: TDetails;
  isError?: boolean;
};

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteToolInput {
  path: string;
  content: string;
}

export interface EditToolInput {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

export interface EditToolDetails {
  patch?: string;
  diff?: string;
}

export interface GrepToolInput {
  pattern: string;
  path?: string;
  include?: string;
}

export interface FindToolInput {
  pattern: string;
  path?: string;
}

export interface LsToolInput {
  path: string;
}

export interface BashToolInput {
  command: string;
  timeout?: number;
}

interface ToolContext {
  cwd: string;
  root: string;
  readRoots?: string[];
}

export async function readFileTool(input: ReadToolInput, context: ToolContext): Promise<ToolResponse> {
  try {
    const path = resolveAllowedPath(input.path, context.cwd, context.readRoots ?? [context.root]);
    const content = await readFile(path, "utf8");
    const lines = content.split(/\r?\n/);
    const offset = Math.max(input.offset ?? 0, 0);
    const limit = input.limit && input.limit > 0 ? input.limit : lines.length;
    const selected = lines.slice(offset, offset + limit).join("\n");

    return { content: [textBlock(selected)] };
  } catch (error) {
    return errorResponse<EditToolDetails>(error);
  }
}

export async function writeFileTool(input: WriteToolInput, context: ToolContext): Promise<ToolResponse> {
  try {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
    await writeFile(path, input.content, "utf8");
    return { content: [textBlock(`Wrote ${formatPath(path, context.root)}`)] };
  } catch (error) {
    return errorResponse(error);
  }
}

export async function editFileTool(input: EditToolInput, context: ToolContext): Promise<ToolResponse<EditToolDetails>> {
  try {
    const path = resolveAllowedPath(input.path, context.cwd, [context.root]);
    let content = await readFile(path, "utf8");
    for (const edit of input.edits) {
      if (!content.includes(edit.oldText)) {
        return { content: [textBlock(`Text not found in ${formatPath(path, context.root)}`)], isError: true };
      }
      content = content.replace(edit.oldText, edit.newText);
    }
    await writeFile(path, content, "utf8");
    return { content: [textBlock(`Edited ${formatPath(path, context.root)}`)], details: {} };
  } catch (error) {
    return errorResponse(error);
  }
}

export async function grepFilesTool(input: GrepToolInput, context: ToolContext): Promise<ToolResponse> {
  try {
    const root = input.path ? resolveAllowedPath(input.path, context.cwd, [context.root]) : context.root;
    const files = await walkFiles(root);
    const matches: string[] = [];
    const regex = new RegExp(input.pattern);

    for (const file of files) {
      if (input.include && !globMatch(relative(context.root, file), input.include)) continue;
      let content;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (regex.test(line)) matches.push(`${formatPath(file, context.root)}:${index + 1}:${line}`);
      });
    }

    return { content: [textBlock(matches.join("\n"))] };
  } catch (error) {
    return errorResponse(error);
  }
}

export async function findFilesTool(input: FindToolInput, context: ToolContext): Promise<ToolResponse> {
  try {
    const root = input.path ? resolveAllowedPath(input.path, context.cwd, [context.root]) : context.root;
    const files = await walkFiles(root);
    const matches = files
      .map((file) => formatPath(file, context.root))
      .filter((path) => globMatch(path, input.pattern));

    return { content: [textBlock(matches.join("\n"))] };
  } catch (error) {
    return errorResponse(error);
  }
}

export async function listDirectoryTool(input: LsToolInput, context: ToolContext): Promise<ToolResponse> {
  try {
    const path = input.path ? resolveAllowedPath(input.path, context.cwd, [context.root]) : context.root;
    const entries = await readdir(path, { withFileTypes: true });
    const output = entries
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
      .sort()
      .join("\n");

    return { content: [textBlock(output)] };
  } catch (error) {
    return errorResponse(error);
  }
}

export async function runShellTool(input: BashToolInput, context: ToolContext): Promise<ToolResponse> {
  try {
    const shell = getShellConfig();
    const timeout = Math.min((input.timeout ?? 30) * 1000, 300_000);
    const { stdout, stderr } = await execFileAsync(shell.shell, [...shell.args, input.command], {
      cwd: context.cwd,
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    return { content: [textBlock([stdout, stderr].filter(Boolean).join("\n"))] };
  } catch (error) {
    return errorResponse(error);
  }
}

function textBlock(text: string): McpContent {
  return { type: "text", text };
}

function errorResponse<TDetails = unknown>(error: unknown): ToolResponse<TDetails> {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [textBlock(message)], isError: true };
}

async function walkFiles(root: string): Promise<string[]> {
  const rootStats = await stat(root);
  if (rootStats.isFile()) return [root];

  const results: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...await walkFiles(path));
    } else if (entry.isFile()) {
      results.push(path);
    }
  }
  return results;
}

function formatPath(path: string, root: string): string {
  return relative(root, resolve(path)).split("\\").join("/");
}

function globMatch(path: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(path) || path.includes(pattern.replaceAll("*", ""));
}
