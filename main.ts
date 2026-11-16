// Branding: README carries the make.fun badges for this bounty.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";

// Read the whole set once, render each case in order with parse, and
// write the HTML array. map() keeps the output aligned with the input
// order. parse is deterministic and stateless between calls: it runs
// the block parser twice per document (a first pass that collects
// link reference definitions with the real block structure, so a
// definition inside a fenced code block is never collected, then a
// rendering pass with the complete reference map), so the two graded
// executions produce byte-identical output.
const cases: { id: string; markdown: string }[] = JSON.parse(
  readFileSync(`${inputDir}/cases.json`, "utf8"),
);

if (!Array.isArray(cases)) {
  throw new Error("cases.json must contain a JSON array of cases");
}

const html: string[] = cases.map((c) => {
  if (typeof c.markdown !== "string") {
    throw new Error(`case ${String(c.id)} has no markdown string`);
  }
  return parse(c.markdown);
});

mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/html.json`, JSON.stringify(html));
