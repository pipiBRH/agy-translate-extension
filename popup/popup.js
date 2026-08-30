document.addEventListener('DOMContentLoaded', () => {
  const srcInput = document.getElementById('srcInput');
  const charCount = document.getElementById('charCount');
  const serverStatus = document.getElementById('serverStatus');
  const resultContainer = document.getElementById('resultContainer');
  const btnTranslate = document.getElementById('btnTranslate');
  const btnTranslateLabel = document.getElementById('btnTranslateLabel');
  const toastEl = document.getElementById('toast');

  let targetLang = 'zh-TW';

  const LANG_NAMES = {
    'zh-TW': '繁體中文',
    'zh-CN': '簡體中文',
    'en': 'English',
    'ja': '日本語',
    'ko': '한국어',
    'es': 'Español',
    'fr': 'Français',
    'de': 'Deutsch'
  };

  chrome.storage.sync.get({ targetLang: 'zh-TW' }, (items) => {
    targetLang = items.targetLang || 'zh-TW';
    btnTranslateLabel.textContent = `Translate to ${LANG_NAMES[targetLang] || targetLang}`;
  });

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('on'), 1400);
  }

  // Check server health
  chrome.runtime.sendMessage({ type: 'CHECK_SERVER' }, (res) => {
    if (res && res.online) {
      serverStatus.textContent = `Online (:${res.port})`;
      serverStatus.className = 'status-badge online';
    } else {
      serverStatus.textContent = 'Offline';
      serverStatus.className = 'status-badge offline';
    }
  });

  srcInput.addEventListener('input', () => {
    charCount.textContent = `${srcInput.value.length} chars`;
  });

  srcInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      triggerTranslate();
    }
  });

  btnTranslate.addEventListener('click', triggerTranslate);

  function triggerTranslate() {
    const text = srcInput.value.trim();
    if (!text) {
      srcInput.focus();
      return;
    }
    runTranslate(text);
  }

  function runTranslate(text) {
    const targetName = LANG_NAMES[targetLang] || targetLang;
    resultContainer.innerHTML = `
      <div class="spinner"></div>
      <div class="loading-label">Translating to ${escapeHTML(targetName)}…</div>
    `;

    chrome.runtime.sendMessage({ type: 'TRANSLATE', text, targetLang }, (res) => {
      if (!res) {
        resultContainer.innerHTML = `<div class="loading-label" style="color:#ff453a;">No response received</div>`;
        return;
      }

      if (res.status === 'done' && res.data) {
        renderResults(res.data);
      } else {
        resultContainer.innerHTML = `<div class="loading-label" style="color:#ff453a;">${escapeHTML(res.message || 'Error occurred')}</div>`;
      }
    });
  }

  function renderResults(data) {
    resultContainer.innerHTML = '';

    if (data.primary) {
      const p = document.createElement('div');
      p.className = 'card primary';
      p.innerHTML = `
        <div class="card-top">
          <span class="badge">★ Main</span>
          <span class="note"><span class="dot t-neutral"></span>${escapeHTML(data.primary.note || 'neutral · safe')}</span>
        </div>
        <div class="card-text">${escapeHTML((data.primary.text || '').trim())}</div>
      `;
      p.addEventListener('click', () => copyText(data.primary.text));
      resultContainer.appendChild(p);
    }

    (data.alts || []).forEach((alt) => {
      const a = document.createElement('div');
      a.className = 'card';
      const tone = alt.tone || 'neutral';
      a.innerHTML = `
        <div class="card-top">
          <span class="num">${alt.n}</span>
          <span class="note"><span class="dot t-${tone}"></span>${escapeHTML(alt.note || '')}</span>
        </div>
        <div class="card-text">${escapeHTML((alt.text || '').trim())}</div>
      `;
      a.addEventListener('click', () => copyText(alt.text));
      resultContainer.appendChild(a);
    });
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied');
    } catch (e) {
      showToast('Copy failed');
    }
  }

  function escapeHTML(str) {
    return (str || '').replace(/[&<>'"]/g, (tag) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }
});
