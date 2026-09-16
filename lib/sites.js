// 站点适配器注册表：多站聚合的唯一站点事实源（v0.4.0 新增 baraag.net / Mastodon 系）
// 设计原则：Mastodon status 在适配器边界归一化为 Misskey note 形态（statusToNote），
// 让 render.js / archstore / 导出 / 媒体抽屉 / 时间导航零改动复用；禁止在渲染层写站点特判。
// 本文件不依赖 chrome API；fetch 由调用方上下文提供（manager 页直连即可，baraag 国内可达）。

import { htmlToText } from './htmltext.js';

const NS = { 'baraag.net': 'baraag.net', 'misskey.io': 'misskey.io' };

export const SITES = {
  'misskey.io': {
    id: 'misskey.io', host: 'misskey.io', product: 'Misskey', kind: 'misskey',
    direct: false,            // 需 Clash 代理；经 misskey.io 标签页中继
    cursorParam: 'untilId',   // POST users/notes
    limit: 100,
  },
  'baraag.net': {
    id: 'baraag.net', host: 'baraag.net', product: 'Mastodon (baraag)', kind: 'mastodon',
    direct: true,             // 匿名直连可达（2026-09-15 实测 200）
    cursorParam: 'max_id',    // GET accounts/:id/statuses
    limit: 40,
  },
};

/** 从输入识别站点与账号：支持 @user（默认 misskey.io）、@user@host、https://host/@user */
export function detectSiteFromInput(input) {
  const s = String(input || '').trim();
  let m = /@([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)/.exec(s);
  if (m) {
    const host = m[2];
    if (SITES[host]) return { site: SITES[host], username: m[1], host };
    // 远程实例句柄（如 @user@remote.example）：未知 host 时按 misskey.io 句柄处理（users/show 支持 host）
    return { site: SITES['misskey.io'], username: m[1], host, unknownHost: true };
  }
  m = /https?:\/\/([^/\s]+)\/@([A-Za-z0-9_.-]+)/.exec(s);
  if (m && SITES[m[1]]) return { site: SITES[m[1]], username: m[2], host: m[1] };
  m = /^@?([A-Za-z0-9_.-]+)$/.exec(s);
  if (m) return { site: SITES['misskey.io'], username: m[1], host: 'misskey.io' };
  return null;
}

// ---------- baraag.net（Mastodon）适配 ----------

const BARAAG_BASE = 'https://baraag.net';
const B_SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

async function baraagJson(path) {
  const url = BARAAG_BASE + path;
  // 网络层重试：本站直连常被干扰（连接挂起/重置），用户浏览器一般走系统代理（与 misskey.io 同一前提）。
  // 每次尝试带 25s AbortController 超时——挂起的连接不能让 startCrawl 永久卡死。
  const AC = typeof AbortController !== 'undefined' ? AbortController : null;
  for (let a = 0; ; a++) {
    const ac = AC ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), 25000) : null;
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ac ? ac.signal : undefined });
      // 体读取必须在超时保护内：直连不稳时头部到了、体挂起是常见形态
      const j = await res.json();
      if (timer) clearTimeout(timer);
      if (res.status === 429 && a < 3) { await B_SLEEP([20, 60, 180][a] * 1000); continue; }
      if (!res.ok) throw new Error('baraag HTTP ' + res.status);
      return j;
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (a < 4) { await B_SLEEP([3000, 8000, 15000, 30000][a]); continue; }
      throw e;
    }
  }
}

/** 解析账号：@user@baraag.net / https://baraag.net/@user；返回 { ok, user, rawId } 或 { ok:false, message } */
export async function baraagResolve(input) {
  const det = detectSiteFromInput(input);
  if (!det) return { ok: false, message: 'bad input' };
  const local = det.username;
  const remote = det.host && det.host !== 'baraag.net' ? '@' + det.host : '';
  const acct = encodeURIComponent(local + remote);
  const d = await baraagJson('/api/v1/accounts/lookup?acct=' + acct);
  if (!d || !d.id) return { ok: false, message: 'NO_SUCH_USER' };
  return {
    ok: true,
    rawId: String(d.id),
    user: {
      id: 'baraag.net:' + d.id,
      username: (d.acct || det.username).split('@')[0],
      host: (d.acct || '').split('@')[1] || 'baraag.net',
      name: d.display_name || d.acct || det.username,
      avatarUrl: d.avatar_static || d.avatar || null,
      emojis: {},
      notesCount: d.statuses_count || 0,
      url: d.url || null,
    },
  };
}

/** Mastodon status → Misskey note 归一化（id 带 baraag.net 命名空间，防撞） */
export function statusToNote(status) {
  const st = status || {};
  const acc = st.account || {};
  const acctParts = String(acc.acct || '').split('@');
  const media = (st.media_attachments || [])
    .filter((a) => a && a.url)
    .map((a) => {
      const isImg = a.type === 'image';
      const ext = String((a.url || '').split('?')[0]).split('.').pop().toLowerCase();
      const type = isImg ? 'image/' + (ext === 'jpg' ? 'jpeg' : ext || 'jpeg') : (a.type || 'file') + '/x';
      const meta = (a.meta && a.meta.original) || {};
      return {
        id: 'baraag.net_' + a.id,
        name: 'baraag_' + a.id,
        type,
        url: a.url,
        thumbnailUrl: a.preview_url || null,
        isSensitive: !!st.sensitive,
        comment: a.description || '',
        size: null,
        md5: null,
        properties: meta.width ? { width: meta.width, height: meta.height } : {},
      };
    });
  const acctFull = String(acc.acct || '');
  return {
    id: 'baraag.net_' + st.id,
    createdAt: st.created_at,
    text: htmlToText(st.content),
    cw: st.spoiler_text || null,
    visibility: st.visibility || 'public',
    localOnly: false,
    replyId: st.in_reply_to_id ? 'baraag.net_' + st.in_reply_to_id : null,
    renoteId: st.reblog ? 'baraag.net_' + st.reblog.id : null,
    url: st.url || null,
    user: {
      username: acctParts[0] || 'user',
      host: acctParts[1] || 'baraag.net',
      name: acc.display_name || acc.acct || acctParts[0] || 'user',
      avatarUrl: acc.avatar_static || acc.avatar || null,
      emojis: {},
    },
    // Mastodon 收藏映射为 ⭐ 伪反应：渲染层零改动即可显示数量
    reactions: st.favourites_count ? { '⭐': st.favourites_count } : {},
    reactionEmojis: {},
    reactionCount: st.favourites_count || 0,
    renoteCount: st.reblogs_count || 0,
    renote: st.reblog
      ? {
          id: 'baraag.net_' + st.reblog.id,
          createdAt: st.reblog.created_at,
          text: htmlToText(st.reblog.content),
          cw: st.reblog.spoiler_text || null,
          user: {
            username: String((st.reblog.account || {}).acct || '').split('@')[0] || 'user',
            host: 'baraag.net',
            name: (st.reblog.account || {}).display_name || '',
            avatarUrl: (st.reblog.account || {}).avatar_static || null,
          },
          files: (st.reblog.media_attachments || []).map((a) => ({ id: 'baraag.net_' + a.id, name: 'baraag_' + a.id, type: a.type === 'image' ? 'image/' + ((String(a.url).split('.').pop() || 'jpeg').toLowerCase()) : (a.type || 'file') + '/x', url: a.url, thumbnailUrl: a.preview_url || null, isSensitive: !!st.reblog.sensitive, comment: a.description || '', size: null, md5: null, properties: {} })),
        }
      : null,
    files: media,
    poll: st.poll
      ? {
          multiple: !!st.poll.multiple,
          expiresAt: st.poll.expires_at || null,
          // Mastodon 只有总票数（votes_count），没有分项票数——诚实显示选项文本，票数计 0
          choices: (st.poll.options || []).map((o) => ({ text: o.title || '', votes: 0, isVoted: false })),
        }
      : null,
  };
}

/** 构造 baraag 时间流翻页器：返回 pageFetch(cursor) → { notes, nextCursor } 供 crawl.js 使用 */
export function baraagPageFetch(cfg) {
  const c = cfg || {};
  const limit = Math.min(40, Math.max(1, c.limit || 40));
  return async function pageFetch(cursor) {
    const p = new URLSearchParams({ limit: String(limit) });
    if (cursor) p.set('max_id', String(cursor));
    if (c.contentType === 'image') p.set('only_media', 'true');
    if (c.contentType === 'article') p.set('exclude_reblogs', 'true');
    const st = await baraagJson('/api/v1/accounts/' + c.rawId + '/statuses?' + p.toString());
    if (!Array.isArray(st) || st.length === 0) return { notes: [], nextCursor: null };
    return { notes: st.map(statusToNote), nextCursor: String(st[st.length - 1].id) };
  };
}
