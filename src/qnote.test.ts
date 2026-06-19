import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQnoteStore } from "./qnote.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function createRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "devspace-qnote-test-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "devspace@example.com"]);
  git(dir, ["config", "user.name", "DevSpace Test"]);
  await mkdir(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "existing.md"), "# Existing\n\nneedle content\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

{
  const dir = await createRepo();
  const store = createQnoteStore({
    enabled: true,
    dir,
    repoUrl: "",
    branch: "main",
    autoPush: false,
    allowedDirs: ["knowledge", "lessons", "skills"],
  });

  const status = await store.status();
  assert.equal(status.exists, true);
  assert.equal(status.clean, true);
  assert.equal(status.branch, "main");

  const search = await store.search({ query: "needle", limit: 5 });
  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0]?.path, "knowledge/existing.md");

  const read = await store.read({ path: "knowledge/existing.md" });
  assert.match(read.content, /needle content/);
}

{
  const dir = await createRepo();
  const store = createQnoteStore({
    enabled: true,
    dir,
    repoUrl: "",
    branch: "main",
    autoPush: false,
    allowedDirs: ["knowledge", "lessons", "skills"],
  });

  const result = await store.capture({
    destination: "knowledge/test-capture.md",
    title: "Test Capture",
    body: "This is distilled knowledge from a coding session.",
    tags: ["codex", "lesson"],
    sourceId: "codex:test-session",
    sync: false,
    push: false,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.path, "knowledge/test-capture.md");
  assert.equal(existsSync(join(dir, "knowledge", "test-capture.md")), true);
  const content = readFileSync(join(dir, "knowledge", "test-capture.md"), "utf8");
  assert.match(content, /source_id: codex:test-session/);
  assert.match(content, /content_hash:/);
  assert.match(content, /This is distilled knowledge/);
  assert.equal(git(dir, ["status", "--porcelain"]), "");

  const duplicate = await store.capture({
    destination: "knowledge/duplicate.md",
    title: "Duplicate",
    body: "This is distilled knowledge from a coding session.",
    sync: false,
    push: false,
  });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.duplicatePath, "knowledge/test-capture.md");
}

{
  const dir = await createRepo();
  const store = createQnoteStore({
    enabled: true,
    dir,
    repoUrl: "",
    branch: "main",
    autoPush: false,
    allowedDirs: ["knowledge"],
  });

  await assert.rejects(
    () => store.read({ path: "../outside.md" }),
    /outside qnote repository/,
  );
  await assert.rejects(
    () => store.capture({
      destination: "skills/not-allowed.md",
      title: "Nope",
      body: "not allowed",
      sync: false,
      push: false,
    }),
    /not in an allowed qnote directory/,
  );
}

{
  const dir = await createRepo();
  writeFileSync(join(dir, "knowledge", "dirty.md"), "uncommitted\n");
  const store = createQnoteStore({
    enabled: true,
    dir,
    repoUrl: "",
    branch: "main",
    autoPush: false,
    allowedDirs: ["knowledge"],
  });

  await assert.rejects(
    () => store.capture({
      destination: "knowledge/blocked.md",
      title: "Blocked",
      body: "should not write over dirty worktree",
      sync: false,
      push: false,
    }),
    /qnote checkout is dirty/,
  );
}
