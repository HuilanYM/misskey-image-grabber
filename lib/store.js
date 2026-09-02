// chrome.storage.local 任务/设置持久化

const TASK_KEY = 'mg:task';
const SETTINGS_KEY = 'mg:settings';

export const DEFAULT_SETTINGS = {
  user: '',
  preset: 'balanced',
  mode: 'files', // files=高效(跳过回复) / full=全覆盖(含回复图片)
  withRenotes: false,
  onlyOriginal: false,
  limit: 40,
  pace: 'normal',
  maxNotes: 500,
  maxImages: 0,
  sinceDate: 0, // 本地毫秒；0=不限（与 readForm 写回的类型一致）
  untilDate: 0,
  // 内容过滤
  formats: [], // 空 = 不限；否则为扩展名数组 ['jpg','png',...]
  minW: 0,
  minH: 0,
  minKB: 0,
  skipSensitive: false,
  // 命名与目录
  nameTemplate: 'datetime', // datetime | noteid | date | orig
  groupBy: 'none', // none | year | month
  // 档案与下载
  archiveOrder: 'newfirst', // newfirst | oldfirst
  revealSens: false,
  mediaPace: 'normal', // gentle | normal | fast
  saveTarget: 'downloads', // downloads = 浏览器下载文件夹；folder = 自选文件夹（File System Access）
  skipOwned: true, // 导出时默认跳过过往已下载过的文件
  token: null,
};

export async function loadSettings() {
  const o = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(o[SETTINGS_KEY] || {}) };
}

let _settingsQueue = Promise.resolve();
export function saveSettings(patch) {
  // 读-改-写串行化：并发调用按序合并，避免互相覆盖丢字段（onboarding 与 manager 共用此实现）
  _settingsQueue = _settingsQueue
    .then(async () => {
      const cur = await loadSettings();
      const next = { ...cur, ...patch };
      await chrome.storage.local.set({ [SETTINGS_KEY]: next });
      return next;
    })
    .catch((e) => {
      console.warn('saveSettings failed', e);
      return loadSettings();
    });
  return _settingsQueue;
}

/**
 * 任务结构：
 * { user, opts, state:{ userId, untilId, seen, notes, requests, done }, status, startedAt, updatedAt }
 */
export async function loadTask() {
  const o = await chrome.storage.local.get(TASK_KEY);
  return o[TASK_KEY] || null;
}

export async function saveTask(task) {
  task.updatedAt = Date.now();
  await chrome.storage.local.set({ [TASK_KEY]: task });
}

export async function clearTask() {
  await chrome.storage.local.remove(TASK_KEY);
}

export async function setToken(token) {
  await chrome.storage.local.set({ 'mk:token': token });
}

export async function getToken() {
  const o = await chrome.storage.local.get('mk:token');
  return o['mk:token'] || null;
}
