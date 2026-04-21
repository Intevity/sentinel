/**
 * Parses Anthropic /v1/messages request bodies for `cache_control` markers
 * and /v1/messages responses (JSON or SSE) for `usage.cache_creation`
 * per-TTL token counts.
 *
 * Both surfaces are needed: request markers say what Claude Code *asked for*,
 * response usage says how many tokens upstream *actually wrote* at each TTL.
 * Reads are a flat aggregate (a 1h-written cache still costs 0.1x to read)
 * so `cache_read_input_tokens` is not broken out by TTL.
 */

export interface CacheControlMarkerCounts {
  markers5m: number;
  markers1h: number;
}

/**
 * Walks a parsed request body counting cache_control markers. A block with
 * `cache_control.type === 'ephemeral'` counts as 5m unless it carries
 * `ttl: '1h'`, in which case it counts as 1h. Anything else is ignored.
 */
export function parseCacheControlMarkers(body: Buffer): CacheControlMarkerCounts {
  const counts: CacheControlMarkerCounts = { markers5m: 0, markers1h: 0 };
  let obj: unknown;
  try {
    obj = JSON.parse(body.toString('utf-8'));
  } catch {
    return counts;
  }
  if (!obj || typeof obj !== 'object') return counts;
  const root = obj as Record<string, unknown>;

  tallyCacheControl(root['cache_control'], counts);

  const system = root['system'];
  if (Array.isArray(system)) {
    for (const block of system) walkBlock(block, counts);
  }

  const tools = root['tools'];
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (tool && typeof tool === 'object') {
        tallyCacheControl((tool as Record<string, unknown>)['cache_control'], counts);
      }
    }
  }

  const messages = root['messages'];
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const content = (msg as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        for (const block of content) walkBlock(block, counts);
      }
    }
  }

  return counts;
}

function walkBlock(block: unknown, counts: CacheControlMarkerCounts): void {
  if (!block || typeof block !== 'object') return;
  tallyCacheControl((block as Record<string, unknown>)['cache_control'], counts);
}

function tallyCacheControl(raw: unknown, counts: CacheControlMarkerCounts): void {
  if (!raw || typeof raw !== 'object') return;
  const cc = raw as Record<string, unknown>;
  if (cc['type'] !== 'ephemeral') return;
  if (cc['ttl'] === '1h') counts.markers1h++;
  else counts.markers5m++;
}

// ── Response usage extraction ────────────────────────────────────────────────

export interface UsageExtractResult {
  model: string | null;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  inputTokens: number;
}

/**
 * Non-streaming path: the whole response body is a single JSON object with
 * `model` and `usage`. Returns null if parsing fails or no usage is present.
 */
export function extractUsageFromJson(body: Buffer): UsageExtractResult | null {
  let obj: unknown;
  try {
    obj = JSON.parse(body.toString('utf-8'));
  } catch {
    return null;
  }
  return extractFromMessageLike(obj);
}

function extractFromMessageLike(obj: unknown): UsageExtractResult | null {
  if (!obj || typeof obj !== 'object') return null;
  const msg = obj as Record<string, unknown>;
  const usage = msg['usage'];
  if (!usage || typeof usage !== 'object') return null;
  return buildResult(
    typeof msg['model'] === 'string' ? (msg['model'] as string) : null,
    usage as Record<string, unknown>,
  );
}

function buildResult(model: string | null, usage: Record<string, unknown>): UsageExtractResult {
  const cc = usage['cache_creation'];
  let cacheCreate5m = 0;
  let cacheCreate1h = 0;
  if (cc && typeof cc === 'object') {
    const ccObj = cc as Record<string, unknown>;
    cacheCreate5m = numberOrZero(ccObj['ephemeral_5m_input_tokens']);
    cacheCreate1h = numberOrZero(ccObj['ephemeral_1h_input_tokens']);
  } else {
    // Older responses only carry the aggregate. Attribute all creations to
    // the 5m bucket (the API default when `ttl` is absent) so totals line up.
    cacheCreate5m = numberOrZero(usage['cache_creation_input_tokens']);
  }
  return {
    model,
    cacheCreate5m,
    cacheCreate1h,
    cacheRead: numberOrZero(usage['cache_read_input_tokens']),
    inputTokens: numberOrZero(usage['input_tokens']),
  };
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Streaming path: feed raw response chunks in, get the final usage out.
 *
 * The extractor maintains a one-line partial buffer and only JSON-parses
 * `data: ` lines whose payload references `"usage"`. It captures the model
 * and a baseline from `message_start`, then overwrites with the final values
 * from `message_delta.usage` when that event arrives (per Anthropic's SSE
 * contract, `message_delta.usage` carries the cumulative final counts).
 *
 * Does not buffer the full response body. O(lines-with-usage).
 */
export class SseUsageExtractor {
  private partial = '';
  private model: string | null = null;
  private haveUsage = false;
  private cacheCreate5m = 0;
  private cacheCreate1h = 0;
  private cacheRead = 0;
  private inputTokens = 0;

  onChunk(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    this.partial += text;
    let newlineAt: number;
    while ((newlineAt = this.partial.indexOf('\n')) !== -1) {
      const rawLine = this.partial.slice(0, newlineAt);
      this.partial = this.partial.slice(newlineAt + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trimStart();
    if (!payload || payload === '[DONE]') return;
    if (!payload.includes('"usage"') && !payload.includes('"model"')) return;

    let evt: unknown;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    if (!evt || typeof evt !== 'object') return;
    const e = evt as Record<string, unknown>;
    const type = e['type'];

    if (type === 'message_start') {
      const message = e['message'];
      if (message && typeof message === 'object') {
        const msg = message as Record<string, unknown>;
        if (typeof msg['model'] === 'string') this.model = msg['model'] as string;
        const result = extractFromMessageLike(message);
        if (result) this.adopt(result);
      }
    } else if (type === 'message_delta') {
      const usage = e['usage'];
      if (usage && typeof usage === 'object') {
        const result = buildResult(this.model, usage as Record<string, unknown>);
        this.adopt(result);
      }
    }
  }

  private adopt(result: UsageExtractResult): void {
    if (result.model && !this.model) this.model = result.model;
    this.cacheCreate5m = result.cacheCreate5m;
    this.cacheCreate1h = result.cacheCreate1h;
    this.cacheRead = result.cacheRead;
    this.inputTokens = result.inputTokens;
    this.haveUsage = true;
  }

  getResult(): UsageExtractResult | null {
    if (!this.haveUsage) return null;
    return {
      model: this.model,
      cacheCreate5m: this.cacheCreate5m,
      cacheCreate1h: this.cacheCreate1h,
      cacheRead: this.cacheRead,
      inputTokens: this.inputTokens,
    };
  }
}
