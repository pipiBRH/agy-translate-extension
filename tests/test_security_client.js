/**
 * Automated offline regression tests for agy-translate-extension client security.
 * Uses Node.js built-in test runner (node --test) and node:vm.
 *
 * CRITICAL REVIEW REQUIREMENT:
 * Evaluates ACTUAL production JavaScript files (background/service_worker.js and
 * content/content.js) in a sandboxed VM with mocked chrome.* and fetch, rather
 * than testing copied/reimplemented helper functions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const swSource = readFileSync(resolve(root, 'background/service_worker.js'), 'utf8');
const contentSource = readFileSync(resolve(root, 'content/content.js'), 'utf8');

// Helper to compute genuine Web Crypto HMAC for mock server responses
async function computeHmac(keyStr, dataStr) {
  const enc = new TextEncoder();
  const key = await webcrypto.subtle.importKey(
    'raw',
    enc.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await webcrypto.subtle.sign('HMAC', key, enc.encode(dataStr));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Creates a sandboxed VM context running the production background/service_worker.js.
 */
function createServiceWorkerEnv({
  local = {},
  sync = {},
  extensionId = 'abcdefghijklmnopqrstuvwxyz123456',
  fetchHandler = null,
} = {}) {
  const origin = `chrome-extension://${extensionId}`;
  const messageListeners = [];
  const contextMenuListeners = [];
  const commandListeners = [];
  const sentTabMessages = [];
  const fetchCalls = [];

  const defaultFetch = async (url, options = {}) => {
    fetchCalls.push({ url, ...options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const context = vm.createContext({
    console,
    URL,
    TextEncoder,
    Uint8Array,
    AbortController,
    Headers,
    Request,
    Response,
    setTimeout,
    clearTimeout,
    crypto: webcrypto,
    chrome: {
      runtime: {
        id: extensionId,
        getURL: (path) => `${origin}/${path}`,
        onInstalled: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onMessage: {
          addListener: (fn) => messageListeners.push(fn),
        },
        lastError: null,
      },
      storage: {
        local: {
          setAccessLevel: async () => {},
          get: (defaults, cb) => cb({ ...defaults, ...local }),
          set: (items, cb) => {
            Object.assign(local, items);
            cb?.();
          },
          remove: (keys, cb) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            arr.forEach((k) => delete local[k]);
            cb?.();
          },
        },
        sync: {
          get: (defaults, cb) => cb({ ...defaults, ...sync }),
          set: (items, cb) => {
            Object.assign(sync, items);
            cb?.();
          },
        },
      },
      contextMenus: {
        removeAll: (cb) => cb?.(),
        create: () => {},
        onClicked: {
          addListener: (fn) => contextMenuListeners.push(fn),
        },
      },
      commands: {
        onCommand: {
          addListener: (fn) => commandListeners.push(fn),
        },
      },
      tabs: {
        query: (queryInfo, cb) => {
          cb([{ id: 1, url: 'https://example.com/page' }]);
        },
        sendMessage: (tabId, msg, cb) => {
          sentTabMessages.push({ tabId, msg });
          cb?.();
        },
      },
    },
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, ...options });
      if (fetchHandler) {
        return fetchHandler(url, options);
      }
      return defaultFetch(url, options);
    },
  });

  // Evaluate the ACTUAL production source code
  vm.runInContext(swSource, context);

  return {
    context,
    local,
    sync,
    fetchCalls,
    messageListeners,
    contextMenuListeners,
    commandListeners,
    sentTabMessages,
    extensionId,
    origin,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Fake Listener Rejection & Bearer Leak Prevention
// ---------------------------------------------------------------------------
test('Options connection test checks the entered port instead of a cached listener', async () => {
  const env = createServiceWorkerEnv({
    fetchHandler: async () => new Response(JSON.stringify({ app: 'agy-translate' }), { status: 200 }),
  });
  const result = await new Promise(resolve => env.messageListeners[0](
    { type: 'CHECK_SERVER', serverPort: 49123 },
    { id: env.extensionId, url: `${env.origin}/options/options.html` },
    resolve,
  ));
  assert.equal(result.port, 49123);
  assert.equal(result.verified, false);
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(new URL(env.fetchCalls[0].url).port, '49123');
});

test('clearServerCache aborts and sends ZERO bearer tokens to unverified or fake listeners', async () => {
  const fakePort = 47829;
  const env = createServiceWorkerEnv({
    local: {
      paired: true,
      clientId: 'client-test-id',
      token: 'secret-bearer-token-12345',
      secret: 'client-secret-key-67890',
      serverPort: fakePort,
    },
    fetchHandler: async (url, options) => {
      // Fake listener fails verification (invalid HMAC proof)
      if (url.includes('/api/auth/verify')) {
        return new Response(JSON.stringify({ status: 'ok', proof: 'invalid_hmac_proof' }), { status: 200 });
      }
      if (url.includes('/api/cache/clear')) {
        throw new Error('LEAK: /api/cache/clear should NEVER be fetched when verification fails');
      }
      return new Response('{}', { status: 200 });
    },
  });

  const result = await vm.runInContext('clearServerCache()', env.context);
  assert.equal(result.success, false);
  assert.match(result.error, /verification failed/i);

  // Assert NO request was made to /api/cache/clear with Authorization header
  const clearRequests = env.fetchCalls.filter((c) => c.url.includes('/api/cache/clear'));
  assert.equal(clearRequests.length, 0, 'Must NOT send /api/cache/clear request to unverified server');
  assert.equal(
    env.fetchCalls.some((c) => c.headers && c.headers.Authorization),
    false,
    'Zero bearer credentials must be transmitted to unverified server'
  );
});

test('unpairServer aborts unpair API call and sends ZERO bearer tokens when server is unverified', async () => {
  const fakePort = 47829;
  const env = createServiceWorkerEnv({
    local: {
      paired: true,
      clientId: 'client-test-id',
      token: 'secret-bearer-token-12345',
      secret: 'client-secret-key-67890',
      serverPort: fakePort,
    },
    fetchHandler: async (url, options) => {
      // Fake listener fails verification
      if (url.includes('/api/auth/verify')) {
        return new Response(JSON.stringify({ status: 'ok', proof: 'forged_proof' }), { status: 200 });
      }
      if (url.includes('/api/auth/unpair')) {
        throw new Error('LEAK: /api/auth/unpair must NEVER be fetched when verification fails');
      }
      return new Response('{}', { status: 200 });
    },
  });

  const result = await vm.runInContext('unpairServer()', env.context);
  assert.equal(result.success, true); // Local credentials cleared cleanly

  // Assert NO request was made to /api/auth/unpair
  const unpairRequests = env.fetchCalls.filter((c) => c.url.includes('/api/auth/unpair'));
  assert.equal(unpairRequests.length, 0, 'Must NOT send unpair request with bearer to unverified server');
  assert.equal(env.local.paired, undefined, 'Local credentials must be cleared locally');
});

test('handleTranslate and handleTranslateBatch abort and send ZERO text/tokens to fake/relayed listeners', async () => {
  const fakePort = 47829;
  const env = createServiceWorkerEnv({
    local: {
      paired: true,
      clientId: 'client-test-id',
      token: 'secret-bearer-token-12345',
      secret: 'client-secret-key-67890',
      serverPort: fakePort,
    },
    sync: {
      serverPort: fakePort,
    },
    fetchHandler: async (url, options) => {
      if (url.includes('/ping')) {
        return new Response(JSON.stringify({ app: 'agy-translate' }), { status: 200 });
      }
      if (url.includes('/api/auth/verify')) {
        // Relayed or fake proof mismatch
        return new Response(JSON.stringify({ status: 'ok', proof: 'forged_relay_proof' }), { status: 200 });
      }
      if (url.includes('/api/translate')) {
        throw new Error('LEAK: /api/translate must NEVER be fetched when server proof verification fails');
      }
      return new Response('{}', { status: 200 });
    },
  });

  // Single translate
  const translateRes = await vm.runInContext(
    'handleTranslate("sensitive user text", "zh-TW", "https://example.com")',
    env.context
  );
  assert.equal(translateRes.status, 'server_unverified');

  // Batch translate
  const batchRes = await vm.runInContext(
    'handleTranslateBatch(["sensitive text 1", "sensitive text 2"], "zh-TW", "https://example.com")',
    env.context
  );
  assert.equal(batchRes.status, 'server_unverified');

  // Assert NO translation text or bearer tokens were sent in any fetch call
  const sensitivePosts = env.fetchCalls.filter((c) => c.url.includes('/api/translate'));
  assert.equal(sensitivePosts.length, 0, 'Zero translate endpoints called when server verification fails');
  for (const call of env.fetchCalls) {
    if (call.body) {
      assert.equal(call.body.includes('sensitive user text'), false, 'Translation text must never be sent');
      assert.equal(call.body.includes('sensitive text 1'), false, 'Batch translation text must never be sent');
    }
  }
});

test('All client network requests strictly enforce redirect: "error"', async () => {
  const env = createServiceWorkerEnv({
    local: {
      paired: true,
      clientId: 'client-123',
      token: 'token-123',
      secret: 'secret-123',
      serverPort: 47821,
    },
    sync: { serverPort: 47821 },
    fetchHandler: async (url, options) => {
      if (url.includes('/ping')) return new Response(JSON.stringify({ app: 'agy-translate' }));
      if (url.includes('/api/auth/verify')) return new Response(JSON.stringify({ status: 'ok', proof: 'bad' }));
      return new Response('{}');
    },
  });

  await vm.runInContext('handleTranslate("test", "zh-TW", "https://example.com")', env.context);

  assert.ok(env.fetchCalls.length > 0, 'Fetch calls should have occurred');
  for (const call of env.fetchCalls) {
    assert.equal(
      call.redirect,
      'error',
      `Fetch call to ${call.url} must set redirect: 'error' to prevent credential leakage via redirects`
    );
  }
});

// ---------------------------------------------------------------------------
// Suite 2: Centralized Disabled Domains Enforcement
// ---------------------------------------------------------------------------
test('handleTranslate and handleTranslateBatch block disabled domains before making network calls', async () => {
  const env = createServiceWorkerEnv({
    local: {
      paired: true,
      clientId: 'client-123',
      token: 'token-123',
      secret: 'secret-123',
      serverPort: 47821,
    },
    sync: {
      disabledDomains: ['private.bank.com', 'internal.corp'],
      serverPort: 47821,
    },
    fetchHandler: async () => {
      throw new Error('No fetch should occur for disabled domains');
    },
  });

  // Exact match on disabled domain
  const resExact = await vm.runInContext(
    'handleTranslate("confidential data", "zh-TW", "https://private.bank.com/account")',
    env.context
  );
  assert.equal(resExact.status, 'domain_disabled');

  // Subdomain match on disabled domain
  const resSub = await vm.runInContext(
    'handleTranslate("confidential data", "zh-TW", "https://app.dev.internal.corp/secret")',
    env.context
  );
  assert.equal(resSub.status, 'domain_disabled');

  // Batch translation on disabled domain
  const resBatch = await vm.runInContext(
    'handleTranslateBatch(["line 1", "line 2"], "zh-TW", "https://private.bank.com/transfers")',
    env.context
  );
  assert.equal(resBatch.status, 'domain_disabled');

  // Assert ZERO network fetches were dispatched
  assert.equal(env.fetchCalls.length, 0, 'Zero network calls should be made when domain is disabled');
});

// ---------------------------------------------------------------------------
// Suite 3: Pairing Authentication & Forged Proof Rejection
// ---------------------------------------------------------------------------
test('pairWithServer rejects forged server proof and refuses to send redemption request', async () => {
  const code = 'TEST_PAIRING_CODE_123456789012';
  const port = 47821;

  const env = createServiceWorkerEnv({
    fetchHandler: async (url, options) => {
      if (url.includes('/api/pair/init')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            server_nonce: 'mock_server_nonce_12345678',
            server_proof: 'forged_server_proof_invalid_hmac',
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/pair/redeem')) {
        throw new Error('CRITICAL SECURITY VIOLATION: redeem must NEVER be sent if server proof fails verification');
      }
      return new Response('{}', { status: 200 });
    },
  });

  env.context.testCode = code;
  env.context.testPort = port;
  const result = await vm.runInContext('pairWithServer(testCode, testPort)', env.context);
  assert.equal(result.success, false);
  assert.match(result.error, /verification failed/i);

  const redeemCalls = env.fetchCalls.filter((c) => c.url.includes('/api/pair/redeem'));
  assert.equal(redeemCalls.length, 0, 'Client must not redeem or send credentials if server proof is forged');
});

test('pairWithServer succeeds when server presents genuine mutual proof', async () => {
  const code = 'GENUINE_PAIR_CODE_ABCDEF123456';
  const port = 47821;
  const extensionId = 'abcdefghijklmnopqrstuvwxyz123456';
  const origin = `chrome-extension://${extensionId}`;

  const env = createServiceWorkerEnv({
    extensionId,
    fetchHandler: async (url, options) => {
      if (url.includes('/api/pair/init')) {
        const body = JSON.parse(options.body);
        const serverNonce = 'srv_nonce_88889999';
        const serverMsg = `agy-pair-server-proof-v1:${port}:${origin}:${body.client_nonce}:${serverNonce}`;
        const serverProof = await computeHmac(code, serverMsg);
        return new Response(
          JSON.stringify({
            status: 'ok',
            server_nonce: serverNonce,
            server_proof: serverProof,
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/pair/redeem')) {
        return new Response(
          JSON.stringify({
            status: 'paired',
            token: 'valid-bearer-token',
            secret: 'valid-client-secret',
            client_id: 'client-active-1',
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    },
  });

  env.context.testCode = code;
  env.context.testPort = port;
  const result = await vm.runInContext('pairWithServer(testCode, testPort)', env.context);
  assert.equal(result.success, true);
  assert.equal(env.local.paired, true);
  assert.equal(env.local.token, 'valid-bearer-token');
  assert.equal(env.local.clientId, 'client-active-1');
});

// ---------------------------------------------------------------------------
// Suite 4: Message Listener Authorization & Sender Verification
// ---------------------------------------------------------------------------
test('onMessage listener rejects unauthorized senders from injecting pairing or settings commands', async () => {
  const env = createServiceWorkerEnv();
  const listener = env.messageListeners[0];
  assert.ok(listener, 'onMessage listener must be registered');

  const invokeMessage = (request, sender) => {
    return new Promise((resolveResponse) => {
      const handled = listener(request, sender, (res) => resolveResponse(res));
      if (!handled) resolveResponse(null);
    });
  };

  // 1. Foreign extension sender (spoofed ID)
  const foreignSender = { id: 'malicious-extension-id', url: 'chrome-extension://malicious-extension-id/page.html' };
  const foreignRes = await invokeMessage({ type: 'PAIR_EXTENSION', code: '123' }, foreignSender);
  assert.equal(foreignRes, null, 'Foreign extension messages must be ignored');

  // 2. Web page / Content script attempting PAIR_EXTENSION -> 403 / restricted to options page
  const contentScriptSender = { id: env.extensionId, url: 'https://example.com/some/article' };
  const csRes = await invokeMessage({ type: 'PAIR_EXTENSION', code: '123' }, contentScriptSender);
  assert.equal(csRes.success, false);
  assert.match(csRes.error, /restricted to options page/i);

  // 3. Web page attempting UNPAIR_EXTENSION
  const unpairRes = await invokeMessage({ type: 'UNPAIR_EXTENSION' }, contentScriptSender);
  assert.equal(unpairRes.success, false);
  assert.match(unpairRes.error, /restricted to options page/i);

  // 4. Web page attempting CLEAR_CACHE
  const clearRes = await invokeMessage({ type: 'CLEAR_CACHE' }, contentScriptSender);
  assert.equal(clearRes.success, false);
  assert.match(clearRes.error, /restricted to options page/i);

  // 5. Web page attempting SAVE_SETTINGS
  const saveRes = await invokeMessage({ type: 'SAVE_SETTINGS', settings: { targetLang: 'es' } }, contentScriptSender);
  assert.equal(saveRes.success, false);
  assert.match(saveRes.error, /restricted to options page/i);

  // 6. Genuine options page sender -> Accepted
  const genuineOptionsSender = {
    id: env.extensionId,
    url: `chrome-extension://${env.extensionId}/options/options.html`,
  };
  const optionsRes = await invokeMessage({ type: 'SAVE_SETTINGS', settings: { targetLang: 'ja' } }, genuineOptionsSender);
  assert.equal(optionsRes.success, true);
  assert.equal(env.sync.targetLang, 'ja');
});

test('GET_SETTINGS exposes UI preferences only and NEVER exposes paired secrets to content scripts', async () => {
  const env = createServiceWorkerEnv({
    local: {
      paired: true,
      clientId: 'secret-client-id',
      token: 'secret-bearer-token',
      secret: 'secret-hmac-key',
    },
    sync: {
      modelId: 'gemini-3.8-flash-tiered',
      targetLang: 'zh-TW',
      disabledDomains: ['secret.corp'],
    },
  });

  const listener = env.messageListeners[0];
  const settings = await new Promise((resolveResponse) => {
    listener({ type: 'GET_SETTINGS' }, { id: env.extensionId, url: 'https://example.com' }, resolveResponse);
  });

  assert.equal('token' in settings, false, 'token must NOT be in public settings');
  assert.equal('secret' in settings, false, 'secret must NOT be in public settings');
  assert.equal('clientId' in settings, false, 'clientId must NOT be in public settings');
  assert.equal(settings.modelId, 'gemini-3.8-flash-tiered');
  assert.equal(settings.targetLang, 'zh-TW');
});

test('Context menu restore action is allowed on newly-disabled domains while translation is blocked', async () => {
  const env = createServiceWorkerEnv({
    sync: {
      disabledDomains: ['newly-disabled.corp'],
    },
  });

  const menuListener = env.contextMenuListeners[0];
  assert.ok(menuListener, 'Context menu listener must be registered');

  const disabledTab = { id: 42, url: 'https://newly-disabled.corp/page' };

  // 1. Restore action must be dispatched even on disabled domain
  menuListener({ menuItemId: 'agy-restore-full-page' }, disabledTab);
  assert.equal(env.sentTabMessages.length, 1);
  assert.equal(env.sentTabMessages[0].msg.type, 'RESTORE_ORIGINAL_PAGE');

  // 2. Translate action must be BLOCKED on disabled domain
  env.sentTabMessages.length = 0;
  menuListener({ menuItemId: 'agy-translate-full-page' }, disabledTab);
  assert.equal(env.sentTabMessages.length, 0, 'Translate action must be blocked on disabled domain');
});

// ---------------------------------------------------------------------------
// Suite 5: Content Script DOM Collector & Visibility Filter
// ---------------------------------------------------------------------------
function createContentScriptEnv(initialHostname = 'example.com') {
  const testHooks = {};
  const docListeners = {};
  const windowListeners = {};
  const runtimeListeners = [];

  class MockElement {
    constructor(tagName, attributes = {}, style = {}) {
      this.tagName = tagName.toUpperCase();
      this.attributes = { ...attributes };
      this.style = { ...style };
      this.nodeType = 1;
      this.parentElement = null;
      this.children = [];
    }
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }
    getAttribute(name) {
      return this.attributes[name] || null;
    }
    hasAttribute(name) {
      return name in this.attributes;
    }
    closest(selector) {
      const matchSelector = (sel, el) => {
        sel = sel.trim();
        if (sel.startsWith('[') && sel.endsWith(']')) {
          const inner = sel.slice(1, -1);
          if (inner.includes('=')) {
            const [attr, val] = inner.split('=').map((s) => s.replace(/["']/g, '').trim());
            if (attr.endsWith('*')) {
              const baseAttr = attr.slice(0, -1);
              return (el.getAttribute(baseAttr) || '').includes(val);
            }
            return el.getAttribute(attr) === val;
          }
          return el.hasAttribute(inner);
        }
        if (sel.startsWith('#')) return el.id === sel.slice(1);
        if (sel.startsWith('.')) return el.className && el.className.includes(sel.slice(1));
        return el.tagName.toLowerCase() === sel.toLowerCase();
      };

      const selectors = selector.split(',').map((s) => s.trim());
      let cur = this;
      while (cur && cur.nodeType === 1) {
        for (const sel of selectors) {
          if (matchSelector(sel, cur)) return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    }
  }

  class MockTextNode {
    constructor(text) {
      this.nodeValue = text;
      this.nodeType = 3;
      this.parentElement = null;
    }
  }

  const documentElement = new MockElement('html');
  const body = new MockElement('body');
  documentElement.appendChild(body);

  const context = vm.createContext({
    console,
    window: {
      __AGY_TEST_HOOKS__: testHooks,
      location: { hostname: initialHostname },
      addEventListener: (t, fn) => { windowListeners[t] = fn; },
      removeEventListener: () => {},
      getComputedStyle: (el) => el.style || {},
    },
    document: {
      documentElement,
      body,
      addEventListener: (t, fn) => { docListeners[t] = fn; },
      removeEventListener: () => {},
      createTreeWalker: (rootNode, whatToShow, filter) => {
        const textNodes = [];
        const traverse = (node) => {
          if (node.nodeType === 3) {
            if (!filter || filter.acceptNode(node) === 1) {
              textNodes.push(node);
            }
          } else if (node.children) {
            for (const child of node.children) traverse(child);
          }
        };
        traverse(rootNode);
        let idx = 0;
        return {
          nextNode: () => (idx < textNodes.length ? textNodes[idx++] : null),
        };
      },
    },
    chrome: {
      runtime: {
        id: 'test-ext-id',
        sendMessage: () => {},
        onMessage: {
          addListener: (fn) => runtimeListeners.push(fn),
        },
      },
      storage: {
        sync: {
          get: (defaults, cb) => cb(defaults),
        },
      },
    },
    NodeFilter: { FILTER_ACCEPT: 1, FILTER_REJECT: 2, SHOW_TEXT: 4 },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    setTimeout: () => {},
    clearTimeout: () => {},
  });

  // Evaluate the ACTUAL production content script
  vm.runInContext(contentSource, context);

  return {
    testHooks,
    documentElement,
    body,
    MockElement,
    MockTextNode,
    runtimeListeners,
  };
}

test('isElementVisible accurately rejects CSS hidden elements and ancestors up to documentElement', () => {
  const { testHooks, MockElement, documentElement, body } = createContentScriptEnv();
  const isVisible = testHooks.isElementVisible;
  assert.ok(isVisible, 'isElementVisible must be exported by content script hooks');

  // 1. Visible element in normal tree
  const p = new MockElement('p');
  body.appendChild(p);
  assert.equal(isVisible(p), true);

  // 2. display: none
  const hiddenP = new MockElement('p', {}, { display: 'none' });
  body.appendChild(hiddenP);
  assert.equal(isVisible(hiddenP), false);

  // 3. visibility: hidden
  const visHiddenP = new MockElement('p', {}, { visibility: 'hidden' });
  body.appendChild(visHiddenP);
  assert.equal(isVisible(visHiddenP), false);

  // 4. visibility: collapse
  const collapseP = new MockElement('p', {}, { visibility: 'collapse' });
  body.appendChild(collapseP);
  assert.equal(isVisible(collapseP), false);

  // 5. opacity: 0
  const opaqueZeroP = new MockElement('p', {}, { opacity: '0' });
  body.appendChild(opaqueZeroP);
  assert.equal(isVisible(opaqueZeroP), false);

  // 6. contentVisibility: hidden
  const cvHiddenP = new MockElement('p', {}, { contentVisibility: 'hidden' });
  body.appendChild(cvHiddenP);
  assert.equal(isVisible(cvHiddenP), false);

  // 7. Hidden ancestor
  const container = new MockElement('div', {}, { display: 'none' });
  const child = new MockElement('span');
  container.appendChild(child);
  body.appendChild(container);
  assert.equal(isVisible(child), false, 'Child of display:none container must not be visible');

  // 8. Body hidden
  body.style.display = 'none';
  const normalUnderHiddenBody = new MockElement('div');
  body.appendChild(normalUnderHiddenBody);
  assert.equal(isVisible(normalUnderHiddenBody), false, 'Element under hidden body must not be visible');
  body.style.display = '';

  // 9. Root / documentElement hidden
  documentElement.style.display = 'none';
  const normalUnderHiddenRoot = new MockElement('div');
  body.appendChild(normalUnderHiddenRoot);
  assert.equal(isVisible(normalUnderHiddenRoot), false, 'Element under hidden root must not be visible');
  documentElement.style.display = '';

  // 10. Visible offscreen element (no display:none / visibility:hidden)
  const offscreen = new MockElement('div', {}, { position: 'absolute', top: '10000px' });
  body.appendChild(offscreen);
  assert.equal(isVisible(offscreen), true, 'Offscreen visible element must be preserved for translation');
});

test('collectTranslatableTextNodes strictly filters sensitive fields and technical elements', () => {
  const { testHooks, MockElement, MockTextNode, body } = createContentScriptEnv();
  const collectNodes = testHooks.collectTranslatableTextNodes;
  assert.ok(collectNodes, 'collectTranslatableTextNodes must be exported by content script hooks');

  // Normal translatable paragraph
  const validP = new MockElement('p');
  const validText = new MockTextNode('This is a legitimate article sentence to translate.');
  validP.appendChild(validText);
  body.appendChild(validP);

  // Sensitive field: data-sensitive
  const sensDiv = new MockElement('div', { 'data-sensitive': 'true' });
  const sensText = new MockTextNode('This contains secret SSN numbers');
  sensDiv.appendChild(sensText);
  body.appendChild(sensDiv);

  // Sensitive field: password autocomplete
  const passDiv = new MockElement('div', { autocomplete: 'current-password' });
  const passText = new MockTextNode('MySuperSecretPassword');
  passDiv.appendChild(passText);
  body.appendChild(passDiv);

  // Sensitive field: credit card
  const ccDiv = new MockElement('div', { autocomplete: 'cc-number' });
  const ccText = new MockTextNode('4111 2222 3333 4444');
  ccDiv.appendChild(ccText);
  body.appendChild(ccDiv);

  // aria-hidden="true"
  const ariaHiddenDiv = new MockElement('div', { 'aria-hidden': 'true' });
  const ariaText = new MockTextNode('Hidden accessibility text');
  ariaHiddenDiv.appendChild(ariaText);
  body.appendChild(ariaHiddenDiv);

  // [hidden] attribute
  const hiddenAttrDiv = new MockElement('div', { hidden: '' });
  const hiddenAttrText = new MockTextNode('Hidden attribute text');
  hiddenAttrDiv.appendChild(hiddenAttrText);
  body.appendChild(hiddenAttrDiv);

  // Code / Pre elements
  const codePre = new MockElement('pre');
  const codeText = new MockTextNode('const x = calculateSecretKey();');
  codePre.appendChild(codeText);
  body.appendChild(codePre);

  // URL-only text
  const urlP = new MockElement('p');
  const urlText = new MockTextNode('https://github.com/example/repo');
  urlP.appendChild(urlText);
  body.appendChild(urlP);

  const collected = collectNodes(body);
  const collectedStrings = collected.map((n) => n.origVal);

  assert.ok(collectedStrings.includes('This is a legitimate article sentence to translate.'));
  assert.equal(collectedStrings.some((s) => s.includes('SSN')), false, 'data-sensitive must be filtered');
  assert.equal(collectedStrings.some((s) => s.includes('MySuperSecretPassword')), false, 'passwords must be filtered');
  assert.equal(collectedStrings.some((s) => s.includes('4111')), false, 'credit cards must be filtered');
  assert.equal(collectedStrings.some((s) => s.includes('Hidden accessibility')), false, 'aria-hidden must be filtered');
  assert.equal(collectedStrings.some((s) => s.includes('Hidden attribute')), false, 'hidden attribute must be filtered');
  assert.equal(collectedStrings.some((s) => s.includes('calculateSecretKey')), false, 'pre/code must be filtered');
  assert.equal(collectedStrings.some((s) => s.includes('https://')), false, 'url-only strings must be filtered');
});
