// Misskey API 客户端：无 chrome 依赖（fetchImpl 由调用方注入）
// 负责：token 附加、限流识别（429 / RATE_LIMIT_EXCEEDED）、指数退避、5xx 重试

import { sleep } from './util.js';
import { t as tt } from './i18n.js';

const RATE_BACKOFF = [20, 60, 180]; // 秒
const SERVER_BACKOFF = [5, 15, 30]; // 秒

/**
 * @param fetchImpl async (path, body) => {ok, status, json}
 * @param getToken () => string|null  登录 token
 * @param hooks { onBackoff?(sec, reason), shouldAbort?() }
 */
export function createApiClient({ fetchImpl, getToken, hooks = {} }) {
  let tokenGetter = getToken || null;
  const T = (k, v) => tt(typeof hooks.lang === 'function' ? hooks.lang() : (hooks.lang || 'zh-CN'), k, v);

  async function call(path, body = {}) {
    let token = tokenGetter ? tokenGetter() : null;
    let payload = token ? { ...body, i: token } : { ...body };
    let tokenRetryDone = false;

    for (let attempt = 0; ; attempt++) {
      if (hooks.shouldAbort && hooks.shouldAbort()) return { ok: false, aborted: true };

      let res;
      try {
        res = await fetchImpl(path, payload);
      } catch (e) {
        if (attempt < 2) {
          await sleep(3000);
          continue;
        }
        return { ok: false, error: 'NETWORK', message: String(e && e.message ? e.message : e) };
      }

      const code = res.json && res.json.error ? res.json.error.code : null;

      // token 失效/被拒：丢弃 token 改匿名重试一次（匿名若可用则任务不受影响）
      if ((res.status === 401 || code === 'AUTHENTICATION_FAILED') && token && !tokenRetryDone) {
        tokenRetryDone = true;
        token = null;
        payload = { ...body };
        if (hooks.onTokenInvalid) hooks.onTokenInvalid();
        attempt = -1;
        continue;
      }

      const rateLimited = res.status === 429 || code === 'RATE_LIMIT_EXCEEDED';

      if (rateLimited) {
        if (attempt >= RATE_BACKOFF.length) {
          return { ok: false, rateLimited: true, status: res.status, code, message: T('apiRateStop') };
        }
        const sec = RATE_BACKOFF[attempt];
        if (hooks.onBackoff) hooks.onBackoff(sec, T('apiBackoffRate'));
        if (await interruptibleSleep(sec * 1000, hooks)) return { ok: false, aborted: true };
        continue;
      }

      if (res.status >= 500) {
        if (attempt >= SERVER_BACKOFF.length) {
          return { ok: false, error: 'SERVER', status: res.status, message: T('apiServerError', { s: res.status }) };
        }
        const sec = SERVER_BACKOFF[attempt];
        if (hooks.onBackoff) hooks.onBackoff(sec, T('apiBackoffSrv'));
        if (await interruptibleSleep(sec * 1000, hooks)) return { ok: false, aborted: true };
        continue;
      }

      if (res.ok) return { ok: true, data: res.json };

      return {
        ok: false,
        status: res.status,
        code,
        message: (res.json && res.json.error && res.json.error.message) || `HTTP ${res.status}`,
      };
    }
  }

  return { call, setTokenGetter: (fn) => { tokenGetter = fn; } };
}

/** 可被 shouldAbort 打断的休眠 */
export async function interruptibleSleep(ms, hooks) {
  const step = 200;
  let waited = 0;
  while (waited < ms) {
    if (hooks && hooks.shouldAbort && hooks.shouldAbort()) return true;
    await sleep(Math.min(step, ms - waited));
    waited += step;
  }
  return false;
}
