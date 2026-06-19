import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import { expandHomePath, isPathInsideRoot } from "./roots.js";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation?: boolean;
}

export interface SkillDiagnostic {
  type: string;
  message: string;
  path?: string;
  name?: string;
}

export interface LoadedSkills {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillReadResolution {
  absolutePath: string;
  skill: Skill;
  isSkillFile: boolean;
}

export function loadWorkspaceSkills(config: ServerConfig, cwd: string): LoadedSkills {
  if (!config.skillsEnabled) return { skills: [], diagnostics: [] };

  const roots = [
    join(cwd, ".pi", "skills"),
    join(config.agentDir, "skills"),
    ...config.skillPaths,
  ];
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const seenNames = new Set<string>();

  for (const root of roots) {
    for (const filePath of findSkillFiles(root)) {
      const parsed = parseSkillFile(filePath);
      if (!parsed) {
        diagnostics.push({
          type: "invalid",
          message: "Skill is missing required name or description frontmatter.",
          path: filePath,
        });
        continue;
      }

      if (seenNames.has(parsed.name)) {
        diagnostics.push({
          type: "collision",
          message: `Duplicate skill name ignored: ${parsed.name}`,
          name: parsed.name,
          path: filePath,
        });
        continue;
      }

      seenNames.add(parsed.name);
      skills.push({
        ...parsed,
        filePath,
        baseDir: dirname(filePath),
      });
    }
  }

  return { skills, diagnostics };
}

export function resolveSkillReadPath(
  skills: Skill[],
  activatedSkillDirs: Set<string>,
  inputPath: string,
): SkillReadResolution | undefined {
  const absolutePath = resolve(expandHomePath(inputPath));

  for (const skill of skills) {
    const skillFilePath = resolve(skill.filePath);
    if (absolutePath === skillFilePath) {
      return { absolutePath, skill, isSkillFile: true };
    }
  }

  for (const skill of skills) {
    const baseDir = resolve(skill.baseDir);
    if (!activatedSkillDirs.has(baseDir)) continue;
    if (!isPathInsideRoot(absolutePath, baseDir)) continue;

    return { absolutePath, skill, isSkillFile: false };
  }

  return undefined;
}

export function markSkillActivated(
  activatedSkillDirs: Set<string>,
  skill: Skill,
): void {
  activatedSkillDirs.add(resolve(skill.baseDir));
}

export function formatPathForPrompt(path: string): string {
  const home = resolve(homedir());
  const resolvedPath = resolve(path);

  if (resolvedPath === home) return "~";
  if (resolvedPath.startsWith(`${home}${sep}`)) {
    return `~/${resolvedPath.slice(home.length + 1).split(sep).join("/")}`;
  }

  return resolvedPath.split(sep).join("/");
}

function findSkillFiles(root: string): string[] {
  const resolvedRoot = resolve(root);
  try {
    if (!statSync(resolvedRoot).isDirectory()) return [];
  } catch {
    return [];
  }

  const found: string[] = [];
  const stack = [resolvedRoot];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        found.push(entryPath);
      }
    }
  }

  return found.sort((a, b) => a.localeCompare(b));
}

function parseSkillFile(filePath: string): Pick<Skill, "name" | "description" | "disableModelInvocation"> | undefined {
  const content = readFileSync(filePath, "utf8");
  if (!content.startsWith("---")) return undefined;

  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;

  const fields = new Map<string, string>();
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    fields.set(key, rawValue.replace(/^["']|["']$/g, ""));
  }

  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) return undefined;

  return {
    name,
    description,
    disableModelInvocation: fields.get("disable-model-invocation") === "true",
  };
}
