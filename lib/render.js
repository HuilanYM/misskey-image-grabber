// archive.html 离线档案生成器：纯字符串生成，无 chrome 依赖，可在 Node 中测试
// 支持两种模式：folder（图片放 images/ 相对路径）/ single（base64 内嵌单文件）

import { escapeHtml, imageFileName, filePasses } from './util.js';
import { t as tt, normalizeLang } from './i18n.js';

let _lang = 'zh-CN';
const A = (k, vars) => tt(_lang, k, vars);

/** 枚举全部图片文件（按笔记分组、笔记内有序、跨笔记按 fileId 去重、按过滤设置筛选）
 *  opts: { formats, skipSensitive, minW, minH, minKB, template, groupBy }
 */
export function collectFiles(notes, opts = {}) {
  const seen = new Set();
  const usedNames = new Set();
  const items = [];
  for (const note of notes) {
    let idx = 0;
    for (const file of note.files || []) {
      if (!filePasses(file, opts)) continue;
      idx++;
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      let localName = imageFileName(note, file, idx - 1, opts);
      if (usedNames.has(localName)) localName = imageFileName(note, file, idx - 1, { ...opts, template: 'datetime' });
      usedNames.add(localName);
      items.push({ note, file, idx: idx - 1, localName });
    }
  }
  return items;
}

// ---------- 正文渲染（MFM 子集，全部先转义防注入） ----------

function emojiImgTag(name, host, emojiRef) {
  const info = emojiRef ? emojiRef(name, host) : null;
  const alt = ':' + name + (host && host !== '.' ? '@' + host : '') + ':';
  if (info && info.ref) {
    return '<img class="emoji" src="' + info.ref + '" alt="' + escapeHtml(alt) + '" title="' + escapeHtml(alt) + '" loading="lazy">';
  }
  if (info && info.remote) {
    // 本地无缓存时在线回退（onerror 再降级为文字）
    return (
      '<img class="emoji" src="' + escapeHtml(info.ref || '') + '" data-remote="' + escapeHtml(info.remote) +
      '" alt="' + escapeHtml(alt) + '" title="' + escapeHtml(alt) + '" loading="lazy" onerror="this.onerror=null;this.src=this.dataset.remote">'
    );
  }
  return '<span class="emoji-fallback">' + escapeHtml(alt) + '</span>';
}

const TOKEN_RE = new RegExp(
  [
    '(https?:\\/\\/[^\\s<>"\']+)', // 1 URL
    '(:([A-Za-z0-9_+\\-.]+)(@[A-Za-z0-9_\\-.]+)?:)', // 2 全表情 :name@host: / :name:
    '(@([A-Za-z0-9_\\-.]+)(@[A-Za-z0-9_\\-.]+)?)', // 5 提及
    '(\\*\\*[^*\\n]+\\*\\*)', // 8 粗体
    '(~~[^~\\n]+~~)', // 9 删除线
    '(#[^\\s#,;:!?()\\[\\]{}<>"\']+)', // 10 话题标签（宽松，不含句点）
  ].join('|'),
  'g',
);

export function renderText(text, emojiRef) {
  const src = String(text ?? '');
  if (!src) return '';
  const lines = src.split('\n');
  const outLines = lines.map((lineEsc) => {
    const escaped = escapeHtml(lineEsc);
    if (/^&gt;\s?/.test(escaped)) {
      return '<span class="quote-line">' + renderInline(escaped.replace(/^&gt;\s?/, ''), emojiRef) + '</span>';
    }
    return renderInline(escaped, emojiRef);
  });
  return outLines.join('<br>');
}

function renderInline(escaped, emojiRef) {
  return escaped.replace(TOKEN_RE, (m, url, emojiFull, eName, eHost, mention, mName, mHost, bold, strike, tag) => {
    if (url) {
      const href = url.replace(/&amp;/g, '&');
      const label = url.length > 60 ? url.slice(0, 57) + '…' : url;
      return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    }
    if (emojiFull) {
      return emojiImgTag(eName, (eHost || '').replace('@', '') || '.', emojiRef);
    }
    if (mention) {
      const host = (mHost || '').replace('@', '');
      const h = host && host !== '.' ? '@' + host : '';
      return (
        '<a class="mention" href="https://misskey.io/@' + escapeHtml(mName) + escapeHtml(h) + '">@' + escapeHtml(mName) + '</a>'
      );
    }
    if (bold) return '<strong>' + bold.slice(2, -2) + '</strong>';
    if (strike) return '<del>' + strike.slice(2, -2) + '</del>';
    if (tag) {
      const t = tag.slice(1);
      return '<a class="hashtag" href="https://misskey.io/tags/' + encodeURIComponent(t) + '">#' + escapeHtml(t) + '</a>';
    }
    return m;
  });
}

// ---------- 反应渲染 ----------

function renderReactions(note, emojiRef) {
  const r = note.reactions || {};
  const entries = Object.entries(r).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  const top = entries.slice(0, 12);
  const total = entries.reduce((s, e) => s + e[1], 0);
  const parts = top.map(([key, count]) => {
    let inner;
    if (key.startsWith(':')) {
      const m = /^:([A-Za-z0-9_+\-.]+)(?:@([A-Za-z0-9_\-.]+))?:$/.exec(key);
      inner = m ? emojiImgTag(m[1], m[2] || '.', emojiRef) : escapeHtml(key);
    } else {
      inner = '<span class="rx-char">' + escapeHtml(key) + '</span>';
    }
    return '<span class="rx">' + inner + '<i>' + count + '</i></span>';
  });
  const more = entries.length > 12 ? '<span class="rx-more">+' + (entries.length - 12) + '</span>' : '';
  return '<div class="reactions" title="' + escapeHtml(A('aReactionsTitle', { n: total })) + '">' + parts.join('') + more + '</div>';
}

// ---------- 单条笔记卡片 ----------

function noteCard(note, refFor, emojiRef, revealSens = false) {
  const imgs = (note.files || []).filter((f) => f && f.type && f.type.startsWith('image/'));
  const u = note.user || {};
  const handle = '@' + u.username + (u.host ? '@' + u.host : '');
  const noteUrl = 'https://misskey.io/notes/' + note.id;
  const displayName =
    '<span class="name">' + renderText(u.name != null ? u.name : u.username, emojiRef) + '</span>';
  const avatar = u.avatarUrl
    ? '<img class="avatar" src="' + escapeHtml(u.avatarUrl) + '" alt="" loading="lazy">'
    : '<div class="avatar avatar-ph"></div>';
  // 注意：档案模式下头像引用本地文件由 refFor('avatar') 全局替换；这里先用远程 URL，构建时统一改写

  const badges =
    (note.replyId ? '<span class="badge" title="回复">回复</span>' : '') +
    (note.renoteId && note.text ? '<span class="badge" title="引用转贴">引用</span>' : '') +
    (note.localOnly ? '<span class="badge" title="仅本实例">本地</span>' : '');

  const quote = note.renote && note.renote.user
    ? '<blockquote class="quote"><span class="q-user">' +
      escapeHtml(note.renote.user.name || '@' + note.renote.user.username) +
      '</span>' +
      renderText(note.renote.text, emojiRef) +
      '</blockquote>'
    : '';

  const gridClass = imgs.length === 1 ? 'grid g1' : imgs.length === 2 ? 'grid g2' : imgs.length <= 4 ? 'grid g2' : 'grid g3';
  const grid = imgs.length
    ? '<div class="' + gridClass + '">' +
      imgs
        .map((f) => {
          const ref = refFor(note, f);
          const w = f.properties && f.properties.width, h = f.properties && f.properties.height;
          const ratio = w && h ? w / h : 1.5;
          const sens = f.isSensitive;
          return (
            '<div class="img' + (sens ? ' sens' : '') + (sens && revealSens ? ' revealed' : '') + '" style="aspect-ratio:' + Math.max(0.3, Math.min(ratio, 3)).toFixed(3) +
            (sens ? '" data-sens="1' : '') +
            '"><img src="' + escapeHtml(ref) + '" alt="' + escapeHtml(f.comment || f.name || '') + '" loading="lazy" decoding="async"></div>'
          );
        })
        .join('') +
      '</div>'
    : '';

  const textHtml = note.text ? '<div class="text">' + renderText(note.text, emojiRef) + '</div>' : '';
  const cwHtml = note.cw
    ? '<details class="cw"><summary>' + renderText(note.cw, emojiRef) + '<span class="cw-hint">' + escapeHtml(A('aCwHint')) + '</span></summary>' + textHtml + grid + '</details>'
    : textHtml + grid;

  const search = ((note.cw || '') + ' ' + (note.text || '')).toLowerCase();

  return (
    '<article class="note" id="n-' + escapeHtml(note.id) + '" data-t="' + escapeHtml(search).replace(/"/g, '&quot;') + '">' +
    avatar +
    '<div class="nbody">' +
    '<div class="nhead">' +
    displayName +
    '<span class="handle">' + escapeHtml(handle) + '</span>' +
    badges +
    '<span class="time"><time datetime="' + escapeHtml(note.createdAt) + '" title="' + escapeHtml(note.createdAt) + '">' + escapeHtml(note.createdAt.slice(0, 16).replace('T', ' ')) + '</time></span>' +
    '<a class="origin" href="' + noteUrl + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(A('aOrigin')) + '</a>' +
    '</div>' +
    cwHtml +
    quote +
    renderReactions(note, emojiRef) +
    '</div></article>'
  );
}

// ---------- 档案页整体 ----------

export function buildArchiveHtml({ user, notes, meta, refFor, avatarRef, emojiRef, collectOpts = {}, order = 'newfirst', revealSens = false, lang = 'zh-CN' }) {
  const L = normalizeLang(lang);
  _lang = L;
  const u = user || {};
  const notesIn = order === 'oldfirst' ? [...notes].reverse() : notes;
  const items = collectFiles(notesIn, collectOpts);
  const handle = '@' + (u.username || '?') + (u.host ? '@' + u.host : '');
  const first = notes.length ? notes[notes.length - 1].createdAt : '';
  const last = notes.length ? notes[0].createdAt : '';
  let bodyNotes = notesIn.map((n) => noteCard(n, refFor, emojiRef, revealSens)).join('\n');
  // 头像离线化：所有笔记作者即目标用户，统一替换为本地头像文件
  if (avatarRef && u.avatarUrl) {
    bodyNotes = bodyNotes.split(escapeHtml(u.avatarUrl)).join(avatarRef);
  }
  const avatarImg = avatarRef
    ? '<img class="pavatar" src="' + escapeHtml(avatarRef) + '" alt="">'
    : '<div class="pavatar avatar-ph"></div>';

  // 描述里的链接/表情也渲染
  const descHtml = u.description ? '<div class="pdesc">' + renderText(u.description, emojiRef) + '</div>' : '';

  return `<!doctype html>
<html lang="${L}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml((u.name || u.username || 'Misskey') + A('aTitleSuffix'))}</title>
<style>
:root{--bg:#101014;--panel:#1a1a21;--panel2:#22222b;--text:#e6e6ef;--dim:#9494a6;--link:#7bc0ff;--accent:#86b300;--line:#2a2a35}
html[data-theme=light]{--bg:#f4f4f7;--panel:#fff;--panel2:#ececf2;--text:#222;--dim:#77778c;--link:#2a6dcf;--line:#e0e0e8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:16px 12px 80px}
header.profile{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;margin:12px 0}
.prow{display:flex;gap:14px;align-items:center}
.pavatar{width:72px;height:72px;border-radius:50%;background:var(--panel2);object-fit:cover;flex:none}
.avatar-ph{display:inline-block}
.pname{font-size:19px;font-weight:700}
.phandle{color:var(--dim);font-size:13px}
.pstats{display:flex;gap:18px;margin-top:10px;color:var(--dim);font-size:13px;flex-wrap:wrap}
.pstats b{color:var(--text)}
.pdesc{margin-top:10px;font-size:13.5px;color:var(--text);word-break:break-word}
.pmeta{margin-top:10px;padding-top:10px;border-top:1px dashed var(--line);color:var(--dim);font-size:12px}
.toolbar{position:sticky;top:0;z-index:30;background:var(--bg);padding:10px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--line)}
.toolbar input[type=search]{flex:1;min-width:160px;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 12px;font-size:14px;outline:none}
.toolbar input[type=search]:focus{border-color:var(--accent)}
.toolbar button{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:7px 12px;cursor:pointer;font-size:13px}
.toolbar button:hover{border-color:var(--accent)}
/* 线性 SVG 图标（currentColor 随文字/主题变色）；主题钮双态：深色显太阳、浅色显月亮 */
.ic{width:16px;height:16px;flex:none;vertical-align:-3px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.toolbar button,.mp-btn,.tp-btn{display:inline-flex;align-items:center;gap:6px}
.mp-title,.tp-title{display:flex;align-items:center;gap:6px}
.lb-cap a{display:inline-flex;align-items:center;gap:5px}
#themeBtn .ic-moon{display:none}
html[data-theme=light] #themeBtn .ic-sun{display:none}
html[data-theme=light] #themeBtn .ic-moon{display:inline-block}
.ic-warn{color:#ffd23e}
#mediaTab .ic,#timeTab .ic{display:inline-block;vertical-align:top;margin-bottom:6px}
.lb-close .ic{width:22px;height:22px;display:block}
.toTop .ic{width:20px;height:20px;display:block;margin:0 auto}
.lb-cap a .ic{width:14px;height:14px;vertical-align:0}
.count{color:var(--dim);font-size:12.5px;padding:0 4px}
.note{display:flex;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin:10px 0;content-visibility:auto;contain-intrinsic-size:auto 340px}
.note.hide{display:none}
.note.flash{outline:3px solid var(--accent);outline-offset:3px;transition:outline-color .2s}
.avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;flex:none;background:var(--panel2)}
.nbody{flex:1;min-width:0}
.nhead{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.name{font-weight:700}
.name:empty::before{content:${JSON.stringify(A('aNoName'))}}
.handle{color:var(--dim);font-size:12.5px}
.badge{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 5px;line-height:18px}
.time{margin-left:auto;color:var(--dim);font-size:12px;white-space:nowrap}
.origin{color:var(--dim);font-size:12px;text-decoration:none;border:1px solid var(--line);border-radius:4px;padding:0 5px}
.origin:hover{color:var(--link);border-color:var(--link)}
.text{margin-top:4px;word-break:break-word;white-space:normal}
a{color:var(--link)}
.mention{background:var(--panel2);border-radius:4px;padding:0 3px;text-decoration:none}
.hashtag{background:var(--panel2);border-radius:4px;padding:0 3px;text-decoration:none}
.quote-line{display:block;border-left:3px solid var(--line);padding-left:8px;color:var(--dim)}
.emoji{height:1.6em;vertical-align:-0.35em;max-width:60px}
.emoji-fallback{color:var(--dim)}
.cw{margin-top:4px}
.cw summary{cursor:pointer;color:var(--accent);font-weight:600}
.cw-hint{color:var(--dim);font-weight:400;font-size:12px}
.grid{margin-top:8px;display:grid;gap:6px}
.g1{grid-template-columns:1fr}
.g2{grid-template-columns:1fr 1fr}
.g3{grid-template-columns:1fr 1fr 1fr}
.grid .img{display:block;overflow:hidden;border-radius:8px;background:var(--panel2);position:relative}
.grid .img img{width:100%;height:100%;object-fit:cover;display:block}
.g1 .img{max-height:560px}
.g1 .img img{max-height:560px;object-fit:contain}
.grid .img.sens:not(.revealed) img{filter:blur(16px) saturate(1.05) brightness(.82);transform:scale(1.12)}
.grid .img.sens::after{content:"${escapeHtml(A('aImgOverlay'))}";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(8,8,12,.22);color:#fff;font-size:13px;cursor:pointer;text-shadow:0 1px 4px rgba(0,0,0,.85)}
.grid .img.sens.revealed::after{display:none}
.grid .img.sens.revealed img{filter:none;transform:none}
.mthumb.sens img{filter:blur(10px) saturate(1.05) brightness(.8);transform:scale(1.12)}
.mthumb.sens::after{content:"${escapeHtml(A('aMthumbBadge'))}";position:absolute;top:8px;right:8px;font-size:11px;background:rgba(0,0,0,.72);color:#ffd23e;border-radius:6px;padding:2px 7px}
.mthumb.sens.revealed img{filter:none;transform:none}
.mthumb.sens.revealed::after{display:none}
body.rail-unmask .mthumb.sens img{filter:none;transform:none}
body.rail-unmask .mthumb.sens::after{display:none}
.quote{margin-top:8px;border-left:3px solid var(--line);padding:6px 10px;color:var(--dim);font-size:13px}
.q-user{font-weight:700;margin-right:6px;color:var(--text)}
.reactions{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.rx{display:inline-flex;align-items:center;gap:4px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:2px 7px;font-size:12px}
.rx i{font-style:normal;color:var(--dim)}
.rx-char{font-size:14px}
.rx-more{color:var(--dim);font-size:12px;align-self:center}
.lightbox{position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:100;display:none;align-items:center;justify-content:center}
.lightbox.on{display:flex}
.lightbox #lbImg{max-width:94vw;max-height:86vh;object-fit:contain;border-radius:4px}
.lightbox .lb-cap{position:absolute;top:14px;left:50%;transform:translateX(-50%);color:#c9c9d4;font-size:13px;text-align:center;padding:6px 14px;background:rgba(10,10,14,.55);border-radius:999px;white-space:nowrap;z-index:3}
.lightbox .lb-cap a{color:#9fe870;cursor:pointer;text-decoration:underline;margin-left:10px}
.lightbox .lb-btn{position:fixed;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.1);border:none;color:#fff;font-size:28px;padding:16px 14px;cursor:pointer;border-radius:8px}
.lightbox .prev{left:12px}.lightbox .next{right:12px}
.lightbox .lb-close{position:fixed;top:12px;right:16px;background:none;border:none;color:#fff;font-size:26px;cursor:pointer;z-index:3}
/* 胶片条：隐藏式抽屉（默认只露拉手，悬停/点击滑出） */
.lb-stripzone{position:absolute;left:0;right:0;bottom:0;transform:translateY(calc(100% - 22px));transition:transform .22s ease;background:rgba(10,10,14,.78);z-index:2}
.lb-stripzone:hover,.lb-stripzone.pinned{transform:none}
.lb-strip-handle{display:block;width:100%;background:none;border:none;color:var(--dim);font-size:11px;letter-spacing:2px;padding:4px 0;cursor:pointer;font-family:inherit}
.lb-stripzone:hover .lb-strip-handle,.lb-stripzone.pinned .lb-strip-handle{color:var(--text)}
.lb-strip{display:flex;gap:6px;overflow-x:auto;max-width:100%;padding:2px 12px 10px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.28) transparent}
.lb-strip::-webkit-scrollbar{height:10px}
.lb-strip::-webkit-scrollbar-track{background:rgba(255,255,255,.05);border-radius:6px}
.lb-strip::-webkit-scrollbar-thumb{background:rgba(255,255,255,.26);border-radius:6px}
.lb-strip::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.45)}
.lb-strip .lbt{flex:0 0 auto;width:64px;height:48px;padding:0;border:2px solid transparent;border-radius:6px;overflow:hidden;cursor:pointer;background:var(--panel2)}
.lb-strip .lbt img{width:100%;height:100%;object-fit:cover;display:block}
.lb-strip .lbt:hover{border-color:var(--dim)}
.lb-strip .lbt.on{border-color:var(--accent)}
.lb-strip .lbt.sens img{filter:brightness(.25)}
body.rail-unmask .lb-strip .lbt.sens img{filter:none}
.toTop{position:fixed;right:18px;bottom:18px;width:42px;height:42px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);color:var(--text);font-size:18px;cursor:pointer;display:none;z-index:40}
.toTop.on{display:block}
/* 媒体抽屉（X 资料页 Media 标签 + Instagram Explore 式大图网格；默认收起，阅读满宽）
   宽度=正文(720px 居中)单侧空白带的宽度，展开时刚好只盖住空白、不压正文；
   窄屏(≤900px)仍整幅覆盖；中等宽度下限 300px 保证缩略图可用（会略压正文） */
#mediaPanel{position:fixed;top:0;right:0;bottom:0;width:clamp(300px,calc((100% - 720px)/2),720px);background:var(--panel);border-left:1px solid var(--line);z-index:50;display:flex;flex-direction:column;transform:translateX(102%);transition:transform .25s ease;box-shadow:-16px 0 40px rgba(0,0,0,.4)}
body.media-open #mediaPanel{transform:none}
.mp-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}
.mp-title{font-weight:700;font-size:14px;flex:1}
.mp-title small{color:var(--dim);font-weight:400;margin-left:6px}
.mp-btn{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 10px;font-size:12.5px;cursor:pointer;white-space:nowrap}
.mp-btn:hover{border-color:var(--accent)}
.mp-btn.off{opacity:.45}
#mediaGrid{flex:1;overflow-y:auto;padding:12px;display:flex;gap:10px;align-items:flex-start;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.22) transparent}
#mediaGrid::-webkit-scrollbar{width:14px}
#mediaGrid::-webkit-scrollbar-track{background:transparent}
#mediaGrid::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border:4px solid transparent;background-clip:padding-box;border-radius:8px}
#mediaGrid::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.34);background-clip:padding-box}
.mcol{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:10px}
.mthumb{padding:0;border:none;background:var(--panel2);overflow:hidden;cursor:pointer;position:relative;display:block;width:100%;font:inherit;border-radius:10px}
.mthumb img{display:block;width:100%;height:auto}
.mthumb:hover img{opacity:.85}
.mthumb.on{outline:3px solid var(--accent);outline-offset:-3px}
.mthumb.sens::after{content:"${escapeHtml(A('aMthumbBadge'))}";position:absolute;top:8px;right:8px;font-size:11px;background:rgba(0,0,0,.72);color:#ffd23e;border-radius:6px;padding:2px 7px}
.mthumb .mtime{position:absolute;left:8px;bottom:8px;font-size:11px;color:#fff;background:rgba(0,0,0,.6);border-radius:6px;padding:2px 7px;opacity:0;transition:opacity .15s}
.mthumb:hover .mtime{opacity:1}
body.rail-unmask .mthumb.sens img{filter:none}
body.rail-unmask .mthumb.sens::after{display:none}
#mediaTab{position:fixed;top:64px;right:0;z-index:45;writing-mode:vertical-rl;letter-spacing:3px;background:var(--panel);border:1px solid var(--line);border-right:none;color:var(--text);border-radius:10px 0 0 10px;padding:16px 7px;cursor:pointer;font-size:13px;font-family:inherit}
#mediaTab:hover{color:var(--accent);border-color:var(--accent)}
body.media-open #mediaTab{display:none}
@media (max-width:900px){#mediaPanel{width:min(100vw,480px)}}
/* 时间导航（左）：月历 + 底部活跃度轴收纳于同一个左侧面板（与右侧图片栏完全对称），
   面板宽度=正文单侧空白带、展开不压正文；关闭时页面只剩左缘竖标签，零杂物 */
#timeTab{position:fixed;top:64px;left:0;z-index:45;writing-mode:vertical-rl;letter-spacing:3px;background:var(--panel);border:1px solid var(--line);border-left:none;color:var(--text);border-radius:0 10px 10px 0;padding:16px 7px;cursor:pointer;font-size:13px;font-family:inherit}
#timeTab:hover{color:var(--accent);border-color:var(--accent)}
body.time-open #timeTab{display:none}
#timePanel{position:fixed;top:0;left:0;bottom:0;width:clamp(300px,calc((100% - 720px)/2),720px);background:var(--panel);border-right:1px solid var(--line);z-index:50;display:flex;flex-direction:column;transform:translateX(-102%);transition:transform .25s ease;box-shadow:16px 0 40px rgba(0,0,0,.4);overflow-y:auto}
body.time-open #timePanel{transform:none}
.tp-head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line)}
.tp-title{font-weight:700;font-size:14px;flex:1}
.tp-btn{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 10px;font-size:12.5px;cursor:pointer;white-space:nowrap;font-family:inherit}
.tp-btn:hover:not(:disabled){border-color:var(--accent)}
.tp-btn:disabled{opacity:.4;cursor:default}
.tp-years{display:flex;gap:6px;flex-wrap:wrap;padding:10px 14px 0}
.tp-years .tp-btn.on{border-color:var(--accent);color:var(--accent)}
.tp-nav{display:flex;align-items:center;justify-content:space-between;padding:10px 14px}
.tp-nav .tp-mlabel{font-weight:700;font-size:15px}
.tp-week,.tp-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;padding:0 14px}
.tp-week span{text-align:center;color:var(--dim);font-size:11px;padding:2px 0}
.tp-grid{padding-bottom:12px}
.tp-day{position:relative;aspect-ratio:1;border-radius:8px;font-size:12px;color:var(--text);display:flex;align-items:flex-start;justify-content:flex-end;padding:4px 5px;background:var(--panel2);border:1px solid transparent;font-family:inherit}
.tp-day:disabled{cursor:default;opacity:.55}
.tp-day .cnt{position:absolute;left:4px;bottom:3px;font-size:10px;color:var(--accent);font-weight:700;font-style:normal}
.tp-day.out{opacity:.28}
.tp-day.on{cursor:pointer;border-color:var(--line)}
.tp-day.on:hover{border-color:var(--accent)}
/* 面板底部横轴：密度柱从底部长出、年份刻度、当前视口光标；拖动 scrub + 浮动日期气泡 */
.tp-axiswrap{margin-top:auto;padding:10px 14px 14px;border-top:1px solid var(--line)}
.tp-axis{position:relative;height:48px;cursor:ew-resize;touch-action:none;border-radius:6px;background:var(--panel2);overflow:hidden}
.tp-axis .ax-col{position:absolute;bottom:0;background:var(--dim);opacity:.4;border-radius:2px 2px 0 0}
.tp-axis:hover .ax-col,.tp-axis.drag .ax-col{background:var(--accent);opacity:.85}
.tp-axis .ax-cursor{position:absolute;top:0;bottom:0;width:2px;background:var(--accent);opacity:0;pointer-events:none;box-shadow:0 0 4px var(--accent)}
.tp-axis.drag .ax-cursor{opacity:.95}
/* 年份标签独立成行放在轴下方（不与密度柱重叠），可点击跳到该年；当前所在年份高亮 */
.ax-yearrow{position:relative;height:18px;margin-top:3px}
.ax-yearrow .ax-year{position:absolute;top:0;padding:0 3px;background:none;border:none;color:var(--dim);font-size:10.5px;line-height:18px;cursor:pointer;font-family:inherit;transform:translateX(-50%);white-space:nowrap}
.ax-yearrow .ax-year:hover{color:var(--accent)}
.ax-yearrow .ax-year.on{color:var(--accent);font-weight:700}
#scrubBubble{position:fixed;z-index:60;display:none;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:3px 10px;font-size:12.5px;pointer-events:none;white-space:nowrap;transform:translate(-50%,-130%);box-shadow:0 2px 10px rgba(0,0,0,.35)}
#monthChip{position:fixed;left:16px;bottom:16px;z-index:36;display:none;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:999px;padding:4px 13px;font-size:12.5px;cursor:pointer;font-family:inherit;box-shadow:0 2px 10px rgba(0,0,0,.25)}
#monthChip.on{display:block}
#monthChip:hover{border-color:var(--accent)}
@media (max-width:900px){#timePanel{width:min(100vw,480px)}#timeTab,#monthChip,#monthChip.on,#scrubBubble{display:none}}
footer{color:var(--dim);font-size:12px;text-align:center;margin-top:24px;line-height:1.8}
</style>
</head>
<body>
<svg style="display:none" aria-hidden="true"><defs>
  <symbol id="i-image" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="9.8" r="1.6"/><path d="M20.5 15.2l-4.1-4.1a1.6 1.6 0 0 0-2.3 0L7 18.2"/></symbol>
  <symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/><path d="M8 14.2h.01M12 14.2h.01M16 14.2h.01M8 17.4h.01M12 17.4h.01"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><path d="M10.3 4.9a2 2 0 0 1 3.4 0l7 12.1a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3l7-12.1z"/><path d="M12 9.5v4.2"/><path d="M12 16.9h.01"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></symbol>
  <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.8V5M12 19v2.2M2.8 12H5M19 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/></symbol>
  <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20.6 13.4A8.6 8.6 0 1 1 10.6 3.4a6.8 6.8 0 0 0 10 10z"/></symbol>
  <symbol id="i-up" viewBox="0 0 24 24"><path d="M12 20V4.5M5.5 11L12 4.5 18.5 11"/></symbol>
  <symbol id="i-pin" viewBox="0 0 24 24"><path d="M12 21.2s-6.6-5.6-6.6-10.4a6.6 6.6 0 0 1 13.2 0C18.6 15.6 12 21.2 12 21.2z"/><circle cx="12" cy="10.6" r="2.3"/></symbol>
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20.5 20.5-4.9-4.9"/></symbol>
</defs></svg>
<div class="wrap">
<header class="profile">
  <div class="prow">${avatarImg}
    <div><div class="pname">${renderText(u.name || u.username || '', emojiRef)}</div>
    <div class="phandle">${escapeHtml(handle)}${u.isBot ? ' · 🤖bot' : ''}</div></div>
  </div>
  ${descHtml}
  <div class="pstats">
    <span>${escapeHtml(A('aStNotes'))} <b>${(u.notesCount ?? '?')}</b></span>
    <span>${escapeHtml(A('aStGrabbed'))} <b>${notes.length}</b></span>
    <span>${escapeHtml(A('aStImgs'))} <b>${items.length}</b></span>
    <span>${escapeHtml(A('aStRange'))} <b>${escapeHtml(first.slice(0, 10) || '-')} ~ ${escapeHtml(last.slice(0, 10) || '-')}</b></span>
  </div>
  <div class="pmeta">${escapeHtml(A('aCrawledAt'))} ${escapeHtml(meta.crawlAt)} · Misskey Image Grabber 自离线生成 · 可直接双击打开，无需联网${meta.note ? ' · ' + escapeHtml(meta.note) : ''}</div>
</header>
<div class="toolbar">
  <input id="q" type="search" placeholder="${escapeHtml(A('aSearchPh'))}" autofocus>
  <button id="mediaBtn" title="${escapeHtml(A('aMpTitle'))}"><svg class="ic"><use href="#i-image"/></svg><span id="mediaBtnCnt"></span></button>
  <button id="sensBtn" title="${escapeHtml(A('aSensBtn'))}">${escapeHtml(A('aSensBtn'))}</button>
  <button id="themeBtn" title="${escapeHtml(A('aThemeTitle'))}"><svg class="ic ic-sun"><use href="#i-sun"/></svg><svg class="ic ic-moon"><use href="#i-moon"/></svg></button>
  <span class="count" id="count"></span>
</div>
<main id="tl">${bodyNotes}</main>
<footer>${escapeHtml(A("aFooter"))}</footer>
</div>
<div class="lightbox" id="lb"><button class="lb-close" title="关闭 (Esc)"><svg class="ic"><use href="#i-x"/></svg></button><div class="lb-cap" id="lbCap"></div><button class="lb-btn prev" title="←">‹</button><img id="lbImg" alt=""><button class="lb-btn next" title="→">›</button><div class="lb-stripzone" id="lbStripZone"><button class="lb-strip-handle" id="lbStripHandle" type="button" title="点击固定/收起，鼠标悬停滑出">${escapeHtml(A('aStripHandle'))}</button><div class="lb-strip" id="lbStrip"></div></div></div>
<button class="toTop" id="toTop" title="回到顶部"><svg class="ic"><use href="#i-up"/></svg></button>
<aside id="mediaPanel" aria-label="${escapeHtml(A('aMpTitle'))}">
  <div class="mp-head">
    <div class="mp-title"><svg class="ic"><use href="#i-image"/></svg>${escapeHtml(A('aMpTitle'))}<small id="mpCount"></small></div>
    <button class="mp-btn" id="mpSens" type="button" title="${escapeHtml(A('aMpSens'))}"><svg class="ic ic-warn"><use href="#i-alert"/></svg>${escapeHtml(A('aMpSens'))}</button>
    <button class="mp-btn" id="mpClose" type="button" title="${escapeHtml(A('aMpClose'))}"><svg class="ic"><use href="#i-x"/></svg>${escapeHtml(A('aMpClose'))}</button>
  </div>
  <div id="mediaGrid"></div>
</aside>
<button id="mediaTab" type="button"><svg class="ic"><use href="#i-image"/></svg>${escapeHtml(A('aMediaTab'))}</button>
<button id="timeTab" type="button"><svg class="ic"><use href="#i-calendar"/></svg>${escapeHtml(A('aTimeTitle'))}</button>
<div id="scrubBubble"></div>
<button id="monthChip" type="button" title="${escapeHtml(A('aCurMonthTitle'))}"></button>
<aside id="timePanel" aria-label="${escapeHtml(A('aTimeTitle'))}">
  <div class="tp-head"><div class="tp-title"><svg class="ic"><use href="#i-calendar"/></svg>${escapeHtml(A('aTimeTitle'))}</div><button class="tp-btn" id="tpClose" type="button" title="${escapeHtml(A('aMpClose'))}"><svg class="ic"><use href="#i-x"/></svg>${escapeHtml(A('aMpClose'))}</button></div>
  <div class="tp-years" id="tpYears"></div>
  <div class="tp-nav"><button class="tp-btn" id="tpPrev" type="button">‹</button><span class="tp-mlabel" id="tpLabel"></span><button class="tp-btn" id="tpNext" type="button">›</button></div>
  <div class="tp-week" id="tpWeek"></div>
  <div class="tp-grid" id="tpGrid"></div>
  <div class="tp-axiswrap"><div class="tp-axis" id="tpAxis" aria-label="${escapeHtml(A('aRailHint'))}"><div class="ax-cursor"></div></div><div class="ax-yearrow" id="tpYearRow"></div></div>
</aside>
<script>
(function(){
  var L = '${normalizeLang(lang)}';
  // 时间本地化
  document.querySelectorAll('time[datetime]').forEach(function(t){
    try{ t.textContent = new Date(t.getAttribute('datetime')).toLocaleString(L === 'en' ? 'en-US' : L); }catch(e){}
  });
  // 搜索过滤：索引建好后移除 data-t 属性（正文不再在 DOM 里存第二份，长档案省内存）
  var q = document.getElementById('q'), notes = Array.prototype.slice.call(document.querySelectorAll('.note')), count = document.getElementById('count');
  var searchIdx = notes.map(function(el){ return el.getAttribute('data-t') || ''; });
  notes.forEach(function(el){ el.removeAttribute('data-t'); });
  function applyFilter(){
    var k = q.value.trim().toLowerCase(), n = 0;
    notes.forEach(function(el, i){
      var hit = !k || searchIdx[i].indexOf(k) >= 0;
      el.classList.toggle('hide', !hit);
      if (hit) n++;
    });
    count.textContent = n + ' / ' + notes.length + ' 条';
  }
  q.addEventListener('input', applyFilter); applyFilter();
  // 敏感遮罩（misskey.io 式：真实图 + CSS 高斯模糊，揭示即去模糊）
  function revealBox(box){ if (box) box.classList.add('revealed'); }
  var sensBtn = document.getElementById('sensBtn');
  // 单一状态：工具栏 ⚠ 与抽屉 ⚠ 共用 sensMask（rail-unmask 管抽屉/胶片条，revealed 管时间线）
  function setSens(mask){
    sensMask = mask;
    applyMedia();
    document.querySelectorAll('.img.sens').forEach(function(a){ a.classList.toggle('revealed', !mask); });
    sensBtn.style.opacity = mask ? '1' : '.5';
  }
  sensBtn.addEventListener('click', function(){ setSens(!sensMask); });
  document.addEventListener('click', function(ev){
    var a = ev.target.closest ? ev.target.closest('.img.sens') : null;
    if (a && !a.classList.contains('revealed')){ ev.preventDefault(); ev.stopImmediatePropagation(); revealBox(a); }
  }, true);
  // 灯箱（全部图片画廊）
  // 同一图片文件可能挂在多个笔记（如月度汇总），抽屉/灯箱按图片去重只显示一次，
  // 并归属到最早发布该图的笔记（首发）——位置、日期与「跳到这条笔记」都以首发为准，
  // 整个抽屉按首发时间新→旧排序，保证三者一致；时间线保持忠实展示（挂几个笔记出现几次）
  var noteTimeOf = function(im){ var t = im.closest('article.note'); return t && t.querySelector('time') ? new Date(t.querySelector('time').getAttribute('datetime')).getTime() || 0 : 0; };
  var allImgs = Array.prototype.slice.call(document.querySelectorAll('.grid .img img'));
  var imgs = [], idxBySrc = {};
  allImgs.forEach(function(im){
    var src = im.getAttribute('src');
    if (!(src in idxBySrc)) { idxBySrc[src] = imgs.length; imgs.push(im); }
    else if (noteTimeOf(im) < noteTimeOf(imgs[idxBySrc[src]])) { imgs[idxBySrc[src]] = im; }
  });
  imgs.sort(function(a, b){ return noteTimeOf(b) - noteTimeOf(a); });
  idxBySrc = {};
  imgs.forEach(function(im, k){ idxBySrc[im.getAttribute('src')] = k; });
  var lb = document.getElementById('lb'), lbImg = document.getElementById('lbImg'), lbCap = document.getElementById('lbCap'), cur = -1;
  function open(i){
    if (i < 0 || i >= imgs.length) return;
    cur = i;
    lbImg.src = imgs[i].src;
    revealBox(imgs[i].closest('.img'));
    var a = imgs[i].closest('.img');
    lbCap.textContent = '';
    lbCap.appendChild(document.createTextNode((i + 1) + ' / ' + imgs.length + (a && a.classList.contains('sens') ? ${JSON.stringify(A('aLbSensUnit'))} : '')));
    var view = document.createElement('a');
    view.innerHTML = '<svg class="ic"><use href="#i-search"/></svg>' + ${JSON.stringify(A('aViewOrg'))};
    view.href = imgs[i].getAttribute('src');
    view.target = '_blank';
    view.rel = 'noopener noreferrer';
    view.title = ${JSON.stringify(A('aViewOrgTitle'))};
    lbCap.appendChild(view);
    var jump = document.createElement('a');
    jump.innerHTML = '<svg class="ic"><use href="#i-pin"/></svg>' + ${JSON.stringify(A('aJumpNote'))};
    jump.style.marginLeft = '10px';
    jump.addEventListener('click', function(){ jumpToNote(cur); });
    lbCap.appendChild(jump);
    lb.classList.add('on');
    markThumb(i);
  }
  // 跳到某张图片所属笔记在页面中的位置（自动展开 CW 折叠、揭示敏感图并高亮）
  // 笔记卡片 content-visibility:auto 让屏外笔记按估值占位，跳转目标若按陈旧布局
  // 计算会大幅偏移，且平滑滚动动画会被途中布局变化打断（表现为要点好几次才跳得到）。
  // 方案：以实时 rect 硬滚动（window.scrollTo 数值形式必定瞬时、可打断残留动画），
  // 落点后再以 120ms 节拍看护约 1-3 秒，补偿图片/表情后加载造成的迟发布局漂移；
  // 用户一旦主动滚动（滚轮/触摸/按键）立即交还控制权
  var jumpWatch = { on: false, gen: 0, lastH: 0, lastHT: 0 };
  ['wheel', 'touchstart', 'keydown'].forEach(function(evt){
    window.addEventListener(evt, function(){ jumpWatch.on = false; }, { passive: true, capture: true });
  });
  function hardCenter(art){
    var r = art.getBoundingClientRect();
    window.scrollTo(0, Math.max(0, window.scrollY + r.top + r.height / 2 - window.innerHeight / 2));
  }
  function centerNote(art){
    var vh = window.innerHeight;
    var r = art.getBoundingClientRect();
    var dist = r.top > vh ? r.top - vh : (r.bottom < 0 ? -r.bottom : 0);
    jumpWatch.on = true;
    var myGen = ++jumpWatch.gen; // 新跳转让旧看护循环立即失效——否则连续点两个相邻日期时
    if (dist <= vh * 1.5) { // 近距离：先平滑滚一把提升手感，750ms 后转入看护校正
      art.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function(){ tickWatch(art, 0, 0, myGen); }, 750);
    } else { // 远距离：直接硬滚动，不走动画
      hardCenter(art);
      tickWatch(art, 0, 0, myGen);
    }
  }
  function tickWatch(art, bad, good, gen){
    if (!jumpWatch.on || gen !== jumpWatch.gen) return; // 已被更新的跳转取代
    var vh = window.innerHeight;
    var b = art.getBoundingClientRect();
    // 跳转落点处的笔记/图片此刻才开始真实渲染，文档总高会持续变化——
    // 高度一变就重置稳定计时，布局稳定 700ms 后才开始累积退出计数
    var h = document.documentElement.scrollHeight;
    if (h !== jumpWatch.lastH) { jumpWatch.lastH = h; jumpWatch.lastHT = Date.now(); }
    var off = Math.abs(b.top + b.height / 2 - vh / 2);
    // 文档尾部的目标无法物理居中（下方内容不足会被 clamp），「已滚动到底且目标可见」即算到达
    var atEnd = window.scrollY + vh >= document.documentElement.scrollHeight - 2;
    var inView = b.bottom > 0 && b.top < vh;
    if (!(off <= 60 || (atEnd && inView))) { hardCenter(art); bad++; good = 0; }
    else if (Date.now() - jumpWatch.lastHT > 700) good++;
    if (bad < 60 && good < 8) setTimeout(function(){ tickWatch(art, bad, good, gen); }, 120);
  }
  function jumpToNote(i){
    var img = imgs[i]; if (!img) return;
    var art = img.closest('article.note');
    var det = img.closest('details');
    if (det) det.open = true;
    revealBox(img.closest('.img'));
    lb.classList.remove('on');
    if (!art) return;
    centerNote(art);
    art.classList.add('flash');
    setTimeout(function(){ art.classList.remove('flash'); }, 1800);
    topArt = art; syncNav(); // 同 jumpAnchor：落点居中不经过观察条，显式同步时间导航
  }
  // 媒体抽屉（X Media 标签式大图网格；默认收起保证阅读满宽）
  var mgrid = document.getElementById('mediaGrid');
  var mediaBtn = document.getElementById('mediaBtn'), mediaTab = document.getElementById('mediaTab');
  var mpSens = document.getElementById('mpSens');
  var mediaOn = false; try { mediaOn = localStorage.getItem('mg-media') === 'on'; } catch (e) {}
  // 敏感遮罩每次打开档案都默认开启（file:// 下 localStorage 是全本地文件共享的，
  // 记忆关闭状态会让所有档案永远开着进出裸奔）——需要看时手动点 ⚠ 关闭，仅本次有效
  var sensMask = true;
  function applyMedia(){
    document.body.classList.toggle('media-open', mediaOn);
    document.body.classList.toggle('rail-unmask', !sensMask);
    mpSens.classList.toggle('off', !sensMask);
    try { localStorage.setItem('mg-media', mediaOn ? 'on' : 'off'); } catch (e) {}
  }
  function toggleMedia(force){
    mediaOn = force != null ? force : !mediaOn;
    applyMedia();
    if (mediaOn) markThumb(cur >= 0 ? cur : 0);
  }
  applyMedia();
  mediaBtn.addEventListener('click', function(){ toggleMedia(); });
  mediaTab.addEventListener('click', function(){ toggleMedia(true); });
  document.getElementById('mpClose').addEventListener('click', function(){ toggleMedia(false); });
  mpSens.addEventListener('click', function(){ setSens(!sensMask); });
  document.getElementById('mediaBtnCnt').textContent = imgs.length + ${JSON.stringify(A('aMpUnit').trim())};
  document.getElementById('mpCount').textContent = imgs.length + ${JSON.stringify(A('aMpUnit'))};
  // 瀑布流大缩略图（保留原始比例；hover 显示日期；敏感图遮罩）
  // 瀑布流：约 180px 目标列宽、列数随容器宽自适应；只在列数变化时重建，图片加载不重排（避免 DOM 风暴）
  var COL_TARGET = 180;
  var mcols = [];
  var thumbs = imgs.map(function(img, i){
    var note = img.closest('article.note');
    var timeEl = note && note.querySelector('time');
    var box = img.closest('.img');
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'mthumb'; b.title = (i + 1) + ' / ' + imgs.length;
    var t = document.createElement('img');
    t.src = img.getAttribute('src'); t.loading = 'lazy'; t.decoding = 'async'; t.alt = '';
    var ratio = 1; // h/w 估计值，加载后更新（仅更新数据，不重排）
    t.addEventListener('load', function(){ try { ratio = t.naturalHeight / (t.naturalWidth || 1); } catch (e) {} });
    b.appendChild(t);
    var tm = document.createElement('span'); tm.className = 'mtime';
    try { tm.textContent = new Date(timeEl ? timeEl.getAttribute('datetime') : Date.now()).toLocaleDateString(L === 'en' ? 'en-US' : L); } catch (e) { tm.textContent = ''; }
    b.appendChild(tm);
    if (box && box.classList.contains('sens')) b.classList.add('sens');
    b.addEventListener('click', function(){
      if (b.classList.contains('sens') && !b.classList.contains('revealed') && !document.body.classList.contains('rail-unmask')) {
        b.classList.add('revealed'); return; // 第一点击：就地揭示（去模糊）
      }
      open(i);
    });
    return { el: b, ratio: function(){ return ratio; } };
  });
  function layout(){
    var cols = Math.max(2, Math.min(5, Math.floor(mgrid.clientWidth / COL_TARGET) || 2));
    if (cols === mcols.length && mcols[0] && mcols[0].parentNode === mgrid) return; // 列数未变：绝不重建
    while (mgrid.firstChild) mgrid.removeChild(mgrid.firstChild);
    mcols = [];
    var heights = [];
    for (var c = 0; c < cols; c++) {
      var col = document.createElement('div'); col.className = 'mcol';
      mgrid.appendChild(col); mcols.push(col); heights.push(0);
    }
    thumbs.forEach(function(th){
      var c = 0; for (var k = 1; k < heights.length; k++) if (heights[k] < heights[c]) c = k;
      mcols[c].appendChild(th.el);
      heights[c] += th.ratio() + 0.06; // 比例 + 间距估计
    });
  }
  var layoutTimer = null;
  function relayoutSoon(){ if (layoutTimer) clearTimeout(layoutTimer); layoutTimer = setTimeout(layout, 120); }
  window.addEventListener('resize', relayoutSoon);
  layout();
  // 灯箱底部胶片条
  var strip = document.getElementById('lbStrip');
  var stripThumbs = imgs.map(function(img, i){
    var b = document.createElement('button'); b.type = 'button'; b.className = 'lbt';
    var box = img.closest('.img');
    if (box && box.classList.contains('sens')) b.classList.add('sens');
    var t = document.createElement('img');
    t.src = img.getAttribute('src'); t.loading = 'lazy'; t.alt = '';
    b.appendChild(t);
    b.addEventListener('click', function(){ open(i); });
    strip.appendChild(b);
    return b;
  });
  var stripPinned = false;
  document.getElementById('lbStripHandle').addEventListener('click', function(){
    stripPinned = !stripPinned;
    document.getElementById('lbStripZone').classList.toggle('pinned', stripPinned);
    if (cur >= 0) markThumb(cur);
  });
  function markThumb(i){
    thumbs.forEach(function(t, k){ t.el.classList.toggle('on', k === i); });
    if (thumbs[i] && mediaOn) thumbs[i].el.scrollIntoView({ block: 'nearest' });
    stripThumbs.forEach(function(t, k){ t.classList.toggle('on', k === i); });
    if (stripThumbs[i] && lb.classList.contains('on')) {
      // 平滑居中当前缩略图（scrollIntoView 在条收起/滑出动画状态下不可靠，手动算位置）
      var st = stripThumbs[i];
      var left = st.offsetLeft - strip.offsetLeft - (strip.clientWidth - st.offsetWidth) / 2;
      strip.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    }
  }
  document.addEventListener('click', function(ev){
    var box = ev.target.closest ? ev.target.closest('.grid .img') : null;
    if (!box) return; // 整块图片区域（含留白）统一进灯箱
    var img = box.querySelector('img');
    if (!img) return;
    if (box.classList.contains('sens') && !box.classList.contains('revealed')) return; // 先揭示
    ev.preventDefault(); open(idxBySrc[img.getAttribute('src')]);
  });
  lb.querySelector('.lb-close').addEventListener('click', function(){ lb.classList.remove('on'); });
  lb.querySelector('.prev').addEventListener('click', function(e){ e.stopPropagation(); open(cur - 1); });
  lb.querySelector('.next').addEventListener('click', function(e){ e.stopPropagation(); open(cur + 1); });
  document.addEventListener('keydown', function(e){
    if (lb.classList.contains('on')) {
      if (e.key === 'Escape') lb.classList.remove('on');
      if (e.key === 'ArrowLeft') open(cur - 1);
      if (e.key === 'ArrowRight') open(cur + 1);
      return;
    }
    if (e.key === 'Escape' && document.body.classList.contains('media-open')) toggleMedia(false);
    if (e.key === 'Escape' && document.body.classList.contains('time-open')) setTimePanel(false);
  });
  lb.addEventListener('click', function(e){ if (e.target === lb) lb.classList.remove('on'); });
  // 灯箱内滚轮 = 切上一张/下一张（大图、空白、缩略图条上均生效），并拦截默认的背景页面滚动；
  // 累积 deltaY 超过阈值才切一张 + 短冷却，防触控板惯性一次滚过好几张
  var wheelAcc = 0, wheelCool = 0;
  lb.addEventListener('wheel', function(e){
    if (!lb.classList.contains('on')) return;
    e.preventDefault();
    var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    var now = Date.now();
    if (now < wheelCool) return;
    wheelAcc += d;
    if (Math.abs(wheelAcc) >= 60) {
      open(cur + (wheelAcc > 0 ? 1 : -1));
      wheelAcc = 0;
      wheelCool = now + 80;
    }
  }, { passive: false });
  // 时间导航：L0 粘性月份指示 / L1 左缘活跃度轴（拖动按时间定位）/ L2 月历（精确落点）
  // 口径：按笔记发布日期分组（时间线忠实口径，与媒体抽屉的首发去重口径无关）；
  // 日期取展示时区（与笔记卡片 toLocaleString 一致），轴按周聚合、时间均匀铺排（空档可见）
  var LOC = L === 'en' ? 'en-US' : L;
  function monthLabel(t){ try { return new Date(t).toLocaleDateString(LOC, { year: 'numeric', month: 'long' }); } catch (e) { return ''; } }
  var tarts = [], dayMap = {}, monthMap = {};
  notes.forEach(function (el) {
    var tel = el.querySelector('time'); if (!tel) return;
    var t = new Date(tel.getAttribute('datetime')).getTime(); if (isNaN(t)) return;
    el.__t = t; tarts.push(el);
    var d = new Date(t);
    var dk = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    var mk = d.getFullYear() * 100 + (d.getMonth() + 1);
    // first = 该天最新一条 = 该天区块顶部（按时间比较取，不依赖 DOM 排序方向——oldfirst 档案 DOM 是升序）
    if (!dayMap[dk]) dayMap[dk] = { n: 0, first: el };
    else if (el.__t > dayMap[dk].first.__t) dayMap[dk].first = el;
    dayMap[dk].n++;
    monthMap[mk] = (monthMap[mk] || 0) + 1;
  });
  // 时间导航内部一律按时间降序自建序，不依赖 DOM 排列方向（档案支持 oldfirst 渲染）
  tarts.sort(function (a, b) { return b.__t - a.__t; });
  var tMax = tarts.length ? tarts[0].__t : 0, tMin = tarts.length ? tarts[tarts.length - 1].__t : 0;
  var WEEK = 7 * 86400000, weekN = tarts.length ? Math.max(1, Math.ceil((tMax - tMin) / WEEK) + 1) : 1;
  var weekCnt = new Array(weekN).fill(0), maxDay = 1, maxWeek = 1;
  tarts.forEach(function (el) {
    var wi = Math.min(weekN - 1, Math.floor((el.__t - tMin) / WEEK));
    weekCnt[wi]++; if (weekCnt[wi] > maxWeek) maxWeek = weekCnt[wi];
    var d = new Date(el.__t);
    var dk = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    if (dayMap[dk] && dayMap[dk].n > maxDay) maxDay = dayMap[dk].n;
  });
  // 目标时间 → 锚点笔记：时间线新→旧，取 createdAt <= t 的最新一条（该时间点的区块顶部）
  function anchorAt(t) {
    if (!tarts.length) return null;
    if (t >= tMax) return tarts[0];
    var lo = 0, hi = tarts.length - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (tarts[mid].__t > t) lo = mid + 1; else hi = mid; }
    return tarts[lo].__t <= t ? tarts[lo] : tarts[tarts.length - 1];
  }
  function firstOfYear(yr) { // 该年第一条笔记（tarts 新→旧；即降序数组中最后一个 >= 该年 1/1 的元素）
    var t0 = new Date(yr, 0, 1).getTime();
    if (tarts[tarts.length - 1].__t >= t0) return tarts[tarts.length - 1];
    var lo = 0, hi = tarts.length - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (tarts[mid].__t >= t0) lo = mid + 1; else hi = mid; }
    return tarts[lo - 1];
  }
  function visibleAnchor(art) { // 搜索过滤隐藏了锚点时顺延到最近的可见笔记（向后找，找不到再向前）
    var a = art;
    while (a && a.classList.contains('hide')) a = a.nextElementSibling && a.nextElementSibling.classList && a.nextElementSibling.classList.contains('note') ? a.nextElementSibling : null;
    if (a) return a;
    a = art.previousElementSibling;
    while (a && !(a.classList && a.classList.contains('note') && !a.classList.contains('hide'))) a = a.previousElementSibling;
    return a;
  }
  function jumpAnchor(art) {
    art = visibleAnchor(art); if (!art) return;
    // 与灯箱「跳到这条笔记」同款：展开含图的 CW 折叠，避免跳过去只看到折叠条
    art.querySelectorAll('details.cw').forEach(function (d) { if (d.querySelector('.grid img')) d.open = true; });
    centerNote(art);
    art.classList.add('flash');
    setTimeout(function () { art.classList.remove('flash'); }, 1800);
    topArt = art; syncNav(); // 落点在视口中央、不经过顶部观察条，显式同步月份指示/日历/轴光标
  }
  // ---- L2 月历面板 ----
  var timeOpen = false; try { timeOpen = localStorage.getItem('mg-time') === 'on'; } catch (e) {}
  var followPauseUntil = 0, calY = 0, calM = 0;
  var tpYears = document.getElementById('tpYears'), tpLabel = document.getElementById('tpLabel'),
      tpGrid = document.getElementById('tpGrid'), tpWeek = document.getElementById('tpWeek');
  var monthKeys = Object.keys(monthMap).map(Number).sort(function (a, b) { return a - b; }); // 升序 y*100+m
  var weekStart = (L === 'en') ? 0 : 1; // en 周日起，zh/ja 周一起
  (function () { // 周几表头（2017-01-01 是周日，按起始日偏移）
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 7; i++) {
      var d = new Date(2017, 0, 1 + weekStart + i);
      var s = document.createElement('span');
      try { s.textContent = d.toLocaleDateString(LOC, { weekday: 'narrow' }); } catch (e) { s.textContent = '·'; }
      frag.appendChild(s);
    }
    tpWeek.appendChild(frag);
  })();
  var years = [];
  monthKeys.forEach(function (mk) { var y = Math.floor(mk / 100); if (years.indexOf(y) < 0) years.push(y); });
  years.forEach(function (y) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'tp-btn'; b.textContent = y;
    b.addEventListener('click', function () {
      for (var i = 0; i < monthKeys.length; i++) if (Math.floor(monthKeys[i] / 100) === y) {
        setCalMonth(y, monthKeys[i] % 100 - 1); followPauseUntil = Date.now() + 4000; return;
      }
    });
    tpYears.appendChild(b);
  });
  function curIdx() { return monthKeys.indexOf(calY * 100 + calM + 1); }
  function updateNavBtns() {
    var i = curIdx();
    document.getElementById('tpPrev').disabled = i <= 0;
    document.getElementById('tpNext').disabled = i < 0 || i >= monthKeys.length - 1;
    Array.prototype.forEach.call(tpYears.children, function (b) { b.classList.toggle('on', +b.textContent === calY); });
  }
  function setCalMonth(y, m) {
    if (calY === y && calM === m && tpGrid.firstChild) { updateNavBtns(); return; }
    calY = y; calM = m;
    tpLabel.textContent = monthLabel(new Date(y, m, 1).getTime());
    var frag = document.createDocumentFragment();
    var lead = (new Date(y, m, 1).getDay() - weekStart + 7) % 7;
    for (var i = 0; i < 42; i++) {
      var d = new Date(y, m, 1 - lead + i);
      var dk = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
      var rec = dayMap[dk];
      var cell = document.createElement('button'); cell.type = 'button';
      cell.className = 'tp-day' + (d.getMonth() !== m ? ' out' : '') + (rec ? ' on' : '');
      cell.textContent = d.getDate();
      if (!rec || d.getMonth() !== m) { cell.disabled = true; }
      else {
        cell.title = d.toLocaleDateString(LOC) + ' · ' + rec.n;
        cell.style.background = 'color-mix(in srgb, var(--accent) ' + Math.round(Math.min(50, 8 + 42 * rec.n / maxDay)) + '%, transparent)';
        if (rec.n > 1) { var c = document.createElement('i'); c.className = 'cnt'; c.textContent = rec.n; cell.appendChild(c); }
        cell.addEventListener('click', (function (art) { return function () { jumpAnchor(art); }; })(rec.first));
      }
      frag.appendChild(cell);
    }
    tpGrid.innerHTML = ''; tpGrid.appendChild(frag);
    updateNavBtns();
  }
  document.getElementById('tpPrev').addEventListener('click', function () {
    var i = curIdx(); if (i > 0) { var mk = monthKeys[i - 1]; setCalMonth(Math.floor(mk / 100), mk % 100 - 1); followPauseUntil = Date.now() + 4000; }
  });
  document.getElementById('tpNext').addEventListener('click', function () {
    var i = curIdx(); if (i >= 0 && i < monthKeys.length - 1) { var mk = monthKeys[i + 1]; setCalMonth(Math.floor(mk / 100), mk % 100 - 1); followPauseUntil = Date.now() + 4000; }
  });
  function setTimePanel(v) {
    timeOpen = v != null ? v : !timeOpen;
    document.body.classList.toggle('time-open', timeOpen);
    try { localStorage.setItem('mg-time', timeOpen ? 'on' : 'off'); } catch (e) {}
    if (timeOpen) syncCalTo(topArt && topArt.__t != null ? topArt.__t : tMax);
  }
  function syncCalTo(t) {
    if (!tarts.length) return;
    var d = new Date(t);
    setCalMonth(d.getFullYear(), d.getMonth());
  }
  document.getElementById('tpClose').addEventListener('click', function () { setTimePanel(false); });
  document.getElementById('timeTab').addEventListener('click', function () { setTimePanel(); });
  // ---- L0 月份指示（左下角小胶囊，与右下角回到顶部对称） + 轴光标 + 日历跟随 ----
  var chip = document.getElementById('monthChip');
  var axis = document.getElementById('tpAxis'), axCursor = axis.querySelector('.ax-cursor');
  chip.addEventListener('click', function () { setTimePanel(true); });
  var topArt = null;
  function axFracOf(t) { return Math.min(1, Math.max(0, (t - tMin) / (tMax - tMin || 1))); }
  function syncNav() {
    if (!tarts.length) return;
    var t = topArt && topArt.__t != null ? topArt.__t : tMax;
    chip.textContent = monthLabel(t);
    axCursor.style.left = (axFracOf(t) * 100) + '%';
    var cy = new Date(t).getFullYear();
    Array.prototype.forEach.call(document.querySelectorAll('.ax-yearrow .ax-year'), function (b) { b.classList.toggle('on', +b.textContent === cy); });
    if (timeOpen && Date.now() > followPauseUntil) syncCalTo(t);
  }
  if ('IntersectionObserver' in window && tarts.length) {
    // 观察视口上半部（跳转落点在中央，top≈25%，也落在观察带内，自然滚动/跳转都能同步）
    var ioTop = new IntersectionObserver(function (ents) { ents.forEach(function (en) { if (en.isIntersecting) { topArt = en.target; syncNav(); } }); }, { rootMargin: '0px 0px -55% 0px' });
    tarts.forEach(function (el) { ioTop.observe(el); });
  }
  window.addEventListener('scroll', function () { chip.classList.toggle('on', window.scrollY > 320 && tarts.length); }, { passive: true });
  // ---- L1 活跃度轴（面板底部横轴：左=最旧 右=最新；密度柱 + 年份刻度 + 拖动 scrub）----
  if (tarts.length) {
    var axf = document.createDocumentFragment();
    for (var wi = 0; wi < weekN; wi++) {
      if (!weekCnt[wi]) continue;
      var col = document.createElement('div'); col.className = 'ax-col';
      col.style.left = (wi / weekN * 100) + '%';
      col.style.width = Math.max(0.4, 100 / weekN - 0.3) + '%';
      col.style.height = Math.max(8, Math.round(14 + 82 * weekCnt[wi] / maxWeek)) + '%';
      axf.appendChild(col);
    }
    var y0 = new Date(tMin).getFullYear(), y1 = new Date(tMax).getFullYear();
    var yearRow = document.getElementById('tpYearRow');
    for (var yy = y0; yy <= y1; yy++) {
      var yl = document.createElement('button'); yl.type = 'button'; yl.className = 'ax-year';
      yl.style.left = Math.min(96, Math.max(4, axFracOf(new Date(yy, 0, 1).getTime()) * 100)) + '%';
      yl.textContent = yy;
      yl.addEventListener('click', (function (yr) { return function () { jumpAnchor(firstOfYear(yr)); }; })(yy));
      yearRow.appendChild(yl);
    }
    axis.appendChild(axf);
  }
  var bubble = document.getElementById('scrubBubble'), scrub = { drag: false, last: 0 };
  function axisFrac(e) { var r = axis.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))); }
  function axisPoint(e, doJump) {
    var t = tMin + axisFrac(e) * (tMax - tMin);
    bubble.style.display = 'block'; bubble.style.left = e.clientX + 'px';
    bubble.style.top = axis.getBoundingClientRect().top + 'px';
    bubble.textContent = monthLabel(t);
    axCursor.style.left = (axisFrac(e) * 100) + '%';
    if (doJump) {
      var now = Date.now();
      if (now - scrub.last > 130) {
        scrub.last = now;
        var a = visibleAnchor(anchorAt(t));
        if (a) { hardCenter(a); syncCalTo(t); }
      }
    }
  }
  axis.addEventListener('pointermove', function (e) { if (tarts.length) axisPoint(e, scrub.drag); });
  axis.addEventListener('pointerleave', function () { if (!scrub.drag) bubble.style.display = 'none'; });
  axis.addEventListener('pointerdown', function (e) {
    if (!tarts.length) return;
    e.preventDefault();
    scrub.drag = true; scrub.last = 0;
    axis.classList.add('drag');
    jumpWatch.on = false; // 拖动期间由节流硬滚接管，先停掉旧的看护循环
    try { axis.setPointerCapture(e.pointerId); } catch (err) {}
    axisPoint(e, true);
  });
  axis.addEventListener('pointerup', function (e) {
    if (!scrub.drag) return;
    scrub.drag = false; axis.classList.remove('drag'); bubble.style.display = 'none';
    jumpAnchor(anchorAt(tMin + axisFrac(e) * (tMax - tMin)));
  });
  axis.addEventListener('pointercancel', function () { scrub.drag = false; axis.classList.remove('drag'); bubble.style.display = 'none'; });
  // 初始状态
  document.body.classList.toggle('time-open', timeOpen);
  if (timeOpen) syncCalTo(topArt && topArt.__t != null ? topArt.__t : tMax);
  syncNav();
  // 主题
  var themeBtn = document.getElementById('themeBtn');
  function setTheme(t){ document.documentElement.setAttribute('data-theme', t); try{ localStorage.setItem('mg-theme', t); }catch(e){} }
  var saved = null; try{ saved = localStorage.getItem('mg-theme'); }catch(e){}
  if (saved) setTheme(saved);
  themeBtn.addEventListener('click', function(){
    var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    setTheme(cur);
  });
  // 回到顶部
  var toTop = document.getElementById('toTop');
  window.addEventListener('scroll', function(){ toTop.classList.toggle('on', window.scrollY > 600); });
  toTop.addEventListener('click', function(){ window.scrollTo({top: 0, behavior: 'smooth'}); });
})();
</script>
</body>
</html>`;
}

// ---------- 元数据导出 ----------

export function buildDataJson({ user, notes, meta, items }) {
  const payload = {
    generator: 'Misskey Image Grabber v0.2.13', // 与 manifest 版本同步更新
    crawledAt: meta.crawlAt,
    source: 'https://misskey.io',
    user,
    stats: { notes: notes.length, images: (items || collectFiles(notes)).length },
    files: (items || collectFiles(notes)).map((it) => ({ localName: it.localName, fileId: it.file.id, noteId: it.note.id })),
    notes,
  };
  return JSON.stringify(payload, null, 1);
}

export function buildCsv(items, user) {
  const cols = [
    'note_id', 'created_at', 'local_time', 'cw', 'text',
    'file_name_local', 'file_name_orig', 'file_type', 'width', 'height', 'sensitive', 'size_bytes',
    'file_url', 'note_url',
  ];
  const q = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // 防 Excel/Sheets 公式注入（CSV injection）
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [cols.join(',')];
  for (const it of items) {
    const { note, file, localName } = it;
    let local = '';
    try { local = new Date(note.createdAt).toLocaleString('zh-CN'); } catch (e) {}
    rows.push(
      [
        note.id, note.createdAt, local, note.cw || '', note.text || '',
        localName, file.name || '', file.type || '',
        (file.properties && file.properties.width) || '', (file.properties && file.properties.height) || '',
        file.isSensitive ? 'yes' : 'no', file.size || '',
        file.url || '', 'https://misskey.io/notes/' + note.id,
      ].map(q).join(','),
    );
  }
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}
