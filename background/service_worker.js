/**
 * agy Translate - Background Service Worker
 * Bridges Chrome/Edge content scripts & popup with the local agytrans server.
 * Handles Context Menus (Full page translation, Selection translation, Restore page).
 */

const DEFAULT_PORT = 47821;
const PORT_RANGE = 12;

let cachedPort = DEFAULT_PORT;

async function getStoredSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({
      targetLang: 'zh-TW',
      serverPort: DEFAULT_PORT,
      autoShowIcon: true,
      closeOnCopy: true,
      disabledDomains: []
    }, (items) => {
      resolve(items);
    });
  });
}

/**
 * Scan for running agytrans service
 */
async function findActivePort(basePort) {
  const portsToTry = [cachedPort];
  for (let p = basePort; p < basePort + PORT_RANGE; p++) {
    if (!portsToTry.includes(p)) portsToTry.push(p);
  }

  for (const port of portsToTry) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 600);
      const res = await fetch(`http://127.0.0.1:${port}/ping`, {
        signal: controller.signal,
        cache: 'no-store'
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const json = await res.json();
        if (json.app === 'agy-translate') {
          cachedPort = port;
          return port;
        }
      }
    } catch (e) {
      // Try next
    }
  }
  return null;
}

/**
 * Single translation (Auto-detect -> Target Language)
 */
async function handleTranslate(text, targetLang = 'zh-TW') {
  const settings = await getStoredSettings();
  const basePort = settings.serverPort || DEFAULT_PORT;
  const lang = targetLang || settings.targetLang || 'zh-TW';

  const port = await findActivePort(basePort);
  if (!port) {
    return {
      status: 'server_offline',
      message: `Cannot connect to local agytrans service on port ${basePort}.`
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const res = await fetch(`http://127.0.0.1:${port}/api/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text, target_lang: lang }),
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timeoutId);

    const json = await res.json();
    return json;
  } catch (err) {
    if (err.name === 'AbortError') {
      return { status: 'error', message: 'Request timeout: Gemini backend did not respond in time.' };
    }
    return { status: 'error', message: 'Network error: ' + (err.message || err) };
  }
}

/**
 * Batch translation (for Full-Page Translation)
 */
async function handleTranslateBatch(texts, targetLang = 'zh-TW') {
  const settings = await getStoredSettings();
  const basePort = settings.serverPort || DEFAULT_PORT;
  const lang = targetLang || settings.targetLang || 'zh-TW';

  const port = await findActivePort(basePort);
  if (!port) {
    return {
      status: 'server_offline',
      message: `Cannot connect to local agytrans service on port ${basePort}.`
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const res = await fetch(`http://127.0.0.1:${port}/api/translate_batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ texts, target_lang: lang }),
      signal: controller.signal,
      cache: 'no-store'
    });
    clearTimeout(timeoutId);

    const json = await res.json();
    return json;
  } catch (err) {
    return { status: 'error', message: 'Network error: ' + (err.message || err) };
  }
}

// Setup Context Menus
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'agy-translate-full-page',
      title: '🌐 Translate Page',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'agy-restore-full-page',
      title: '↩️ Show Original Page',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'agy-translate-selection',
      title: '🌐 Translate Selection (agy Translate)',
      contexts: ['selection']
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  setupContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  setupContextMenus();
});

// Handle Context Menu item clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'agy-translate-full-page') {
    chrome.tabs.sendMessage(tab.id, { type: 'START_FULL_PAGE_TRANSLATION' });
  } else if (info.menuItemId === 'agy-restore-full-page') {
    chrome.tabs.sendMessage(tab.id, { type: 'RESTORE_ORIGINAL_PAGE' });
  } else if (info.menuItemId === 'agy-translate-selection') {
    chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_SHORTCUT_TRANSLATE' });
  }
});

// Message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'TRANSLATE') {
    handleTranslate(request.text, request.targetLang).then(sendResponse);
    return true;
  }

  if (request.type === 'TRANSLATE_BATCH') {
    handleTranslateBatch(request.texts, request.targetLang).then(sendResponse);
    return true;
  }

  if (request.type === 'CHECK_SERVER') {
    getStoredSettings().then((s) => findActivePort(s.serverPort || DEFAULT_PORT)).then((port) => {
      sendResponse({ online: port !== null, port });
    });
    return true;
  }

  if (request.type === 'GET_SETTINGS') {
    getStoredSettings().then(sendResponse);
    return true;
  }

  if (request.type === 'SAVE_SETTINGS') {
    chrome.storage.sync.set(request.settings, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// Shortcut command trigger
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-translate') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_SHORTCUT_TRANSLATE' });
      }
    });
  }
});
