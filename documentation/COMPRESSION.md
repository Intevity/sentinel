# In-flight tool_result compression

Sentinel's proxy compresses the `.text` of `tool_result` blocks in
`/v1/messages` request bodies before forwarding them to Anthropic. Nothing
else in the request is ever touched: not the `system` prompt, not `tools[]`,
not `cache_control` markers, not assistant or user prose. This document is the
rule reference and the design contract.

## The contract (why every rule looks the way it does)

1. **Deterministic, idempotent, byte-stable.** Claude Code replays the full
   original conversation every turn, and Anthropic's prompt-cache prefix is
   byte-sensitive. Every rule is a pure function: no clock, no randomness, no
   locale, no I/O, no cross-request state, and `rule(rule(x)) === rule(x)`.
   Compressing the same tool_result always yields identical bytes, so the
   cache prefix survives across turns. A rule-set change between Sentinel
   versions recomputes those bytes once at upgrade, rebuilding the prefix one
   time; within a version, replayed turns stay byte-stable.

2. **Lossy means reversible.** Any rule that drops information hands the exact
   dropped bytes to a capture store keyed by `sha256(dropped)[:16]` and embeds
   that id in its elision marker:

   ```
   ... [137 lines elided by Sentinel; retrieve the full output with the sentinel retrieve tool, id="3cc6b9319b440422"] ...
   ```

   With reversible retrieval enabled, the `mcp__sentinel__retrieve` MCP tool
   returns the original bytes for any marker id, so even aggressive
   compression is informationally lossless end-to-end.

3. **Errors always survive.** Log rules never elide a line matching the
   interesting-line pattern (errors, failures, warnings, panics, test
   summaries); JSON sampling always keeps error-shaped items and statistical
   outliers. The benchmark suite asserts error survival per fixture at every
   level ("same FATAL found").

4. **Never grow the body.** A net-expansion guard forwards the original
   verbatim whenever compression would not actually shrink the request.

## Rules

| Rule                       | Target                                | Lossy?       | Mechanism                                                                                                                                                                                   |
| -------------------------- | ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ansi_strip`               | any text                              | lossless     | strips ANSI color/cursor/OSC sequences                                                                                                                                                      |
| `collapse_blank_lines`     | any text                              | lossless     | runs of blank lines fold to one                                                                                                                                                             |
| `collapse_duplicate_lines` | any text                              | lossless-ish | byte-identical adjacent lines fold to one                                                                                                                                                   |
| `json_minify`              | JSON                                  | lossless     | whitespace-only minification (byte-exact for numbers, key order, escapes)                                                                                                                   |
| `json_tabular`             | homogeneous JSON arrays               | lossless     | `{_sentinelTable:{columns,rows}}` fold; uniform nested objects flatten to dotted columns (`meta.region`)                                                                                    |
| `json_sample`              | large JSON arrays                     | reversible   | keeps head/tail items, every error-shaped item, and sigma outliers; emits per-field `stats` (count/min/max/mean/median/stdev) for the dropped population; capture = the full original array |
| `stack_trace_collapse`     | stack traces                          | reversible   | long frame runs keep first/last frames                                                                                                                                                      |
| `log_error_extract`        | recognized build/test logs            | reversible   | keeps errors/warnings/summaries with context, elides passing noise                                                                                                                          |
| `log_near_dup_fold`        | repetitive logs                       | reversible   | normalizes volatile fields (timestamps, UUIDs, hex, paths, numbers) to a template; adjacent same-template runs fold to first line + count                                                   |
| `log_truncate`             | very long output                      | reversible   | head/tail keep, middle elided                                                                                                                                                               |
| `search_extract`           | grep/ripgrep/Glob output              | reversible   | groups `path:line:content` by file; caps files (heaviest kept) and matches per file (first/last kept); bare path lists head/tail capped                                                     |
| `diff_trim`                | unified diffs                         | reversible   | drops lockfile hunk bodies and whitespace-only hunks; caps files and hunks per file; trims leading/trailing context; never rewrites a kept line (mode/index/`@@` lines byte-identical)      |
| `html_extract`             | HTML documents/fragments              | reversible   | strips script/style/head/comments, keeps text + img alt, decodes entities; capture = the entire original HTML                                                                               |
| `intra_body_fold`          | duplicate tool_results in one request | reversible   | byte-identical blocks ≥ 1 KiB fold to a pointer at the first occurrence                                                                                                                     |

### Content routing

Non-JSON payloads are routed by shape before the generic log chain runs:

```
JSON?  -> sample -> tabular -> minify
diff?  -> diff_trim -> truncate           (skips the log chain: +/- lines are not log noise)
search? -> search_extract -> truncate     (skips the log chain)
HTML?  -> html_extract -> generic chain   (extraction yields prose)
else   -> blank/dup -> near-dup fold -> stack collapse -> error extract -> truncate
```

Detection order is deliberate: diff before search (hunk headers contain
`path:line` lookalikes), search before HTML (shape test is stricter than tag
density). Detectors are tuned against false positives — source code, syslog
lines, YAML, and TypeScript generics all ride through untouched (the test
suites assert this).

## Tiers

| Option                                      | conservative | moderate        | aggressive     |
| ------------------------------------------- | ------------ | --------------- | -------------- |
| ansi / blank / minify                       | on           | on              | on             |
| duplicate-line collapse                     | off          | on              | on             |
| stack collapse (frames kept)                | off          | 8               | 4              |
| error extract (trigger lines)               | off          | 200             | 80             |
| truncate (trigger lines)                    | off          | 300             | 120            |
| tabular fold                                | off          | on              | on             |
| sampling (minRows / head / tail / sigma)    | off          | 120 / 8 / 8 / 3 | 30 / 3 / 3 / 2 |
| diff trim (files / hunks / context)         | off          | 20 / 10 / 3     | 8 / 4 / 1      |
| search extract (trigger / files / per-file) | off          | 60 / 30 / 20    | 30 / 12 / 6    |
| near-dup fold (min run)                     | off          | 5               | 3              |
| HTML extract                                | off          | on              | on             |
| intra-body fold                             | off          | on              | on             |

Conservative is the lossless tier: nothing is removed, ever. Moderate enables
every reversible rule with gentle thresholds. Aggressive is the same rule set
with the tightest caps.

## Measured results

`pnpm bench:compression` runs deterministic, checked-in fixtures mirroring
headroom's published workload classes and prints the savings table. As of the
fixtures landing (June 2026), reversible mode on:

| Fixture          | bytes in | moderate | aggressive |
| ---------------- | -------- | -------- | ---------- |
| sre-incident-log | 238,368  | 99.6%    | 99.6%      |
| build-log        | 71,004   | 98.0%    | 98.0%      |
| html-page        | 69,471   | 94.6%    | 98.0%      |
| json-api-array   | 149,014  | 96.8%    | 97.8%      |
| code-search      | 190,095  | 85.7%    | 93.6%      |
| glob-list        | 21,441   | 87.1%    | 93.3%      |
| unified-diff     | 46,007   | 82.1%    | 93.4%      |

The spec asserts a savings floor ~5 points under each measured value, error
survival per fixture, no-expansion at every level, and idempotency — all on
every CI run. Floors only ratchet up; lowering one is a compression
regression and needs the same scrutiny as a coverage-threshold drop.

**Honest framing:** these are per-payload numbers on ideal workloads, the same
basis headroom's "up to 95%" uses (their own limitations doc reports a 4.8%
median across real production traffic, because short conversational turns and
source code pass through any such tool uncompressed). Across a real mixed
conversation your realized average is lower; the Optimize tab reports it
truthfully from the bytes actually removed.

## What Sentinel deliberately does not do

- **Touch `tools[]` or the system prompt.** Tool-definition slimming has no
  runtime retrieve path (irreversible) and collides with the code-mode
  Context feature's mission. Cache-alignment tricks that reorder `tools[]`
  mutate the schema for a cache benefit, not a token one.
- **Stale-history elision / cross-request dedup / adaptive sizing.** Anything
  whose output for already-sent content can change later breaks the cache
  prefix and is net-negative.
- **AST-aware code compression / ML content routing.** Tree-sitter and ONNX
  models cannot bundle into the single-binary sidecar — and code compression
  is off by default even in the tools that ship it, because mangling source
  is how you turn a 40% saving into a wrong edit.
