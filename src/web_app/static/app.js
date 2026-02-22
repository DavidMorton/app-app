// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════
let currentChatId = null;
let chatEngine = null;
let chatTabManager = null;


// ═══════════════════════════════════════════════════════════════
// Initialize
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  loadTheme();
  setupKeyboardShortcuts();
  setupPanelResizer();
  await initializeChatPanel();

  // Load saved chat session
  if (chatTabManager) {
    const activeTab = chatTabManager.getActiveTab();
    const inst = chatTabManager.activeInstance;
    if (activeTab && activeTab.chatId && inst) {
      currentChatId = activeTab.chatId;
      await inst.loadChatHistory(activeTab.chatId);
    }
  } else {
    const savedChatId = localStorage.getItem('appapp_chat_id');
    if (savedChatId && chatEngine) {
      currentChatId = savedChatId;
      chatEngine.currentChatId = savedChatId;
      await chatEngine.loadChatHistory(savedChatId);
    }
  }

  marked.setOptions({
    gfm: true,
    breaks: true,
    highlight: function(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch (e) {}
      }
      return hljs.highlightAuto(code).value;
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Panel Resizer
// ═══════════════════════════════════════════════════════════════
function setupPanelResizer() {
  const resizer = document.getElementById('panel-resizer');
  const chatPanel = document.getElementById('chat-panel');
  if (!resizer || !chatPanel) return;

  const STORAGE_KEY = 'appapp_chat_width';
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const w = parseInt(saved, 10);
    if (w >= 360 && w <= 800) {
      chatPanel.style.width = w + 'px';
    }
  }

  let isResizing = false;

  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isResizing = true;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const containerRight = document.getElementById('body-row').getBoundingClientRect().right;
    let newWidth = containerRight - e.clientX;
    newWidth = Math.max(360, Math.min(800, newWidth));
    chatPanel.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    resizer.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(STORAGE_KEY, parseInt(chatPanel.style.width, 10) || 480);
  });
}

// ═══════════════════════════════════════════════════════════════
// Theme Management
// ═══════════════════════════════════════════════════════════════
const THEME_KEY = 'dr-theme';
const THEMES = ['light', 'dark', 'system'];
const THEME_ICONS = { light: '☀️', dark: '🌙', system: '💻' };
const THEME_LABELS = { light: 'Light', dark: 'Dark', system: 'System' };

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'light';
  applyTheme(saved);
}

function cycleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const idx = THEMES.indexOf(current);
  const next = THEMES[(idx + 1) % THEMES.length];
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
  showToast(`Theme: ${THEME_LABELS[next]}`, 'info');
}

async function restartBackend() {
  const btn = document.getElementById('btn-restart');
  if (!confirm('Restart the backend server?')) return;
  btn.style.color = 'var(--warning)';
  btn.style.animation = 'spin 1s linear infinite';
  showToast('Restarting backend…', 'info');
  try { await fetch('/api/restart', { method: 'POST' }); } catch {}
  const poll = setInterval(async () => {
    try {
      const r = await fetch('/api/health');
      if (r.ok) { clearInterval(poll); location.reload(); }
    } catch {}
  }, 500);
  setTimeout(() => { clearInterval(poll); location.reload(); }, 10000);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').textContent = THEME_ICONS[theme];
  document.getElementById('theme-toggle').title = `Theme: ${THEME_LABELS[theme]} (click to change)`;

  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.getElementById('hljs-theme-light').disabled = isDark;
  document.getElementById('hljs-theme-dark').disabled = !isDark;
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'system') applyTheme('system');
});

function isDarkMode() {
  const theme = document.documentElement.getAttribute('data-theme');
  return theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}


// ═══════════════════════════════════════════════════════════════
// Chat Tab Manager
// ═══════════════════════════════════════════════════════════════
class ChatTabManager {
  constructor(sharedConfig) {
    this.sharedConfig = sharedConfig;
    this.tabs = [];
    this.instances = {};
    this.activeTabId = null;
    this.draftPrompts = {};
    this._draftSaveInterval = null;
    this.tabBarEl = document.getElementById('chat-tab-bar');
    this.wrapperEl = document.getElementById('chat-messages-wrapper');
    this.systemMessageHtml = `
      <div class="chat-msg system">
        Welcome to <strong>AppApp</strong>. Start chatting to build whatever you want.
        <br><br>
        <em style="color:var(--text-dim)">⌘↵ to send · conversations persist · use + for a new chat</em>
      </div>`;
  }

  get activeInstance() {
    return this.activeTabId ? this.instances[this.activeTabId] : null;
  }

  async init() {
    const saved = localStorage.getItem('appapp_chat_tabs');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        if (data.tabs && data.tabs.length > 0) {
          const firstTabId = data.tabs[0].id;
          const existingPane = document.getElementById('chat-messages');
          if (existingPane) {
            existingPane.id = `chat-messages-${firstTabId}`;
            existingPane.className = 'chat-messages-pane';
            this._addChatRefClickHandler(existingPane);
          }

          this.tabs = data.tabs.map(t => ({
            id: t.id,
            chatId: t.chatId,
            title: t.title || 'Chat',
            isRunning: false,
          }));

          for (let i = 1; i < this.tabs.length; i++) {
            this._createPane(this.tabs[i].id);
          }

          const activeId = data.activeTabId && this.tabs.find(t => t.id === data.activeTabId)
            ? data.activeTabId
            : this.tabs[0].id;
          this._activatePane(activeId);
          this.activeTabId = activeId;

          for (const tab of this.tabs) {
            this._createInstance(tab.id, tab.chatId);
          }

          this.renderTabs();
          this._setupSharedListeners();
          this._wireAddButton();
          return;
        }
      } catch (e) {
        console.warn('Failed to restore chat tabs:', e);
      }
    }

    this._createInitialTab();
    this._setupSharedListeners();
    this._wireAddButton();
    this.renderTabs();
  }

  _createInstance(tabId, chatId) {
    const instance = new ChatEngine({
      ...this.sharedConfig,
      messagesContainerId: `chat-messages-${tabId}`,
      sendButtonId: `_no-send-${tabId}`,
      agentRunningId: `_no-running-${tabId}`,
      newChatButtonId: `_no-new-${tabId}`,
      promptInputId: 'chat-prompt',
      modelSelectId: 'chat-model-select',
      skipSharedUISetup: true,
      tabId: tabId,
      getWorkingDirectory: () => '',
      onRunningChange: (isRunning) => {
        this.updateTabRunning(tabId, isRunning);
        if (!isRunning && tabId !== this.activeTabId) {
          const tab = this.tabs.find(t => t.id === tabId);
          if (tab) { tab.unread = true; this.renderTabs(); }
        }
        if (tabId === this.activeTabId) {
          this._syncSharedUI();
        }
      },
      onNeedsAttention: () => {
        if (tabId !== this.activeTabId) {
          this.setTabNeedsAttention(tabId);
        }
      },
    });
    if (chatId) {
      instance.currentChatId = chatId;
      instance.setChatId(chatId);
    }
    this.instances[tabId] = instance;
    return instance;
  }

  _setupSharedListeners() {
    const promptEl = document.getElementById('chat-prompt');
    const sendBtn = document.getElementById('btn-send-agent');
    const cancelBtn = document.getElementById('btn-cancel-agent');

    if (promptEl) {
      promptEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          this._sendToActive();
        }
      });
      promptEl.addEventListener('focus', () => this._startDraftSave());
      promptEl.addEventListener('blur', () => this._stopDraftSave());
      promptEl.addEventListener('paste', (e) => {
        const inst = this.activeInstance;
        if (inst) inst.handlePaste(e);
      });
      promptEl.addEventListener('dragover', (e) => {
        e.preventDefault(); e.stopPropagation();
        promptEl.style.borderColor = 'var(--accent)';
      });
      promptEl.addEventListener('dragleave', (e) => {
        e.preventDefault(); e.stopPropagation();
        promptEl.style.borderColor = '';
      });
      promptEl.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation();
        promptEl.style.borderColor = '';
        const inst = this.activeInstance;
        if (inst) inst.handleDrop(e);
      });
    }
    if (sendBtn) sendBtn.addEventListener('click', () => this._sendToActive());
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        const inst = this.activeInstance;
        if (inst) inst.cancelRun();
      });
    }
  }

  _sendToActive() {
    const inst = this.activeInstance;
    if (!inst) return;
    const tab = this.getActiveTab();
    if (tab && (tab.title === 'New Chat' || tab.title === 'Chat')) {
      const prompt = document.getElementById('chat-prompt')?.value?.trim();
      if (prompt) {
        tab.title = prompt.slice(0, 30) + (prompt.length > 30 ? '…' : '');
        this.renderTabs();
        this.persist();
      }
    }
    inst.sendPrompt();
  }

  _syncSharedUI() {
    const inst = this.activeInstance;
    const runningIndicator = document.getElementById('agent-running');
    const sendBtn = document.getElementById('btn-send-agent');

    if (inst && inst.agentRunning) {
      if (runningIndicator) {
        runningIndicator.style.display = 'flex';
        const label = runningIndicator.querySelector('span:not(.queue-badge)');
        if (label) label.textContent = 'Agent is working...';
      }
      if (sendBtn) {
        sendBtn.classList.add('queue-mode');
        sendBtn.innerHTML = '<span class="icon">📥</span> Queue';
      }
    } else {
      if (runningIndicator) runningIndicator.style.display = 'none';
      if (sendBtn) {
        sendBtn.classList.remove('queue-mode');
        sendBtn.innerHTML = '<span class="icon">🚀</span> Run Agent';
      }
    }

    if (runningIndicator && inst) {
      let badge = runningIndicator.querySelector('.queue-badge');
      if (inst.messageQueue.length > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'queue-badge';
          badge.style.cssText = 'margin-left: 8px; background: var(--accent); color: white; border-radius: 10px; font-size: 11px; padding: 2px 8px; font-weight: 600;';
          runningIndicator.appendChild(badge);
        }
        badge.textContent = `${inst.messageQueue.length} queued`;
      } else if (badge) {
        badge.remove();
      }
    }
  }

  _startDraftSave() {
    if (this._draftSaveInterval) return;
    this._draftSaveInterval = setInterval(() => {
      if (this.activeTabId) {
        const promptEl = document.getElementById('chat-prompt');
        if (promptEl) this.draftPrompts[this.activeTabId] = promptEl.value;
      }
    }, 1000);
  }

  _stopDraftSave() {
    if (this._draftSaveInterval) {
      clearInterval(this._draftSaveInterval);
      this._draftSaveInterval = null;
    }
    if (this.activeTabId) {
      const promptEl = document.getElementById('chat-prompt');
      if (promptEl) this.draftPrompts[this.activeTabId] = promptEl.value;
    }
  }

  _wireAddButton() {
    const addBtn = document.getElementById('chat-tab-add');
    if (addBtn) addBtn.addEventListener('click', () => this.addNewTab());
  }

  _createInitialTab() {
    const chatId = localStorage.getItem('appapp_chat_id') || null;
    const tabId = `tab_${Date.now()}`;

    const existingPane = document.getElementById('chat-messages');
    if (existingPane) {
      existingPane.id = `chat-messages-${tabId}`;
      existingPane.className = 'chat-messages-pane active';
      this._addChatRefClickHandler(existingPane);
    }

    this.tabs.push({
      id: tabId,
      chatId: chatId,
      title: 'Chat',
      isRunning: false,
    });

    this.activeTabId = tabId;
    this._createInstance(tabId, chatId);
  }

  _addChatRefClickHandler(pane) {
    pane.addEventListener('click', (e) => {
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

  _createPane(tabId) {
    const pane = document.createElement('div');
    pane.id = `chat-messages-${tabId}`;
    pane.className = 'chat-messages-pane';
    pane.innerHTML = this.systemMessageHtml;
    this.wrapperEl.appendChild(pane);
    this._addChatRefClickHandler(pane);
    return pane;
  }

  _activatePane(tabId) {
    this.wrapperEl.querySelectorAll('.chat-messages-pane').forEach(p => {
      p.classList.remove('active');
    });
    const target = document.getElementById(`chat-messages-${tabId}`);
    if (target) target.classList.add('active');
  }

  async addNewTab() {
    const tabId = `tab_${Date.now()}`;

    if (this.activeTabId) {
      const promptEl = document.getElementById('chat-prompt');
      if (promptEl) this.draftPrompts[this.activeTabId] = promptEl.value;
    }

    this._createPane(tabId);
    const instance = this._createInstance(tabId, null);

    this.tabs.push({
      id: tabId,
      chatId: null,
      title: 'New Chat',
      isRunning: false,
    });

    this._activatePane(tabId);
    this.activeTabId = tabId;
    chatEngine = instance;

    localStorage.removeItem('appapp_chat_id');
    await instance.initializeChatSession();
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab) tab.chatId = instance.currentChatId;

    const promptEl = document.getElementById('chat-prompt');
    if (promptEl) promptEl.value = '';
    this.draftPrompts[tabId] = '';

    currentChatId = instance.currentChatId;
    localStorage.setItem('appapp_chat_id', instance.currentChatId || '');

    this._syncSharedUI();
    this.renderTabs();
    this.persist();
    instance.showToast('New chat tab', 'info');

    if (promptEl) promptEl.focus();
  }

  async addTabWithChat(chatId) {
    const tabId = `tab_${Date.now()}`;

    const existing = this.findTabByChatId(chatId);
    if (existing) {
      this.switchToTab(existing.id);
      return;
    }

    if (this.activeTabId) {
      const promptEl = document.getElementById('chat-prompt');
      if (promptEl) this.draftPrompts[this.activeTabId] = promptEl.value;
    }

    this._createPane(tabId);
    const instance = this._createInstance(tabId, chatId);

    this.tabs.push({
      id: tabId,
      chatId: chatId,
      title: 'Loading…',
      isRunning: false,
    });

    this._activatePane(tabId);
    this.activeTabId = tabId;
    chatEngine = instance;

    const chatData = await instance.loadChatHistory(chatId);
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab && chatData) {
      tab.title = chatData.title || (chatData.messages?.[0]?.content?.slice(0, 30) + '…') || 'Chat';
    }

    const promptEl = document.getElementById('chat-prompt');
    if (promptEl) promptEl.value = '';
    this.draftPrompts[tabId] = '';

    currentChatId = chatId;
    localStorage.setItem('appapp_chat_id', chatId);

    this._syncSharedUI();
    this.renderTabs();
    this.persist();
    instance.showToast('Chat loaded in new tab', 'success');
  }

  switchToTab(tabId) {
    if (tabId === this.activeTabId) return;

    if (this.activeTabId) {
      const promptEl = document.getElementById('chat-prompt');
      if (promptEl) this.draftPrompts[this.activeTabId] = promptEl.value;
    }

    this._activatePane(tabId);
    this.activeTabId = tabId;
    const instance = this.instances[tabId];
    chatEngine = instance;

    const switchedTab = this.tabs.find(t => t.id === tabId);
    if (switchedTab) {
      switchedTab.unread = false;
      switchedTab.needsAttention = false;
    }

    const promptEl = document.getElementById('chat-prompt');
    if (promptEl) promptEl.value = this.draftPrompts[tabId] || '';

    const tab = this.tabs.find(t => t.id === tabId);
    if (tab && tab.chatId) {
      currentChatId = tab.chatId;
      localStorage.setItem('appapp_chat_id', tab.chatId);

      const pane = document.getElementById(`chat-messages-${tabId}`);
      const hasOnlySystemMsg = pane && pane.children.length <= 1;
      if (hasOnlySystemMsg && instance) {
        instance.loadChatHistory(tab.chatId).then(chatData => {
          if (chatData && tab.title === 'Chat') {
            tab.title = chatData.title || (chatData.messages?.[0]?.content?.slice(0, 30) + '…') || 'Chat';
            this.renderTabs();
            this.persist();
          }
        }).catch(() => {});
      }
    }

    this._syncSharedUI();
    this.renderTabs();
    this.persist();
  }

  closeTab(tabId) {
    const tabIndex = this.tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const instance = this.instances[tabId];
    if (instance && instance.agentRunning) {
      showToast('Cannot close tab while agent is running', 'error');
      return;
    }

    this._doCloseTab(tabId);
  }

  _doCloseTab(tabId) {
    const tabIndex = this.tabs.findIndex(t => t.id === tabId);
    if (tabIndex === -1) return;

    const pane = document.getElementById(`chat-messages-${tabId}`);
    if (pane) pane.remove();

    delete this.instances[tabId];
    delete this.draftPrompts[tabId];
    this.tabs.splice(tabIndex, 1);

    if (this.tabs.length === 0) {
      this.addNewTab();
      return;
    }

    if (tabId === this.activeTabId) {
      const newIndex = Math.min(tabIndex, this.tabs.length - 1);
      this.activeTabId = null;
      this.switchToTab(this.tabs[newIndex].id);
    }

    this.renderTabs();
    this.persist();
  }

  updateTabTitle(tabId, title) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab) {
      tab.title = title;
      this.renderTabs();
      this.persist();
    }
  }

  updateTabRunning(tabId, isRunning) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab) {
      tab.isRunning = isRunning;
      this.renderTabs();
    }
  }

  setTabNeedsAttention(tabId, value = true) {
    const tab = this.tabs.find(t => t.id === tabId);
    if (tab) {
      tab.needsAttention = value;
      this.renderTabs();
    }
  }

  findTabByChatId(chatId) {
    return this.tabs.find(t => t.chatId === chatId);
  }

  getActiveTab() {
    return this.tabs.find(t => t.id === this.activeTabId);
  }

  renderTabs() {
    if (!this.tabBarEl) return;
    const addBtn = this.tabBarEl.querySelector('#chat-tab-add');
    this.tabBarEl.querySelectorAll('.chat-tab').forEach(el => el.remove());

    for (const tab of this.tabs) {
      const tabEl = document.createElement('div');
      tabEl.className = `chat-tab${tab.id === this.activeTabId ? ' active' : ''}${tab.unread ? ' unread' : ''}${tab.needsAttention ? ' needs-attention' : ''}`;
      tabEl.setAttribute('data-tab-id', tab.id);

      let innerHtml = '';
      if (tab.isRunning) {
        innerHtml += '<span class="tab-spinner"></span>';
      }
      if (tab.needsAttention) {
        innerHtml += '<span class="tab-attention-dot" title="Needs your attention">●</span>';
      }
      innerHtml += `<span class="tab-title">${this._escapeHtml(tab.title || 'Chat')}</span>`;
      innerHtml += '<span class="tab-close" title="Close tab">×</span>';
      tabEl.innerHTML = innerHtml;

      tabEl.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) {
          e.stopPropagation();
          this.closeTab(tab.id);
        } else {
          this.switchToTab(tab.id);
        }
      });

      this.tabBarEl.insertBefore(tabEl, addBtn);
    }
  }

  persist() {
    try {
      localStorage.setItem('appapp_chat_tabs', JSON.stringify({
        tabs: this.tabs.map(t => ({ id: t.id, chatId: t.chatId, title: t.title })),
        activeTabId: this.activeTabId,
      }));
    } catch (e) {
      console.warn('Failed to persist chat tabs:', e);
    }
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}


// ═══════════════════════════════════════════════════════════════
// Chat Initialization
// ═══════════════════════════════════════════════════════════════
async function initializeChatPanel() {
  const panel = document.getElementById('chat-panel');
  if (!panel) return;

  if (!chatTabManager) {
    const sharedConfig = {
      getContextPath: () => '',
      getChatId: () => currentChatId,
      setChatId: (id) => { currentChatId = id; },
      onChatIdChange: (id) => { currentChatId = id; },
      showToast: showToast,
      onComplete: async () => {
        // Agent completed — nothing to refresh in blank canvas mode
      },
    };

    chatTabManager = new ChatTabManager(sharedConfig);
    await chatTabManager.init();
    chatEngine = chatTabManager.activeInstance;

    if (chatEngine) await chatEngine.setupModelSelector();
  }
}

async function startNewChat() {
  if (chatTabManager) {
    await chatTabManager.addNewTab();
  } else if (chatEngine) {
    await chatEngine.startNewChat();
  }
}

async function showChatHistory() {
  try {
    const res = await fetch(`/api/chats?t=${Date.now()}`);
    if (!res.ok) throw new Error('Failed to load chats');
    const data = await res.json();
    const chats = data.chats || [];

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width: 600px; max-height: 80vh; overflow-y: auto;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <h3>Chat History</h3>
          <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove()" style="padding: 4px 8px;">×</button>
        </div>
        <div id="chat-history-list" style="display: flex; flex-direction: column; gap: 8px;">
          ${chats.length === 0 ? '<p style="color: var(--btn-ghost-text); text-align: center; padding: 20px;">No chat history yet</p>' : ''}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const listEl = overlay.querySelector('#chat-history-list');
    if (chats.length > 0) {
      chats.forEach(chat => {
        const chatEl = document.createElement('div');
        chatEl.className = 'chat-history-item';
        chatEl.style.cssText = `
          padding: 12px;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: var(--panel-bg);
          cursor: pointer;
          transition: background 0.2s;
        `;
        chatEl.onmouseover = () => chatEl.style.background = 'var(--panel-msg-bg)';
        chatEl.onmouseout = () => chatEl.style.background = 'var(--panel-bg)';

        const date = new Date(chat.updated_at || chat.created_at);
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        chatEl.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: start; gap: 12px;">
            <div style="flex: 1; min-width: 0;">
              <div style="font-weight: 500; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${escapeHtml(chat.title || 'Untitled')}
              </div>
              <div style="font-size: 11px; color: var(--btn-ghost-text);">
                ${chat.message_count || 0} messages • ${dateStr}
              </div>
            </div>
            <div style="display: flex; gap: 4px;">
              <button class="btn btn-ghost" onclick="event.stopPropagation(); loadChat('${chat.chat_id}'); this.closest('.modal-overlay').remove();" style="padding: 4px 8px; font-size: 11px;" title="Load Chat">
                Load
              </button>
              <button class="btn btn-ghost" onclick="event.stopPropagation(); deleteChat('${chat.chat_id}', this);" style="padding: 4px 8px; font-size: 11px; color: var(--danger);" title="Delete Chat">
                Delete
              </button>
            </div>
          </div>
        `;
        listEl.appendChild(chatEl);
      });
    }
  } catch (err) {
    showToast('Failed to load chat history', 'error');
    console.error('Error loading chat history:', err);
  }
}

async function loadChat(chatId) {
  if (!chatEngine) return;

  if (chatTabManager) {
    const existingTab = chatTabManager.findTabByChatId(chatId);
    if (existingTab) {
      chatTabManager.switchToTab(existingTab.id);
      showToast('Switched to existing tab', 'info');
      return;
    }
    await chatTabManager.addTabWithChat(chatId);
    return;
  }

  try {
    const chatData = await chatEngine.loadChatHistory(chatId);
    if (chatData) {
      chatEngine.currentChatId = chatId;
      currentChatId = chatId;
      localStorage.setItem('appapp_chat_id', chatId);
      chatEngine.setChatId(chatId);
      chatEngine.onChatIdChange(chatId);
      showToast('Chat loaded', 'success');
    }
  } catch (err) {
    showToast('Failed to load chat', 'error');
    console.error('Error loading chat:', err);
  }
}

async function deleteChat(chatId, buttonEl) {
  if (!confirm('Delete this chat? This cannot be undone.')) return;
  
  try {
    const res = await fetch(`/api/chats/${chatId}`, { method: 'DELETE' });
    if (res.ok) {
      buttonEl.closest('.chat-history-item').remove();
      showToast('Chat deleted', 'success');
      
      if (chatTabManager) {
        const tab = chatTabManager.findTabByChatId(chatId);
        if (tab) {
          const inst = chatTabManager.instances[tab.id];
          if (inst && inst.agentRunning) {
            showToast('Cannot delete chat while agent is running', 'error');
            return;
          }
          if (chatTabManager.tabs.length > 1) {
            chatTabManager.closeTab(tab.id);
          } else {
            if (inst) {
              await inst.startNewChat();
              tab.chatId = inst.currentChatId;
              tab.title = 'New Chat';
              chatTabManager.renderTabs();
              chatTabManager.persist();
            }
          }
        }
      } else if (chatEngine && chatEngine.currentChatId === chatId) {
        await chatEngine.startNewChat();
      }
    } else {
      throw new Error('Failed to delete chat');
    }
  } catch (err) {
    showToast('Failed to delete chat', 'error');
    console.error('Error deleting chat:', err);
  }
}


// ═══════════════════════════════════════════════════════════════
// Keyboard Shortcuts
// ═══════════════════════════════════════════════════════════════
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Cmd+Enter → send prompt (also handled in tab manager listener)
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const promptEl = document.getElementById('chat-prompt');
      if (document.activeElement === promptEl) return; // Handled by tab manager
      e.preventDefault();
      promptEl?.focus();
    }
  });
}


// ═══════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.classList.add('visible'), 10);
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
