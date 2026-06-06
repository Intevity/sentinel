/**
 * Benchmark fixture: a rendered marketing/docs HTML page with the
 * boilerplate weight real pages carry (head, style, script, nav, footer,
 * repeated cards), the workload class behind Headroom's "HTML extraction
 * 94.9%" figure. html_extract must reduce it to the prose.
 *
 * Deterministic builder (pure function of loop indices).
 */

export function buildHtmlPage(): string {
  const cards: string[] = [];
  for (let i = 0; i < 120; i++) {
    cards.push(
      `      <div class="card card-${i % 6} grid-item" data-idx="${i}" data-track="prod-${(i * 31) % 500}">\n` +
        `        <div class="card-media"><img src="/cdn/img/product-${i}.webp" srcset="/cdn/img/product-${i}@2x.webp 2x" alt="Product ${i}: precision widget" loading="lazy" /></div>\n` +
        `        <h3 class="card-title"><a href="/products/${i}?ref=grid&amp;pos=${i}">Precision Widget ${i}</a></h3>\n` +
        `        <p class="card-blurb">Tuned for batch ${(i * 7) % 90} workloads &mdash; ships in ${(i % 5) + 1} days.</p>\n` +
        `        <span class="price">&#36;${(i % 40) + 10}.99</span>\n` +
        `      </div>`,
    );
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Widget Catalog &amp; Specs</title>
  <style>
    :root { --accent: #4f46e5; --bg: #0b0b10; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
    ${Array.from({ length: 80 }, (_, i) => `.card-${i % 6} .v${i} { margin: ${i % 9}px; padding: ${i % 7}px ${i % 5}px; }`).join('\n    ')}
  </style>
  <script>
    window.__telemetry = { page: 'catalog', ts: 'static' };
    ${Array.from({ length: 60 }, (_, i) => `function handler${i}(e) { return queue.push(['evt${i}', e.target.dataset.idx]); }`).join('\n    ')}
  </script>
</head>
<body>
  <!-- header / navigation boilerplate -->
  <nav class="topnav">
    <a href="/">Home</a><a href="/catalog">Catalog</a><a href="/docs">Docs</a><a href="/support">Support</a>
  </nav>
  <main>
    <h1>Widget Catalog</h1>
    <p>Compare all <strong>120 widgets</strong> side by side &mdash; specs, lead times &amp; pricing.</p>
    <div class="grid">
${cards.join('\n')}
    </div>
  </main>
  <footer>
    <ul>
      <li><a href="/legal/terms">Terms</a></li>
      <li><a href="/legal/privacy">Privacy</a></li>
      <li>&copy; 2026 Widget Co.</li>
    </ul>
  </footer>
</body>
</html>`;
}
