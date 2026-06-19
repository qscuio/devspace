import type { App } from "@modelcontextprotocol/ext-apps";

export type ToolName =
  | "open_workspace"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "grep_files"
  | "find_files"
  | "list_directory"
  | "run_shell"
  | "show_changes"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "ls"
  | "bash";

export type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

export interface ToolResultCard {
  tool: ToolName;
  workspaceId?: string;
  path?: string;
  root?: string;
  status?: string;
  summary?: Record<string, unknown>;
  files?: Array<{
    path?: string;
    previousPath?: string;
    type?: string;
    additions?: number;
    removals?: number;
  }>;
  payload?: ToolPayload;
  agentsFiles?: Array<{
    path?: string;
    content?: string;
  }>;
  availableAgentsFiles?: Array<{
    path?: string;
  }>;
  skills?: Array<{
    name?: string;
    description?: string;
    path?: string;
  }>;
  skillDiagnostics?: unknown[];
  instruction?: string;
}

export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ToolPayload {
  content?: ToolContent[];
  diff?: string;
  patch?: string;
}

export function isToolName(value: unknown): value is ToolName {
  return (
    value === "open_workspace" ||
    value === "read_file" ||
    value === "write_file" ||
    value === "edit_file" ||
    value === "grep_files" ||
    value === "find_files" ||
    value === "list_directory" ||
    value === "run_shell" ||
    value === "show_changes" ||
    value === "read" ||
    value === "write" ||
    value === "edit" ||
    value === "grep" ||
    value === "glob" ||
    value === "ls" ||
    value === "bash"
  );
}

export function isReadTool(tool: ToolName): boolean {
  return tool === "read_file" || tool === "read";
}

export function isWriteTool(tool: ToolName): boolean {
  return tool === "write_file" || tool === "write";
}

export function isEditTool(tool: ToolName): boolean {
  return tool === "edit_file" || tool === "edit";
}

export function isSearchTool(tool: ToolName): boolean {
  return tool === "grep_files" || tool === "find_files" || tool === "grep" || tool === "glob";
}

export function isShellTool(tool: ToolName): boolean {
  return tool === "run_shell" || tool === "bash";
}

export function isReviewTool(tool: ToolName): boolean {
  return tool === "show_changes";
}

export function progressActionLabel(tool: ToolName | undefined): string {
  switch (tool) {
    case "open_workspace":
      return "Opening Workspace";
    case "read_file":
    case "read":
      return "Reading File";
    case "write_file":
    case "write":
      return "Writing File";
    case "edit_file":
    case "edit":
      return "Editing File";
    case "grep_files":
    case "grep":
      return "Searching Files";
    case "find_files":
    case "glob":
      return "Finding Files";
    case "list_directory":
    case "ls":
      return "Listing Directory";
    case "run_shell":
    case "bash":
      return "Running Bash";
    case "show_changes":
      return "Preparing Review";
    default:
      return "Running Tool";
  }
}

export function progressDetailLabel(
  tool: ToolName | undefined,
  args: Record<string, unknown> | undefined,
): string {
  const detail = preferredProgressDetail(tool, args);
  return detail ? truncateProgressDetail(detail) : "Waiting for tool progress...";
}

function preferredProgressDetail(
  tool: ToolName | undefined,
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  if (isShellProgressTool(tool)) return stringValue(args.command);

  return (
    stringValue(args.path) ??
    stringValue(args.root) ??
    stringValue(args.pattern) ??
    stringValue(args.command)
  );
}

function isShellProgressTool(tool: ToolName | undefined): boolean {
  return tool === "run_shell" || tool === "bash";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function truncateProgressDetail(value: string): string {
  return value.length > 140 ? `${value.slice(0, 137)}...` : value;
}

export function isToolResultCard(value: unknown): value is Omit<ToolResultCard, "tool"> {
  return Boolean(value && typeof value === "object");
}

export function payloadText(payload: ToolPayload | undefined): string {
  return (
    payload?.content
      ?.map((item) => {
        if (item.type === "text") return item.text ?? "";
        return `[${item.mimeType ?? "image"} image payload]`;
      })
      .filter(Boolean)
      .join("\n\n") ?? ""
  );
}

export function summaryNumber(
  summary: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isExpandableCard(card: ToolResultCard): boolean {
  if (card.tool === "open_workspace") {
    return (
      Number(card.summary?.agentsFiles ?? 0) > 0 ||
      Number(card.summary?.skills ?? 0) > 0 ||
      Number(card.summary?.skillDiagnostics ?? 0) > 0 ||
      Boolean(card.agentsFiles?.length) ||
      Boolean(card.availableAgentsFiles?.length) ||
      Boolean(card.skills?.length) ||
      Boolean(card.skillDiagnostics?.length)
    );
  }

  if (isReviewTool(card.tool)) return Boolean(card.files?.length || card.payload?.patch);

  return Boolean(card.payload);
}

export function shouldLoadReviewPayload(
  card: ToolResultCard,
  detailsRequested: boolean,
): boolean {
  return isReviewTool(card.tool) && detailsRequested && Boolean(card.payload?.patch);
}
