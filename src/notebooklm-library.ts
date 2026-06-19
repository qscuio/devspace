import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type NotebookSource = "manual" | "discovered";

export interface NotebookRecord {
  id: string;
  url: string;
  name: string;
  aliases: string[];
  description: string;
  topics: string[];
  tags: string[];
  source: NotebookSource;
  lastDiscoveredAt?: string;
  lastEnrichedAt?: string;
}

export interface NotebookUpsertInput {
  url: string;
  name: string;
  aliases?: string[];
  description?: string;
  topics?: string[];
  tags?: string[];
  source: NotebookSource;
  discoveredAt?: string;
  enrichedAt?: string;
}

export type NotebookResolveResult =
  | { status: "matched"; notebook: NotebookRecord }
  | { status: "ambiguous"; candidates: NotebookRecord[] }
  | { status: "not_found"; candidates: NotebookRecord[] };

export function normalizeNotebookUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString().replace(/\/$/, "");
}

function notebookIdFromUrl(value: string): string {
  const parsed = new URL(normalizeNotebookUrl(value));
  const id = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (!id) throw new Error(`Notebook URL does not contain an id: ${value}`);
  return id;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}

function scoreNotebook(record: NotebookRecord, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  if (record.id.toLowerCase() === normalized) return 100;
  if (record.url.toLowerCase() === normalized) return 100;
  if (record.aliases.some((alias) => alias.toLowerCase() === normalized)) return 95;
  if (record.name.toLowerCase() === normalized) return 90;
  if (record.name.toLowerCase().includes(normalized)) return 70;
  if (record.tags.some((tag) => tag.toLowerCase() === normalized)) return 65;
  if (record.topics.some((topic) => topic.toLowerCase().includes(normalized))) return 55;
  return 0;
}

export class NotebookLmLibraryStore {
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = join(dataDir, "library.json");
  }

  async list(): Promise<NotebookRecord[]> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as NotebookRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async upsert(input: NotebookUpsertInput): Promise<NotebookRecord> {
    const records = await this.list();
    const url = normalizeNotebookUrl(input.url);
    const id = notebookIdFromUrl(url);
    const existing = records.find((record) => record.id === id || record.url === url);
    const merged: NotebookRecord = {
      id,
      url,
      name: input.name,
      aliases: uniqueSorted([...(existing?.aliases ?? []), ...(input.aliases ?? [])]),
      description: input.description ?? existing?.description ?? "",
      topics: uniqueSorted([...(existing?.topics ?? []), ...(input.topics ?? [])]),
      tags: uniqueSorted([...(existing?.tags ?? []), ...(input.tags ?? [])]),
      source: input.source,
      lastDiscoveredAt: input.discoveredAt ?? existing?.lastDiscoveredAt,
      lastEnrichedAt: input.enrichedAt ?? existing?.lastEnrichedAt,
    };
    const next = existing
      ? records.map((record) => (record.id === existing.id ? merged : record))
      : [...records, merged];
    await this.save(next);
    return merged;
  }

  async resolve(selector: {
    notebook?: string;
    notebookId?: string;
    notebookUrl?: string;
  }): Promise<NotebookResolveResult> {
    const records = await this.list();
    const query = selector.notebookUrl
      ? normalizeNotebookUrl(selector.notebookUrl)
      : selector.notebookId ?? selector.notebook ?? "";
    const scored = records
      .map((record) => ({ record, score: scoreNotebook(record, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return { status: "not_found", candidates: [] };
    if (scored.length === 1 || scored[0]!.score >= scored[1]!.score + 20) {
      return { status: "matched", notebook: scored[0]!.record };
    }
    return { status: "ambiguous", candidates: scored.map((entry) => entry.record) };
  }

  private async save(records: NotebookRecord[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }
}
