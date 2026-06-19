import assert from "node:assert/strict";
import { extractNotebookCardsFromHtml } from "./notebooklm-discovery.js";

const html = `
  <a href="/notebook/abc"><span>Broadcom DNX SDK</span></a>
  <a href="https://notebooklm.google.com/notebook/def?pli=1"><span>StrataXGS</span></a>
  <a href="/notebook/abc"><span>Broadcom DNX SDK</span></a>
`;

const cards = extractNotebookCardsFromHtml(html, "https://notebooklm.google.com");
assert.deepEqual(cards, [
  { name: "Broadcom DNX SDK", url: "https://notebooklm.google.com/notebook/abc" },
  { name: "StrataXGS", url: "https://notebooklm.google.com/notebook/def" },
]);
