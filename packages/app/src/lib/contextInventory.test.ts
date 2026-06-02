import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatTokens,
  totalEstimatedTokens,
  truncatePath,
  visibleMcpServers,
} from './contextInventory.js';
import {
  estimateTokensFromBytes,
  type ContextInventory,
  type ContextInventoryMcpServer,
} from '@claude-sentinel/shared';

const EMPTY_INV: ContextInventory = {
  mcpServers: [],
  claudeMdFiles: [],
  memoryDirs: [],
  plugins: [],
  globalSubagents: [],
};

function mcp(overrides: Partial<ContextInventoryMcpServer>): ContextInventoryMcpServer {
  return {
    project: '/p',
    name: 'srv',
    enabled: true,
    recent7d: { calls: 0, bytesIn: 0, bytesOut: 0, estimatedTokens: 0 },
    ...overrides,
  };
}

describe('formatBytes', () => {
  it('renders B / KB / MB at the right thresholds', () => {
    expect(formatBytes(0)).toBe('0B');
    expect(formatBytes(1023)).toBe('1023B');
    expect(formatBytes(1024)).toBe('1.0KB');
    expect(formatBytes(50_000)).toBe('48.8KB');
    expect(formatBytes(2_500_000)).toBe('2.4MB');
  });
});

describe('formatTokens', () => {
  it('renders ~N for sub-1000', () => {
    expect(formatTokens(0)).toBe('~0');
    expect(formatTokens(950)).toBe('~950');
  });
  it('renders ~N.NK for thousands', () => {
    expect(formatTokens(2_500)).toBe('~2.5K');
  });
  it('renders ~N.NNM for millions', () => {
    expect(formatTokens(2_500_000)).toBe('~2.50M');
  });
});

describe('truncatePath', () => {
  it('preserves short paths verbatim', () => {
    expect(truncatePath('/a/b')).toBe('/a/b');
    expect(truncatePath('foo/bar')).toBe('foo/bar');
  });
  it('drops to last two segments on long paths', () => {
    expect(truncatePath('/Users/jeff/github/foo/bar')).toBe('…/foo/bar');
  });
  it('handles trailing slashes', () => {
    expect(truncatePath('/a/b/c/')).toBe('…/b/c');
  });
});

describe('totalEstimatedTokens', () => {
  it('returns 0 for an empty inventory', () => {
    expect(totalEstimatedTokens(EMPTY_INV)).toBe(0);
  });

  it('sums MCP tokens directly', () => {
    const inv: ContextInventory = {
      ...EMPTY_INV,
      mcpServers: [
        mcp({ recent7d: { calls: 1, bytesIn: 0, bytesOut: 0, estimatedTokens: 1000 } }),
        mcp({ recent7d: { calls: 1, bytesIn: 0, bytesOut: 0, estimatedTokens: 500 } }),
      ],
    };
    expect(totalEstimatedTokens(inv)).toBe(1500);
  });

  it('converts CLAUDE.md and memory bytes via the shared ruler', () => {
    const inv: ContextInventory = {
      ...EMPTY_INV,
      claudeMdFiles: [{ path: '/a', sizeBytes: 4000, scope: 'global' }],
      memoryDirs: [{ projectId: 'p', fileCount: 1, totalBytes: 8000 }],
    };
    expect(totalEstimatedTokens(inv)).toBe(estimateTokensFromBytes(12_000));
  });
});

describe('visibleMcpServers', () => {
  it('keeps enabled servers regardless of recent calls', () => {
    const out = visibleMcpServers([
      mcp({ enabled: true, recent7d: { calls: 0, bytesIn: 0, bytesOut: 0, estimatedTokens: 0 } }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps disabled servers when they have recent activity', () => {
    const out = visibleMcpServers([
      mcp({ enabled: false, recent7d: { calls: 3, bytesIn: 0, bytesOut: 0, estimatedTokens: 0 } }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('drops disabled servers with no recent activity', () => {
    const out = visibleMcpServers([
      mcp({ enabled: false, recent7d: { calls: 0, bytesIn: 0, bytesOut: 0, estimatedTokens: 0 } }),
    ]);
    expect(out).toHaveLength(0);
  });
});
