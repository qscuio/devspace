import { normalizeNotebookUrl } from "./notebooklm-library.js";

export interface DiscoveredNotebookCard {
  name: string;
  url: string;
}

export interface NotebookLmDiscoverer {
  discover(input: { limit: number }): Promise<DiscoveredNotebookCard[]>;
}

export function extractNotebookCardsFromHtml(html: string, baseUrl: string): DiscoveredNotebookCard[] {
  const anchorPattern = /<a\b[^>]*href=["']([^"']*\/notebook\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const cards: DiscoveredNotebookCard[] = [];

  for (const match of html.matchAll(anchorPattern)) {
    let url: string;
    try {
      url = normalizeNotebookUrl(new URL(match[1]!, baseUrl).toString());
    } catch {
      continue;
    }
    if (seen.has(url)) continue;

    const name = decodeHtmlEntities(
      match[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    );
    if (!name) continue;

    seen.add(url);
    cards.push({ name, url });
  }

  return cards;
}

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, key: string) => {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("#x")) {
      return decodeCodePoint(Number.parseInt(normalized.slice(2), 16)) ?? entity;
    }
    if (normalized.startsWith("#")) {
      return decodeCodePoint(Number.parseInt(normalized.slice(1), 10)) ?? entity;
    }
    return entities[normalized] ?? entity;
  }).replace(/\s+/g, " ").trim();
}

function decodeCodePoint(value: number): string | undefined {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return undefined;
  return String.fromCodePoint(value);
}
