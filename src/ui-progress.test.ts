import assert from "node:assert/strict";
import {
  progressActionLabel,
  progressDetailLabel,
  type ToolName,
} from "./ui/card-types.js";

assert.equal(progressActionLabel("bash"), "Running Bash");
assert.equal(progressActionLabel("read"), "Reading File");
assert.equal(progressActionLabel("show_changes"), "Preparing Review");
assert.equal(progressActionLabel(undefined), "Running Tool");

assert.equal(
  progressDetailLabel("bash", { command: "npm test -- --runInBand" }),
  "npm test -- --runInBand",
);
assert.equal(
  progressDetailLabel("read", { path: "src/ui/workspace-app.tsx" }),
  "src/ui/workspace-app.tsx",
);
assert.equal(
  progressDetailLabel("edit" as ToolName, { path: "src/server.ts" }),
  "src/server.ts",
);
assert.equal(progressDetailLabel("bash", {}), "Waiting for tool progress...");
