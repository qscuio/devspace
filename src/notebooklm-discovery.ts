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
    const url = normalizeNotebookUrl(new URL(match[1]!, baseUrl).toString());
    if (seen.has(url)) continue;

    const name = match[2]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!name) continue;

    seen.add(url);
    cards.push({ name, url });
  }

  return cards;
}
