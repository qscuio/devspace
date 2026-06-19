import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type NotebookRecord,
  type NotebookLmLibraryStore,
} from "./notebooklm-library.js";
import type { NotebookLmSessionStore } from "./notebooklm-sessions.js";
import {
  NotebookLmClientError,
  type NotebookLmClient,
  type NotebookLmMappedError,
} from "./notebooklm.js";

export interface NotebookLmDiscoverer {
  discover(input: { limit: number }): Promise<Array<{ name: string; url: string }>>;
}

export interface NotebookLmWorkflowsDeps {
  library: NotebookLmLibraryStore;
  sessions: NotebookLmSessionStore;
  client: NotebookLmClient;
  dataDir: string;
  discoverer?: NotebookLmDiscoverer;
}

export interface NotebookLmStatusInput {
  verifyBrowser?: boolean;
  verify_browser?: boolean;
}

export type NotebookLmWorkflowFailureStatus =
  | NotebookLmMappedError["code"]
  | "not_authenticated"
  | "browser_failed"
  | "upstream_unavailable";

export interface NotebookLmRepairPlan {
  code: string;
  message: string;
  repairHint: string;
}

export type NotebookLmStatusResponse =
  | {
    status: string;
    authenticated: boolean;
    knownNotebooks: number;
    sessions: Awaited<ReturnType<NotebookLmSessionStore["stats"]>>;
    dataDir: string;
    repairPlan?: NotebookLmRepairPlan;
  }
  | {
    status: NotebookLmWorkflowFailureStatus;
    authenticated: false;
    knownNotebooks: number;
    sessions: Awaited<ReturnType<NotebookLmSessionStore["stats"]>>;
    dataDir: string;
    repairPlan: NotebookLmRepairPlan;
  };

export interface NotebookLmResearchInput {
  question: string;
  notebook?: string;
  notebookId?: string;
  notebook_id?: string;
  notebookUrl?: string;
  notebook_url?: string;
  conversation?: string;
  fresh_session?: boolean;
  freshSession?: boolean;
}

export type NotebookLmResearchResponse =
  | {
    status: "ok";
    notebook: NotebookRecord;
    answer?: unknown;
    result: CallToolResult;
    sessionId?: string;
    sessionRefreshed: boolean;
  }
  | { status: "ambiguous_notebook"; candidates: NotebookRecord[] }
  | { status: "notebook_not_found"; candidates: NotebookRecord[] }
  | {
    status: NotebookLmWorkflowFailureStatus;
    notebook?: NotebookRecord;
    authenticated?: false;
    repairPlan: NotebookLmRepairPlan;
  };

export interface NotebookLmLibraryInput {
  action?: "list" | "search" | "clear_sessions";
  query?: string;
  notebook?: string;
  notebookId?: string;
  notebook_id?: string;
  notebookUrl?: string;
  notebook_url?: string;
  conversation?: string;
}

export type NotebookLmLibraryResponse =
  | { status: "ok"; action: "list"; notebooks: NotebookRecord[] }
  | { status: "ok"; action: "search"; notebooks: NotebookRecord[] }
  | { status: "ok"; action: "clear_sessions"; cleared: number }
  | { status: "ambiguous_notebook"; candidates: NotebookRecord[] }
  | { status: "notebook_not_found"; candidates: NotebookRecord[] };

export interface NotebookLmDiscoverInput {
  limit?: number;
  tag?: string;
}

export type NotebookLmDiscoverResponse =
  | { status: "ok"; imported: number; notebooks: NotebookRecord[] }
  | { status: "browser_failed"; message: string; repairHint: string };

export class NotebookLmWorkflows {
  constructor(private readonly deps: NotebookLmWorkflowsDeps) {}

  async status(input: NotebookLmStatusInput): Promise<NotebookLmStatusResponse> {
    const [knownNotebooks, sessions] = await Promise.all([
      this.deps.library.list().then((records) => records.length),
      this.deps.sessions.stats(),
    ]);

    try {
      const health = await this.deps.client.callTool("get_health", {
        verify_browser: input.verifyBrowser ?? input.verify_browser ?? false,
      });
      const structured = structuredContent(health);
      const authenticated = structured.authenticated === undefined
        ? true
        : Boolean(structured.authenticated);
      const status = typeof structured.status === "string"
        ? structured.status
        : authenticated ? "ok" : "not_authenticated";
      return {
        status,
        authenticated,
        knownNotebooks,
        sessions,
        dataDir: this.deps.dataDir,
        repairPlan: authenticated
          ? undefined
          : {
            code: "not_authenticated",
            message: "NotebookLM is not authenticated.",
            repairHint: "Run notebooklm_status or notebooklm_setup_auth with a visible browser.",
          },
      };
    } catch (error) {
      const repairPlan = repairPlanFromError(error);
      return {
        status: repairPlan.code as NotebookLmWorkflowFailureStatus,
        authenticated: false,
        knownNotebooks,
        sessions,
        dataDir: this.deps.dataDir,
        repairPlan,
      };
    }
  }

  async research(input: NotebookLmResearchInput): Promise<NotebookLmResearchResponse> {
    const resolved = await this.deps.library.resolve({
      notebook: input.notebook,
      notebookId: input.notebookId ?? input.notebook_id,
      notebookUrl: input.notebookUrl ?? input.notebook_url,
    });
    if (resolved.status === "ambiguous") {
      return { status: "ambiguous_notebook", candidates: resolved.candidates };
    }
    if (resolved.status === "not_found") {
      return { status: "notebook_not_found", candidates: resolved.candidates };
    }

    const notebook = resolved.notebook;
    const health = await this.status({});
    if (health.status !== "ok" || !health.authenticated) {
      return {
        status: health.status as NotebookLmWorkflowFailureStatus,
        notebook,
        authenticated: false,
        repairPlan: health.repairPlan ?? {
          code: "not_authenticated",
          message: "NotebookLM is not authenticated.",
          repairHint: "Run notebooklm_status or notebooklm_setup_auth with a visible browser.",
        },
      };
    }

    const conversation = input.conversation;
    const freshSession = input.fresh_session ?? input.freshSession ?? false;
    const reusable = freshSession
      ? undefined
      : await this.deps.sessions.getReusableSession({
        notebookId: notebook.id,
        notebookUrl: notebook.url,
        conversation,
      });
    const sessionId = reusable?.upstreamSessionId;

    try {
      return await this.askAndSave({ input, notebook, sessionId });
    } catch (error) {
      if (sessionId && isSessionRelatedError(error)) {
        try {
          return await this.askAndSave({ input, notebook });
        } catch (retryError) {
          return failureResponseFromError(retryError, notebook);
        }
      }
      return failureResponseFromError(error, notebook);
    }
  }

  async library(input: NotebookLmLibraryInput): Promise<NotebookLmLibraryResponse> {
    const action = input.action ?? "list";
    if (action === "list") {
      return { status: "ok", action, notebooks: await this.deps.library.list() };
    }
    if (action === "search") {
      const query = input.query?.trim().toLowerCase();
      const notebooks = query
        ? (await this.deps.library.list()).filter((record) => notebookContains(record, query))
        : await this.deps.library.list();
      return { status: "ok", action, notebooks };
    }

    const resolved = await this.deps.library.resolve({
      notebook: input.notebook,
      notebookId: input.notebookId ?? input.notebook_id,
      notebookUrl: input.notebookUrl ?? input.notebook_url,
    });
    if (resolved.status === "ambiguous") {
      return { status: "ambiguous_notebook", candidates: resolved.candidates };
    }
    if (resolved.status === "not_found") {
      return { status: "notebook_not_found", candidates: resolved.candidates };
    }
    const cleared = await this.deps.sessions.clear({
      notebookId: resolved.notebook.id,
      conversation: input.conversation,
    });
    return { status: "ok", action, cleared };
  }

  async discover(input: NotebookLmDiscoverInput): Promise<NotebookLmDiscoverResponse> {
    if (!this.deps.discoverer) {
      return {
        status: "browser_failed",
        message: "NotebookLM account discovery is not wired yet.",
        repairHint: "Ask by notebook URL or configure the discovery adapter.",
      };
    }

    const cards = await this.deps.discoverer.discover({ limit: input.limit ?? 20 });
    const imported: NotebookRecord[] = [];
    for (const card of cards) {
      imported.push(await this.deps.library.upsert({
        url: card.url,
        name: card.name,
        aliases: [],
        description: "",
        topics: [],
        tags: input.tag ? [input.tag] : [],
        source: "discovered",
        discoveredAt: new Date().toISOString(),
      }));
    }
    return { status: "ok", imported: imported.length, notebooks: imported };
  }

  private async askAndSave(input: {
    input: NotebookLmResearchInput;
    notebook: NotebookRecord;
    sessionId?: string;
  }): Promise<Extract<NotebookLmResearchResponse, { status: "ok" }>> {
    const args: Record<string, unknown> = {
      question: input.input.question,
      notebook_url: input.notebook.url,
    };
    if (input.sessionId) args.session_id = input.sessionId;

    let result: CallToolResult;
    try {
      result = await this.deps.client.callTool("ask_question", args);
    } catch (error) {
      if (error instanceof Error) throw new NotebookLmUpstreamCallError(error);
      throw error;
    }
    const structured = structuredContent(result);
    const returnedSessionId = typeof structured.session_id === "string"
      ? structured.session_id
      : undefined;
    if (returnedSessionId) {
      await this.deps.sessions.saveSession({
        notebookId: input.notebook.id,
        notebookUrl: input.notebook.url,
        conversation: input.input.conversation,
        upstreamSessionId: returnedSessionId,
      });
    }
    return {
      status: "ok",
      notebook: input.notebook,
      answer: structured.answer,
      result,
      sessionId: returnedSessionId,
      sessionRefreshed: Boolean(returnedSessionId),
    };
  }
}

function structuredContent(result: CallToolResult): Record<string, unknown> {
  const structured = result.structuredContent;
  return structured && typeof structured === "object" && !Array.isArray(structured)
    ? structured as Record<string, unknown>
    : {};
}

function repairPlanFromError(error: unknown): NotebookLmRepairPlan {
  if (error instanceof NotebookLmClientError) {
    return {
      code: error.code,
      message: error.message,
      repairHint: error.repairHint,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "upstream_unavailable",
    message,
    repairHint: "Check that notebooklm-mcp can start and that Node/npm are available.",
  };
}

function failureResponseFromError(
  error: unknown,
  notebook: NotebookRecord,
): Extract<NotebookLmResearchResponse, { repairPlan: NotebookLmRepairPlan }> {
  const upstreamError = upstreamCallErrorCause(error);
  if (!upstreamError) throw error;
  const repairPlan = repairPlanFromError(upstreamError);
  return {
    status: repairPlan.code as NotebookLmWorkflowFailureStatus,
    notebook,
    repairPlan,
  };
}

function isSessionRelatedError(error: unknown): boolean {
  const upstreamError = upstreamCallErrorCause(error) ?? error;
  if (upstreamError instanceof NotebookLmClientError && upstreamError.code === "auth_state_stale") return true;
  const message = upstreamError instanceof Error ? upstreamError.message : String(upstreamError);
  const normalized = message.toLowerCase();
  return normalized.includes("session") ||
    normalized.includes("expired") ||
    normalized.includes("stale") ||
    normalized.includes("invalid session");
}

class NotebookLmUpstreamCallError extends Error {
  override readonly cause: Error;

  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "NotebookLmUpstreamCallError";
    this.cause = cause;
  }
}

function upstreamCallErrorCause(error: unknown): Error | undefined {
  if (error instanceof NotebookLmUpstreamCallError) return error.cause;
  if (error instanceof NotebookLmClientError) return error;
  return undefined;
}

function notebookContains(record: NotebookRecord, query: string): boolean {
  return [
    record.id,
    record.url,
    record.name,
    record.description,
    ...record.aliases,
    ...record.topics,
    ...record.tags,
  ].some((value) => value.toLowerCase().includes(query));
}
