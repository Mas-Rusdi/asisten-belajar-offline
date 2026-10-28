/**
 * Offline AI Assistant - Pure Vanilla JavaScript
 * Runs local LLMs in-browser via WebGPU and Transformers.js
 * 100% Offline-capable, Private, No Server, No APIs
 */

// ============================================================================
// 1. Database Layer (IndexedDB for Conversations and Messages)
// ============================================================================

class OfflineDB {
  constructor() {
    this.dbName = 'OfflineAIChatDB';
    this.version = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Conversations Store
        if (!db.objectStoreNames.contains('conversations')) {
          const convStore = db.createObjectStore('conversations', { keyPath: 'id' });
          convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Messages Store
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('conversationId', 'conversationId', { unique: false });
          msgStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('IndexedDB error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  async getAllConversations() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('conversations', 'readonly');
      const store = tx.objectStore('conversations');
      const request = store.getAll();

      request.onsuccess = () => {
        const convs = request.result || [];
        convs.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(convs);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getConversation(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('conversations', 'readonly');
      const store = tx.objectStore('conversations');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async createConversation(title = 'New Conversation') {
    const id = 'conv_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const now = Date.now();
    const newConv = {
      id,
      title,
      createdAt: now,
      updatedAt: now
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('conversations', 'readwrite');
      const store = tx.objectStore('conversations');
      const request = store.add(newConv);
      request.onsuccess = () => resolve(newConv);
      request.onerror = () => reject(request.error);
    });
  }

  async updateConversation(id, updates) {
    const conv = await this.getConversation(id);
    if (!conv) return null;

    const updated = { ...conv, ...updates, updatedAt: Date.now() };
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('conversations', 'readwrite');
      const store = tx.objectStore('conversations');
      const request = store.put(updated);
      request.onsuccess = () => resolve(updated);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteConversation(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['conversations', 'messages'], 'readwrite');
      const convStore = tx.objectStore('conversations');
      const msgStore = tx.objectStore('messages');

      convStore.delete(id);

      const msgIndex = msgStore.index('conversationId');
      const msgRequest = msgIndex.getAllKeys(id);

      msgRequest.onsuccess = () => {
        const keys = msgRequest.result || [];
        keys.forEach((key) => msgStore.delete(key));
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async getMessages(conversationId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('messages', 'readonly');
      const store = tx.objectStore('messages');
      const index = store.index('conversationId');
      const request = index.getAll(conversationId);

      request.onsuccess = () => {
        const msgs = request.result || [];
        msgs.sort((a, b) => a.timestamp - b.timestamp);
        resolve(msgs);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async addMessage(msg) {
    const fullMsg = {
      id: msg.id || 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      conversationId: msg.conversationId,
      role: msg.role,
      content: msg.content,
      model: msg.model || 'local-ai',
      timestamp: msg.timestamp || Date.now()
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['messages', 'conversations'], 'readwrite');
      const msgStore = tx.objectStore('messages');
      const convStore = tx.objectStore('conversations');

      msgStore.add(fullMsg);

      // Touch parent conversation updatedAt
      const convReq = convStore.get(msg.conversationId);
      convReq.onsuccess = () => {
        if (convReq.result) {
          convReq.result.updatedAt = fullMsg.timestamp;
          convStore.put(convReq.result);
        }
      };

      tx.oncomplete = () => resolve(fullMsg);
      tx.onerror = () => reject(tx.error);
    });
  }

  async updateMessage(id, updates) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const getReq = store.get(id);

      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) return resolve(null);
        const updated = { ...existing, ...updates };
        const putReq = store.put(updated);
        putReq.onsuccess = () => resolve(updated);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async clearAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['conversations', 'messages'], 'readwrite');
      tx.objectStore('conversations').clear();
      tx.objectStore('messages').clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
}

// ============================================================================
// 2. Settings & Hardware Detection
// ============================================================================

const DEFAULT_SETTINGS = {
  theme: 'dark',
  model: 'onnx-community/SmolLM2-360M-Instruct',
  device: 'webgpu',
  dtype: 'q4',
  temperature: 0.7,
  maxTokens: 512,
  topP: 0.9,
  systemPrompt: 'You are an intelligent, helpful, and concise AI assistant running completely offline inside the user\'s browser via WebGPU.'
};

class SettingsManager {
  constructor() {
    this.key = 'offline_ai_settings';
    this.settings = this.load();
  }

  load() {
    try {
      const saved = localStorage.getItem(this.key);
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  save(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      localStorage.setItem(this.key, JSON.stringify(this.settings));
    } catch (e) {
      console.warn('Unable to persist settings to localStorage:', e);
    }
    return this.settings;
  }

  reset() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.save(this.settings);
    return this.settings;
  }
}

class HardwareDetector {
  static async checkWebGPU() {
    if (!navigator.gpu) {
      return {
        supported: false,
        reason: 'navigator.gpu is unavailable. Please use a modern browser (Chrome 113+, Edge 113+) and enable hardware acceleration.'
      };
    }

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        return {
          supported: false,
          reason: 'No suitable WebGPU adapter found. Verify GPU drivers and system settings.'
        };
      }

      let adapterInfo = {};
      try {
        if (adapter.requestAdapterInfo) {
          adapterInfo = await adapter.requestAdapterInfo();
        } else if (adapter.info) {
          adapterInfo = adapter.info;
        }
      } catch (infoErr) {
        console.warn('Could not read detailed adapter info:', infoErr);
      }

      return {
        supported: true,
        vendor: adapterInfo.vendor || 'Unknown GPU Vendor',
        architecture: adapterInfo.architecture || '',
        description: adapterInfo.description || 'Hardware WebGPU Device'
      };
    } catch (err) {
      return {
        supported: false,
        reason: `WebGPU error: ${err.message}`
      };
    }
  }

  static async getStorageInfo() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const usageMB = (estimate.usage / (1024 * 1024)).toFixed(1);
        const quotaMB = (estimate.quota / (1024 * 1024)).toFixed(0);
        const quotaGB = (estimate.quota / (1024 * 1024 * 1024)).toFixed(1);
        const isPersisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;

        return {
          supported: true,
          usageMB,
          quotaMB,
          quotaGB,
          isPersisted
        };
      } catch (err) {
        console.warn('Storage estimate failed:', err);
      }
    }
    return { supported: false };
  }

  static async requestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
      try {
        return await navigator.storage.persist();
      } catch (err) {
        console.warn('Persistence request error:', err);
      }
    }
    return false;
  }
}

// ============================================================================
// 3. Lightweight Vanilla Markdown Parser & Sanitizer
// ============================================================================

class MarkdownParser {
  static escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  static render(markdownText) {
    if (!markdownText) return '';

    // Handle code blocks first to protect code contents
    const codeBlocks = [];
    let text = markdownText.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const id = `__CODE_BLOCK_${codeBlocks.length}__`;
      codeBlocks.push({ lang: lang || 'text', code: code.trimEnd() });
      return id;
    });

    // Escape HTML in the remaining text
    text = this.escapeHtml(text);

    // Headers
    text = text.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    text = text.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    text = text.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Blockquotes
    text = text.replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>');

    // Horizontal Rule
    text = text.replace(/^---$/gim, '<hr>');

    // Inline formatting
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.*?)__/g, '<strong>$1</strong>');
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
    text = text.replace(/_(.*?)_/g, '<em>$1</em>');
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Links [text](url)
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Lists (Unordered)
    text = text.replace(/^\s*[\-\*]\s+(.*)$/gim, '<li>$1</li>');
    text = text.replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>');
    text = text.replace(/<\/ul>\s*<ul>/g, ''); // merge adjacent

    // Paragraphs
    const paragraphs = text.split(/\n{2,}/);
    text = paragraphs.map(p => {
      p = p.trim();
      if (!p) return '';
      if (p.startsWith('<h') || p.startsWith('<ul>') || p.startsWith('<blockquote>') || p.startsWith('<hr>') || p.startsWith('__CODE_BLOCK_')) {
        return p;
      }
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('');

    // Restore Code Blocks
    codeBlocks.forEach((item, index) => {
      const placeholder = `__CODE_BLOCK_${index}__`;
      const escapedCode = this.escapeHtml(item.code);
      const htmlBlock = `
        <div class="code-block-wrapper">
          <div class="code-block-header">
            <span>${this.escapeHtml(item.lang)}</span>
            <button class="copy-code-btn" type="button" aria-label="Copy code">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            </button>
          </div>
          <pre><code>${escapedCode}</code></pre>
        </div>
      `;
      text = text.replace(placeholder, htmlBlock);
    });

    return text;
  }
}

// ============================================================================
// 4. Web Worker AI Engine (Inline Blob Worker)
// ============================================================================

const WORKER_SCRIPT = `
import { pipeline, env, TextStreamer, InterruptableStoppingCriteria } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';

// Force use of browser Cache API for 100% offline persistence
env.allowLocalModels = false;
env.useBrowserCache = true;

let generator = null;
let currentStoppingCriteria = null;
let activeModelId = null;
let activeDevice = null;
let activeDtype = null;

self.addEventListener('message', async (event) => {
  const { type, payload } = event.data;

  // 1. Initialize & Download Model
  if (type === 'INIT_MODEL') {
    const { modelId, device, dtype } = payload;

    // Check if already loaded with identical config
    if (generator && activeModelId === modelId && activeDevice === device && activeDtype === dtype) {
      self.postMessage({ type: 'MODEL_READY', payload: { modelId, device, dtype } });
      return;
    }

    try {
      self.postMessage({ type: 'STATUS_UPDATE', payload: { message: 'Initializing pipeline for ' + modelId + '...' } });

      const progressTracker = {};

      generator = await pipeline('text-generation', modelId, {
        device: device,
        dtype: dtype,
        progress_callback: (progressData) => {
          // progressData: { status, file, progress, loaded, total }
          if (progressData.file) {
            progressTracker[progressData.file] = {
              status: progressData.status,
              progress: progressData.progress || 0,
              loaded: progressData.loaded || 0,
              total: progressData.total || 0
            };
          }

          // Compute overall loaded and total
          let totalBytes = 0;
          let loadedBytes = 0;
          let weightedProgress = 0;
          const files = Object.keys(progressTracker);

          files.forEach(f => {
            const item = progressTracker[f];
            if (item.total > 0) {
              totalBytes += item.total;
              loadedBytes += item.loaded;
            }
            weightedProgress += (item.progress || 0);
          });

          const overallPercent = files.length > 0 ? (weightedProgress / files.length) : 0;

          self.postMessage({
            type: 'DOWNLOAD_PROGRESS',
            payload: {
              file: progressData.file || '',
              status: progressData.status,
              percent: overallPercent,
              loadedBytes,
              totalBytes,
              filesBreakdown: progressTracker
            }
          });
        }
      });

      activeModelId = modelId;
      activeDevice = device;
      activeDtype = dtype;

      self.postMessage({
        type: 'MODEL_READY',
        payload: { modelId, device, dtype }
      });
    } catch (err) {
      console.error('Worker Model Initialization Error:', err);
      self.postMessage({
        type: 'ERROR',
        payload: {
          code: 'MODEL_INIT_FAILED',
          message: err.message || 'Failed to initialize model.'
        }
      });
    }
  }

  // 2. Generate Text
  else if (type === 'GENERATE') {
    if (!generator) {
      self.postMessage({
        type: 'ERROR',
        payload: {
          code: 'MODEL_NOT_LOADED',
          message: 'Cannot generate: The model has not been loaded yet.'
        }
      });
      return;
    }

    const { messages, settings } = payload;

    try {
      currentStoppingCriteria = new InterruptableStoppingCriteria();

      const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        callback_function: (chunk) => {
          self.postMessage({
            type: 'STREAM_CHUNK',
            payload: { text: chunk }
          });
        }
      });

      const startTime = performance.now();

      const output = await generator(messages, {
        max_new_tokens: settings.maxTokens || 512,
        temperature: settings.temperature || 0.7,
        top_p: settings.topP || 0.9,
        do_sample: settings.temperature > 0.05,
        streamer: streamer,
        stopping_criteria: currentStoppingCriteria
      });

      const durationSec = (performance.now() - startTime) / 1000;

      // Extract generated text
      let fullText = '';
      if (Array.isArray(output) && output[0]) {
        if (typeof output[0].generated_text === 'string') {
          fullText = output[0].generated_text;
        } else if (Array.isArray(output[0].generated_text)) {
          // Chat output array format
          const lastMsg = output[0].generated_text[output[0].generated_text.length - 1];
          fullText = lastMsg.content || '';
        }
      }

      self.postMessage({
        type: 'GENERATION_COMPLETE',
        payload: {
          fullText,
          durationSec
        }
      });
    } catch (err) {
      if (err.message && err.message.includes('interrupted')) {
        self.postMessage({ type: 'GENERATION_INTERRUPTED' });
      } else {
        console.error('Worker Generation Error:', err);
        self.postMessage({
          type: 'ERROR',
          payload: {
            code: 'GENERATION_FAILED',
            message: err.message || 'Inference error during text generation.'
          }
        });
      }
    } finally {
      currentStoppingCriteria = null;
    }
  }

  // 3. Stop Generation
  else if (type === 'STOP_GENERATION') {
    if (currentStoppingCriteria) {
      currentStoppingCriteria.interrupt();
    }
  }
});
`;

class AIEngine {
  constructor() {
    this.worker = null;
    this.isLoaded = false;
    this.isDownloading = false;
    this.isGenerating = false;
    this.currentModel = null;
    this.currentDevice = null;
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach(cb => cb(data));
  }

  initWorker() {
    if (this.worker) return;

    try {
      const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      this.worker = new Worker(workerUrl, { type: 'module' });

      this.worker.onmessage = (event) => {
        const { type, payload } = event.data;

        if (type === 'DOWNLOAD_PROGRESS') {
          this.emit('progress', payload);
        } else if (type === 'STATUS_UPDATE') {
          this.emit('status', payload.message);
        } else if (type === 'MODEL_READY') {
          this.isLoaded = true;
          this.isDownloading = false;
          this.currentModel = payload.modelId;
          this.currentDevice = payload.device;
          this.emit('ready', payload);
        } else if (type === 'STREAM_CHUNK') {
          this.emit('stream', payload.text);
        } else if (type === 'GENERATION_COMPLETE') {
          this.isGenerating = false;
          this.emit('complete', payload);
        } else if (type === 'GENERATION_INTERRUPTED') {
          this.isGenerating = false;
          this.emit('interrupted');
        } else if (type === 'ERROR') {
          this.isDownloading = false;
          this.isGenerating = false;
          this.emit('error', payload);
        }
      };

      this.worker.onerror = (err) => {
        console.error('Worker runtime error:', err);
        this.emit('error', {
          code: 'WORKER_ERROR',
          message: 'Web Worker runtime encountered an unhandled error. Ensure you have network connectivity during first setup.'
        });
      };
    } catch (err) {
      console.error('Failed to create worker:', err);
      this.emit('error', {
        code: 'WORKER_CREATION_FAILED',
        message: `Failed to spawn Web Worker: ${err.message}`
      });
    }
  }

  loadModel(modelId, device = 'webgpu', dtype = 'q4') {
    this.initWorker();
    this.isDownloading = true;
    this.isLoaded = false;
    this.worker.postMessage({
      type: 'INIT_MODEL',
      payload: { modelId, device, dtype }
    });
  }

  generate(messages, settings) {
    if (!this.isLoaded) {
      throw new Error('Model is not ready. Please download and initialize it first.');
    }
    this.isGenerating = true;
    this.worker.postMessage({
      type: 'GENERATE',
      payload: { messages, settings }
    });
  }

  stop() {
    if (this.worker && this.isGenerating) {
      this.worker.postMessage({ type: 'STOP_GENERATION' });
    }
  }
}

// ============================================================================
// 5. Main Application Controller
// ============================================================================

class AppController {
  constructor() {
    this.db = new OfflineDB();
    this.settingsMgr = new SettingsManager();
    this.ai = new AIEngine();
    this.currentConvId = null;
    this.currentStreamingMsgId = null;
    this.currentStreamingContent = '';
    this.hardwareInfo = null;

    // DOM References
    this.elements = {
      appContainer: document.getElementById('appContainer'),
      sidebar: document.getElementById('sidebar'),
      sidebarBackdrop: document.getElementById('sidebarBackdrop'),
      toggleSidebarBtn: document.getElementById('toggleSidebarBtn'),
      closeSidebarBtn: document.getElementById('closeSidebarBtn'),
      newChatBtn: document.getElementById('newChatBtn'),
      conversationsList: document.getElementById('conversationsList'),
      currentChatTitle: document.getElementById('currentChatTitle'),
      renameCurrentChatBtn: document.getElementById('renameCurrentChatBtn'),
      messagesContainer: document.getElementById('messagesContainer'),
      welcomeScreen: document.getElementById('welcomeScreen'),
      messagesList: document.getElementById('messagesList'),
      chatInput: document.getElementById('chatInput'),
      sendBtn: document.getElementById('sendBtn'),
      generationBar: document.getElementById('generationBar'),
      generationText: document.getElementById('generationText'),
      stopGenerationBtn: document.getElementById('stopGenerationBtn'),
      modelStatusBadge: document.getElementById('modelStatusBadge'),
      modelBadgeDot: document.getElementById('modelBadgeDot'),
      modelBadgeText: document.getElementById('modelBadgeText'),
      storageStatusDot: document.getElementById('storageStatusDot'),
      offlineStatusText: document.getElementById('offlineStatusText'),
      openOfflineManagerBtn: document.getElementById('openOfflineManagerBtn'),
      topOfflineBtn: document.getElementById('topOfflineBtn'),
      openSettingsBtn: document.getElementById('openSettingsBtn'),
      themeToggleBtn: document.getElementById('themeToggleBtn'),
      footerHardwareInfo: document.getElementById('footerHardwareInfo'),
      welcomeDownloadBtn: document.getElementById('welcomeDownloadBtn'),
      welcomeConfigureBtn: document.getElementById('welcomeConfigureBtn'),
      hwWebGpuStatus: document.getElementById('hwWebGpuStatus'),
      hwSelectedModelPill: document.getElementById('hwSelectedModelPill'),
      suggestionGrid: document.getElementById('suggestionGrid'),
      toastContainer: document.getElementById('toastContainer'),
      
      // Modals
      settingsModal: document.getElementById('settingsModal'),
      closeSettingsModal: document.getElementById('closeSettingsModal'),
      saveSettingsBtn: document.getElementById('saveSettingsBtn'),
      resetSettingsBtn: document.getElementById('resetSettingsBtn'),
      modelSelect: document.getElementById('modelSelect'),
      deviceSelect: document.getElementById('deviceSelect'),
      dtypeSelect: document.getElementById('dtypeSelect'),
      tempRange: document.getElementById('tempRange'),
      tempValue: document.getElementById('tempValue'),
      tokensRange: document.getElementById('tokensRange'),
      tokensValue: document.getElementById('tokensValue'),
      topPRange: document.getElementById('topPRange'),
      topPValue: document.getElementById('topPValue'),
      systemPrompt: document.getElementById('systemPrompt'),
      
      offlineModal: document.getElementById('offlineModal'),
      closeOfflineModal: document.getElementById('closeOfflineModal'),
      startModelDownloadBtn: document.getElementById('startModelDownloadBtn'),
      clearCacheBtn: document.getElementById('clearCacheBtn'),
      downloadStatusTitle: document.getElementById('downloadStatusTitle'),
      downloadStatusPercent: document.getElementById('downloadStatusPercent'),
      downloadProgressBar: document.getElementById('downloadProgressBar'),
      downloadStatusSub: document.getElementById('downloadStatusSub'),
      filesBreakdown: document.getElementById('filesBreakdown'),
      checkWebGpuIcon: document.getElementById('checkWebGpuIcon'),
      checkWebGpuDetail: document.getElementById('checkWebGpuDetail'),
      checkSwIcon: document.getElementById('checkSwIcon'),
      checkSwDetail: document.getElementById('checkSwDetail'),
      checkModelIcon: document.getElementById('checkModelIcon'),
      checkModelDetail: document.getElementById('checkModelDetail'),
      checkStorageIcon: document.getElementById('checkStorageIcon'),
      checkStorageDetail: document.getElementById('checkStorageDetail'),

      renameModal: document.getElementById('renameModal'),
      renameInput: document.getElementById('renameInput'),
      cancelRenameBtn: document.getElementById('cancelRenameBtn'),
      confirmRenameBtn: document.getElementById('confirmRenameBtn'),
      closeRenameModal: document.getElementById('closeRenameModal')
    };
  }

  async init() {
    this.applyTheme(this.settingsMgr.settings.theme);
    await this.db.init();
    await this.registerServiceWorker();
    await this.checkHardware();
    this.bindEvents();
    this.setupAIEvents();
    await this.loadConversations();
    this.updateOfflineReadinessUI();

    // Check if models are already cached
    await this.checkCachedModels();
  }

  // --------------------------------------------------------------------------
  // Theme Management
  // --------------------------------------------------------------------------
  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    this.settingsMgr.save({ theme });
  }

  toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    this.applyTheme(next);
  }

  // --------------------------------------------------------------------------
  // Service Worker Registration
  // --------------------------------------------------------------------------
  async registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.register('./sw.js');
        console.log('[App] Service Worker registered with scope:', reg.scope);
        this.elements.checkSwIcon.textContent = '✅';
        this.elements.checkSwDetail.textContent = 'Active (App shell cached for offline access)';
      } catch (err) {
        console.warn('[App] Service Worker registration failed:', err);
        this.elements.checkSwIcon.textContent = '⚠️';
        this.elements.checkSwDetail.textContent = 'Service Worker inactive (Ensure serving over http/https).';
      }
    } else {
      this.elements.checkSwIcon.textContent = '❌';
      this.elements.checkSwDetail.textContent = 'Service Worker not supported in this browser.';
    }
  }

  // --------------------------------------------------------------------------
  // Hardware and Storage Diagnostic
  // --------------------------------------------------------------------------
  async checkHardware() {
    this.hardwareInfo = await HardwareDetector.checkWebGPU();

    if (this.hardwareInfo.supported) {
      const vendorDesc = this.hardwareInfo.vendor || 'WebGPU Adapter';
      this.elements.checkWebGpuIcon.textContent = '✅';
      this.elements.checkWebGpuDetail.textContent = `Supported: ${vendorDesc}`;
      this.elements.hwWebGpuStatus.textContent = `WebGPU: Supported (${vendorDesc})`;
      this.elements.footerHardwareInfo.textContent = `WebGPU Ready • Local Browser Inference`;
    } else {
      this.elements.checkWebGpuIcon.textContent = '⚠️';
      this.elements.checkWebGpuDetail.textContent = `Unavailable: ${this.hardwareInfo.reason}`;
      this.elements.hwWebGpuStatus.textContent = 'WebGPU: Unsupported (WASM Fallback available)';
      this.elements.footerHardwareInfo.textContent = `WASM Mode • CPU Inference Fallback`;
      this.showToast('WebGPU is not enabled or supported. Inference will fall back to CPU WASM.', 'info');
    }

    // Storage Quota
    const storage = await HardwareDetector.getStorageInfo();
    if (storage.supported) {
      this.elements.checkStorageIcon.textContent = '✅';
      this.elements.checkStorageDetail.textContent = `Used: ${storage.usageMB} MB / Available: ${storage.quotaGB} GB`;
    } else {
      this.elements.checkStorageIcon.textContent = 'ℹ️';
      this.elements.checkStorageDetail.textContent = 'Storage quota estimation unavailable.';
    }

    // Request persistent storage
    await HardwareDetector.requestPersistence();
  }

  async checkCachedModels() {
    if ('caches' in window) {
      try {
        const hasModelCache = await caches.has('transformers-cache');
        if (hasModelCache) {
          const cache = await caches.open('transformers-cache');
          const keys = await cache.keys();
          if (keys.length > 0) {
            this.elements.checkModelIcon.textContent = '✅';
            this.elements.checkModelDetail.textContent = `${keys.length} model assets found in local cache.`;
            this.elements.offlineStatusText.textContent = 'Model Assets Cached';
            this.elements.storageStatusDot.className = 'status-indicator-dot online-ready';
            return true;
          }
        }
      } catch (e) {
        console.warn('Error reading model cache:', e);
      }
    }

    this.elements.checkModelIcon.textContent = '⏳';
    this.elements.checkModelDetail.textContent = 'No model assets cached yet. Download required.';
    this.elements.offlineStatusText.textContent = 'Download Needed';
    this.elements.storageStatusDot.className = 'status-indicator-dot unloaded';
    return false;
  }

  // --------------------------------------------------------------------------
  // AI Engine Event Handling
  // --------------------------------------------------------------------------
  setupAIEvents() {
    // 1. Download Progress
    this.ai.on('progress', (data) => {
      const percent = Math.min(100, Math.max(0, Math.round(data.percent || 0)));
      this.elements.modelBadgeDot.className = 'badge-dot downloading';
      this.elements.modelBadgeText.textContent = `Downloading (${percent}%)`;
      this.elements.downloadProgressBar.style.width = `${percent}%`;
      this.elements.downloadStatusPercent.textContent = `${percent}%`;

      if (data.file) {
        const fileName = data.file.split('/').pop();
        const loadedMB = (data.loadedBytes / (1024 * 1024)).toFixed(1);
        const totalMB = (data.totalBytes / (1024 * 1024)).toFixed(1);
        this.elements.downloadStatusSub.textContent = `Fetching ${fileName} (${loadedMB} MB / ${totalMB} MB)...`;
      }

      // Update Breakdown
      if (data.filesBreakdown) {
        this.renderFilesBreakdown(data.filesBreakdown);
      }
    });

    // 2. Status message
    this.ai.on('status', (msg) => {
      this.elements.downloadStatusSub.textContent = msg;
    });

    // 3. Model Ready
    this.ai.on('ready', (payload) => {
      this.elements.modelBadgeDot.className = 'badge-dot ready';
      const shortName = payload.modelId.split('/').pop();
      this.elements.modelBadgeText.textContent = `${shortName} (${payload.device.toUpperCase()})`;
      this.elements.storageStatusDot.className = 'status-indicator-dot online-ready';
      this.elements.offlineStatusText.textContent = 'Offline Ready';
      this.elements.checkModelIcon.textContent = '✅';
      this.elements.checkModelDetail.textContent = `Model ${shortName} loaded in local memory.`;
      this.elements.downloadProgressBar.style.width = '100%';
      this.elements.downloadStatusPercent.textContent = '100%';
      this.elements.downloadStatusTitle.textContent = 'Model Ready for Offline Use';
      this.elements.downloadStatusSub.textContent = 'Weights cached in browser storage. You can now use the app without internet!';
      this.elements.startModelDownloadBtn.disabled = false;
      this.elements.startModelDownloadBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Model Ready (Re-download)</span>
      `;

      // Update welcome card
      const welcomeCard = document.getElementById('welcomeModelCard');
      if (welcomeCard) {
        welcomeCard.style.display = 'none';
      }

      this.updateSendButtonState();
      this.showToast(`Model ${shortName} successfully initialized! Ready for offline conversations.`, 'success');
    });

    // 4. Stream token chunk
    this.ai.on('stream', (text) => {
      this.currentStreamingContent += text;
      this.updateStreamingMessageUI(this.currentStreamingContent);
    });

    // 5. Generation complete
    this.ai.on('complete', async (payload) => {
      this.elements.generationBar.style.display = 'none';
      this.updateSendButtonState();

      if (this.currentStreamingMsgId) {
        await this.db.updateMessage(this.currentStreamingMsgId, {
          content: this.currentStreamingContent
        });
        this.finalizeStreamingMessageUI();
        this.currentStreamingMsgId = null;
        this.currentStreamingContent = '';
      }

      this.showToast(`Response complete in ${payload.durationSec?.toFixed(1) || ''}s`, 'info');
    });

    // 6. Generation interrupted
    this.ai.on('interrupted', async () => {
      this.elements.generationBar.style.display = 'none';
      this.updateSendButtonState();

      if (this.currentStreamingMsgId) {
        await this.db.updateMessage(this.currentStreamingMsgId, {
          content: this.currentStreamingContent + '\n\n*(Generation stopped by user)*'
        });
        this.finalizeStreamingMessageUI();
        this.currentStreamingMsgId = null;
        this.currentStreamingContent = '';
      }
      this.showToast('Generation stopped.', 'info');
    });

    // 7. Error handling
    this.ai.on('error', (err) => {
      this.elements.generationBar.style.display = 'none';
      this.elements.modelBadgeDot.className = 'badge-dot error';
      this.elements.modelBadgeText.textContent = 'Model Error';
      this.elements.startModelDownloadBtn.disabled = false;
      this.updateSendButtonState();

      console.error('[AI Error]', err);
      let errorHelp = err.message;

      if (err.message.includes('WebGPU') || err.code === 'UNSUPPORTED_WEBGPU') {
        errorHelp = 'WebGPU failed to initialize. Try switching to WASM backend in Settings.';
      } else if (err.message.includes('memory') || err.message.includes('OOM')) {
        errorHelp = 'Browser ran out of memory. Try selecting the smaller SmolLM2-135M model.';
      } else if (!navigator.onLine && !this.ai.isLoaded) {
        errorHelp = 'Offline error: Model has not been downloaded yet. Connect to the internet once to cache the model.';
      }

      this.showToast(`Error: ${errorHelp}`, 'error');
    });
  }

  renderFilesBreakdown(breakdown) {
    const container = this.elements.filesBreakdown;
    container.innerHTML = '';
    Object.keys(breakdown).forEach(file => {
      const item = breakdown[file];
      const fileName = file.split('/').pop();
      const row = document.createElement('div');
      row.className = 'file-row';
      const pct = Math.round(item.progress || 0);
      row.innerHTML = `
        <span>${fileName}</span>
        <span>${pct}% (${item.status})</span>
      `;
      container.appendChild(row);
    });
  }

  // --------------------------------------------------------------------------
  // Event Listeners & Binding
  // --------------------------------------------------------------------------
  bindEvents() {
    // Sidebar Toggles
    this.elements.toggleSidebarBtn.addEventListener('click', () => {
      this.elements.sidebar.classList.toggle('open');
      this.elements.sidebarBackdrop.classList.toggle('active');
    });

    this.elements.closeSidebarBtn.addEventListener('click', () => {
      this.elements.sidebar.classList.remove('open');
      this.elements.sidebarBackdrop.classList.remove('active');
    });

    this.elements.sidebarBackdrop.addEventListener('click', () => {
      this.elements.sidebar.classList.remove('open');
      this.elements.sidebarBackdrop.classList.remove('active');
    });

    // Theme Toggle
    this.elements.themeToggleBtn.addEventListener('click', () => this.toggleTheme());

    // New Chat
    this.elements.newChatBtn.addEventListener('click', () => this.createNewConversation());

    // Rename Chat
    this.elements.renameCurrentChatBtn.addEventListener('click', () => this.openRenameModal());
    this.elements.cancelRenameBtn.addEventListener('click', () => this.elements.renameModal.close());
    this.elements.closeRenameModal.addEventListener('click', () => this.elements.renameModal.close());
    this.elements.confirmRenameBtn.addEventListener('click', () => this.confirmRename());

    // Chat Input Auto-Resize & Send
    this.elements.chatInput.addEventListener('input', () => {
      this.autoResizeTextarea();
      this.updateSendButtonState();
    });

    this.elements.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    this.elements.sendBtn.addEventListener('click', () => this.sendMessage());

    // Stop Generation
    this.elements.stopGenerationBtn.addEventListener('click', () => {
      this.ai.stop();
    });

    // Modals: Settings
    this.elements.openSettingsBtn.addEventListener('click', () => this.openSettingsModal());
    this.elements.closeSettingsModal.addEventListener('click', () => this.elements.settingsModal.close());
    this.elements.saveSettingsBtn.addEventListener('click', () => this.saveSettings());
    this.elements.resetSettingsBtn.addEventListener('click', () => this.resetSettings());

    // Range Sliders
    this.elements.tempRange.addEventListener('input', (e) => {
      this.elements.tempValue.textContent = e.target.value;
    });
    this.elements.tokensRange.addEventListener('input', (e) => {
      this.elements.tokensValue.textContent = e.target.value;
    });
    this.elements.topPRange.addEventListener('input', (e) => {
      this.elements.topPValue.textContent = e.target.value;
    });

    // Modals: Offline Manager
    const openOffline = () => this.openOfflineModal();
    this.elements.openOfflineManagerBtn.addEventListener('click', openOffline);
    this.elements.topOfflineBtn.addEventListener('click', openOffline);
    this.elements.closeOfflineModal.addEventListener('click', () => this.elements.offlineModal.close());

    // Download & Cache Trigger
    this.elements.startModelDownloadBtn.addEventListener('click', () => this.triggerModelDownload());
    this.elements.welcomeDownloadBtn.addEventListener('click', () => this.triggerModelDownload());
    this.elements.welcomeConfigureBtn.addEventListener('click', () => this.openSettingsModal());

    // Clear Cache
    this.elements.clearCacheBtn.addEventListener('click', () => this.clearModelCache());

    // Suggestions Chips
    this.elements.suggestionGrid.addEventListener('click', (e) => {
      const chip = e.target.closest('.suggestion-chip');
      if (chip) {
        const prompt = chip.getAttribute('data-prompt');
        this.elements.chatInput.value = prompt;
        this.autoResizeTextarea();
        this.updateSendButtonState();
        this.sendMessage();
      }
    });

    // Delegated click for Copy message & Copy code buttons
    this.elements.messagesList.addEventListener('click', (e) => {
      // Copy Message text
      const copyMsgBtn = e.target.closest('.copy-msg-btn');
      if (copyMsgBtn) {
        const textToCopy = copyMsgBtn.getAttribute('data-text');
        this.copyToClipboard(textToCopy, copyMsgBtn);
        return;
      }

      // Copy Code block
      const copyCodeBtn = e.target.closest('.copy-code-btn');
      if (copyCodeBtn) {
        const pre = copyCodeBtn.closest('.code-block-wrapper')?.querySelector('pre');
        if (pre) {
          this.copyToClipboard(pre.innerText, copyCodeBtn);
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // Conversation Management
  // --------------------------------------------------------------------------
  async loadConversations() {
    const convs = await this.db.getAllConversations();
    this.renderConversationsList(convs);

    if (convs.length > 0) {
      await this.selectConversation(convs[0].id);
    } else {
      await this.createNewConversation();
    }
  }

  renderConversationsList(convs) {
    const list = this.elements.conversationsList;
    list.innerHTML = '';

    if (convs.length === 0) {
      list.innerHTML = '<div style="font-size:0.8rem; color:var(--text-dim); padding:10px;">No chats yet.</div>';
      return;
    }

    convs.forEach(conv => {
      const item = document.createElement('div');
      item.className = `conversation-item ${conv.id === this.currentConvId ? 'active' : ''}`;
      item.setAttribute('data-id', conv.id);

      item.innerHTML = `
        <span class="conv-title">${MarkdownParser.escapeHtml(conv.title)}</span>
        <div class="conv-actions">
          <button class="conv-action-btn edit-btn" title="Rename chat" aria-label="Rename chat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487zm0 0L19.5 7.125" />
            </svg>
          </button>
          <button class="conv-action-btn delete-btn" title="Delete chat" aria-label="Delete chat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      `;

      // Click to select
      item.addEventListener('click', (e) => {
        if (e.target.closest('.conv-action-btn')) return;
        this.selectConversation(conv.id);
        if (window.innerWidth <= 768) {
          this.elements.sidebar.classList.remove('open');
          this.elements.sidebarBackdrop.classList.remove('active');
        }
      });

      // Rename button
      item.querySelector('.edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openRenameModal(conv.id, conv.title);
      });

      // Delete button
      item.querySelector('.delete-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Delete conversation "${conv.title}"?`)) {
          await this.db.deleteConversation(conv.id);
          this.showToast('Conversation deleted', 'info');
          await this.loadConversations();
        }
      });

      list.appendChild(item);
    });
  }

  async createNewConversation() {
    const conv = await this.db.createConversation('New Conversation');
    await this.loadConversations();
    await this.selectConversation(conv.id);
  }

  async selectConversation(id) {
    this.currentConvId = id;
    const conv = await this.db.getConversation(id);
    if (!conv) return;

    this.elements.currentChatTitle.textContent = conv.title;

    // Update active highlight in sidebar
    const items = this.elements.conversationsList.querySelectorAll('.conversation-item');
    items.forEach(el => {
      el.classList.toggle('active', el.getAttribute('data-id') === id);
    });

    // Render messages
    const msgs = await this.db.getMessages(id);
    this.renderMessages(msgs);
  }

  openRenameModal(convId = this.currentConvId, currentTitle = null) {
    if (!convId) return;
    this.renameTargetId = convId;
    this.elements.renameInput.value = currentTitle || this.elements.currentChatTitle.textContent;
    this.elements.renameModal.showModal();
    this.elements.renameInput.focus();
  }

  async confirmRename() {
    const newTitle = this.elements.renameInput.value.trim();
    if (newTitle && this.renameTargetId) {
      await this.db.updateConversation(this.renameTargetId, { title: newTitle });
      if (this.renameTargetId === this.currentConvId) {
        this.elements.currentChatTitle.textContent = newTitle;
      }
      this.elements.renameModal.close();
      const convs = await this.db.getAllConversations();
      this.renderConversationsList(convs);
    }
  }

  // --------------------------------------------------------------------------
  // Messages Rendering
  // --------------------------------------------------------------------------
  renderMessages(messages) {
    const list = this.elements.messagesList;
    list.innerHTML = '';

    if (!messages || messages.length === 0) {
      this.elements.welcomeScreen.style.display = 'flex';
      list.style.display = 'none';
      return;
    }

    this.elements.welcomeScreen.style.display = 'none';
    list.style.display = 'flex';

    messages.forEach(msg => {
      this.appendMessageBubble(msg);
    });

    this.scrollToBottom();
  }

  appendMessageBubble(msg) {
    const list = this.elements.messagesList;
    const isUser = msg.role === 'user';

    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${isUser ? 'user' : 'assistant'}`;
    bubble.id = msg.id;

    const formattedTime = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const renderedContent = isUser ? MarkdownParser.escapeHtml(msg.content).replace(/\n/g, '<br>') : MarkdownParser.render(msg.content);

    bubble.innerHTML = `
      <div class="message-avatar">
        ${isUser ? 'You' : 'AI'}
      </div>
      <div class="message-content-wrapper">
        <div class="message-header">
          <span class="sender-name">${isUser ? 'You' : 'Offline Assistant'}</span>
          ${!isUser ? `<span class="model-tag">${MarkdownParser.escapeHtml(msg.model || 'local')}</span>` : ''}
          <span class="message-timestamp">${formattedTime}</span>
        </div>
        <div class="message-body" id="body_${msg.id}">
          ${renderedContent}
        </div>
        ${!isUser ? `
          <div class="message-actions">
            <button class="action-pill-btn copy-msg-btn" data-text="${MarkdownParser.escapeHtml(msg.content)}" title="Copy entire response">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            </button>
          </div>
        ` : ''}
      </div>
    `;

    list.appendChild(bubble);
    this.scrollToBottom();
  }

  updateStreamingMessageUI(content) {
    if (!this.currentStreamingMsgId) return;

    let bodyEl = document.getElementById(`body_${this.currentStreamingMsgId}`);
    if (!bodyEl) {
      // Create streaming placeholder bubble if not present
      const list = this.elements.messagesList;
      this.elements.welcomeScreen.style.display = 'none';
      list.style.display = 'flex';

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble assistant';
      bubble.id = this.currentStreamingMsgId;
      bubble.innerHTML = `
        <div class="message-avatar">AI</div>
        <div class="message-content-wrapper">
          <div class="message-header">
            <span class="sender-name">Offline Assistant</span>
            <span class="model-tag">${this.settingsMgr.settings.model.split('/').pop()}</span>
          </div>
          <div class="message-body" id="body_${this.currentStreamingMsgId}"></div>
        </div>
      `;
      list.appendChild(bubble);
      bodyEl = document.getElementById(`body_${this.currentStreamingMsgId}`);
    }

    bodyEl.innerHTML = MarkdownParser.render(content) + '<span class="streaming-cursor"></span>';
    this.scrollToBottom();
  }

  finalizeStreamingMessageUI() {
    if (!this.currentStreamingMsgId) return;
    const bodyEl = document.getElementById(`body_${this.currentStreamingMsgId}`);
    if (bodyEl) {
      bodyEl.innerHTML = MarkdownParser.render(this.currentStreamingContent);

      // Add copy button
      const wrapper = bodyEl.closest('.message-content-wrapper');
      if (wrapper && !wrapper.querySelector('.message-actions')) {
        const actions = document.createElement('div');
        actions.className = 'message-actions';
        actions.innerHTML = `
          <button class="action-pill-btn copy-msg-btn" data-text="${MarkdownParser.escapeHtml(this.currentStreamingContent)}" title="Copy response">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span>Copy</span>
          </button>
        `;
        wrapper.appendChild(actions);
      }
    }
  }

  scrollToBottom() {
    this.elements.messagesContainer.scrollTop = this.elements.messagesContainer.scrollHeight;
  }

  // --------------------------------------------------------------------------
  // Message Sending & Inference
  // --------------------------------------------------------------------------
  async sendMessage() {
    const text = this.elements.chatInput.value.trim();
    if (!text || this.ai.isGenerating) return;

    if (!this.ai.isLoaded) {
      this.showToast('Please download and initialize the model first before chatting.', 'error');
      this.openOfflineModal();
      return;
    }

    // Reset textarea
    this.elements.chatInput.value = '';
    this.autoResizeTextarea();
    this.updateSendButtonState();

    // 1. Add User Message
    const userMsg = await this.db.addMessage({
      conversationId: this.currentConvId,
      role: 'user',
      content: text
    });

    this.appendMessageBubble(userMsg);

    // Auto-update conversation title if it's the first message
    const msgs = await this.db.getMessages(this.currentConvId);
    if (msgs.length === 1) {
      const summaryTitle = text.slice(0, 35) + (text.length > 35 ? '...' : '');
      await this.db.updateConversation(this.currentConvId, { title: summaryTitle });
      this.elements.currentChatTitle.textContent = summaryTitle;
      const convs = await this.db.getAllConversations();
      this.renderConversationsList(convs);
    }

    // 2. Prepare assistant placeholder
    this.currentStreamingMsgId = 'msg_' + Date.now();
    this.currentStreamingContent = '';

    // Show generation bar
    this.elements.generationBar.style.display = 'flex';
    this.elements.generationText.textContent = `Generating offline response (${this.settingsMgr.settings.device.toUpperCase()})...`;

    // 3. Format message history for Chat Template
    const formattedHistory = [
      { role: 'system', content: this.settingsMgr.settings.systemPrompt }
    ];

    msgs.forEach(m => {
      formattedHistory.push({
        role: m.role,
        content: m.content
      });
    });

    try {
      this.ai.generate(formattedHistory, this.settingsMgr.settings);
    } catch (err) {
      this.showToast(`Generation failed: ${err.message}`, 'error');
      this.elements.generationBar.style.display = 'none';
    }
  }

  // --------------------------------------------------------------------------
  // UI Helpers (Textarea auto-resize, send button state, copy)
  // --------------------------------------------------------------------------
  autoResizeTextarea() {
    const textarea = this.elements.chatInput;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }

  updateSendButtonState() {
    const hasText = this.elements.chatInput.value.trim().length > 0;
    this.elements.sendBtn.disabled = !hasText || this.ai.isGenerating || !this.ai.isLoaded;
  }

  async copyToClipboard(text, btnElement) {
    try {
      await navigator.clipboard.writeText(text);
      if (btnElement) {
        const originalText = btnElement.innerHTML;
        btnElement.innerHTML = `
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          <span>Copied!</span>
        `;
        setTimeout(() => {
          btnElement.innerHTML = originalText;
        }, 2000);
      }
      this.showToast('Copied to clipboard!', 'info');
    } catch (err) {
      this.showToast('Failed to copy to clipboard', 'error');
    }
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    this.elements.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // --------------------------------------------------------------------------
  // Modals & Settings Management
  // --------------------------------------------------------------------------
  openSettingsModal() {
    const s = this.settingsMgr.settings;
    this.elements.modelSelect.value = s.model;
    this.elements.deviceSelect.value = s.device;
    this.elements.dtypeSelect.value = s.dtype;
    this.elements.tempRange.value = s.temperature;
    this.elements.tempValue.textContent = s.temperature;
    this.elements.tokensRange.value = s.maxTokens;
    this.elements.tokensValue.textContent = s.maxTokens;
    this.elements.topPRange.value = s.topP;
    this.elements.topPValue.textContent = s.topP;
    this.elements.systemPrompt.value = s.systemPrompt;

    this.elements.settingsModal.showModal();
  }

  saveSettings() {
    const oldModel = this.settingsMgr.settings.model;
    const oldDevice = this.settingsMgr.settings.device;

    const newSettings = this.settingsMgr.save({
      model: this.elements.modelSelect.value,
      device: this.elements.deviceSelect.value,
      dtype: this.elements.dtypeSelect.value,
      temperature: parseFloat(this.elements.tempRange.value),
      maxTokens: parseInt(this.elements.tokensRange.value, 10),
      topP: parseFloat(this.elements.topPRange.value),
      systemPrompt: this.elements.systemPrompt.value.trim()
    });

    this.elements.settingsModal.close();
    this.showToast('Settings saved successfully.', 'success');
    this.elements.hwSelectedModelPill.textContent = `Model: ${newSettings.model.split('/').pop()} (${newSettings.dtype})`;

    // If model or device changed, notify that reload is required
    if (oldModel !== newSettings.model || oldDevice !== newSettings.device) {
      this.elements.modelBadgeDot.className = 'badge-dot';
      this.elements.modelBadgeText.textContent = 'Model Changed';
      this.showToast('Model changed. Click "Download & Cache Model" to initialize.', 'info');
    }
  }

  resetSettings() {
    const s = this.settingsMgr.reset();
    this.elements.modelSelect.value = s.model;
    this.elements.deviceSelect.value = s.device;
    this.elements.dtypeSelect.value = s.dtype;
    this.elements.tempRange.value = s.temperature;
    this.elements.tempValue.textContent = s.temperature;
    this.elements.tokensRange.value = s.maxTokens;
    this.elements.tokensValue.textContent = s.maxTokens;
    this.elements.topPRange.value = s.topP;
    this.elements.topPValue.textContent = s.topP;
    this.elements.systemPrompt.value = s.systemPrompt;
    this.showToast('Settings reset to defaults.', 'info');
  }

  openOfflineModal() {
    this.updateOfflineReadinessUI();
    this.elements.offlineModal.showModal();
  }

  async updateOfflineReadinessUI() {
    await this.checkHardware();
    await this.checkCachedModels();
  }

  async triggerModelDownload() {
    const s = this.settingsMgr.settings;
    this.elements.startModelDownloadBtn.disabled = true;
    this.elements.downloadStatusTitle.textContent = `Downloading ${s.model.split('/').pop()}...`;
    this.elements.downloadStatusSub.textContent = 'Connecting to Hugging Face CDN. Please keep the tab open.';
    this.elements.downloadProgressBar.style.width = '2%';
    this.elements.downloadStatusPercent.textContent = '2%';

    this.ai.loadModel(s.model, s.device, s.dtype);
  }

  async clearModelCache() {
    if (!confirm('Are you sure you want to delete all cached models from browser storage? You will need an internet connection to download them again.')) {
      return;
    }

    try {
      if ('caches' in window) {
        await caches.delete('transformers-cache');
      }
      this.ai.isLoaded = false;
      this.elements.checkModelIcon.textContent = '⏳';
      this.elements.checkModelDetail.textContent = 'Cache cleared. Model download needed.';
      this.elements.modelBadgeDot.className = 'badge-dot';
      this.elements.modelBadgeText.textContent = 'Model Unloaded';
      this.elements.storageStatusDot.className = 'status-indicator-dot unloaded';
      this.elements.offlineStatusText.textContent = 'Cache Cleared';
      this.updateSendButtonState();
      this.showToast('Model cache deleted from disk.', 'info');
    } catch (e) {
      this.showToast(`Failed to clear cache: ${e.message}`, 'error');
    }
  }
}

// ============================================================================
// 6. Bootstrap Application on DOM Ready
// ============================================================================

window.addEventListener('DOMContentLoaded', () => {
  const app = new AppController();
  app.init().catch(err => {
    console.error('Fatal Application Init Error:', err);
  });
});

