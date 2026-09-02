// service worker：打开/复用管理页 + 安装/更新时打开项目启动页

const MANAGER_URL = chrome.runtime.getURL('manager/manager.html');
const ONBOARDING_URL = chrome.runtime.getURL('onboarding/onboarding.html');

async function openManager(handle) {
  const tabs = await chrome.tabs.query({ url: MANAGER_URL + '*' });
  const url = MANAGER_URL + (handle ? '#u=' + encodeURIComponent(handle) : '');
  if (tabs.length) {
    // 复用已打开的管理页，避免多实例同时写任务状态
    await chrome.tabs.update(tabs[0].id, { active: true, url });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.action.onClicked.addListener(() => openManager());

// 首次安装 → 启动页；版本更新 → 启动页定位到更新日志（同一版本只提示一次）
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: ONBOARDING_URL });
  } else if (details.reason === 'update') {
    chrome.storage.local.get(['mg:whatsnew-seen']).then((o) => {
      if (o['mg:whatsnew-seen'] === details.previousVersion) return; // 该版本已展示过
      chrome.storage.local.set({ 'mg:whatsnew-seen': details.previousVersion });
      chrome.tabs.create({ url: ONBOARDING_URL + '#whatsnew' });
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'mg:open-manager') {
    openManager(msg.handle).then(() => sendResponse({ ok: true }));
    return true;
  }
});
