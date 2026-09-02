// misskey.io 页面注入：抓取按钮 + 登录 token 采集 + API 同源中继
// API 通过页面上下文发出（与用户正常浏览完全一致的 Origin/Cookie/指纹）

(() => {
  const ORIGIN = 'https://misskey.io';
  const BTN_ID = 'mg-grab-btn';

  // ---------- 扩展上下文失效保护 ----------
  // 扩展被刷新/更新后，已打开页面里的旧注入脚本会成为“孤儿”：所有 chrome.* 调用都会抛
  // “Extension context invalidated”。检测到失效即清理按钮/定时器/监听器，并提示刷新页面。
  let ctxDead = false;
  const tokenTimer = { id: null };
  function enterZombie() {
    if (ctxDead) return;
    ctxDead = true;
    if (tokenTimer.id) clearInterval(tokenTimer.id);
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (e) {}
    const btn = document.getElementById(BTN_ID);
    if (btn) {
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M20 11.2a8 8 0 1 0-2.1 6.5"/><path d="M20 21.2v-4.4h-4.4"/></svg>扩展已更新，请刷新页面';
      btn.style.background = '#3a3a44';
      btn.style.pointerEvents = 'none';
      btn.title = '扩展已更新或重载，刷新当前页面后可继续使用';
    }
    console.info('[Misskey Image Grabber] 扩展已更新/重载，刷新页面后可继续使用。');
  }
  function safe(fn) {
    try { fn(); } catch (e) {
      if (String((e && e.message) || e).includes('Extension context invalidated')) enterZombie();
    }
  }

  // ---------- 登录 token 采集 ----------
  // Misskey access token 是 base36 随机串；账号以带 token 字段的结构化对象存储。
  // 只认"对象内 token 字段"或 i/token 两个历史键名，避免把 base36 的会话 id 之类误判为 token。
  const TOKEN_RE = /^[0-9a-zA-Z]{16,64}$/; // misskey rndstr 生成的 token 含大写字母，不能只认小写

  function scanToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const tok = extractToken(raw);
        if (tok) return tok;
      }
      // 历史版本用过的裸值键名
      for (const k of ['i', 'token']) {
        const v = (localStorage.getItem(k) || '').trim();
        if (TOKEN_RE.test(v)) return v;
      }
    } catch (e) { /* 隐私模式等情况下忽略 */ }
    return null;
  }

  // misskey.io 新版客户端把登录 token 迁到了 IndexedDB（idb-keyval：库 keyval-store / store keyval，
  // 键 account/i），localStorage 扫不到——这里异步兜底扫描该库的所有键值
  function idbReadAll(dbName, storeName) {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          const db = req.result;
          let tx;
          try { tx = db.transaction(storeName, 'readonly'); } catch (e) { try { db.close(); } catch (e2) {} return resolve([]); }
          const out = [];
          const cur = tx.objectStore(storeName).openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) { try { db.close(); } catch (e2) {} return resolve(out); }
            out.push({ key: c.key, val: c.value });
            c.continue();
          };
          cur.onerror = () => { try { db.close(); } catch (e2) {} resolve(out); };
        };
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  }

  async function scanIdbToken() {
    try {
      if (!indexedDB || !indexedDB.databases) return null;
      const dbs = await indexedDB.databases();
      const names = (dbs || []).map((d) => d && d.name).filter((n) => n && /keyval/i.test(n));
      for (const name of names) {
        const items = await idbReadAll(name, 'keyval');
        for (const { key, val } of items) {
          if (typeof val === 'string' && TOKEN_RE.test(val.trim()) && /token|account|^i$/i.test(key)) return val.trim();
          let tok = extractToken(typeof val === 'string' ? val : JSON.stringify(val));
          if (tok) return tok;
          if (val && typeof val === 'object') {
            const cand = val.token || (val.value && val.value.token);
            if (typeof cand === 'string' && TOKEN_RE.test(cand)) return cand;
          }
        }
      }
    } catch (e) { /* IDB 不可用等情况忽略 */ }
    return null;
  }

  async function scanTokenAsync() {
    return scanToken() || (await scanIdbToken()) || null;
  }

  function extractToken(raw) {
    const s = raw.trim();
    if (s[0] !== '{' && s[0] !== '[') return null;
    let obj;
    try { obj = JSON.parse(s); } catch (e) { return null; }
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 2) return null;
      if (
        typeof o.token === 'string' &&
        TOKEN_RE.test(o.token) &&
        Object.keys(o).length >= 2 // 账号对象不会只有 token 一个字段
      ) {
        return o.token;
      }
      for (const v of Object.values(o)) {
        const t = walk(v, depth + 1);
        if (t) return t;
      }
      return null;
    };
    return walk(obj, 0);
  }

  async function pushToken() {
    // 整段自包裹：safe() 只能捕获同步段，await 之后的 chrome.* 调用在扩展重载后
    // 仍会抛 "Extension context invalidated"——必须自己接住并转入僵尸清理，否则每 15 秒刷一次未捕获错误
    try {
      const tok = await scanTokenAsync();
      const val = tok || null;
      // 扫不到就清空存储（避免旧值残留成无效 token）；值未变不写，省掉每 15 秒的存储写放大
      chrome.storage.local.get(['mk:token'], function (o) {
        try {
          if (o && o['mk:token'] !== val) chrome.storage.local.set({ 'mk:token': val, 'mk:token-at': Date.now() });
        } catch (e) { if (String((e && e.message) || e).includes('Extension context invalidated')) enterZombie(); }
      });
    } catch (e) {
      if (String((e && e.message) || e).includes('Extension context invalidated')) enterZombie();
    }
  }
  safe(pushToken);
  if (!ctxDead) {
    tokenTimer.id = setInterval(function(){ safe(pushToken); }, 15000); // token 轮换/登录态变化时自动更新
    safe(function(){ chrome.runtime.onMessage.addListener(onMessage); });
  }

  // ---------- API 同源中继 ----------
  function onMessage(msg, _sender, sendResponse) {
    try {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'mg:api') {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const to = ctrl ? setTimeout(() => ctrl.abort(), 25_000) : null;
        fetch(ORIGIN + '/api/' + String(msg.path || '').replace(/^\/+/, ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg.body || {}),
          signal: ctrl ? ctrl.signal : undefined,
        })
          .then(async (r) => {
            let json = null;
            try { json = await r.json(); } catch (e) { /* 空 body */ }
            sendResponse({ ok: r.ok, status: r.status, json });
          })
          .catch((e) => { try { sendResponse({ ok: false, status: 0, json: null, error: String(e) }); } catch (e2) {} })
          .finally(() => { if (to) clearTimeout(to); });
        return true; // 异步响应
      }
      if (msg.type === 'mg:scan-token') {
        (async () => {
          let token = null;
          try { token = await scanTokenAsync(); } catch (e) { token = null; }
          try { sendResponse({ token: token || null }); } catch (e2) {}
        })();
        return true; // 异步响应
      }
    } catch (e) {
      if (String((e && e.message) || e).includes('Extension context invalidated')) enterZombie();
      try { sendResponse({ ok: false, status: 0, json: null, error: String(e) }); } catch (e2) {}
    }
  }
  // onMessage 监听器的注册已并入上方条件块（上下文失效时不再注册）

  // ---------- 用户主页注入“抓取此用户”按钮 ----------
  let currentHandle = null;
  let lastLabel = null;
  let scheduled = false;

  function routeHandle() {
    const m = /^\/@([A-Za-z0-9_.\-]+(?:@[A-Za-z0-9_.\-]+)?)/.exec(location.pathname);
    if (m) return m[1];
    return null;
  }

  function ensureButton() {
    if (ctxDead) return; // 上下文已失效：保持清理后的状态，不再注入
    const handle = routeHandle();
    currentHandle = handle;
    let btn = document.getElementById(BTN_ID);
    if (!handle) {
      if (btn) btn.remove();
      lastLabel = null;
      return;
    }
    const label = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M12 4v15M5.5 12.5 12 19l6.5-6.5"/></svg>抓取 @' + handle.split('@')[0] + ' 的图片';
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      Object.assign(btn.style, {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        zIndex: '99999',
        padding: '10px 16px',
        borderRadius: '999px',
        border: 'none',
        background: 'linear-gradient(135deg,#86b300,#5d9b00)',
        color: '#fff',
        fontWeight: '700',
        fontSize: '14px',
        cursor: 'pointer',
        boxShadow: '0 4px 14px rgba(0,0,0,.35)',
        fontFamily: 'system-ui,sans-serif',
      });
      btn.addEventListener('mouseenter', () => (btn.style.filter = 'brightness(1.1)'));
      btn.addEventListener('mouseleave', () => (btn.style.filter = ''));
      btn.addEventListener('click', () => {
        safe(() => chrome.runtime.sendMessage({ type: 'mg:open-manager', handle: currentHandle }));
      });
      document.documentElement.appendChild(btn);
      lastLabel = label;
    } else if (btn.dataset.mgL !== label) {
      // 仅在变化时写入，避免触发 observer 自激循环（label 含 SVG，textContent 会剥离它，比较用 dataset 存原串）
      btn.dataset.mgL = label;
      btn.innerHTML = label;
    }
  }

  // 防抖：SPA 一次路由/DOM 批量变化只检查一次；自身写入不再引发连锁
  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      ensureButton();
    }, 300);
  }

  ensureButton();
  const mo = new MutationObserver(scheduleEnsure);
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
