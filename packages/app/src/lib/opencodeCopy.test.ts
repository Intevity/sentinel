/**
 * opencode surface copy. The load-bearing behaviors: the credentials sentence
 * names both paths (an API key stays the user's own; the opencode-claude-auth
 * plugin uses the pool), an unwritable file is blamed on its real cause, and a
 * user's own base URL is promised back on disable.
 */

import { describe, it, expect } from 'vitest';
import type { OpencodeConfigDetails } from '@sentinel/shared';
import {
  OPENCODE_CREDENTIALS_COPY,
  opencodeCardCopy,
  opencodeToggleDescription,
  opencodeUnwritableCopy,
} from './opencodeCopy.js';

function details(overrides: Partial<OpencodeConfigDetails> = {}): OpencodeConfigDetails {
  return {
    state: 'inactive',
    configPath: '/home/u/.config/opencode/opencode.json',
    baseUrl: null,
    overridingPlugins: [],
    manualSnippet: null,
    unwritableReason: null,
    previousBaseUrl: null,
    ...overrides,
  };
}

describe('OPENCODE_CREDENTIALS_COPY', () => {
  it('names both the own-key path and the pooled plugin path', () => {
    expect(OPENCODE_CREDENTIALS_COPY).toContain('your own key');
    expect(OPENCODE_CREDENTIALS_COPY).toContain('opencode-claude-auth');
    expect(OPENCODE_CREDENTIALS_COPY).toContain('account pool');
    // The claim this replaced, which was false for the plugin path.
    expect(OPENCODE_CREDENTIALS_COPY).not.toMatch(/not supplied|does not supply/);
  });
});

describe('opencodeUnwritableCopy', () => {
  it('blames comments only when the reason is comments', () => {
    expect(opencodeUnwritableCopy(details({ unwritableReason: 'comments' }))).toContain(
      'contains comments',
    );
  });

  it('reports invalid JSON without mentioning comments', () => {
    const copy = opencodeUnwritableCopy(details({ unwritableReason: 'unparseable' }));
    expect(copy).toContain("isn't valid JSON");
    expect(copy).not.toContain('comment');
  });
});

describe('opencodeCardCopy', () => {
  it('offers routing with the credentials sentence when inactive', () => {
    const { title, body } = opencodeCardCopy(details());
    expect(title).toBe('Route opencode through Sentinel');
    expect(body).toContain(OPENCODE_CREDENTIALS_COPY);
  });

  it('treats unloaded details as inactive', () => {
    expect(opencodeCardCopy(null).title).toBe('Route opencode through Sentinel');
  });

  it('names the overriding plugin', () => {
    const { title, body } = opencodeCardCopy(
      details({ state: 'plugin-override', overridingPlugins: ['opencode-with-claude@1.8.0'] }),
    );
    expect(title).toBe('opencode is bypassing Sentinel');
    expect(body).toContain('(opencode-with-claude@1.8.0)');
  });

  it('gives the real unwritable cause before the snippet', () => {
    const { title, body } = opencodeCardCopy(
      details({ state: 'unwritable', unwritableReason: 'unparseable' }),
    );
    expect(title).toBe('opencode needs a manual config edit');
    expect(body).toContain("isn't valid JSON");
    expect(body).not.toContain('comment');
    expect(body.endsWith('Add this to it by hand:')).toBe(true);
  });

  it('promises a foreign base URL back on disable', () => {
    const { title, body } = opencodeCardCopy(
      details({ state: 'foreign-base-url', baseUrl: 'https://gw.corp/v1' }),
    );
    expect(title).toBe('opencode routed elsewhere');
    expect(body).toContain('https://gw.corp/v1');
    expect(body).toContain('puts it back when you disable');
  });
});

describe('opencodeToggleDescription', () => {
  it('explains a plugin override', () => {
    expect(
      opencodeToggleDescription(
        details({ state: 'plugin-override', overridingPlugins: ['opencode-with-claude'] }),
      ),
    ).toMatch(/^Unavailable: the opencode-with-claude plugin/);
  });

  it('explains an unwritable file by its cause', () => {
    expect(
      opencodeToggleDescription(details({ state: 'unwritable', unwritableReason: 'comments' })),
    ).toBe(
      'Unavailable: Your opencode config contains comments, which Sentinel will not rewrite — saving it would delete them.',
    );
  });

  it('describes routing and both credential paths when inactive', () => {
    const d = opencodeToggleDescription(null);
    expect(d).toContain(OPENCODE_CREDENTIALS_COPY);
    expect(d).not.toContain('restores');
    expect(d.endsWith('Restart opencode after changing this.')).toBe(true);
  });

  it('warns that enabling replaces a foreign base URL and that it comes back', () => {
    const d = opencodeToggleDescription(
      details({ state: 'foreign-base-url', baseUrl: 'https://gw.corp/v1' }),
    );
    expect(d).toContain('replaces your base URL (https://gw.corp/v1)');
    expect(d).toContain('restores it when you turn this off');
  });

  it('shows the resolved config file so an environment mismatch is visible', () => {
    expect(opencodeToggleDescription(details({ state: 'active' }))).toMatch(
      / Config file: \/home\/u\/\.config\/opencode\/opencode\.json$/,
    );
  });

  it('names the saved URL that disabling restores while active', () => {
    const d = opencodeToggleDescription(
      details({ state: 'active', previousBaseUrl: 'https://gw.corp/v1' }),
    );
    expect(d).toContain('Turning this off restores your previous base URL (https://gw.corp/v1).');
  });
});
