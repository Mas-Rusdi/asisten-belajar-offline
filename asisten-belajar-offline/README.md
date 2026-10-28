# Offline AI Assistant (WebGPU & Transformers.js)

A fully functional, privacy-first offline AI chatbot built with **100% HTML, CSS, and Vanilla JavaScript**.

This application runs quantized neural language models directly inside your web browser using **WebGPU** hardware acceleration and **Transformers.js v3**. No backend server, no cloud APIs, and no tracking.

---

## 🚀 Key Features

- **Direct In-Browser AI**: Runs local LLMs via WebGPU (with WebAssembly / WASM CPU fallback).
- **Zero Backend Required**: Pure client-side code (`index.html`, `style.css`, `script.js`, `sw.js`).
- **Web Worker Inference**: Runs the neural network in a background Web Worker so the user interface never freezes.
- **Token Streaming**: Real-time token streaming as the model generates text.
- **Stop Generation**: Immediate interruption of ongoing text generation.
- **Complete Offline Cache**: Service Worker (`sw.js`) and Browser Cache Storage (`transformers-cache`) store application files and neural model weights on disk.
- **Local Chat History**: Persistent multi-session conversation history using **IndexedDB**.
- **Dark & Light Mode**: Clean, responsive UI with seamless theme toggling.
- **Markdown & Code Support**: Full markdown rendering with language tags and one-click code copying.

---

## 💻 Hardware Compatibility & Model Selection

Tested for smooth performance on modern laptops with **16 GB RAM and Intel Iris Xe integrated graphics**:

| Model ID | Quantization | Download Size | Best For |
|---|---|---|---|
| `onnx-community/SmolLM2-360M-Instruct` | `q4` (4-bit) | ~260 MB | **Recommended**: Great balance of reasoning & speed on Intel Iris Xe |
| `onnx-community/SmolLM2-135M-Instruct` | `q4` (4-bit) | ~120 MB | Ultra-lightweight, rapid testing, low memory devices |
| `onnx-community/Qwen2.5-0.5B-Instruct` | `q4` (4-bit) | ~380 MB | Higher reasoning, multi-language, programming assistance |
| `onnx-community/Llama-3.2-1B-Instruct` | `q4` (4-bit) | ~750 MB | Advanced capability; requires dedicated GPU or strong iGPU |

---

## 🛠️ How to Run Locally

> [!IMPORTANT]
> **Why `file:///` does not work**:
> Modern browser security standards restrict ES modules, Web Workers, Service Workers, and Cache API from executing over the `file:///` protocol.
> The application must be served over a local HTTP origin (`http://localhost`).

### Option 1: VS Code Live Server (Easiest)
1. Open the project folder in VS Code.
2. Install the **Live Server** extension (by Ritwick Dey).
3. Right-click `index.html` and select **"Open with Live Server"**.
4. The app opens at `http://127.0.0.1:5500`.

### Option 2: Python Static Server
If Python is installed on your machine:
```bash
python -m http.server 8080
```
Open your browser at `http://localhost:8080`.

### Option 3: Node / npx Static Server
```bash
npx serve .
# or
npx http-server -p 8080
```

---

## 📶 Preparing for Offline Use (Step-by-Step)

1. **Connect to the Internet**: Ensure your computer has internet access for the first-time setup.
2. **Open the App**: Navigate to `http://localhost:8080` in a WebGPU-compatible browser (**Google Chrome 113+** or **Microsoft Edge 113+**).
3. **Verify WebGPU**: Check the status badge at the top right. It should indicate WebGPU support.
4. **Download & Cache the Model**:
   - Click the **"Download & Initialize Model"** button on the welcome screen (or open the **Offline Readiness** modal from the sidebar/top bar).
   - Watch the multi-file download progress bar.
   - Transformers.js downloads the ONNX model weights and tokenizer and saves them into the browser's persistent `Cache Storage`.
5. **Verify Offline Readiness**:
   - Wait until the status badge turns green: **"Offline Ready"**.
6. **Go Offline**:
   - Disconnect your Wi-Fi or unplug your Ethernet cable.
   - Or open Chrome DevTools (`F12`) &rarr; **Network** tab &rarr; select **Offline**.
   - Refresh the page (`F5`). The application and model weights will load directly from local browser cache without requesting anything over the network!

---

## 📁 Source File Architecture

```
asisten-belajar-offline/
├── index.html   # Semantic UI structure, modals, SVG icons, and accessibility markup
├── style.css    # Responsive theme design (dark/light), typography, and chat components
├── script.js    # IndexedDB, WebGPU detector, Web Worker AI inference, and Markdown parser
├── sw.js        # Service Worker for local caching of app shell and model assets
└── README.md    # Documentation and offline verification guide
```
