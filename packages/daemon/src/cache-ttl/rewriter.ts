/**
 * Rewrites `cache_control` blocks in an Anthropic /v1/messages request body
 * so every `{type: 'ephemeral'}` block carries the requested `ttl`. Used by
 * the proxy when the user has enabled the "Force 1h cache TTL" setting to
 * give consistent cache behavior across accounts whose default TTL differs.
 *
 * Tree walk mirrors `parseCacheControlMarkers` in `parser.ts`: root
 * `cache_control`, every entry in `system[]`, `tools[]`, and
 * `messages[].content[]`. Only mutates existing blocks — never adds new
 * `cache_control` entries, so we naturally stay inside Anthropic's
 * 4-breakpoint-per-request cap.
 *
 * Returns the original Buffer when nothing changed (lets the caller skip the
 * Content-Length update). Returns the original Buffer on malformed JSON too —
 * defensive posture matches the parser.
 */

export type CacheTtl = '5m' | '1h';

export function rewriteCacheControlTtl(body: Buffer, ttl: CacheTtl): Buffer {
  let obj: unknown;
  try {
    obj = JSON.parse(body.toString('utf-8'));
  } catch {
    return body;
  }
  if (!obj || typeof obj !== 'object') return body;
  const root = obj as Record<string, unknown>;

  let mutated = false;
  const setTtl = (cc: unknown): void => {
    if (!cc || typeof cc !== 'object') return;
    const record = cc as Record<string, unknown>;
    if (record['type'] !== 'ephemeral') return;
    if (record['ttl'] === ttl) return;
    record['ttl'] = ttl;
    mutated = true;
  };

  setTtl(root['cache_control']);

  const system = root['system'];
  if (Array.isArray(system)) {
    for (const block of system) {
      if (block && typeof block === 'object') {
        setTtl((block as Record<string, unknown>)['cache_control']);
      }
    }
  }

  const tools = root['tools'];
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool && typeof tool === 'object') {
        setTtl((tool as Record<string, unknown>)['cache_control']);
      }
    }
  }

  const messages = root['messages'];
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const content = (msg as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object') {
            setTtl((block as Record<string, unknown>)['cache_control']);
          }
        }
      }
    }
  }

  if (!mutated) return body;
  return Buffer.from(JSON.stringify(root), 'utf-8');
}
