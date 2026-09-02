// 下载过往记录：谁的内容、哪些文件已经下载过
// 存储结构：
//   'hist:users'          -> { [userId]: {username, host, name, avatarUrl, count, lastAt} }
//   'hist:files:<userId>' -> { [fileId]: {n: 本地文件名, t: 时间戳} }

import { emojiKey as archEmojiKey, emojiNamesKey as archEmojiNamesKey, avatarKey as archAvatarKey, mergeNoteLists } from './archstore.js';
import { t as tt } from './i18n.js';

const USERS_KEY = 'hist:users';
const filesKey = (userId) => 'hist:files:' + userId;
const archNotesKey = (userId) => 'arch:notes:' + userId;

async function getUsers() {
  const o = await chrome.storage.local.get(USERS_KEY);
  return o[USERS_KEY] || {};
}

async function putUsers(map) {
  await chrome.storage.local.set({ [USERS_KEY]: map });
}

async function getFiles(userId) {
  const o = await chrome.storage.local.get(filesKey(userId));
  return o[filesKey(userId)] || {};
}

/** 记录一次成功导出的文件（增量合并） */
export async function recordFiles(userId, user, items) {
  if (!userId || !Array.isArray(items) || items.length === 0) return;
  const files = await getFiles(userId);
  const now = Date.now();
  for (const it of items) {
    if (it && it.file && it.file.id) files[it.file.id] = { n: it.localName || '', t: now };
  }
  const users = await getUsers();
  users[userId] = {
    username: user.username,
    host: user.host ?? null,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
    count: Object.keys(files).length,
    lastAt: now,
  };
  await chrome.storage.local.set({ [filesKey(userId)]: files });
  await putUsers(users);
  return Object.keys(files).length;
}

/** 该用户已拥有的文件 ID 集合 */
export async function ownedSet(userId) {
  const files = await getFiles(userId);
  return new Set(Object.keys(files));
}

/** 列出全部记录（按最近导出排序） */
export async function listHistory() {
  const users = await getUsers();
  return Object.entries(users)
    .map(([userId, u]) => ({ userId, ...u }))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

export async function clearUser(userId) {
  const users = await getUsers();
  delete users[userId];
  await putUsers(users);
  // 同步清掉该用户的增量档案数据（笔记/元信息/表情映射）
  await chrome.storage.local.remove([
    filesKey(userId), 'arch:user:' + userId, 'arch:notes:' + userId,
    archEmojiKey(userId), archEmojiNamesKey(userId), archAvatarKey(userId),
  ]);
}

export async function clearAll() {
  // 全量扫描清理：除正常记录外，还兜底覆盖「增量写入中途失败」留下的无 hist 行孤儿 arch:* 键
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('hist:') || k.startsWith('arch:'));
  if (keys.length) await chrome.storage.local.remove(keys);
}

/** 导出全部记录为 JSON 备份（含文件记录 + 增量档案笔记数据，可用于跨浏览器恢复） */
export async function exportHistoryJson() {
  const users = await listHistory();
  const all = [];
  for (const u of users) {
    const files = await getFiles(u.userId);
    const o = await chrome.storage.local.get([archNotesKey(u.userId), archEmojiKey(u.userId), archEmojiNamesKey(u.userId), archAvatarKey(u.userId)]);
    all.push({
      ...u, files,
      archNotes: o[archNotesKey(u.userId)] || [],
      emojiMap: o[archEmojiKey(u.userId)] || {},       // 表情 URL → 本地文件名
      emojiNames: o[archEmojiNamesKey(u.userId)] || {}, // 表情名 → 远端 URL
      avatar: o[archAvatarKey(u.userId)] || null,       // 头像本地文件名
    });
  }
  return JSON.stringify({ exportedAt: new Date().toISOString(), generator: 'Misskey Image Grabber', users: all }, null, 1);
}

/** 导入记录（text 可为 JSON 字符串或已解析的对象；与现有记录合并：文件并集、笔记按 ID 合并去重） */
export async function importHistoryData(text, lang = 'zh-CN') {
  const T = (k) => tt(lang, k);
  let data;
  if (typeof text === 'string') {
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(T('errBadJson'));
    }
  } else if (text && typeof text === 'object') {
    data = text;
  } else {
    throw new Error(T('errBadJson'));
  }
  const list = Array.isArray(data) ? data : Array.isArray(data.users) ? data.users : null;
  if (!list) throw new Error(T('errBadFormat'));

  let uCount = 0;
  let fCount = 0;
  let nCount = 0;
  for (const u of list) {
    if (!u || !u.userId) continue;
    uCount++;

    // 文件记录：并集合并
    const cur = await getFiles(u.userId);
    for (const [fid, v] of Object.entries(u.files || {})) {
      if (!cur[fid]) {
        cur[fid] = v && typeof v === 'object' ? v : { n: '', t: Date.now() };
        fCount++;
      }
    }
    await chrome.storage.local.set({ [filesKey(u.userId)]: cur });

    // 增量档案笔记数据：按 ID 合并
    if (Array.isArray(u.archNotes) && u.archNotes.length) {
      const o = await chrome.storage.local.get(archNotesKey(u.userId));
      const merged = mergeNoteLists(o[archNotesKey(u.userId)] || [], u.archNotes);
      await chrome.storage.local.set({ [archNotesKey(u.userId)]: merged.notes });
      nCount += merged.notes.length;
    }

    // 表情/头像映射：与现有值合并（新值优先），恢复「重新生成 HTML」所需的离线引用
    const restore = {};
    if (u.emojiMap && typeof u.emojiMap === 'object') {
      const o = await chrome.storage.local.get(archEmojiKey(u.userId));
      restore[archEmojiKey(u.userId)] = { ...(o[archEmojiKey(u.userId)] || {}), ...u.emojiMap };
    }
    if (u.emojiNames && typeof u.emojiNames === 'object') {
      const o = await chrome.storage.local.get(archEmojiNamesKey(u.userId));
      restore[archEmojiNamesKey(u.userId)] = { ...(o[archEmojiNamesKey(u.userId)] || {}), ...u.emojiNames };
    }
    if (u.avatar) restore[archAvatarKey(u.userId)] = u.avatar;
    if (Object.keys(restore).length) await chrome.storage.local.set(restore);

    // 用户元信息
    const um = await getUsers();
    const old = um[u.userId];
    um[u.userId] = {
      username: u.username ?? (old && old.username) ?? '?',
      host: u.host ?? (old && old.host) ?? null,
      name: u.name ?? (old && old.name) ?? null,
      avatarUrl: u.avatarUrl ?? (old && old.avatarUrl) ?? null,
      count: Object.keys(cur).length,
      lastAt: Math.max(u.lastAt || 0, (old && old.lastAt) || 0),
    };
    await putUsers(um);
  }
  if (!uCount) throw new Error(T('errNoRecords'));
  return { users: uCount, files: fCount, notes: nCount };
}
