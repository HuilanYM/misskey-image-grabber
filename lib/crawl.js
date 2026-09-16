// 分页抓取循环：拟人节奏（随机抖动 + 周期性长停顿）、暂停/停止、断点续抓
// 无 chrome 依赖。api 形如 lib/api.js 的 { call }
// v0.4.0：新增站点适配器分页（构造参数 pageFetch，Mastodon 系站点如 baraag.net，见 lib/sites.js）——
//   传入 pageFetch 时跳过 api.call，游标存 state.cursor；不传走原 Misskey 路径，行为零变化

import { sleep, rand, noteImages, noteMatchesType, trimNote, parseUserInput } from './util.js';
import { interruptibleSleep } from './api.js';
import { t as tt } from './i18n.js';

export const DEFAULT_PACE = {
  safest: { label: '稳健（最安全）', min: 2500, max: 6500, longEveryMin: 8, longEveryMax: 15, longMin: 45, longMax: 120, batchEveryMin: 20, batchEveryMax: 30, batchMin: 8, batchMax: 20 },
  slow: { label: '慢速', min: 1600, max: 4200, longEveryMin: 12, longEveryMax: 22, longMin: 12, longMax: 35, batchEveryMin: 30, batchEveryMax: 50, batchMin: 5, batchMax: 12 },
  normal: { label: '平衡（推荐）', min: 900, max: 2600, longEveryMin: 18, longEveryMax: 35, longMin: 8, longMax: 28, batchEveryMin: 45, batchEveryMax: 80, batchMin: 3, batchMax: 8 },
  fast: { label: '快速（不推荐）', min: 700, max: 2000, longEveryMin: 20, longEveryMax: 40, longMin: 10, longMax: 30, batchEveryMin: 40, batchEveryMax: 60, batchMin: 5, batchMax: 10 },
};

/**
 * Crawler
 * @param api { call }
 * @param opts { contentType:'all'|'image'|'article'|'renote', limit, pace, maxNotes, maxImages, maxRequests, sinceDate, untilDate, onlyOriginal }
 *   - contentType 决定 users/notes 请求参数与客户端逐条过滤（缺省回退 'image'；旧任务字段
 *     mode:'files'/'full' 没有 contentType，一律按 image 处理，与升级前行为一致）：
 *     all     : withReplies + withChannelNotes（withRenotes 省略，服务端默认 true），客户端不过滤
 *     image   : withFiles + withRenotes:false，客户端再做格式/尺寸/敏感过滤
 *     article : withRenotes:false + withReplies，客户端要求有文字内容（hasTextContent）
 *     renote  : 请求体不加过滤参数，客户端要求有 renoteId
 *   - 2026-09-14 实测：withFiles 与 withReplies 可同时传，旧版"两者互斥"的服务端限制已不存在
 *   - pageFetch（可选，v0.4.0 站点适配器）：async (cursor|null) => { notes:[Misskey形态note], nextCursor:string|null }
 *     传入后本类跳过 users/notes 请求，翻页游标改存 state.cursor（nextCursor=null 表示取尽）；
 *     Misskey 路径仍用 state.untilId，两者互不干扰
 * @param state 持久化状态（就地修改）：{ untilId, cursor, seen:{}, notes:[], requests, done }
 * @param hooks { onNote, onProgress, onStatus, onBackoff, shouldPause, shouldAbort }
 */
export class Crawler {
  constructor({ api, opts, state, hooks = {}, lang = 'zh-CN', pageFetch = null }) {
    this.api = api;
    this.opts = opts;
    this.state = state;
    this.hooks = hooks;
    this.lang = lang;
    this.pageFetch = pageFetch || null;
    this.pace = DEFAULT_PACE[opts.pace] || DEFAULT_PACE.normal;
  }

  /** '@user' / '@user@host' / URL → users/show */
  async resolveUser(input) {
    const parsed = parseUserInput(input);
    if (!parsed) return { ok: false, message: tt(this.lang, 'errNoUser') };
    const res = await this.api.call('users/show', { username: parsed.username, host: parsed.host ?? null });
    if (!res.ok) {
      if (res.code === 'NO_SUCH_USER') {
        return { ok: false, message: tt(this.lang, 'errNoSuchUser') };
      }
      return { ok: false, message: res.message || tt(this.lang, 'errQueryFail').replace('{status}', res.status) };
    }
    return { ok: true, user: res.data };
  }

  async waitWhilePaused() {
    while (this.hooks.shouldPause && this.hooks.shouldPause()) {
      if (this.hooks.shouldAbort && this.hooks.shouldAbort()) return;
      await sleep(300);
    }
  }

  /** 运行抓取，直到取尽 / 达到上限 / 中止。返回 {stopped, reason} */
  async run() {
    const {
      limit = 40, maxNotes = 0, maxImages = 0, maxRequests = 0,
      sinceDate = 0, untilDate = 0,
      onlyOriginal = false, formats, skipSensitive, minW, minH, minKB,
    } = this.opts;
    const fopts = { formats, skipSensitive, minW, minH, minKB };
    // 内容类型：缺省/旧任务（含旧 mode:'files'/'full'，无 contentType）一律回退 image
    const contentType = this.opts.contentType || 'image';
    const imgCount = () => st.notes.reduce((s, n) => s + noteImages(n, fopts).length, 0);
    const st = this.state;

    while (true) {
      if (this.hooks.shouldAbort && this.hooks.shouldAbort()) return { stopped: true, reason: 'aborted' };
      await this.waitWhilePaused();
      if (this.hooks.shouldAbort && this.hooks.shouldAbort()) return { stopped: true, reason: 'aborted' };

      if (maxRequests && st.requests >= maxRequests) return { stopped: true, reason: 'maxRequests' };
      if (maxNotes && st.notes.length >= maxNotes) return { stopped: true, reason: 'maxNotes' };
      // 图片数上限仅在 image 模式下有意义（其他模式不保证产出图片）
      if (maxImages && contentType === 'image' && imgCount() >= maxImages) return { stopped: true, reason: 'maxImages' };

      let page;
      if (this.pageFetch) {
        // ── v0.4.0 站点适配器分支（Mastodon 系，如 baraag.net）──
        // 请求/重试/限速由适配器内部完成，这里跳过 api.call 的 body 构造与请求，
        // 只接管游标与计数：游标存 state.cursor（saveTask 原样序列化，续抓自动恢复），
        // 不触碰 state.untilId；notes 已归一化为 Misskey 形态，下方过滤循环原样共用
        if (this.hooks.onStatus) this.hooks.onStatus(tt(this.lang, 'crawlingN', { n: st.requests + 1 }));
        let pr;
        try {
          pr = await this.pageFetch(st.cursor || null);
        } catch (e) {
          return { stopped: true, reason: 'error', message: (e && e.message) || String(e) };
        }
        st.requests++;
        page = pr && Array.isArray(pr.notes) ? pr.notes : [];
        st.cursor = pr && pr.nextCursor != null ? pr.nextCursor : null;
        if (page.length === 0) {
          st.done = true;
          return { stopped: false, reason: 'exhausted' };
        }
      } else {
        // ── Misskey 原路径（行为不变）──
        const body = { userId: st.userId, limit };
        if (st.untilId) body.untilId = st.untilId;
        // 请求体过滤参数按内容类型区分
        if (contentType === 'all') {
          body.withReplies = true;
          body.withChannelNotes = true;
          // withRenotes 省略，服务端默认 true
        } else if (contentType === 'article') {
          body.withRenotes = false;
          body.withReplies = true;
        } else if (contentType === 'renote') {
          // 不加任何过滤参数，原样拉取
        } else {
          body.withFiles = true;
          body.withRenotes = false;
        }

        if (this.hooks.onStatus) this.hooks.onStatus(tt(this.lang, 'crawlingN', { n: st.requests + 1 }));
        const res = await this.api.call('users/notes', body);
        if (!res.ok) {
          if (res.aborted) return { stopped: true, reason: 'aborted' };
          if (res.rateLimited) return { stopped: true, reason: 'ratelimited', message: res.message };
          return { stopped: true, reason: 'error', message: res.message || `HTTP ${res.status}` };
        }
        st.requests++;

        page = Array.isArray(res.data) ? res.data : [];
        if (page.length === 0) {
          st.done = true;
          return { stopped: false, reason: 'exhausted' };
        }
      }

      let added = 0;
      // P3 启发式：从开始至今一条都没抓到 + 连续 20 页无新增 → 大概率过滤条件排除了所有内容
      // （如最小宽度过大/格式全排除）。提前停止保留断点，用户可从横幅继续。
      // API 按 id 降序返回；untilId 始终取本页最后一条（含被过滤的），保证翻页正确
      // （仅 Misskey 路径；适配器分支的游标已在上方写入 state.cursor）
      if (!this.pageFetch) st.untilId = page[page.length - 1].id;

      for (const raw of page) {
        // 日期上界：跳过更新的笔记
        if (untilDate && new Date(raw.createdAt).getTime() > untilDate) continue;
        // 日期下界：更早的笔记直接结束（降序）
        if (sinceDate && new Date(raw.createdAt).getTime() < sinceDate) {
          st.done = true;
          return { stopped: false, reason: 'sinceDate' };
        }
        if (st.seen[raw.id]) continue;

        // 全覆盖模式下可选：只要原创（忽略回复）
        if (onlyOriginal && raw.replyId) continue;

        // 按内容类型逐条过滤：image 含格式/尺寸/敏感过滤；article 要有文字内容；renote 要有转发目标；all 全保留
        // （纯转贴不再无条件丢弃：renote 模式它们是目标，all 模式它们是内容，
        //   image 模式由服务端 withFiles 排除、article 模式由 hasTextContent 排除）
        if (!noteMatchesType(raw, contentType, fopts)) continue;

        st.seen[raw.id] = 1;
        const note = trimNote(raw);
        st.notes.push(note);
        added++;
        if (this.hooks.onNote) this.hooks.onNote(note);
        if (maxNotes && st.notes.length >= maxNotes) {
          return { stopped: true, reason: 'maxNotes' };
        }
        if (contentType === 'image' && maxImages && imgCount() >= maxImages) {
          return { stopped: true, reason: 'maxImages' };
        }
      }

      if (added === 0) this._emptyStreak = (this._emptyStreak || 0) + 1;
      else this._emptyStreak = 0;
      if (st.notes.length === 0 && this._emptyStreak >= 20) {
        return { stopped: true, reason: 'noMatch' };
      }

      if (this.hooks.onProgress) {
        this.hooks.onProgress({ requests: st.requests, pageLen: page.length, added, total: st.notes.length });
      }

      // 是否翻到底：Misskey 返回数量不足一页基本代表取尽（空 untilId 由下轮空页判定）；
      // 适配器分支由 nextCursor 为空判定取尽（本页 notes 已在上方共用循环处理，不丢末页数据）
      if (this.pageFetch ? st.cursor == null : page.length < limit) {
        st.done = true;
        return { stopped: false, reason: 'exhausted' };
      }

      // 拟人节奏：常规抖动 + 周期性长停顿 + 更大周期的批次休息
      const sinceLong = st.requests - (this._lastLongPause || 0);
      const sinceBatch = st.requests - (this._lastBatch || 0);
      const batchEvery = Math.round(rand(this.pace.batchEveryMin || 0, this.pace.batchEveryMax || 0));

      if (batchEvery > 0 && sinceBatch >= batchEvery) {
        const sec = rand(this.pace.batchMin * 60, this.pace.batchMax * 60);
        this._lastBatch = st.requests;
        if (this.hooks.onStatus) this.hooks.onStatus(tt(this.lang, 'batchRestC', { t: fmtMin(sec, this.lang) }));
        if (await interruptibleSleep(sec * 1000, this.hooks)) return { stopped: true, reason: 'aborted' };
      } else if (sinceLong >= Math.round(rand(this.pace.longEveryMin, this.pace.longEveryMax))) {
        const sec = rand(this.pace.longMin, this.pace.longMax);
        this._lastLongPause = st.requests;
        if (this.hooks.onStatus) this.hooks.onStatus(tt(this.lang, 'longPauseC', { s: Math.round(sec) }));
        if (await interruptibleSleep(sec * 1000, this.hooks)) return { stopped: true, reason: 'aborted' };
      } else {
        const ms = rand(this.pace.min, this.pace.max);
        if (await interruptibleSleep(ms, this.hooks)) return { stopped: true, reason: 'aborted' };
      }
    }
  }
}

function fmtMin(sec, lang) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return tt(lang, 'fmtMinSec', { m, s });
}
