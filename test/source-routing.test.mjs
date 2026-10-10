import assert from 'node:assert/strict';

const ENTRY = 'https://huangguoai.ai';
const FALLBACK = 'https://huangguoai.com';
const FIRST = 'https://first.example';
const SECOND = 'https://second.example';
const SELECTED = 'https://selected.example';
const routes = `<a href="https://ads.example/download">下载</a>
  <a class="use-btn" href="${FIRST}/">线路 01</a>
  <a href="${SECOND}/?ref=entry" class="use-btn">线路 02</a>
  <a class="use-btn" href="${FIRST}/">重复线路</a>`;
const catalog = (route = 'video') => `<div class="hg-card-grid">
  <div class="hg-drama-card">
    <a href="/${route}/123/"><img data-src="/cover.jpg"></a>
    <h3 class="hg-drama-card__title"><a href="/${route}/123/">测试条目</a></h3>
  </div></div>`;
const detail = `<h1>测试条目</h1>
  <a data-ep-id="1" href="/video/123/">第1集</a>`;
const originalFetch = globalThis.fetch;
let scenario = 0;

async function loadScraper(handler) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, referer: init.headers.Referer });
    return handler(url, init);
  };
  const scraper = await import(`../src/lib/scraper.js?source-test=${++scenario}`);
  return { scraper, requests };
}

try {
  const { scraper: regression } = await loadScraper((url) => new Response(
    url === `${ENTRY}/` ? routes : catalog()
  ));
  assert.equal((await regression.getCatalog()).list.length, 1, 'current /video/ cards must be parsed');

  const { scraper, requests } = await loadScraper((url) => {
    if (url === `${ENTRY}/`) return new Response(routes);
    if (url === `${FIRST}/`) return new Response('<html>unrelated HTTP 200 page</html>');
    if (url === `${SECOND}/`) {
      const response = new Response(catalog());
      Object.defineProperty(response, 'url', { value: `${SELECTED}/` });
      return response;
    }
    if (url === `${SELECTED}/ai-duanju/`) return new Response(catalog());
    if (url === `${SELECTED}/ranks/hot/`) return new Response(`<div class="hg-rank-list">
      <div class="hg-rank-item"><a href="/video/123/"><h2 class="hg-rank-item__title">测试条目</h2></a></div></div>`);
    if (url === `${SELECTED}/search/video/test/`) return new Response(catalog());
    if (url === `${SELECTED}/search/video/missing/`) return new Response('<div class="hg-card-grid"></div>');
    if (url === `${SELECTED}/search/video/broken/`) return new Response(catalog('detail'));
    if (url === `${SELECTED}/video/123/`) return new Response(detail);
    if (url === `${SELECTED}/ai-duanju/100/`) return new Response('', { status: 404 });
    throw new Error(`Unexpected request: ${url}`);
  });
  assert.deepEqual(scraper.parseSourceRoutes(routes), [FIRST, SECOND]);
  const [home, duplicateHome] = await Promise.all([scraper.getCatalog(), scraper.getCatalog()]);
  assert.equal(home.list.length, 1);
  assert.deepEqual(duplicateHome, home);
  assert.deepEqual(requests.map((request) => request.url), [`${ENTRY}/`, `${FIRST}/`, `${SECOND}/`]);
  assert.equal(scraper.SITE, SELECTED, 'use the final origin after a redirect');
  assert.equal(scraper.getSourceStatus().baseUrl, SELECTED);
  assert.equal(scraper.SITE_HEADERS.Referer, `${SELECTED}/`);
  assert.equal(home.list[0].image, `${SELECTED}/cover.jpg`);
  assert.equal((await scraper.getCatalog('ai-duanju')).list.length, 1, 'current /video/ category links must be parsed');
  assert.equal((await scraper.getCatalog('ranks/hot')).list.length, 1);
  assert.equal((await scraper.searchCatalog('test')).list.length, 1);
  assert.equal((await scraper.searchCatalog('missing')).list.length, 0, 'a real empty result is allowed');
  assert.deepEqual((await scraper.getCatalog('ai-duanju', 100)).list, []);
  assert.equal((await scraper.getDetail('123')).episodes[0].playUrl, `${SELECTED}/video/123/`);
  assert.ok(requests.slice(3).every((request) => request.referer === `${SELECTED}/`));
  await assert.rejects(scraper.searchCatalog('broken'), (error) => error.code === 'SOURCE_STRUCTURE_CHANGED', 'legacy /detail/ links are unsupported');
  assert.equal(scraper.getSourceStatus().state, 'changed');
  assert.equal(requests.filter((request) => request.url === `${ENTRY}/`).length, 1);

  const { scraper: fallback, requests: fallbackRequests } = await loadScraper((url) => {
    if (url === `${ENTRY}/`) return new Response('', { status: 403 });
    if (url === `${FALLBACK}/`) return new Response(catalog());
    throw new Error(`Unexpected request: ${url}`);
  });
  assert.equal((await fallback.getCatalog()).list.length, 1);
  assert.equal(fallback.SITE, FALLBACK);
  assert.deepEqual(fallbackRequests.map((request) => request.url), [`${ENTRY}/`, `${FALLBACK}/`]);

  let unavailable = true;
  const { scraper: recovery } = await loadScraper((url) => {
    if (url === `${ENTRY}/`) return new Response(routes);
    return new Response(unavailable ? '<html>unrelated page</html>' : catalog());
  });
  await assert.rejects(recovery.getCatalog(), /没有可用的内容源线路/);
  unavailable = false;
  assert.equal((await recovery.getCatalog()).list.length, 1, 'a failed selection can be retried');

  console.log(JSON.stringify({ ok: true, orderedSourceSelectionChecked: true, redirectedBaseChecked: true,
    concurrentSelectionChecked: true, currentLinksChecked: true, emptyResultDetectionChecked: true,
    fallbackAndRecoveryChecked: true }, null, 2));
} finally {
  globalThis.fetch = originalFetch;
}
