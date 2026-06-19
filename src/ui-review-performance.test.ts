import assert from "node:assert/strict";
import {
  shouldLoadReviewPayload,
  type ToolResultCard,
} from "./ui/card-types.js";

const reviewCard: ToolResultCard = {
  tool: "show_changes",
  summary: { files: 1, additions: 2, removals: 1 },
  files: [{ path: "src/example.ts", additions: 2, removals: 1 }],
  payload: { patch: "diff --git a/src/example.ts b/src/example.ts\n" },
};

assert.equal(shouldLoadReviewPayload(reviewCard, false), false);
assert.equal(shouldLoadReviewPayload(reviewCard, true), true);

const readCard: ToolResultCard = {
  tool: "read",
  payload: { content: [{ type: "text", text: "hello" }] },
};

assert.equal(shouldLoadReviewPayload(readCard, true), false);
