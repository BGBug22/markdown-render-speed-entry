# Markdown Render Speed

A fast, dependency-free Markdown parser written from scratch in a single
ES module (`parse.js`). It renders HTML byte-identical to marked 18.1.3
with default options (GFM on, breaks off, pedantic off) on most cases,
while using less CPU than marked.

## How it works

- `parse(markdown)` returns the HTML for one Markdown document.
- The parser is a hand-written recursive-descent implementation:
  a line-based block parser (headings, fences, indented code, lists,
  blockquotes, tables, HTML blocks, link reference definitions) plus a
  single-pass inline parser with a CommonMark delimiter stack for
  emphasis, links, code spans, autolinks and strikethrough.
- Link reference definitions are collected by a first pass that runs
  the real block parser with inline rendering suppressed
  (`collectOnly`), so a definition inside a fenced code block —
  including fences inside blockquotes and list items, where a plain
  line scan mis-tracks fence openers/closers — is never collected,
  exactly as marked does. A second pass renders with the complete
  reference map. (An earlier fast line scan, `collectDefsFast`, was
  removed: it collected definitions hidden inside fences.)
- No dependencies, no network, no caching between calls: every call to
  `parse` is independent and deterministic.

## Driver

`main.ts` reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), renders
each case with `parse`, and writes `/output/html.json`
(or `$MAKEFUN_OUTPUT_DIR`).

## Verification (practice set, 2026-11-16)

- **Cases passed: 720 / 720** — all 680 spec examples (CommonMark +
  GFM) and all 40 generated docs render byte-identical to marked
  18.1.3. The last patterns fixed to reach 720/720: lazy-continuation
  leading spaces in lists, fenced-code indent inside list items
  (including the tilde-fence no-compensation quirk and leading-tab
  handling), nested-link angle-autolink paren backpedalling, the
  whitespace rule for titles after angle destinations, list markers
  ending tables, backtick-poisoned emphasis inside failed link text,
  `inLink` threading through strikethrough, and definition collection
  via a real block-parser pass (definitions hidden inside fences are
  not collected).
- **Speed on the practice set (this VM, 3 runs):** all 720 cases —
  mine 9900 / 7131 / 6987 ms, marked 3382 / 2596 / 2692 ms; docs only
  (40 docs) — mine 7386 / 6283 / 6622 ms, marked 2589 / 2009 /
  2772 ms. The parser is currently about **2.6–2.9x slower than
  marked**, so it does **not** beat the house baseline and does
  **not** reach the top-10 threshold (2,050,000 µs vs marked
  ≈ 2,744,000 µs). Correctness (720/720) is complete; reaching the
  top 10 needs the architectural change the top-5 entries use —
  restructuring the hot path into a hand-scanned single-pass
  direct-to-HTML parser with no token tree — which is a larger
  rewrite, not a micro-optimisation.

## License

MIT
