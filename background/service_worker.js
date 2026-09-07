/**
 * agy Translate - Background Service Worker
 * Bridges Chrome/Edge content scripts & popup with the local agytrans server.
 * Handles Context Menus (Full page translation, Selection translation, Restore page).
 */

const DEFAULT_MODEL = 'gemini-3.8-flash-tiered';
const DEFAULT_PORT = 47821;
const PORT_RANGE = 12;

let cachedPort = DEFAULT_PORT;

// Restrict secret storage to trusted extension contexts only (MV3)
function initStorageAccess() {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && typeof chrome.storage.local.setAccessLevel === 'function') {
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  }
}
initStorageAccess();

/**
 * Web Crypto HMAC-SHA256 helper
 */
async function hmacSha256(keyStr, dataStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(dataStr));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function generateRandomNonce(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function getExtensionOrigin() {
  return chrome.runtime.getURL('').replace(/\/$/, '');
}

async function getStoredSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({
      modelId: DEFAULT_MODEL,
      targetLang: 'zh-TW',
      serverPort: DEFAULT_PORT,
      autoShowIcon: true,
      closeOnCopy: true,
      disabledDomains: [],
      disableCache: false
    }, (items) => {
      resolve(items);
    });
  });
}

async function getPairedCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      paired: false,
      clientId: null,
      token: null,
      secret: null,
      serverPort: DEFAULT_PORT
    }, (items) => {
      resolve(items);
    });
  });
}

async function clearPairedCredentials() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(['paired', 'clientId', 'token', 'secret', 'serverPort'], () => {
      resolve();
    });
  });
}

function isUrlDisabled(urlStr, disabledDomains) {
  if (!urlStr || !Array.isArray(disabledDomains) || !disabledDomains.length) return false;
  try {
    const parsed = new URL(urlStr);
    const hostname = (parsed.hostname || '').toLowerCase();
    return disabledDomains.some((d) => {
      const domain = (d || '').trim().toLowerCase();
      return domain && (hostname === domain || hostname.endsWith('.' + domain));
    });
  } catch (e) {
    return false;
  }
}

function isOptionsPageSender(sender) {
  if (!sender || !sender.url) return false;
  try {
    const senderUrl = new URL(sender.url);
    const expectedUrl = new URL(chrome.runtime.getURL('options/options.html'));
    return senderUrl.protocol === 'chrome-extension:' &&
           senderUrl.origin === expectedUrl.origin &&
           senderUrl.pathname === expectedUrl.pathname;
  } catch (e) {
    return false;
  }
}

/**
 * Scan for running agytrans service in parallel
 */
async function findActivePort(basePort, exactPort = false) {
  const portsToTry = exactPort ? [basePort] : [cachedPort];
  if (!exactPort) {
    for (let p = basePort; p < Math.min(basePort + PORT_RANGE, 65536); p++) {
      if (!portsToTry.includes(p)) portsToTry.push(p);
    }
  }

  const checkPort = async (port) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 700);
      const res = await fetch(`http://127.0.0.1:${port}/ping`, {
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error'
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const json = await res.json();
        if (json && json.app === 'agy-translate') {
          return port;
        }
      }
    } catch (e) {}
    return null;
  };

  const results = await Promise.all(portsToTry.map(checkPort));
  const active = results.find((p) => p !== null);
  if (active) {
    cachedPort = active;
    return active;
  }
  return null;
}

/**
 * Challenge-response verification of server identity using paired secret.
 * Binds listening port, extension origin, and fresh nonce (anti-relay proof).
 */
async function verifyServer(port, creds) {
  if (!creds || !creds.clientId || !creds.secret) return false;
  const origin = getExtensionOrigin();
  const nonce = generateRandomNonce(16);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/verify?client_id=${encodeURIComponent(creds.clientId)}&nonce=${nonce}`, {
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error'
    });
    clearTimeout(timeoutId);
    if (!res.ok) return false;
    const data = await res.json();
    if (!data || data.status !== 'ok' || !data.proof) return false;

    const expectedProof = await hmacSha256(creds.secret, `agy-service-proof-v1:${port}:${origin}:${nonce}`);
    return data.proof.toLowerCase() === expectedProof.toLowerCase();
  } catch (e) {
    return false;
  }
}

/**
 * Bootstrap pairing protocol:
 * Authenticates server using out-of-band high-entropy code without transmitting code in plaintext,
 * then redeems pairing proof.
 */
async function pairWithServer(pairingCode, targetPort) {
  const code = (pairingCode || '').trim().toUpperCase();
  if (!code || code.length < 8) {
    return { success: false, error: 'Pairing code is invalid' };
  }
  const port = targetPort || DEFAULT_PORT;
  const origin = getExtensionOrigin();
  const clientNonce = generateRandomNonce(16);

  try {
    // Step 1: Initialize pairing session & request server proof
    const initController = new AbortController();
    const initTimeout = setTimeout(() => initController.abort(), 5000);
    const initRes = await fetch(`http://127.0.0.1:${port}/api/pair/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_nonce: clientNonce }),
      cache: 'no-store',
      redirect: 'error',
      signal: initController.signal
    });
    clearTimeout(initTimeout);
    if (!initRes.ok) {
      const errJson = await initRes.json().catch(() => ({}));
      return { success: false, error: errJson.message || `Server returned HTTP ${initRes.status}` };
    }
    const initData = await initRes.json();
    const serverNonce = initData.server_nonce;
    const serverProof = initData.server_proof;

    // Verify server proof (authenticates server to extension)
    const expectedServerProof = await hmacSha256(code, `agy-pair-server-proof-v1:${port}:${origin}:${clientNonce}:${serverNonce}`);
    if (!serverProof || serverProof.toLowerCase() !== expectedServerProof.toLowerCase()) {
      return {
        success: false,
        error: `Server identity verification failed on port ${port}. Listener does not possess valid pairing code or port relay was attempted.`
      };
    }

    // Step 2: Authenticated redeem (client proves knowledge without revealing code in plaintext)
    const clientProof = await hmacSha256(code, `agy-pair-client-redeem-v1:${port}:${origin}:${clientNonce}:${serverNonce}`);
    const redeemController = new AbortController();
    const redeemTimeout = setTimeout(() => redeemController.abort(), 5000);
    const redeemRes = await fetch(`http://127.0.0.1:${port}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_nonce: clientNonce,
        server_nonce: serverNonce,
        client_proof: clientProof
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: redeemController.signal
    });
    clearTimeout(redeemTimeout);

    if (!redeemRes.ok) {
      const errJson = await redeemRes.json().catch(() => ({}));
      return { success: false, error: errJson.message || `Pairing redemption failed with HTTP ${redeemRes.status}` };
    }

    const creds = await redeemRes.json();
    if (creds.status !== 'paired' || !creds.token || !creds.secret) {
      return { success: false, error: 'Malformed pairing response received from local service' };
    }

    // Store in chrome.storage.local (restricted to trusted contexts)
    await new Promise((resolve) => {
      chrome.storage.local.set({
        paired: true,
        clientId: creds.client_id,
        token: creds.token,
        secret: creds.secret,
        serverPort: port
      }, resolve);
    });

    return { success: true, clientId: creds.client_id };
  } catch (err) {
    return { success: false, error: `Connection failed: ${err.message || err}` };
  }
}

/**
 * Unpair extension - verifies server proof BEFORE transmitting bearer token
 */
async function unpairServer() {
  const creds = await getPairedCredentials();
  if (creds && creds.token && creds.clientId) {
    const port = creds.serverPort || DEFAULT_PORT;
    const isVerified = await verifyServer(port, creds);
    if (isVerified) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        await fetch(`http://127.0.0.1:${port}/api/auth/unpair`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creds.token}`
          },
          body: JSON.stringify({ client_id: creds.clientId }),
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal
        });
        clearTimeout(timeoutId);
      } catch (e) {}
    }
  }
  await clearPairedCredentials();
  return { success: true };
}

/**
 * Clear local translation cache on server - verifies server proof BEFORE transmitting bearer token
 */
async function clearServerCache() {
  const creds = await getPairedCredentials();
  if (!creds || !creds.paired || !creds.token) {
    return { success: false, error: 'Extension not paired' };
  }
  const port = creds.serverPort || DEFAULT_PORT;
  const isVerified = await verifyServer(port, creds);
  if (!isVerified) {
    return {
      success: false,
      error: `Local service verification failed on port ${port}. Request aborted to protect credentials.`
    };
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`http://127.0.0.1:${port}/api/cache/clear`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creds.token}`
      },
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    return { success: res.ok, clearedCount: data.cleared_count || 0 };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Single translation (Auto-detect -> Target Language)
 */
async function handleTranslate(text, targetLang = 'zh-TW', senderUrl = null) {
  const settings = await getStoredSettings();

  // Centralized disabled domain check
  if (senderUrl && isUrlDisabled(senderUrl, settings.disabledDomains)) {
    return {
      status: 'domain_disabled',
      message: 'Translation is disabled on this domain in extension settings.'
    };
  }

  const creds = await getPairedCredentials();
  if (!creds || !creds.paired || !creds.token) {
    return {
      status: 'not_paired',
      message: 'Extension is not paired with local agytrans service. Please pair in Options.'
    };
  }

  const basePort = creds.serverPort || settings.serverPort || DEFAULT_PORT;
  const lang = targetLang || settings.targetLang || 'zh-TW';

  const port = await findActivePort(basePort);
  if (!port) {
    return {
      status: 'server_offline',
      message: `Cannot connect to local agytrans service on port ${basePort}.`
    };
  }

  // Verify server proof BEFORE sending private translation text or credentials
  const isVerified = await verifyServer(port, creds);
  if (!isVerified) {
    return {
      status: 'server_unverified',
      message: `Local service verification failed on port ${port}. Request aborted to protect privacy.`
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const res = await fetch(`http://127.0.0.1:${port}/api/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creds.token}`
      },
      body: JSON.stringify({
        text,
        target_lang: lang,
        model: settings.modelId?.trim() || DEFAULT_MODEL,
        no_cache: Boolean(settings.disableCache)
      }),
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error'
    });
    clearTimeout(timeoutId);

    if (res.status === 401) {
      await clearPairedCredentials();
      return { status: 'not_paired', message: 'Pairing authorization revoked or invalid. Please re-pair in Options.' };
    }

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
async function handleTranslateBatch(texts, targetLang = 'zh-TW', senderUrl = null) {
  const settings = await getStoredSettings();

  // Centralized disabled domain check
  if (senderUrl && isUrlDisabled(senderUrl, settings.disabledDomains)) {
    return {
      status: 'domain_disabled',
      message: 'Translation is disabled on this domain in extension settings.'
    };
  }

  const creds = await getPairedCredentials();
  if (!creds || !creds.paired || !creds.token) {
    return {
      status: 'not_paired',
      message: 'Extension is not paired with local agytrans service. Please pair in Options.'
    };
  }

  const basePort = creds.serverPort || settings.serverPort || DEFAULT_PORT;
  const lang = targetLang || settings.targetLang || 'zh-TW';

  const port = await findActivePort(basePort);
  if (!port) {
    return {
      status: 'server_offline',
      message: `Cannot connect to local agytrans service on port ${basePort}.`
    };
  }

  // Verify server proof BEFORE sending batch translation text
  const isVerified = await verifyServer(port, creds);
  if (!isVerified) {
    return {
      status: 'server_unverified',
      message: `Local service verification failed on port ${port}. Request aborted to protect privacy.`
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const res = await fetch(`http://127.0.0.1:${port}/api/translate_batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creds.token}`
      },
      body: JSON.stringify({
        texts,
        target_lang: lang,
        model: settings.modelId?.trim() || DEFAULT_MODEL,
        no_cache: Boolean(settings.disableCache)
      }),
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error'
    });
    clearTimeout(timeoutId);

    if (res.status === 401) {
      await clearPairedCredentials();
      return { status: 'not_paired', message: 'Pairing authorization revoked or invalid. Please re-pair in Options.' };
    }

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
  initStorageAccess();
  setupContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  initStorageAccess();
  setupContextMenus();
});

// Handle Context Menu item clicks with disabledDomains check
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;

  const sendSafeTabMessage = (msg) => {
    try {
      chrome.tabs.sendMessage(tab.id, msg, () => {
        if (chrome.runtime.lastError) {}
      });
    } catch (e) {}
  };

  // Restore original page is ALWAYS permitted even if domain was newly added to disabled list
  if (info.menuItemId === 'agy-restore-full-page') {
    sendSafeTabMessage({ type: 'RESTORE_ORIGINAL_PAGE' });
    return;
  }

  getStoredSettings().then((settings) => {
    if (tab.url && isUrlDisabled(tab.url, settings.disabledDomains)) {
      return;
    }

    if (info.menuItemId === 'agy-translate-full-page') {
      sendSafeTabMessage({ type: 'START_FULL_PAGE_TRANSLATION' });
    } else if (info.menuItemId === 'agy-translate-selection') {
      sendSafeTabMessage({ type: 'TRIGGER_SHORTCUT_TRANSLATE' });
    }
  });
});

// Message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Security: Reject any message from external/unauthorized extensions
  if (sender && sender.id && sender.id !== chrome.runtime.id) {
    return;
  }

  // Critical requirement 4: Restrict pairing and settings management messages strictly to options page
  const isOptions = isOptionsPageSender(sender);

  if (request.type === 'PAIR_EXTENSION') {
    if (!isOptions) {
      sendResponse({ success: false, error: 'Unauthorized sender: restricted to options page' });
      return true;
    }
    pairWithServer(request.code, request.serverPort).then(sendResponse);
    return true;
  }

  if (request.type === 'UNPAIR_EXTENSION') {
    if (!isOptions) {
      sendResponse({ success: false, error: 'Unauthorized sender: restricted to options page' });
      return true;
    }
    unpairServer().then(sendResponse);
    return true;
  }

  if (request.type === 'GET_PAIRING_STATUS') {
    if (!isOptions) {
      sendResponse({ success: false, error: 'Unauthorized sender: restricted to options page' });
      return true;
    }
    getPairedCredentials().then((creds) => {
      sendResponse({
        paired: Boolean(creds && creds.paired),
        clientId: creds ? creds.clientId : null,
        serverPort: creds ? creds.serverPort : DEFAULT_PORT
      });
    });
    return true;
  }

  if (request.type === 'CLEAR_CACHE') {
    if (!isOptions) {
      sendResponse({ success: false, error: 'Unauthorized sender: restricted to options page' });
      return true;
    }
    clearServerCache().then(sendResponse);
    return true;
  }

  if (request.type === 'SAVE_SETTINGS') {
    if (!isOptions) {
      sendResponse({ success: false, error: 'Unauthorized sender: restricted to options page' });
      return true;
    }
    chrome.storage.sync.set(request.settings, () => {
      // Broadcast settings update to active tabs so content scripts refresh privacy filtering
      try {
        chrome.tabs.query({}, (tabs) => {
          for (const tab of tabs || []) {
            if (tab && tab.id) {
              try {
                chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: request.settings }, () => {
                  if (chrome.runtime.lastError) {}
                });
              } catch (e) {}
            }
          }
        });
      } catch (e) {}
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'TRANSLATE') {
    const senderUrl = (sender.tab && sender.tab.url) || sender.url || null;
    handleTranslate(request.text, request.targetLang, senderUrl).then(sendResponse);
    return true;
  }

  if (request.type === 'TRANSLATE_BATCH') {
    const senderUrl = (sender.tab && sender.tab.url) || sender.url || null;
    handleTranslateBatch(request.texts, request.targetLang, senderUrl).then(sendResponse);
    return true;
  }

  if (request.type === 'CHECK_SERVER') {
    const explicitPort = isOptions && Number.isInteger(request.serverPort)
      && request.serverPort >= 1024 && request.serverPort <= 65535;
    getStoredSettings()
      .then((s) => findActivePort(explicitPort ? request.serverPort : (s.serverPort || DEFAULT_PORT), explicitPort))
      .then(async (port) => {
        if (!port) {
          sendResponse({ online: false, verified: false, port: null });
          return;
        }
        const creds = await getPairedCredentials();
        const verified = creds.paired ? await verifyServer(port, creds) : false;
        sendResponse({ online: true, verified, port, paired: Boolean(creds.paired) });
      });
    return true;
  }

  if (request.type === 'GET_SETTINGS') {
    // Only return user UI settings from storage.sync, never credentials
    getStoredSettings().then(sendResponse);
    return true;
  }
});

// Shortcut command trigger with disabledDomains check
chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-translate') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id) {
        getStoredSettings().then((settings) => {
          if (tabs[0].url && isUrlDisabled(tabs[0].url, settings.disabledDomains)) {
            return;
          }
          try {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'TRIGGER_SHORTCUT_TRANSLATE' }, () => {
              if (chrome.runtime.lastError) {}
            });
          } catch (e) {}
        });
      }
    });
  }
});
