// HTML → MFM 兼容文本（baraag/Mastodon content 用）
// 规则见 MULTI-SITE-v0.4.0-BARAAG.md §3：保序、白名单标记转换、实体最后解码（渲染层会再统一转义，安全性等同）

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function htmlToText(html) {
  let s = String(html ?? '');
  if (!s.trim()) return '';
  // 1) 锚点 → [text](href)（保留真实域名：mention/hashtag/普通链接都走这条）
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const text = decodeEntities(String(inner).replace(/<[^>]+>/g, '')).trim();
    const h = decodeEntities(href);
    return text ? '[' + text + '](' + h + ')' : h ? h : '';
  });
  // 2) 换行结构
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  s = s.replace(/<p[^>]*>/gi, '');
  s = s.replace(/<\/p>/gi, '\n');
  // 3) 白名单行内标记
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/(strong|b)>/gi, (m, t, inner) => '**' + inner + '**');
  s = s.replace(/<(em|i)>([\s\S]*?)<\/(em|i)>/gi, (m, t, inner) => '*' + inner + '*');
  s = s.replace(/<(del|s)>([\s\S]*?)<\/(del|s)>/gi, (m, t, inner) => '~~' + inner + '~~');
  s = s.replace(/<code>([\s\S]*?)<\/code>/gi, (m, inner) => '`' + decodeEntities(inner) + '`');
  // 4) 剥掉其余标签
  s = s.replace(/<[^>]+>/g, '');
  // 5) 实体解码（文本位；渲染层 renderText 会统一再转义，安全性等同）
  s = decodeEntities(s);
  // 6) 收敛空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
