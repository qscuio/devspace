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
  private writeQueue: Promise<void> = Promise.resolve();

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
    return this.updateRecords((records) => {
      const recordIndex = records.findIndex((session) =>
        session.notebookId === input.notebookId &&
        session.notebookUrl === input.notebookUrl &&
        session.conversation === conversation
      );
      if (recordIndex === -1) return { records, result: undefined };

      const record = records[recordIndex]!;
      const ageSeconds = (now.getTime() - new Date(record.lastUsedAt).getTime()) / 1000;
      if (ageSeconds > this.ttlSeconds) return { records, result: undefined };

      const touched: NotebookSessionRecord = {
        ...record,
        lastUsedAt: now.toISOString(),
        messageCount: record.messageCount + 1,
      };
      return {
        records: records.map((session, index) => index === recordIndex ? touched : session),
        result: touched,
      };
    });
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
    return this.updateRecords((records) => {
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
      return { records: next, result: nextRecord };
    });
  }

  async clear(input: { notebookId?: string; conversation?: string }): Promise<number> {
    return this.updateRecords((records) => {
      const next = records.filter((record) => {
        if (input.notebookId && record.notebookId !== input.notebookId) return true;
        if (input.conversation && record.conversation !== input.conversation) return true;
        return false;
      });
      return { records: next, result: records.length - next.length };
    });
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

  private async updateRecords<T>(
    fn: (records: NotebookSessionRecord[]) => { records: NotebookSessionRecord[]; result: T },
  ): Promise<T> {
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const update = fn(await this.list());
      await this.save(update.records);
      return update.result;
    } finally {
      release();
    }
  }
}
