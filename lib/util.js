// 通用工具：无 chrome 依赖，可在 Node 中测试

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (min, max) => min + Math.random() * (max - min);

/** Windows/通用文件名清洗 */
export function sanitizeFilename(name, maxLen = 140) {
  let s = String(name ?? '');
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
  s = s.replace(/[\s.]+$/, '').replace(/^[\s.]+/, '');
  if (!s) s = 'file';
  if (s.length > maxLen) {
    const dot = s.lastIndexOf('.');
    if (dot > maxLen - 10) s = s.slice(0, dot - 1) + s.slice(dot);
    else s = s.slice(0, maxLen);
  }
  return s;
}

/** 从 mime type / url 推断扩展名 */
export function extFor(file) {
  const type = file?.type || '';
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  if (type === 'image/avif') return 'avif';
  if (type === 'image/apng') return 'png';
  const m = /([a-zA-Z0-9]{2,5})(?:\?|#|$)/.exec(new URL(file?.url || 'https://x/').pathname) || [];
  if (m && m[1].length <= 5) return m[1].toLowerCase();
  return 'png';
}

/** 图片文件落地名（可含分组子目录，返回相对路径如 2026/xxx.jpg）
 *  o.template: datetime(默认) | noteid | date | orig
 *  o.groupBy: none(默认) | year | month
 */
export function imageFileName(note, file, idx, o = {}) {
  const d = new Date(note.createdAt);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const yyyy = d.getFullYear(), MM = p(d.getMonth() + 1), dd = p(d.getDate());
  const ts = `${yyyy}${MM}${dd}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const ext = extFor(file);
  let base;
  switch (o.template) {
    case 'noteid':
      base = `${note.id}_${idx + 1}`;
      break;
    case 'date':
      base = `${yyyy}${MM}${dd}_${idx + 1}`;
      break;
    case 'orig': {
      const raw = String(file.name || '').trim().replace(/\.[^.]+$/, '');
      base = raw ? raw : `${note.id}_${idx + 1}`;
      break;
    }
    default:
      base = `${ts}_${note.id}_${idx + 1}`;
  }
  const name = sanitizeFilename(`${base}.${ext}`);
  let group = '';
  if (o.groupBy === 'year') group = `${yyyy}/`;
  else if (o.groupBy === 'month') group = `${yyyy}-${MM}/`;
  return group + name;
}

/** 文件是否通过内容过滤（formats 为扩展名小写数组；空 = 不限） */
export function filePasses(file, f = {}) {
  if (!file || typeof file.type !== 'string' || !file.type.startsWith('image/')) return false;
  if (f.formats && f.formats.length && !f.formats.includes(extFor(file))) return false;
  if (f.skipSensitive && file.isSensitive) return false;
  const w = (file.properties && file.properties.width) || 0;
  const h = (file.properties && file.properties.height) || 0;
  if (f.minW > 0 && w > 0 && w < f.minW) return false;
  if (f.minH > 0 && h > 0 && h < f.minH) return false;
  if (f.minKB > 0 && file.size > 0 && file.size < f.minKB * 1024) return false;
  return true;
}

/** 笔记里通过过滤的图片列表 */
export function noteImages(note, f = {}) {
  return (note.files || []).filter((x) => filePasses(x, f));
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/** 短哈希（FNV-1a → base36 6 位），用于头像/表情的稳定文件名 */
export function hash6(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).padStart(6, '0').slice(-6);
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 解析用户输入：@user / @user@host / https://misskey.io/@user... / user */
export function parseUserInput(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  const m = /^https?:\/\/[^/]+\/@([A-Za-z0-9_.\-]+)(@[A-Za-z0-9_.\-]+)?/.exec(s);
  if (m) return { username: m[1], host: m[2] ? m[2].slice(1) : null };
  const m2 = /^@?([A-Za-z0-9_.\-]+)(@[A-Za-z0-9_.\-]+)?$/.exec(s);
  if (m2) return { username: m2[1], host: m2[2] ? m2[2].slice(1) : null };
  return null;
}

/** 笔记裁剪：只保留档案需要的字段，控制存储体积 */
export function trimNote(note) {
  const files = (note.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    url: f.url,
    thumbnailUrl: f.thumbnailUrl,
    isSensitive: !!f.isSensitive,
    blurhash: f.blurhash || null,
    comment: f.comment || null,
    size: f.size || null,
    md5: f.md5,
    properties: f.properties || null,
  }));
  return {
    id: note.id,
    createdAt: note.createdAt,
    text: note.text ?? '',
    cw: note.cw ?? null,
    visibility: note.visibility,
    replyId: note.replyId ?? null,
    renoteId: note.renoteId ?? null,
    reactions: note.reactions || {},
    reactionEmojis: note.reactionEmojis || {},
    reactionCount: note.reactionCount ?? null,
    renoteCount: note.renoteCount ?? null,
    user: note.user
      ? {
          username: note.user.username,
          host: note.user.host ?? null,
          name: note.user.name ?? null,
          avatarUrl: note.user.avatarUrl ?? null,
          emojis: note.user.emojis || {},
        }
      : null,
    renote: note.renote
      ? {
          id: note.renote.id,
          createdAt: note.renote.createdAt,
          text: note.renote.text ?? '',
          user: note.renote.user
            ? { username: note.renote.user.username, host: note.renote.user.host ?? null, name: note.renote.user.name ?? null }
            : null,
        }
      : null,
    files,
  };
}

