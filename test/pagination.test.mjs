import assert from 'node:assert/strict';
import { hasNextPage } from '../src/lib/scraper.js';

assert.equal(
  hasNextPage('<head><link rel="next" href="/ai-duanju/2/"></head>'),
  true,
  'rel=next should expose another page'
);

assert.equal(
  hasNextPage('<nav><a class="hg-pager__arrow" title="下一页" href="/ai-duanju/2/">next</a></nav>'),
  true,
  'the visible next-page arrow should expose another page'
);

assert.equal(
  hasNextPage('<nav><button class="hg-pager__arrow" title="下一页" disabled>next</button></nav>'),
  false,
  'a disabled next-page button should mark the final page'
);

assert.equal(hasNextPage('<main>no pager</main>'), false);

console.log(JSON.stringify({ ok: true, finalPageDetectionChecked: true }, null, 2));
