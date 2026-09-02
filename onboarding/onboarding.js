// 项目启动页：三语欢迎 / 状态自检 / 初始偏好 / 关于与更新日志
// 作者与仓库为占位符，开源时替换 ABOUT 常量即可
import { pickDirectory, supportsDirPicker, saveHandle } from '../manager/dirhandle.js';
import { saveSettings as storeSaveSettings } from '../lib/store.js';
import { detectUiLang } from '../lib/i18n.js';

// TODO(开源时替换)：作者名与仓库地址
const ABOUT = {
  author: 'HuilanYM',
  repo: 'https://github.com/HuilanYM/misskey-image-grabber',
};

const PRESET_APPLY = {
  safest: { pace: 'safest', limit: 10, mediaPace: 'gentle' },
  balanced: { pace: 'normal', limit: 40, mediaPace: 'normal' },
  fast: { pace: 'fast', limit: 100, mediaPace: 'fast' },
};

const I18N = {
  'zh-CN': {
    subtitle: '抓取 misskey.io 用户发布的图片，生成可离线浏览的 HTML 档案',
    stepsTitle: '三步开始',
    step1: '打开 misskey.io 的任一用户主页',
    step2: '点击页面右下角的绿色「抓取此用户的图片」按钮',
    step3: '在管理页选「更新本地档案」导出，双击 archive.html 离线浏览',
    btnMisskey: '打开 misskey.io',
    btnManager: '打开管理页',
    statusTitle: '当前状态',
    st_ok: '✓ 已检测到 misskey.io 登录会话（可抓取登录后可见内容）',
    st_nologin: '⚠ 已打开 misskey.io 但未登录——公开内容仍可抓取，建议登录以获取更多内容',
    st_notab: '未检测到已打开的 misskey.io 页面——打开后这里会自动检测',
    prefsTitle: '初始偏好（可稍后在管理页修改）',
    prefPreset: '安全预设',
    presetSafest: '稳健（最安全）',
    presetBalanced: '平衡（推荐）',
    presetFast: '快速（不推荐）',
    presetHint: '请求节奏与分页大小的一键模板；预设无法做到“绝对不可见”，请配合数量上限控制总量',
    prefSave: '保存位置',
    saveDownloads: '浏览器下载文件夹（默认）',
    saveFolder: '自选文件夹（直接写入，不弹下载栏）',
    btnPick: '📂 选择文件夹…',
    saveHint: '自选文件夹需要授权一次，之后导出会直接写入该目录；随时可在管理页修改',
    privTitle: '隐私与数据',
    priv1: '所有抓取的数据与图片仅保存在你的电脑本地',
    priv2: 'API 请求通过你自己的浏览器登录会话发出，扩展不向任何第三方服务器发送数据',
    priv3: '请遵守 misskey.io 的实例规则，控制抓取量级与频率',
    aboutTitle: '关于',
    version: '版本',
    author: '作者',
    repo: '仓库',
    whatsnew: '更新日志',
    wn020: '启动页 · 增量档案（本地镜像）· 媒体抽屉 · 灯箱重设计 · 过往记录与扫描档案库',
    wn021: '修复重启后重建失败 · 独立的按文件夹重建 · 过滤全排除时提前停止 · 三语化完善',
    wn022: '图片抽屉按图片去重并归属首发笔记（时间与跳转以首发为准）',
    wn023: '抽屉顺序也以首发为准（整体按时间排列，不再夹在汇总笔记的位置）· 修复「跳到这条笔记」远距离一次跳不到位',
    wn024: '敏感遮罩改为每次打开档案默认开启（手动关闭仅当次有效）· 抽屉宽度改为正好盖住正文旁空白区，不再遮挡正文',
    wn025: '新增左侧时间导航：月历点日期直达 · 日历下方活跃度轴拖动按时间定位 · 左下角显示当前所在月份',
    wn026: '修复连续点击相邻日期时页面来回跳动的问题（旧定位看护未及时让位）',
    wn027: '时间导航优化：年份数字移到活跃度轴下方、更清晰，并可点击直达该年第一条笔记；当前所在年份高亮',
    wn028: '界面图标全部替换为手绘线性 SVG（随主题/悬停变色，跨平台显示一致），不再依赖系统 emoji 字体',
    wn029: '图标排版微调：图标放大至 16px 并统一与文字的间距，观感更整洁',
    wn0210: '灯箱内滚轮可直接切换上一张/下一张，缩略图条平滑跟随居中，不再滚动背景页面',
    wn0211: '修复：点过一次「停止」后，同一会话内无法再次开始抓取的问题',
    wn0212: '评审修复八项：日期范围重启后正确恢复 · 出错/限流停止后可从横幅继续抓取 · 管理页已开时「抓取此用户」正确预填 · 导出失败不再卡死导出栏 · 档案快照不再出现失效图片 · 从旧到新排序档案的时间导航修复等',
    wn0213: '质量清理一批：开始按钮防连点 · 抓取异常后状态必然复位 · 设置保存防并发覆盖 · 记录备份补全表情/头像映射 · 清空记录连孤儿数据一起清 · 档案搜索更快更省内存 · CSV 防公式注入等',
    wn0214: '过往记录新增：一键「打开下载文件夹（MisskeyGrab）」与每位用户行内的「打开 HTML」，直接在浏览器中查看对应档案',
    wn0215: '管理页顶栏新增抓取状态胶囊（语言选择旁）：实时显示当前能否抓取——已登录（绿）/ 匿名可抓公开（黄）/ 无 misskey.io 页面不可抓取（灰），随标签开关自动更新，点击可手动重查',
    wn0216: '修复已登录却被识别为未登录的问题：misskey.io 新版把登录凭证迁到 IndexedDB 且 token 含大写字母，检测已全面支持（IndexedDB 兜底 + 格式放宽）；状态胶囊样式也与整体界面统一',
    wn0217: '修复扩展重载后未刷新的 misskey.io 页面每 15 秒在控制台刷一次 "Extension context invalidated" 的问题（错误现在会正确转入页面提示，不再刷屏）',
    wn0218: '首次安装时界面语言自动跟随浏览器语言（中文系统→中文、日文系统→日文，其余英文），可随时手动切换',
    wn010: '首个版本：抓取 · 低风控预设 · 离线 HTML 档案',
    legal: '本工具仅供个人备份与存档。请控制抓取量级与频率、遵守实例规则；数据与图片版权归原作者所有。',
    cta: '开始使用 →',
  },
  ja: {
    subtitle: 'misskey.io のユーザー画像を取得し、オフラインで閲覧できる HTML アーカイブを生成します',
    stepsTitle: '3ステップで開始',
    step1: 'misskey.io のユーザーページを開く',
    step2: 'ページ右下の緑の「画像を取得」ボタンをクリック',
    step3: '管理ページで「ローカルアーカイブを更新」を選んで書き出し、archive.html をダブルクリック',
    btnMisskey: 'misskey.io を開く',
    btnManager: '管理ページを開く',
    statusTitle: '現在の状態',
    st_ok: '✓ misskey.io のログインセッションを検出しました',
    st_nologin: '⚠ misskey.io は開いていますが未ログインです——公開コンテンツは取得できます。ログイン推奨',
    st_notab: 'misskey.io のタブが見つかりません——開くと自動で検出します',
    prefsTitle: '初期設定（後から管理ページで変更できます）',
    prefPreset: '安全プリセット',
    presetSafest: '安全（最優先）',
    presetBalanced: 'バランス（推奨）',
    presetFast: '高速（非推奨）',
    presetHint: 'リクエスト間隔とページサイズのテンプレート。プリセットでも「完全に見えなくなる」わけではないので、取得量は上限設定で管理してください',
    prefSave: '保存先',
    saveDownloads: 'ブラウザのダウンロードフォルダ（既定）',
    saveFolder: 'フォルダを指定（直接書き込み）',
    btnPick: '📂 フォルダを選択…',
    saveHint: 'フォルダ指定には一度だけ許可が必要です。いつでも管理ページで変更できます',
    privTitle: 'プライバシーとデータ',
    priv1: '取得したデータと画像はあなたの PC 内にのみ保存されます',
    priv2: 'API リクエストはあなた自身のブラウザセッションから送信され、第三者のサーバーへ送信されることはありません',
    priv3: 'misskey.io のルールを守り、取得量と頻度は控えめにしてください',
    aboutTitle: 'この拡張機能について',
    version: 'バージョン',
    author: '開発者',
    repo: 'リポジトリ',
    whatsnew: '更新履歴',
    wn020: 'スタートページ · 増分アーカイブ · メディアドロワー · ライトボックス刷新 · 履歴とアーカイブスキャン',
    wn021: '再起動後の再生成失敗を修正 · フォルダ選択での再構築 · 全排除フィルタの早期停止 · 多言語化改善',
    wn022: '画像ドロワーを画像単位に重複排除し、初出ノートに帰属（日時とジャンプは初出基準）',
    wn023: 'ドロワーの並び順も初出基準に統一（まとめノートの位置に挟まれなくなりました）· 「ノートへジャンプ」の遠距離ジャンプが一発で届くよう修正',
    wn024: 'センシティブマスクはアーカイブを開くたびに既定で ON（手動オフはその場限り）· ドロワー幅を本文横の余白ぴったりにし、本文を覆わない',
    wn025: '左側に時間ナビを追加：カレンダーの日付クリックでジャンプ · カレンダー下のアクティビティ軸をドラッグして日付移動 · 左下に現在の月を表示',
    wn026: '隣接する日付を連続クリックするとページが行き来する問題を修正（旧スクロール監視が即時に譲らなかった）',
    wn027: '時間ナビ改善：年ラベルをアクティビティ軸の下へ移動して視認性向上。クリックでその年最初のノートへジャンプ、現在の年をハイライト',
    wn028: 'UIアイコンを自作ライン風SVGに全面変更（テーマやホバーで色が変わり、環境差なし）',
    wn029: 'アイコンの微調整：16px に拡大し、文字との間隔を統一して見やすく',
    wn0210: 'ライトボックス内でホイールにより前後の画像へ切替、サムネイル列がスムーズに追従。背景はスクロールされません',
    wn0211: '修正：「停止」を一度押すと同じセッションで再度取得を開始できなかった問題',
    wn0212: 'レビュー修正8件：日付範囲の復元・エラー後のバナー再開・ハッシュ事前入力・書き出し失敗時の復旧・失効画像リンク除去・昇順アーカイブの時間ナビ修正など',
    wn0213: '品質改善多数：開始ボタン連打防止・エラー後の状態復旧・設定保存の競合防止・記録バックアップに絵文字/头像マップ追加・孤児データも消去・アーカイブ検索の高速化・CSV式注入対策など',
    wn0214: '取得履歴に追加：「ダウンロードフォルダを開く（MisskeyGrab）」ボタンと、ユーザーごとの「HTML を開く」ボタンでアーカイブを直接表示',
    wn0215: '管理ページ上部に取得状態ピルを追加（言語選択の隣）：ログイン済み（緑）/ 匿名で公開内容のみ（黄）/ misskey.io タブなしで取得不可（グレー）をリアルタイム表示。タブの開閉で自動更新、クリックで再チェック',
    wn0216: '修正：ログイン済みなのに未ログインと表示される問題（misskey.io 新版は認証情報を IndexedDB に移行、トークンに大文字が含まれる形式にも対応）。ステータスピルのデザインも UI に統一',
    wn0217: '修正：拡張機能の再読み込み後、未更新の misskey.io ページで 15 秒ごとにコンソールへエラーが出る問題（ページ上の案内に反映されるように）',
    wn0218: '初回インストール時に UI 言語をブラウザの言語に自動追従（日本語環境なら日本語）。いつでも手動切替可能',    wn010: '初回リリース：取得 · 安全プリセット · オフライン HTML アーカイブ',
    legal: '本ツールは個人用のバックアップとアーカイブ目的にのみ使用してください。取得量と頻度を控えめにし、インスタンスのルールを守ってください。データと画像の著作権は各作者に帰属します。',
    cta: '開始する →',
  },
  en: {
    subtitle: 'Grab a misskey.io user\'s images and build an offline, browsable HTML archive',
    stepsTitle: 'Start in 3 steps',
    step1: 'Open a user page on misskey.io',
    step2: 'Click the green "Grab" button at the bottom-right of the page',
    step3: 'In the manager choose "Update local archive", then double-click archive.html',
    btnMisskey: 'Open misskey.io',
    btnManager: 'Open manager',
    statusTitle: 'Current status',
    st_ok: '✓ misskey.io login session detected',
    st_nologin: '⚠ misskey.io is open but not logged in — public content still works, logging in is recommended',
    st_notab: 'No misskey.io tab detected — open one and the status updates automatically',
    prefsTitle: 'Initial preferences (change later in the manager)',
    prefPreset: 'Safety preset',
    presetSafest: 'Safe (safest)',
    presetBalanced: 'Balanced (recommended)',
    presetFast: 'Fast (not recommended)',
    presetHint: 'One-click template for pacing and page size. No preset makes you "invisible" — cap your volume with the notes limit',
    prefSave: 'Save location',
    saveDownloads: 'Browser downloads folder (default)',
    saveFolder: 'Custom folder (direct write, no download bar)',
    btnPick: '📂 Choose folder…',
    saveHint: 'Grant access once; exports are written straight into that folder. Change anytime in the manager',
    privTitle: 'Privacy & data',
    priv1: 'All grabbed data and images stay on your computer only',
    priv2: 'API requests go through your own browser session; the extension never sends data to third-party servers',
    priv3: 'Follow misskey.io instance rules and keep volume and frequency reasonable',
    aboutTitle: 'About',
    version: 'Version',
    author: 'Author',
    repo: 'Repository',
    whatsnew: 'What\'s new',
    wn020: 'Onboarding · Incremental archive (local mirror) · Media drawer · Lightbox redesign · History & library scan',
    wn021: 'Fixed rebuild-after-restart crash · standalone folder rebuild · early stop when filters exclude all · i18n polish',
    wn022: 'Media drawer deduplicated per image, anchored to the first note (dates & jump follow the original post)',
    wn023: 'Drawer order now also follows the first publication (chronological, no longer stuck at the summary note) · fixed long-distance "jump to note" falling short',
    wn024: 'Sensitive mask now on by default every open (manual off lasts for that session) · drawer width fits the gutter beside the article, no longer covering it',
    wn025: 'New left time navigation: click a calendar day to jump · drag the activity axis below it to scrub by date · current month shown at bottom-left',
    wn026: 'Fixed page oscillation when rapidly clicking adjacent dates (old scroll watchdog did not yield in time)',
    wn027: 'Time navigation polish: year labels moved below the activity axis for clarity, clickable to jump to the first note of a year; current year highlighted',
    wn028: 'All UI icons replaced with hand-drawn linear SVGs (tint with theme and hover, consistent across platforms)',
    wn029: 'Icon polish: enlarged to 16px with unified spacing from labels for a cleaner look',
    wn0210: 'Mouse wheel inside the lightbox now switches images with a smoothly following film strip; the background page no longer scrolls',
    wn0211: 'Fixed: after pressing Stop once, starting a new grab in the same session failed until reload',
    wn0212: 'Review fixes (8): date-range restore, resume banner after errors, hash prefill, export failure recovery, dead image links removed, oldest-first archive time navigation fixed',
    wn0213: 'Quality sweep: start-button reentry guard, guaranteed state reset after crawl errors, race-free settings saves, emoji/avatar maps in history backups, orphan-data cleanup, faster archive search, CSV formula-injection guard',
    wn0214: 'History tab additions: one-click "Open downloads folder (MisskeyGrab)" and a per-user "Open HTML" button to view each archive directly in the browser',
    wn0215: 'Manager header now shows a grab-status pill next to the language selector: logged-in (green) / anonymous public-only (yellow) / no misskey.io tab (grey, cannot grab), auto-updating with tab changes; click to re-check',
    wn0216: 'Fixed logged-in sessions being detected as anonymous: misskey.io moved credentials into IndexedDB and newer tokens contain uppercase letters — detection now covers both; the status pill styling is also unified with the UI',
    wn0217: 'Fixed repeated "Extension context invalidated" console errors on misskey.io tabs left open after reloading the extension — the page now shows a refresh notice instead',
    wn0218: 'UI language now follows the browser language on first install (switchable anytime)',    wn010: 'First release: grabbing · safety presets · offline HTML archive',
    legal: 'For personal backup and archiving only. Keep crawl volume and frequency reasonable and follow instance rules. All data and images belong to their original authors.',
    cta: 'Get started →',
  },
};

const $ = (id) => document.getElementById(id);
let lang = 'zh-CN';

// 首次安装默认英文；用户选择后记忆到本地

function applyLang() {
  const dict = I18N[lang] || I18N['zh-CN'];
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key]) el.textContent = dict[key];
  });
  document.documentElement.lang = lang;
  document.title = 'Misskey Image Grabber — ' + (lang === 'ja' ? 'ようこそ' : lang === 'en' ? 'Welcome' : '欢迎使用');
}

// 与 manager 共用 store.js 的串行化 saveSettings，避免两处读-改-写并发丢字段
const saveSettings = storeSaveSettings;

async function init() {
  // 版本号
  const ver = chrome.runtime.getManifest().version;
  $('ver').textContent = 'v' + ver;
  $('ver2').textContent = 'v' + ver;

  // 关于（占位符，开源时替换 ABOUT）
  $('author').textContent = ABOUT.author;
  $('repo').textContent = ABOUT.repo.replace('https://', '');
  $('repo').href = ABOUT.repo;

  // 语言：存储优先，首次安装默认英文
  const stored = (await chrome.storage.local.get('mg:lang'))['mg:lang'];
  lang = stored || detectUiLang(); // 未设置时跟随浏览器语言
  if (!I18N[lang]) lang = 'en';
  $('lang').value = lang;
  applyLang();

  $('lang').addEventListener('change', async () => {
    lang = $('lang').value;
    try { await chrome.storage.local.set({ 'mg:lang': lang }); } catch (e) { /* 上下文失效等 */ }
    applyLang();
  });

  // 状态自检：经 misskey.io 内容脚本扫描登录 token
  (async () => {
    const el = $('status');
    const set = (cls, key) => { el.className = 'status-line ' + cls; el.textContent = I18N[lang][key]; };
    try {
      const tabs = await chrome.tabs.query({ url: 'https://misskey.io/*' });
      if (!tabs.length) return set('dim', 'st_notab');
      const r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'mg:scan-token' }).catch(() => null);
      if (r && r.token) set('ok', 'st_ok'); else set('warn', 'st_nologin');
    } catch (e) { set('dim', 'st_notab'); }
  })();

  // 初始偏好：安全预设
  const savedSettings = (await chrome.storage.local.get('mg:settings'))['mg:settings'] || {};
  if (savedSettings.preset) {
    const radio = document.querySelector(`input[name=preset][value=${savedSettings.preset}]`);
    if (radio) radio.checked = true;
  }
  document.querySelectorAll('input[name=preset]').forEach((r) => r.addEventListener('change', () => {
    const v = r.value;
    saveSettings({ preset: v, ...PRESET_APPLY[v] });
  }));

  // 初始偏好：保存位置
  if (savedSettings.saveTarget === 'folder') document.querySelector('input[name=save][value=folder]').checked = true;
  document.querySelectorAll('input[name=save]').forEach((r) => r.addEventListener('change', () => {
    if (r.value === 'folder' && !supportsDirPicker()) {
      alert(lang === 'ja' ? 'このブラウザはフォルダ選択に対応していません' : lang === 'en' ? 'This browser does not support folder picking' : '当前浏览器不支持自选文件夹');
      r.checked = false;
      document.querySelector('input[name=save][value=downloads]').checked = true;
      return;
    }
    if (r.value === 'folder') $('btnPick').classList.remove('hidden');
    else { $('btnPick').classList.add('hidden'); saveSettings({ saveTarget: 'downloads' }); }
  }));
  $('btnPick').addEventListener('click', async () => {
    if (!supportsDirPicker()) return;
    try {
      const dir = await pickDirectory();
      // 与管理页一致：写临时文件验证可写后删除，避免导出时才发现不可写
      const { writeFileIn } = await import('../manager/dirhandle.js');
      try {
        await writeFileIn(dir, '_mg_test.tmp', 'ok');
        await dir.removeEntry('_mg_test.tmp');
      } catch (e2) {
        alert(lang === 'ja' ? 'このフォルダには書き込めません：' + (e2.message || e2)
          : lang === 'en' ? 'Folder is not writable: ' + (e2.message || e2)
          : '该文件夹不可写：' + (e2.message || e2));
        return;
      }
      $('dirName').textContent = '📂 ' + dir.name;
      await saveSettings({ saveTarget: 'folder' });
    } catch (e) { /* 用户取消 */ }
  });

  // 按钮
  $('btnMisskey').addEventListener('click', () => chrome.tabs.create({ url: 'https://misskey.io/' }));
  $('btnManager').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') }));
  $('btnStart').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
    window.close();
  });

  // 更新日志定位
  if (location.hash === '#whatsnew') {
    $('whatsnewBox').open = true;
    $('whatsnewBox').scrollIntoView({ block: 'center' });
  }
}

init();
