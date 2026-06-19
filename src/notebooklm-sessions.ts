import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface NotebookSessionRecord {
  conversation: string;
  notebookId: string;
  notebookUrl: string;
  upstreamSessionId: string;
  createdAt: string;
  lastUsedAt: string;
  messageCount: number;
}

export class NotebookLmSessionStore {
  private readonly filePath: string;

  constructor(private readonly dataDir: string, private readonly ttlSeconds: number) {
    this.filePath = join(dataDir, "sessions.json");
  }

  async getReusableSession(input: {
    notebookId: string;
    notebookUrl: string;
    conversation?: string;
    now?: Date;
  }): Promise<NotebookSessionRecord | undefined> {
    const now = input.now ?? new Date();
    const conversation = input.conversation ?? "default";
    const record = (await this.list()).find((session) =>
      session.notebookId === input.notebookId &&
      session.notebookUrl === input.notebookUrl &&
      session.conversation === conversation
    );
    if (!record) return undefined;
    const ageSeconds = (now.getTime() - new Date(record.lastUsedAt).getTime()) / 1000;
    return ageSeconds <= this.ttlSeconds ? record : undefined;
  }

  async saveSession(input: {
    notebookId: string;
    notebookUrl: string;
    conversation?: string;
    upstreamSessionId: string;
    now?: Date;
  }): Promise<NotebookSessionRecord> {
    const now = (input.now ?? new Date()).toISOString();
    const conversation = input.conversation ?? "default";
    const records = await this.list();
    const existing = records.find((session) =>
      session.notebookId === input.notebookId &&
      session.notebookUrl === input.notebookUrl &&
      session.conversation === conversation
    );
    const nextRecord: NotebookSessionRecord = {
      conversation,
      notebookId: input.notebookId,
      notebookUrl: input.notebookUrl,
      upstreamSessionId: input.upstreamSessionId,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      messageCount: (existing?.messageCount ?? 0) + 1,
    };
    const next = existing
      ? records.map((record) => record === existing ? nextRecord : record)
      : [...records, nextRecord];
    await this.save(next);
    return nextRecord;
  }

  async clear(input: { notebookId?: string; conversation?: string }): Promise<number> {
    const records = await this.list();
    const next = records.filter((record) => {
      if (input.notebookId && record.notebookId !== input.notebookId) return true;
      if (input.conversation && record.conversation !== input.conversation) return true;
      return false;
    });
    await this.save(next);
    return records.length - next.length;
  }

  async stats(): Promise<{ activeSessions: number; oldestSessionAgeSeconds?: number }> {
    const records = await this.list();
    if (records.length === 0) return { activeSessions: 0 };
    const now = Date.now();
    const oldest = Math.max(...records.map((record) => now - new Date(record.createdAt).getTime()));
    return { activeSessions: records.length, oldestSessionAgeSeconds: Math.round(oldest / 1000) };
  }

  private async list(): Promise<NotebookSessionRecord[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as NotebookSessionRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async save(records: NotebookSessionRecord[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }
}
