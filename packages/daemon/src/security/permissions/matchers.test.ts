import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import {
  globToRegex,
  tokenize,
  splitPipeline,
  stripWrappers,
  expandBashCommand,
  matchBash,
  matchPath,
  matchWeb,
  matchMcpTool,
  matchFallback,
  isPathTool,
  isWebTool,
} from './matchers.js';

describe('globToRegex', () => {
  it('matches literal strings', () => {
    expect(globToRegex('foo').test('foo')).toBe(true);
    expect(globToRegex('foo').test('bar')).toBe(false);
  });
  it('anchors both ends', () => {
    expect(globToRegex('foo').test('foobar')).toBe(false);
  });
  it('escapes regex metacharacters', () => {
    expect(globToRegex('a.b').test('a.b')).toBe(true);
    expect(globToRegex('a.b').test('axb')).toBe(false);
  });
  it('translates * to .* in non-path mode', () => {
    expect(globToRegex('npm *').test('npm install')).toBe(true);
    expect(globToRegex('npm *').test('npm')).toBe(false);
  });
  it('translates ** to .* (greedy)', () => {
    expect(globToRegex('/src/**/*.ts', { pathMode: true }).test('/src/a/b/foo.ts')).toBe(true);
  });
  it('path-mode * does NOT cross /', () => {
    expect(globToRegex('/src/*.ts', { pathMode: true }).test('/src/a/b/foo.ts')).toBe(false);
    expect(globToRegex('/src/*.ts', { pathMode: true }).test('/src/foo.ts')).toBe(true);
  });
  it('? matches a single char', () => {
    expect(globToRegex('a?c').test('abc')).toBe(true);
    expect(globToRegex('a?c').test('ac')).toBe(false);
  });
  it('supports literal escape via backslash', () => {
    expect(globToRegex('foo\\*bar').test('foo*bar')).toBe(true);
    expect(globToRegex('foo\\*bar').test('fooXbar')).toBe(false);
  });
});

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('npm test')).toEqual(['npm', 'test']);
  });
  it('preserves double-quoted segments', () => {
    expect(tokenize('echo "hello world"')).toEqual(['echo', 'hello world']);
  });
  it('preserves single-quoted segments', () => {
    expect(tokenize("echo 'hi there'")).toEqual(['echo', 'hi there']);
  });
  it('handles escaped double quote inside double quotes', () => {
    expect(tokenize('echo "say \\"hi\\""')).toEqual(['echo', 'say "hi"']);
  });
});

describe('splitPipeline', () => {
  it('splits on |', () => {
    expect(splitPipeline('cat foo | grep bar')).toEqual(['cat foo', 'grep bar']);
  });
  it('splits on &&', () => {
    expect(splitPipeline('a && b')).toEqual(['a', 'b']);
  });
  it('splits on ||', () => {
    expect(splitPipeline('a || b')).toEqual(['a', 'b']);
  });
  it('splits on ;', () => {
    expect(splitPipeline('a ; b')).toEqual(['a', 'b']);
  });
  it('does not split inside quotes', () => {
    expect(splitPipeline('echo "a | b"')).toEqual(['echo "a | b"']);
  });
  it('splits on & when not paired', () => {
    expect(splitPipeline('a & b')).toEqual(['a', 'b']);
  });
});

describe('stripWrappers', () => {
  it('strips sudo', () => {
    expect(stripWrappers('sudo npm test')).toBe('npm test');
  });
  it('strips timeout N', () => {
    expect(stripWrappers('timeout 30 npm test')).toBe('npm test');
  });
  it('strips nice -n N', () => {
    expect(stripWrappers('nice -n 5 npm test')).toBe('npm test');
  });
  it('strips timeout with -k flag and value', () => {
    expect(stripWrappers('timeout -k 5 30 npm test')).toBe('npm test');
  });
  it('strips timeout with suffixed duration (30s)', () => {
    expect(stripWrappers('timeout 30s npm test')).toBe('npm test');
  });
  it('strips chained wrappers', () => {
    expect(stripWrappers('sudo timeout 5 nohup npm test')).toBe('npm test');
  });
  it('strips leading env K=V', () => {
    expect(stripWrappers('FOO=bar npm test')).toBe('npm test');
  });
  it('strips env with multiple vars', () => {
    expect(stripWrappers('env FOO=bar BAZ=qux npm test')).toBe('npm test');
  });
  it('strips xargs flags', () => {
    expect(stripWrappers('xargs -I {} npm run {}')).toContain('npm');
  });
  it('leaves non-wrapped commands unchanged', () => {
    expect(stripWrappers('npm test')).toBe('npm test');
  });
});

describe('expandBashCommand', () => {
  it('yields the whole command as a segment', () => {
    expect(expandBashCommand('npm test')).toContain('npm test');
  });
  it('splits pipelines', () => {
    const segs = expandBashCommand('cat foo | grep bar');
    expect(segs).toContain('cat foo');
    expect(segs).toContain('grep bar');
  });
  it('recurses into sh -c', () => {
    const segs = expandBashCommand('sh -c "npm test && npm lint"');
    expect(segs.some((s) => s.includes('npm test'))).toBe(true);
    expect(segs.some((s) => s.includes('npm lint'))).toBe(true);
  });
  it('recurses into bash -c', () => {
    const segs = expandBashCommand('bash -c "rm -rf /"');
    expect(segs.some((s) => s.includes('rm -rf /'))).toBe(true);
  });
});

describe('matchBash', () => {
  it('matches exact command', () => {
    expect(matchBash('npm test', 'npm test')).toBe(true);
  });
  it('matches prefix with trailing wildcard after space (word-boundary)', () => {
    expect(matchBash('npm *', 'npm install')).toBe(true);
    expect(matchBash('npm *', 'npm test')).toBe(true);
  });
  it('does NOT match lsof when rule is "ls *" (space enforces boundary)', () => {
    expect(matchBash('ls *', 'lsof')).toBe(false);
  });
  it('matches lsof when rule is "ls*" (no space, no boundary)', () => {
    expect(matchBash('ls*', 'lsof')).toBe(true);
  });
  it('normalizes colon form to space form', () => {
    expect(matchBash('npm:*', 'npm install')).toBe(true);
  });
  it('matches through sudo wrapper', () => {
    expect(matchBash('npm test', 'sudo npm test')).toBe(true);
  });
  it('matches through timeout wrapper', () => {
    expect(matchBash('npm test', 'timeout 30 npm test')).toBe(true);
  });
  it('matches any segment of a pipeline', () => {
    expect(matchBash('grep *', 'cat foo | grep bar')).toBe(true);
  });
  it('matches inside sh -c payload', () => {
    expect(matchBash('rm -rf *', 'sh -c "rm -rf /tmp/foo"')).toBe(true);
  });
  it('matches inside bash -c payload', () => {
    expect(matchBash('curl *', 'bash -c "curl example.com"')).toBe(true);
  });
  it('returns false for empty command', () => {
    expect(matchBash('npm *', '')).toBe(false);
  });
  it('matches rm -rf specifically', () => {
    expect(matchBash('rm -rf *', 'rm -rf /')).toBe(true);
    expect(matchBash('rm -rf *', 'rm file.txt')).toBe(false);
  });
});

describe('matchPath', () => {
  it('matches absolute path via //', () => {
    expect(matchPath('//Users/jeff/secrets.txt', { file_path: '/Users/jeff/secrets.txt' })).toBe(true);
  });
  it('matches home-relative via ~/', () => {
    const home = homedir();
    expect(matchPath('~/secrets.txt', { file_path: `${home}/secrets.txt` })).toBe(true);
  });
  it('matches recursive glob with //', () => {
    expect(matchPath('//Users/jeff/**/*.env', { file_path: '/Users/jeff/app/config/.env' })).toBe(true);
  });
  it('glob respects path segment boundaries', () => {
    expect(matchPath('//foo/*.txt', { file_path: '/foo/sub/a.txt' })).toBe(false);
    expect(matchPath('//foo/*.txt', { file_path: '/foo/a.txt' })).toBe(true);
  });
  it('matches basename for bare pattern', () => {
    expect(matchPath('*.env', { file_path: '/a/b/c/.env' })).toBe(true);
  });
  it('returns false when no path key present', () => {
    expect(matchPath('//a/b', { command: 'ls' })).toBe(false);
  });
  it('works with notebook_path', () => {
    expect(matchPath('//a/**/*.ipynb', { notebook_path: '/a/b/c.ipynb' })).toBe(true);
  });
});

describe('matchWeb', () => {
  it('matches domain: exact', () => {
    expect(matchWeb('domain:example.com', { url: 'https://example.com/foo' })).toBe(true);
  });
  it('matches subdomain of domain:', () => {
    expect(matchWeb('domain:example.com', { url: 'https://api.example.com/foo' })).toBe(true);
  });
  it('does not match unrelated domain', () => {
    expect(matchWeb('domain:example.com', { url: 'https://evil.com/foo' })).toBe(false);
  });
  it('does not match suffix-only overlap', () => {
    expect(matchWeb('domain:example.com', { url: 'https://notexample.com/foo' })).toBe(false);
  });
  it('matches URL glob', () => {
    expect(matchWeb('https://example.com/*', { url: 'https://example.com/anything' })).toBe(true);
  });
  it('returns false for invalid URL', () => {
    expect(matchWeb('domain:example.com', { url: 'not a url' })).toBe(false);
  });
  it('returns false when no url present', () => {
    expect(matchWeb('domain:a.com', {})).toBe(false);
  });
  it('matches query for WebSearch input', () => {
    expect(matchWeb('*', { query: 'anything' })).toBe(true);
  });
});

describe('matchMcpTool', () => {
  it('matches exact MCP tool name', () => {
    expect(matchMcpTool('mcp__github__create_issue', 'mcp__github__create_issue')).toBe(true);
  });
  it('matches wildcard per server', () => {
    expect(matchMcpTool('mcp__github__*', 'mcp__github__create_issue')).toBe(true);
    expect(matchMcpTool('mcp__github__*', 'mcp__github__search_code')).toBe(true);
  });
  it('does not match different server', () => {
    expect(matchMcpTool('mcp__github__*', 'mcp__gitlab__create_issue')).toBe(false);
  });
  it('returns false for non-MCP rule tool', () => {
    expect(matchMcpTool('Bash', 'mcp__github__create_issue')).toBe(false);
  });
});

describe('matchFallback', () => {
  it('matches via stringified input', () => {
    expect(matchFallback('*delete*', { action: 'delete_all' })).toBe(true);
    expect(matchFallback('*delete*', { action: 'read' })).toBe(false);
  });
  it('matches string input directly', () => {
    expect(matchFallback('hello*', 'hello world')).toBe(true);
  });
});

describe('isPathTool / isWebTool', () => {
  it('classifies path tools', () => {
    expect(isPathTool('Read')).toBe(true);
    expect(isPathTool('Edit')).toBe(true);
    expect(isPathTool('Write')).toBe(true);
    expect(isPathTool('NotebookEdit')).toBe(true);
    expect(isPathTool('Bash')).toBe(false);
  });
  it('classifies web tools', () => {
    expect(isWebTool('WebFetch')).toBe(true);
    expect(isWebTool('WebSearch')).toBe(true);
    expect(isWebTool('Read')).toBe(false);
  });
});
