/**
 * Compression benchmark: per-content-type savings floors over deterministic,
 * checked-in fixtures mirroring headroom's published workload classes
 * (github.com/chopratejas/headroom: JSON APIs, build logs, SRE incident logs,
 * code search, diffs, HTML pages).
 *
 * This is a NORMAL vitest spec, not a `vitest bench`: every rule is
 * deterministic, so the savings percentages are exactly stable and the floors
 * below are non-flaky regression guards. Anything that weakens a rule shows up
 * here as a hard failure. The floors are pinned ~5 points below the measured
 * value at the time each fixture landed; ratchet them up deliberately, never
 * down (a floor drop is a compression regression and needs the same scrutiny
 * as a coverage-threshold drop).
 *
 * Run `pnpm bench:compression` (or set SENTINEL_BENCH_TABLE=1) to print the
 * full per-fixture savings table.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { compressToolResultText } from '../src/optimize/compress/tiers.js';
import type { OnElide } from '../src/optimize/compress/text-rules.js';
import { byteLen, estimateTokensFromBytes, hashOriginal } from '../src/optimize/compress/types.js';
import type { CompressionLevel } from '../src/optimize/compress/types.js';
import { buildJsonApiArray } from './fixtures/json-api-array.js';
import { buildBuildLog } from './fixtures/build-log.js';
import { buildSreIncidentLog } from './fixtures/sre-incident-log.js';
import { buildCodeSearch, buildGlobList } from './fixtures/code-search.js';
import { buildUnifiedDiff } from './fixtures/unified-diff.js';
import { buildHtmlPage } from './fixtures/html-page.js';

/** Reversible mode ON (the recommended production configuration): markers
 *  carry the retrieval hint, so measured savings are the honest, slightly
 *  smaller number. Plain closure, no mocks. */
const onElide: OnElide = (_rule, elided) => hashOriginal(elided);

interface Fixture {
  name: string;
  build: () => string;
  /** Minimum % saved (1 - out/in bytes), per level. Conservative has no floor
   *  beyond the universal no-expansion guarantee. */
  floors: { moderate: number; aggressive: number };
  /** Substrings that MUST survive compression at every level: the errors and
   *  failure signals a reader needs (headroom's own benchmark caption is
   *  "same FATAL found" — this is our enforcement of the same property). */
  mustKeep?: string[];
}

// Floors are ~5 points below the values measured when each fixture landed
// (June 2026: json-api 96.8/97.8, build-log 98/98, sre-log 99.6/99.6,
// code-search 85.7/93.6, glob-list 87.1/93.3, unified-diff 82.1/93.4,
// html-page 94.6/98). Headroom's published per-content-type bests, for
// comparison: build logs 93.9, code search 92, SRE logs 92, HTML 94.9.
const FIXTURES: Fixture[] = [
  {
    name: 'json-api-array',
    build: buildJsonApiArray,
    floors: { moderate: 91, aggressive: 92 },
    // The planted "failed" statuses are error items: sampling must keep them.
    mustKeep: ['"failed"'],
  },
  {
    name: 'build-log',
    build: buildBuildLog,
    floors: { moderate: 93, aggressive: 93 },
    mustKeep: ['error[E0308]: mismatched types', 'warning: unused variable: `retries`'],
  },
  {
    name: 'sre-incident-log',
    build: buildSreIncidentLog,
    floors: { moderate: 94, aggressive: 94 },
    mustKeep: [
      'ERROR upstream connection refused host=db-primary-3',
      'ConnectionError: pool exhausted (32/32 in use)',
    ],
  },
  { name: 'code-search', build: buildCodeSearch, floors: { moderate: 80, aggressive: 88 } },
  { name: 'glob-list', build: buildGlobList, floors: { moderate: 82, aggressive: 88 } },
  { name: 'unified-diff', build: buildUnifiedDiff, floors: { moderate: 77, aggressive: 88 } },
  { name: 'html-page', build: buildHtmlPage, floors: { moderate: 89, aggressive: 93 } },
];

const LEVELS: CompressionLevel[] = ['conservative', 'moderate', 'aggressive'];

interface Row {
  fixture: string;
  level: CompressionLevel;
  bytesIn: number;
  bytesOut: number;
  pctSaved: number;
  estTokensIn: number;
  estTokensOut: number;
  rules: string;
}

const rows: Row[] = [];

function measure(name: string, text: string, level: CompressionLevel): Row {
  const r = compressToolResultText(text, level, onElide);
  const bytesIn = byteLen(text);
  const bytesOut = byteLen(r.text);
  const row: Row = {
    fixture: name,
    level,
    bytesIn,
    bytesOut,
    pctSaved: Math.round((1 - bytesOut / bytesIn) * 1000) / 10,
    estTokensIn: estimateTokensFromBytes(bytesIn),
    estTokensOut: estimateTokensFromBytes(bytesOut),
    rules: Object.keys(r.perRule).join('+'),
  };
  rows.push(row);
  return row;
}

describe('compression benchmark (per-content-type savings floors)', () => {
  for (const f of FIXTURES) {
    describe(f.name, () => {
      const text = f.build();

      it('never expands at any level', () => {
        for (const level of LEVELS) {
          const r = compressToolResultText(text, level, onElide);
          expect(byteLen(r.text)).toBeLessThanOrEqual(byteLen(text));
        }
      });

      if (f.mustKeep) {
        it('keeps every error/failure signal at every level', () => {
          for (const level of LEVELS) {
            const r = compressToolResultText(text, level, onElide);
            for (const needle of f.mustKeep ?? []) {
              expect(r.text).toContain(needle);
            }
          }
        });
      }

      it('meets the moderate savings floor', () => {
        const row = measure(f.name, text, 'moderate');
        expect(row.pctSaved).toBeGreaterThanOrEqual(f.floors.moderate);
      });

      it('meets the aggressive savings floor', () => {
        const row = measure(f.name, text, 'aggressive');
        expect(row.pctSaved).toBeGreaterThanOrEqual(f.floors.aggressive);
      });

      it('is deterministic and idempotent on this workload', () => {
        for (const level of LEVELS) {
          const once = compressToolResultText(text, level, onElide);
          const again = compressToolResultText(text, level, onElide);
          expect(again.text).toBe(once.text);
          const twice = compressToolResultText(once.text, level, onElide);
          expect(twice.text).toBe(once.text);
        }
      });
    });
  }

  // Conservative is measured for the table but has no floor: its contract is
  // losslessness, not savings.
  it('records conservative rows for the table', () => {
    for (const f of FIXTURES) {
      const row = measure(f.name, f.build(), 'conservative');
      expect(row.bytesOut).toBeLessThanOrEqual(row.bytesIn);
    }
  });
});

afterAll(() => {
  if (!process.env['SENTINEL_BENCH_TABLE']) return;
  const order: Record<CompressionLevel, number> = { conservative: 0, moderate: 1, aggressive: 2 };
  const sorted = [...rows].sort(
    (a, b) => a.fixture.localeCompare(b.fixture) || order[a.level] - order[b.level],
  );
  console.table(
    sorted.map((r) => ({
      fixture: r.fixture,
      level: r.level,
      'bytes in': r.bytesIn,
      'bytes out': r.bytesOut,
      '% saved': r.pctSaved,
      'tok in': r.estTokensIn,
      'tok out': r.estTokensOut,
      rules: r.rules,
    })),
  );
});
