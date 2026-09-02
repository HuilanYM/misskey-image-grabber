// 管理页：任务编排（抓取 → 预览选择 → 导出）
// API 走 misskey.io 页面上下文中继（与正常浏览同源同会话），无页面时回退扩展直连

import { Crawler } from '../lib/crawl.js';
import { createApiClient, interruptibleSleep } from '../lib/api.js';
import * as store from '../lib/store.js';
import { collectFiles, buildArchiveHtml, buildDataJson, buildCsv } from '../lib/render.js';
import { StoreZip } from '../lib/zip.js';
import { t as tt, normalizeLang, detectUiLang } from '../lib/i18n.js';
import * as history from '../lib/history.js';
import * as archstore from '../lib/archstore.js';
import { supportsDirPicker, pickDirectory, loadHandle, hasPermission, requestPermission, writeFileIn, fileExists, listEntries, readFileText } from './dirhandle.js';
import { recoverUserFromPayload } from '../lib/recover.js';
import { sleep, rand, sanitizeFilename, imageFileName, noteImages, filePasses, fmtBytes, hash6 } from '../lib/util.js';

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

let task = null; // 当前任务（store.Task）
let crawler = null;
let paused = false;
let aborted = false;
let crawlStarting = false;
let backoffUntil = 0;
let exAbort = false;
let exporting = false;
let items = []; // collectFiles 结果
const selected = new Set(); // fileId -> bool
let ownedFiles = new Set(); // 该用户过往已下载的 fileId
let saveDir = null; // 自选保存文件夹句柄 {handle,name}
let uiLang = 'zh-CN'; // 界面语言（mg:lang）
const T = (k, vars) => tt(uiLang, k, vars);

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { const k = el.getAttribute('data-i18n'); const v = tt(uiLang, k); if (v !== k) el.textContent = v; });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { const k = el.getAttribute('data-i18n-ph'); const v = tt(uiLang, k); if (v !== k) el.placeholder = v; });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { const k = el.getAttribute('data-i18n-title'); const v = tt(uiLang, k); if (v !== k) el.title = v; });
}

// ---------------- 网络层 ----------------

/** 给任意 Promise 加超时（超时 reject，由调用方决定换路或回退） */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function relayFetch(path, body) {
  // 1) 优先经 misskey.io 标签页中继（活动标签优先，避开休眠标签；单个 20s 无响应换下一个）
  try {
    const tabs = await chrome.tabs.query({ url: 'https://misskey.io/*' });
    tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    for (const t of tabs.slice(0, 3)) {
      try {
        const r = await withTimeout(chrome.tabs.sendMessage(t.id, { type: 'mg:api', path, body }), 20_000);
        if (r && typeof r.status === 'number') return { ok: !!r.ok, status: r.status, json: r.json };
      } catch (e) { /* 该 tab 休眠/无响应/无 content script，试下一个 */ }
    }
  } catch (e) { /* 查询失败走回退 */ }
  // 2) 回退扩展直连（30s 超时，避免网络卡死无限等待）
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch('https://misskey.io/api/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* 空 body */ }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(to);
  }
}

const api = createApiClient({
  fetchImpl: relayFetch,
  hooks: {
    lang: () => uiLang,
    onBackoff: (sec) => {
      backoffUntil = Date.now() + sec * 1000;
      setStatus(T('backoffWaitShort').replace('{s}', sec), true);
    },
    onTokenInvalid: () => {
      tokenCache = null;
      chrome.storage.local.set({ 'mk:token': null });
      updateTokenPill();
    },
    shouldAbort: () => aborted || exAbort,
  },
});

// token 同步缓存（storage 读取是异步的，client 里用同步 getter）
let tokenCache = null;
api.setTokenGetter(() => tokenCache);
function refreshTokenCache() {
  chrome.storage.local.get('mk:token').then((o) => {
    tokenCache = o['mk:token'] || null;
    updateTokenPill();
  });
}
chrome.storage.onChanged.addListener((changes) => {
  if (changes['mk:token']) refreshTokenCache();
});
// misskey.io 标签开关/导航都会改变抓取通道状态，自动重查（带节流）
if (chrome.tabs) {
  const poke = () => updateTokenPill();
  chrome.tabs.onRemoved.addListener(poke);
  chrome.tabs.onUpdated.addListener((id, info, tab) => { if (tab.url && tab.url.includes('misskey.io')) poke(); });
  chrome.tabs.onCreated.addListener((tab) => { if (tab.pendingUrl && tab.pendingUrl.includes('misskey.io')) poke(); });
}
// 覆盖 client 的 getToken
api.getToken = () => tokenCache;

// 抓取状态胶囊（三态，移植启动页检测）：ok=登录会话 / warn=已开页未登录 / dim=无 misskey.io 页面（API 中继不可用，无法抓取）
// tokenCache 命中走快速通道；否则实时向 misskey.io 标签的 content script 发 mg:scan-token 扫描
function setPill(text, cls) {
  const el = $('tokenState');
  el.className = 'pill ' + cls;
  el.title = T('pillRecheck');
  if (!el.querySelector('.dot')) { const d = document.createElement('i'); d.className = 'dot'; el.appendChild(d); }
  let sp = el.querySelector('span');
  if (!sp) { sp = document.createElement('span'); el.appendChild(sp); }
  sp.textContent = text;
}
let tokenStateTimer = null;
function updateTokenPill(force) {
  if (force) { clearTimeout(tokenStateTimer); tokenStateTimer = null; }
  if (tokenStateTimer) return; // 节流：tabs.onUpdated 等高频触发合并
  tokenStateTimer = setTimeout(async () => {
    tokenStateTimer = null;
    // 先查通道：API 请求经 misskey.io 标签中继，标签全关时无论有无缓存 token 都无法抓取
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: 'https://misskey.io/*' }); } catch (e) {}
    if (!tabs.length) { setPill(T('pillNoTab'), 'dim'); return; }
    if (tokenCache) { setPill(T('pillOk'), 'ok'); return; } // 缓存命中（content script 每 15s 刷新）免一次往返
    let r = null;
    try { r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'mg:scan-token' }).catch(() => null); } catch (e) {}
    if (r && r.token) setPill(T('pillOk'), 'ok');
    else setPill(T('pillNoLogin'), 'warn');
  }, force ? 0 : 400);
}
$('tokenState').addEventListener('click', () => { setPill(T('pillChecking'), 'dim'); updateTokenPill(true); });

// ---------------- UI 辅助 ----------------

function show(id) { ['secSetup', 'secProgress', 'secExport', 'secHistory'].forEach((s) => $(s).classList.toggle('hidden', s !== id)); }
function setStatus(text, warn = false) {
  const el = $('statusLine');
  el.textContent = text;
  el.classList.toggle('backoff', warn);
}
function log(msg, cls = '') {
  const el = $('exLog');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = msg;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function setExProgress(done, total, text) {
  $('exProgress').classList.remove('hidden');
  const known = Number.isFinite(total) && total > 0; // 负值=未知总量（如媒体限流等待），不显示假 100%
  $('exBar').style.width = known ? Math.min(100, Math.round((done / total) * 100)) + '%' : '0%';
  $('exText').textContent = text || `${done} / ${known ? total : '?'}`;
}

// 抓取进度条 + 已用时
let elapsedTimer = null;
let elapsedStart = 0;

function startElapsed() {
  stopElapsed();
  elapsedStart = Date.now();
  $('elapsed').textContent = T('elapsedFmt').replace('{t}', '0:00');
  elapsedTimer = setInterval(() => {
    const s = Math.floor((Date.now() - elapsedStart) / 1000);
    $('elapsed').textContent = T('elapsedFmt').replace('{t}', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  }, 1000);
}

function stopElapsed() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
}

/** pct=null 表示总量未知（动画条），否则显示百分比 */
function setCrawlBar(pct) {
  const wrap = $('crawlBarWrap');
  const bar = $('crawlBar');
  if (pct == null) {
    wrap.classList.add('indet');
    bar.style.width = '30%';
    $('pct').textContent = T('indeterminate');
  } else {
    wrap.classList.remove('indet');
    bar.style.width = pct + '%';
    $('pct').textContent = pct + '%';
  }
}

// 退避倒计时刷新
setInterval(() => {
  if (backoffUntil > Date.now()) {
    const s = Math.ceil((backoffUntil - Date.now()) / 1000);
    $('statusLine').classList.add('backoff');
    $('statusLine').textContent = T('backoffWait').replace('{s}', s);
  }
}, 500);

// ---------------- 表单 ----------------

const PRESETS = {
  safest: { pace: 'safest', limit: 10, mediaPace: 'gentle', descKey: 'presetDescSafest' },
  balanced: { pace: 'normal', limit: 40, mediaPace: 'normal', descKey: 'presetDescBalanced' },
  fast: { pace: 'fast', limit: 100, mediaPace: 'fast', descKey: 'presetDescFast' },
};

function applyPreset(key) {
  const p = PRESETS[key] || PRESETS.balanced;
  $('pace').value = p.pace;
  $('limit').value = p.limit;
  $('mediaPace').value = p.mediaPace;
  $('presetDesc').textContent = T(p.descKey);
}

function readForm() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  const since = $('sinceDate').value ? new Date($('sinceDate').value + 'T00:00:00').getTime() : 0;
  const until = $('untilDate').value ? new Date($('untilDate').value + 'T23:59:59').getTime() : 0;
  const allFmts = ['jpg', 'png', 'gif', 'webp', 'avif'];
  const fmts = Array.from(document.querySelectorAll('.fmt:checked')).map((c) => c.value);
  return {
    mode,
    pace: $('pace').value,
    preset: $('preset').value,
    limit: Math.min(100, Math.max(10, Number($('limit').value) || 40)),
    maxNotes: Math.max(0, Number($('maxNotes').value) || 0),
    maxImages: Math.max(0, Number($('maxImages').value) || 0),
    withRenotes: $('withRenotes').checked,
    onlyOriginal: $('onlyOriginal').checked,
    sinceDate: since,
    untilDate: until,
    // 全勾或全不勾都视为"不限制"，部分勾选才过滤
    formats: fmts.length === 0 || fmts.length === allFmts.length ? [] : fmts,
    minW: Math.max(0, Number($('minW').value) || 0),
    minH: Math.max(0, Number($('minH').value) || 0),
    minKB: Math.max(0, Number($('minKB').value) || 0),
    skipSensitive: $('skipSensitive').checked,
    nameTemplate: $('nameTemplate').value,
    groupBy: $('groupBy').value,
    archiveOrder: $('archiveOrder').value,
    revealSens: $('revealSens').checked,
    mediaPace: $('mediaPace').value,
    saveTarget: $('saveTarget').value,
    skipOwned: $('skipOwned').checked,
    archiveLang: $('archiveLang').value,
  };
}

function msToDate(ms) { // 存储的是本地毫秒，回填 input[type=date] 用本地日期防时区漂移
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function fillForm(s) {
  if (s.user) $('userInput').value = s.user;
  if (s.mode) document.querySelector(`input[name=mode][value=${s.mode}]`).checked = true;
  if (s.pace) $('preset').value = s.preset;
  if (s.pace) $('pace').value = s.pace;
  if (s.limit) $('limit').value = s.limit;
  if (s.maxNotes != null) $('maxNotes').value = s.maxNotes;
  if (s.maxImages != null) $('maxImages').value = s.maxImages;
  if (s.withRenotes != null) $('withRenotes').checked = s.withRenotes;
  if (s.onlyOriginal != null) $('onlyOriginal').checked = s.onlyOriginal;
  if (s.nameTemplate) $('nameTemplate').value = s.nameTemplate;
  if (s.groupBy) $('groupBy').value = s.groupBy;
  if (s.archiveOrder) $('archiveOrder').value = s.archiveOrder;
  if (s.revealSens != null) $('revealSens').checked = s.revealSens;
  if (s.mediaPace) $('mediaPace').value = s.mediaPace;
  if (s.saveTarget) $('saveTarget').value = s.saveTarget;
  if (s.skipOwned != null) $('skipOwned').checked = s.skipOwned;
  if (s.archiveLang) $('archiveLang').value = s.archiveLang;
  if (s.minW) $('minW').value = s.minW;
  if (s.minH) $('minH').value = s.minH;
  if (s.minKB) $('minKB').value = s.minKB;
  if (s.skipSensitive) $('skipSensitive').checked = s.skipSensitive;
  if (s.sinceDate) $('sinceDate').value = msToDate(s.sinceDate);
  if (s.untilDate) $('untilDate').value = msToDate(s.untilDate);
  if (Array.isArray(s.formats)) {
    // 空 = 不限（全勾）；非空 = 只勾选中的
    document.querySelectorAll('.fmt').forEach((c) => (c.checked = s.formats.length === 0 || s.formats.includes(c.value)));
  }
  $('presetDesc').textContent = T((PRESETS[$('preset').value] || PRESETS.balanced).descKey);
}

// ---------------- 抓取 ----------------

function crawlHooks() {
  return {
    onNote: (note) => {
      const imgs = noteImages(note, task.opts);
      $('stNotes').textContent = task.state.notes.length;
      $('stImgs').textContent = Number($('stImgs').textContent || 0) + imgs.length;
      for (const f of imgs) {
        const img = document.createElement('img');
        img.src = f.thumbnailUrl || f.url;
        img.loading = 'lazy';
        if (f.isSensitive) img.className = 'sens';
        img.title = new Date(note.createdAt).toLocaleString();
        $('thumbs').appendChild(img);
      }
    },
    onProgress: () => {
      $('stReq').textContent = task.state.requests;
      const maxN = task.opts.maxNotes | 0;
      const maxI = task.opts.maxImages | 0;
      let pct = null;
      if (maxN) pct = Math.min(100, Math.round((task.state.notes.length / maxN) * 100));
      if (maxI && !maxN) pct = Math.min(100, Math.round((Number($('stImgs').textContent || 0) / maxI) * 100));
      setCrawlBar(pct);
      store.saveTask(task);
    },
    onStatus: (t) => { if (backoffUntil < Date.now()) setStatus(t); },
    shouldPause: () => paused,
    shouldAbort: () => aborted,
  };
}

async function startCrawl(input) {
  aborted = false; // 上一次「停止」的标志必须在此清掉，否则本会话内所有后续抓取都会秒失败
  const opts = readForm();
  $('setupMsg').textContent = '';
  show('secProgress');
  $('stReq').textContent = '0';
  $('stNotes').textContent = '0';
  $('stImgs').textContent = '0';
  $('thumbs').innerHTML = '';
  setCrawlBar(null);
  startElapsed();
  setStatus(T('querying'));

  const c = new Crawler({ api, opts: {}, state: {}, hooks: crawlHooks(), lang: uiLang });
  const ru = await c.resolveUser(input);
  if (!ru.ok) {
    stopElapsed();
    show('secSetup');
    $('setupMsg').textContent = '❌ ' + ru.message;
    return;
  }

  task = {
    user: ru.user,
    opts,
    state: { userId: ru.user.id, untilId: null, seen: {}, notes: [], requests: 0, done: false },
    status: 'running',
    startedAt: Date.now(),
  };
  await store.saveTask(task);
  await store.saveSettings({ user: input });
  await runCrawler();
}

async function resumeCrawl() {
  aborted = false; // 同 startCrawl：续抓入口也要清掉上一次「停止」的标志
  const opts = task.opts;
  crawler = new Crawler({ api, opts, state: task.state, hooks: crawlHooks(), lang: uiLang });
  show('secProgress');
  startElapsed();
  setCrawlBar(opts.maxNotes ? Math.min(100, Math.round((task.state.notes.length / opts.maxNotes) * 100)) : null);
  // 恢复统计
  $('stReq').textContent = task.state.requests;
  $('stNotes').textContent = task.state.notes.length;
  $('stImgs').textContent = task.state.notes.reduce((s, n) => s + noteImages(n, task.opts).length, 0);
  await runCrawler();
}

async function runCrawler() {
  crawler = new Crawler({ api, opts: task.opts, state: task.state, hooks: crawlHooks(), lang: uiLang });
  let r;
  try {
    r = await crawler.run();
  } finally {
    // run() 内抛错也要停计时器并复位暂停按钮，否则界面永久停在「抓取中」
    stopElapsed();
    paused = false;
    $('btnPause').textContent = T('pause');
  }
  stopElapsed();
  paused = false;
  $('btnPause').textContent = T('pause');
  setCrawlBar(100);

  // noMatch 提前停止与 error/ratelimited 都保持 running 状态：横幅提供「继续抓取」真断点续扫
  task.status = r.reason === 'noMatch' || r.reason === 'error' || r.reason === 'ratelimited' ? 'running' : 'crawled';
  await store.saveTask(task);

  const reasonText = T('r_' + r.reason) !== 'r_' + r.reason ? T('r_' + r.reason) : r.reason;
  $('crawlSummary').textContent = T('summary', {
    user: task.user.username,
    n: task.state.notes.length,
    m: collectFiles(task.state.notes, task.opts).length,
    k: task.state.requests,
    reason: reasonText + (r.message ? ' · ' + r.message : ''),
  });

  if (r.reason === 'error' || r.reason === 'ratelimited') {
    setStatus(T('taskSaved') + (r.message || ''), true);
  }
  await enterExport();
  show('secExport');
}

// ---------------- 导出：选择区 ----------------

/** 进入导出页：载入过滤结果与过往记录，应用"默认跳过已拥有"规则 */
async function enterExport() {
  items = collectFiles(task.state.notes, task.opts);
  try {
    ownedFiles = await history.ownedSet(task.user.id);
  } catch (e) {
    ownedFiles = new Set();
  }
  const skipOwned = $('skipOwned').checked;
  selected.clear();
  for (const it of items) {
    it._owned = ownedFiles.has(it.file.id);
    if (!(it._owned && skipOwned)) selected.add(it.file.id);
  }
  renderGrid();
}

/** 按 selected 当前状态渲染网格（不重置选择） */
function renderGrid() {
  const grid = $('fileGrid');
  grid.innerHTML = '';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'fitem' + (selected.has(it.file.id) ? ' on' : '') + (it._owned ? ' owned' : '');
    d.title = it.localName + (it._owned ? T('fOwnTitle') : '');
    const img = document.createElement('img');
    img.src = it.file.thumbnailUrl || it.file.url;
    img.loading = 'lazy';
    if (it.file.isSensitive) img.className = 'sens';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = selected.has(it.file.id);
    chk.className = 'fchk';
    const toggle = (on) => {
      d.classList.toggle('on', on);
      chk.checked = on;
      on ? selected.add(it.file.id) : selected.delete(it.file.id);
      updateSelInfo();
    };
    chk.addEventListener('click', (e) => { e.stopPropagation(); toggle(chk.checked); });
    d.addEventListener('click', () => toggle(!d.classList.contains('on')));
    d.appendChild(img);
    d.appendChild(chk);
    if (it.file.isSensitive) {
      const s = document.createElement('span');
      s.className = 'fsens';
      s.textContent = '⚠';
      d.appendChild(s);
    }
    if (it._owned) {
      const s = document.createElement('span');
      s.className = 'fown';
      s.textContent = T('fOwnBadge');
      d.appendChild(s);
    }
    grid.appendChild(d);
  }
  updateSelInfo();
}

function updateSelInfo() {
  const n = items.filter((i) => selected.has(i.file.id)).length;
  const owned = items.filter((i) => i._owned).length;
  const bytes = items.filter((i) => selected.has(i.file.id)).reduce((s, i) => s + (i.file.size || 0), 0);
  $('selInfo').textContent = T('selInfo', {
    n, total: items.length,
    owned: owned ? T('selOwned').replace('{n}', owned) : '',
    bytes: fmtBytes(bytes),
  });
}

// ---------------- 导出：资源下载 ----------------

async function fetchUrlBytes(url, { label = '', on429Wait = true } = {}) {
  for (let a = 0; ; a++) {
    if (exAbort) throw new Error('cancelled');
    try {
      const res = await fetch(url);
      if (res.ok) return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
      if (res.status === 404 || res.status === 410) return null;
      if (res.status === 429 && on429Wait && a < 2) {
        setExProgress(-1, -1, T('mediaRateLimit').replace('{s}', a ? 60 : 15));
        await interruptibleSleep((a ? 60 : 15) * 1000, { shouldAbort: () => exAbort });
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (e.message === 'cancelled') throw e;
      if (a >= 2) throw e;
      await sleep(1200 * (a + 1));
    }
  }
}

/** URL 过期时通过 notes/show 刷新单条笔记取新地址 */
async function refreshFileUrl(item) {
  const res = await api.call('notes/show', { noteId: item.note.id });
  if (!res.ok || !Array.isArray(res.data.files)) return false;
  const f = res.data.files.find((x) => x.id === item.file.id);
  if (f && f.url) { item.file.url = f.url; return true; }
  return false;
}

/** 批量抓取选中图片字节（节奏随 mediaPace 设置） */
const MEDIA_PACE = {
  gentle: [700, 1800],
  normal: [220, 720],
  fast: [80, 280],
};

async function fetchSelectedImages(selItems) {
  const [pMin, pMax] = MEDIA_PACE[task.opts.mediaPace] || MEDIA_PACE.normal;
  const map = new Map(); // fileId -> {bytes}
  const failed = [];
  let done = 0;
  for (const it of selItems) {
    if (exAbort) break;
    let r = await fetchUrlBytes(it.file.url);
    if (!r) {
      const refreshed = await refreshFileUrl(it);
      if (refreshed) r = await fetchUrlBytes(it.file.url);
    }
    if (r) map.set(it.file.id, r);
    else failed.push(it);
    done++;
    setExProgress(done, selItems.length, T('logDlImg', { done, total: selItems.length, fail: failed.length }));
    if (done < selItems.length) await sleep(rand(pMin, pMax));
  }
  return { map, failed };
}

/** 头像 + 表情符号资源（HTML 档案离线显示用）；skipEmojiUrls 里已落地的表情不再重复下载 */
async function buildAssets(selItems, { needHtml, skipEmojiUrls = new Set() }) {
  const out = { avatar: null, avatarExt: 'png', emojiUrls: new Map(), emojiBytes: new Map(), emojiLocal: new Map() };
  if (!needHtml) return out;

  // 头像
  if (task.user.avatarUrl) {
    setExProgress(0, 1, T('dlAvatar'));
    const r = await fetchUrlBytes(task.user.avatarUrl, { label: '头像' });
    if (r) {
      out.avatar = r.bytes;
      const t = (r.type || '').split('/')[1];
      out.avatarExt = (t || 'png').replace('jpeg', 'jpg');
    }
  }

  // 表情来源1：笔记 reactionEmojis（键 name 或 name@host）
  for (const n of task.state.notes) {
    for (const [k, url] of Object.entries(n.reactionEmojis || {})) out.emojiUrls.set(k, url);
    for (const [k, url] of Object.entries((n.user && n.user.emojis) || {})) out.emojiUrls.set(k, url);
  }
  // 表情来源2：正文里出现的本地 :name: 表情 → meta / 逐个 emoji 接口
  const localNames = new Set();
  const re = /:([A-Za-z0-9_+\-.]+)(?:@([A-Za-z0-9_\-.]+))?:/g;
  const scan = (s) => { let m; while ((m = re.exec(String(s || '')))) { if (!m[2] || m[2] === '.') localNames.add(m[1]); } };
  for (const n of task.state.notes) { scan(n.text); scan(n.cw); }
  scan(task.user.description);
  scan(task.user.name);

  let metaMap = null;
  try {
    setExProgress(0, 1, T('dlEmojiMeta'));
    const meta = await api.call('meta', {});
    if (meta.ok && Array.isArray(meta.data.emojis)) {
      metaMap = new Map(meta.data.emojis.map((e) => [e.name, e.url]));
    }
  } catch (e) { /* 无 meta 权限时走逐个查询 */ }

  let li = 0;
  for (const name of localNames) {
    if (exAbort) break;
    if (out.emojiUrls.has(name)) continue;
    let url = metaMap ? metaMap.get(name) : null;
    if (!url) {
      if (li++ > 60) break;
      setExProgress(li, 60, T('dlEmojiQ').replace('{n}', li));
      const r = await api.call('emoji', { name });
      if (r.ok && r.data && r.data.url) url = r.data.url;
      await sleep(rand(150, 400));
    }
    if (url) out.emojiUrls.set(name, url);
  }

  // 表情字节：只抓有 host 权限的域名（misskey.io / *.misskeyusercontent.jp），
  // 其他实例的域名 fetch 必然因 CORS 失败，白耗重试时间——直接在线回退
  // 文件名用 URL 哈希，跨次导出保持一致（增量合并的关键）
  const EMOJI_OK_HOST = /(^|\.)misskey\.io$|(^|\.)misskeyusercontent\.jp$/;
  const urls = [...out.emojiUrls.values()].filter((u) => {
    if (skipEmojiUrls.has(u)) return false;
    try { return EMOJI_OK_HOST.test(new URL(u).hostname); } catch (e) { return false; }
  }).slice(0, 150);
  for (const url of urls) {
    if (exAbort) break;
    try {
      const r = await fetchUrlBytes(url, { on429Wait: false });
      if (r) {
        out.emojiBytes.set(url, r.bytes);
        const t = (r.type || '').split('/')[1];
        out.emojiLocal.set(url, '_emoji_' + hash6(url) + '.' + (t || 'png').replace('jpeg', 'jpg'));
      }
    } catch (e) { /* 无权限域名：在线回退 */ }
    await sleep(rand(80, 200));
  }
  return out;
}

/** 头像稳定文件名（URL 哈希，跨次导出一致） */
function avatarLocalName() {
  return task.user.avatarUrl ? '_avatar_' + hash6(task.user.avatarUrl) : null;
}

function makeEmojiRef(assets, { single = false, bytesOf = null }) {
  return (name, host) => {
    const key = host && host !== '.' ? name + '@' + host : name;
    const url = assets.emojiUrls.get(key) || assets.emojiUrls.get(name);
    if (!url) return null;
    const local = assets.emojiLocal.get(url);
    if (local && single && bytesOf) {
      const r = bytesOf(url);
      if (r) return { ref: `data:image/png;base64,${b64(r.bytes)}`, remote: url };
    }
    if (local) return { ref: 'images/' + local, remote: url };
    return { ref: null, remote: url };
  };
}

function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------------- 导出：下载落地 ----------------

function sanitizePath(p) {
  return p
    .split('/')
    .map((seg) => sanitizeFilename(seg, 120))
    .join('/');
}

// 等待 chrome.downloads 到终态：interrupted 返回 false（URL 过期/断网等），让上层 refreshFileUrl 重试生效；
// 查询不可用或超时按成功处理（维持旧宽容行为，不阻塞导出）
function dlWait(id, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!id || !chrome.downloads || !chrome.downloads.search) return resolve(true);
    const t0 = Date.now();
    const poll = () => {
      chrome.downloads.search({ id }, (items) => {
        const st = items && items[0] && items[0].state;
        if (st === 'complete') return resolve(true);
        if (st === 'interrupted') return resolve(false);
        if (Date.now() - t0 > timeoutMs) return resolve(true);
        setTimeout(poll, 400);
      });
    };
    poll();
  });
}

async function dl(urlOrBlob, filename, { overwrite = false } = {}) {
  const url = typeof urlOrBlob === 'string' ? urlOrBlob : URL.createObjectURL(urlOrBlob);
  try {
    const id = await chrome.downloads.download({
      url,
      filename: sanitizePath(filename),
      conflictAction: overwrite ? 'overwrite' : 'uniquify',
      saveAs: false,
    });
    return id;
  } finally {
    if (typeof urlOrBlob !== 'string') setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

// 字节落地前确保 Blob 有合理 MIME（无类型时 chrome.downloads 会按嗅探结果强行改扩展名）
const MIME_BY_EXT = {
  webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  avif: 'image/avif', html: 'text/html', json: 'application/json', csv: 'text/csv', zip: 'application/zip',
  txt: 'text/plain',
};
function toBlob(data, pathForExt) {
  if (data instanceof Blob && data.type) return data;
  const ext = (String(pathForExt || '').split('.').pop() || '').toLowerCase();
  const type = (data instanceof Blob && data.type) || MIME_BY_EXT[ext] || 'application/octet-stream';
  return new Blob([data instanceof Blob ? data : [data]], { type });
}

/** 快照时间戳（用于 _snapshots 内的文件名） */
function tsName() {
  const ts = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${ts.getFullYear()}${p(ts.getMonth() + 1)}${p(ts.getDate())}-${p(ts.getHours())}${p(ts.getMinutes())}${p(ts.getSeconds())}`;
}

/** 档案主文件夹名（每用户一个：archive.html 入口 + images/ + _data/ + _snapshots/） */
function stableUserFolder(user) {
  return sanitizeFilename(user.username + (user.host ? '@' + user.host : ''));
}

/**
 * 导出写入器：自选文件夹模式直接写文件（不弹下载栏），否则走浏览器下载（MisskeyGrab/）
 * @param folderName 运行文件夹名（快照=时间戳；增量档案=用户名）
 * @param opts.overwrite 结构文件覆盖写入（增量档案需要，避免产生 (1) 副本）
 * 返回 { mode, base, targetDesc, putFile(name,data), putInRun(path,data,{ow}) }
 */
async function resolveWriter(user, folderName, { overwrite = false } = {}) {
  const base = folderName;
  if ($('saveTarget').value === 'folder' && saveDir && (await hasPermission(saveDir))) {
    return {
      mode: 'fs',
      base,
      targetDesc: saveDir.name,
      async putFile(name, data) {
        await writeFileIn(saveDir, name, toBlob(data, name));
      },
      async putInRun(path, data) {
        await writeFileIn(saveDir, base + '/' + path, toBlob(data, path));
      },
    };
  }
  return {
    mode: 'dl',
    base,
    targetDesc: T('saveRootDl'),
    async putFile(name, data, { ow = overwrite } = {}) {
      await dl(toBlob(data, name), 'MisskeyGrab/' + name, { overwrite: ow });
    },
    async putInRun(path, data, { ow = overwrite } = {}) {
      await dl(toBlob(data, path), 'MisskeyGrab/' + base + '/' + path, { overwrite: ow });
    },
  };
}

async function recordWritten(recItems) {
  try {
    const total = await history.recordFiles(task.user.id, task.user, recItems);
    log(T('logRec', { user: task.user.username, n: recItems.length, total }), 'okk');
  } catch (e) {
    log(T('logRecFail').replace('{msg}', e.message || e), 'err');
  }
}

// ---------------- 导出：五种模式 ----------------

async function doExport(mode) {
  if (exporting) return;
  exporting = true;
  exAbort = false;
  document.querySelectorAll('.exbar button').forEach((b) => (b.disabled = true));
  $('exLog').innerHTML = '';
  $('exProgress').classList.remove('hidden');
  setExProgress(0, 1, T('logPrepare'));

  const selItems = items.filter((i) => selected.has(i.file.id));
  const isUpdate = mode === 'update';
  const ts = tsName();
  let w = null; // finally 的自动备份要用；resolveWriter 失败时为 null 跳过备份
  try {
    // 所有导出统一归入 用户名/ 档案夹：archive.html 入口 + images/ + _data/ + _snapshots/
    w = await resolveWriter(task.user, stableUserFolder(task.user), { overwrite: isUpdate || mode === 'meta' });
    const base = w.base;
    log(isUpdate
      ? T('logSavedFs').replace('{base}', base).replace('{target}', w.targetDesc)
      : T('logSavedDl').replace('{base}', base).replace('{target}', w.targetDesc));
    if (isUpdate) {
      await updateArchive(selItems, w);
      return;
    }

    if (mode === 'meta') {
      const dataJson = buildDataJson({ user: task.user, notes: task.state.notes, meta: { crawlAt: new Date().toLocaleString(uiLang === 'en' ? 'en-US' : uiLang) } });
      const csv = buildCsv(collectFiles(task.state.notes, task.opts), task.user);
      await w.putInRun('_data/data.json', new Blob([dataJson], { type: 'application/json' }));
      await w.putInRun('_data/metadata.csv', new Blob([csv], { type: 'text/csv' }));
      log('✅ ' + T('logMetaSaved').replace('{base}', base), 'okk');
      return;
    }

    if (mode === 'archiveFolder') {
      await exportFolder(selItems, w, '_snapshots/' + ts + '/');
      return;
    }

    // 其余模式都需要图片字节
    setExProgress(0, selItems.length, T('logDlImg').replace('{done}', 0).replace('{total}', selItems.length).replace('{fail}', 0));
    const assets = await buildAssets(selItems, { needHtml: mode !== 'imagesZip' });
    const { map, failed } = await fetchSelectedImages(selItems);
    for (const f of failed) log(T('logFailItem', { name: f.localName, note: f.note.id }), 'err');
    const okItems = selItems.filter((i) => map.has(i.file.id));
    if (!okItems.length) { log(T('logNoImages'), 'err'); return; }

    if (mode === 'imagesZip') {
      const zip = new StoreZip();
      for (const it of okItems) zip.add(it.localName, map.get(it.file.id).bytes);
      zip.add('metadata.csv', enc.encode(buildCsv(okItems, task.user)));
      zip.add('data.json', enc.encode(buildDataJson({ user: task.user, notes: task.state.notes, meta: { crawlAt: new Date().toLocaleString(uiLang === 'en' ? 'en-US' : uiLang) } })));
      await w.putInRun(`_snapshots/${ts}_images.zip`, zip.build());
      log('✅ ' + T('logImagesZip').replace('{base}', base).replace('{ts}', ts).replace('{n}', okItems.length).replace('{fail}', failed.length ? ' +' + failed.length : ''), 'okk');
      await recordWritten(okItems);
      return;
    }

    // ---- HTML 档案（zip / single） ----
    const single = mode === 'single';
    const bytesOf = (fid) => map.get(fid);
    const refFor = single
      ? (note, file) => {
          const r = map.get(file.id);
          return r ? `data:${file.type || 'image/png'};base64,${b64(r.bytes)}` : (file.thumbnailUrl || '');
        }
      : () => null; // folder 模式下面占位，实际用 images/xx
    const refForFolder = (note, file, _idx, it) => 'images/' + (it ? it.localName : imageLocalName(note, file));
    const emojiRef = makeEmojiRef(assets, {
      single,
      bytesOf: (url) => (assets.emojiBytes.has(url) ? { bytes: assets.emojiBytes.get(url) } : null),
    });
    const avatarRef = single
      ? assets.avatar ? `data:image/${assets.avatarExt || 'png'};base64,${b64(assets.avatar)}` : null
      : assets.avatar && avatarLocalName() ? 'images/' + avatarLocalName() + '.' + assets.avatarExt : null;

    const meta = { crawlAt: new Date().toLocaleString(uiLang === 'en' ? 'en-US' : uiLang), note: T(task.opts.mode === 'full' ? 'modeFullTag' : 'modeFilesTag') + ' · ' + T('apiCount').replace('{k}', task.state.requests) };
    // 只保留至少含一张"已成功落地"图片的笔记，且笔记内只保留已落地图——避免档案里出现死链
    const okSet = new Set(okItems.map((it) => it.file.id));
    const notesForHtml = task.state.notes
      .map((n) => ({ ...n, files: noteImages(n, task.opts).filter((f) => okSet.has(f.id)) }))
      .filter((n) => n.files.length > 0);
    const nameMap = new Map(okItems.map((it) => [it.file.id, it]));
    const html = buildArchiveHtml({
      user: task.user,
      notes: notesForHtml,
      meta,
      lang: metaLang(),
      collectOpts: task.opts,
      order: task.opts.archiveOrder,
      revealSens: task.opts.revealSens,
      refFor: single ? refFor : (note, file) => refForFolder(note, file, 0, nameMap.get(file.id)),
      avatarRef,
      emojiRef,
    });

    if (single) {
      await w.putInRun(`_snapshots/${ts}_archive.html`, new Blob([html], { type: 'text/html' }));
      log('✅ ' + T('logSingle').replace('{base}', base).replace('{ts}', ts).replace('{n}', okItems.length).replace('{fail}', failed.length ? ' +' + failed.length : ''), 'okk');
    } else {
      const zip = new StoreZip();
      zip.add('archive.html', enc.encode(html));
      for (const it of okItems) zip.add('images/' + it.localName, map.get(it.file.id).bytes);
      if (assets.avatar && avatarLocalName()) zip.add('images/' + avatarLocalName() + '.' + assets.avatarExt, assets.avatar);
      for (const [url, bytes] of assets.emojiBytes) zip.add('images/' + assets.emojiLocal.get(url), bytes);
      zip.add('data.json', enc.encode(buildDataJson({ user: task.user, notes: task.state.notes, meta, items: okItems })));
      zip.add('metadata.csv', enc.encode(buildCsv(okItems, task.user)));
      zip.add('README.txt', enc.encode(T('zipReadme')));
      await w.putInRun(`_snapshots/${ts}_archive.zip`, zip.build());
      log('✅ ' + T('logSnapZip').replace('{base}', base).replace('{ts}', ts).replace('{n}', okItems.length).replace('{fail}', failed.length ? ' +' + failed.length : ''), 'okk');
      log(T('logSnapHint'), 'okk');
      await recordWritten(okItems);
    }
  } catch (e) {
    if (e.message === 'cancelled' || exAbort) log(T('logCancelled'), 'err');
    else {
      log(T('logExportFailMsg').replace('{msg}', e && e.message ? e.message : e), 'err');
      if (e && e.stack) log(String(e.stack).split('\n').slice(0, 3).join('\n'), 'err');
    }
  } finally {
    exporting = false;
    // 每次导出后自动把下载记录（含增量档案数据）备份到 _data/，可在「过往记录」导入恢复
    if (!exAbort && w) {
      try {
        const json = await history.exportHistoryJson();
        await w.putFile('_data/misskey_history.json', new Blob([json], { type: 'application/json' }), { ow: true });
        log('🗂 下载记录已自动备份到 _data/misskey_history.json', 'okk');
      } catch (e) { /* 备份失败不影响导出结果 */ }
    }
    exAbort = false;
    document.querySelectorAll('.exbar button').forEach((b) => (b.disabled = false));
    setExProgress(0, 1, T('logExportEnd'));
  }
}

function metaLang(archiveLang) {
  // archiveLang 可由调用方传入（如 rebuild 场景的 settings.archiveLang）；缺省回退内存任务
  const al = archiveLang !== undefined ? archiveLang : (task && task.opts && task.opts.archiveLang);
  return al && al !== 'auto' ? al : uiLang;
}

function imageLocalName(note, file, opts) {
  // 与 collectFiles 相同规则；items 里可能没有对应项（未选中文件也被 html 引用时兜底）
  return items.find((it) => it.file.id === file.id)?.localName || imageFileName(note, file, 0, opts || (task && task.opts) || {});
}

/** 快照文件夹档案：写入 用户名/_snapshots/<时间戳>/（sub 为该子目录前缀，以 / 结尾） */
async function exportFolder(selItems, w, sub) {
  // 1) 小资源先走字节抓取（头像/表情）
  const assets = await buildAssets(selItems, { needHtml: true });
  // 2) 生成 HTML（图片用相对路径 images/xx）；只保留含已选图片的笔记
  const nameMap = new Map(selItems.map((it) => [it.file.id, it]));
  const meta = { crawlAt: new Date().toLocaleString(uiLang === 'en' ? 'en-US' : uiLang), note: T('aMetaSnap') };
  const selSet = new Set(selItems.map((it) => it.file.id));
  const notesForHtml = task.state.notes
    .map((n) => ({ ...n, files: noteImages(n, task.opts).filter((f) => selSet.has(f.id)) }))
    .filter((n) => n.files.length > 0);
  const html = buildArchiveHtml({
    user: task.user,
    notes: notesForHtml,
    meta,
    collectOpts: task.opts,
    order: task.opts.archiveOrder,
    revealSens: task.opts.revealSens,
    refFor: (note, file) => {
      const it = nameMap.get(file.id);
      return 'images/' + (it ? it.localName : imageLocalName(note, file));
    },
    avatarRef: assets.avatar && avatarLocalName() ? 'images/' + avatarLocalName() + '.' + assets.avatarExt : null,
    emojiRef: makeEmojiRef(assets, {}),
  });

  if (w.mode === 'fs') {
    // ---- 自选文件夹：全部字节直写，成功即精确记录 ----
    setExProgress(0, selItems.length, '下载图片 0/' + selItems.length);
    const { map, failed } = await fetchSelectedImages(selItems);
    for (const f of failed) log(T('logFailItem', { name: f.localName, note: f.note.id }), 'err');
    const written = selItems.filter((i) => map.has(i.file.id));
    await w.putInRun(sub + 'archive.html', new Blob([html], { type: 'text/html' }));
    await w.putInRun(sub + '_data/data.json', new Blob([buildDataJson({ user: task.user, notes: task.state.notes, meta, items: written })], { type: 'application/json' }));
    await w.putInRun(sub + '_data/metadata.csv', new Blob([buildCsv(written, task.user)], { type: 'text/csv' }));
    if (assets.avatar && avatarLocalName()) await w.putInRun(sub + 'images/' + avatarLocalName() + '.' + assets.avatarExt, new Blob([assets.avatar]));
    for (const [url, bytes] of assets.emojiBytes) {
      await w.putInRun(sub + 'images/' + assets.emojiLocal.get(url), new Blob([bytes]));
    }
    for (const it of written) {
      await w.putInRun(sub + 'images/' + it.localName, new Blob([map.get(it.file.id).bytes], { type: it.file.type || 'application/octet-stream' }));
    }
    log(T('logFolderFsDone', { target: w.targetDesc, base: w.base, sub, n: written.length, fail: failed.length ? ' +' + failed.length : '' }), 'okk');
    log(T('logFolderHint'), 'okk');
    await recordWritten(written);
    return;
  }

  // ---- 浏览器下载模式：结构文件走 blob，图片由浏览器直连下载（兼容性最好） ----
  const dlPath = (p) => 'MisskeyGrab/' + w.base + '/' + sub + p;
  await w.putInRun(sub + 'archive.html', new Blob([html], { type: 'text/html' }));
  await w.putInRun(sub + '_data/data.json', new Blob([buildDataJson({ user: task.user, notes: task.state.notes, meta, items: selItems })], { type: 'application/json' }));
  await w.putInRun(sub + '_data/metadata.csv', new Blob([buildCsv(selItems, task.user)], { type: 'text/csv' }));
  if (assets.avatar && avatarLocalName()) {
    await dl(new Blob([assets.avatar]), dlPath('images/' + avatarLocalName() + '.' + assets.avatarExt));
  }
  log(T('logStructDl2'));

  let done = 0, failIds = new Set();
  for (const it of selItems) {
    if (exAbort) break;
    try {
      const okDl = await dlWait(await dl(it.file.url, dlPath('images/' + it.localName)));
      if (!okDl) throw new Error('download interrupted');
    } catch (e) {
      // URL 过期 → 刷新重试一次
      const ok = await refreshFileUrl(it);
      try {
        if (ok) await dl(it.file.url, dlPath('images/' + it.localName));
        else { failIds.add(it.file.id); log(T('logFailItem', { name: it.localName, note: it.note.id }), 'err'); }
      } catch (e2) { failIds.add(it.file.id); log(T('logFailItem', { name: it.localName, note: it.note.id }), 'err'); }
    }
    done++;
    setExProgress(done, selItems.length, `图片下载任务 ${done}/${selItems.length}`);
    await sleep(rand(120, 380));
  }
  // 表情符号落地
  for (const [url, bytes] of assets.emojiBytes) {
    try { await dl(new Blob([bytes]), dlPath('images/' + assets.emojiLocal.get(url))); } catch (e) { /* 忽略 */ }
  }
  log(T('logFolderDlDone', { base: w.base, sub, n: failIds.size }), 'okk');
  log(T('logFolderHint'), 'okk');
  await recordWritten(selItems.filter((i) => !failIds.has(i.file.id)));
}

// ---------------- 导出：增量更新本地档案 ----------------

/** 把本次抓取合并进固定档案文件夹（{用户名}/archive.html + images/），像本地镜像一样持续累积 */
async function updateArchive(selItems, w) {
  // 1) 合并笔记数据（持久化，供下次合并）
  setExProgress(0, 1, T('logPrepare'));
  const folder = w.base;
  const prevMeta = await archstore.archMeta(task.user.id);
  const naming = { template: task.opts.nameTemplate, groupBy: task.opts.groupBy };
  if (prevMeta && prevMeta.naming && (prevMeta.naming.template !== naming.template || prevMeta.naming.groupBy !== naming.groupBy)) {
    log(T('logNamingChanged'), 'err');
  }
  const { notes: merged, added } = await archstore.mergeNotes(task.user.id, task.user, task.state.notes, folder, naming);
  log(T('logMerge', { a: task.state.notes.length, b: added, c: merged.length }));

  // 2) 资源：已落地的表情不重复下载；头像始终取最新
  const knownEmoji = await archstore.emojiMap(task.user.id);
  const assets = await buildAssets(selItems, { needHtml: true, skipEmojiUrls: new Set(knownEmoji.keys()) });

  // 3) 新图片字节（选区默认 = 未拥有）
  if (selItems.length) setExProgress(0, selItems.length, T('dlNewImgs').replace('{done}', 0).replace('{total}', selItems.length));
  const { map, failed } = await fetchSelectedImages(selItems);
  for (const f of failed) log(T('logFailItem', { name: f.localName, note: f.note.id }), 'err');
  const okItems = selItems.filter((i) => map.has(i.file.id));

  // 4) 重建档案视图：已在磁盘上的（过往已拥有）∪ 本次下载成功的
  const owned = await history.ownedSet(task.user.id);
  const have = new Set([...owned, ...map.keys()]);
  const notesForHtml = merged
    .map((n) => ({ ...n, files: noteImages(n, task.opts).filter((f) => have.has(f.id)) }))
    .filter((n) => n.files.length > 0);
  // 全量路径映射（含旧笔记文件），保证引用名与磁盘一致
  const allItems = collectFiles(merged, task.opts);
  const allPaths = new Map(allItems.map((it) => [it.file.id, it.localName]));
  const meta = { crawlAt: new Date().toLocaleString(uiLang === 'en' ? 'en-US' : uiLang), note: tt(metaLang(), 'aMetaNote', { n: merged.length, a: added }) };
  const avName = avatarLocalName();
  const html = buildArchiveHtml({
    user: task.user,
    notes: notesForHtml,
    meta,
    collectOpts: task.opts,
    order: task.opts.archiveOrder,
    revealSens: task.opts.revealSens,
    refFor: (note, file) => 'images/' + (allPaths.get(file.id) || imageLocalName(note, file)),
    avatarRef: assets.avatar && avName ? 'images/' + avName + '.' + assets.avatarExt : null,
    emojiRef: makeEmojiRef(assets, {}),
  });

  // 5) 写入：结构文件覆盖写；图片只写新增（fs 模式先查存在，双保险不产生重复）
  await w.putInRun('archive.html', new Blob([html], { type: 'text/html' }));
  await w.putInRun('_data/data.json', new Blob([buildDataJson({ user: task.user, notes: merged, meta, items: allItems })], { type: 'application/json' }));
  await w.putInRun('_data/metadata.csv', new Blob([buildCsv(allItems, task.user)], { type: 'text/csv' }));
  if (assets.avatar && avName) await w.putInRun('images/' + avName + '.' + assets.avatarExt, new Blob([assets.avatar], { type: 'image/' + assets.avatarExt }));
  const emojiWritten = [];
  for (const [url, bytes] of assets.emojiBytes) {
    const fn = assets.emojiLocal.get(url);
    if (knownEmoji.get(url) === fn) continue;
    await w.putInRun('images/' + fn, new Blob([bytes], { type: 'application/octet-stream' }));
    emojiWritten.push([url, fn]);
  }
  let writeCount = 0;
  const written = [];
  for (const it of okItems) {
    if (w.mode === 'fs' && (await fileExists(saveDir, w.base + '/images/' + it.localName))) {
      written.push(it); // 磁盘上已有（勾选了重下也无需重复写）
      continue;
    }
    await w.putInRun('images/' + it.localName, new Blob([map.get(it.file.id).bytes], { type: it.file.type || 'application/octet-stream' }));
    written.push(it);
    writeCount++;
  }
  await archstore.rememberEmojis(task.user.id, emojiWritten);
  // 记录表情名称键（name/name@host）→ URL、头像本地名，供「重新生成 HTML」免网络重建
  await archstore.rememberEmojiNames(task.user.id, [...assets.emojiUrls.entries()]);
  if (avName && assets.avatar) await archstore.rememberAvatar(task.user.id, avName + '.' + assets.avatarExt);
  if (written.length) await recordWritten(written);
  log(T('logUpdDone', { target: w.targetDesc, folder, n: writeCount, fail: failed.length ? ' +' + failed.length : '' }), 'okk');
  log(T('logUpdOpen', { folder, n: merged.length }), 'okk');
}

$('selNew').addEventListener('click', () => {
  selected.clear();
  items.forEach((i) => { if (!i._owned) selected.add(i.file.id); });
  renderGrid();
});

// ---------------- 保存位置 / 导航 / 过往记录 ----------------

function updateDirLabel() {
  const el = $('dirName');
  if (!saveDir) {
    el.textContent = supportsDirPicker() ? T('dirNone') : T('dirNoSupport');
    return;
  }
  hasPermission(saveDir).then((ok) => {
    el.textContent = T(ok ? 'dirPicked' : 'dirNeedAuth').replace('{name}', saveDir.name);
  });
}

$('pickDir').addEventListener('click', async () => {
  if (!supportsDirPicker()) {
    alert(T('dirNoSupport'));
    return;
  }
  try {
    // 已有句柄但掉权限 → 先尝试重新授权
    if (saveDir && !(await hasPermission(saveDir))) {
      if (await requestPermission(saveDir)) {
        $('saveTarget').value = 'folder';
        updateDirLabel();
        return;
      }
    }
    saveDir = await pickDirectory();
    // 写一个临时文件验证可写后删除
    try {
      await writeFileIn(saveDir, '_mg_test.tmp', 'ok');
      await saveDir.removeEntry('_mg_test.tmp');
    } catch (e) {
      alert(T('alertDirNotWritable').replace('{msg}', e.message || e));
      return;
    }
    $('saveTarget').value = 'folder';
    updateDirLabel();
  } catch (e) {
    /* 用户取消目录选择 */
  }
});

$('saveTarget').addEventListener('change', () => {
  store.saveSettings({ saveTarget: $('saveTarget').value });
  if ($('saveTarget').value === 'folder' && !saveDir) {
    $('dirName').textContent = T('dirNotPicked');
  }
});
$('skipOwned').addEventListener('change', () => store.saveSettings({ skipOwned: $('skipOwned').checked }));

function markNav(id) {
  $('navNew').classList.toggle('on', id === 'navNew');
  $('navHist').classList.toggle('on', id === 'navHist');
}

$('navNew').addEventListener('click', () => {
  show('secSetup');
  markNav('navNew');
  refreshResumeBanner();
});

$('navHist').addEventListener('click', async () => {
  try {
    await renderHistory();
    show('secHistory');
    markNav('navHist');
  } catch (e) { console.error('renderHistory failed:', e); }
});

async function renderHistory() {
  const list = await history.listHistory();
  const tbody = $('histTable').querySelector('tbody');
  tbody.innerHTML = '';
  $('histEmpty').classList.toggle('hidden', list.length > 0);
  $('histTable').classList.toggle('hidden', list.length === 0);
  const total = list.reduce((s, u) => s + (u.count || 0), 0);
  $('histSummary').textContent = list.length ? T('histSummary', { u: list.length, f: total }) : '';
  for (const u of list) {
    const tr = document.createElement('tr');
    const tdUser = document.createElement('td');
    const hu = document.createElement('div');
    hu.className = 'hu';
    hu.textContent = u.name || u.username;
    const hn = document.createElement('div');
    hn.className = 'hn';
    hn.textContent = '@' + u.username + (u.host ? '@' + u.host : '');
    tdUser.append(hu, hn);
    const tdCount = document.createElement('td');
    tdCount.textContent = u.count ?? 0;
    const tdTime = document.createElement('td');
    tdTime.textContent = u.lastAt ? new Date(u.lastAt).toLocaleString(uiLang === 'en' ? 'en-US' : uiLang) : '';
    const tdAct = document.createElement('td');
    const bGo = document.createElement('button');
    bGo.className = 'mini';
    bGo.textContent = T('rowGrab');
    bGo.addEventListener('click', () => {
      $('userInput').value = '@' + u.username + (u.host ? '@' + u.host : '');
      $('navNew').click();
    });
    const bRb = document.createElement('button');
    bRb.className = 'mini';
    bRb.textContent = T('rowRegen');
    bRb.title = T('rowRegenTitle');
    bRb.addEventListener('click', () => rebuildArchiveFor({ userId: u.userId, username: u.username, host: u.host, name: u.name, avatarUrl: u.avatarUrl, naming: u.naming }, bRb));
    const bOpen = document.createElement('button');
    bOpen.className = 'mini';
    bOpen.textContent = T('rowOpenHtml');
    bOpen.addEventListener('click', async () => {
      const ok = await openUserArchive(u.username);
      if (!ok) alert(T('alertHtmlNotFound'));
    });
    const bDel = document.createElement('button');
    bDel.className = 'mini';
    bDel.textContent = T('rowClear');
    bDel.style.color = 'var(--warn)';
    bDel.addEventListener('click', async () => {
      await history.clearUser(u.userId);
      renderHistory();
    });
    tdAct.append(bGo, bOpen, bRb, bDel);
    tr.append(tdUser, tdCount, tdTime, tdAct);
    tbody.appendChild(tr);
  }
}

$('histExport').addEventListener('click', async () => {
  const json = await history.exportHistoryJson();
  await dl(new Blob([json], { type: 'application/json' }), 'MisskeyGrab/_data/misskey_history.json', { overwrite: true });
});

$('histImport').addEventListener('click', () => $('histFile').click());
$('histFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const text = await f.text();
    const r = await history.importHistoryData(text, uiLang);
    alert(T('alertImportOk', { users: r.users, files: r.files, notes: r.notes }));
    renderHistory();
  } catch (err) {
    alert(T('alertImportFail').replace('{msg}', err.message || err));
  }
  e.target.value = '';
});

// 扫描档案库：从磁盘档案（_data/data.json + images/）重建下载记录索引（Plex「扫描资料库」式设计）
$('histRecover').addEventListener('click', async () => {
  try {
    let dir = saveDir && (await hasPermission(saveDir)) ? saveDir : await pickDirectory();
    if (!dir) return;
    saveDir = dir;
    updateDirLabel();

    // 判定所选目录：用户档案夹本身（含 _data）或包含多个档案夹的根目录
    const entries = await listEntries(dir);
    let roots = [];
    if (entries.some((e2) => e2.name === '_data')) {
      roots = [dir];
    } else {
      for (const e2 of entries) {
        if (e2.kind !== 'directory' || e2.name.startsWith('_')) continue;
        const h = await dir.getDirectoryHandle(e2.name);
        if ((await listEntries(h)).some((s) => s.name === '_data')) roots.push(h);
      }
    }
    if (!roots.length) {
      alert(T('alertNoScanFolder'));
      return;
    }

    const users = [];
    let skipped = 0;
    let imgCount = 0;
    for (const root of roots) {
      try {
        const payload = JSON.parse(await readFileText(root, '_data/data.json'));
        const rec = recoverUserFromPayload(payload, (localName) => fileExists(root, 'images/' + localName));
        if (rec) {
          users.push(rec);
          imgCount += rec.stat.present;
        } else skipped++;
      } catch (e2) {
        skipped++;
      }
    }
    if (!users.length) {
      alert(T('alertScanNoFiles'));
      return;
    }

    const r = await history.importHistoryData({ users }, uiLang);
    // 顺手把重建后的完整记录刷新到磁盘备份
    try {
      const json = await history.exportHistoryJson();
      const blob = new Blob([json], { type: 'application/json' });
      if (saveDir && (await hasPermission(saveDir))) await writeFileIn(saveDir, '_data/misskey_history.json', blob);
      else await dl(blob, 'MisskeyGrab/_data/misskey_history.json', { overwrite: true });
    } catch (e2) { /* 备份失败不影响恢复结果 */ }

    alert(T('alertScanDone', { users: r.users, files: r.files, notes: r.notes, imgs: imgCount, skip: skipped ? T('alertScanSkipped').replace('{n}', skipped) : '' }));
    renderHistory();
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 用户取消选择文件夹
    alert(T('alertScanFail').replace('{msg}', e.message || e));
  }
});

// 重新生成 HTML（Regenerate）：用已存储的记录+磁盘图片重建 archive.html，无需重新抓取
let rebuilding = new Set(); // 防并发
async function rebuildArchiveFor(meta, btn) {
  if (rebuilding.has(meta.userId)) { alert(T('alertRegenBusy')); return; }
  rebuilding.add(meta.userId);
  const oldText = btn ? btn.textContent : '';
  if (btn) { btn.textContent = T('regenBusy'); btn.disabled = true; }
  try {
    const o = await chrome.storage.local.get('arch:notes:' + meta.userId);
    const notes = o['arch:notes:' + meta.userId] || [];
    if (!notes.length) throw new Error(T('alertRegenNoData'));
    const user = { id: meta.userId, username: meta.username, host: meta.host, name: meta.name, avatarUrl: meta.avatarUrl };
    // 命名规则以档案元信息为准（与当初写盘时一致，路径才能对得上）
    const am = await archstore.archMeta(meta.userId);
    const collectOpts = {
      template: (am && am.naming && am.naming.template) || 'datetime',
      groupBy: (am && am.naming && am.naming.groupBy) || 'none',
    };
    // 已拥有文件 → 只保留含已落地图片的笔记，引用路径与磁盘一致
    const owned = await history.ownedSet(meta.userId);
    const allItems = collectFiles(notes, collectOpts);
    const have = new Set(allItems.filter((it) => owned.has(it.file.id)).map((it) => it.file.id));
    const notesForHtml = notes.filter((n) => noteImages(n, collectOpts).some((f) => have.has(f.id)));
    const allPaths = new Map(allItems.map((it) => [it.file.id, it.localName]));

    // 表情：存储的 名称键→URL + URL→本地文件
    const urlByLocal = await archstore.emojiMap(meta.userId);
    const urlByName = await archstore.emojiNameMap(meta.userId);
    const emojiRef = (name, host) => {
      const key = host && host !== '.' ? name + '@' + host : name;
      const url = urlByName.get(key) || urlByName.get(name);
      if (!url) return null;
      const local = urlByLocal.get(url);
      return local ? { ref: 'images/' + local, remote: url } : { ref: null, remote: url };
    };
    const avLocal = await archstore.avatarLocal(meta.userId);

    const folder = stableUserFolder(user);
    const w = await resolveWriter(user, folder, { overwrite: true });
    const settings = await store.loadSettings();
    const html = buildArchiveHtml({
      user,
      notes: notesForHtml,
      meta: { crawlAt: new Date().toLocaleString(uiLang === 'en' ? 'en-US' : uiLang), note: tt(metaLang(settings.archiveLang), 'aMetaRegen', { t: new Date().toLocaleString(uiLang === 'en' ? 'en-US' : uiLang), n: notesForHtml.length }) },
      collectOpts,
      order: settings.archiveOrder,
      revealSens: settings.revealSens,
      refFor: (note, file) => 'images/' + (allPaths.get(file.id) || imageFileName(note, file, 0, collectOpts)),
      avatarRef: avLocal ? 'images/' + avLocal : user.avatarUrl,
      emojiRef,
    });
    await w.putInRun('archive.html', new Blob([html], { type: 'text/html' }));
    alert(T('alertRegenDone', { target: w.targetDesc, folder, n: notesForHtml.length }));
  } catch (e) {
    alert(T('alertRegenFail').replace('{msg}', e.message || e));
  } finally {
    rebuilding.delete(meta.userId);
    if (btn) { btn.textContent = oldText; btn.disabled = false; }
  }
}

// P2: 按文件夹重建——纯磁盘数据驱动（_data/data.json + images/），不依赖扩展记录，清空记录后仍可用
async function rebuildArchiveFromDisk() {
  try {
    let dir = saveDir && (await hasPermission(saveDir)) ? saveDir : await pickDirectory();
    if (!dir) return;
    saveDir = dir;
    updateDirLabel();
    const entries = await listEntries(dir);
    let roots = [];
    if (entries.some((e) => e.name === '_data')) {
      roots = [dir];
    } else {
      for (const e of entries) {
        if (e.kind !== 'directory' || e.name.startsWith('_')) continue;
        const h = await dir.getDirectoryHandle(e.name);
        if ((await listEntries(h)).some((s) => s.name === '_data')) roots.push(h);
      }
    }
    if (!roots.length) { alert(T('alertNoScanFolder')); return; }

    const settings = await store.loadSettings();
    const lang = metaLang(settings.archiveLang);
    let done = 0;
    const fails = [];
    for (const root of roots) {
      try {
        const payload = JSON.parse(await readFileText(root, '_data/data.json'));
        let diskNames = new Set();
        try {
          const imgs = await root.getDirectoryHandle('images');
          diskNames = new Set((await listEntries(imgs)).map((e) => e.name));
        } catch (e) { /* images/ 缺失按空处理 */ }
        // 表情：旧 archive.html 的 名称→本地文件 映射（与 regen.mjs 同思路）
        const emojiNameMap = new Map();
        let oldHtml = '';
        try { oldHtml = await readFileText(root, 'archive.html'); } catch (e) { /* 首次生成 */ }
        if (oldHtml) {
          let m;
          const re = /<img class="emoji" src="(?:images\/(_emoji_[^"]+))?"[^>]*alt=":([A-Za-z0-9_+\-.@]+):"/g;
          while ((m = re.exec(oldHtml))) if (m[1]) emojiNameMap.set(m[2], m[1]);
          const re2 = /alt=":([A-Za-z0-9_+\-.@]+):"[^>]*?src="images\/(_emoji_[^"]+)"/g;
          while ((m = re2.exec(oldHtml))) emojiNameMap.set(m[1], m[2]);
        }
        const emojiRef = (name, host) => {
          const key = host && host !== '.' ? name + '@' + host : name;
          const local = emojiNameMap.get(key) || emojiNameMap.get(name);
          if (local && diskNames.has(local)) return { ref: 'images/' + local, remote: null };
          return null;
        };
        const pathById = new Map((payload.files || []).map((f) => [f.fileId, f.localName]));
        const notes = payload.notes || [];
        const refFor = (note, file) => {
          const ln = pathById.get(file.id);
          return 'images/' + (ln && diskNames.has(ln) ? ln : imageFileName(note, file, 0, {}));
        };
        const avatarFile = [...diskNames].find((f) => f.startsWith('_avatar_'));
        const html = buildArchiveHtml({
          user: payload.user || {},
          notes,
          meta: {
            crawlAt: new Date().toLocaleString(uiLang === 'en' ? 'en-US' : uiLang),
            note: tt(lang, 'aMetaRegen', { t: new Date().toLocaleString(uiLang === 'en' ? 'en-US' : uiLang), n: notes.length }),
          },
          lang,
          collectOpts: {},
          order: settings.archiveOrder,
          revealSens: settings.revealSens,
          refFor,
          avatarRef: avatarFile ? 'images/' + avatarFile : (payload.user && payload.user.avatarUrl) || null,
          emojiRef,
        });
        await writeFileIn(root, 'archive.html', new Blob([html], { type: 'text/html' }));
        done++;
      } catch (e2) { fails.push(e2.message || e2); }
    }
    alert(T('alertDiskRebuildDone', { n: done, fail: fails.length ? '\n⚠ ' + fails.slice(0, 3).join(' / ') : '' }));
  } catch (e) {
    if (e && e.name === 'AbortError') return; // 用户取消选择
    alert(T('alertDiskRebuildFail').replace('{msg}', e.message || e));
  }
}
$('histRegenDisk').addEventListener('click', rebuildArchiveFromDisk);

$('histClear').addEventListener('click', async () => {
  if (confirm(T('confirmClearAll'))) {
    await history.clearAll();
    renderHistory();
  }
});

// ---- 打开下载文件夹 / 打开某用户的 archive.html ----
// 原理：archive.html 每次导出都会写入浏览器下载记录，用 filenameRegex 搜出绝对路径后
// tabs.create file:// 新标签打开（扩展页直接放 file:// 链接会被拦截，tabs.create 不会）
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '$&');
}

async function openUserArchive(username) {
  if (!chrome.downloads || !chrome.downloads.search) return false;
  // 兼容 Windows(\) 与 mac/linux(/) 的路径分隔符；锁定 MisskeyGrab/<用户名>/archive.html
  const rx = 'MisskeyGrab[\\\\/]' + escapeRegExp(username) + '[\\\\/]archive\\.html$';
  const items = await chrome.downloads.search({ filenameRegex: rx });
  if (!items.length) return false;
  items.sort((a, b) => (b.endTime || '').localeCompare(a.endTime || ''));
  const file = items[0].filename.replace(/\\/g, '/');
  chrome.tabs.create({ url: 'file:///' + file.replace(/^\/+/, '') });
  return true;
}
$('btnOpenDl').addEventListener('click', () => {
  try {
    if (!chrome.downloads || !chrome.downloads.showDefaultFolder) { alert(T('alertHtmlNotFound')); return; }
    chrome.downloads.showDefaultFolder();
  } catch (e) { alert(T('alertHtmlNotFound')); }
});

$('preset').addEventListener('change', () => applyPreset($('preset').value));

$('btnStart').addEventListener('click', () => {
  if (crawlStarting || exporting) return; // 重入保护：双击不会并发两个 Crawler
  const v = $('userInput').value.trim();
  if (!v) { $('setupMsg').textContent = T('errNoUserShort'); return; }
  crawlStarting = true;
  store.saveSettings(readForm()).then(() => store.saveSettings({ user: v }));
  startCrawl(v)
    .catch((e) => { $('setupMsg').textContent = T('logExportFailMsg').replace('{msg}', e && e.message ? e.message : e); })
    .finally(() => { crawlStarting = false; });
});

$('btnPause').addEventListener('click', () => {
  paused = !paused;
  $('btnPause').textContent = paused ? T('resume') : T('pause');
  setStatus(paused ? T('paused') : T('resuming'));
  if (task) store.saveTask(task); // 查询用户阶段 task 尚未赋值，跳过保存
});

$('btnStop').addEventListener('click', () => {
  if (crawler) { aborted = true; if (paused) { paused = false; } setStatus(T('stopping')); }
});

$('selAll').addEventListener('click', () => {
  items.forEach((i) => selected.add(i.file.id));
  renderGrid();
});
$('selNone').addEventListener('click', () => { selected.clear(); renderGrid(); });
$('selSafe').addEventListener('click', () => {
  selected.clear();
  items.forEach((i) => { if (!i.file.isSensitive) selected.add(i.file.id); });
  renderGrid();
});

document.querySelectorAll('.exbar button').forEach((b) => {
  b.addEventListener('click', () => doExport(b.dataset.ex));
});

$('btnBack').addEventListener('click', () => {
  if (exporting) { exAbort = true; log(T('cancelling'), 'err'); return; }
  show('secSetup');
  refreshResumeBanner();
});

// ---------------- 初始化 ----------------

async function refreshResumeBanner() {
  const t = await store.loadTask();
  const banner = $('resumeBanner');
  if (!t || !t.state || !t.state.notes) { banner.classList.add('hidden'); return; }
  const unfinished = t.status === 'running';
  banner.classList.remove('hidden');
  banner.innerHTML = '';
  const txt = document.createElement('span');
  txt.textContent = unfinished
    ? T('bannerUnfinished', { user: t.user.username, n: t.state.notes.length, k: t.state.requests })
    : T('bannerLast', { user: t.user.username, n: t.state.notes.length });
  const btnGo = document.createElement('button');
  btnGo.textContent = unfinished ? T('bannerContinue') : T('bannerGo');
  btnGo.className = 'primary';
  btnGo.addEventListener('click', async () => {
    task = t;
    banner.classList.add('hidden');
    if (unfinished) await resumeCrawl();
    else { $('crawlSummary').textContent = T('summaryShort', { user: t.user.username, n: t.state.notes.length, m: collectFiles(t.state.notes, t.opts).length }); await enterExport(); show('secExport'); }
  });
  const btnDrop = document.createElement('button');
  btnDrop.textContent = T('bannerDrop');
  btnDrop.addEventListener('click', async () => {
    await store.clearTask();
    banner.classList.add('hidden');
  });
  banner.append(txt, btnGo, btnDrop);
}

async function init() {
  const settings = await store.loadSettings();
  fillForm(settings);
  uiLang = normalizeLang((await chrome.storage.local.get('mg:lang'))['mg:lang'] || detectUiLang()); // 未设置时跟随浏览器语言
  $('uiLang').value = uiLang;
  applyI18n();
  $('uiLang').addEventListener('change', async () => {
    uiLang = normalizeLang($('uiLang').value);
    await chrome.storage.local.set({ 'mg:lang': uiLang });
    applyI18n();
    applyPreset($('preset').value);
    updateTokenPill();
    updateDirLabel();
    updateSelInfo();
    refreshResumeBanner();
  });
  refreshTokenCache();
  // 恢复自选保存文件夹（权限若失效，界面会提示重新授权）
  saveDir = await loadHandle();
  updateDirLabel();
  const m = /^#u=(.+)$/.exec(location.hash);
  if (m) $('userInput').value = decodeURIComponent(m[1]).trim();
  else if (settings.user) $('userInput').value = settings.user;
  await refreshResumeBanner();
  show('secSetup');
  markNav('navNew');
}
// 调试/自动化接口（控制台可调用）
window.__mg = {
  importHistory: (t) => history.importHistoryData(t, uiLang),
  exportHistory: () => history.exportHistoryJson(),
  recoverOne: (payload, exists) => recoverUserFromPayload(payload, exists),
  rebuildArchiveFromDisk, // E2E：P2 磁盘重建
  __setSaveDir: (h) => { saveDir = h; }, // E2E：注入目录句柄（OPFS）绕过系统选择框
  history,
  archstore,
};
init().catch((e) => {
  try { setStatus('Init error: ' + (e && e.message ? e.message : e), true); } catch (_) { /* ignore */ }
});

// 管理页已打开时，从 misskey.io 点「抓取此用户」是同文档 hash 导航——监听以预填用户
window.addEventListener('hashchange', () => {
  const m = /^#u=(.+)$/.exec(location.hash);
  if (!m) return;
  $('userInput').value = decodeURIComponent(m[1]).trim();
  show('secSetup');
  markNav('navNew');
  refreshResumeBanner();
});
