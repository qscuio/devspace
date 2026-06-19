import { existsSync } from "node:fs";

export interface ShellConfig {
  shell: string;
  args: string[];
}

export function getShellConfig(): ShellConfig {
  if (process.platform !== "win32") {
    return { shell: "/bin/bash", args: ["-c"] };
  }

  const candidates = [
    process.env.DEVSPACE_SHELL_PATH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return { shell: candidate, args: ["-c"] };
  }

  return { shell: "bash.exe", args: ["-c"] };
}
