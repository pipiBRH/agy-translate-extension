# agy Translate — Browser Extension for Microsoft Edge & Chrome

A high-performance text selection and full-page translation browser extension powered by **Google Antigravity (Gemini)** (Chromium Manifest V3). Features automatic source language detection, customizable target language, and non-destructive full-page translation.

---

## ✨ Key Features

1. **Google Translate-Style Floating Action Button**:
   - Selecting text on any webpage displays a sleek circular floating action button.
   - **Automatic Source Language Detection**: Automatically detects input language (English, Japanese, Korean, German, French, Spanish, Chinese, etc.) and translates directly into your configured target language.
2. **Context-Aware Tone Alternatives**:
   - Generates a primary natural translation plus alternative phrasings tailored for different tones:
     - `casual` 🟢 (peer chat, Slack/Discord)
     - `neutral` 🔵 (cross-team collaboration, general communication)
     - `formal` 🟣 (management updates, official correspondence)
3. **Non-Destructive Full-Page Translation**:
   - Right-click anywhere on a webpage and choose **Translate Page**.
   - Powered by a DOM `TreeWalker` TextNode engine that swaps text in place while **100% preserving all HTML elements, CSS layouts, inline links, buttons, and event listeners**.
   - Includes a floating top banner with real-time progress and instantaneous 0ms switching between original and translated versions.
4. **Target Language Configuration**:
   - Easily configure your preferred target language in the extension options:
     - Traditional Chinese (繁體中文 · 台灣)
     - Simplified Chinese (簡體中文)
     - English
     - Japanese (日本語)
     - Korean (한국어)
     - Spanish (Español), French (Français), German (Deutsch)
5. **Shadow DOM Encapsulation & Native Apple Typography**:
   - Modal card and floating elements are encapsulated within a Shadow DOM, preventing CSS conflicts with host websites.
   - Styled with native macOS system typography (San Francisco & PingFang) with subpixel antialiasing and glassmorphic aesthetics.
6. **Polished UX & Keyboard Shortcuts**:
   - **Click-to-Copy**: Click any card or alternative line to copy immediately.
   - **Local Web Speech TTS**: Read source text or translations aloud using native system speech synthesizers.
   - **Keyboard Shortcuts**:
     - `Alt + T` / `Option + T`: Translate selected text immediately without clicking the floating icon.
     - `Enter`: Copy main translation and close popup.
     - `1` / `2` / `3`: Copy corresponding alternative tone line.
     - `⌘ + click` / `Alt + click`: Copy and keep window open.
     - `Esc`: Close modal card.

---

## 🔒 Security Architecture & Privacy Hardening

The extension authenticates its local daemon before sending translation text. Text you explicitly translate is sent to Google's Antigravity service; running a localhost daemon does not make translation offline. Full-page translation excludes hidden and marked-sensitive elements, but visible personal or confidential text can still be included. Use Disabled Domains for pages you do not want translated.

Pairing assumes you trust the terminal command, this extension, and the local operating system. It protects against an unrelated listener impersonating the daemon, including relaying challenges from a different port. It does not protect against malware already able to read your account's credential files or browser storage. OAuth and pairing credentials are stored outside this repository in the daemon's private data directory.

### 1. Atomic Route Authentication & Mutual Bootstrap Pairing
- All translation routes (`/api/translate`, `/api/translate_batch`) require paired Bearer tokens and origin verification. Untrusted origins and `Origin: null` (e.g. sandboxed iframes) are strictly rejected with HTTP 403.
- **Out-of-Band High-Entropy Bootstrap**: Pairing is initiated via an out-of-band 128-bit code generated in your terminal (`python3 server/server.py pair`).
- **Zero Plaintext Transmission**: The pairing code is never transmitted over the wire in plaintext. The daemon and extension mutually prove knowledge of the code using domain-separated HMAC challenge-responses (`agy-pair-server-proof-v1` and `agy-pair-client-redeem-v1`).
- **Atomic Concurrency Control**: Attempt counters, rate limits (maximum 5 attempts), session expiration (5-minute TTL), and one-time token burning are executed atomically under inter-process and inter-thread file locks (`fcntl.flock` and `threading.Lock`).

### 2. Anti-Relay Service Proof (`agy-service-proof-v1`)
- Before transmitting private translation text or bearer tokens, the extension verifies the local service identity using a domain-separated HMAC challenge.
- The challenge cryptographically binds the server's **actual listening port**, the **paired extension origin**, and a **fresh random nonce**.
- If an unauthorized process or fake listener on another port attempts to relay a challenge to the genuine daemon, the port binding mismatch causes verification to fail, immediately aborting the request to protect your data.
- Legacy Alfred workflow `/ping` verification is preserved for seamless coexistence.

### 3. DOM Collector Privacy & Domain Disable List
- **Sensitive Element Filtering**: The full-page translation DOM collector explicitly ignores text inside `[data-sensitive]`, password fields, credit card fields, editable nodes (`[contenteditable]`, `<textarea>`, `<input>`), and hidden elements (`[hidden]`, `[aria-hidden="true"]`, collapsed `<details>`).
- **CSS Visibility Enforcement**: Ancestor visibility is inspected using `checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })` to ignore CSS-hidden nodes (`display: none`, `visibility: hidden`, `opacity: 0`, `content-visibility: hidden`) while safely preserving visible offscreen text.
- **Centralized Domain Disable List**: Configure sensitive domains (e.g., banking or internal corporate tools) in Options. All translation triggers (floating buttons, keyboard shortcuts, context menus, full page) are strictly disabled on listed domains.

### 4. Storage Isolation, Context Restriction & Cache Management
- **Trusted Storage Access**: Secret storage (`chrome.storage.local`) is locked to trusted extension contexts using `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`. Content scripts cannot read paired bearer tokens or client secrets.
- **Options-Only Administrative Messages**: Pairing (`PAIR_EXTENSION`, `UNPAIR_EXTENSION`), settings modification (`SAVE_SETTINGS`), and cache clearing (`CLEAR_CACHE`) messages are exclusively authorized when sent from the extension's options page.
- **Cache retention**: Selection translation results enforce a 14-day TTL on read; the running daemon also sweeps expired files every 60 seconds. Full-page batches are not cached on disk. "Disable translation cache" skips both reading and writing results for new extension requests. It does not erase older entries or change Alfred's cache behavior.
- **Clear Local Cache** removes all recognized translation cache files, including fresh entries, source text, errors, and viewer tickets. It preserves OAuth tokens, server secrets, paired credentials, and unrelated files. Open Alfred result windows may need to be reopened after clearing.

---

## 🚀 Installation & Pairing Setup

### Step 1: Load Extension in Edge / Chrome

1. Open Microsoft Edge and navigate to `edge://extensions` (or `chrome://extensions` in Google Chrome).
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `agy-translate-extension` directory.

### Step 2: Authenticate Local Daemon (First-time setup)

```bash
python3 server/server.py login
```
*(If you have already signed in via Alfred on this machine, your credentials are automatically detected!)*

### Step 3: Start Local Daemon

Run as a background macOS LaunchAgent:
```bash
./launchd/install_daemon.sh
```
Or run manually in foreground:
```bash
python3 server/server.py serve
```

### Step 4: Pair Extension with Local Service

1. In your terminal, generate a one-time pairing code:
   ```bash
   python3 server/server.py pair
   ```
2. Open the extension **Options** page (right-click extension icon → **Options**).
3. Under **Local Pairing & Security**, paste the 32-character pairing code and click **Pair Extension**.
4. The status badge will update to `Paired with local service`.

---

## ⚙️ Configuration & Options

Right-click the extension icon and select **Options** to customize:
- **Model ID**: Choose a suggested model or enter any model ID available to your account. Defaults to Gemini 3.8 Flash (`gemini-3.8-flash-tiered`). Saved changes apply to new selection and full-page translation requests. Run `python3 server/server.py models` to list available IDs.
- **Target Language**: Configure your default translation language.
- **Local Pairing & Security**: Check pairing status, pair with a one-time code, or disconnect/unpair.
- **Translation Cache**: Clear existing translation history or disable cache reads and writes for new extension requests.
- **Disabled Domains**: Specify domains where translation features should never trigger.
- **Floating Button**: Toggle automatic floating button on text selection.
- **Copy Behavior**: Toggle whether popup automatically dismisses upon copying.
- **Connection Port**: Test and configure the local daemon connection.

After updating, reload the extension in `chrome://extensions` or `edge://extensions` and restart the local daemon to load these security changes. Existing installations must complete Step 4 once before translating. Google sign-in does not need to be repeated if the current credential is still valid. If a different unpacked installation gets a new extension ID, pair that installation separately.

---

## 🧪 Automated Offline Regression Tests

The repository includes a comprehensive, self-contained offline test suite covering replay attacks, race conditions, forged proofs, and permission boundaries. The tests require no external internet access, npm modules, or pip packages.

Run Python server security test suite:
```bash
python3 -m unittest discover -s tests -p "test_*.py"
```

Run Node.js client security test suite:
```bash
node --test tests/test_*.js
```

---

## 📄 License

MIT License.
