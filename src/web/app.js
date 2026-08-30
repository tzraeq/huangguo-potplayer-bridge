const LIBRARY_TABS = Object.freeze([
  { name: '收藏', id: 'favorites' },
  { name: '观看记录', id: 'history' },
]);

const state = {
  health: null,
  sessionToken: '',
  activeTab: 'home',
  page: 1,
  items: [],
  hasMore: false,
  search: '',
  loading: false,
  detail: null,
  library: { favorites: [], history: [] },
  playlistJob: '',
  diagnosticsText: '',
};

const $ = (selector) => document.querySelector(selector);
const refs = {
  tabs: $('#tabs'),
  grid: $('#card-grid'),
  catalog: $('.catalog'),
  empty: $('#empty-state'),
  emptyTitle: $('#empty-title'),
  emptyCopy: $('#empty-copy'),
  loadMore: $('#load-more'),
  pageTitle: $('#page-title'),
  pageKicker: $('#page-kicker'),
  resultNote: $('#result-note'),
  clearHistory: $('#clear-history'),
  searchForm: $('#search-form'),
  searchInput: $('#search-input'),
  playerState: $('#player-state'),
  playerStateText: $('#player-state-text'),
  diagnosticsButton: $('#diagnostics-button'),
  settingsButton: $('#settings-button'),
  settingsDialog: $('#settings-dialog'),
  settingsForm: $('#settings-form'),
  potPlayerPath: $('#potplayer-path'),
  dataDirectory: $('#data-directory'),
  restartButton: $('#restart-button'),
  shutdownButton: $('#shutdown-button'),
  detailDialog: $('#detail-dialog'),
  detailLoading: $('#detail-loading'),
  detailContent: $('#detail-content'),
  detailTitle: $('#detail-title'),
  detailDescription: $('#detail-description'),
  detailPoster: $('#detail-poster'),
  episodeCount: $('#episode-count'),
  episodeGrid: $('#episode-grid'),
  favoriteButton: $('#favorite-button'),
  resumeButton: $('#resume-button'),
  openPlaylist: $('#open-playlist'),
  copyPlaylist: $('#copy-playlist'),
  playlistProgress: $('#playlist-progress'),
  playlistProgressBar: $('#playlist-progress-bar'),
  playlistProgressText: $('#playlist-progress-text'),
  cancelPlaylist: $('#cancel-playlist'),
  diagnosticsDialog: $('#diagnostics-dialog'),
  diagnosticsOutput: $('#diagnostics-output'),
  refreshDiagnostics: $('#refresh-diagnostics'),
  copyDiagnostics: $('#copy-diagnostics'),
  sourceAlert: $('#source-alert'),
  sourceAlertText: $('#source-alert-text'),
  sourceAlertDiagnostics: $('#source-alert-diagnostics'),
  toast: $('#toast'),
};

let toastTimer;

function friendlyUpstreamError(message) {
  const text = String(message || '请求失败');
  if (/socket connection|ECONNRESET|fetch failed|connection.*(?:closed|reset)|network error|other side closed|terminated/i.test(text)) {
    return '内容源连接中断，自动重试仍未成功，请稍后再试';
  }
  return text;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (state.sessionToken) headers.set('X-HG-Token', state.sessionToken);
  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch {
    throw new Error('无法连接本地点播服务，请确认程序仍在运行');
  }
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || data.ok === false) {
    const error = new Error(friendlyUpstreamError(data.error || `请求失败（HTTP ${response.status}）`));
    error.code = data.code || '';
    throw error;
  }
  return data;
}

function showToast(message, error = false) {
  clearTimeout(toastTimer);
  refs.toast.textContent = message;
  refs.toast.classList.toggle('error', error);
  refs.toast.classList.add('show');
  toastTimer = setTimeout(() => refs.toast.classList.remove('show'), 4200);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setPlayerState(potPlayer) {
  refs.playerState.classList.toggle('ready', Boolean(potPlayer?.found));
  refs.playerState.classList.toggle('missing', !potPlayer?.found);
  refs.playerStateText.textContent = potPlayer?.found ? 'PotPlayer 已就绪' : '未找到 PotPlayer';
  refs.potPlayerPath.value = potPlayer?.path || '';
}

function updateSourceStatus(sourceStatus) {
  if (!sourceStatus) return;
  state.health.sourceStatus = sourceStatus;
  const changed = sourceStatus.state === 'changed';
  refs.sourceAlert.hidden = !changed;
  refs.sourceAlertText.textContent = changed ? sourceStatus.message : '';
}

function allTabs() {
  return [...(state.health?.tabs || []), ...LIBRARY_TABS];
}

function activeTabName() {
  return allTabs().find((tab) => tab.id === state.activeTab)?.name || '内容';
}

function isLibraryTab() {
  return LIBRARY_TABS.some((tab) => tab.id === state.activeTab);
}

function renderTabs() {
  refs.tabs.replaceChildren();
  for (const tab of allTabs()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab-button';
    button.textContent = tab.name;
    button.dataset.tab = tab.id;
    button.classList.toggle('active', state.activeTab === tab.id && !state.search);
    button.setAttribute('aria-current', state.activeTab === tab.id && !state.search ? 'page' : 'false');
    button.addEventListener('click', () => {
      if (state.loading) return;
      state.search = '';
      refs.searchInput.value = '';
      state.activeTab = tab.id;
      state.page = 1;
      renderTabs();
      loadCatalog(true);
    });
    refs.tabs.append(button);
  }
}

function renderSkeletons() {
  refs.grid.replaceChildren();
  for (let index = 0; index < 12; index += 1) {
    const card = document.createElement('div');
    card.className = 'card skeleton';
    const poster = document.createElement('div');
    poster.className = 'poster';
    const copy = document.createElement('div');
    copy.className = 'card-copy';
    card.append(poster, copy);
    refs.grid.append(card);
  }
}

function imageUrl(value) {
  return `/api/image?url=${encodeURIComponent(value)}`;
}

function historyLabel(item) {
  if (!item.episodeName) return item.remark || '最近点播';
  return `上次点播：${item.episodeName}`;
}

function cardElement(item) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.setAttribute('aria-label', `查看《${item.title}》剧集`);

  const poster = document.createElement('div');
  poster.className = 'poster';
  const fallback = document.createElement('span');
  fallback.className = 'poster-fallback';
  fallback.textContent = 'HG';
  poster.append(fallback);
  if (item.image) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.src = imageUrl(item.image);
    image.addEventListener('error', () => image.remove());
    poster.append(image);
  }

  const copy = document.createElement('div');
  copy.className = 'card-copy';
  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = item.title;
  const remark = document.createElement('p');
  remark.className = 'card-remark';
  remark.textContent = item.episodeName ? historyLabel(item) : item.remark || '点击查看剧集';
  copy.append(title, remark);
  card.append(poster, copy);
  card.addEventListener('click', () => openDetail(item));
  return card;
}

function emptyMessage() {
  if (state.activeTab === 'favorites' && !state.search) return ['还没有收藏', '打开作品详情后点击“收藏”。'];
  if (state.activeTab === 'history' && !state.search) return ['还没有观看记录', '成功交给 PotPlayer 的剧集会显示在这里。'];
  if (state.search) return ['没有找到相关内容', '换个关键词再试一次。'];
  return ['这里暂时没有内容', '换个分类再试一次。'];
}

function renderItems() {
  refs.grid.replaceChildren(...state.items.map(cardElement));
  refs.empty.hidden = state.items.length > 0;
  const [title, copy] = emptyMessage();
  refs.emptyTitle.textContent = title;
  refs.emptyCopy.textContent = copy;
  refs.loadMore.hidden = !state.hasMore || state.items.length === 0 || isLibraryTab();
  refs.resultNote.textContent = state.items.length ? `已显示 ${state.items.length} 项` : '';
  refs.clearHistory.hidden = state.activeTab !== 'history' || Boolean(state.search) || state.items.length === 0;
  refs.catalog.setAttribute('aria-busy', 'false');
}

async function refreshLibrary() {
  const data = await api('/api/library');
  state.library = { favorites: data.favorites || [], history: data.history || [] };
  return state.library;
}

function libraryItems() {
  return state.activeTab === 'favorites' ? state.library.favorites : state.library.history;
}

async function loadCatalog(reset = false) {
  if (state.loading) return;
  state.loading = true;
  refs.catalog.setAttribute('aria-busy', 'true');
  if (reset) {
    state.items = [];
    state.page = 1;
    renderSkeletons();
  }
  refs.pageKicker.textContent = state.search ? 'SEARCH' : isLibraryTab() ? 'MY LIBRARY' : 'LOCAL VOD';
  refs.pageTitle.textContent = state.search ? `搜索“${state.search}”` : activeTabName();
  try {
    let data;
    if (!state.search && isLibraryTab()) {
      await refreshLibrary();
      data = { list: libraryItems(), hasMore: false };
    } else {
      data = state.search
        ? await api(`/api/search?q=${encodeURIComponent(state.search)}&page=${state.page}`)
        : await api(`/api/catalog?tab=${encodeURIComponent(state.activeTab)}&page=${state.page}`);
      updateSourceStatus(data.sourceStatus);
    }
    if (!reset && data.list.length === 0) {
      state.page = Math.max(1, state.page - 1);
      state.hasMore = false;
      renderItems();
      showToast('已经是最后一页');
      return;
    }
    state.items = reset
      ? data.list
      : [...state.items, ...data.list.filter((item) => !state.items.some((old) => old.id === item.id))];
    state.hasMore = Boolean(data.hasMore && data.list.length);
    renderItems();
  } catch (error) {
    if (reset) state.items = [];
    state.hasMore = false;
    renderItems();
    if (error.code === 'SOURCE_STRUCTURE_CHANGED') {
      updateSourceStatus({ state: 'changed', message: error.message });
    }
    showToast(error.message, true);
  } finally {
    state.loading = false;
    refs.loadMore.disabled = false;
  }
}

function detailPoster(image) {
  refs.detailPoster.querySelector('img')?.remove();
  if (!image) return;
  const element = document.createElement('img');
  element.alt = '';
  element.src = imageUrl(image);
  element.addEventListener('error', () => element.remove());
  refs.detailPoster.append(element);
}

function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
  }
}

function favoriteEntry() {
  return state.library.favorites.find((item) => item.id === state.detail?.id);
}

function historyEntry() {
  return state.library.history.find((item) => item.id === state.detail?.id);
}

function updateDetailLibraryActions() {
  const favorite = Boolean(favoriteEntry());
  refs.favoriteButton.classList.toggle('active', favorite);
  refs.favoriteButton.textContent = favorite ? '★ 已收藏' : '☆ 收藏';
  const history = historyEntry();
  const resumable = history && state.detail?.episodes.some((episode) => String(episode.ep) === String(history.ep));
  refs.resumeButton.hidden = !resumable;
  refs.resumeButton.textContent = resumable ? `继续点播 ${history.episodeName || `第${history.ep}集`}` : '继续点播';
}

function rememberHistory(entry) {
  if (!entry) return;
  state.library.history = [entry, ...state.library.history.filter((item) => item.id !== entry.id)];
  updateDetailLibraryActions();
}

async function playEpisode(episode, button) {
  setBusy(button, true, '验证中…');
  try {
    const result = await api('/api/play', {
      method: 'POST',
      body: JSON.stringify({ id: state.detail.id, ep: episode.ep }),
    });
    rememberHistory(result.history);
    showToast(`播放预检通过，已交给 PotPlayer：${result.episode}`);
  } catch (error) {
    showToast(error.message, true);
    if (/PotPlayer/.test(error.message)) openSettings();
    if (error.code === 'SOURCE_STRUCTURE_CHANGED') updateSourceStatus({ state: 'changed', message: error.message });
  } finally {
    setBusy(button, false);
  }
}

function renderDetail(detail) {
  state.detail = detail;
  refs.detailTitle.textContent = detail.title;
  refs.detailDescription.textContent = detail.description || '选择一集后，会先验证播放清单和媒体片段，再交给 PotPlayer。';
  detailPoster(detail.image);
  refs.episodeCount.textContent = `${detail.episodes.length} 集`;
  refs.episodeGrid.replaceChildren();
  for (const episode of detail.episodes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'episode-button';
    button.textContent = episode.name;
    button.addEventListener('click', () => playEpisode(episode, button));
    refs.episodeGrid.append(button);
  }
  updateDetailLibraryActions();
  refs.detailLoading.hidden = true;
  refs.detailContent.hidden = false;
}

async function openDetail(item) {
  state.detail = null;
  refs.detailLoading.hidden = false;
  refs.detailContent.hidden = true;
  refs.detailDialog.showModal();
  try {
    const data = await api(`/api/detail/${encodeURIComponent(item.id)}`);
    updateSourceStatus(data.sourceStatus);
    renderDetail({ ...data.detail, title: data.detail.title || item.title, image: data.detail.image || item.image });
  } catch (error) {
    refs.detailDialog.close();
    if (error.code === 'SOURCE_STRUCTURE_CHANGED') updateSourceStatus({ state: 'changed', message: error.message });
    showToast(error.message, true);
  }
}

function updatePlaylistProgress(job) {
  const total = Math.max(0, Number(job.total) || 0);
  const completed = Math.max(0, Number(job.completed) || 0);
  const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 4;
  refs.playlistProgressBar.style.width = `${percent}%`;
  refs.playlistProgressText.textContent = total
    ? `${job.message} · ${completed}/${total}（成功 ${job.succeeded}，失败 ${job.failed}）`
    : job.message;
}

async function monitorPlaylistJob(jobId) {
  while (state.playlistJob === jobId) {
    const data = await api(`/api/playlist-jobs/${encodeURIComponent(jobId)}`);
    const job = data.job;
    updatePlaylistProgress(job);
    if (job.status === 'complete') {
      const opened = await api(`/api/playlist-jobs/${encodeURIComponent(jobId)}/open`, {
        method: 'POST',
        body: '{}',
      });
      const skipped = Number(opened.skippedEpisodes || 0);
      showToast(skipped
        ? `已加入 ${opened.includedEpisodes} 集，跳过 ${skipped} 集；失败详情可在诊断中查看`
        : `已验证并加入 ${opened.includedEpisodes} 集到 PotPlayer`);
      return;
    }
    if (job.status === 'cancelled') {
      showToast('整剧任务已取消');
      return;
    }
    if (job.status === 'failed') throw new Error(job.message || '整剧解析失败');
    await sleep(450);
  }
}

async function openWholePlaylist() {
  if (!state.detail || state.playlistJob) return;
  setBusy(refs.openPlaylist, true, '正在准备…');
  refs.playlistProgress.hidden = false;
  refs.cancelPlaylist.disabled = false;
  refs.playlistProgressBar.style.width = '4%';
  refs.playlistProgressText.textContent = '正在创建整剧任务';
  try {
    const data = await api('/api/playlist-jobs', {
      method: 'POST',
      body: JSON.stringify({ id: state.detail.id }),
    });
    state.playlistJob = data.job.id;
    await monitorPlaylistJob(data.job.id);
  } catch (error) {
    showToast(error.message, true);
    if (/PotPlayer/.test(error.message)) openSettings();
  } finally {
    state.playlistJob = '';
    setBusy(refs.openPlaylist, false);
    refs.cancelPlaylist.disabled = false;
    setTimeout(() => {
      if (!state.playlistJob) refs.playlistProgress.hidden = true;
    }, 1000);
  }
}

async function cancelPlaylistJob() {
  if (!state.playlistJob) return;
  refs.cancelPlaylist.disabled = true;
  refs.playlistProgressText.textContent = '正在取消任务…';
  try {
    await api(`/api/playlist-jobs/${encodeURIComponent(state.playlistJob)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
  } catch (error) {
    refs.cancelPlaylist.disabled = false;
    showToast(error.message, true);
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
}

async function copyPlaylistUrl() {
  if (!state.detail) return;
  const url = `${location.origin}/api/playlist/${state.detail.id}.m3u?token=${encodeURIComponent(state.sessionToken)}`;
  const response = await fetch(url, {
    method: 'HEAD',
    headers: { 'X-HG-Token': state.sessionToken },
  });
  if (response.status === 404) {
    showToast('请先点击“整剧加入 PotPlayer”生成并验证播放列表', true);
    return;
  }
  if (!response.ok) {
    showToast(`无法读取已生成的 M3U（HTTP ${response.status}）`, true);
    return;
  }
  await copyText(url);
  showToast('直链 M3U 下载地址已复制；服务重启后需重新复制该下载地址');
}

async function toggleFavorite() {
  if (!state.detail) return;
  const favorite = !favoriteEntry();
  setBusy(refs.favoriteButton, true, favorite ? '正在收藏…' : '正在移除…');
  try {
    const data = await api('/api/favorites', {
      method: 'POST',
      body: JSON.stringify({ id: state.detail.id, favorite }),
    });
    state.library = { favorites: data.favorites, history: data.history };
    updateDetailLibraryActions();
    showToast(favorite ? '已加入收藏' : '已取消收藏');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    refs.favoriteButton.disabled = false;
    delete refs.favoriteButton.dataset.label;
    updateDetailLibraryActions();
  }
}

function resumeLastEpisode() {
  const history = historyEntry();
  if (!history || !state.detail) return;
  const episode = state.detail.episodes.find((item) => String(item.ep) === String(history.ep));
  if (episode) playEpisode(episode, refs.resumeButton);
}

function openSettings() {
  refs.potPlayerPath.value = state.health?.potPlayer?.path || '';
  refs.dataDirectory.value = state.health?.dataDirectory || '';
  if (!refs.settingsDialog.open) refs.settingsDialog.showModal();
}

function diagnosticsText(diagnostics) {
  const safe = {
    generatedAt: diagnostics.generatedAt,
    app: diagnostics.app,
    potPlayer: diagnostics.potPlayer,
    source: diagnostics.source,
    retry: diagnostics.retry,
    jobs: diagnostics.jobs,
    events: diagnostics.events,
  };
  return JSON.stringify(safe, null, 2);
}

async function loadDiagnostics() {
  refs.diagnosticsOutput.textContent = '正在读取诊断信息…';
  try {
    const data = await api('/api/diagnostics');
    state.diagnosticsText = diagnosticsText(data.diagnostics);
    refs.diagnosticsOutput.textContent = state.diagnosticsText;
    updateSourceStatus(data.diagnostics.source);
  } catch (error) {
    refs.diagnosticsOutput.textContent = `诊断读取失败：${error.message}`;
  }
}

function openDiagnostics() {
  if (!refs.diagnosticsDialog.open) refs.diagnosticsDialog.showModal();
  loadDiagnostics();
}

async function refreshHealth() {
  const data = await api('/api/health');
  state.health = data;
  state.sessionToken = data.sessionToken || '';
  setPlayerState(data.potPlayer);
  refs.dataDirectory.value = data.dataDirectory || '';
  updateSourceStatus(data.sourceStatus);
  return data;
}

refs.searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  state.search = refs.searchInput.value.trim();
  state.page = 1;
  renderTabs();
  loadCatalog(true);
});

refs.loadMore.addEventListener('click', () => {
  if (state.loading) return;
  state.page += 1;
  refs.loadMore.disabled = true;
  loadCatalog(false);
});

refs.playerState.addEventListener('click', openSettings);
refs.settingsButton.addEventListener('click', openSettings);
refs.diagnosticsButton.addEventListener('click', openDiagnostics);
refs.sourceAlertDiagnostics.addEventListener('click', openDiagnostics);
refs.favoriteButton.addEventListener('click', toggleFavorite);
refs.resumeButton.addEventListener('click', resumeLastEpisode);
refs.openPlaylist.addEventListener('click', openWholePlaylist);
refs.cancelPlaylist.addEventListener('click', cancelPlaylistJob);
refs.copyPlaylist.addEventListener('click', copyPlaylistUrl);
refs.refreshDiagnostics.addEventListener('click', loadDiagnostics);
refs.copyDiagnostics.addEventListener('click', async () => {
  if (!state.diagnosticsText) await loadDiagnostics();
  await copyText(state.diagnosticsText || refs.diagnosticsOutput.textContent);
  showToast('诊断信息已复制');
});

refs.clearHistory.addEventListener('click', async () => {
  if (!confirm('清空全部观看记录？收藏不会受到影响。')) return;
  try {
    const data = await api('/api/history/clear', { method: 'POST', body: '{}' });
    state.library = { favorites: data.favorites, history: data.history };
    await loadCatalog(true);
    showToast('观看记录已清空');
  } catch (error) {
    showToast(error.message, true);
  }
});

refs.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = refs.settingsForm.querySelector('[type="submit"]');
  setBusy(button, true, '正在保存…');
  try {
    const data = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ potPlayerPath: refs.potPlayerPath.value.trim() }),
    });
    state.health.potPlayer = data.potPlayer;
    setPlayerState(data.potPlayer);
    refs.settingsDialog.close();
    showToast('PotPlayer 路径已保存');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

refs.restartButton.addEventListener('click', async () => {
  if (!confirm('重启本地点播服务？当前页面会自动重新连接。')) return;
  try {
    await api('/api/restart', { method: 'POST', body: '{}' });
    showToast('服务正在重启…');
    setTimeout(() => location.reload(), 1900);
  } catch (error) {
    showToast(error.message, true);
  }
});

refs.shutdownButton.addEventListener('click', async () => {
  if (!confirm('关闭本地点播服务？网页和 M3U 下载地址会停止访问。')) return;
  try {
    await api('/api/shutdown', { method: 'POST', body: '{}' });
    document.body.replaceChildren();
    const message = document.createElement('main');
    message.innerHTML = '<h1>本地服务已关闭</h1><p>可以安全关闭这个页面；也可以从压缩包重新启动。</p>';
    document.body.append(message);
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => document.getElementById(button.dataset.close).close());
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

async function init() {
  try {
    await refreshHealth();
    await refreshLibrary();
    renderTabs();
    await loadCatalog(true);
  } catch (error) {
    refs.grid.replaceChildren();
    refs.empty.hidden = false;
    refs.pageTitle.textContent = '本地服务初始化失败';
    showToast(error.message, true);
  }
}

init();
