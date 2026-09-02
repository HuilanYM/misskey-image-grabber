// 自选保存文件夹：File System Access API + IndexedDB 句柄持久化
// 仅在扩展页（manager）使用；浏览器不支持时上层自动回退 chrome.downloads

const DB_NAME = 'mg-dirs';
const STORE = 'handles';
const KEY = 'saveDir';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function supportsDirPicker() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** 弹出系统目录选择框（必须由用户点击等手势触发） */
export async function pickDirectory() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await saveHandle(handle);
  return handle;
}

export async function saveHandle(handle) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(handle, KEY);
  await txDone(tx);
}

export async function loadHandle() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(KEY);
    return await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null;
  }
}

// 保留未接入：预留给「解除文件夹授权」入口；当前清空历史特意保留文件夹授权
export async function clearHandle() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(KEY);
    await txDone(tx);
  } catch (e) { /* 忽略 */ }
}

export async function hasPermission(handle) {
  if (!handle || !handle.queryPermission) return false;
  return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
}

/** 重新授权（必须由用户手势触发） */
export async function requestPermission(handle) {
  return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
}

/** 向句柄目录写文件；path 支持多级子目录（自动创建），data 为 Blob/Uint8Array/字符串 */
export async function writeFileIn(dirHandle, path, data) {
  const parts = String(path).split('/').filter(Boolean);
  let dir = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: true });
  }
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

/** 检查文件是否已存在（用于精确的已拥有判断） */
export async function fileExists(dirHandle, path) {
  try {
    const parts = String(path).split('/').filter(Boolean);
    let dir = dirHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    await dir.getFileHandle(parts[parts.length - 1]);
    return true;
  } catch (e) {
    return false;
  }
}

/** 列出目录下的条目 [{name, kind:'file'|'directory'}] */
export async function listEntries(dirHandle) {
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    out.push({ name, kind: handle.kind });
  }
  return out;
}

/** 读取目录下文件文本（path 支持多级子目录） */
export async function readFileText(dirHandle, path) {
  const parts = String(path).split('/').filter(Boolean);
  let dir = dirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  const fh = await dir.getFileHandle(parts[parts.length - 1]);
  const file = await fh.getFile();
  return await file.text();
}
