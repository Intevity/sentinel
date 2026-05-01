import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAnthropicOrigin, getAnthropicUpstream, getProxyUpstream } from './hosts.js';

describe('hosts', () => {
  let savedUpstream: string | undefined;

  beforeEach(() => {
    savedUpstream = process.env.ANTHROPIC_UPSTREAM_URL;
  });

  afterEach(() => {
    if (savedUpstream === undefined) {
      delete process.env.ANTHROPIC_UPSTREAM_URL;
    } else {
      process.env.ANTHROPIC_UPSTREAM_URL = savedUpstream;
    }
  });

  describe('getAnthropicUpstream', () => {
    it('defaults to api.anthropic.com over https when no env override is set', () => {
      delete process.env.ANTHROPIC_UPSTREAM_URL;
      const u = getAnthropicUpstream();
      expect(u.hostname).toBe('api.anthropic.com');
      expect(u.protocol).toBe('https:');
      expect(u.port).toBe(443);
      expect(u.origin).toBe('https://api.anthropic.com');
    });

    it('honors ANTHROPIC_UPSTREAM_URL for a localhost http override (test path)', () => {
      process.env.ANTHROPIC_UPSTREAM_URL = 'http://127.0.0.1:54321';
      const u = getAnthropicUpstream();
      expect(u.hostname).toBe('127.0.0.1');
      expect(u.protocol).toBe('http:');
      expect(u.port).toBe(54321);
      expect(u.origin).toBe('http://127.0.0.1:54321');
    });
  });

  describe('getAnthropicOrigin', () => {
    it('returns the same origin string as getAnthropicUpstream', () => {
      delete process.env.ANTHROPIC_UPSTREAM_URL;
      expect(getAnthropicOrigin()).toBe(getAnthropicUpstream().origin);
    });
  });

  describe('getProxyUpstream', () => {
    it('falls back to getAnthropicUpstream when alternateApiUrl is null', () => {
      delete process.env.ANTHROPIC_UPSTREAM_URL;
      const u = getProxyUpstream(null);
      expect(u.origin).toBe('https://api.anthropic.com');
    });

    it('falls back to getAnthropicUpstream when alternateApiUrl is empty string', () => {
      delete process.env.ANTHROPIC_UPSTREAM_URL;
      const u = getProxyUpstream('');
      expect(u.origin).toBe('https://api.anthropic.com');
    });

    it('honors a valid https alternate origin', () => {
      const u = getProxyUpstream('https://router.example.com');
      expect(u.hostname).toBe('router.example.com');
      expect(u.protocol).toBe('https:');
      expect(u.port).toBe(443);
      expect(u.origin).toBe('https://router.example.com');
    });

    it('honors a valid http alternate origin with explicit port', () => {
      const u = getProxyUpstream('http://localhost:9000');
      expect(u.hostname).toBe('localhost');
      expect(u.protocol).toBe('http:');
      expect(u.port).toBe(9000);
      expect(u.origin).toBe('http://localhost:9000');
    });

    it('falls back to canonical when alternate has a non-http(s) protocol', () => {
      delete process.env.ANTHROPIC_UPSTREAM_URL;
      const u = getProxyUpstream('ftp://nope.example.com');
      expect(u.origin).toBe('https://api.anthropic.com');
    });

    it('falls back to canonical when alternate is malformed', () => {
      delete process.env.ANTHROPIC_UPSTREAM_URL;
      const u = getProxyUpstream('not-a-url');
      expect(u.origin).toBe('https://api.anthropic.com');
    });

    it('does NOT consult ANTHROPIC_UPSTREAM_URL when alternate is set (alternate wins)', () => {
      // Critical: an integration test scenario where the test fake is on
      // canonical but the user has configured an alternate must route Claude
      // Code traffic to the alternate, not back to the test fake.
      process.env.ANTHROPIC_UPSTREAM_URL = 'http://127.0.0.1:11111';
      const u = getProxyUpstream('https://router.example.com');
      expect(u.origin).toBe('https://router.example.com');
      expect(u.hostname).toBe('router.example.com');
    });
  });
});
