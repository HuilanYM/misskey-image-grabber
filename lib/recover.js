// 磁盘考古：根据磁盘上已下载的档案（_data/data.json + images/）反推下载记录
// 纯函数核心，无 chrome 依赖，可在 Node 中测试

/**
 * 从一份 data.json 载荷构建恢复记录
 * @param payload data.json 解析后的对象 {user, files:[{localName,fileId,noteId}], notes:[...]}
 * @param exists (localName) => boolean  磁盘上 images/<localName> 是否真实存在
 * @returns 恢复记录（可直接并入 importHistoryData 的 users 列表），无有效内容时返回 null
 */
export function recoverUserFromPayload(payload, exists) {
  const u = (payload && payload.user) || {};
  if (!u.id) return null;
  const files = {};
  let total = 0;
  let present = 0;
  for (const f of payload.files || []) {
    if (!f || !f.fileId) continue;
    total++;
    if (typeof exists === 'function' && exists(f.localName)) {
      files[f.fileId] = { n: f.localName || '', t: Date.now() };
      present++;
    }
  }
  if (!present) return null;
  return {
    userId: u.id,
    username: u.username ?? '?',
    host: u.host ?? null,
    name: u.name ?? null,
    avatarUrl: u.avatarUrl ?? null,
    lastAt: Date.now(),
    files,
    archNotes: Array.isArray(payload.notes) ? payload.notes : [],
    stat: { total, present },
  };
}
