import { describe, expect, it } from 'vitest';
import {
  isApiKeyCredential,
  validateApiKeyInput,
  validateWorkspaceIdInput,
} from './credential-kind.js';

const body = 'A1b2_C3-d4'.repeat(10);

describe('isApiKeyCredential', () => {
  it.each([
    ['legacy workspace key', `sk-ant-api03-${body}`],
    ['personal (identity-linked) key', `sk-ant-usr01-${body}`],
    ['a future key family', `sk-ant-svc01-${body}`],
  ])('treats a %s as an API key', (_label, token) => {
    expect(isApiKeyCredential(token)).toBe(true);
  });

  it.each([
    ['setup-token / OAuth access token', `sk-ant-oat01-${body}`],
    ['OAuth refresh token', `sk-ant-ort01-${body}`],
    ['claude.ai session key', `sk-ant-sid01-${body}`],
    ['Admin API key', `sk-ant-admin01-${body}`],
    ['a non-Anthropic string', 'test-token'],
  ])('does not treat a %s as an API key', (_label, token) => {
    expect(isApiKeyCredential(token)).toBe(false);
  });
});

describe('validateApiKeyInput', () => {
  it('accepts a key and trims what a copy carries around it', () => {
    expect(validateApiKeyInput(`  sk-ant-usr01-${body}\n`)).toEqual({
      ok: true,
      apiKey: `sk-ant-usr01-${body}`,
    });
  });

  it.each([
    ['', 'Paste an API key.'],
    ['   ', 'Paste an API key.'],
    [`sk-ant-api03-${body} extra`, 'API keys contain no spaces or line breaks. Copy it again.'],
    [
      `sk-ant-api03-${body.slice(0, 50)}\n${body}`,
      'API keys contain no spaces or line breaks. Copy it again.',
    ],
    [`sk-proj-${body}`, 'Anthropic API keys start with sk-ant-.'],
    [
      `sk-ant-oat01-${body}`,
      'That is a Claude subscription token, not an API key. Choose "Claude subscription" to add it.',
    ],
    [`sk-ant-ort01-${body}`, 'That is an OAuth refresh token, not an API key.'],
    [`sk-ant-sid01-${body}`, 'That is a claude.ai session key, not an API key.'],
    [
      `sk-ant-admin01-${body}`,
      'Admin API keys manage an organization and cannot send messages. Create a standard API key in the Claude Console.',
    ],
    ['sk-ant-api03-short', 'That API key looks incomplete. Copy it again in full.'],
    [`sk-ant-api03-${body}…`, 'That API key looks incomplete. Copy it again in full.'],
  ])('rejects %j', (raw, error) => {
    expect(validateApiKeyInput(raw)).toEqual({ ok: false, error });
  });
});

describe('validateWorkspaceIdInput', () => {
  it('treats a missing or blank workspace as not needed', () => {
    expect(validateWorkspaceIdInput(undefined)).toEqual({ ok: true, workspaceId: undefined });
    expect(validateWorkspaceIdInput('  ')).toEqual({ ok: true, workspaceId: undefined });
  });

  it('accepts and trims a workspace ID', () => {
    expect(validateWorkspaceIdInput(' wrkspc_01AbCdEf ')).toEqual({
      ok: true,
      workspaceId: 'wrkspc_01AbCdEf',
    });
  });

  it.each(['01AbCdEf', 'wrkspc_', 'wrkspc 01', 'org_01AbC'])('rejects %j', (raw) => {
    expect(validateWorkspaceIdInput(raw)).toEqual({
      ok: false,
      error: 'Workspace IDs look like wrkspc_01AbC…',
    });
  });
});
