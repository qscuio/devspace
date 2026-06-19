import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeNotebookUrl } from "./notebooklm-library.js";

export interface DiscoveredNotebookCard {
  name: string;
  url: string;
}

export interface NotebookLmDiscoverer {
  discover(input: { limit: number }): Promise<DiscoveredNotebookCard[]>;
}

export interface BrowserNotebookLmDiscovererOptions {
  profileDir?: string;
  headless?: boolean;
  timeoutMs?: number;
}

interface RawNotebookAnchor {
  name: string;
  url: string;
}

export class BrowserNotebookLmDiscoverer implements NotebookLmDiscoverer {
  constructor(private readonly options: BrowserNotebookLmDiscovererOptions = {}) {}

  async discover(input: { limit: number }): Promise<DiscoveredNotebookCard[]> {
    const { chromium } = await import("patchright");
    const profileDir = this.options.profileDir ?? defaultNotebookLmChromeProfileDir();
    const statePath = defaultNotebookLmBrowserStatePath();
    const timeout = this.options.timeoutMs ?? 45_000;
    const browserChannel = process.env.DEVSPACE_NOTEBOOKLM_BROWSER_CHANNEL?.trim();
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: this.options.headless ?? true,
      ...(browserChannel ? { channel: browserChannel } : {}),
      ...(existsSync(statePath) ? { storageState: statePath } : {}),
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: "Europe/Berlin",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto("https://notebooklm.google.com/", {
        waitUntil: "domcontentloaded",
        timeout,
      });
      await page.waitForTimeout(1500);

      const currentUrl = page.url();
      if (currentUrl.includes("accounts.google.com")) {
        throw new Error("NotebookLM browser profile is not authenticated.");
      }

      const cards = normalizeDiscoveredNotebookCards([
        ...await extractNotebookCardsFromPage(page, input.limit),
        ...extractNotebookCardsFromHtml(await page.content(), "https://notebooklm.google.com"),
      ]);
      return cards.slice(0, input.limit);
    } finally {
      await context.close();
    }
  }
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

export function normalizeDiscoveredNotebookCards(cards: RawNotebookAnchor[]): DiscoveredNotebookCard[] {
  const seen = new Set<string>();
  const normalized: DiscoveredNotebookCard[] = [];

  for (const card of cards) {
    let url: string;
    try {
      url = normalizeNotebookUrl(card.url);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;

    const id = notebookIdFromUrl(url);
    const name = card.name.replace(/\s+/g, " ").trim() || `Notebook ${id}`;
    seen.add(url);
    normalized.push({ name, url });
  }

  return normalized;
}

async function extractNotebookCardsFromPage(
  page: {
    evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
    waitForTimeout(ms: number): Promise<void>;
  },
  limit: number,
): Promise<RawNotebookAnchor[]> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const count = await page.evaluate(() => document.querySelectorAll('a[href*="/notebook/"]').length);
    if (count >= limit) break;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
  }

  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/notebook/"]')).map((anchor) => ({
      url: anchor.href,
      name: [
        anchor.getAttribute("aria-label"),
        anchor.textContent,
        anchor.querySelector("[title]")?.getAttribute("title"),
      ].find((value) => value?.trim())?.trim() ?? "",
    })),
  );
}

function defaultNotebookLmChromeProfileDir(): string {
  if (process.env.DEVSPACE_NOTEBOOKLM_CHROME_PROFILE_DIR) {
    return process.env.DEVSPACE_NOTEBOOKLM_CHROME_PROFILE_DIR;
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "notebooklm-mcp", "chrome_profile");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "notebooklm-mcp", "chrome_profile");
  }
  return join(homedir(), ".local", "share", "notebooklm-mcp", "chrome_profile");
}

export function defaultNotebookLmBrowserStatePath(): string {
  if (process.env.DEVSPACE_NOTEBOOKLM_BROWSER_STATE_PATH) {
    return process.env.DEVSPACE_NOTEBOOKLM_BROWSER_STATE_PATH;
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "notebooklm-mcp", "browser_state", "state.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "notebooklm-mcp", "browser_state", "state.json");
  }
  return join(homedir(), ".local", "share", "notebooklm-mcp", "browser_state", "state.json");
}

function notebookIdFromUrl(value: string): string {
  return new URL(value).pathname.split("/").filter(Boolean).at(-1) ?? "unknown";
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
