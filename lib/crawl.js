// 分页抓取循环：拟人节奏（随机抖动 + 周期性长停顿）、暂停/停止、断点续抓
// 无 chrome 依赖。api 形如 lib/api.js 的 { call }

import { sleep, rand, noteImages, trimNote, parseUserInput } from './util.js';
import { interruptibleSleep } from './api.js';
import { t as tt } from './i18n.js';

export const DEFAULT_PACE = {
  safest: { label: '稳健（最安全）', min: 2500, max: 6500, longEveryMin: 8, longEveryMax: 15, longMin: 45, longMax: 120, batchEveryMin: 20, batchEveryMax: 30, batchMin: 8, batchMax: 20 },
  slow: { label: '慢速', min: 1600, max: 4200, longEveryMin: 12, longEveryMax: 22, longMin: 12, longMax: 35, batchEveryMin: 30, batchEveryMax: 50, batchMin: 5, batchMax: 12 },
  normal: { label: '平衡（推荐）', min: 900, max: 2600, longEveryMin: 18, longEveryMax: 35, longMin: 8, longMax: 28, batchEveryMin: 45, batchEveryMax: 80, batchMin: 3, batchMax: 8 },
  fast: { label: '快速（不推荐）', min: 450, max: 1300, longEveryMin: 30, longEveryMax: 60, longMin: 5, longMax: 15, batchEveryMin: 0, batchEveryMax: 0, batchMin: 0, batchMax: 0 },
};

/**
 * Crawler
 * @param api { call }
 * @param opts { mode:'files'|'full', limit, pace, maxNotes, maxRequests, sinceDate, untilDate, withRenotes }
 *   - mode 'files'  : API 端 withFiles=true（高效，跳过回复中的图片）
 *   - mode 'full'   : API 端 withReplies=true + 客户端过滤（能抓到回复里的图片；两者不能同传，服务端限制）
 * @param state 持久化状态（就地修改）：{ untilId, seen:{}, notes:[], requests, done }
 * @param hooks { onNote, onProgress, onStatus, onBackoff, shouldPause, shouldAbort }
 */
export class Crawler {
  constructor({ api, opts, state, hooks = {}, lang = 'zh-CN' }) {
    this.api = api;
    this.opts = opts;
    this.state = state;
    this.hooks = hooks;
    this.lang = lang;
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
      mode, limit = 40, maxNotes = 0, maxImages = 0, maxRequests = 0,
      sinceDate = 0, untilDate = 0, withRenotes = false,
      onlyOriginal = false, formats, skipSensitive, minW, minH, minKB,
    } = this.opts;
    const fopts = { formats, skipSensitive, minW, minH, minKB };
    const imgCount = () => st.notes.reduce((s, n) => s + noteImages(n, fopts).length, 0);
    const st = this.state;

    while (true) {
      if (this.hooks.shouldAbort && this.hooks.shouldAbort()) return { stopped: true, reason: 'aborted' };
      await this.waitWhilePaused();
      if (this.hooks.shouldAbort && this.hooks.shouldAbort()) return { stopped: true, reason: 'aborted' };

      if (maxRequests && st.requests >= maxRequests) return { stopped: true, reason: 'maxRequests' };
      if (maxNotes && st.notes.length >= maxNotes) return { stopped: true, reason: 'maxNotes' };
      if (maxImages && imgCount() >= maxImages) return { stopped: true, reason: 'maxImages' };

      const body = { userId: st.userId, limit };
      if (st.untilId) body.untilId = st.untilId;
      if (mode === 'files') {
        body.withFiles = true;
        body.withRenotes = withRenotes;
      } else {
        body.withReplies = true;
        body.withRenotes = withRenotes;
      }

      if (this.hooks.onStatus) this.hooks.onStatus(tt(this.lang, 'crawlingN', { n: st.requests + 1 }));
      const res = await this.api.call('users/notes', body);
      if (!res.ok) {
        if (res.aborted) return { stopped: true, reason: 'aborted' };
        if (res.rateLimited) return { stopped: true, reason: 'ratelimited', message: res.message };
        return { stopped: true, reason: 'error', message: res.message || `HTTP ${res.status}` };
      }
      st.requests++;

      const page = Array.isArray(res.data) ? res.data : [];
      if (page.length === 0) {
        st.done = true;
        return { stopped: false, reason: 'exhausted' };
      }

      let added = 0;
      // P3 启发式：从开始至今一条都没抓到 + 连续 20 页无新增 → 大概率过滤条件排除了所有内容
      // （如最小宽度过大/格式全排除）。提前停止保留断点，用户可从横幅继续。
      // API 按 id 降序返回；untilId 始终取本页最后一条（含被过滤的），保证翻页正确
      st.untilId = page[page.length - 1].id;

      for (const raw of page) {
        // 日期上界：跳过更新的笔记
        if (untilDate && new Date(raw.createdAt).getTime() > untilDate) continue;
        // 日期下界：更早的笔记直接结束（降序）
        if (sinceDate && new Date(raw.createdAt).getTime() < sinceDate) {
          st.done = true;
          return { stopped: false, reason: 'sinceDate' };
        }
        if (st.seen[raw.id]) continue;

        // 纯转贴（无正文）在 API 层已被 withRenotes=false 过滤；这里再兜底
        const isPureRenote = raw.renoteId && !raw.text && !(raw.files && raw.files.length) && !raw.cw;
        if (isPureRenote) continue;
        // 全覆盖模式下可选：只要原创（忽略回复）
        if (onlyOriginal && raw.replyId) continue;

        const imgs = noteImages(raw, fopts);
        if (imgs.length === 0) continue; // full 模式会混入纯文本/视频笔记，客户端过滤

        st.seen[raw.id] = 1;
        const note = trimNote(raw);
        st.notes.push(note);
        added++;
        if (this.hooks.onNote) this.hooks.onNote(note);
        if (maxNotes && st.notes.length >= maxNotes) {
          return { stopped: true, reason: 'maxNotes' };
        }
        if (maxImages && imgCount() >= maxImages) {
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

      // 是否翻到底：返回数量不足一页基本代表取尽；空 untilId 由下轮空页判定
      if (page.length < limit) {
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
