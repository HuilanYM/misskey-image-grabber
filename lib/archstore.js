// 增量档案存储：按用户持久化"合并后的笔记数据"，让 archive.html 可以持续合并新内容
// 存储键：
//   'arch:user:<userId>'  -> {username, host, name, avatarUrl, folder, updatedAt, noteCount}
//   'arch:notes:<userId>' -> [trimmedNote...]（新→旧，cap 上限）
//   'arch:emoji:<userId>' -> { [emojiUrl]: 本地文件名 }（已落地的表情资源）

const CAP = 5000;

const metaKey = (id) => 'arch:user:' + id;
const notesKey = (id) => 'arch:notes:' + id;
export const emojiKey = (id) => 'arch:emoji:' + id;
export const emojiNamesKey = (id) => 'arch:emojinames:' + id;
export const avatarKey = (id) => 'arch:avatar:' + id;

/** 纯函数：合并两批笔记（按 id 去重，新版本覆盖旧版本，新→旧排序，cap 截断） */
export function mergeNoteLists(oldNotes, newNotes, cap = CAP) {
  const map = new Map();
  for (const n of oldNotes || []) {
    if (n && n.id) map.set(n.id, n);
  }
  let added = 0;
  for (const n of newNotes || []) {
    if (!n || !n.id) continue;
    if (!map.has(n.id)) added++;
    map.set(n.id, n);
  }
  const all = [...map.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { notes: all.slice(0, cap), added };
}

export async function archMeta(userId) {
  const o = await chrome.storage.local.get(metaKey(userId));
  return o[metaKey(userId)] || null;
}

/** 读旧档案笔记 → 合并本次抓取 → 持久化。返回 {notes, added} */
export async function mergeNotes(userId, user, newNotes, folder, naming) {
  const o = await chrome.storage.local.get(notesKey(userId));
  const old = o[notesKey(userId)] || [];
  const { notes, added } = mergeNoteLists(old, newNotes);
  await chrome.storage.local.set({
    [notesKey(userId)]: notes,
    [metaKey(userId)]: {
      username: user.username,
      host: user.host ?? null,
      name: user.name ?? null,
      avatarUrl: user.avatarUrl ?? null,
      folder: folder || null,
      naming: naming || null, // {template, groupBy}——改名会导致磁盘旧文件与新档案引用不一致
      noteCount: notes.length,
      updatedAt: Date.now(),
    },
  });
  return { notes, added };
}

export async function emojiMap(userId) {
  const o = await chrome.storage.local.get(emojiKey(userId));
  return new Map(Object.entries(o[emojiKey(userId)] || {}));
}

export async function rememberEmojis(userId, entries) {
  if (!entries || !entries.length) return;
  const cur = await emojiMap(userId);
  for (const [url, fname] of entries) cur.set(url, fname);
  await chrome.storage.local.set({ [emojiKey(userId)]: Object.fromEntries(cur) });
}

/** 表情名称键（name / name@host）→ URL 映射（重建 HTML 时无需重新请求 meta） */
export async function emojiNameMap(userId) {
  const o = await chrome.storage.local.get(emojiNamesKey(userId));
  return new Map(Object.entries(o[emojiNamesKey(userId)] || {}));
}

export async function rememberEmojiNames(userId, entries) {
  if (!entries || !entries.length) return;
  const cur = await emojiNameMap(userId);
  for (const [nameKey, url] of entries) cur.set(nameKey, url);
  await chrome.storage.local.set({ [emojiNamesKey(userId)]: Object.fromEntries(cur) });
}

/** 头像本地文件名（跨会话记住，重建 HTML 无需探测磁盘） */
export async function rememberAvatar(userId, localName) {
  if (!localName) return;
  await chrome.storage.local.set({ [avatarKey(userId)]: localName });
}

export async function avatarLocal(userId) {
  const o = await chrome.storage.local.get(avatarKey(userId));
  return o[avatarKey(userId)] || null;
}
