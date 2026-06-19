import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isEditTool,
  isExpandableCard,
  isReadTool,
  isReviewTool,
  isSearchTool,
  isShellTool,
  shouldLoadReviewPayload,
  isToolName,
  isToolResultCard,
  isWriteTool,
  payloadText,
  progressActionLabel,
  progressDetailLabel,
  summaryNumber,
  type HostContext,
  type ToolName,
  type ToolResultCard,
} from "./card-types.js";
import "./workspace-app.css";

interface ToolDisplay {
  icon: string;
  title: string;
  label: string;
  tone: string;
}

interface MountedPayload {
  update(options: {
    card: ToolResultCard;
    hostContext?: HostContext;
    errorMessage?: string | null;
    visibleFileCount?: number;
    initialOpenPath?: string;
  }): void;
  unmount(): void;
}

type ToolProgressPhase = "preparing" | "running" | "cancelled";

interface ToolProgressState {
  phase: ToolProgressPhase;
  tool?: ToolName;
  args?: Record<string, unknown>;
  reason?: string;
  startedAt: number;
  updatedAt: number;
}

interface ToolInputParams {
  arguments?: Record<string, unknown>;
}

interface ToolCancelledParams {
  reason?: string;
}

let app: App | null = null;
let connected = false;
let connectionError: string | null = null;
let hostContext: HostContext | undefined;
let card: ToolResultCard | null = null;
let expanded = false;
let reviewFilesExpanded = false;
let reviewDetailPath: string | null = null;
let errorMessage: string | null = null;
let currentPayload: MountedPayload | null = null;
let currentPayloadContainer: HTMLElement | null = null;
let toolProgress: ToolProgressState | null = null;
let progressTimer: number | null = null;

const PROGRESS_REFRESH_MS = 1000;

const maybeAppRoot = document.querySelector<HTMLElement>("#app");

if (!maybeAppRoot) {
  throw new Error("Missing #app root element.");
}

const appRoot = maybeAppRoot;

void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
    { name: "devspace-tool-cards", version: "0.4.0" },
    {},
  );

  app.ontoolinputpartial = (params) => {
    updateToolProgress("preparing", params as ToolInputParams);
  };

  app.ontoolinput = (params) => {
    updateToolProgress("running", params as ToolInputParams);
  };

  app.ontoolresult = (result) => {
    clearToolProgress();
    const structuredContent = getStructuredContent<Partial<ToolResultCard>>(result);
    const metaCard = cardFromMeta(result);
    const structured = metaCard
      ? { ...structuredContent, ...metaCard }
      : structuredContent;
    const tool = toolNameFromMeta(result);

    if (!tool || !isToolResultCard(structured)) {
      card = null;
      expanded = false;
      reviewFilesExpanded = false;
      reviewDetailPath = null;
      errorMessage = "No result card is available for this tool result.";
      render();
      return;
    }

    card = { ...structured, tool };
    expanded = false;
    reviewFilesExpanded = false;
    reviewDetailPath = null;
    errorMessage = null;
    render();
  };

  app.onhostcontextchanged = (ctx) => {
    hostContext = {
      ...hostContext,
      ...ctx,
    };
    refreshProgressToolFromHostContext();
    applyHostContext();
    renderPayloadIfNeeded();
  };

  app.ontoolcancelled = (params) => {
    markToolProgressCancelled(params as ToolCancelledParams);
  };

  app.onteardown = async () => {
    clearToolProgress();
    unmountPayload();
    return {};
  };

  try {
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
  } catch (connectError) {
    connectionError = connectError instanceof Error
      ? connectError.message
      : String(connectError);
  }

  render();
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }

  const insets = hostContext?.safeAreaInsets;
  if (!insets) return;

  document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}

function render(): void {
  unmountPayload();

  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }

  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }

  if (toolProgress) {
    renderToolProgress(toolProgress);
    return;
  }

  if (!card) {
    renderEmpty(errorMessage ?? "Waiting for a tool result.", errorMessage ? "error" : "muted");
    return;
  }

  const display = getToolDisplay(card);
  if (isReviewTool(card.tool)) {
    renderReviewCard(card, display);
    return;
  }

  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: `tool-card ${display.tone}` });
  const button = element("button", {
    className: "tool-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    button.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;

  const toolMain = element("span", { className: "tool-main" });
  const title = element("span", { className: "tool-title", text: display.title });
  const label = element("span", {
    className: "tool-label",
    text: display.label,
    title: display.label,
  });
  toolMain.append(title, label);

  button.append(
    icon,
    toolMain,
    renderSummaryBadge(card),
    renderChevron(expanded, expandable),
  );
  section.append(button);

  if (expanded) {
    const body = element("div", { className: "tool-body" });
    currentPayloadContainer = body;
    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderToolProgress(progress: ToolProgressState): void {
  const display = getProgressDisplay(progress);
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - progress.startedAt) / 1000));
  const main = element("main", { className: "shell" });
  const section = element("section", {
    className: `tool-card progress ${progress.phase === "cancelled" ? "cancelled" : display.tone}`,
  });
  const header = element("div", { className: "tool-header progress-header" });
  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;
  const toolMain = element("span", { className: "tool-main" });
  const title = element("span", {
    className: "tool-title",
    text: progress.phase === "cancelled" ? "Tool Cancelled" : display.title,
  });
  const label = element("span", {
    className: "tool-label",
    text: display.label,
    title: display.label,
  });
  const badge = element("span", {
    className: "badge",
    text: progress.phase === "cancelled" ? "cancelled" : `${elapsedSeconds}s`,
  });

  toolMain.append(title, label);
  header.append(icon, toolMain, badge, element("span", { className: "chevron" }));

  const body = element("div", { className: "progress-body" });
  const lineText = progress.phase === "cancelled"
    ? progress.reason ?? "The host cancelled this tool run."
    : progress.phase === "preparing"
      ? "Receiving tool input..."
      : "Tool is running...";
  body.append(
    element("div", {
      className: `progress-line ${progress.phase === "cancelled" ? "cancelled" : ""}`,
      text: lineText,
    }),
    renderProgressBar(progress.phase),
  );

  section.append(header, body);
  main.append(section);
  appRoot.replaceChildren(main);
}

function getProgressDisplay(progress: ToolProgressState): ToolDisplay {
  const title = progressActionLabel(progress.tool);
  const label = progressDetailLabel(progress.tool, progress.args);
  const tone = getProgressTone(progress.tool);
  return { icon: getProgressIcon(progress.tool), title, label, tone };
}

function getProgressTone(tool: ToolName | undefined): string {
  if (!tool) return "running";
  if (isReviewTool(tool)) return "review";
  if (isShellTool(tool)) return "shell";
  if (isSearchTool(tool)) return "search";
  if (isReadTool(tool)) return "read";
  if (isWriteTool(tool)) return "write";
  if (isEditTool(tool)) return "edit";
  if (tool === "open_workspace") return "workspace";
  return "running";
}

function getProgressIcon(tool: ToolName | undefined): string {
  if (!tool) return clockIcon();
  if (isReviewTool(tool)) return reviewIcon();
  if (isShellTool(tool)) return terminalIcon();
  if (isSearchTool(tool)) return searchIcon();
  if (isReadTool(tool)) return fileIcon();
  if (isWriteTool(tool)) return filePlusIcon();
  if (isEditTool(tool)) return editIcon();
  if (tool === "open_workspace") return folderIcon();
  if (tool === "list_directory" || tool === "ls") return listIcon();
  if (tool === "find_files" || tool === "glob") return filesIcon();
  return clockIcon();
}

function renderProgressBar(phase: ToolProgressPhase): HTMLElement {
  const bar = element("div", {
    className: `progress-bar ${phase === "cancelled" ? "cancelled" : ""}`,
    ariaHidden: "true",
  });
  bar.append(element("span"));
  return bar;
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  const main = element("main", { className: "shell" });
  main.append(element("section", { className: `empty ${tone}`, text: message }));
  appRoot.replaceChildren(main);
}

function updateToolProgress(phase: ToolProgressPhase, params: ToolInputParams): void {
  const now = Date.now();
  toolProgress = {
    phase,
    tool: currentHostToolName() ?? toolProgress?.tool,
    args: params.arguments ?? toolProgress?.args,
    startedAt: toolProgress?.startedAt ?? now,
    updatedAt: now,
  };
  card = null;
  expanded = false;
  reviewFilesExpanded = false;
  reviewDetailPath = null;
  errorMessage = null;
  startProgressTimer();
  render();
}

function markToolProgressCancelled(params: ToolCancelledParams): void {
  const now = Date.now();
  toolProgress = {
    phase: "cancelled",
    tool: currentHostToolName() ?? toolProgress?.tool,
    args: toolProgress?.args,
    reason: params.reason,
    startedAt: toolProgress?.startedAt ?? now,
    updatedAt: now,
  };
  card = null;
  errorMessage = null;
  stopProgressTimer();
  render();
}

function refreshProgressToolFromHostContext(): void {
  if (!toolProgress || toolProgress.tool) return;
  const tool = currentHostToolName();
  if (!tool) return;
  toolProgress = {
    ...toolProgress,
    tool,
    updatedAt: Date.now(),
  };
  render();
}

function currentHostToolName(): ToolName | undefined {
  const name = hostContext?.toolInfo?.tool?.name;
  return isToolName(name) ? name : undefined;
}

function startProgressTimer(): void {
  if (progressTimer) return;
  progressTimer = window.setInterval(() => {
    if (!toolProgress || toolProgress.phase === "cancelled") {
      stopProgressTimer();
      return;
    }
    render();
  }, PROGRESS_REFRESH_MS);
}

function stopProgressTimer(): void {
  if (!progressTimer) return;
  window.clearInterval(progressTimer);
  progressTimer = null;
}

function clearToolProgress(): void {
  toolProgress = null;
  stopProgressTimer();
}

async function renderPayloadIfNeeded(): Promise<void> {
  if (
    !card ||
    !currentPayloadContainer ||
    (!expanded && !shouldLoadReviewPayload(card, reviewDetailPath !== null))
  ) {
    return;
  }

  const target = currentPayloadContainer;

  if (errorMessage) {
    renderStatus(target, errorMessage, "error");
    return;
  }

  if (card.tool === "open_workspace") {
    renderPrePayload(target, workspacePayloadText(card), "open_workspace");
    return;
  }

  if (shouldUseHeavyPayload(card)) {
    if (currentPayload) {
      currentPayload.update({ card, hostContext, errorMessage });
      return;
    }

    renderStatus(target, "Loading details...");

    const { mountHeavyPayload } = await import("./heavy-payload.js");
    if (target !== currentPayloadContainer || !expanded || !card) return;

    currentPayload = mountHeavyPayload(target, {
      card,
      hostContext,
      errorMessage,
    });
    return;
  }

  if (shouldLoadReviewPayload(card, reviewDetailPath !== null)) {
    const visibleFileCount = reviewFilesExpanded
      ? undefined
      : Math.max(3, (card.files ?? []).slice(0, 3).length);

    if (currentPayload) {
      currentPayload.update({
        card,
        hostContext,
        errorMessage,
        visibleFileCount,
        initialOpenPath: reviewDetailPath ?? undefined,
      });
      return;
    }

    renderStatus(target, "Loading review...");

    const { mountReviewPayload } = await import("./review-payload.js");
    if (target !== currentPayloadContainer || !card) return;

    currentPayload = mountReviewPayload(target, {
      card,
      hostContext,
      errorMessage,
      visibleFileCount,
      initialOpenPath: reviewDetailPath ?? undefined,
    });
    return;
  }

  const text = payloadText(card.payload);
  if (!text) {
    renderStatus(target, "No details available.");
    return;
  }

  renderPrePayload(target, text, card.tool);
}

function shouldUseHeavyPayload(card: ToolResultCard): boolean {
  return isReadTool(card.tool) || isEditTool(card.tool) || isWriteTool(card.tool);
}

function unmountPayload(): void {
  unmountCurrentPayload();
  currentPayload = null;
  currentPayloadContainer = null;
}

function unmountCurrentPayload(): void {
  currentPayload?.unmount();
  currentPayload = null;
}

function renderStatus(
  container: HTMLElement,
  message: string,
  tone: "muted" | "error" = "muted",
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("div", { className: `status ${tone}`, text: message }));
}

function renderPrePayload(
  container: HTMLElement,
  text: string,
  tool: string,
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("pre", { className: `text-payload ${tool}`, text }));
}

function renderSummaryBadge(card: ToolResultCard): HTMLElement {
  const summary = card.summary ?? {};

  if (isReviewTool(card.tool)) {
    const stats = element("span", { className: "stats" });
    stats.setAttribute("aria-label", "Review diff statistics");
    stats.append(
      element("span", { className: "add", text: `+${String(summary.additions ?? 0)}` }),
      element("span", { className: "remove", text: `-${String(summary.removals ?? 0)}` }),
    );
    return stats;
  }

  if (isEditTool(card.tool) || isWriteTool(card.tool)) {
    const stats = element("span", { className: "stats" });
    stats.setAttribute("aria-label", "Diff statistics");
    stats.append(
      element("span", { className: "add", text: `+${String(summary.additions ?? 0)}` }),
      element("span", { className: "remove", text: `-${String(summary.removals ?? 0)}` }),
    );
    return stats;
  }

  if (card.tool === "open_workspace") {
    const agentsFiles = summaryNumber(summary, "agentsFiles") ?? 0;
    const skills = summaryNumber(summary, "skills") ?? 0;
    const group = element("span", { className: "badge-group" });
    group.setAttribute("aria-label", "Workspace summary");

    const agentsBadge = element("span", {
      className: `badge ${agentsFiles > 0 ? "success" : "muted"}`,
      text: agentsFiles > 0 ? "AGENTS.md" : "No AGENTS.md",
    });
    if (agentsFiles > 0) {
      agentsBadge.insertAdjacentHTML("afterbegin", checkCircleIcon());
    }

    group.append(agentsBadge, element("span", { className: "badge", text: `${skills} skills` }));
    return group;
  }

  if (isShellTool(card.tool)) {
    return element("span", { className: "badge", text: `ran · ${String(summary.lines ?? 0)} lines` });
  }

  if (isSearchTool(card.tool)) {
    return element("span", { className: "badge", text: `${String(summary.lines ?? 0)} lines` });
  }

  return element("span", { className: "badge", text: `${String(summary.lines ?? 0)} lines` });
}

function renderReviewCard(card: ToolResultCard, display: ToolDisplay): void {
  unmountPayload();

  const files = card.files ?? [];
  const visibleFiles = reviewFilesExpanded ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: "tool-card review" });
  const header = element("div", { className: "review-header" });
  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.innerHTML = display.icon;
  const titleGroup = element("div", { className: "review-title-group" });

  titleGroup.append(
    element("span", { className: "tool-title", text: display.title }),
    element("span", { className: "tool-label", text: display.label, title: display.label }),
  );
  header.append(icon, titleGroup, renderSummaryBadge(card));

  const body = element("div", { className: "review-summary" });
  if (shouldLoadReviewPayload(card, reviewDetailPath !== null)) {
    currentPayloadContainer = body;
  } else {
    renderReviewSummary(card, body, visibleFiles);
  }

  const actions = element("div", { className: "review-actions" });
  if (hiddenCount > 0) {
    const showMore = element("button", {
      className: "review-action",
      type: "button",
      text: `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`,
    });
    showMore.addEventListener("click", () => {
      reviewFilesExpanded = true;
      render();
    });
    actions.append(showMore);
  }

  section.append(header, body);
  if (actions.childElementCount > 0) {
    section.append(actions);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderReviewSummary(
  card: ToolResultCard,
  container: HTMLElement,
  files: NonNullable<ToolResultCard["files"]>,
): void {
  if (errorMessage) {
    renderStatus(container, errorMessage, "error");
    return;
  }

  if (files.length === 0) {
    if (card.payload?.patch) {
      const action = element("button", {
        className: "review-action",
        type: "button",
        text: "Load visual diff",
      });
      action.addEventListener("click", () => {
        reviewDetailPath = "";
        render();
      });
      const actions = element("div", { className: "review-actions inline" });
      actions.append(action);
      container.replaceChildren(actions);
      return;
    }

    renderStatus(container, "No diff hunks to review.");
    return;
  }

  const wrapper = element("div", { className: "review-diff" });
  const list = element("div", { className: "review-diff-files" });

  for (const file of files) {
    const fileCard = element("div", { className: "review-diff-file" });
    const button = element("button", {
      type: "button",
      className: "review-diff-file-header",
      ariaExpanded: "false",
    });
    button.addEventListener("click", () => {
      reviewDetailPath = file.path ?? file.previousPath ?? "";
      render();
    });

    button.append(
      element("span", {
        className: "review-diff-file-name",
        text: file.path ?? file.previousPath ?? "changed file",
      }),
      renderFileStats(file),
    );
    fileCard.append(button);
    list.append(fileCard);
  }

  wrapper.append(list);
  container.replaceChildren(wrapper);
}

function renderFileStats(file: NonNullable<ToolResultCard["files"]>[number]): HTMLElement {
  const stats = element("span", { className: "review-diff-file-stats" });
  stats.append(
    element("span", { className: "add", text: `+${String(file.additions ?? 0)}` }),
    element("span", { className: "remove", text: `-${String(file.removals ?? 0)}` }),
  );
  return stats;
}

function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });

  if (visible) {
    chevron.innerHTML = iconSvg('<path d="m6 9 6 6 6-6" />');
  }

  return chevron;
}

function workspacePayloadText(card: ToolResultCard): string {
  const agentsFiles = card.agentsFiles ?? [];
  const availableAgentsFiles = card.availableAgentsFiles ?? [];
  const skills = card.skills ?? [];
  const lines = [
    card.workspaceId ? `Workspace: ${card.workspaceId}` : undefined,
    card.root ? `Root: ${card.root}` : undefined,
    skills.length > 0
      ? `Skills: ${skills.map((skill) => skill.name ?? skill.path ?? "unnamed").join(", ")}`
      : "Skills: none",
    availableAgentsFiles.length > 0
      ? `Nested instructions: ${availableAgentsFiles.map((file) => file.path ?? "unknown").join(", ")}`
      : undefined,
    agentsFiles.length > 0
      ? `\n${formatAgentsFilesForPayload(agentsFiles)}`
      : "\nAGENTS.md: none loaded",
  ].filter((line): line is string => typeof line === "string");

  return lines.join("\n");
}

function formatAgentsFilesForPayload(
  agentsFiles: NonNullable<ToolResultCard["agentsFiles"]>,
): string {
  return agentsFiles
    .map((file) => {
      const path = file.path ?? "AGENTS.md";
      const content = file.content?.trim();
      return content ? `${path}\n\n${content}` : `${path}\n\nNo content loaded.`;
    })
    .join("\n\n");
}

function getToolDisplay(card: ToolResultCard): ToolDisplay {
  const label = getToolLabel(card);

  switch (card.tool) {
    case "open_workspace":
      return { icon: folderIcon(), title: "Workspace", label, tone: "workspace" };
    case "read_file":
    case "read":
      return { icon: fileIcon(), title: "Read File", label, tone: "read" };
    case "write_file":
    case "write":
      return { icon: filePlusIcon(), title: "Write File", label, tone: "write" };
    case "edit_file":
    case "edit":
      return { icon: editIcon(), title: "Edit File", label, tone: "edit" };
    case "grep_files":
    case "grep":
      return { icon: searchIcon(), title: "Grep", label, tone: "search" };
    case "find_files":
    case "glob":
      return { icon: filesIcon(), title: "Glob", label, tone: "search" };
    case "list_directory":
    case "ls":
      return { icon: listIcon(), title: "List Directory", label, tone: "directory" };
    case "run_shell":
    case "bash":
      return { icon: terminalIcon(), title: "Bash", label, tone: "shell" };
    case "show_changes":
      return { icon: reviewIcon(), title: "Show Changes", label, tone: "review" };
  }
}

function getToolLabel(card: ToolResultCard): string {
  if (isShellTool(card.tool)) {
    return String(card.summary?.command ?? card.path ?? card.tool);
  }
  if (isReviewTool(card.tool)) {
    const count = Number(card.summary?.files ?? card.files?.length ?? 0);
    return count === 0 ? "No changes since last review" : `${count} changed ${count === 1 ? "file" : "files"}`;
  }
  if (card.path) return card.path;
  if (card.root) return card.root;
  if (isSearchTool(card.tool)) {
    return String(card.summary?.pattern ?? card.tool);
  }

  return card.tool;
}

function toolNameFromMeta(result: CallToolResult): ToolName | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const tool = meta?.tool;
  return isToolName(tool) ? tool : undefined;
}

function cardFromMeta(result: CallToolResult): Partial<ToolResultCard> | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const metaCard = meta?.card;
  return metaCard && typeof metaCard === "object" ? metaCard : undefined;
}

function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
    ariaExpanded?: string;
    disabled?: boolean;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node) node.setAttribute("type", options.type);
  if (options.title !== undefined) node.title = options.title;
  if (options.ariaHidden !== undefined) node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaExpanded !== undefined) node.setAttribute("aria-expanded", options.ariaExpanded);
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
}

function iconSvg(children: string): string {
  return `<svg aria-hidden="true" class="icon-svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8">${children}</svg>`;
}

function folderIcon(): string {
  return iconSvg('<path d="M3 7.5h6l2 2h10" /><path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5v-8H3" />');
}

function fileIcon(): string {
  return iconSvg('<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M9 13h6" /><path d="M9 17h4" />');
}

function filePlusIcon(): string {
  return iconSvg('<path d="M14 3v5h5" /><path d="M6 3h8l5 5v13H6z" /><path d="M12 12v6" /><path d="M9 15h6" />');
}

function editIcon(): string {
  return iconSvg('<path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" />');
}

function searchIcon(): string {
  return iconSvg('<circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" />');
}

function filesIcon(): string {
  return iconSvg('<path d="M8 7V4h9l4 4v10h-3" /><path d="M12 4v5h5" /><path d="M4 7h9l4 4v10H4z" /><path d="M13 7v5h4" />');
}

function checkCircleIcon(): string {
  return '<svg aria-hidden="true" class="badge-icon" fill="none" viewBox="0 0 16 16" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="8" cy="8" r="6" /><path d="m5.5 8 1.7 1.7 3.4-3.5" /></svg>';
}

function listIcon(): string {
  return iconSvg('<path d="M8 6h12" /><path d="M8 12h12" /><path d="M8 18h12" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" />');
}

function terminalIcon(): string {
  return iconSvg('<path d="m5 7 5 5-5 5" /><path d="M12 17h7" />');
}

function reviewIcon(): string {
  return iconSvg('<path d="M5 4h14v16H5z" /><path d="M8 8h8" /><path d="M8 12h5" /><path d="M8 16h7" />');
}

function clockIcon(): string {
  return iconSvg('<circle cx="12" cy="12" r="8" /><path d="M12 8v5l3 2" />');
}
