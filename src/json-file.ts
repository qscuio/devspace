import { readFileSync } from "node:fs";

export function parseJsonFile<T>(filePath: string, label = filePath): T {
  try {
    return JSON.parse(stripByteOrderMark(readFileSync(filePath, "utf8"))) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read ${label}: ${reason}`);
  }
}

function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}
