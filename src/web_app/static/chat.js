/**
 * Chat Engine Module
 * Provides unified chat functionality for both main window and popup
 */

// Module-level state shared across all ChatEngine instances
let _globalRunningCount = 0;   // Number of instances with agentRunning === true
let _sharedStartTime = null;   // Server start_time (shared to avoid duplicate health checks)
let _startTimeInitialized = false;

class ChatEngine {
  constructor(config) {
    // Required config
    this.getContextPath = config.getContextPath || (() => '');
    this.getWorkingDirectory = config.getWorkingDirectory || (() => '');
    this.getChatId = config.getChatId || (() => null);
    this.setChatId = config.setChatId || (() => {});
    this.onChatIdChange = config.onChatIdChange || (() => {});
    this.onComplete = config.onComplete || (() => {}); // Callback after agent completes
    
    // Optional config with defaults
    this.messagesContainerId = config.messagesContainerId || 'chat-messages';
    this.promptInputId = config.promptInputId || 'chat-prompt';
    this.sendButtonId = config.sendButtonId || 'btn-send-agent';
    this.agentRunningId = config.agentRunningId || 'agent-running';
    this.newChatButtonId = config.newChatButtonId || 'btn-new-chat';
    this.modelSelectId = config.modelSelectId || 'chat-model-select';
    this.showToast = config.showToast || (() => {});
    this.onRunningChange = config.onRunningChange || (() => {});
    this.onNeedsAttention = config.onNeedsAttention || (() => {});
    this.skipSharedUISetup = config.skipSharedUISetup || false;
    
    // State
    this.agentRunning = false;
    this._runId = 0; // incremented per _executePrompt call; guards finally from stomping a newer call
    this.currentChatId = this.getChatId();
    this.attachedImages = []; // Array of {id, data, name, size}
    this.attachedFiles = []; // Array of {id, name, content, size} for markdown/text files
    this.messageQueue = []; // Queue of {prompt, images, files, displayText} for sequential processing
    this.processingQueue = false;
    this.userSentMessage = false; // true once the user sends at least one message this session

    this._knownStartTime = null; // server start_time from /api/health, used to detect restarts

    // Prompt auto-save state
    this._saveIntervalId = null;
    this._sessionKey = config.tabId
      ? `appapp_prompt_draft_${config.tabId}`
      : `appapp_prompt_draft_${this.promptInputId}`;
    this._queueKey = config.tabId
      ? `appapp_message_queue_${config.tabId}`
      : `appapp_message_queue_${this.promptInputId}`;

    // Initialize — skip shared UI setup when managed externally (e.g. by ChatTabManager)
    if (!this.skipSharedUISetup) {
      this.setupEventListeners();
      this.setupImageHandling();
      this.setupModelSelector();
      this._restorePromptDraft();
    }
    if (!this.skipSharedUISetup) {
      this.loadChatSession();
    }
    this._initStartTime();
    this._restoreQueue();
  }

  // ─── Safe agentRunning setter (maintains global counter) ──────────────────

  _setAgentRunning(value) {
    const prev = this.agentRunning;
    this.agentRunning = value;
    if (value && !prev) _globalRunningCount++;
    if (!value && prev) _globalRunningCount = Math.max(0, _globalRunningCount - 1);
    this.onRunningChange(value);
  }

  static get globalRunningCount() {
    return _globalRunningCount;
  }

  setupEventListeners() {
    const promptEl = document.getElementById(this.promptInputId);
    if (promptEl) {
      promptEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          this.sendPrompt();
        }
      });

      // Auto-save draft: poll every 1s while focused, save once on blur
      promptEl.addEventListener('focus', () => this._startPromptSaveLoop());
      promptEl.addEventListener('blur', () => this._stopPromptSaveLoop());
    }

    const newChatBtn = document.getElementById(this.newChatButtonId);
    if (newChatBtn) {
      newChatBtn.addEventListener('click', () => this.startNewChat());
    }

    const sendBtn = document.getElementById(this.sendButtonId);
    if (sendBtn) {
      sendBtn.addEventListener('click', () => this.sendPrompt());
    }

    const cancelBtn = document.getElementById('btn-cancel-agent');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.cancelRun());
    }

    // Delegated click handler for chat reference links (chat:// URIs)
    const messagesEl = document.getElementById(this.messagesContainerId);
    if (messagesEl) {
      messagesEl.addEventListener('click', (e) => {
        const link = e.target.closest('.chat-ref-link');
        if (link) {
          e.preventDefault();
          const chatId = link.dataset.chatId;
          if (chatId && typeof loadChat === 'function') {
            loadChat(chatId);
          }
        }
      });
    }
  }

  // ─── Prompt draft auto-save (sessionStorage) ────────────────────────────────

  _restorePromptDraft() {
    const promptEl = document.getElementById(this.promptInputId);
    if (!promptEl) return;
    const saved = sessionStorage.getItem(this._sessionKey);
    if (saved) promptEl.value = saved;
  }

  _savePromptDraft() {
    const promptEl = document.getElementById(this.promptInputId);
    if (!promptEl) return;
    const val = promptEl.value;
    if (val) {
      sessionStorage.setItem(this._sessionKey, val);
    } else {
      sessionStorage.removeItem(this._sessionKey);
    }
  }

  _startPromptSaveLoop() {
    if (this._saveIntervalId) return;
    this._saveIntervalId = setInterval(() => this._savePromptDraft(), 1000);
  }

  _stopPromptSaveLoop() {
    if (this._saveIntervalId) {
      clearInterval(this._saveIntervalId);
      this._saveIntervalId = null;
    }
    this._savePromptDraft();
  }

  // ─── Queue persistence (localStorage) ───────────────────────────────────────

  _persistQueue() {
    try {
      if (this.messageQueue.length > 0) {
        // Omit images — too large for localStorage
        const serializable = this.messageQueue.map(m => ({
          prompt: m.prompt,
          displayText: m.displayText,
        }));
        localStorage.setItem(this._queueKey, JSON.stringify(serializable));
      } else {
        localStorage.removeItem(this._queueKey);
      }
    } catch (e) {
      console.warn('Failed to persist message queue:', e);
    }
  }

  _restoreQueue() {
    try {
      const saved = localStorage.getItem(this._queueKey);
      if (!saved) return;

      const items = JSON.parse(saved);
      if (!Array.isArray(items) || items.length === 0) return;

      this.messageQueue = items.map(item => ({
        prompt: item.prompt,
        images: [],
        displayText: item.displayText,
      }));

      // Show queued indicators and start processing after page settles
      for (const item of this.messageQueue) {
        this._addQueuedIndicator(item.displayText);
      }
      this._updateQueueBadge();

      if (!this.agentRunning) {
        const count = this.messageQueue.length;
        this.showToast(`${count} queued message${count > 1 ? 's' : ''} — resuming...`, 'info');
        setTimeout(() => {
          this._processQueue().catch(err => {
            console.error('Error processing restored queue:', err);
            this._drainQueueUI();
          });
        }, 2000);
      }
    } catch (e) {
      console.warn('Failed to restore message queue:', e);
      localStorage.removeItem(this._queueKey);
    }
  }

  // ─── Auto-reload on code changes ────────────────────────────────────────────

  async _initStartTime() {
    // Share one health check across all instances
    if (_startTimeInitialized) {
      this._knownStartTime = _sharedStartTime;
      return;
    }
    _startTimeInitialized = true;
    try {
      const resp = await fetch('/api/health');
      const data = await resp.json();
      _sharedStartTime = data.start_time;
      this._knownStartTime = _sharedStartTime;
    } catch {
      // Server unreachable on init; restart detection will be skipped
    }
  }

  async _checkForServerRestart() {
    if (this._knownStartTime === null) return false;
    // Don't reload if any agents are still running across all tabs
    if (_globalRunningCount > 0) return false;
    const maxAttempts = 10; // poll every 1s for up to 10s
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const resp = await fetch('/api/health');
        const data = await resp.json();
        if (data.start_time !== this._knownStartTime) {
          // Re-check: don't reload if agents started running during our poll
          if (_globalRunningCount > 0) return false;
          this.showToast('Server restarted — reloading...', 'info');
          setTimeout(() => window.location.reload(), 800);
          return true;
        }
        // Same start_time — wait 1s and try again in case restart is in progress
        await new Promise(r => setTimeout(r, 1000));
      } catch {
        // Server is down (likely restarting) — wait 500ms and retry
        await new Promise(r => setTimeout(r, 500));
      }
    }
    return false;
  }

  async setupModelSelector() {
    const modelSelect = document.getElementById(this.modelSelectId);
    if (!modelSelect) return;

    // Load saved model preference
    const savedModel = localStorage.getItem('appapp_model') || '';

    // Check if we have cached models (cache for 1 hour)
    const cachedModels = localStorage.getItem('appapp_models_cache');
    const cacheTime = localStorage.getItem('appapp_models_cache_time');
    const now = Date.now();
    const CACHE_DURATION = 60 * 60 * 1000; // 1 hour

    let models = null;
    let defaultModel = null;

    if (cachedModels && cacheTime && (now - parseInt(cacheTime)) < CACHE_DURATION) {
      // Use cached models
      try {
        const cached = JSON.parse(cachedModels);
        models = cached.models;
        defaultModel = cached.default;
      } catch (e) {
        // Cache corrupted, fetch fresh
        models = null;
      }
    }

    // Fetch models if not cached or cache expired
    if (!models) {
      try {
        const res = await fetch('/api/agent/models');
        if (res.ok) {
          const data = await res.json();
          models = data.models || [];
          defaultModel = data.default || null;
          
          // Cache the models
          localStorage.setItem('appapp_models_cache', JSON.stringify(data));
          localStorage.setItem('appapp_models_cache_time', now.toString());
        } else {
          // Fallback to empty list or default models
          models = [];
        }
      } catch (err) {
        console.error('Error fetching models:', err);
        models = [];
      }
    }

    // Clear existing options
    modelSelect.innerHTML = '';

    // Add "Auto" option first (uses the default/auto mode)
    const autoOption = document.createElement('option');
    autoOption.value = '';
    autoOption.textContent = 'Auto (Default)';
    modelSelect.appendChild(autoOption);

    // Add models to dropdown
    if (models && models.length > 0) {
      models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        // Show "(default)" label only if it's the default model
        option.textContent = model.name + (model.is_default ? ' (default)' : '');
        modelSelect.appendChild(option);
      });
    } else {
      // Fallback if no models loaded
      const fallbackOption = document.createElement('option');
      fallbackOption.value = '';
      fallbackOption.textContent = 'No models available';
      modelSelect.appendChild(fallbackOption);
    }

    // Set saved model if it exists, otherwise use Auto (empty value)
    if (savedModel) {
      // Verify saved model still exists in the list
      const modelExists = Array.from(modelSelect.options).some(opt => opt.value === savedModel);
      if (modelExists) {
        modelSelect.value = savedModel;
      } else {
        // Saved model no longer exists, use Auto mode
        modelSelect.value = '';
        localStorage.removeItem('appapp_model'); // Clear invalid saved model
      }
    } else {
      // No saved preference - use Auto mode (empty value = auto)
      modelSelect.value = '';
    }

    // Save model preference on change
    modelSelect.addEventListener('change', (e) => {
      const selectedModel = e.target.value;
      if (selectedModel && selectedModel !== '') {
        localStorage.setItem('appapp_model', selectedModel);
      } else {
        localStorage.removeItem('appapp_model');
      }
    });
  }

  getSelectedModel() {
    const modelSelect = document.getElementById(this.modelSelectId);
    if (modelSelect) {
      const value = modelSelect.value;
      // Return the selected model ID, or null if empty/invalid
      return (value && value !== '' && value !== 'auto') ? value : null;
    }
    return null;
  }

  setupImageHandling() {
    const promptEl = document.getElementById(this.promptInputId);
    if (!promptEl) return;

    // Handle paste events
    promptEl.addEventListener('paste', (e) => {
      this.handlePaste(e);
    });

    // Handle drag and drop
    promptEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      promptEl.style.borderColor = 'var(--accent)';
    });

    promptEl.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      promptEl.style.borderColor = '';
    });

    promptEl.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      promptEl.style.borderColor = '';
      this.handleDrop(e);
    });
  }

  handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image') !== -1) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          this.processImageFile(file);
        }
        break;
      }
    }
  }

  isMarkdownFile(file) {
    const markdownExtensions = ['.md', '.markdown', '.txt'];
    const fileName = file.name || '';
    const extension = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
    return markdownExtensions.includes(extension) || 
           file.type === 'text/markdown' || 
           file.type === 'text/plain' ||
           file.type === '';
  }

  processMarkdownFile(file) {
    // Check file size (max 5MB for text files)
    const MAX_SIZE = 5 * 1024 * 1024; // 5MB
    if (file.size > MAX_SIZE) {
      this.showToast(`File too large. Maximum size is 5MB.`, 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target.result;
      const fileId = `file_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      this.attachedFiles.push({
        id: fileId,
        name: file.name || 'untitled.md',
        content: content,
        size: file.size
      });

      this.updateImagePreview();
      this.showToast(`File attached: ${file.name || 'untitled.md'}`, 'info');
    };

    reader.onerror = () => {
      this.showToast('Failed to read file', 'error');
    };

    reader.readAsText(file);
  }

  removeFile(fileId) {
    this.attachedFiles = this.attachedFiles.filter(f => f.id !== fileId);
    this.updateImagePreview();
  }

  handleDrop(e) {
    const files = e.dataTransfer?.files;
    if (!files) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        this.processImageFile(file);
      } else if (this.isMarkdownFile(file)) {
        this.processMarkdownFile(file);
      }
    }
  }

  processImageFile(file) {
    // Check file size (max 10MB)
    const MAX_SIZE = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_SIZE) {
      this.showToast(`Image too large. Maximum size is 10MB.`, 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      this.attachedImages.push({
        id: imageId,
        data: dataUrl,
        name: file.name || 'pasted-image.png',
        size: file.size,
        type: file.type
      });

      this.updateImagePreview();
      this.showToast(`Image attached: ${file.name || 'pasted image'}`, 'info');
    };

    reader.onerror = () => {
      this.showToast('Failed to read image file', 'error');
    };

    reader.readAsDataURL(file);
  }

  removeImage(imageId) {
    this.attachedImages = this.attachedImages.filter(img => img.id !== imageId);
    this.updateImagePreview();
  }

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      this.showToast('Copied to clipboard', 'success');
      return true;
    } catch (err) {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        this.showToast('Copied to clipboard', 'success');
        return true;
      } catch (e) {
        this.showToast('Failed to copy to clipboard', 'error');
        return false;
      } finally {
        document.body.removeChild(textArea);
      }
    }
  }

  async copyRichText(html, plainText) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html':  new Blob([html],      { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        })
      ]);
      this.showToast('Copied to clipboard', 'success');
      return true;
    } catch (err) {
      // ClipboardItem not supported or permission denied — fall back to plain text
      return this.copyToClipboard(plainText);
    }
  }

  addCodeBlockCopyButtons(container) {
    container.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('.code-copy-btn')) return;
      const code = pre.querySelector('code');
      if (!code) return;
      pre.style.position = 'relative';
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = 'Copy';
      btn.onclick = async (e) => {
        e.stopPropagation();
        const text = code.textContent;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      };
      pre.appendChild(btn);
    });
  }

  addCopyButton(element, text, timestamp) {
    // Check if footer already exists
    if (element.querySelector('.msg-footer')) return;

    const footer = document.createElement('div');
    footer.className = 'msg-footer';

    // Timestamp
    const timeEl = document.createElement('span');
    timeEl.className = 'msg-timestamp';
    const ts = timestamp ? new Date(timestamp) : new Date();
    timeEl.textContent = ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    footer.appendChild(timeEl);

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-button';
    copyBtn.innerHTML = '📋 Copy';
    copyBtn.title = 'Copy to clipboard';
    copyBtn.onclick = async (e) => {
      e.stopPropagation();
      const html = this.formatMarkdown(text);
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;
      const plainText = tempDiv.textContent || tempDiv.innerText || text;
      await this.copyRichText(html, plainText);
    };
    footer.appendChild(copyBtn);

    element.appendChild(footer);
  }

  updateImagePreview() {
    const inputArea = document.querySelector(`#${this.promptInputId}`)?.closest('.chat-input-area');
    if (!inputArea) return;

    // Remove existing preview containers
    const existingImage = inputArea.querySelector('.image-preview-container');
    if (existingImage) {
      existingImage.remove();
    }
    const existingFile = inputArea.querySelector('.file-preview-container');
    if (existingFile) {
      existingFile.remove();
    }

    // Create image preview container if images exist
    if (this.attachedImages.length > 0) {
      const container = document.createElement('div');
      container.className = 'image-preview-container';
      
      this.attachedImages.forEach(img => {
        const preview = document.createElement('div');
        preview.className = 'image-preview-item';
        
        const imgEl = document.createElement('img');
        imgEl.src = img.data;
        imgEl.alt = img.name;
        
        const info = document.createElement('div');
        info.className = 'image-preview-info';
        info.textContent = `${img.name} (${this.formatFileSize(img.size)})`;
        
        const removeBtn = document.createElement('button');
        removeBtn.className = 'image-preview-remove';
        removeBtn.innerHTML = '×';
        removeBtn.title = 'Remove image';
        removeBtn.onclick = () => this.removeImage(img.id);
        
        preview.appendChild(imgEl);
        preview.appendChild(info);
        preview.appendChild(removeBtn);
        container.appendChild(preview);
      });

      // Insert before the textarea
      const textarea = inputArea.querySelector(`#${this.promptInputId}`);
      if (textarea) {
        inputArea.insertBefore(container, textarea);
      }
    }

    // Create file preview container if files exist
    if (this.attachedFiles.length > 0) {
      const container = document.createElement('div');
      container.className = 'file-preview-container';
      container.style.cssText = 'margin-bottom: 8px; padding: 8px; background: var(--panel-bg); border-radius: var(--radius-sm); border: 1px solid var(--border);';
      
      this.attachedFiles.forEach(file => {
        const preview = document.createElement('div');
        preview.className = 'file-preview-item';
        preview.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; margin-bottom: 4px; background: var(--bg); border-radius: var(--radius-sm);';
        
        const info = document.createElement('div');
        info.style.cssText = 'display: flex; align-items: center; gap: 8px; flex: 1;';
        info.innerHTML = `📄 <span style="font-size: 12px; color: var(--content-text);">${this.escapeHtml(file.name)}</span> <span style="font-size: 11px; color: var(--btn-ghost-text);">(${this.formatFileSize(file.size)})</span>`;
        
        const removeBtn = document.createElement('button');
        removeBtn.className = 'file-preview-remove';
        removeBtn.innerHTML = '×';
        removeBtn.title = 'Remove file';
        removeBtn.style.cssText = 'background: none; border: none; color: var(--btn-ghost-text); cursor: pointer; font-size: 18px; padding: 0 4px; line-height: 1;';
        removeBtn.onclick = () => this.removeFile(file.id);
        
        preview.appendChild(info);
        preview.appendChild(removeBtn);
        container.appendChild(preview);
      });

      // Insert before the textarea
      const textarea = inputArea.querySelector(`#${this.promptInputId}`);
      if (textarea) {
        inputArea.insertBefore(container, textarea);
      }
    }

    // Update send button badge
    const sendBtn = document.getElementById(this.sendButtonId);
    if (sendBtn) {
      const existingBadge = sendBtn.querySelector('.attachment-count-badge');
      if (existingBadge) {
        existingBadge.remove();
      }
      
      const totalAttachments = this.attachedImages.length + this.attachedFiles.length;
      if (totalAttachments > 0) {
        const badge = document.createElement('span');
        badge.className = 'attachment-count-badge';
        badge.textContent = totalAttachments;
        badge.style.cssText = 'position: absolute; top: -4px; right: -4px; background: var(--accent); color: white; border-radius: 10px; font-size: 10px; padding: 2px 6px; min-width: 16px; text-align: center;';
        sendBtn.style.position = 'relative';
        sendBtn.appendChild(badge);
      }
    }
  }

  formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async loadChatSession() {
    const savedChatId = localStorage.getItem('appapp_chat_id');
    if (savedChatId) {
      this.currentChatId = savedChatId;
      this.setChatId(savedChatId);
    }
  }

  // ─── Tab state management (for ChatTabManager) ─────────────────────────────

  saveTabState() {
    return {
      chatId: this.currentChatId,
      attachedImages: [...this.attachedImages],
      attachedFiles: [...this.attachedFiles],
      messageQueue: [...this.messageQueue],
      processingQueue: this.processingQueue,
    };
  }

  restoreTabState(state) {
    this.currentChatId = state.chatId;
    this.setChatId(state.chatId);
    this.onChatIdChange(state.chatId);
    this.attachedImages = state.attachedImages || [];
    this.attachedFiles = state.attachedFiles || [];
    this.messageQueue = state.messageQueue || [];
    this.processingQueue = state.processingQueue || false;
    this.updateImagePreview();
    this._updateQueueBadge();
    if (this.agentRunning) {
      const ri = document.getElementById(this.agentRunningId);
      if (ri) ri.style.display = 'flex';
      const sb = document.getElementById(this.sendButtonId);
      if (sb) {
        sb.classList.add('queue-mode');
        sb.innerHTML = '<span class="icon">📥</span> Queue';
      }
    } else {
      this._restoreIdleUI();
    }
  }

  async initializeChatSession() {
    const savedChatId = localStorage.getItem('appapp_chat_id');
    if (savedChatId) {
      this.currentChatId = savedChatId;
      this.setChatId(savedChatId);
      return;
    }

    try {
      const res = await fetch('/api/agent/create-chat', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        this.currentChatId = data.chat_id;
        localStorage.setItem('appapp_chat_id', this.currentChatId);
        this.setChatId(this.currentChatId);
        this.onChatIdChange(this.currentChatId);
      } else {
        console.error('Failed to create chat session');
      }
    } catch (err) {
      console.error('Error creating chat session:', err);
    }
  }

  async startNewChat() {
    const messagesContainer = document.getElementById(this.messagesContainerId);
    const systemMsg = messagesContainer.querySelector('.chat-msg.system');
    messagesContainer.innerHTML = '';
    if (systemMsg) {
      messagesContainer.appendChild(systemMsg);
    }

    this.currentChatId = null;
    localStorage.removeItem('appapp_chat_id');
    this.setChatId(null);
    this.attachedImages = [];
    this.attachedFiles = [];
    this.messageQueue = [];
    this.processingQueue = false;
    this._persistQueue();
    this.updateImagePreview();
    this._updateQueueBadge();
    await this.initializeChatSession();
    
    this.showToast('Started new chat', 'info');
  }

  async cancelRun() {
    if (!this.agentRunning || !this.currentChatId) return;
    try {
      const res = await fetch('/api/agent/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.currentChatId })
      });
      if (res.ok) {
        this.showToast('Cancelling…', 'info');
      }
    } catch (err) {
      console.error('Cancel failed:', err);
    }
  }

  addMessage(text, type, timestamp) {
    const container = document.getElementById(this.messagesContainerId);
    if (!container) return;
    
    const msg = document.createElement('div');
    msg.className = `chat-msg ${type}`;
    
    // Format markdown for assistant messages, plain text for user messages
    if (type === 'assistant' || type === 'system') {
      msg.innerHTML = this.formatMarkdown(text);
      // Highlight code blocks if hljs is available
      if (typeof hljs !== 'undefined') {
        msg.querySelectorAll('pre code').forEach(block => {
          hljs.highlightElement(block);
        });
      }
      this.addCodeBlockCopyButtons(msg);
    } else {
      msg.textContent = text;
    }

    // Add timestamp footer to user messages
    if (type === 'user') {
      const footer = document.createElement('div');
      footer.className = 'msg-footer';
      const timeEl = document.createElement('span');
      timeEl.className = 'msg-timestamp';
      const ts = timestamp ? new Date(timestamp) : new Date();
      timeEl.textContent = ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      footer.appendChild(timeEl);
      msg.appendChild(footer);
    }

    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;

    // Add footer with timestamp + copy button for assistant messages
    if (type === 'assistant') {
      this.addCopyButton(msg, text, timestamp);
    }
  }

  formatMarkdown(text) {
    if (!text || !text.trim()) return '<div class="spinner" style="margin:4px 0;"></div>';
    try {
      const html = marked.parse(text);
      // Open all links in a new tab, but convert chat:// links to clickable chat references
      return html.replace(/<a\s+href="chat:\/\/([^"]+)"[^>]*>(.*?)<\/a>/g,
        (match, chatId, label) => {
          return `<a href="#" class="chat-ref-link" data-chat-id="${chatId}" title="Open chat: ${chatId}">${label}</a>`;
        }
      ).replace(/<a\s(?!.*class="chat-ref-link")/g, '<a target="_blank" rel="noopener noreferrer" ');
    } catch (e) {
      return `<pre><code>${this.escapeHtml(text.trim())}</code></pre>`;
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async sendPrompt() {
    const promptEl = document.getElementById(this.promptInputId);
    let prompt = promptEl.value.trim();
    if (!prompt && this.attachedImages.length === 0 && this.attachedFiles.length === 0) return;

    this.userSentMessage = true;


    // Build the full prompt with file contents prepended
    let fullPrompt = prompt;
    if (this.attachedFiles.length > 0) {
      const fileContents = this.attachedFiles.map(file => {
        return `\n\n--- File: ${file.name} ---\n${file.content}\n--- End of ${file.name} ---`;
      }).join('\n\n');
      fullPrompt = fileContents + (prompt ? '\n\n' + prompt : '');
    }

    // Build display text with attachment indicators
    let messageText = promptEl.value.trim();
    const attachmentInfo = [];
    if (this.attachedImages.length > 0) {
      attachmentInfo.push(`${this.attachedImages.length} image${this.attachedImages.length > 1 ? 's' : ''}`);
    }
    if (this.attachedFiles.length > 0) {
      attachmentInfo.push(`${this.attachedFiles.length} file${this.attachedFiles.length > 1 ? 's' : ''}`);
    }
    if (attachmentInfo.length > 0) {
      messageText = (messageText || '') + (messageText ? ' ' : '') + `[${attachmentInfo.join(', ')} attached]`;
    }

    // Snapshot attachments and clear input immediately
    const imagesToSend = [...this.attachedImages];
    promptEl.value = '';
    sessionStorage.removeItem(this._sessionKey);
    this.attachedImages = [];
    this.attachedFiles = [];
    this.updateImagePreview();

    // Show the user message in the chat right away
    this.addMessage(messageText, 'user');
    this.saveMessage('user', messageText);

    // Package the message for execution
    const queuedMessage = {
      prompt: fullPrompt,
      images: imagesToSend,
      displayText: messageText
    };

    if (this.agentRunning) {
      // Agent is busy — queue this message and show a queued indicator
      this.messageQueue.push(queuedMessage);
      this._persistQueue();
      this._addQueuedIndicator(messageText);
      this._updateQueueBadge();
      return;
    }

    // Agent is free — execute immediately
    await this._executePrompt(queuedMessage);
  }

  _addQueuedIndicator(messageText) {
    const container = document.getElementById(this.messagesContainerId);
    if (!container) return;

    const indicator = document.createElement('div');
    indicator.className = 'chat-msg system queued-indicator';
    indicator.setAttribute('data-queue-index', this.messageQueue.length - 1);
    indicator.innerHTML = `<span style="font-size:12px; color:var(--text-dim);">⏳ Queued — will send when agent finishes</span>`;
    container.appendChild(indicator);
    container.scrollTop = container.scrollHeight;
  }

  _updateQueueBadge() {
    const runningIndicator = document.getElementById(this.agentRunningId);
    if (!runningIndicator) return;

    let badge = runningIndicator.querySelector('.queue-badge');
    if (this.messageQueue.length > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'queue-badge';
        badge.style.cssText = 'margin-left: 8px; background: var(--accent); color: white; border-radius: 10px; font-size: 11px; padding: 2px 8px; font-weight: 600;';
        runningIndicator.appendChild(badge);
      }
      badge.textContent = `${this.messageQueue.length} queued`;
    } else if (badge) {
      badge.remove();
    }
  }

  async _processQueue() {
    if (this.messageQueue.length === 0) {
      this.processingQueue = false;
      this._updateQueueBadge();
      this._restoreIdleUI();
      return;
    }

    this.processingQueue = true;
    const nextMessage = this.messageQueue.shift();
    this._persistQueue();
    this._updateQueueBadge();

    // Remove the queued indicator for this message
    const container = document.getElementById(this.messagesContainerId);
    if (container) {
      const indicators = container.querySelectorAll('.queued-indicator');
      if (indicators.length > 0) {
        indicators[0].remove();
      }
    }

    try {
      await this._executePrompt(nextMessage);
    } catch (err) {
      console.error('Error executing queued message:', err);
      this._setAgentRunning(false);
      this._drainQueueUI();
    }
  }

  async _executePrompt(messageData) {
    const { prompt, images: imagesToSend, displayText } = messageData;
    const myRunId = ++this._runId;

    this._setAgentRunning(true);
    const runningIndicator = document.getElementById(this.agentRunningId);
    if (runningIndicator) {
      runningIndicator.style.display = 'flex';
      const label = runningIndicator.querySelector('span:not(.queue-badge)');
      if (label) label.textContent = 'Agent is working...';
    }
    this._updateQueueBadge();

    // Switch send button to queue mode (stays enabled so users can queue more)
    const sendBtn = document.getElementById(this.sendButtonId);
    if (sendBtn) {
      sendBtn.classList.add('queue-mode');
      sendBtn.innerHTML = '<span class="icon">📥</span> Queue';
    }

    // Capture the messages container for this execution (stable across tab switches)
    const myContainer = document.getElementById(this.messagesContainerId);

    // Create container for this response
    const responseContainer = document.createElement('div');
    responseContainer.className = 'chat-msg system';
    myContainer.appendChild(responseContainer);

    // ── Content block tracking ─────────────────────────────────────
    // Each content_block_start creates an indexed block with its own
    // DOM element, enabling multiple thinking / text sections in order.
    let contentBlocks = new Map(); // blockIndex → {type, element, text}
    let assistantText = '';        // all text blocks concatenated (for result / copy)
    let resultEl = null;
    let updateTimeouts = new Map(); // blockIndex → timeout id
    const UPDATE_THROTTLE = 50;
    let streamedText = false;
    let streamedThinking = false;
    let streamedToolIds = new Set();

    // Remove init/status spinners once real content arrives
    const clearInitMessages = () => {
      responseContainer.querySelectorAll('.init-message, .status-message').forEach(el => el.remove());
    };

    // Collapse all open thinking blocks in the response container
    const collapseThinkingBlocks = () => {
      clearInitMessages();
      responseContainer.querySelectorAll('details.thinking-container[open]').forEach(el => {
        el.removeAttribute('open');
      });
    };

    // Create a collapsible thinking block
    const createThinkingBlock = (blockIndex) => {
      collapseThinkingBlocks();
      const el = document.createElement('details');
      el.className = 'thinking-container';
      el.open = true;
      el.innerHTML = `
        <summary style="cursor: pointer; color: var(--text-dim); font-size: 11px; padding: 4px 0;">
          <span class="thinking-toggle">💭 Thinking</span>
        </summary>
        <div class="thinking-content" style="color: var(--text-dim); font-size: 12px; padding: 8px 0; white-space: pre-wrap;"></div>
      `;
      responseContainer.appendChild(el);
      const block = { type: 'thinking', element: el, text: '' };
      contentBlocks.set(blockIndex, block);
      return block;
    };

    // Create a text content block
    const createTextBlock = (blockIndex) => {
      collapseThinkingBlocks();
      const el = document.createElement('div');
      el.className = 'assistant-content';
      responseContainer.appendChild(el);
      const block = { type: 'text', element: el, text: '' };
      contentBlocks.set(blockIndex, block);
      return block;
    };

    // Throttled DOM update for a specific block
    const scheduleBlockUpdate = (blockIndex) => {
      if (updateTimeouts.has(blockIndex)) clearTimeout(updateTimeouts.get(blockIndex));
      updateTimeouts.set(blockIndex, setTimeout(() => {
        const block = contentBlocks.get(blockIndex);
        if (!block) return;
        if (block.type === 'thinking') {
          const cel = block.element.querySelector('.thinking-content');
          if (cel) cel.textContent = block.text;
        } else if (block.type === 'text') {
          block.element.innerHTML = this.formatMarkdown(block.text);
          this.addCodeBlockCopyButtons(block.element);
        }
        if (myContainer) myContainer.scrollTop = myContainer.scrollHeight;
        updateTimeouts.delete(blockIndex);
      }, UPDATE_THROTTLE));
    };

    // Flush all pending block updates immediately
    const flushBlockUpdates = () => {
      for (const [idx, t] of updateTimeouts) {
        clearTimeout(t);
        const block = contentBlocks.get(idx);
        if (!block) continue;
        if (block.type === 'thinking') {
          const cel = block.element.querySelector('.thinking-content');
          if (cel) cel.textContent = block.text;
        } else if (block.type === 'text') {
          block.element.innerHTML = this.formatMarkdown(block.text);
          this.addCodeBlockCopyButtons(block.element);
        }
      }
      updateTimeouts.clear();
    };

    if (!this.currentChatId) {
      await this.initializeChatSession();
    }

    try {
      // Prepare images (extract base64 data from data URLs)
      const images = (imagesToSend || []).map(img => {
        // dataUrl format: "data:image/png;base64,iVBORw0KGgo..."
        const base64Data = img.data.split(',')[1]; // Remove data:image/...;base64, prefix
        return {
          data: base64Data,
          name: img.name,
          type: img.type || 'image/png'
        };
      });

      const selectedModel = this.getSelectedModel();

      const res = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          images: images.length > 0 ? images : undefined,
          context_path: this.getContextPath(),
          code_folder: this.getWorkingDirectory(),
          chat_id: this.currentChatId || '',
          model: selectedModel || undefined
        })
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done || streamDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          try {
            let data = JSON.parse(line.slice(6));
            // Unwrap stream_event envelope from Claude Code --output-format stream-json
            if (data.type === 'stream_event' && data.event) {
              data = data.event;
            }

            if (data.type === 'status') {
              if (!responseContainer.querySelector('.status-message')) {
                const statusEl = document.createElement('p');
                statusEl.className = 'status-message';
                statusEl.innerHTML = `⏳ ${this.escapeHtml(data.message)}`;
                responseContainer.insertBefore(statusEl, responseContainer.firstChild);
              }
            } else if (data.type === 'system' && data.subtype === 'init') {
              if (!responseContainer.querySelector('.init-message')) {
                const initEl = document.createElement('p');
                initEl.className = 'init-message';
                initEl.innerHTML = `⏳ Connected to <strong>${this.escapeHtml(data.model || 'Agent')}</strong>...`;
                responseContainer.insertBefore(initEl, responseContainer.firstChild);
              }
            } else if (data.type === 'content_block_delta') {
              // Incremental streaming — route delta to its indexed block
              const delta = data.delta || {};
              const blockIndex = data.index ?? -1;
              if (delta.type === 'text_delta' && delta.text) {
                streamedText = true;
                let block = contentBlocks.get(blockIndex);
                if (!block) block = createTextBlock(blockIndex);
                block.text += delta.text;
                assistantText += delta.text;
                scheduleBlockUpdate(blockIndex);
              } else if (delta.type === 'thinking_delta' && delta.thinking) {
                streamedThinking = true;
                let block = contentBlocks.get(blockIndex);
                if (!block) block = createThinkingBlock(blockIndex);
                block.text += delta.thinking;
                scheduleBlockUpdate(blockIndex);
              }
            } else if (data.type === 'content_block_start') {
              // Create DOM element for each new content block in order
              const block = data.content_block || {};
              const blockIndex = data.index ?? contentBlocks.size;
              if (block.type === 'thinking') {
                createThinkingBlock(blockIndex);
              } else if (block.type === 'text') {
                createTextBlock(blockIndex);
              } else if (block.type === 'tool_use' && block.name && block.name !== 'AskFollowupQuestion' && block.name !== 'AskUserQuestion' && block.id) {
                collapseThinkingBlocks();
                // Skip early card for TodoWrite — handled when input is complete
                if (this._isTodoWriteTool(block.name)) {
                  streamedToolIds.add(block.id);
                } else {
                  const alreadyExists = responseContainer.querySelector(`.tool-call-card[data-tool-use-id="${block.id}"]`);
                  if (!alreadyExists) {
                    const isCompact = this._isLowSignalTool(block.name);
                    const displayName = block.name.replace(/^mcp__[^_]+__/, '');
                    const toolCard = document.createElement('details');
                    toolCard.className = isCompact ? 'tool-call-card tool-compact' : 'tool-call-card';
                    toolCard.setAttribute('data-tool-use-id', block.id);
                    toolCard.setAttribute('data-tool-name', displayName);
                    toolCard.innerHTML = `
                      <summary style="cursor:pointer; list-style:none; display:flex; align-items:center; gap:6px; padding:${isCompact ? '1px 0' : '4px 0'};">
                        <span class="tool-call-spinner"></span>
                        <span style="font-size:${isCompact ? '11px' : '12px'}; font-weight:600; color:var(--accent);">${this.escapeHtml(displayName)}</span>
                        <span class="tool-input-summary" style="font-size:11px; color:var(--text-dim); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">…</span>
                      </summary>
                      <div class="tool-call-detail" style="margin:4px 0 4px 22px; font-size:11px; color:var(--text-dim); white-space:pre-wrap; max-height:200px; overflow-y:auto;"></div>
                    `;
                    responseContainer.appendChild(toolCard);
                    streamedToolIds.add(block.id);
                    myContainer.scrollTop = myContainer.scrollHeight;
                  }
                }
              }
            } else if (data.type === 'content_block_stop') {
              // Finalize a content block — flush its pending update
              const blockIndex = data.index ?? -1;
              if (updateTimeouts.has(blockIndex)) {
                clearTimeout(updateTimeouts.get(blockIndex));
                updateTimeouts.delete(blockIndex);
              }
              const block = contentBlocks.get(blockIndex);
              if (block) {
                if (block.type === 'thinking') {
                  const cel = block.element.querySelector('.thinking-content');
                  if (cel) cel.textContent = block.text;
                } else if (block.type === 'text') {
                  block.element.innerHTML = this.formatMarkdown(block.text);
                  this.addCodeBlockCopyButtons(block.element);
                }
              }
            } else if (data.type === 'assistant') {
              // Handle assistant messages — final content blocks for this turn.
              // When streamed, reconcile assistantText from canonical content.
              const content = data.message?.content || [];
              if (streamedText) {
                assistantText = content
                  .filter(p => p.type === 'text')
                  .map(p => p.text)
                  .join('\n\n');
              }
              let fallbackIdx = contentBlocks.size;
              for (const part of content) {
                if (part.type === 'text') {
                  if (!streamedText) {
                    const block = createTextBlock(fallbackIdx++);
                    block.text = part.text;
                    block.element.innerHTML = this.formatMarkdown(part.text);
                    assistantText += (assistantText ? '\n\n' : '') + part.text;
                  }
                } else if (part.type === 'thinking') {
                  if (!streamedThinking && part.thinking) {
                    const block = createThinkingBlock(fallbackIdx++);
                    block.text = part.thinking;
                    const cel = block.element.querySelector('.thinking-content');
                    if (cel) cel.textContent = part.thinking;
                  }
                } else if (part.type === 'tool_use') {
                  // Flush any pending block updates first
                  flushBlockUpdates();

                  if (part.name === 'AskFollowupQuestion') {
                    // ── Special case: render an interactive question card ──
                    const question = part.input?.question || 'Claude has a question';
                    const options  = Array.isArray(part.input?.options) ? part.input.options : [];

                    const qCard = document.createElement('div');
                    qCard.className = 'question-card';
                    qCard.setAttribute('data-tool-use-id', part.id);

                    const optionBtnsHtml = options.map(opt =>
                      `<button class="question-option" style="padding:5px 12px; background:var(--btn-ghost-bg,#334155); color:var(--sidebar-text,#cbd5e1); border:1px solid var(--border); border-radius:var(--radius-sm); cursor:pointer; font-size:12px;">${this.escapeHtml(opt)}</button>`
                    ).join('');

                    qCard.innerHTML = `
                      <div style="display:flex; align-items:flex-start; gap:10px;">
                        <span style="font-size:18px; flex-shrink:0;">❓</span>
                        <div style="flex:1; min-width:0;">
                          <strong style="font-size:13px;">Claude is asking:</strong>
                          <p style="margin:4px 0 8px; font-size:13px;">${this.escapeHtml(question)}</p>
                          ${optionBtnsHtml ? `<div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:8px;">${optionBtnsHtml}</div>` : ''}
                          <div style="display:flex; gap:6px;">
                            <input class="question-input" type="text" placeholder="Your answer…"
                              style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--input-bg,#fff); color:var(--content-text); font-size:13px;">
                            <button class="question-submit" style="padding:6px 14px; background:var(--accent); color:#fff; border:none; border-radius:var(--radius-sm); cursor:pointer; font-size:13px; font-weight:600;">Send</button>
                          </div>
                        </div>
                      </div>
                    `;

                    const inputEl = qCard.querySelector('.question-input');
                    const submitAnswer = async () => {
                      const answer = inputEl.value.trim();
                      if (!answer) return;
                      qCard.innerHTML = `<em style="font-size:12px; color:var(--text-dim);">❓ Answered: ${this.escapeHtml(answer)}</em>`;
                      try {
                        await fetch('/api/agent/tool-result', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            chat_id:     this.currentChatId,
                            tool_use_id: part.id,
                            content:     answer,
                          })
                        });
                      } catch (err) {
                        console.error('Failed to send tool result:', err);
                      }
                    };

                    qCard.querySelector('.question-submit').addEventListener('click', submitAnswer);
                    inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitAnswer(); } });
                    qCard.querySelectorAll('.question-option').forEach(btn => {
                      btn.addEventListener('click', () => { inputEl.value = btn.textContent; submitAnswer(); });
                    });

                    responseContainer.appendChild(qCard);
                    this.onNeedsAttention();

                  } else if (part.name === 'AskUserQuestion') {
                    // ── AskUserQuestion: multi-question card with options ──
                    const questions = Array.isArray(part.input?.questions) ? part.input.questions : [];

                    const qCard2 = document.createElement('div');
                    qCard2.className = 'question-card';
                    qCard2.setAttribute('data-tool-use-id', part.id);

                    let html2 = '<div style="display:flex; align-items:flex-start; gap:10px;">';
                    html2 += '<span style="font-size:18px; flex-shrink:0;">❓</span>';
                    html2 += '<div style="flex:1; min-width:0;">';
                    html2 += '<strong style="font-size:13px;">Claude is asking:</strong>';

                    questions.forEach((q, qIdx) => {
                      const qText = q.question || '';
                      const options = Array.isArray(q.options) ? q.options : [];
                      const header = q.header || '';

                      html2 += `<div class="ask-q-block" data-q-idx="${qIdx}" style="margin:8px 0;">`;
                      if (header) {
                        html2 += `<span style="display:inline-block; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--accent); margin-bottom:4px;">${this.escapeHtml(header)}</span><br>`;
                      }
                      html2 += `<p style="margin:2px 0 8px; font-size:13px;">${this.escapeHtml(qText)}</p>`;

                      // Option buttons
                      html2 += '<div style="display:flex; flex-direction:column; gap:4px; margin-bottom:8px;">';
                      options.forEach((opt, optIdx) => {
                        const label = typeof opt === 'string' ? opt : (opt.label || '');
                        const desc = typeof opt === 'string' ? '' : (opt.description || '');
                        html2 += `<button class="ask-q-option" data-q-idx="${qIdx}" data-opt-idx="${optIdx}" style="text-align:left; padding:8px 12px; background:var(--btn-ghost-bg,#334155); color:var(--sidebar-text,#cbd5e1); border:1px solid var(--border); border-radius:var(--radius-sm); cursor:pointer; font-size:12px; transition:border-color 0.15s, background 0.15s;">`;
                        html2 += `<strong>${this.escapeHtml(label)}</strong>`;
                        if (desc) html2 += `<br><span style="font-size:11px; opacity:0.7;">${this.escapeHtml(desc)}</span>`;
                        html2 += `</button>`;
                      });
                      html2 += '</div>';

                      // Free-text input
                      html2 += `<div style="display:flex; gap:6px;">`;
                      html2 += `<input class="ask-q-input" data-q-idx="${qIdx}" type="text" placeholder="Or type your own answer…" style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--input-bg,#fff); color:var(--content-text); font-size:12px;">`;
                      html2 += `</div>`;
                      html2 += `</div>`;
                    });

                    html2 += '<button class="ask-q-submit" style="padding:6px 14px; background:var(--accent); color:#fff; border:none; border-radius:var(--radius-sm); cursor:pointer; font-size:13px; font-weight:600; margin-top:4px;">Send</button>';
                    html2 += '</div></div>';

                    qCard2.innerHTML = html2;

                    // Track selected answer per question index
                    const selectedAnswers = {};

                    // Option click → select & highlight
                    qCard2.querySelectorAll('.ask-q-option').forEach(btn => {
                      btn.addEventListener('click', () => {
                        const qIdx = btn.getAttribute('data-q-idx');
                        const optIdx = parseInt(btn.getAttribute('data-opt-idx'));
                        const q = questions[parseInt(qIdx)];
                        const opt = q.options[optIdx];
                        const label = typeof opt === 'string' ? opt : (opt.label || '');

                        // Deselect siblings
                        qCard2.querySelectorAll(`.ask-q-option[data-q-idx="${qIdx}"]`).forEach(b => {
                          b.style.borderColor = 'var(--border)';
                          b.style.background = 'var(--btn-ghost-bg,#334155)';
                        });
                        btn.style.borderColor = 'var(--accent)';
                        btn.style.background = 'color-mix(in srgb, var(--accent) 15%, transparent)';

                        selectedAnswers[qIdx] = label;

                        // Clear text input
                        const inp = qCard2.querySelector(`.ask-q-input[data-q-idx="${qIdx}"]`);
                        if (inp) inp.value = '';
                      });
                    });

                    // Submit handler
                    const submitAskQ = async () => {
                      // Collect text inputs if option not clicked
                      questions.forEach((q, qIdx) => {
                        const inp = qCard2.querySelector(`.ask-q-input[data-q-idx="${qIdx}"]`);
                        if (inp && inp.value.trim()) {
                          selectedAnswers[String(qIdx)] = inp.value.trim();
                        }
                      });

                      // Build answers map keyed by question text
                      const answers = {};
                      questions.forEach((q, qIdx) => {
                        if (selectedAnswers[String(qIdx)]) {
                          answers[q.question] = selectedAnswers[String(qIdx)];
                        }
                      });

                      const summary = Object.values(answers).join(', ') || '(no answer)';
                      qCard2.innerHTML = `<em style="font-size:12px; color:var(--text-dim);">❓ Answered: ${this.escapeHtml(summary)}</em>`;

                      try {
                        await fetch('/api/agent/tool-result', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            chat_id:     this.currentChatId,
                            tool_use_id: part.id,
                            content:     JSON.stringify({ answers }),
                          })
                        });
                      } catch (err) {
                        console.error('Failed to send AskUserQuestion result:', err);
                      }
                    };

                    qCard2.querySelector('.ask-q-submit').addEventListener('click', submitAskQ);
                    qCard2.querySelectorAll('.ask-q-input').forEach(inp => {
                      inp.addEventListener('keydown', e => {
                        if (e.key === 'Enter') { e.preventDefault(); submitAskQ(); }
                      });
                    });

                    // Auto-submit on option click when there's only one question
                    if (questions.length === 1) {
                      qCard2.querySelectorAll('.ask-q-option').forEach(btn => {
                        btn.addEventListener('click', () => setTimeout(submitAskQ, 200));
                      });
                    }

                    responseContainer.appendChild(qCard2);
                    myContainer.scrollTop = myContainer.scrollHeight;
                    this.onNeedsAttention();

                  } else if (this._isTodoWriteTool(part.name)) {
                    // ── TodoWrite → render/update progress widget ─────────
                    const todos = part.input?.todos;
                    if (Array.isArray(todos) && todos.length > 0) {
                      this._renderTodoWidget(todos, responseContainer);
                    }
                    // Also group any preceding compact card run
                    this._groupCompactCards(responseContainer);

                  } else {
                    // ── Generic tool-call card ────────────────────────────
                    const isCompact = this._isLowSignalTool(part.name);
                    const displayName = part.name.replace(/^mcp__[^_]+__/, '');
                    const inputSummary = this._summariseToolInput(part.name, part.input || {});
                    const inputJson = JSON.stringify(part.input || {}, null, 2);

                    // Check if an early card was created via content_block_start
                    const earlyCard = responseContainer.querySelector(`.tool-call-card[data-tool-use-id="${part.id}"]`);
                    if (earlyCard) {
                      // Update the early card stub with the now-complete input
                      const summarySpan = earlyCard.querySelector('.tool-input-summary');
                      if (summarySpan) summarySpan.textContent = inputSummary;
                      earlyCard.setAttribute('data-tool-input', inputJson);
                    } else {
                      const toolCard = document.createElement('details');
                      toolCard.className = isCompact ? 'tool-call-card tool-compact' : 'tool-call-card';
                      toolCard.setAttribute('data-tool-use-id', part.id);
                      toolCard.setAttribute('data-tool-name', displayName);
                      toolCard.setAttribute('data-tool-input', inputJson);
                      toolCard.innerHTML = `
                        <summary style="cursor:pointer; list-style:none; display:flex; align-items:center; gap:6px; padding:${isCompact ? '1px 0' : '4px 0'};">
                          <span class="tool-call-spinner"></span>
                          <span style="font-size:${isCompact ? '11px' : '12px'}; font-weight:600; color:var(--accent);">${this.escapeHtml(displayName)}</span>
                          <span style="font-size:11px; color:var(--text-dim); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this.escapeHtml(inputSummary)}</span>
                        </summary>
                        <div class="tool-call-detail" style="margin:4px 0 4px 22px; font-size:11px; color:var(--text-dim); white-space:pre-wrap; max-height:200px; overflow-y:auto;"></div>
                      `;

                      // If this is a non-compact card, group preceding compact run first
                      if (!isCompact) {
                        this._groupCompactCards(responseContainer);
                      }
                      responseContainer.appendChild(toolCard);
                    }
                  }

                  myContainer.scrollTop = myContainer.scrollHeight;
                }
              }
              // (text blocks already created inline above)
            } else if (data.type === 'user') {
              // tool_result messages: fill in the matching tool-call card
              const content = data.message?.content || [];
              for (const part of content) {
                if (part.type === 'tool_result') {
                  const card = responseContainer.querySelector(
                    `.tool-call-card[data-tool-use-id="${part.tool_use_id}"]`
                  );
                  if (card) {
                    const spinner = card.querySelector('.tool-call-spinner');
                    if (spinner) {
                      const isError = part.is_error;
                      spinner.outerHTML = isError
                        ? '<span style="font-size:11px;">❌</span>'
                        : '<span style="font-size:11px;">✅</span>';
                    }
                    const detail = card.querySelector('.tool-call-detail');
                    if (detail) {
                      const resultText = typeof part.content === 'string'
                        ? part.content
                        : JSON.stringify(part.content, null, 2);
                      const savedInput = card.getAttribute('data-tool-input') || '';
                      detail.innerHTML = '';
                      // Output section
                      const outPre = document.createElement('pre');
                      outPre.style.cssText = 'margin:0; white-space:pre-wrap; font-size:11px; color:var(--text-dim);';
                      outPre.textContent = resultText;
                      detail.appendChild(outPre);
                      // Collapsible input section (hidden by default)
                      if (savedInput) {
                        const inputDetails = document.createElement('details');
                        inputDetails.style.cssText = 'margin-top:6px; opacity:0.6;';
                        inputDetails.innerHTML = `<summary style="cursor:pointer; font-size:10px; color:var(--text-dim); user-select:none;">Input</summary><pre style="margin:2px 0 0; white-space:pre-wrap; font-size:10px;"></pre>`;
                        inputDetails.querySelector('pre').textContent = savedInput;
                        detail.appendChild(inputDetails);
                      }
                    }
                  }
                }
              }
            } else if (data.type === 'result') {
              // When result arrives, remove text block elements and show result
              flushBlockUpdates();

              // Group any trailing compact tool cards before appending result
              this._groupCompactCards(responseContainer);

              // Remove text-block elements (keep thinking blocks and tool cards)
              for (const [idx, block] of contentBlocks) {
                if (block.type === 'text') block.element.remove();
              }

              // Create result element
              const resultText = data.result || assistantText;
              const dur = data.duration_ms ? ` <em style="font-size:11px;color:var(--btn-ghost-text);">(${(data.duration_ms / 1000).toFixed(1)}s)</em>` : '';

              resultEl = document.createElement('div');
              resultEl.className = 'result-content';
              resultEl.innerHTML = `<p>✅ <strong>Done</strong>${dur}</p>${this.formatMarkdown(resultText)}`;
              responseContainer.appendChild(resultEl);
              this.addCodeBlockCopyButtons(resultEl);

              // Add copy button
              this.addCopyButton(resultEl, resultText);

              // Save assistant response to chat history
              this.saveMessage('assistant', resultText);

              myContainer.scrollTop = myContainer.scrollHeight;

              // The result event is the agent's completion signal. Restore the
              // full idle UI immediately — don't wait for the SSE 'done' event
              // which only arrives after the CLI process fully exits (draining
              // verbose stderr, which can take several seconds).
              streamDone = true;
              this._setAgentRunning(false);
              this._restoreIdleUI();
              // Cancel the reader so the pending reader.read() resolves immediately,
              // letting the finally block run and trigger queue processing now
              // rather than waiting for Flask to close the SSE stream.
              reader.cancel().catch(() => {});
            } else if (data.type === 'permission_request') {
              // MCP approval-gate is waiting for the user to allow or deny a tool call.
              const card = document.createElement('div');
              card.className = 'permission-card';
              card.setAttribute('data-request-id', data.request_id);

              const tool = data.tool || 'unknown tool';
              // Strip the mcp__approval-gate__ prefix for display
              const toolDisplay = tool.replace(/^mcp__[^_]+__/, '');
              const pathHtml = data.path
                ? `<code style="font-size:11px; word-break:break-all;">${this.escapeHtml(data.path)}</code>`
                : '';
              const descHtml = data.description
                ? `<p style="margin:4px 0 0; font-size:12px; color:var(--text-dim); word-break:break-all;">${this.escapeHtml(data.description)}</p>`
                : '';

              const alwaysAllowPattern = data.always_allow_pattern || null;
              const alwaysAllowLabel = alwaysAllowPattern
                ? `🔒 Always allow '${alwaysAllowPattern}'`
                : null;

              const alwaysAllowBtnHtml = alwaysAllowLabel
                ? `<button class="btn-always-allow" style="flex:1; padding:6px 12px; background:#059669; color:#fff; border:none; border-radius:var(--radius-sm); cursor:pointer; font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${this.escapeHtml(alwaysAllowLabel)}">${this.escapeHtml(alwaysAllowLabel)}</button>`
                : '';

              card.innerHTML = `
                <div style="display:flex; align-items:flex-start; gap:10px;">
                  <span style="font-size:18px; flex-shrink:0;">🔐</span>
                  <div style="flex:1; min-width:0;">
                    <strong style="font-size:13px;">Approval Required</strong>
                    <p style="margin:2px 0; font-size:12px;">
                      Tool: <strong>${this.escapeHtml(toolDisplay)}</strong>${pathHtml ? ' → ' + pathHtml : ''}
                    </p>
                    ${descHtml}
                  </div>
                </div>
                <div class="permission-buttons" style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
                  <button class="btn-approve" style="flex:1; min-width:80px; padding:6px 12px; background:var(--accent); color:#fff; border:none; border-radius:var(--radius-sm); cursor:pointer; font-size:13px; font-weight:600;">✅ Allow Once</button>
                  ${alwaysAllowBtnHtml}
                  <button class="btn-deny" style="flex:1; min-width:60px; padding:6px 12px; background:var(--btn-ghost-bg,#444); color:var(--btn-ghost-text,#ccc); border:1px solid var(--border); border-radius:var(--radius-sm); cursor:pointer; font-size:13px;">❌ Deny</button>
                </div>
              `;

              const sendDecision = async (decision) => {
                card.querySelector('.permission-buttons').innerHTML =
                  `<em style="font-size:12px; color:var(--text-dim);">${decision === 'allow' ? '✅ Allowed' : '❌ Denied'}</em>`;
                try {
                  await fetch('/api/approval/decide', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ request_id: data.request_id, decision })
                  });
                } catch (err) {
                  console.error('Failed to send approval decision:', err);
                }
              };

              const sendAlwaysAllow = async () => {
                // 1. Create persistent allow rule
                const matchType = (data.tool === 'Bash') ? 'prefix' : 'glob';
                try {
                  await fetch('/api/permissions/rules', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      tool: data.tool,
                      match_type: matchType,
                      pattern: alwaysAllowPattern,
                      action: 'allow',
                    })
                  });
                  // Refresh rules panel if visible
                  if (typeof loadPermissionRules === 'function') loadPermissionRules();
                } catch (err) {
                  console.error('Failed to save always-allow rule:', err);
                }
                // 2. Approve this instance
                await sendDecision('allow');
              };

              card.querySelector('.btn-approve').addEventListener('click', () => sendDecision('allow'));
              card.querySelector('.btn-deny').addEventListener('click',    () => sendDecision('deny'));
              if (alwaysAllowPattern) {
                card.querySelector('.btn-always-allow').addEventListener('click', sendAlwaysAllow);
              }

              responseContainer.appendChild(card);
              myContainer.scrollTop = myContainer.scrollHeight;
              this.onNeedsAttention();

            } else if (data.type === 'permission_decision') {
              // The card already updated itself; nothing extra to render here.

            } else if (data.type === 'user_question') {
              // MCP AskUserQuestion — render an interactive question card
              const questions = Array.isArray(data.questions) ? data.questions : [];
              const reqId = data.request_id;

              const qCard = document.createElement('div');
              qCard.className = 'question-card';
              qCard.setAttribute('data-request-id', reqId);

              let qHtml = '<div style="display:flex; align-items:flex-start; gap:10px;">';
              qHtml += '<span style="font-size:18px; flex-shrink:0;">❓</span>';
              qHtml += '<div style="flex:1; min-width:0;">';
              qHtml += '<strong style="font-size:13px;">Claude is asking:</strong>';

              questions.forEach((q, qIdx) => {
                const qText = q.question || '';
                const options = Array.isArray(q.options) ? q.options : [];
                const header = q.header || '';

                qHtml += `<div class="ask-q-block" data-q-idx="${qIdx}" style="margin:8px 0;">`;
                if (header) {
                  qHtml += `<span style="display:inline-block; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--accent); margin-bottom:4px;">${this.escapeHtml(header)}</span><br>`;
                }
                qHtml += `<p style="margin:2px 0 8px; font-size:13px;">${this.escapeHtml(qText)}</p>`;

                qHtml += '<div style="display:flex; flex-direction:column; gap:4px; margin-bottom:8px;">';
                options.forEach((opt, optIdx) => {
                  const label = typeof opt === 'string' ? opt : (opt.label || '');
                  const desc = typeof opt === 'string' ? '' : (opt.description || '');
                  qHtml += `<button class="ask-q-option" data-q-idx="${qIdx}" data-opt-idx="${optIdx}" style="text-align:left; padding:8px 12px; background:var(--btn-ghost-bg,#334155); color:var(--sidebar-text,#cbd5e1); border:1px solid var(--border); border-radius:var(--radius-sm); cursor:pointer; font-size:12px; transition:border-color 0.15s, background 0.15s;">`;
                  qHtml += `<strong>${this.escapeHtml(label)}</strong>`;
                  if (desc) qHtml += `<br><span style="font-size:11px; opacity:0.7;">${this.escapeHtml(desc)}</span>`;
                  qHtml += `</button>`;
                });
                qHtml += '</div>';

                qHtml += `<div style="display:flex; gap:6px;">`;
                qHtml += `<input class="ask-q-input" data-q-idx="${qIdx}" type="text" placeholder="Or type your own answer…" style="flex:1; padding:6px 10px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--input-bg,#fff); color:var(--content-text); font-size:12px;">`;
                qHtml += `</div>`;
                qHtml += `</div>`;
              });

              qHtml += '<button class="ask-q-submit" style="padding:6px 14px; background:var(--accent); color:#fff; border:none; border-radius:var(--radius-sm); cursor:pointer; font-size:13px; font-weight:600; margin-top:4px;">Send</button>';
              qHtml += '</div></div>';

              qCard.innerHTML = qHtml;

              const selectedAnswers = {};

              qCard.querySelectorAll('.ask-q-option').forEach(btn => {
                btn.addEventListener('click', () => {
                  const qIdx = btn.getAttribute('data-q-idx');
                  const optIdx = parseInt(btn.getAttribute('data-opt-idx'));
                  const q = questions[parseInt(qIdx)];
                  const opt = q.options[optIdx];
                  const label = typeof opt === 'string' ? opt : (opt.label || '');

                  qCard.querySelectorAll(`.ask-q-option[data-q-idx="${qIdx}"]`).forEach(b => {
                    b.style.borderColor = 'var(--border)';
                    b.style.background = 'var(--btn-ghost-bg,#334155)';
                  });
                  btn.style.borderColor = 'var(--accent)';
                  btn.style.background = 'color-mix(in srgb, var(--accent) 15%, transparent)';
                  selectedAnswers[qIdx] = label;

                  const inp = qCard.querySelector(`.ask-q-input[data-q-idx="${qIdx}"]`);
                  if (inp) inp.value = '';
                });
              });

              const submitQAnswer = async () => {
                questions.forEach((q, qIdx) => {
                  const inp = qCard.querySelector(`.ask-q-input[data-q-idx="${qIdx}"]`);
                  if (inp && inp.value.trim()) {
                    selectedAnswers[String(qIdx)] = inp.value.trim();
                  }
                });

                const answers = {};
                questions.forEach((q, qIdx) => {
                  if (selectedAnswers[String(qIdx)]) {
                    answers[q.question] = selectedAnswers[String(qIdx)];
                  }
                });

                const summary = Object.values(answers).join(', ') || '(no answer)';
                qCard.innerHTML = `<em style="font-size:12px; color:var(--text-dim);">❓ Answered: ${this.escapeHtml(summary)}</em>`;

                try {
                  await fetch('/api/approval/answer', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      request_id: reqId,
                      answer: JSON.stringify({ answers }),
                    })
                  });
                } catch (err) {
                  console.error('Failed to send question answer:', err);
                }
              };

              qCard.querySelector('.ask-q-submit').addEventListener('click', submitQAnswer);
              qCard.querySelectorAll('.ask-q-input').forEach(inp => {
                inp.addEventListener('keydown', e => {
                  if (e.key === 'Enter') { e.preventDefault(); submitQAnswer(); }
                });
              });

              // Auto-submit on option click when there's only one question
              if (questions.length === 1) {
                qCard.querySelectorAll('.ask-q-option').forEach(btn => {
                  btn.addEventListener('click', () => setTimeout(submitQAnswer, 200));
                });
              }

              responseContainer.appendChild(qCard);
              myContainer.scrollTop = myContainer.scrollHeight;
              this.onNeedsAttention();

            } else if (data.type === 'cancelled') {
              flushBlockUpdates();
              const cancelEl = document.createElement('p');
              cancelEl.className = 'status-message';
              cancelEl.innerHTML = `⏹️ ${this.escapeHtml(data.message || 'Cancelled')}`;
              responseContainer.appendChild(cancelEl);
              this.saveMessage('assistant', assistantText || '(cancelled)');
              streamDone = true;
              this._setAgentRunning(false);
              this._restoreIdleUI();
              reader.cancel().catch(() => {});
            } else if (data.type === 'session_compacting') {
              // Session too large — compacting in progress
              flushBlockUpdates();
              responseContainer.querySelectorAll('.error-message').forEach(el => el.remove());
              const compactEl = document.createElement('div');
              compactEl.className = 'status-message session-compact-status';
              compactEl.innerHTML = `<span class="tool-call-spinner"></span> ${this.escapeHtml(data.message || 'Compacting session…')}`;
              responseContainer.appendChild(compactEl);
              this.showToast('Compacting conversation — please wait', 'info');
            } else if (data.type === 'session_compacted') {
              // Compact succeeded — retrying with the smaller session
              const compactStatus = responseContainer.querySelector('.session-compact-status');
              if (compactStatus) compactStatus.innerHTML = `✅ ${this.escapeHtml(data.message || 'Session compacted')}`;
            } else if (data.type === 'session_reset') {
              // Compact failed or session dropped — starting fresh
              flushBlockUpdates();
              responseContainer.querySelectorAll('.error-message').forEach(el => el.remove());
              const compactStatus = responseContainer.querySelector('.session-compact-status');
              if (compactStatus) compactStatus.innerHTML = `⚠️ Compact failed`;
              const resetEl = document.createElement('p');
              resetEl.className = 'status-message';
              resetEl.innerHTML = `🔄 ${this.escapeHtml(data.message || 'Session reset — retrying…')}`;
              responseContainer.appendChild(resetEl);
              this.showToast('Session was too large — starting fresh', 'info');
            } else if (data.type === 'error') {
              flushBlockUpdates();
              const errorEl = document.createElement('p');
              errorEl.className = 'error-message';
              errorEl.innerHTML = `❌ ${this.escapeHtml(data.message || 'Agent error')}`;
              responseContainer.appendChild(errorEl);
            } else if (data.type === 'done') {
              flushBlockUpdates();
              
              // If we have a result, it's already displayed. Otherwise show final state.
              if (!resultEl) {
                if (data.exit_code === 0 && !assistantText) {
                  const doneEl = document.createElement('p');
                  doneEl.innerHTML = '✅ Agent completed.';
                  responseContainer.appendChild(doneEl);
                } else if (data.exit_code !== 0 && !assistantText) {
                  const doneEl = document.createElement('p');
                  doneEl.innerHTML = `⚠️ Agent exited with code ${data.exit_code}`;
                  responseContainer.appendChild(doneEl);
                } else if (assistantText && !resultEl) {
                  // No result message received, but text blocks are already visible.
                  // Add copy button to the last text block.
                  const lastTextBlock = [...contentBlocks.values()].reverse().find(b => b.type === 'text');
                  if (lastTextBlock) {
                    this.addCopyButton(lastTextBlock.element, assistantText);
                  }
                  this.saveMessage('assistant', assistantText);
                }
              }
              
              myContainer.scrollTop = myContainer.scrollHeight;
              streamDone = true;
              break; // exit inner for-loop; outer while checks streamDone flag
            } else if (data.type === 'text') {
              // Fallback for plain text messages
              const fallbackText = data.content || '';
              assistantText += fallbackText;
              // Append to last text block, or create one
              let lastText = [...contentBlocks.values()].reverse().find(b => b.type === 'text');
              if (!lastText) lastText = createTextBlock(contentBlocks.size);
              lastText.text += fallbackText;
              scheduleBlockUpdate([...contentBlocks.entries()].find(([, b]) => b === lastText)[0]);
            }
          } catch (e) {
            // Try to parse as plain text
            const text = line.slice(6);
            if (text && text.trim()) {
              assistantText += text;
              let lastText = [...contentBlocks.values()].reverse().find(b => b.type === 'text');
              if (!lastText) lastText = createTextBlock(contentBlocks.size);
              lastText.text += text;
              scheduleBlockUpdate([...contentBlocks.entries()].find(([, b]) => b === lastText)[0]);
            }
          }
        }
      }
    } catch (err) {
      const errorEl = document.createElement('p');
      errorEl.className = 'error-message';
      errorEl.innerHTML = `❌ Failed to communicate with agent: ${this.escapeHtml(err.message)}`;
      responseContainer.appendChild(errorEl);
    } finally {
      // Only run cleanup if no newer _executePrompt call has started.
      // If myRunId < _runId, a new call already owns agentRunning and the UI.
      if (this._runId === myRunId) {
        this._setAgentRunning(false);

        // Call completion callback
        this.onComplete();

        // Process next queued message after a 5s grace period (allows page refresh)
        if (this.messageQueue.length > 0) {
          setTimeout(() => {
            this._processQueue().catch(err => {
              console.error('Error processing queued message:', err);
              this._setAgentRunning(false);
              this._drainQueueUI();
            });
          }, 5000);
        } else {
          this._restoreIdleUI();
        }

        // Check for server restart in the background (up to 10s).
        // Runs after UI is restored so it doesn't block the user.
        // Reloads the page if a new start_time is detected.
        this._checkForServerRestart();
      }
    }
  }

  _restoreIdleUI() {
    const runningIndicator = document.getElementById(this.agentRunningId);
    if (runningIndicator) runningIndicator.style.display = 'none';
    this._updateQueueBadge();

    const sendBtn = document.getElementById(this.sendButtonId);
    if (sendBtn) {
      sendBtn.classList.remove('queue-mode');
      sendBtn.innerHTML = '<span class="icon">🚀</span> Run Agent';
    }
  }

  _drainQueueUI() {
    // Emergency cleanup: remove all queued indicators and restore UI
    this.messageQueue = [];
    this.processingQueue = false;
    this._persistQueue();
    const container = document.getElementById(this.messagesContainerId);
    if (container) {
      container.querySelectorAll('.queued-indicator').forEach(el => el.remove());
    }
    this._restoreIdleUI();
    this.showToast('Queued messages failed to send', 'error');
  }

  _summariseToolInput(toolName, input) {
    // Return a short one-line description of the tool invocation for the summary row.
    if (!input || typeof input !== 'object') return '';
    switch (toolName) {
      case 'Bash':
      case 'bash':
        return input.command || '';
      case 'Read':
      case 'read':
        return input.file_path || input.path || '';
      case 'Write':
      case 'write':
        return input.file_path || input.path || '';
      case 'Edit':
      case 'edit':
        return input.file_path || input.path || '';
      case 'Glob':
      case 'glob':
        return input.pattern || '';
      case 'Grep':
      case 'grep':
        return `${input.pattern || ''} ${input.path ? 'in ' + input.path : ''}`.trim();
      case 'WebFetch':
        return input.url || '';
      case 'WebSearch':
        return input.query || '';
      default: {
        // First string value found, or first key=value pair
        const firstStr = Object.values(input).find(v => typeof v === 'string');
        if (firstStr) return firstStr.slice(0, 80);
        return Object.entries(input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).slice(0, 2).join(' ');
      }
    }
  }

  // ── Tool card tiering ─────────────────────────────────────────

  static LOW_SIGNAL_TOOLS = new Set([
    'Glob', 'glob', 'Read', 'read', 'Grep', 'grep',
    'mcp__approval-gate__Read', 'mcp__approval-gate__Glob', 'mcp__approval-gate__Grep',
    'ListMcpResourcesTool', 'ReadMcpResourceTool',
    'WebSearch', 'WebFetch',
  ]);

  static TODO_TOOL_NAMES = new Set([
    'TodoWrite', 'mcp__approval-gate__TodoWrite',
  ]);

  _isLowSignalTool(name) {
    return ChatEngine.LOW_SIGNAL_TOOLS.has(name);
  }

  _isTodoWriteTool(name) {
    return ChatEngine.TODO_TOOL_NAMES.has(name) || (name && name.toLowerCase() === 'todowrite');
  }

  /**
   * Render or update the TodoWrite progress widget in a response container.
   * If a widget already exists, it is updated in place; otherwise a new one is created.
   */
  _renderTodoWidget(todos, responseContainer) {
    if (!Array.isArray(todos) || todos.length === 0) return null;

    let widget = responseContainer.querySelector('.todo-progress-widget');
    const isNew = !widget;
    if (isNew) {
      widget = document.createElement('div');
      widget.className = 'todo-progress-widget';
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    let listHtml = '';
    for (const todo of todos) {
      let icon, cls;
      if (todo.status === 'completed') {
        icon = '✅'; cls = 'todo-completed';
      } else if (todo.status === 'in_progress') {
        icon = '⏳'; cls = 'todo-in-progress';
      } else {
        icon = '○'; cls = 'todo-pending';
      }
      const text = (todo.status === 'in_progress' && todo.activeForm)
        ? todo.activeForm
        : todo.content;
      listHtml += `<li class="todo-item ${cls}"><span class="todo-icon">${icon}</span><span>${this.escapeHtml(text)}</span></li>`;
    }

    widget.innerHTML = `
      <div class="todo-header">
        <span class="todo-header-label">Progress</span>
        <div class="todo-progress-bar"><div class="todo-progress-fill" style="width:${pct}%"></div></div>
        <span class="todo-progress-count">${completed}/${total}</span>
      </div>
      <ul class="todo-list">${listHtml}</ul>
    `;

    if (isNew) {
      // Insert at the top of the response, after any thinking blocks
      const firstNonThinking = Array.from(responseContainer.children).find(
        el => !el.classList.contains('thinking-container') && !el.classList.contains('init-message') && !el.classList.contains('status-message')
      );
      if (firstNonThinking) {
        responseContainer.insertBefore(widget, firstNonThinking);
      } else {
        responseContainer.appendChild(widget);
      }
    }

    return widget;
  }

  /**
   * Group consecutive compact tool cards into a collapsible group.
   * Finds the trailing run of compact cards at the end of the container
   * and wraps them in a <details> group if there are 3+.
   */
  _groupCompactCards(responseContainer) {
    const children = Array.from(responseContainer.children);
    if (children.length === 0) return;

    // Walk backwards from the end to find the trailing run of compact cards
    let runEnd = children.length - 1;
    while (runEnd >= 0 && children[runEnd].classList?.contains('tool-compact')) {
      runEnd--;
    }
    // runEnd now points to the last non-compact child (or -1)
    const runStart = runEnd + 1;
    runEnd = children.length - 1;

    const runLength = runEnd - runStart + 1;
    if (runLength < 3) return; // only group runs of 3+

    const compactCards = children.slice(runStart, runEnd + 1);

    // Build group summary text
    const toolCounts = {};
    for (const card of compactCards) {
      const name = card.getAttribute('data-tool-name') || 'Tool';
      toolCounts[name] = (toolCounts[name] || 0) + 1;
    }
    const summaryParts = Object.entries(toolCounts).map(([name, count]) => `${name} ×${count}`);
    const summaryText = summaryParts.join(', ');

    // Create the group wrapper
    const group = document.createElement('details');
    group.className = 'tool-group-compact';
    group.innerHTML = `
      <summary>🔧 ${this.escapeHtml(summaryText)}</summary>
      <div class="tool-group-inner"></div>
    `;
    const inner = group.querySelector('.tool-group-inner');

    // Move compact cards into the group
    const refNode = compactCards[0];
    responseContainer.insertBefore(group, refNode);
    for (const card of compactCards) {
      inner.appendChild(card);
    }
  }

  updateContextPath(path) {
    // This can be called externally to update context
    // The getContextPath function will return the updated value
  }

  async saveMessage(role, content) {
    // Save message to chat history
    if (!this.currentChatId || !content || !content.trim()) return;
    
    try {
      const response = await fetch('/api/chats/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.currentChatId,
          role: role,
          content: content.trim(),
          timestamp: new Date().toISOString()
        })
      });
      
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Failed to save message' }));
        console.error('Error saving message:', error);
      }
    } catch (err) {
      console.error('Error saving message:', err);
    }
  }

  async loadChatHistory(chatId) {
    // Load and display chat history
    try {
      const res = await fetch(`/api/chats/${chatId}`);
      if (!res.ok) {
        if (res.status === 404) {
          // Chat doesn't exist (or is empty) — treat as a fresh chat, not an error
          return null;
        }
        throw new Error('Failed to load chat');
      }
      
      const chatData = await res.json();
      const messagesContainer = document.getElementById(this.messagesContainerId);
      if (!messagesContainer) {
        console.error('Messages container not found');
        return null;
      }
      
      // Preserve the system message if it exists
      const systemMsg = messagesContainer.querySelector('.chat-msg.system');
      
      // Clear existing messages
      messagesContainer.innerHTML = '';
      
      // Restore system message if it existed
      if (systemMsg) {
        messagesContainer.appendChild(systemMsg);
      }
      
      // Display all messages from history
      for (const msg of chatData.messages || []) {
        // Map 'user' role to 'user' type, 'assistant' role to 'assistant' type
        const messageType = msg.role === 'user' ? 'user' : 'assistant';
        this.addMessage(msg.content, messageType, msg.timestamp);
      }
      
      // Update current chat ID
      this.currentChatId = chatId;
      this.setChatId(chatId);
      this.onChatIdChange(chatId);

      
      // Scroll to bottom
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      
      return chatData;
    } catch (err) {
      console.error('Error loading chat history:', err);
      this.showToast('Failed to load chat history', 'error');
      return null;
    }
  }
}
