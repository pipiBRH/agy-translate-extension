// Reviewer integration test: real JS client + real Python HTTP routes, synthetic model only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createServer } from 'node:http';

const root = resolve(import.meta.dirname, '..');
const fixture = `
import sys, threading, json
sys.path.insert(0, sys.argv[1] + '/server')
import server as s
s.ensure_cache()
s.logged_in = lambda: True
s.access_token = lambda: {'access': 'synthetic-access', 'project': 'synthetic-project'}
def no_network(*a, **kw):
    raise AssertionError('External HTTP is forbidden in this test')
s.http_post = no_network
def model(path, token, body, **kw):
    assert body['model'] == 'review-test-model'
    prompt = body['request']['systemInstruction']['parts'][0]['text']
    return '["synthetic batch"]' if 'JSON array' in prompt else '**翻譯**\\nsynthetic translation'
s.post_api = model
s.extract_text = lambda data: data
with s.Server(('127.0.0.1', 0), s.Handler) as srv:
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    code, _ = s.generate_pairing_code()
    print(json.dumps({'port': srv.server_address[1], 'code': code}), flush=True)
    try:
        sys.stdin.read()
    finally:
        srv.shutdown()
        thread.join(timeout=3)
`;

test('real client pairs, translates, disables/clears cache and unpairs against real Python routes', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-review-integration-'));
  const child = spawn('python3', ['-u', '-B', '-c', fixture, root], {
    env: { ...process.env, alfred_workflow_data: join(dir, 'data'), alfred_workflow_cache: join(dir, 'cache') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  try {
    const lines = createInterface({ input: child.stdout });
    const ready = await Promise.race([
      new Promise(resolveReady => lines.once('line', line => resolveReady(JSON.parse(line)))),
      exited.then(() => { throw new Error(`Fixture exited: ${stderr}`); }),
    ]);
    const origin = `chrome-extension://${'a'.repeat(32)}`;
    const local = {};
    const allowedOrigins = new Set([`http://127.0.0.1:${ready.port}`]);
    const settings = { modelId: 'review-test-model', serverPort: ready.port };
    const listener = { addListener() {} };
    const context = vm.createContext({
      console, URL, TextEncoder, Uint8Array, AbortController, Headers,
      setTimeout, clearTimeout, crypto: webcrypto,
      chrome: {
        runtime: { id: 'a'.repeat(32), getURL: path => `${origin}/${path}`, onInstalled: listener, onStartup: listener, onMessage: listener },
        storage: {
          local: {
            setAccessLevel: async () => {},
            get: (defaults, callback) => callback({ ...defaults, ...local }),
            set: (values, callback) => { Object.assign(local, values); callback?.(); },
            remove: (keys, callback) => { keys.forEach(key => delete local[key]); callback?.(); },
          },
          sync: { get: (defaults, callback) => callback({ ...defaults, ...settings }) },
        },
        contextMenus: { onClicked: listener }, commands: { onCommand: listener },
      },
      fetch: async (url, options = {}) => {
        const parsed = new URL(url);
        // Port discovery must never touch the user's real daemon or other listeners.
        if (!allowedOrigins.has(parsed.origin)) throw new Error('Not a fixture endpoint');
        const headers = new Headers(options.headers);
        // Privileged extension GET requests may omit Origin. POST pairing still
        // supplies it. Do not mask this browser behavior in the integration test.
        if ((options.method || 'GET').toUpperCase() !== 'GET') headers.set('Origin', origin);
        return fetch(url, { ...options, headers });
      },
    });
    vm.runInContext(readFileSync(join(root, 'background/service_worker.js'), 'utf8'), context);
    context.reviewCode = ready.code;
    context.reviewPort = ready.port;
    const pair = await vm.runInContext('pairWithServer(reviewCode, reviewPort)', context);
    assert.equal(pair.success, true, pair.error);
    assert.equal(local.paired, true);
    // A real second listener forwards challenges to the genuine daemon. It must
    // never receive a bearer token or translation body despite valid relayed HMACs.
    let leaked = false;
    const relay = createServer(async (request, response) => {
      try {
        if (request.headers.authorization || request.method !== 'GET') leaked = true;
        const upstream = await fetch(`http://127.0.0.1:${ready.port}${request.url}`, { headers: { Origin: origin } });
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        response.end(await upstream.text());
      } catch {
        response.writeHead(502);
        response.end('{}');
      }
    });
    await new Promise(resolveListen => relay.listen(0, '127.0.0.1', resolveListen));
    const fakePort = relay.address().port;
    allowedOrigins.add(`http://127.0.0.1:${fakePort}`);
    context.reviewFakePort = fakePort;
    const savedCredentials = { ...local };
    try {
      const blocked = await vm.runInContext('cachedPort = reviewFakePort; handleTranslate("synthetic relay target", "zh-TW", "https://example.com")', context);
      assert.equal(blocked.status, 'server_unverified');
      local.serverPort = fakePort;
      const refusedClear = await vm.runInContext('clearServerCache()', context);
      assert.equal(refusedClear.success, false);
      await vm.runInContext('unpairServer()', context);
      assert.equal(leaked, false, 'Relayed proof must never authorize text or token delivery');
    } finally {
      Object.assign(local, savedCredentials);
      vm.runInContext('cachedPort = reviewPort', context);
      relay.closeAllConnections();
      await new Promise(resolveClose => relay.close(resolveClose));
      allowedOrigins.delete(`http://127.0.0.1:${fakePort}`);
    }
    assert.equal(await vm.runInContext('verifyServer(reviewPort, { clientId: "missing", secret: "wrong" })', context), false);
    const translated = await vm.runInContext('handleTranslate("synthetic selection", "zh-TW", "https://example.com")', context);
    assert.equal(translated.status, 'done', translated.message);
    assert.equal(translated.data.primary.text, 'synthetic translation');
    const cachedFiles = () => readdirSync(join(dir, 'cache')).filter(name => /^[0-9a-f]{16}\.json$/.test(name));
    assert.equal(cachedFiles().length, 1);
    settings.disableCache = true;
    const privateResult = await vm.runInContext('handleTranslate("synthetic uncached selection", "zh-TW", "https://example.com")', context);
    assert.equal(privateResult.status, 'done', privateResult.message);
    assert.equal(cachedFiles().length, 1, 'Disabled cache must not write a new result');
    const batch = await vm.runInContext('handleTranslateBatch(["synthetic batch input"], "zh-TW", "https://example.com")', context);
    assert.equal(batch.status, 'done', batch.message);
    assert.equal(batch.translations[0], 'synthetic batch');
    assert.equal(cachedFiles().length, 1, 'Batch translation must not introduce new disk retention');
    const cleared = await vm.runInContext('clearServerCache()', context);
    assert.equal(cleared.success, true, cleared.error);
    assert.equal(cachedFiles().length, 0);
    const unpaired = await vm.runInContext('unpairServer()', context);
    assert.equal(unpaired.success, true, unpaired.error);
    assert.equal(local.paired, undefined);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'data', 'paired_clients.json'), 'utf8')).clients, {});
  } finally {
    child.stdin.end();
    const fallback = setTimeout(() => child.kill('SIGTERM'), 3000);
    await exited;
    clearTimeout(fallback);
    rmSync(dir, { recursive: true, force: true });
  }
});
