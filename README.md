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

## 🚀 Installation

### Step 1: Load Extension in Edge / Chrome

1. Open Microsoft Edge and navigate to `edge://extensions` (or `chrome://extensions` in Google Chrome).
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `agy-translate-extension` directory.

---

## 🔌 Local Daemon Service

The extension includes a self-contained local daemon (`server/server.py`) that runs locally on `http://127.0.0.1:47821` and communicates directly with Google Antigravity. It does not require third-party API keys and seamlessly shares existing OAuth credentials with Alfred if available.

### 1. Authenticate (First-time setup on a new computer)

```bash
python3 server/server.py login
```
*(If you have already signed in via Alfred on this machine, your credentials are automatically detected!)*

### 2. Start Background Service (macOS LaunchAgent)

Run the installation script to configure the service to run automatically in the background on startup:

```bash
./launchd/install_daemon.sh
```

To run manually in foreground:
```bash
python3 server/server.py serve
```

---

## ⚙️ Configuration & Options

Right-click the extension icon and select **Options** to customize:
- **Target Language**: Configure your default translation language.
- **Floating Button**: Toggle automatic floating button on text selection.
- **Copy Behavior**: Toggle whether popup automatically dismisses upon copying.
- **Connection Port**: Test and configure the local daemon connection.

---

## 📄 License

MIT License.
