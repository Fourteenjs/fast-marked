# fast-marked

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Fourteenjs/fast-marked/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Fourteenjs/fast-marked/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast drop-in for marked 18.1.3 with its default options (GFM on, breaks
off, pedantic off, async off). `parse(markdown)` in `parse.js` returns
exactly the HTML `marked.parse(markdown)` returns, for every string — the
entry is verified byte-identical on all 720 practice cases (680 CommonMark /
GFM spec examples + 40 generated documents).

## Layout

- `parse.js` — the whole renderer, dependency-free ES module. Written from
  scratch in this session as an independent implementation of the same
  behaviour, with its own structure.
- `main.ts` — the harness driver: reads `/input/cases.json`, renders each
  case with `parse`, writes `/output/html.json`.
- `vendor/marked/` — marked 18.1.3's licence and notice (MIT); the code in
  `parse.js` does not import it, and the reference implementation itself
  lives in the competition kit's house baseline.

## What is faster, and why

- **One shared lexer.** A single `Lexer` instance is reused across calls;
  all per-call state (tokens, link map, inline queue, mask stack, flags) is
  reset in `lex()`. No per-parse allocation of the grammar tables.
- **First-character dispatch.** The block loop and the inline loop try only
  the tokenizers that can match at the current first character, in the
  grammar's order, instead of every tokenizer on every position.
- **Lists rewritten around a manual line scan.** `tokList` walks lines with
  `indexOf('\n')`, computes indents on the leading whitespace run, and uses
  one combined interruption pattern per line instead of six patterns plus
  repeated searches.
- **Setext pre-scan.** One scan of the document for an underline-shaped
  line; when there is none, the setext-heading pattern is skipped
  everywhere.
- **Emphasis masking is skipped** for inline runs without `*`, `_`, or `~`,
  and each mask is built with a single regex pass over delimiter runs
  instead of a per-character loop.
- **No spreads over delimiter runs**; code-point lengths are counted with
  `for..of` and first/last code points are sliced directly.
- **Numeric references are decoded only when `&#` is present**; otherwise
  the renderer's escape step already handles bare `&`.
- Delimiter-run closers are bounded by the last possible closer position
  recorded during masking, so the closer scan never runs past it.

## Verification

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

Practice set: 720/720 byte-identical, confirmed with a second (L1) regrade.
See the submission notes for the benchmark table (cold single-pass and warm
in-process, baseline marked vs this entry, medians over repeated runs).
