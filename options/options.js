document.addEventListener('DOMContentLoaded', () => {
  const DEFAULT_MODEL = 'gemini-3.8-flash-tiered';
  const modelId = document.getElementById('modelId');
  const targetLang = document.getElementById('targetLang');
  const serverPort = document.getElementById('serverPort');
  const autoShowIcon = document.getElementById('autoShowIcon');
  const closeOnCopy = document.getElementById('closeOnCopy');
  const disableCache = document.getElementById('disableCache');
  const disabledDomains = document.getElementById('disabledDomains');
  const btnTestConn = document.getElementById('btnTestConn');
  const connStatus = document.getElementById('connStatus');
  const btnClearCache = document.getElementById('btnClearCache');
  const cacheStatus = document.getElementById('cacheStatus');
  const btnSave = document.getElementById('btnSave');
  const saveToast = document.getElementById('saveToast');

  const pairingBadge = document.getElementById('pairingBadge');
  const pairingCode = document.getElementById('pairingCode');
  const btnPair = document.getElementById('btnPair');
  const btnUnpair = document.getElementById('btnUnpair');
  const pairInputRow = document.getElementById('pairInputRow');
  const pairActionRow = document.getElementById('pairActionRow');
  const pairingMsg = document.getElementById('pairingMsg');

  function updatePairingUI() {
    chrome.runtime.sendMessage({ type: 'GET_PAIRING_STATUS' }, (res) => {
      if (res && res.paired) {
        pairingBadge.textContent = `✅ Paired with local service (Client: ${res.clientId || 'active'})`;
        pairingBadge.className = 'status-msg ok';
        pairInputRow.style.display = 'none';
        pairActionRow.style.display = 'block';
        pairingMsg.textContent = '';
      } else {
        pairingBadge.textContent = '❌ Not paired with local service';
        pairingBadge.className = 'status-msg err';
        pairInputRow.style.display = 'flex';
        pairActionRow.style.display = 'none';
      }
    });
  }

  // Load existing settings
  chrome.storage.sync.get({
    modelId: DEFAULT_MODEL,
    targetLang: 'zh-TW',
    serverPort: 47821,
    autoShowIcon: true,
    closeOnCopy: true,
    disableCache: false,
    disabledDomains: []
  }, (items) => {
    modelId.value = items.modelId || DEFAULT_MODEL;
    targetLang.value = items.targetLang || 'zh-TW';
    serverPort.value = items.serverPort || 47821;
    autoShowIcon.checked = items.autoShowIcon !== false;
    closeOnCopy.checked = items.closeOnCopy !== false;
    if (disableCache) disableCache.checked = Boolean(items.disableCache);
    if (disabledDomains) disabledDomains.value = Array.isArray(items.disabledDomains) ? items.disabledDomains.join('\n') : '';
  });

  updatePairingUI();

  // Pair button
  btnPair.addEventListener('click', () => {
    const code = pairingCode.value.trim();
    if (!code) {
      pairingMsg.textContent = '⚠️ Please enter the code from terminal.';
      pairingMsg.className = 'status-msg err';
      return;
    }
    const port = parseInt(serverPort.value, 10) || 47821;
    pairingMsg.textContent = 'Authenticating server and pairing…';
    pairingMsg.className = 'status-msg';

    chrome.runtime.sendMessage({ type: 'PAIR_EXTENSION', code, serverPort: port }, (res) => {
      if (res && res.success) {
        pairingMsg.textContent = '✅ Paired successfully!';
        pairingMsg.className = 'status-msg ok';
        pairingCode.value = '';
        updatePairingUI();
      } else {
        pairingMsg.textContent = `❌ Pairing failed: ${(res && res.error) || 'Unknown error'}`;
        pairingMsg.className = 'status-msg err';
      }
    });
  });

  // Unpair button
  btnUnpair.addEventListener('click', () => {
    if (!confirm('Are you sure you want to disconnect / unpair this extension?')) return;
    chrome.runtime.sendMessage({ type: 'UNPAIR_EXTENSION' }, (res) => {
      pairingMsg.textContent = 'Disconnected. Extension is now unpaired.';
      pairingMsg.className = 'status-msg';
      updatePairingUI();
    });
  });

  // Clear cache button
  if (btnClearCache) {
    btnClearCache.addEventListener('click', () => {
      cacheStatus.textContent = 'Clearing translation cache…';
      cacheStatus.className = 'status-msg';
      chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, (res) => {
        if (res && res.success) {
          cacheStatus.textContent = `✅ Cache cleared (${res.clearedCount || 0} entries removed)`;
          cacheStatus.className = 'status-msg ok';
        } else {
          cacheStatus.textContent = `❌ Failed to clear cache: ${(res && res.error) || 'Not paired or server offline'}`;
          cacheStatus.className = 'status-msg err';
        }
      });
    });
  }

  // Test connection
  btnTestConn.addEventListener('click', () => {
    const port = parseInt(serverPort.value, 10) || 47821;
    connStatus.textContent = `Testing connection to http://127.0.0.1:${port}…`;
    connStatus.className = 'status-msg';

    chrome.runtime.sendMessage({ type: 'CHECK_SERVER', serverPort: port }, (res) => {
      if (res && res.online) {
        const verifiedText = res.verified ? ' [Cryptographically Verified ✅]' : ' [Unverified ⚠️]';
        connStatus.textContent = `✅ Connected to port ${res.port}${verifiedText}`;
        connStatus.className = res.verified ? 'status-msg ok' : 'status-msg';
      } else {
        connStatus.textContent = `❌ Cannot connect to 127.0.0.1:${port}. Please check if the local service is running.`;
        connStatus.className = 'status-msg err';
      }
    });
  });

  // Save settings
  btnSave.addEventListener('click', () => {
    const domainList = disabledDomains
      ? disabledDomains.value
          .split('\n')
          .map((d) => d.trim().toLowerCase())
          .filter((d) => d.length > 0)
      : [];

    const settings = {
      modelId: modelId.value.trim() || DEFAULT_MODEL,
      targetLang: targetLang.value,
      serverPort: parseInt(serverPort.value, 10) || 47821,
      autoShowIcon: autoShowIcon.checked,
      closeOnCopy: closeOnCopy.checked,
      disableCache: disableCache ? disableCache.checked : false,
      disabledDomains: domainList
    };

    chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }, () => {
      modelId.value = settings.modelId;
      saveToast.classList.add('show');
      setTimeout(() => saveToast.classList.remove('show'), 1800);
    });
  });
});
