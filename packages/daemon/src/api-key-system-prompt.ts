/**
 * The system-prompt half of presenting a pooled API-key request as a plain API
 * client (the header half is `presentAsApiKeyClient` in `proxy.ts`).
 *
 * Anthropic also identifies Claude Code by the first block of the system
 * prompt. When that block is Claude Code's billing-attribution block
 * (`x-anthropic-billing-header: cc_version=…; cc_entrypoint=…`) or one of its
 * identity lines ("You are Claude Code, Anthropic's official CLI for Claude.",
 * "You are a Claude agent, built on Anthropic's Claude Agent SDK."), a request
 * sent with an `sk-ant-usr` key is refused with 400 "Your credit balance is
 * too low" although the key's organization has credits. Neither counts
 * anywhere but first: the billing block matches by prefix, an identity line
 * only exactly, and the same text later in the prompt or in a message passes.
 * Verified against two live keys on 2026-10-14.
 *
 * So the billing block is dropped (it is attribution metadata, not an
 * instruction) and the first remaining block is folded into the one after it.
 * The model reads the same text, and the folded block keeps a cache breakpoint
 * where either half had one, so caching is unaffected. A lone remaining block
 * gets a trailing newline instead, which is enough to stop the exact match.
 */

/** Opening of the system block Claude Code adds to attribute a request to it. */
const BILLING_BLOCK_PREFIX = 'x-anthropic-billing-header:';

/** Separator between the two halves of a folded block. */
const FOLD_SEPARATOR = '\n\n';

interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: unknown;
  [key: string]: unknown;
}

function isTextBlock(block: unknown): block is TextBlock {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as Record<string, unknown>)['type'] === 'text' &&
    typeof (block as Record<string, unknown>)['text'] === 'string'
  );
}

function isBillingBlock(block: unknown): boolean {
  return isTextBlock(block) && block.text.startsWith(BILLING_BLOCK_PREFIX);
}

/** Fold `first` into `second`, keeping a cache breakpoint where either had one. */
function fold(first: TextBlock, second: TextBlock): TextBlock {
  const merged: TextBlock = { ...second, text: `${first.text}${FOLD_SEPARATOR}${second.text}` };
  const cacheControl = second.cache_control ?? first.cache_control;
  if (cacheControl !== undefined) merged.cache_control = cacheControl;
  return merged;
}

/**
 * Reshape the system prompt of a /v1/messages body bound for Anthropic with a
 * pooled API key. Returns `body` itself when it is not a JSON object with a
 * system prompt, so the caller can skip the Content-Length update.
 */
export function presentSystemPromptAsApiClient(body: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    return body;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return body;
  const root = parsed as Record<string, unknown>;
  const system = root['system'];

  if (typeof system === 'string') {
    if (system.length === 0) return body;
    root['system'] = `${system}\n`;
    return Buffer.from(JSON.stringify(root), 'utf-8');
  }
  if (!Array.isArray(system) || system.length === 0) return body;

  const blocks: unknown[] = system.filter((block) => !isBillingBlock(block));
  const [first, second] = blocks;
  if (isTextBlock(first) && isTextBlock(second)) {
    blocks.splice(0, 2, fold(first, second));
  } else if (isTextBlock(first)) {
    blocks[0] = { ...first, text: `${first.text}\n` };
  }

  if (blocks.length > 0) root['system'] = blocks;
  else delete root['system'];
  return Buffer.from(JSON.stringify(root), 'utf-8');
}
