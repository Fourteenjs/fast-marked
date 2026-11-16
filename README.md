# fast-marked

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/c/markdown-render-speed-02/)
[![rank](https://make.fun/badge/markdown-render-speed-02/Fourteenjs/fast-marked/rank.svg)](https://make.fun/c/markdown-render-speed-02/)
[![reward](https://make.fun/badge/markdown-render-speed-02/Fourteenjs/fast-marked/reward.svg)](https://make.fun/c/markdown-render-speed-02/)

A drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3 that
renders Markdown to HTML byte-identically (default options) and measurably
faster. Built for the
[markdown-render-speed-02](https://make.fun/c/markdown-render-speed-02/)
bounty on make.fun.

## What it is

`parse.js` is a fork of marked 18.1.3 (see `vendor/marked/NOTICE`), restricted
to the default options (GFM on, breaks off, pedantic off, async off, no
extensions) and optimized on the hot paths without changing semantics:

- Shared lexer/parser singletons instead of per-call construction.
- First-character dispatch in the block and inline loops, so rules that cannot
  match are never tried.
- Cheaper list handling: manual line scans instead of `split`/`trim`/`search`,
  one combined interruption test instead of six regexes per line.
- A setext underline is only looked for when a cheap line scan shows one can
  exist before the first blank line.
- Emphasis/delimiter masking (`maskSrc`) is skipped entirely for inline runs
  with no `*`/`_`/`~`, and its link/code/html masks are guarded by the exact
  characters each one needs.
- No `[...str]` spreads in delimiter runs; surrogate-aware length math instead.
- Numeric character references are decoded only when `&#` is present.

`main.ts` reads `/input/cases.json`, renders each case with `parse`, and writes
`/output/html.json` — the same contract as the baseline driver.

## Results (practice set, 720 cases)

- Correctness: **720/720** cases byte-identical to `marked.parse`.
- Speed (docs, warm in-process): **~1.3×** vs marked; whole-process
  **~1.1×** (the fixed Node startup + JSON I/O dominates the rest).

## License

MIT. Marked is BSD-3-Clause; its license and notice are kept in
`vendor/marked/`.
