/**
 * agy Translate - Content Script
 * Auto-detect Source Language -> Target Language Translation
 * Single-click Floating Button & Glassmorphism Card (Shadow DOM)
 */

(function () {
  if (window.__AGY_TRANSLATE_LOADED__) return;
  window.__AGY_TRANSLATE_LOADED__ = true;

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

  const ICONS = {
    translateLogo: `
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m5 8 6 6"/>
        <path d="m4 14 6-6 2-3"/>
        <path d="M2 5h12"/>
        <path d="M7 2h1"/>
        <path d="m22 22-5-10-5 10"/>
        <path d="M14 18h6"/>
      </svg>`,
    speaker: `
      <svg viewBox="0 0 18 16" width="13" height="13" aria-hidden="true">
        <path d="M9.1 2.2 5.6 5H3.1c-.6 0-1 .4-1 1v4c0 .6.4 1 1 1h2.5l3.5 2.8c.4.3 1 .1 1-.4V2.6c0-.5-.6-.7-1-.4z" fill="currentColor"/>
        <path class="wave" d="M12.4 5.8c.9.5 1.5 1.3 1.5 2.2s-.6 1.7-1.5 2.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>
        <path class="wave far" d="M14.6 3.6c1.4 1 2.3 2.6 2.3 4.4s-.9 3.4-2.3 4.4" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/>
      </svg>`,
    pin: `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 17v5"/>
        <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/>
        <path d="M6 8v1a6 6 0 0 0 3 5.2V17h6v-2.8A6 6 0 0 0 18 9V8H6z"/>
      </svg>`,
    close: `
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>`,
    copy: `
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect width="13" height="13" x="9" y="9" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>`
  };

  let hostEl = null;
  let shadow = null;
  let floatingBtn = null;
  let modalCard = null;
  let toastEl = null;
  let activeSelection = '';
  let isPinned = false;
  let cards = [];
  let availableVoices = [];
  let speakingBtn = null;
  let userSettings = {
    targetLang: 'zh-TW',
    autoShowIcon: true,
    closeOnCopy: true,
    disabledDomains: []
  };

  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    try {
      availableVoices = (window.speechSynthesis.getVoices() || []).filter(
        (v) => v.localService && !/^Google/i.test(v.name || '')
      );
    } catch (e) {
      availableVoices = [];
    }
  }

  if ('speechSynthesis' in window) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  function pickVoice(langCode) {
    const prefix = (langCode || 'zh').toLowerCase().split('-')[0];
    const pool = availableVoices.filter((v) => (v.lang || '').toLowerCase().startsWith(prefix));
    if (!pool.length) return availableVoices[0] || null;
    return pool.find((v) => v.default) || pool[0];
  }

  function stopSpeaking() {
    if (speakingBtn) {
      speakingBtn.classList.remove('speaking');
      speakingBtn = null;
    }
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch (e) {}
  }

  function speakText(text, langCode, btn) {
    if (!('speechSynthesis' in window)) return showToast('Speech synthesis not supported');
    if (speakingBtn === btn) return stopSpeaking();
    stopSpeaking();

    const voice = pickVoice(langCode);
    const utterance = new SpeechSynthesisUtterance(text);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = text.length <= 6 ? 0.88 : 0.98;

    utterance.onend = utterance.onerror = () => {
      if (speakingBtn === btn) stopSpeaking();
    };

    speakingBtn = btn;
    btn.classList.add('speaking');
    setTimeout(() => {
      if (speakingBtn !== btn) return;
      try {
        window.speechSynthesis.speak(utterance);
      } catch (e) {
        stopSpeaking();
      }
    }, 60);
  }

  function isExtensionValid() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
  }

  function safeSendMessage(payload, callback) {
    if (!isExtensionValid()) {
      showToast('Extension updated. Please refresh this webpage (⌘R)');
      if (callback) callback(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(payload, (res) => {
        if (!isExtensionValid() || chrome.runtime.lastError) {
          if (callback) callback(null);
          return;
        }
        if (callback) callback(res);
      });
    } catch (err) {
      if (err.message && err.message.includes('Extension context invalidated')) {
        showToast('Extension updated. Please refresh this webpage (⌘R)');
      }
      if (callback) callback(null);
    }
  }

  function fetchSettings() {
    safeSendMessage({ type: 'GET_SETTINGS' }, (settings) => {
      if (settings) userSettings = { ...userSettings, ...settings };
    });
  }
  fetchSettings();

  function ensureShadowDOM() {
    if (hostEl && shadow) return;
    hostEl = document.createElement('div');
    hostEl.id = 'agy-translate-extension-host';
    hostEl.style.cssText = 'all: initial; position: absolute; top: 0; left: 0; z-index: 2147483647; pointer-events: none;';
    document.documentElement.appendChild(hostEl);

    shadow = hostEl.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = getStyles();
    shadow.appendChild(style);

    toastEl = document.createElement('div');
    toastEl.className = 'agy-toast';
    shadow.appendChild(toastEl);
  }

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('visible'), 1500);
  }

  function showFloatingButton(rect, text) {
    ensureShadowDOM();
    hideFloatingButton();

    if (modalCard && !isPinned) hideModalCard();

    activeSelection = text;
    floatingBtn = document.createElement('div');
    floatingBtn.className = 'agy-float-container';

    floatingBtn.innerHTML = `
      <button class="agy-float-btn" title="Translate (agy Translate)" type="button">
        ${ICONS.translateLogo}
      </button>
    `;

    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    let posX = (rect.right || 0) + scrollX + 4;
    let posY = (rect.top || 0) + scrollY - 8;

    if (isNaN(posX) || isNaN(posY)) return;

    if (rect.top < 36) posY = (rect.bottom || 0) + scrollY + 6;
    if (rect.right > window.innerWidth - 60) posX = (rect.left || 0) + scrollX - 32;

    floatingBtn.style.left = `${Math.max(8, posX)}px`;
    floatingBtn.style.top = `${Math.max(8, posY)}px`;

    const mainBtn = floatingBtn.querySelector('.agy-float-btn');
    mainBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      executeTranslate(activeSelection, rect);
    });

    shadow.appendChild(floatingBtn);
  }

  function hideFloatingButton() {
    if (floatingBtn) {
      floatingBtn.remove();
      floatingBtn = null;
    }
  }

  function hideModalCard() {
    if (modalCard) {
      stopSpeaking();
      modalCard.remove();
      modalCard = null;
    }
  }

  async function copyText(text, el, keepOpen) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (_) {}
      ta.remove();
    }

    if (el) {
      el.classList.remove('agy-card-flash');
      void el.offsetWidth;
      el.classList.add('agy-card-flash');
    }

    if (keepOpen || !userSettings.closeOnCopy || isPinned) {
      showToast('Copied');
    } else {
      showToast('Copied — closing…');
      setTimeout(() => hideModalCard(), 280);
    }
  }

  function renderInlineMarkdown(text) {
    const esc = (text || '').replace(/[&<>'"]/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[m]));
    return esc
      .replace(/^[-*•]\s+/gm, '• ')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }

  function executeTranslate(text, anchorRect) {
    hideFloatingButton();
    ensureShadowDOM();
    hideModalCard();

    activeSelection = text;

    modalCard = document.createElement('div');
    modalCard.className = 'agy-modal-card';

    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    let cardLeft = (anchorRect ? anchorRect.left : window.innerWidth / 2 - 240) + scrollX;
    let cardTop = (anchorRect ? anchorRect.bottom + 8 : window.innerHeight / 2 - 180) + scrollY;

    const cardWidth = 480;
    const estimatedHeight = 360;

    // Flip above selection if too close to bottom of screen
    if (anchorRect && anchorRect.bottom + estimatedHeight > window.innerHeight && anchorRect.top > estimatedHeight + 20) {
      cardTop = anchorRect.top + scrollY - estimatedHeight - 10;
    }

    if (cardLeft + cardWidth > window.innerWidth + scrollX - 20) {
      cardLeft = window.innerWidth + scrollX - cardWidth - 20;
    }
    if (cardLeft < scrollX + 10) cardLeft = scrollX + 10;

    modalCard.style.left = `${cardLeft}px`;
    modalCard.style.top = `${cardTop}px`;

    const targetLang = userSettings.targetLang || 'zh-TW';
    renderLoadingUI(text, targetLang);
    shadow.appendChild(modalCard);

    setupDraggable(modalCard);

    safeSendMessage(
      { type: 'TRANSLATE', text, targetLang },
      (res) => {
        if (!modalCard) return;
        if (!res) {
          renderErrorUI('No response received from background service.');
          return;
        }
        if (res.status === 'done' && res.data) {
          renderResultUI(res.data, text, targetLang);
        } else if (res.status === 'needs_login') {
          renderNeedsLoginUI(res.message);
        } else if (res.status === 'server_offline') {
          renderServerOfflineUI(res.message);
        } else {
          renderErrorUI(res.message || 'An error occurred during translation.');
        }
      }
    );
  }

  function renderLoadingUI(text, targetLang) {
    const targetName = LANG_NAMES[targetLang] || targetLang;

    modalCard.innerHTML = `
      <div class="agy-card-header">
        <div class="agy-lang-indicator">
          <span class="agy-lang-auto">Auto</span>
          <span class="agy-lang-arrow">➔</span>
          <span class="agy-lang-target">${escapeHTML(targetName)}</span>
        </div>
        <div class="agy-header-actions">
          <button class="agy-btn-icon agy-pin-btn" title="Pin window">${ICONS.pin}</button>
          <button class="agy-btn-icon agy-close-btn" title="Close (Esc)">${ICONS.close}</button>
        </div>
      </div>
      <div class="agy-src-box">
        <div class="agy-src-text">${escapeHTML(text)}</div>
      </div>
      <div class="agy-loading-box">
        <div class="agy-spinner"></div>
        <div class="agy-loading-text">Translating with Gemini…</div>
        <div class="agy-loading-sub">Target: ${escapeHTML(targetName)}</div>
      </div>
    `;

    bindHeaderEvents();
  }

  function renderResultUI(data, text, targetLang) {
    cards = [];
    const targetName = LANG_NAMES[targetLang] || targetLang;

    modalCard.innerHTML = `
      <div class="agy-card-header">
        <div class="agy-lang-indicator">
          <span class="agy-lang-auto">Auto</span>
          <span class="agy-lang-arrow">➔</span>
          <span class="agy-lang-target">${escapeHTML(targetName)}</span>
        </div>
        <div class="agy-header-actions">
          <button class="agy-btn-icon agy-pin-btn ${isPinned ? 'active' : ''}" title="Pin window">${ICONS.pin}</button>
          <button class="agy-btn-icon agy-close-btn" title="Close (Esc)">${ICONS.close}</button>
        </div>
      </div>
      <div class="agy-src-box">
        <div class="agy-src-text">${escapeHTML(text)}</div>
        <button class="agy-speak-btn agy-src-speak" title="Read source aloud">${ICONS.speaker}</button>
      </div>
      <div class="agy-card-body"></div>
      <div class="agy-card-footer">
        <span><kbd>click</kbd> copy</span>
        <span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> copy line</span>
        <span><kbd>⌘</kbd>+click keep open</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    `;

    bindHeaderEvents();

    const srcSpeakBtn = modalCard.querySelector('.agy-src-speak');
    if (srcSpeakBtn) {
      srcSpeakBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        speakText(text, 'en', srcSpeakBtn);
      });
    }

    const bodyEl = modalCard.querySelector('.agy-card-body');

    // 1. Primary Translation Card
    if (data.primary) {
      const pCard = document.createElement('div');
      pCard.className = 'agy-item-card agy-primary';
      const pText = (data.primary.text || '').trim();
      pCard.innerHTML = `
        <div class="agy-item-top">
          <span class="agy-badge">★ Main</span>
          <span class="agy-note"><span class="agy-dot t-neutral"></span>${escapeHTML(data.primary.note || 'neutral · safe')}</span>
          <button class="agy-speak-btn" title="Read translation aloud">${ICONS.speaker}</button>
          <div class="agy-copy-indicator" title="Click to copy">${ICONS.copy}</div>
        </div>
        <div class="agy-item-text">${escapeHTML(pText)}</div>
      `;

      const speakBtn = pCard.querySelector('.agy-speak-btn');
      speakBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        speakText(pText, targetLang, speakBtn);
      });

      pCard.addEventListener('click', (e) => {
        copyText(pText, pCard, e.metaKey || e.altKey || isPinned);
      });

      bodyEl.appendChild(pCard);
      cards.push({ el: pCard, text: pText });
    }

    // 2. Alternative Phrasings (1, 2, 3)
    (data.alts || []).forEach((alt) => {
      const aCard = document.createElement('div');
      aCard.className = 'agy-item-card';
      const safeTone = ['casual', 'neutral', 'formal', 'terse'].includes(alt.tone) ? alt.tone : 'neutral';
      const aText = (alt.text || '').trim();
      aCard.innerHTML = `
        <div class="agy-item-top">
          <span class="agy-num">${parseInt(alt.n, 10) || ''}</span>
          <span class="agy-note"><span class="agy-dot t-${safeTone}"></span>${escapeHTML(alt.note || '')}</span>
          <button class="agy-speak-btn" title="Read aloud">${ICONS.speaker}</button>
          <div class="agy-copy-indicator" title="Click to copy">${ICONS.copy}</div>
        </div>
        <div class="agy-item-text">${escapeHTML(aText)}</div>
      `;

      const speakBtn = aCard.querySelector('.agy-speak-btn');
      speakBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        speakText(aText, targetLang, speakBtn);
      });

      aCard.addEventListener('click', (e) => {
        copyText(aText, aCard, e.metaKey || e.altKey || isPinned);
      });

      bodyEl.appendChild(aCard);
      cards.push({ el: aCard, text: aText });
    });

    // 3. Info / Notes
    (data.infos || []).forEach((info) => {
      const iCard = document.createElement('div');
      iCard.className = 'agy-item-card agy-info';
      iCard.innerHTML = `
        <div class="agy-item-top">
          <span class="agy-badge agy-badge-dim">💡 ${escapeHTML(info.title)}</span>
        </div>
        <div class="agy-item-text rich">${renderInlineMarkdown(info.text)}</div>
      `;
      bodyEl.appendChild(iCard);
    });
  }

  function renderServerOfflineUI(msg) {
    modalCard.innerHTML = `
      <div class="agy-card-header">
        <div class="agy-title">⚠️ Service Offline</div>
        <div class="agy-header-actions">
          <button class="agy-btn-icon agy-close-btn">${ICONS.close}</button>
        </div>
      </div>
      <div class="agy-error-box">
        <div class="agy-err-title">Cannot reach local agytrans service</div>
        <div class="agy-err-desc">The extension connects to the local agytrans service on port 47821. Run this command in Terminal:</div>
        <div class="agy-code-box">
          <code>./launchd/install_daemon.sh</code>
          <button class="agy-copy-cmd-btn">Copy Command</button>
        </div>
        <button class="agy-retry-btn">Retry</button>
      </div>
    `;

    bindHeaderEvents();

    const copyCmdBtn = modalCard.querySelector('.agy-copy-cmd-btn');
    if (copyCmdBtn) {
      copyCmdBtn.addEventListener('click', () => {
        const cmd = modalCard.querySelector('code').textContent;
        copyText(cmd, copyCmdBtn, true);
        showToast('Command copied');
      });
    }

    const retryBtn = modalCard.querySelector('.agy-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        executeTranslate(activeSelection, null);
      });
    }
  }

  function renderNeedsLoginUI(msg) {
    modalCard.innerHTML = `
      <div class="agy-card-header">
        <div class="agy-title">🔑 Sign-in Required</div>
        <div class="agy-header-actions">
          <button class="agy-btn-icon agy-close-btn">${ICONS.close}</button>
        </div>
      </div>
      <div class="agy-error-box">
        <div class="agy-err-title">Google Authentication Needed</div>
        <div class="agy-err-desc">Run this in your terminal to sign in:</div>
        <div class="agy-code-box">
          <code>python3 agytrans.py login</code>
          <button class="agy-copy-cmd-btn">Copy Command</button>
        </div>
      </div>
    `;

    bindHeaderEvents();
  }

  function renderErrorUI(msg) {
    modalCard.innerHTML = `
      <div class="agy-card-header">
        <div class="agy-title">❌ Translation Failed</div>
        <div class="agy-header-actions">
          <button class="agy-btn-icon agy-close-btn">${ICONS.close}</button>
        </div>
      </div>
      <div class="agy-error-box">
        <div class="agy-err-msg">${escapeHTML(msg)}</div>
        <button class="agy-retry-btn">Retry</button>
      </div>
    `;

    bindHeaderEvents();

    const retryBtn = modalCard.querySelector('.agy-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        executeTranslate(activeSelection, null);
      });
    }
  }

  function bindHeaderEvents() {
    if (!modalCard) return;

    const closeBtn = modalCard.querySelector('.agy-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideModalCard();
      });
    }

    const pinBtn = modalCard.querySelector('.agy-pin-btn');
    if (pinBtn) {
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isPinned = !isPinned;
        pinBtn.classList.toggle('active', isPinned);
        showToast(isPinned ? 'Window pinned' : 'Window unpinned');
      });
    }
  }

  function setupDraggable(el) {
    const header = el.querySelector('.agy-card-header');
    if (!header) return;

    let isDragging = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    header.style.cursor = 'grab';

    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      header.style.cursor = 'grabbing';
      startX = e.clientX;
      startY = e.clientY;
      initialLeft = parseInt(el.style.left, 10) || el.offsetLeft;
      initialTop = parseInt(el.style.top, 10) || el.offsetTop;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = `${initialLeft + dx}px`;
      el.style.top = `${initialTop + dy}px`;
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        header.style.cursor = 'grab';
      }
    });
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

  document.addEventListener('mouseup', (e) => {
    if (!isExtensionValid()) return;
    if (hostEl && (e.target === hostEl || hostEl.contains(e.target))) return;

    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';

      if (!text || text.length < 2) {
        hideFloatingButton();
        return;
      }

      // Security: Never trigger on password inputs or sensitive form fields
      if (sel.anchorNode) {
        const parent = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
        if (parent && parent.closest('input[type="password"], [data-sensitive], [autocomplete*="password"], [autocomplete*="cc-"], [autocomplete*="credit-card"]')) {
          hideFloatingButton();
          return;
        }
      }

      const currentHost = window.location.hostname;
      if ((userSettings.disabledDomains || []).includes(currentHost)) {
        return;
      }

      if (!userSettings.autoShowIcon) return;

      try {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          showFloatingButton(rect, text);
        }
      } catch (err) {}
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (!isExtensionValid()) return;
    if (hostEl && (e.target === hostEl || hostEl.contains(e.target))) return;
    hideFloatingButton();
    if (modalCard && !isPinned) {
      hideModalCard();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!isExtensionValid()) return;
    if (!modalCard) return;

    // Do not intercept keystrokes if the user is typing in an input, textarea, or contenteditable
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      if (e.key === 'Escape') hideModalCard();
      return;
    }

    if (e.key === 'Escape') {
      hideModalCard();
      return;
    }

    if (e.key === 'Enter' && cards[0]) {
      copyText(cards[0].text, cards[0].el);
      return;
    }

    const n = parseInt(e.key, 10);
    if (!isNaN(n) && n >= 1 && n <= 9 && cards[n]) {
      copyText(cards[n].text, cards[n].el, e.metaKey || e.altKey || isPinned);
    }
  });

  // Full Page Translation Engine (Pure TextNode in-place replacement)
  let pageTranslation = {
    isTranslating: false,
    isTranslated: false,
    isShowingOriginal: false,
    nodes: [],
    bannerEl: null
  };

  function showPageBanner(text, inProgress = false) {
    ensureShadowDOM();
    if (!pageTranslation.bannerEl) {
      pageTranslation.bannerEl = document.createElement('div');
      pageTranslation.bannerEl.className = 'agy-page-banner';
      shadow.appendChild(pageTranslation.bannerEl);
    }

    if (inProgress) {
      pageTranslation.bannerEl.innerHTML = `
        <div class="agy-spinner-sm"></div>
        <span class="agy-banner-title">${escapeHTML(text)}</span>
      `;
    } else {
      pageTranslation.bannerEl.innerHTML = `
        <div class="agy-banner-icon">${ICONS.translateLogo}</div>
        <span class="agy-banner-title">${escapeHTML(text)}</span>
        <button class="agy-banner-btn agy-banner-toggle-btn" type="button">
          ${pageTranslation.isShowingOriginal ? '🌐 Show Translation' : '↩️ Show Original'}
        </button>
        <button class="agy-banner-btn agy-banner-close-btn" title="Close banner" type="button">
          ${ICONS.close}
        </button>
      `;

      const toggleBtn = pageTranslation.bannerEl.querySelector('.agy-banner-toggle-btn');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          togglePageTranslation();
        });
      }

      const closeBtn = pageTranslation.bannerEl.querySelector('.agy-banner-close-btn');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          hidePageBanner();
        });
      }
    }
  }

  function hidePageBanner() {
    if (pageTranslation.bannerEl) {
      pageTranslation.bannerEl.remove();
      pageTranslation.bannerEl = null;
    }
  }

  function togglePageTranslation() {
    if (!pageTranslation.nodes.length) return;
    const targetName = LANG_NAMES[userSettings.targetLang] || userSettings.targetLang;
    if (pageTranslation.isShowingOriginal) {
      pageTranslation.nodes.forEach(({ node, origVal, transVal }) => {
        if (node && node.isConnected && transVal) {
          const leadingSpace = origVal.match(/^\s*/)[0];
          const trailingSpace = origVal.match(/\s*$/)[0];
          node.nodeValue = leadingSpace + transVal.trim() + trailingSpace;
        }
      });
      pageTranslation.isShowingOriginal = false;
      showPageBanner(`Page Translated (${targetName})`);
      showToast('Switched to translation');
    } else {
      pageTranslation.nodes.forEach(({ node, origVal }) => {
        if (node && node.isConnected && origVal) node.nodeValue = origVal;
      });
      pageTranslation.isShowingOriginal = true;
      showPageBanner('Original Page');
      showToast('Restored original text');
    }
  }

  function restoreOriginalPage() {
    if (pageTranslation.nodes.length) {
      pageTranslation.nodes.forEach(({ node, origVal }) => {
        if (node && node.isConnected && origVal) node.nodeValue = origVal;
      });
      pageTranslation.isShowingOriginal = true;
      showPageBanner('Original Page');
      showToast('Restored original text');
    } else {
      showToast('Page is not currently translated');
    }
  }

  function collectTranslatableTextNodes() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node || !node.nodeValue) return NodeFilter.FILTER_REJECT;
          const txt = node.nodeValue.trim();
          if (txt.length < 2 || !/[a-zA-Z\u3040-\u30ff\uac00-\ud7af\u4e00-\u9fff]/.test(txt)) {
            return NodeFilter.FILTER_REJECT;
          }

          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          if (parent.closest('pre, code, kbd, samp, script, style, svg, noscript, input, textarea, select, option, math, template, canvas, audio, video, object, embed, [contenteditable], [role="textbox"], #agy-translate-extension-host')) {
            return NodeFilter.FILTER_REJECT;
          }

          if (/^(https?:\/\/|\d+[\s\d:./-]*$)/.test(txt)) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const validNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      validNodes.push({
        node,
        origVal: node.nodeValue,
        transVal: ''
      });
    }
    return validNodes;
  }

  async function translateFullPage() {
    if (pageTranslation.isTranslating) {
      showToast('Page translation is already in progress…');
      return;
    }

    if (pageTranslation.isTranslated && pageTranslation.nodes.length) {
      if (pageTranslation.isShowingOriginal) {
        togglePageTranslation();
      } else {
        showToast('Page is already translated');
      }
      return;
    }

    const validNodes = collectTranslatableTextNodes();

    if (!validNodes.length) {
      showToast('No translatable text found on page');
      return;
    }

    const targetLang = userSettings.targetLang || 'zh-TW';
    const targetName = LANG_NAMES[targetLang] || targetLang;

    // Prioritize visible text nodes
    const vh = window.innerHeight;
    validNodes.sort((a, b) => {
      const pA = a.node.parentElement;
      const pB = b.node.parentElement;
      const rA = pA ? pA.getBoundingClientRect() : { top: 0 };
      const rB = pB ? pB.getBoundingClientRect() : { top: 0 };
      const inViewA = rA.top >= -100 && rA.top <= vh + 200;
      const inViewB = rB.top >= -100 && rB.top <= vh + 200;
      if (inViewA && !inViewB) return -1;
      if (!inViewA && inViewB) return 1;
      return rA.top - rB.top;
    });

    pageTranslation.isTranslating = true;
    pageTranslation.nodes = validNodes;
    const total = validNodes.length;
    let completed = 0;

    showPageBanner(`Translating page: 0 / ${total} (0%)`, true);

    const BATCH_SIZE = 120;
    const batches = [];
    for (let i = 0; i < validNodes.length; i += BATCH_SIZE) {
      batches.push(validNodes.slice(i, i + BATCH_SIZE));
    }

    const promises = batches.map(async (batch) => {
      const texts = batch.map((item) => item.origVal.trim());
      try {
        const res = await new Promise((resolve) => {
          safeSendMessage(
            { type: 'TRANSLATE_BATCH', texts, targetLang },
            resolve
          );
        });

        if (res && res.status === 'done' && Array.isArray(res.translations)) {
          batch.forEach((item, idx) => {
            const trans = res.translations[idx];
            if (trans && item.node && item.node.isConnected) {
              item.transVal = trans;
              const leadingSpace = item.origVal.match(/^\s*/)[0];
              const trailingSpace = item.origVal.match(/\s*$/)[0];
              item.node.nodeValue = leadingSpace + trans.trim() + trailingSpace;
            }
          });
        }
      } catch (err) {
        console.error('Batch translation error:', err);
      }

      completed += batch.length;
      const pct = Math.min(100, Math.round((completed / total) * 100));
      showPageBanner(`Translating page: ${completed} / ${total} (${pct}%)`, true);
    });

    await Promise.all(promises);

    pageTranslation.isTranslating = false;
    pageTranslation.isTranslated = true;
    pageTranslation.isShowingOriginal = false;

    showPageBanner(`Page Translated (${targetName})`, false);
    showToast('Page translation complete!');
  }

  chrome.runtime.onMessage.addListener((req) => {
    if (req.type === 'START_FULL_PAGE_TRANSLATION') {
      translateFullPage();
    } else if (req.type === 'RESTORE_ORIGINAL_PAGE') {
      restoreOriginalPage();
    } else if (req.type === 'TRIGGER_SHORTCUT_TRANSLATE') {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text && text.length >= 2) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        executeTranslate(text, rect);
      } else {
        showToast('Select text to translate first');
      }
    }
  });

  function getStyles() {
    return `
      :host {
        --bg-glass: rgba(255, 255, 255, 0.88);
        --bg-card: rgba(255, 255, 255, 0.95);
        --bg-card-hover: #f0f7ff;
        --bg-inset: rgba(0, 0, 0, 0.035);
        --border: rgba(0, 0, 0, 0.09);
        --border-strong: rgba(0, 0, 0, 0.16);
        --text: #1d1d1f;
        --text-dim: #6e6e73;
        --accent: #0071e3;
        --accent-hover: #0077ed;
        --accent-glow: rgba(0, 113, 227, 0.18);
        --shadow-floating: 0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
        --shadow-modal: 0 12px 36px rgba(0, 0, 0, 0.18), 0 3px 10px rgba(0, 0, 0, 0.08);
        --tone-casual: #30b053;
        --tone-neutral: #0a84ff;
        --tone-formal: #a24dd3;
        --tone-terse: #e88b00;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang TC", "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
        font-feature-settings: "cv02", "cv03", "cv04", "cv11";
      }

      @media (prefers-color-scheme: dark) {
        :host {
          --bg-glass: rgba(30, 30, 32, 0.88);
          --bg-card: rgba(44, 44, 46, 0.9);
          --bg-card-hover: rgba(58, 62, 70, 0.95);
          --bg-inset: rgba(255, 255, 255, 0.05);
          --border: rgba(255, 255, 255, 0.11);
          --border-strong: rgba(255, 255, 255, 0.22);
          --text: #f5f5f7;
          --text-dim: #98989d;
          --accent: #0a84ff;
          --accent-hover: #409cff;
          --accent-glow: rgba(10, 132, 255, 0.25);
          --shadow-floating: 0 6px 20px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.25);
          --shadow-modal: 0 16px 44px rgba(0, 0, 0, 0.55), 0 4px 14px rgba(0, 0, 0, 0.35);
          --tone-casual: #40d463;
          --tone-neutral: #4aa8ff;
          --tone-formal: #c07ae8;
          --tone-terse: #ffab2e;
        }
      }

      * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang TC", "PingFang SC", "Hiragino Sans GB", "Helvetica Neue", system-ui, sans-serif !important;
        -webkit-font-smoothing: antialiased !important;
        -moz-osx-font-smoothing: grayscale !important;
      }

      .agy-float-container {
        position: absolute;
        pointer-events: auto;
        display: grid;
        place-items: center;
        z-index: 2147483647;
        animation: agy-pop-in 0.16s cubic-bezier(0.16, 1, 0.3, 1);
        user-select: none;
      }

      .agy-float-btn {
        width: 26px;
        height: 26px;
        border-radius: 50%;
        border: none;
        background: linear-gradient(135deg, #0071e3 0%, #0056b3 100%);
        color: #ffffff;
        display: grid;
        place-items: center;
        cursor: pointer;
        transition: transform 0.12s ease, box-shadow 0.12s ease;
        padding: 0;
        box-shadow: 0 2px 8px rgba(0, 113, 227, 0.4);
      }
      .agy-float-btn svg {
        width: 14px;
        height: 14px;
        flex: none;
      }
      .agy-float-btn:hover {
        transform: scale(1.12);
        box-shadow: 0 4px 14px rgba(0, 113, 227, 0.55);
      }
      .agy-float-btn:active {
        transform: scale(0.92);
      }

      .agy-modal-card {
        position: absolute;
        width: 480px;
        max-width: calc(100vw - 32px);
        max-height: 85vh;
        background: var(--bg-glass);
        backdrop-filter: blur(28px) saturate(180%);
        -webkit-backdrop-filter: blur(28px) saturate(180%);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow-modal);
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: agy-pop-in 0.18s cubic-bezier(0.16, 1, 0.3, 1);
        z-index: 10000;
      }

      .agy-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 9px 14px;
        background: var(--bg-card);
        border-bottom: 1px solid var(--border);
        user-select: none;
      }

      .agy-lang-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 650;
      }
      .agy-lang-auto {
        color: var(--text-dim);
        background: var(--bg-inset);
        padding: 2px 7px;
        border-radius: 6px;
      }
      .agy-lang-arrow {
        color: var(--text-dim);
        font-size: 11px;
      }
      .agy-lang-target {
        color: var(--accent);
        background: var(--accent-glow);
        padding: 2px 8px;
        border-radius: 6px;
      }

      .agy-header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .agy-btn-icon {
        width: 24px;
        height: 24px;
        border-radius: 6px;
        border: none;
        background: transparent;
        color: var(--text-dim);
        cursor: pointer;
        display: grid;
        place-items: center;
        transition: all 0.12s ease;
        padding: 0;
      }
      .agy-btn-icon:hover {
        background: var(--bg-inset);
        color: var(--text);
      }
      .agy-pin-btn.active {
        color: var(--accent);
        background: var(--accent-glow);
      }

      .agy-src-box {
        padding: 9px 14px;
        background: var(--bg-inset);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .agy-src-text {
        flex: 1;
        font-size: 12.5px;
        color: var(--text-dim);
        line-height: 1.45;
        max-height: 48px;
        overflow-y: auto;
        user-select: text;
      }

      .agy-card-body {
        padding: 12px 14px;
        overflow-y: auto;
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .agy-item-card {
        background: var(--bg-card);
        border: 1px solid var(--border);
        border-radius: 11px;
        padding: 11px 13px;
        cursor: pointer;
        transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease, border-color 0.12s ease;
        position: relative;
        user-select: none;
        box-shadow: 0 1px 3px rgba(0,0,0,0.04);
      }
      .agy-item-card:hover {
        background: var(--bg-card-hover);
        border-color: var(--border-strong);
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      }
      .agy-item-card:active {
        transform: translateY(0);
      }
      .agy-item-card.agy-primary {
        border-color: color-mix(in srgb, var(--accent) 35%, var(--border));
      }
      .agy-item-card.agy-info {
        background: transparent;
        border-style: dashed;
        cursor: default;
        box-shadow: none;
      }
      .agy-item-card.agy-info:hover {
        transform: none;
        background: transparent;
      }

      .agy-card-flash {
        animation: agy-flash 0.35s ease;
      }
      @keyframes agy-flash {
        0% { background: color-mix(in srgb, var(--accent) 22%, var(--bg-card)); }
        100% { background: var(--bg-card); }
      }

      .agy-item-top {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 20px;
        margin-bottom: 6px;
      }
      .agy-badge {
        height: 18px;
        padding: 0 6px;
        border-radius: 5px;
        background: rgba(0, 113, 227, 0.1);
        border: 1px solid rgba(0, 113, 227, 0.22);
        font-size: 10.5px;
        font-weight: 700;
        color: var(--accent);
        letter-spacing: 0.02em;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
      }
      .agy-badge-dim {
        background: var(--bg-inset);
        border-color: var(--border);
        color: var(--text-dim);
      }
      .agy-num {
        height: 18px;
        min-width: 18px;
        padding: 0 5px;
        border-radius: 5px;
        background: var(--bg-inset);
        border: 1px solid var(--border);
        font-size: 10.5px;
        font-weight: 700;
        color: var(--text-dim);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
      }
      .agy-note {
        margin-left: auto;
        font-size: 11px;
        color: var(--text-dim);
        display: flex;
        align-items: center;
        gap: 5px;
        height: 20px;
      }
      .agy-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex: none;
      }
      .t-casual  { background: var(--tone-casual); box-shadow: 0 0 5px var(--tone-casual); }
      .t-neutral { background: var(--tone-neutral); box-shadow: 0 0 5px var(--tone-neutral); }
      .t-formal  { background: var(--tone-formal); box-shadow: 0 0 5px var(--tone-formal); }
      .t-terse   { background: var(--tone-terse); box-shadow: 0 0 5px var(--tone-terse); }

      .agy-speak-btn {
        width: 20px;
        height: 20px;
        border: none;
        background: transparent;
        color: var(--text-dim);
        border-radius: 5px;
        cursor: pointer;
        display: grid;
        place-items: center;
        padding: 0;
        transition: all 0.12s ease;
        flex: none;
      }
      .agy-speak-btn:hover {
        color: var(--accent);
        background: var(--bg-inset);
      }
      .agy-speak-btn.speaking {
        color: var(--accent);
      }
      .agy-speak-btn.speaking .wave {
        animation: agy-wave 0.8s ease-in-out infinite;
      }
      @keyframes agy-wave {
        0%, 100% { opacity: 0.2; }
        50% { opacity: 1; }
      }

      .agy-copy-indicator {
        width: 20px;
        height: 20px;
        color: var(--text-dim);
        opacity: 0.4;
        display: grid;
        place-items: center;
        transition: opacity 0.12s ease, color 0.12s ease;
        flex: none;
      }
      .agy-item-card:hover .agy-copy-indicator {
        opacity: 0.85;
        color: var(--accent);
      }

      .agy-item-text {
        font-size: 14.5px;
        line-height: 1.55;
        letter-spacing: -0.01em;
        white-space: pre-wrap;
        word-break: break-word;
        user-select: text;
        color: var(--text);
        margin: 0;
        padding: 0;
      }
      .agy-primary .agy-item-text {
        font-size: 14.5px;
        font-weight: 550;
        line-height: 1.55;
      }
      .agy-item-text.rich {
        font-size: 12.5px;
        color: var(--text-dim);
      }
      .agy-item-text strong {
        font-weight: 650;
        color: var(--text);
      }
      .agy-item-text code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11.5px;
        background: var(--bg-inset);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 1px 4px;
        color: var(--text);
      }

      .agy-card-footer {
        padding: 7px 12px;
        background: var(--bg-card);
        border-top: 1px solid var(--border);
        font-size: 11px;
        color: var(--text-dim);
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        user-select: none;
      }
      kbd {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10px;
        font-weight: 600;
        padding: 1px 4px;
        border-radius: 4px;
        background: var(--bg-inset);
        border: 1px solid var(--border);
        color: var(--text);
      }

      .agy-loading-box {
        padding: 36px 16px;
        text-align: center;
        color: var(--text-dim);
      }
      .agy-spinner {
        width: 22px;
        height: 22px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        margin: 0 auto 10px;
        animation: agy-spin 0.8s linear infinite;
      }
      @keyframes agy-spin {
        to { transform: rotate(360deg); }
      }
      .agy-loading-text {
        font-size: 13px;
        font-weight: 550;
        color: var(--text);
      }
      .agy-loading-sub {
        font-size: 11px;
        margin-top: 3px;
        opacity: 0.7;
      }

      .agy-error-box {
        padding: 20px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .agy-err-title {
        font-size: 13.5px;
        font-weight: 650;
        color: #ff453a;
      }
      .agy-err-desc {
        font-size: 12px;
        color: var(--text-dim);
        line-height: 1.4;
      }
      .agy-code-box {
        background: var(--bg-inset);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 8px 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .agy-code-box code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        color: var(--text);
        overflow-x: auto;
        white-space: nowrap;
      }
      .agy-copy-cmd-btn {
        border: 1px solid var(--border);
        background: var(--bg-card);
        color: var(--text);
        font-size: 10.5px;
        font-weight: 600;
        padding: 3px 7px;
        border-radius: 5px;
        cursor: pointer;
        flex: none;
      }
      .agy-copy-cmd-btn:hover {
        background: var(--bg-card-hover);
      }
      .agy-retry-btn {
        background: var(--accent);
        color: #ffffff;
        border: none;
        border-radius: 7px;
        padding: 7px 12px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.12s ease;
      }
      .agy-retry-btn:hover {
        background: var(--accent-hover);
      }

      .agy-toast {
        position: fixed;
        left: 50%;
        bottom: 24px;
        transform: translateX(-50%) translateY(14px);
        background: var(--text);
        color: var(--bg-card);
        font-size: 12px;
        font-weight: 600;
        padding: 7px 15px;
        border-radius: 9px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease, transform 0.15s ease;
        box-shadow: 0 6px 20px rgba(0,0,0,0.25);
        z-index: 999999;
      }
      .agy-toast.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }

      .agy-page-banner {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-glass);
        backdrop-filter: blur(28px) saturate(180%);
        -webkit-backdrop-filter: blur(28px) saturate(180%);
        color: var(--text);
        border: 1px solid var(--border-strong);
        border-radius: 30px;
        padding: 7px 16px;
        display: flex;
        align-items: center;
        gap: 10px;
        box-shadow: var(--shadow-modal);
        z-index: 2147483647;
        pointer-events: auto;
        animation: agy-pop-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        font-size: 13px;
        font-weight: 550;
      }
      .agy-banner-icon {
        display: grid;
        place-items: center;
        color: var(--accent);
      }
      .agy-spinner-sm {
        width: 15px;
        height: 15px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: agy-spin 0.8s linear infinite;
        flex: none;
      }
      .agy-banner-btn {
        border: 1px solid var(--border);
        background: var(--bg-card);
        color: var(--text);
        font: inherit;
        font-size: 11.5px;
        font-weight: 600;
        padding: 4px 10px;
        border-radius: 14px;
        cursor: pointer;
        transition: all 0.12s ease;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .agy-banner-btn:hover {
        background: var(--bg-card-hover);
        color: var(--accent);
        border-color: var(--accent);
      }
      .agy-banner-close-btn {
        padding: 4px 6px;
        border-radius: 50%;
      }

      @keyframes agy-pop-in {
        from {
          opacity: 0;
          transform: scale(0.94) translateY(3px);
        }
        to {
          opacity: 1;
          transform: scale(1) translateY(0);
        }
      }
    `;
  }
})();
