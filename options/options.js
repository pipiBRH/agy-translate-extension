document.addEventListener('DOMContentLoaded', () => {
  const targetLang = document.getElementById('targetLang');
  const serverPort = document.getElementById('serverPort');
  const autoShowIcon = document.getElementById('autoShowIcon');
  const closeOnCopy = document.getElementById('closeOnCopy');
  const btnTestConn = document.getElementById('btnTestConn');
  const connStatus = document.getElementById('connStatus');
  const btnSave = document.getElementById('btnSave');
  const saveToast = document.getElementById('saveToast');

  // Load existing settings
  chrome.storage.sync.get({
    targetLang: 'zh-TW',
    serverPort: 47821,
    autoShowIcon: true,
    closeOnCopy: true
  }, (items) => {
    targetLang.value = items.targetLang || 'zh-TW';
    serverPort.value = items.serverPort || 47821;
    autoShowIcon.checked = items.autoShowIcon !== false;
    closeOnCopy.checked = items.closeOnCopy !== false;
  });

  // Test connection
  btnTestConn.addEventListener('click', () => {
    const port = parseInt(serverPort.value, 10) || 47821;
    connStatus.textContent = `Testing connection to http://127.0.0.1:${port}…`;
    connStatus.className = 'status-msg';

    fetch(`http://127.0.0.1:${port}/ping`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (data.app === 'agy-translate') {
          connStatus.textContent = `✅ Connected! agytrans service is running (Port: ${port})`;
          connStatus.className = 'status-msg ok';
        } else {
          connStatus.textContent = `⚠️ Port ${port} responded, but not with agytrans service`;
          connStatus.className = 'status-msg err';
        }
      })
      .catch((err) => {
        connStatus.textContent = `❌ Cannot connect to 127.0.0.1:${port}. Please check if the local service is running.`;
        connStatus.className = 'status-msg err';
      });
  });

  // Save settings
  btnSave.addEventListener('click', () => {
    const settings = {
      targetLang: targetLang.value,
      serverPort: parseInt(serverPort.value, 10) || 47821,
      autoShowIcon: autoShowIcon.checked,
      closeOnCopy: closeOnCopy.checked
    };

    chrome.storage.sync.set(settings, () => {
      saveToast.classList.add('show');
      setTimeout(() => saveToast.classList.remove('show'), 1800);
    });
  });
});
