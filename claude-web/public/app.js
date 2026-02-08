// ============================
// Remote Console Log Piping
// ============================
// Must be defined early so all subsequent console calls are captured

const _origConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};

function _sendRemoteLog(level, args) {
  // ws is declared below — this function is called after ws exists
  if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
    try {
      const msg = args.map(a => {
        if (a instanceof Error) return `${a.message}\n${a.stack}`;
        if (typeof a === 'object') {
          try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
      }).join(' ');

      ws.send(JSON.stringify({
        type: 'client_log',
        level,
        message: msg,
        timestamp: Date.now(),
      }));
    } catch (e) {
      // Avoid infinite recursion
    }
  }
}

console.log = (...args) => { _origConsole.log(...args); _sendRemoteLog('log', args); };
console.warn = (...args) => { _origConsole.warn(...args); _sendRemoteLog('warn', args); };
console.error = (...args) => { _origConsole.error(...args); _sendRemoteLog('error', args); };
console.info = (...args) => { _origConsole.info(...args); _sendRemoteLog('info', args); };

// Catch uncaught errors and unhandled rejections
window.addEventListener('error', (e) => {
  _sendRemoteLog('error', [`Uncaught: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`]);
});
window.addEventListener('unhandledrejection', (e) => {
  _sendRemoteLog('error', [`Unhandled Promise: ${e.reason}`]);
});

// ============================
// State
// ============================
let ws = null;
let currentSessionId = null;
let currentSdkSessionId = null; // SDK-level session ID for resumption
let sessions = [];
let isConnected = false;
let isSending = false;
let sendingTimeout = null;
let pendingImages = []; // Array of { data: base64, mediaType: string }
let unreadCounts = {}; // { sessionId: number } — unread message counts per session
let serverRestarting = false; // true when WS disconnects during an active query
let reconnectAttempts = 0; // For exponential backoff
let selectSessionSeq = 0; // Batch 3: sequence counter for race condition prevention
let lastPingTime = null; // Track last server ping
let activeMsgStatus = null; // Current message status element (for ack/working/done)

// DOM elements
const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menuBtn');
const closeSidebar = document.getElementById('closeSidebar');
const newSessionBtn = document.getElementById('newSessionBtn');
const sessionList = document.getElementById('sessionList');
const sessionTitle = document.getElementById('sessionTitle');
const messages = document.getElementById('messages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const interruptBtn = document.getElementById('interruptBtn');
const mcpConfigBtn = document.getElementById('mcpConfigBtn');
const mcpModal = document.getElementById('mcpModal');
const closeMcpModal = document.getElementById('closeMcpModal');
const cancelMcpConfig = document.getElementById('cancelMcpConfig');
const saveMcpConfig = document.getElementById('saveMcpConfig');
const mcpConfig = document.getElementById('mcpConfig');
const vncToggleBtn = document.getElementById('vncToggleBtn');
const vncViewer = document.getElementById('vncViewer');
const vncMinimizeBtn = document.getElementById('vncMinimizeBtn');
const vncMaximizeBtn = document.getElementById('vncMaximizeBtn');
const vncCloseBtn = document.getElementById('vncCloseBtn');
const vncRestartBtn = document.getElementById('vncRestartBtn');
const vncHeader = document.querySelector('.vnc-header');
const attachBtn = document.getElementById('attachBtn');
const imageInput = document.getElementById('imageInput');
const imagePreview = document.getElementById('imagePreview');
const refreshAppBtn = document.getElementById('refreshAppBtn');
const connDot = document.getElementById('connDot');
const connLabel = document.getElementById('connLabel');

// ============================
// Connection Status
// ============================

function updateConnectionStatus(state, detail = '') {
  // state: 'connected', 'disconnected', 'connecting', 'querying'
  connDot.className = 'conn-dot';
  if (state === 'connected') {
    connDot.classList.add('connected');
    const pingAge = lastPingTime ? Math.round((Date.now() - lastPingTime) / 1000) : null;
    connLabel.textContent = detail || (pingAge !== null ? `ok · ${pingAge}s` : 'connected');
  } else if (state === 'disconnected') {
    connDot.classList.add('disconnected');
    connLabel.textContent = detail || 'offline';
  } else if (state === 'connecting') {
    connDot.classList.add('connecting');
    connLabel.textContent = detail || 'connecting';
  } else if (state === 'querying') {
    connDot.classList.add('connected');
    connLabel.textContent = detail || 'query running';
  }
}

// Refresh connection status label periodically (show ping age)
setInterval(() => {
  if (isConnected && !isSending) {
    updateConnectionStatus('connected');
  }
}, 10_000);

// Initialize
init();

async function init() {
  setupEventListeners();
  connectWebSocket();
  await loadSessions();

  // Restore session after refresh if available
  const restoreId = sessionStorage.getItem('claude_restore_session');
  sessionStorage.removeItem('claude_restore_session');

  if (restoreId && sessions.find(s => s.id === restoreId)) {
    selectSession(restoreId);
  } else if (sessions.length === 0) {
    await createSession('New Session');
  } else {
    selectSession(sessions[0].id);
  }
}

function setupEventListeners() {
  menuBtn.addEventListener('click', () => sidebar.classList.add('open'));
  closeSidebar.addEventListener('click', () => sidebar.classList.remove('open'));

  newSessionBtn.addEventListener('click', async () => {
    const name = `Session ${sessions.length + 1}`;
    await createSession(name);
    sidebar.classList.remove('open');
  });

  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
  });

  interruptBtn.addEventListener('click', interrupt);

  mcpConfigBtn.addEventListener('click', openMcpModal);
  closeMcpModal.addEventListener('click', () => mcpModal.classList.remove('open'));
  cancelMcpConfig.addEventListener('click', () => mcpModal.classList.remove('open'));
  saveMcpConfig.addEventListener('click', saveMcpConfiguration);

  // VNC viewer controls
  vncToggleBtn.addEventListener('click', toggleVncViewer);
  vncMinimizeBtn.addEventListener('click', minimizeVnc);
  vncMaximizeBtn.addEventListener('click', toggleMaximizeVnc);
  vncCloseBtn.addEventListener('click', closeVnc);
  vncRestartBtn.addEventListener('click', restartWebtop);

  // Make VNC draggable and resizable
  setupVncDragging();
  setupVncResizing();

  // Image attach
  attachBtn.addEventListener('click', () => imageInput.click());
  imageInput.addEventListener('change', handleImageSelect);

  // PWA refresh
  refreshAppBtn.addEventListener('click', refreshApp);
}

// WebSocket
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    console.log('WebSocket connected');
    const wasReconnect = reconnectAttempts > 0;
    const wasSending = isSending;
    isConnected = true;
    reconnectAttempts = 0; // Reset backoff on successful connect
    lastPingTime = Date.now();
    updateConnectionStatus('connected');

    // On any reconnect (not first connect), sync state with server
    if (wasReconnect && currentSessionId) {
      serverRestarting = false;
      if (sendingTimeout) { clearTimeout(sendingTimeout); sendingTimeout = null; }

      try {
        const statusRes = await fetch(`/api/sessions/${currentSessionId}/status`);
        const status = await statusRes.json();

        if (status.activeQuery) {
          // Query still running on server — show interrupt button
          console.log('Query still active on server after reconnect');
          isSending = true;
          sendBtn.disabled = true;
          interruptBtn.style.display = 'block';
          updateConnectionStatus('querying');
          showToast('Reconnected — query still running', 3000);
        } else {
          // Query finished (or never started) — reset to idle, reload history
          isSending = false;
          sendBtn.disabled = false;
          interruptBtn.style.display = 'none';
          clearMsgStatus();

          if (wasSending) {
            // We were mid-query when disconnected, and it's now done
            showToast('Reconnected — loading latest messages', 3000);
          }

          // Always reload history on reconnect to catch messages we missed
          messages.innerHTML = '';
          await loadSessionHistory(currentSessionId);
        }
      } catch (e) {
        console.warn('Failed to check session status:', e);
        // Fallback: reload history anyway, reset to idle
        isSending = false;
        sendBtn.disabled = false;
        interruptBtn.style.display = 'none';
        messages.innerHTML = '';
        await loadSessionHistory(currentSessionId);
      }
    }

    // Start current session if one is selected
    if (currentSessionId) {
      startSession(currentSessionId);
    }
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerMessage(data);
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');
    isConnected = false;
    updateConnectionStatus('disconnected');

    // If we were actively sending, the query was interrupted by a server restart
    if (isSending) {
      serverRestarting = true;
      if (sendingTimeout) { clearTimeout(sendingTimeout); sendingTimeout = null; }
      addMessage('system', 'Server disconnected — reconnecting...', 'error');
      clearMsgStatus();
    }

    // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s, 30s max
    reconnectAttempts++;
    const baseDelay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
    const jitter = baseDelay * 0.3 * (Math.random() * 2 - 1); // ±30%
    const delay = Math.round(baseDelay + jitter);
    console.log(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    updateConnectionStatus('connecting', `retry ${reconnectAttempts}`);
    setTimeout(connectWebSocket, delay);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

// ============================
// Message Status (send ack, working, done)
// ============================

function showMsgStatus(text, state = 'sent') {
  // Remove previous status if any
  clearMsgStatus();

  const el = document.createElement('div');
  el.className = `msg-status ${state}`;
  if (state === 'working') {
    el.innerHTML = `<span class="status-spinner"></span> ${escapeHtml(text)}`;
  } else {
    el.textContent = text;
  }
  messages.appendChild(el);
  scrollToBottom();
  activeMsgStatus = el;
  return el;
}

function updateMsgStatus(text, state = 'working') {
  if (activeMsgStatus) {
    activeMsgStatus.className = `msg-status ${state}`;
    if (state === 'working') {
      activeMsgStatus.innerHTML = `<span class="status-spinner"></span> ${escapeHtml(text)}`;
    } else {
      activeMsgStatus.textContent = text;
    }
  }
}

function clearMsgStatus() {
  if (activeMsgStatus) {
    activeMsgStatus.remove();
    activeMsgStatus = null;
  }
}

function handleServerMessage(data) {
  console.log('Server message:', data);

  // Ignore messages from other sessions (prevents leaking)
  // BUT allow session_notification through — those are meant for cross-session display
  if (data.sessionId && data.sessionId !== currentSessionId && data.type !== 'session_notification') {
    console.log('Ignoring message for different session:', data.sessionId);
    return;
  }

  switch (data.type) {
    case 'session_started':
      console.log('Session started:', data.sessionId);
      // Sync query status from server (e.g., after reconnect)
      if (data.activeQuery && !isSending) {
        isSending = true;
        sendBtn.disabled = true;
        interruptBtn.style.display = 'block';
        updateConnectionStatus('querying');
        showMsgStatus('Query running...', 'working');
      }
      break;

    case 'sdk_event':
      handleSdkEvent(data.event);
      break;

    case 'query_completed':
      if (sendingTimeout) {
        clearTimeout(sendingTimeout);
        sendingTimeout = null;
      }
      isSending = false;
      sendBtn.disabled = false;
      interruptBtn.style.display = 'none';
      updateConnectionStatus('connected');
      clearMsgStatus();
      break;

    case 'interrupted':
      if (sendingTimeout) {
        clearTimeout(sendingTimeout);
        sendingTimeout = null;
      }
      isSending = false;
      sendBtn.disabled = false;
      interruptBtn.style.display = 'none';
      updateConnectionStatus('connected');
      clearMsgStatus();
      addMessage('system', 'Query interrupted');
      break;

    case 'error':
      if (sendingTimeout) {
        clearTimeout(sendingTimeout);
        sendingTimeout = null;
      }
      isSending = false;
      sendBtn.disabled = false;
      interruptBtn.style.display = 'none';
      updateConnectionStatus('connected');
      clearMsgStatus();
      addMessage('system', `Error: ${data.error}`, 'error');
      break;

    case 'mcp_servers_updated':
      addMessage('system', 'MCP servers updated successfully', 'success');
      break;

    case 'session_notification':
      handleSessionNotification(data);
      break;
  }
}

function handleSdkEvent(event) {
  console.log('SDK event:', event);

  switch (event.type) {
    case 'system':
      handleSystemEvent(event);
      break;

    case 'assistant':
      // First assistant message = Claude is responding, clear "Starting Claude..."
      clearMsgStatus();
      updateConnectionStatus('querying', 'responding');
      handleAssistantMessage(event);
      break;

    case 'user':
      // User messages are already shown in the UI when sent and saved server-side.
      // Skip all user echoes from the SDK to prevent duplicates.
      break;

    case 'result':
      handleResultMessage(event);
      break;

    case 'tool_progress':
      updateToolProgress(event);
      updateConnectionStatus('querying', `tool: ${event.tool_name}`);
      break;
  }
}

function handleSystemEvent(event) {
  if (event.subtype === 'init') {
    // Store SDK session ID for resumption
    currentSdkSessionId = event.session_id;

    // Show compact MCP server status bar
    if (event.mcp_servers && event.mcp_servers.length > 0) {
      const statusHtml = '<div class="mcp-status-bar">' +
        event.mcp_servers.map(server => {
          const dotClass = server.status === 'connected' ? '' : (server.status === 'connecting' ? 'pending' : 'error');
          return `<span class="mcp-status-item"><span class="status-dot ${dotClass}"></span>${escapeHtml(server.name)}</span>`;
        }).join('') +
        '</div>';
      addSystemMessage(statusHtml);
    }

    // Update status: Claude is initializing
    updateMsgStatus('Starting Claude...', 'working');
    updateConnectionStatus('querying', 'initializing');
  } else if (event.subtype === 'status') {
    if (event.status === 'compacting') {
      updateMsgStatus('Compacting context...', 'working');
    }
  }
}

function handleAssistantMessage(event) {
  const content = event.message.content;

  for (const block of content) {
    if (block.type === 'text') {
      addMessage('assistant', block.text, null, true); // Enable markdown
    } else if (block.type === 'tool_use') {
      addToolUse(block);
    }
  }
}

function handleResultMessage(event) {
  if (event.subtype === 'success') {
    const stats = `<span style="font-size:0.7rem;color:var(--text-tertiary)">${event.num_turns} turns · $${event.total_cost_usd.toFixed(4)} · ${event.usage.input_tokens}↓ ${event.usage.output_tokens}↑</span>`;
    addSystemMessage(stats);
  } else if (event.subtype.startsWith('error_')) {
    const errorMsg = event.errors.join('\n');
    addMessage('system', `Error: ${errorMsg}`, 'error');
  }
}

// Message rendering
function addMessage(role, content, status = null, useMarkdown = false) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message';

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let statusClass = '';
  if (status === 'error') statusClass = 'error';
  else if (status === 'success') statusClass = 'success';

  // Render markdown for assistant messages
  let contentHtml;
  if (useMarkdown && typeof marked !== 'undefined') {
    contentHtml = marked.parse(content, { breaks: true });
  } else {
    contentHtml = escapeHtml(content);
  }

  messageDiv.innerHTML = `
    <div class="message-header">
      <span class="message-role ${role} ${statusClass}">${role}</span>
      <span class="message-time">${time}</span>
    </div>
    <div class="message-content">${contentHtml}</div>
  `;

  messages.appendChild(messageDiv);
  scrollToBottom();
}

function addSystemMessage(htmlContent) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message';

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  messageDiv.innerHTML = `
    <div class="message-header">
      <span class="message-role system">system</span>
      <span class="message-time">${time}</span>
    </div>
    <div class="message-content">${htmlContent}</div>
  `;

  messages.appendChild(messageDiv);
  scrollToBottom();
}

function addToolUse(toolUse) {
  const toolDiv = document.createElement('div');
  toolDiv.className = 'tool-block';
  toolDiv.dataset.toolId = toolUse.id;

  const inputJson = JSON.stringify(toolUse.input, null, 2);

  toolDiv.innerHTML = `
    <div class="tool-header">
      <span class="tool-icon">🔧</span>
      <span class="tool-name">${escapeHtml(toolUse.name)}</span>
      <span class="tool-expand-icon">▼</span>
    </div>
    <div class="tool-content">${escapeHtml(inputJson)}</div>
  `;

  // Toggle expand
  toolDiv.querySelector('.tool-header').addEventListener('click', () => {
    toolDiv.classList.toggle('expanded');
  });

  messages.appendChild(toolDiv);
  scrollToBottom();
}

function updateToolProgress(event) {
  const toolDiv = messages.querySelector(`[data-tool-id="${event.tool_use_id}"]`);
  if (toolDiv) {
    const toolName = toolDiv.querySelector('.tool-name');
    toolName.textContent = `${event.tool_name} (${event.elapsed_time_seconds.toFixed(1)}s)`;
  }
}

// Sessions
async function loadSessions() {
  try {
    const response = await fetch('/api/sessions');
    sessions = await response.json();
    renderSessions();
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

function renderSessions() {
  sessionList.innerHTML = sessions.map(session => {
    const date = new Date(session.lastActive);
    const timeStr = date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    const unread = unreadCounts[session.id] || 0;
    const unreadBadge = unread > 0
      ? `<span class="session-unread-badge">${unread > 9 ? '9+' : unread}</span>`
      : '';
    const unreadClass = unread > 0 ? ' has-unread' : '';

    return `
      <div class="session-item ${session.id === currentSessionId ? 'active' : ''}${unreadClass}"
           data-id="${session.id}">
        <div class="session-item-content">
          <div class="session-name">${escapeHtml(session.name)}${unreadBadge}</div>
          <div class="session-time">${timeStr}</div>
        </div>
        <div class="session-actions">
          <button class="session-action-btn session-rename-btn" data-id="${session.id}" title="Rename">✏️</button>
          <button class="session-action-btn session-delete-btn" data-id="${session.id}" title="Delete">✕</button>
        </div>
      </div>
    `;
  }).join('');

  // Add click listeners for selecting sessions
  document.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.session-action-btn')) return;
      const id = item.dataset.id;
      selectSession(id);
      sidebar.classList.remove('open');
    });
  });

  // Rename buttons
  document.querySelectorAll('.session-rename-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      renameSession(btn.dataset.id);
    });
  });

  // Delete buttons
  document.querySelectorAll('.session-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const session = sessions.find(s => s.id === id);
      if (!session) return;
      if (!confirm(`Delete "${session.name}"?`)) return;
      await deleteSession(id);
    });
  });
}

async function deleteSession(sessionId) {
  try {
    await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    sessions = sessions.filter(s => s.id !== sessionId);

    // If we deleted the current session, switch to another or create new
    if (sessionId === currentSessionId) {
      if (sessions.length > 0) {
        selectSession(sessions[0].id);
      } else {
        await createSession('New Session');
      }
    }

    renderSessions();
  } catch (error) {
    console.error('Failed to delete session:', error);
    alert('Failed to delete session: ' + error.message);
  }
}

async function createSession(name, folder = null) {
  try {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder })
    });

    const session = await response.json();
    sessions.push(session);
    renderSessions();
    selectSession(session.id);
  } catch (error) {
    console.error('Failed to create session:', error);
  }
}

async function selectSession(sessionId) {
  // Batch 3: increment sequence counter to prevent race conditions
  const seq = ++selectSessionSeq;

  currentSessionId = sessionId;
  currentSdkSessionId = null; // Will be loaded from server

  // Clear unread for this session
  delete unreadCounts[sessionId];
  updateUnreadBadge();

  // Reset sending state when switching sessions
  if (sendingTimeout) {
    clearTimeout(sendingTimeout);
    sendingTimeout = null;
  }
  isSending = false;
  sendBtn.disabled = false;
  interruptBtn.style.display = 'none';

  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    sessionTitle.textContent = session.name;
  }

  // Clear messages
  messages.innerHTML = '';

  // Load message history (pass sequence counter for race detection)
  await loadSessionHistory(sessionId, seq);

  // Re-render session list to update active state
  renderSessions();

  // Start session with server (re-routes WS connection to this session)
  if (isConnected) {
    startSession(sessionId);
  }
}

async function loadSessionHistory(sessionId, seq = null) {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages`);
    const data = await response.json();

    // Batch 3: bail if the user switched sessions while we were fetching
    if (seq !== null && seq !== selectSessionSeq) {
      console.log('Stale session history response — user switched sessions');
      return;
    }

    // Restore SDK session ID for resumption
    if (data.sdkSessionId) {
      currentSdkSessionId = data.sdkSessionId;
    }

    // Render historical messages
    if (data.messages && data.messages.length > 0) {
      data.messages.forEach(msg => {
        addMessage(msg.role, msg.content, msg.status, msg.useMarkdown);
      });
    }
  } catch (error) {
    console.error('Failed to load session history:', error);
  }
}

function startSession(sessionId) {
  send({
    type: 'start_session',
    sessionId,
    resume: currentSdkSessionId // Resume if we have an SDK session ID
  });
}

// Send message
function sendMessage() {
  const text = messageInput.value.trim();
  const hasImages = pendingImages.length > 0;
  if ((!text && !hasImages) || !isConnected || isSending) return;

  isSending = true;
  sendBtn.disabled = true;
  interruptBtn.style.display = 'block';

  // Set a timeout to reset UI state if query hangs (5 minutes)
  sendingTimeout = setTimeout(() => {
    console.warn('Query timeout - resetting UI state');
    isSending = false;
    sendBtn.disabled = false;
    interruptBtn.style.display = 'none';
    addMessage('system', 'Query timed out after 5 minutes', 'error');
  }, 5 * 60 * 1000);

  // Batch 4: Pre-save user message via REST (fire-and-forget — survives WS drop)
  if (text) {
    fetch(`/api/sessions/${currentSessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, timestamp: Date.now() }),
    }).catch(e => console.warn('Pre-save failed (will be saved via WS):', e));
  }

  // Add user message to UI (with image thumbnails if present)
  let displayContent = text || '';
  if (hasImages) {
    const thumbsHtml = pendingImages.map(img =>
      `<img src="data:${img.mediaType};base64,${img.data}" class="message-image-thumb" alt="attached image">`
    ).join('');
    displayContent = thumbsHtml + (text ? `<p>${escapeHtml(text)}</p>` : '');
    addMessageHtml('user', displayContent);
  } else {
    addMessage('user', text);
  }

  // Build message payload
  const payload = {
    type: 'send_message',
    sessionId: currentSessionId,
    prompt: text || 'What do you see in this image?',
    resume: currentSdkSessionId,
  };

  // Include images if present
  if (hasImages) {
    payload.images = pendingImages.map(img => ({
      data: img.data,
      mediaType: img.mediaType,
    }));
  }

  send(payload);

  // Show send acknowledgment
  showMsgStatus('Sent ✓', 'sent');
  updateConnectionStatus('querying', 'sending');

  // Clear input and images
  messageInput.value = '';
  messageInput.style.height = 'auto';
  clearPendingImages();
}

function interrupt() {
  send({
    type: 'interrupt',
    sessionId: currentSessionId
  });
}

// MCP Configuration
async function openMcpModal() {
  try {
    const response = await fetch('/api/mcp-config');
    const config = await response.json();
    mcpConfig.value = JSON.stringify(config, null, 2);
    mcpModal.classList.add('open');
  } catch (error) {
    console.error('Failed to load MCP config:', error);
  }
}

async function saveMcpConfiguration() {
  try {
    const config = JSON.parse(mcpConfig.value);

    // Save to server
    await fetch('/api/mcp-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });

    // Update current session if active
    if (currentSessionId && isConnected) {
      send({
        type: 'set_mcp_servers',
        sessionId: currentSessionId,
        servers: config
      });
    }

    mcpModal.classList.remove('open');
  } catch (error) {
    alert('Invalid JSON configuration: ' + error.message);
  }
}

// Helpers
function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function extractContent(message) {
  if (!message || !message.content) return '';

  if (Array.isArray(message.content)) {
    return message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }

  return String(message.content);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messages.scrollTop = messages.scrollHeight;
  });
}

// ============================
// Toast Notifications
// ============================

function showToast(message, duration = 4000, onClick = null) {
  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.textContent = message;
  if (onClick) {
    toast.style.cursor = 'pointer';
    toast.addEventListener('click', () => {
      onClick();
      toast.remove();
    });
  }
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ============================
// Session Notifications (cross-session)
// ============================

function handleSessionNotification(data) {
  // Don't show toast for the session we're currently viewing
  if (data.sessionId === currentSessionId) return;

  if (data.notification === 'completed') {
    // Increment unread count for that session
    unreadCounts[data.sessionId] = (unreadCounts[data.sessionId] || 0) + 1;
    updateUnreadBadge();
    renderSessions();

    showToast(`"${data.sessionName}" finished`, 5000, () => {
      selectSession(data.sessionId);
      sidebar.classList.remove('open');
    });
  }
}

function updateUnreadBadge() {
  const totalUnread = Object.values(unreadCounts).reduce((sum, c) => sum + c, 0);
  let badge = document.getElementById('menuBadge');

  if (totalUnread > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'menuBadge';
      badge.className = 'menu-badge';
      menuBtn.style.position = 'relative';
      menuBtn.appendChild(badge);
    }
    badge.textContent = totalUnread > 9 ? '9+' : String(totalUnread);
    badge.style.display = 'flex';
  } else if (badge) {
    badge.style.display = 'none';
  }
}

// ============================
// Session Rename
// ============================

async function renameSession(sessionId) {
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;

  const newName = prompt('Rename session:', session.name);
  if (!newName || newName === session.name) return;

  try {
    const response = await fetch(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });

    if (response.ok) {
      session.name = newName;
      renderSessions();
      if (sessionId === currentSessionId) {
        sessionTitle.textContent = newName;
      }
    }
  } catch (error) {
    console.error('Failed to rename session:', error);
  }
}

// ============================
// Image Upload
// ============================

function handleImageSelect(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  files.forEach(file => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 10 * 1024 * 1024) {
      addMessage('system', `Image ${file.name} is too large (max 10MB)`, 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = (evt) => {
      const dataUrl = evt.target.result;
      // Extract base64 data and media type
      const [header, data] = dataUrl.split(',');
      const mediaType = header.match(/data:(.*?);/)[1];

      pendingImages.push({ data, mediaType });
      renderImagePreviews();
    };
    reader.readAsDataURL(file);
  });

  // Reset file input so same file can be selected again
  e.target.value = '';
}

function renderImagePreviews() {
  imagePreview.innerHTML = pendingImages.map((img, i) => `
    <div class="image-preview-item">
      <img src="data:${img.mediaType};base64,${img.data}" alt="preview">
      <button class="image-preview-remove" data-index="${i}" title="Remove">✕</button>
    </div>
  `).join('');

  // Add remove handlers
  imagePreview.querySelectorAll('.image-preview-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index);
      pendingImages.splice(idx, 1);
      renderImagePreviews();
    });
  });
}

function clearPendingImages() {
  pendingImages = [];
  imagePreview.innerHTML = '';
}

// Render a user message with raw HTML content (for image thumbnails)
function addMessageHtml(role, htmlContent) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message';

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  messageDiv.innerHTML = `
    <div class="message-header">
      <span class="message-role ${role}">${role}</span>
      <span class="message-time">${time}</span>
    </div>
    <div class="message-content">${htmlContent}</div>
  `;

  messages.appendChild(messageDiv);
  scrollToBottom();
}

// ============================
// PWA: Refresh App
// ============================

async function refreshApp() {
  if (!confirm('Clear cache and reload the app?')) return;

  refreshAppBtn.disabled = true;
  refreshAppBtn.textContent = '⏳ Refreshing...';

  try {
    // Clear all caches
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));

    // Update service worker (don't unregister — just trigger update check)
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }

    // Cache-bust reload CSS in place (no page reload needed)
    const bust = '?v=' + Date.now();
    const oldLink = document.querySelector('link[rel="stylesheet"]');
    if (oldLink) {
      const newLink = document.createElement('link');
      newLink.rel = 'stylesheet';
      newLink.href = '/styles.css' + bust;
      newLink.onload = () => oldLink.remove();
      oldLink.parentNode.insertBefore(newLink, oldLink.nextSibling);
    }

    // Reload the page JS by re-fetching app.js with cache bust
    // We need a full reload for JS — but we'll use a soft approach:
    // Store current session so we can restore it after reload
    const currentSess = currentSessionId;
    if (currentSess) {
      sessionStorage.setItem('claude_restore_session', currentSess);
    }

    // Use standard reload — the caches are already cleared so it'll fetch fresh
    window.location.reload();
  } catch (err) {
    console.error('Refresh failed:', err);
    refreshAppBtn.disabled = false;
    refreshAppBtn.textContent = '🔄 Refresh App';
    alert('Refresh failed: ' + err.message);
  }
}

// ============================
// VNC Viewer
// ============================

// VNC state: 'hidden' | 'pip' | 'minimized' | 'maximized'
let vncState = 'hidden';
let vncLoaded = false;

// Saved PIP position/size for restoring after maximize/minimize
let vncPipRect = null;

function getDefaultPipRect() {
  const w = 480;
  const h = 340;
  return {
    left: window.innerWidth - w - 20,
    top: window.innerHeight - h - 120,
    width: w,
    height: h,
  };
}

function setVncState(newState) {
  const oldState = vncState;
  vncState = newState;

  // Clear all state classes and inline position for class-based states
  vncViewer.classList.remove('pip', 'minimized', 'maximized');

  if (newState === 'hidden') {
    vncViewer.style.display = 'none';
    return;
  }

  vncViewer.style.display = 'flex';

  // Lazy-load the iframe
  if (!vncLoaded) {
    const vncFrame = document.getElementById('vncFrame');
    vncFrame.src = '/vnc/';
    vncLoaded = true;
  }

  if (newState === 'pip') {
    // Use saved rect or default
    if (!vncPipRect) vncPipRect = getDefaultPipRect();
    vncViewer.classList.add('pip');
    // Apply inline styles for position (overrides the CSS defaults)
    vncViewer.style.left = vncPipRect.left + 'px';
    vncViewer.style.top = vncPipRect.top + 'px';
    vncViewer.style.width = vncPipRect.width + 'px';
    vncViewer.style.height = vncPipRect.height + 'px';
    vncViewer.style.right = 'auto';
    vncViewer.style.bottom = 'auto';
  } else if (newState === 'minimized') {
    // Save PIP rect if coming from PIP
    if (oldState === 'pip') savePipRect();
    vncViewer.classList.add('minimized');
    // Clear inline positioning, let CSS handle it
    clearInlinePosition();
  } else if (newState === 'maximized') {
    // Save PIP rect if coming from PIP
    if (oldState === 'pip') savePipRect();
    vncViewer.classList.add('maximized');
    // Clear inline positioning, let CSS handle it
    clearInlinePosition();
  }
}

function savePipRect() {
  vncPipRect = {
    left: vncViewer.offsetLeft,
    top: vncViewer.offsetTop,
    width: vncViewer.offsetWidth,
    height: vncViewer.offsetHeight,
  };
}

function clearInlinePosition() {
  vncViewer.style.left = '';
  vncViewer.style.top = '';
  vncViewer.style.right = '';
  vncViewer.style.bottom = '';
  vncViewer.style.width = '';
  vncViewer.style.height = '';
}

function toggleVncViewer() {
  if (vncState === 'hidden') {
    setVncState('pip');
  } else {
    setVncState('hidden');
  }
}

function minimizeVnc() {
  if (vncState === 'minimized') {
    setVncState('pip');
  } else {
    setVncState('minimized');
  }
}

function toggleMaximizeVnc() {
  if (vncState === 'maximized') {
    setVncState('pip');
  } else {
    setVncState('maximized');
  }
}

function closeVnc() {
  setVncState('hidden');
}

async function restartWebtop() {
  if (!confirm('Restart the webtop computer? This will take about 15-30 seconds.')) return;

  const btn = vncRestartBtn;
  const originalText = btn.textContent;
  btn.textContent = '⏳';
  btn.disabled = true;

  try {
    const response = await fetch('/api/webtop/restart', { method: 'POST' });
    const data = await response.json();

    if (data.success) {
      btn.textContent = '✅';
      // Reload the VNC iframe after a delay for the container to come back up
      setTimeout(() => {
        const vncFrame = document.getElementById('vncFrame');
        if (vncFrame && vncLoaded) {
          vncFrame.src = '/vnc/';
        }
        btn.textContent = originalText;
        btn.disabled = false;
      }, 15000);
    } else {
      btn.textContent = '❌';
      alert('Failed to restart: ' + (data.error || 'Unknown error'));
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
    }
  } catch (err) {
    btn.textContent = '❌';
    alert('Failed to restart webtop: ' + err.message);
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
  }
}

// VNC dragging
function setupVncDragging() {
  let isDragging = false;
  let startMouseX, startMouseY;
  let startLeft, startTop;

  vncHeader.addEventListener('mousedown', dragStart);
  vncHeader.addEventListener('touchstart', dragStart, { passive: false });
  document.addEventListener('mousemove', drag);
  document.addEventListener('touchmove', drag, { passive: false });
  document.addEventListener('mouseup', dragEnd);
  document.addEventListener('touchend', dragEnd);

  function dragStart(e) {
    if (e.target.closest('.vnc-btn')) return;
    if (vncState !== 'pip') return;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    startMouseX = clientX;
    startMouseY = clientY;
    startLeft = vncViewer.offsetLeft;
    startTop = vncViewer.offsetTop;

    isDragging = true;
    vncViewer.classList.add('dragging');
    e.preventDefault();
  }

  function drag(e) {
    if (!isDragging) return;
    e.preventDefault();

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const dx = clientX - startMouseX;
    const dy = clientY - startMouseY;

    vncViewer.style.left = (startLeft + dx) + 'px';
    vncViewer.style.top = (startTop + dy) + 'px';
  }

  function dragEnd() {
    if (!isDragging) return;
    isDragging = false;
    vncViewer.classList.remove('dragging');
    // Update saved rect
    savePipRect();
  }

  // Click minimized pill to restore
  vncHeader.addEventListener('click', (e) => {
    if (vncState === 'minimized' && !e.target.closest('.vnc-btn')) {
      setVncState('pip');
    }
  });
}

// VNC resizing
function setupVncResizing() {
  const resizeHandle = document.querySelector('.vnc-resize-handle');
  let isResizing = false;
  let startMouseX, startMouseY;
  let startWidth, startHeight;

  resizeHandle.addEventListener('mousedown', resizeStart);
  resizeHandle.addEventListener('touchstart', resizeStart, { passive: false });
  document.addEventListener('mousemove', resize);
  document.addEventListener('touchmove', resize, { passive: false });
  document.addEventListener('mouseup', resizeEnd);
  document.addEventListener('touchend', resizeEnd);

  function resizeStart(e) {
    if (vncState !== 'pip') return;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    startMouseX = clientX;
    startMouseY = clientY;
    startWidth = vncViewer.offsetWidth;
    startHeight = vncViewer.offsetHeight;

    isResizing = true;
    vncViewer.classList.add('resizing');
    e.preventDefault();
    e.stopPropagation();
  }

  function resize(e) {
    if (!isResizing) return;
    e.preventDefault();

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const dx = clientX - startMouseX;
    const dy = clientY - startMouseY;

    const newWidth = Math.max(240, startWidth + dx);
    const newHeight = Math.max(180, startHeight + dy);

    vncViewer.style.width = newWidth + 'px';
    vncViewer.style.height = newHeight + 'px';
  }

  function resizeEnd() {
    if (!isResizing) return;
    isResizing = false;
    vncViewer.classList.remove('resizing');
    savePipRect();
  }
}

// ============================
// PWA: Service Worker Registration
// ============================

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then((registration) => {
        console.log('SW registered, scope:', registration.scope);

        // Listen for updates
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated') {
                console.log('New service worker activated');
              }
            });
          }
        });
      })
      .catch((error) => {
        console.error('SW registration failed:', error);
      });
  });
}

// ============================
// PWA: Install Prompt
// ============================

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Prevent the default mini-infobar on Android
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallButton();
});

window.addEventListener('appinstalled', () => {
  console.log('App installed successfully');
  deferredInstallPrompt = null;
  hideInstallButton();
});

function showInstallButton() {
  let installBtn = document.getElementById('installBtn');
  if (!installBtn) {
    installBtn = document.createElement('button');
    installBtn.id = 'installBtn';
    installBtn.className = 'btn-secondary install-btn';
    installBtn.innerHTML = '<span class="install-icon">+</span> Install App';
    installBtn.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      const result = await deferredInstallPrompt.userChoice;
      console.log('Install prompt result:', result.outcome);
      deferredInstallPrompt = null;
      hideInstallButton();
    });

    // Add to sidebar footer, before the MCP Config button
    const sidebarFooter = document.querySelector('.sidebar-footer');
    if (sidebarFooter) {
      sidebarFooter.insertBefore(installBtn, sidebarFooter.firstChild);
    }
  }
  installBtn.style.display = 'block';
}

function hideInstallButton() {
  const installBtn = document.getElementById('installBtn');
  if (installBtn) {
    installBtn.style.display = 'none';
  }
}

// ============================
// PWA: Online/Offline Status
// ============================

const offlineBanner = document.getElementById('offlineBanner');

function updateOnlineStatus() {
  if (!offlineBanner) return;
  if (navigator.onLine) {
    offlineBanner.style.display = 'none';
  } else {
    offlineBanner.style.display = 'flex';
  }
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// Check on load
updateOnlineStatus();

// ============================
// PWA: Standalone Mode Detection
// ============================

const isStandalone = window.matchMedia('(display-mode: standalone)').matches
                  || window.navigator.standalone === true;

if (isStandalone) {
  document.documentElement.classList.add('pwa-standalone');
}

// ============================
// System Status Bar
// ============================

const statusGit = document.getElementById('statusGit');
const statusLoad = document.getElementById('statusLoad');
const statusMem = document.getElementById('statusMem');
const statusQueries = document.getElementById('statusQueries');
const statusUptime = document.getElementById('statusUptime');

let statusInterval = null;
let statusExpanded = false;
const statusExpandedEl = document.getElementById('statusExpanded');
const statusBarEl = document.getElementById('statusBar');

// Tap to toggle expanded panel
statusBarEl.addEventListener('click', () => {
  statusExpanded = !statusExpanded;
  statusExpandedEl.classList.toggle('open', statusExpanded);
  statusBarEl.classList.toggle('expanded', statusExpanded);
});

// Close expanded panel when tapping outside
document.addEventListener('click', (e) => {
  if (statusExpanded && !e.target.closest('.status-bar') && !e.target.closest('.status-expanded')) {
    statusExpanded = false;
    statusExpandedEl.classList.remove('open');
    statusBarEl.classList.remove('expanded');
  }
});

async function fetchSystemStatus() {
  try {
    const res = await fetch('/api/system-status');
    if (!res.ok) return;
    const s = await res.json();

    // --- Compact bar values ---

    const dirty = s.git?.dirty ?? 0;
    const untracked = s.git?.untracked ?? 0;
    const changes = dirty + untracked;
    const branch = s.git?.branch ?? '';
    const loadArr = Array.isArray(s.load) ? s.load : [];
    const load1 = loadArr[0];
    const usedMB = s.mem?.used;
    const totalMB = s.mem?.total;
    const q = s.queries ?? 0;
    const secs = s.uptime;

    // Git
    if (statusGit) {
      statusGit.textContent = `⎇ ${branch}${changes > 0 ? ` +${changes}` : ''}`;
    }

    // CPU load
    if (statusLoad) {
      statusLoad.textContent = `⚡ ${typeof load1 === 'number' ? load1.toFixed(1) : '—'}`;
    }

    // Memory
    if (statusMem && usedMB != null && totalMB != null && totalMB > 0) {
      const pct = Math.round((usedMB / totalMB) * 100);
      statusMem.textContent = `🧠 ${pct}%`;
    }

    // Active queries
    if (statusQueries) {
      statusQueries.textContent = `▶ ${q}`;
    }

    // Uptime
    let uptimeStr = '—';
    if (secs != null) {
      if (secs < 3600) uptimeStr = Math.round(secs / 60) + 'm';
      else if (secs < 86400) uptimeStr = (secs / 3600).toFixed(1) + 'h';
      else uptimeStr = (secs / 86400).toFixed(1) + 'd';
    }
    if (statusUptime) {
      statusUptime.textContent = `⏱ ${uptimeStr}`;
    }

    // --- Expanded panel values ---

    const seGit = document.getElementById('seGit');
    const seLoad = document.getElementById('seLoad');
    const seMem = document.getElementById('seMem');
    const seQueries = document.getElementById('seQueries');
    const seDisk = document.getElementById('seDisk');
    const seUptime = document.getElementById('seUptime');

    if (seGit) {
      let gitDetail = branch || 'unknown';
      if (changes > 0) gitDetail += ` — ${dirty} modified, ${untracked} untracked`;
      else gitDetail += ' — clean';
      seGit.textContent = gitDetail;
    }

    if (seLoad) {
      const l1 = loadArr[0]?.toFixed(2) ?? '—';
      const l5 = loadArr[1]?.toFixed(2) ?? '—';
      const l15 = loadArr[2]?.toFixed(2) ?? '—';
      seLoad.textContent = `${l1} / ${l5} / ${l15}  (1m / 5m / 15m)`;
    }

    if (seMem) {
      if (usedMB != null && totalMB != null && totalMB > 0) {
        const pct = Math.round((usedMB / totalMB) * 100);
        seMem.textContent = `${Math.round(usedMB)} MB / ${Math.round(totalMB)} MB  (${pct}%)`;
      }
    }

    if (seQueries) {
      seQueries.textContent = q === 0 ? 'None' : `${q} running`;
    }

    if (seDisk) {
      seDisk.textContent = s.diskUsage || '—';
    }

    if (seUptime) {
      if (secs != null) {
        const days = Math.floor(secs / 86400);
        const hrs = Math.floor((secs % 86400) / 3600);
        const mins = Math.floor((secs % 3600) / 60);
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hrs > 0) parts.push(`${hrs}h`);
        parts.push(`${mins}m`);
        seUptime.textContent = parts.join(' ');
      }
    }
  } catch (e) {
    // Silently fail — status bar just shows stale data
  }
}

// Poll every 15 seconds
fetchSystemStatus();
statusInterval = setInterval(fetchSystemStatus, 15000);

// ============================
// File Browser Panel
// ============================

const filePanel = document.getElementById('filePanel');
const fileToggleBtn = document.getElementById('fileToggleBtn');
const filePanelClose = document.getElementById('filePanelClose');
const fileBreadcrumb = document.getElementById('fileBreadcrumb');
const fileListEl = document.getElementById('fileList');
const fileUploadInput = document.getElementById('fileUploadInput');

let fileBrowserPath = '.'; // Relative to FILE_ROOT on server
let fileBrowserOpen = false;

// Toggle file panel
fileToggleBtn.addEventListener('click', () => {
  if (fileBrowserOpen) {
    closeFilePanel();
  } else {
    openFilePanel();
  }
});

filePanelClose.addEventListener('click', closeFilePanel);

function openFilePanel() {
  fileBrowserOpen = true;
  filePanel.style.display = 'flex';
  loadDirectory(fileBrowserPath);
}

function closeFilePanel() {
  fileBrowserOpen = false;
  filePanel.style.display = 'none';
}

async function loadDirectory(path) {
  fileBrowserPath = path;
  fileListEl.innerHTML = '<div class="file-loading">Loading...</div>';
  renderBreadcrumb(path);

  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      fileListEl.innerHTML = `<div class="file-empty">Error: ${err.error || res.statusText}</div>`;
      return;
    }
    const data = await res.json();
    renderFileList(data.entries || []);
  } catch (e) {
    fileListEl.innerHTML = `<div class="file-empty">Failed to load: ${e.message}</div>`;
  }
}

function renderBreadcrumb(path) {
  // Split path into segments
  const parts = path === '.' ? ['~'] : ['~', ...path.split('/').filter(Boolean)];
  const pathParts = path === '.' ? ['.'] : ['.'];

  // Build cumulative paths
  if (path !== '.') {
    const segs = path.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      pathParts.push(segs.slice(0, i + 1).join('/'));
    }
  }

  fileBreadcrumb.innerHTML = parts.map((part, i) => {
    const isLast = i === parts.length - 1;
    const sep = i > 0 ? '<span class="breadcrumb-sep">›</span>' : '';
    const cls = isLast ? 'breadcrumb-item current' : 'breadcrumb-item';
    return `${sep}<span class="${cls}" data-path="${pathParts[i]}">${escapeHtml(part)}</span>`;
  }).join('');

  // Click handlers for breadcrumb navigation
  fileBreadcrumb.querySelectorAll('.breadcrumb-item:not(.current)').forEach(el => {
    el.addEventListener('click', () => loadDirectory(el.dataset.path));
  });
}

function renderFileList(entries) {
  if (entries.length === 0) {
    fileListEl.innerHTML = '<div class="file-empty">Empty directory</div>';
    return;
  }

  // Sort: directories first, then by name
  entries.sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });

  fileListEl.innerHTML = entries.map(entry => {
    const icon = entry.isDir ? '📁' : getFileIcon(entry.name);
    const size = entry.isDir ? '' : formatFileSize(entry.size);
    const entryPath = fileBrowserPath === '.' ? entry.name : `${fileBrowserPath}/${entry.name}`;

    let actions = '';
    if (!entry.isDir) {
      actions = `
        <div class="file-item-actions">
          <button class="file-action-btn download" data-path="${escapeHtml(entryPath)}" title="Download">⬇</button>
          <button class="file-action-btn delete" data-path="${escapeHtml(entryPath)}" data-name="${escapeHtml(entry.name)}" title="Delete">✕</button>
        </div>`;
    }

    return `
      <div class="file-item" data-path="${escapeHtml(entryPath)}" data-dir="${entry.isDir}">
        <span class="file-item-icon">${icon}</span>
        <span class="file-item-name">${escapeHtml(entry.name)}</span>
        <span class="file-item-size">${size}</span>
        ${actions}
      </div>`;
  }).join('');

  // Click handlers
  fileListEl.querySelectorAll('.file-item').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't navigate if clicking an action button
      if (e.target.closest('.file-action-btn')) return;

      if (el.dataset.dir === 'true') {
        loadDirectory(el.dataset.path);
      } else {
        // Open file in viewer/editor
        openFileViewer(el.dataset.path);
      }
    });
  });

  // Download buttons
  fileListEl.querySelectorAll('.file-action-btn.download').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadFile(btn.dataset.path);
    });
  });

  // Delete buttons
  fileListEl.querySelectorAll('.file-action-btn.delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFile(btn.dataset.path, btn.dataset.name);
    });
  });
}

function downloadFile(path) {
  const url = `/api/files/download?path=${encodeURIComponent(path)}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = path.split('/').pop();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function deleteFile(path, name) {
  if (!confirm(`Delete "${name}"?`)) return;

  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (res.ok) {
      // Reload current directory
      loadDirectory(fileBrowserPath);
      showToast(`Deleted ${name}`, 2000);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(`Delete failed: ${err.error || 'Unknown error'}`, 3000);
    }
  } catch (e) {
    showToast(`Delete failed: ${e.message}`, 3000);
  }
}

// File upload
fileUploadInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  const formData = new FormData();
  formData.append('path', fileBrowserPath);
  files.forEach(f => formData.append('files', f));

  try {
    showToast(`Uploading ${files.length} file(s)...`, 2000);
    const res = await fetch('/api/files/upload', {
      method: 'POST',
      body: formData,
    });

    if (res.ok) {
      const data = await res.json();
      showToast(`Uploaded ${data.count} file(s)`, 3000);
      loadDirectory(fileBrowserPath);
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(`Upload failed: ${err.error || 'Unknown error'}`, 3000);
    }
  } catch (err) {
    showToast(`Upload failed: ${err.message}`, 3000);
  }

  // Reset input
  e.target.value = '';
});

// ============================
// File Viewer / Editor
// ============================

const fvModal = document.getElementById('fileViewerModal');
const fvFileName = document.getElementById('fvFileName');
const fvBody = document.getElementById('fvBody');
const fvSaveBtn = document.getElementById('fvSaveBtn');
const fvCloseBtn = document.getElementById('fvCloseBtn');
const fvStatus = document.getElementById('fvStatus');

let fvCurrentPath = null;
let fvOriginalContent = null;
let fvModified = false;

fvCloseBtn.addEventListener('click', closeFileViewer);
fvSaveBtn.addEventListener('click', saveFileContent);

// Keyboard shortcut: Ctrl/Cmd+S to save
document.addEventListener('keydown', (e) => {
  if (fvModal.style.display !== 'none' && (e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (fvModified) saveFileContent();
  }
});

function openFileViewer(path) {
  fvCurrentPath = path;
  fvModified = false;
  fvOriginalContent = null;
  const name = path.split('/').pop();
  fvFileName.textContent = name;
  fvStatus.textContent = '';
  fvStatus.className = 'fv-status';
  fvSaveBtn.style.display = 'none';
  fvBody.innerHTML = '<div class="fv-info"><span class="fv-info-text">Loading...</span></div>';
  fvModal.style.display = 'flex';

  loadFileContent(path);
}

function closeFileViewer() {
  if (fvModified) {
    if (!confirm('You have unsaved changes. Close anyway?')) return;
  }
  fvModal.style.display = 'none';
  fvBody.innerHTML = '';
  fvCurrentPath = null;
  fvOriginalContent = null;
  fvModified = false;
}

async function loadFileContent(path) {
  try {
    const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      fvBody.innerHTML = `<div class="fv-info"><span class="fv-info-icon">❌</span><span class="fv-info-text">${escapeHtml(err.error || 'Failed to load file')}</span></div>`;
      return;
    }

    const data = await res.json();
    const ext = path.split('.').pop().toLowerCase();

    switch (data.type) {
      case 'text':
        renderTextEditor(data.content, data.size, ext);
        break;
      case 'image':
        renderImageViewer(path, data.size);
        break;
      case 'video':
        renderVideoViewer(path, data.mime, data.size);
        break;
      case 'audio':
        renderAudioViewer(path, data.size);
        break;
      case 'binary':
      default:
        renderBinaryInfo(data.size, data.reason);
        break;
    }
  } catch (e) {
    fvBody.innerHTML = `<div class="fv-info"><span class="fv-info-icon">❌</span><span class="fv-info-text">${escapeHtml(e.message)}</span></div>`;
  }
}

function renderTextEditor(content, size, ext) {
  fvOriginalContent = content;
  fvSaveBtn.style.display = 'flex';
  fvSaveBtn.disabled = true;

  const lines = content.split('\n').length;
  fvStatus.textContent = `${lines} lines · ${formatFileSize(size)}`;

  const textarea = document.createElement('textarea');
  textarea.className = 'fv-editor';
  textarea.value = content;
  textarea.spellcheck = false;
  textarea.autocapitalize = 'off';
  textarea.autocomplete = 'off';

  // Handle tab key for indentation
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      markModified();
    }
  });

  // Track modifications
  textarea.addEventListener('input', () => {
    const isChanged = textarea.value !== fvOriginalContent;
    if (isChanged && !fvModified) {
      markModified();
    } else if (!isChanged && fvModified) {
      fvModified = false;
      fvSaveBtn.disabled = true;
      fvStatus.textContent = `${textarea.value.split('\n').length} lines · ${formatFileSize(size)}`;
      fvStatus.className = 'fv-status';
    }
  });

  fvBody.innerHTML = '';
  fvBody.appendChild(textarea);
  textarea.focus();
}

function markModified() {
  fvModified = true;
  fvSaveBtn.disabled = false;
  fvStatus.textContent = 'Modified';
  fvStatus.className = 'fv-status modified';
}

async function saveFileContent() {
  const textarea = fvBody.querySelector('.fv-editor');
  if (!textarea || !fvCurrentPath) return;

  fvSaveBtn.disabled = true;
  fvStatus.textContent = 'Saving...';
  fvStatus.className = 'fv-status';

  try {
    const res = await fetch('/api/files/write', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fvCurrentPath, content: textarea.value }),
    });

    if (res.ok) {
      const data = await res.json();
      fvOriginalContent = textarea.value;
      fvModified = false;
      fvSaveBtn.disabled = true;
      const lines = textarea.value.split('\n').length;
      fvStatus.textContent = `Saved · ${lines} lines · ${formatFileSize(data.size)}`;
      fvStatus.className = 'fv-status saved';

      // Reset status text after a moment
      setTimeout(() => {
        if (!fvModified && fvModal.style.display !== 'none') {
          fvStatus.textContent = `${lines} lines · ${formatFileSize(data.size)}`;
          fvStatus.className = 'fv-status';
        }
      }, 2000);
    } else {
      const err = await res.json().catch(() => ({}));
      fvStatus.textContent = `Save failed: ${err.error || 'Unknown error'}`;
      fvStatus.className = 'fv-status modified';
      fvSaveBtn.disabled = false;
    }
  } catch (e) {
    fvStatus.textContent = `Save failed: ${e.message}`;
    fvStatus.className = 'fv-status modified';
    fvSaveBtn.disabled = false;
  }
}

function renderImageViewer(path, size) {
  fvStatus.textContent = formatFileSize(size);

  const container = document.createElement('div');
  container.className = 'fv-image-container';

  const img = document.createElement('img');
  img.className = 'fv-image';
  img.src = `/api/files/raw?path=${encodeURIComponent(path)}`;
  img.alt = path.split('/').pop();

  // Click to toggle zoom
  img.addEventListener('click', () => {
    img.classList.toggle('zoomed');
  });

  container.appendChild(img);
  fvBody.innerHTML = '';
  fvBody.appendChild(container);
}

function renderVideoViewer(path, mime, size) {
  fvStatus.textContent = formatFileSize(size);

  const container = document.createElement('div');
  container.className = 'fv-video-container';

  const video = document.createElement('video');
  video.className = 'fv-video';
  video.controls = true;
  video.preload = 'metadata';

  const source = document.createElement('source');
  source.src = `/api/files/raw?path=${encodeURIComponent(path)}`;
  source.type = mime;
  video.appendChild(source);

  container.appendChild(video);
  fvBody.innerHTML = '';
  fvBody.appendChild(container);
}

function renderAudioViewer(path, size) {
  fvStatus.textContent = formatFileSize(size);

  const container = document.createElement('div');
  container.className = 'fv-audio-container';

  const icon = document.createElement('div');
  icon.className = 'fv-audio-icon';
  icon.textContent = '🎵';

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = `/api/files/raw?path=${encodeURIComponent(path)}`;

  container.appendChild(icon);
  container.appendChild(audio);
  fvBody.innerHTML = '';
  fvBody.appendChild(container);
}

function renderBinaryInfo(size, reason) {
  fvBody.innerHTML = `
    <div class="fv-info">
      <span class="fv-info-icon">📦</span>
      <span class="fv-info-text">${reason || 'Binary file — cannot be edited'}</span>
      <span class="fv-info-size">${formatFileSize(size)}</span>
      <button class="fv-btn" onclick="downloadFile(fvCurrentPath)" style="margin-top: 0.5rem;">⬇ Download</button>
    </div>`;
}

// Helper: file icon by extension
function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    js: '📜', ts: '📜', jsx: '📜', tsx: '📜', mjs: '📜',
    json: '📋', yaml: '📋', yml: '📋', toml: '📋',
    md: '📝', txt: '📝', log: '📝',
    html: '🌐', css: '🎨', svg: '🎨',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', ico: '🖼️',
    pdf: '📄', doc: '📄', docx: '📄',
    zip: '📦', tar: '📦', gz: '📦', tgz: '📦',
    sh: '⚙️', bash: '⚙️', zsh: '⚙️',
    py: '🐍', rb: '💎', go: '🐹', rs: '🦀',
    sql: '🗃️', db: '🗃️', sqlite: '🗃️',
    lock: '🔒',
  };
  return icons[ext] || '📄';
}

// Helper: format file size
function formatFileSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'M';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G';
}
