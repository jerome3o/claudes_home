// ============================
// Webtop Detection — block app from loading inside the VNC desktop
// ============================
// The webtop runs Linux x86_64 Chrome. Your phone runs Android.
// If we detect a desktop Linux UA without Android, show a blocker.
(function() {
  const ua = navigator.userAgent;
  const isLinuxDesktop = ua.includes('Linux') && ua.includes('X11') && !ua.includes('Android');
  // Also check if running inside the webtop by looking at screen size typical of VNC
  // and the absence of touch support combined with Linux desktop
  if (isLinuxDesktop) {
    document.documentElement.innerHTML = `
      <body style="background:#0f0f0f;color:#fff;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:2rem;">
        <div>
          <div style="font-size:3rem;margin-bottom:1rem;">🚫</div>
          <h2 style="margin:0 0 0.5rem">This app is for mobile devices</h2>
          <p style="color:#888;font-size:0.9rem;">Please use your phone to access Claude.<br>This browser appears to be inside the webtop container.</p>
        </div>
      </body>`;
    throw new Error('Blocked: running inside webtop');
  }
})();

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
let sessionQueryStates = {}; // { sessionId: boolean } — tracks active queries per session

// Pagination state
const PAGE_SIZE = 50;
let paginationState = {
  totalCount: 0,
  loadedCount: 0,
  hasMore: false,
  isLoadingMore: false,
  useEvents: true, // whether the session uses events or legacy messages endpoint
};

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
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
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

  // Restore session: explicit refresh override > localStorage persist > first session
  const refreshRestore = sessionStorage.getItem('claude_restore_session');
  sessionStorage.removeItem('claude_restore_session');
  const lastActiveId = refreshRestore || localStorage.getItem('claude_active_session');

  if (lastActiveId && sessions.find(s => s.id === lastActiveId)) {
    selectSession(lastActiveId);
  } else if (sessions.length === 0) {
    await createSession('New Session');
  } else {
    selectSession(sessions[0].id);
  }
}

function setupEventListeners() {
  menuBtn.addEventListener('click', () => sidebar.classList.add('open'));
  closeSidebar.addEventListener('click', () => sidebar.classList.remove('open'));

  // Close sidebar when tapping/clicking the backdrop overlay (mobile)
  sidebarBackdrop.addEventListener('click', () => sidebar.classList.remove('open'));

  const newSessionForm = document.getElementById('newSessionForm');
  const newSessionNameInput = document.getElementById('newSessionName');
  const newSessionFolderInput = document.getElementById('newSessionFolder');
  const newSessionCreateBtn = document.getElementById('newSessionCreate');
  const newSessionCancelBtn = document.getElementById('newSessionCancel');

  newSessionBtn.addEventListener('click', () => {
    newSessionNameInput.value = `Session ${sessions.length + 1}`;
    newSessionFolderInput.value = '';
    newSessionForm.style.display = newSessionForm.style.display === 'none' ? 'block' : 'none';
    if (newSessionForm.style.display === 'block') {
      newSessionNameInput.focus();
      newSessionNameInput.select();
    }
  });

  newSessionCreateBtn.addEventListener('click', async () => {
    const name = newSessionNameInput.value.trim() || `Session ${sessions.length + 1}`;
    const folder = newSessionFolderInput.value.trim() || null;
    await createSession(name, folder);
    newSessionForm.style.display = 'none';
    sidebar.classList.remove('open');
  });

  newSessionCancelBtn.addEventListener('click', () => {
    newSessionForm.style.display = 'none';
  });

  newSessionNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') newSessionCreateBtn.click();
    if (e.key === 'Escape') newSessionCancelBtn.click();
  });

  newSessionFolderInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') newSessionCreateBtn.click();
    if (e.key === 'Escape') newSessionCancelBtn.click();
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

  // Infinite scroll — load older messages when scrolling near top
  messages.addEventListener('scroll', () => {
    if (messages.scrollTop < 200 && paginationState.hasMore && !paginationState.isLoadingMore) {
      loadOlderMessages();
    }
  });

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
  if (data.sessionId && data.sessionId !== currentSessionId && data.type !== 'session_notification' && data.type !== 'session_query_state') {
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
      handleSdkEvent(data.event, data.timestamp);
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

    case 'session_renamed': {
      // Update session name in sidebar and title when an agent renames itself
      const renamedSession = sessions.find(s => s.id === data.sessionId);
      if (renamedSession) {
        renamedSession.name = data.name;
        renderSessions();
        if (data.sessionId === currentSessionId) {
          sessionTitle.textContent = data.name;
        }
      }
      break;
    }

    case 'session_query_state':
      sessionQueryStates[data.sessionId] = data.active;
      renderSessions();
      break;
  }
}

function handleSdkEvent(event, timestamp = null) {
  console.log('SDK event:', event);

  switch (event.type) {
    case 'system':
      handleSystemEvent(event);
      break;

    case 'assistant':
      // First assistant message = Claude is responding, clear "Starting Claude..."
      clearMsgStatus();
      updateConnectionStatus('querying', 'responding');
      handleAssistantMessage(event, timestamp);
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

function handleAssistantMessage(event, timestamp = null) {
  const content = event.message.content;

  for (const block of content) {
    if (block.type === 'text') {
      addMessage('assistant', block.text, null, true, timestamp); // Enable markdown
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
function addMessage(role, content, status = null, useMarkdown = false, timestamp = null) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message';

  const date = timestamp ? new Date(timestamp) : new Date();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

function addSystemMessage(htmlContent, timestamp = null) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message';

  const date = timestamp ? new Date(timestamp) : new Date();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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
    sessions.forEach(s => { sessionQueryStates[s.id] = s.activeQuery || false; });
    renderSessions();
  } catch (error) {
    console.error('Failed to load sessions:', error);
  }
}

function groupSessionsByPrefix(sessions) {
  const groups = {};
  const ungrouped = [];

  for (const session of sessions) {
    const slashIndex = session.name.indexOf('/');
    if (slashIndex > 0 && slashIndex < 20) {
      const prefix = session.name.substring(0, slashIndex);
      if (!groups[prefix]) groups[prefix] = [];
      groups[prefix].push(session);
    } else {
      ungrouped.push(session);
    }
  }

  return { groups, ungrouped };
}

function renderSessionItem(session) {
  const isActive = sessionQueryStates[session.id];
  const unreadCount = unreadCounts[session.id] || 0;
  const unreadClass = unreadCount > 0 ? ' has-unread' : '';

  // Strip prefix for display if it has a folder
  const slashIndex = session.name.indexOf('/');
  const displayName = (slashIndex > 0 && slashIndex < 20)
    ? session.name.substring(slashIndex + 1)
    : session.name;

  const timeStr = new Date(session.lastActive).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const statusHtml = isActive
    ? '<span class="session-activity-dot"></span><span class="session-status-working">Working...</span>'
    : `<span class="session-time">${timeStr}</span>`;

  return `
    <div class="session-item compact ${session.id === currentSessionId ? 'active' : ''}${unreadClass}"
         data-id="${session.id}">
      <div class="session-info-compact">
        <span class="session-name-compact" title="${escapeHtml(session.name)}">${escapeHtml(displayName)}</span>
        ${statusHtml}
      </div>
      <div class="session-actions">
        <button class="session-action-btn session-rename-btn" data-id="${session.id}" title="Rename">✏️</button>
        <button class="session-action-btn session-delete-btn" data-id="${session.id}" title="Delete">✕</button>
      </div>
      ${unreadCount > 0 ? `<span class="unread-badge">${unreadCount > 9 ? '9+' : unreadCount}</span>` : ''}
    </div>`;
}

function renderSessions() {
  // Sort: active queries first, then by recency
  const sortedSessions = [...sessions].sort((a, b) => {
    const aActive = sessionQueryStates[a.id] ? 1 : 0;
    const bActive = sessionQueryStates[b.id] ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return b.lastActive - a.lastActive;
  });

  const { groups, ungrouped } = groupSessionsByPrefix(sortedSessions);

  // Get collapsed state from localStorage
  const collapsedFolders = JSON.parse(localStorage.getItem('collapsedFolders') || '{}');

  let html = '';

  // Render ungrouped sessions first (no folder header)
  if (ungrouped.length > 0) {
    const activeCount = ungrouped.filter(s => sessionQueryStates[s.id]).length;
    html += `<div class="session-folder-header" data-folder="__ungrouped">
      <span class="folder-chevron">${collapsedFolders['__ungrouped'] ? '▸' : '▾'}</span>
      <span class="folder-name">Sessions</span>
      <span class="folder-count">${ungrouped.length}</span>
      ${activeCount > 0 ? `<span class="folder-active-badge">${activeCount} active</span>` : ''}
    </div>`;
    if (!collapsedFolders['__ungrouped']) {
      html += ungrouped.map(s => renderSessionItem(s)).join('');
    }
  }

  // Render grouped sessions
  const sortedPrefixes = Object.keys(groups).sort();
  for (const prefix of sortedPrefixes) {
    const folderSessions = groups[prefix];
    const activeCount = folderSessions.filter(s => sessionQueryStates[s.id]).length;
    const isCollapsed = collapsedFolders[prefix];

    html += `<div class="session-folder-header" data-folder="${escapeHtml(prefix)}">
      <span class="folder-chevron">${isCollapsed ? '▸' : '▾'}</span>
      <span class="folder-name">${escapeHtml(prefix)}/</span>
      <span class="folder-count">${folderSessions.length}</span>
      ${activeCount > 0 ? `<span class="folder-active-badge">${activeCount} active</span>` : ''}
    </div>`;
    if (!isCollapsed) {
      html += folderSessions.map(s => renderSessionItem(s)).join('');
    }
  }

  sessionList.innerHTML = html;

  // Add click listeners for selecting sessions
  document.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.session-action-btn')) return;
      const id = item.dataset.id;
      selectSession(id);
      sidebar.classList.remove('open');
    });
  });

  // Add click handlers for folder headers (toggle collapse)
  document.querySelectorAll('.session-folder-header').forEach(el => {
    el.addEventListener('click', () => {
      const folder = el.dataset.folder;
      const collapsed = JSON.parse(localStorage.getItem('collapsedFolders') || '{}');
      collapsed[folder] = !collapsed[folder];
      localStorage.setItem('collapsedFolders', JSON.stringify(collapsed));
      renderSessions();
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

  // Persist active session so it survives app backgrounding / PWA reload
  try { localStorage.setItem('claude_active_session', sessionId); } catch(e) {}

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
  // Reset pagination state
  paginationState = { totalCount: 0, loadedCount: 0, hasMore: false, isLoadingMore: false, useEvents: true };
  removeLoadMoreIndicator();

  try {
    // Try loading from new sdk_events endpoint first (with pagination)
    const eventsRes = await fetch(`/api/sessions/${sessionId}/events?limit=${PAGE_SIZE}`);
    const eventsData = await eventsRes.json();

    if (seq !== null && seq !== selectSessionSeq) {
      console.log('Stale session history response — user switched sessions');
      return;
    }

    if (eventsData.sdkSessionId) {
      currentSdkSessionId = eventsData.sdkSessionId;
    }

    if (eventsData.events && eventsData.events.length > 0) {
      paginationState.useEvents = true;
      paginationState.totalCount = eventsData.total_count || eventsData.events.length;
      paginationState.loadedCount = eventsData.events.length;
      paginationState.hasMore = eventsData.has_more || false;

      _suppressAutoScroll = true;
      renderPersistedEvents(eventsData.events);
      _suppressAutoScroll = false;
      scrollToBottomInstant();

      if (paginationState.hasMore) {
        showLoadMoreIndicator();
      }
      return;
    }

    // Fallback: load from old messages endpoint (for pre-migration sessions)
    const response = await fetch(`/api/sessions/${sessionId}/messages?limit=${PAGE_SIZE}`);
    const data = await response.json();

    if (seq !== null && seq !== selectSessionSeq) {
      console.log('Stale session history response — user switched sessions');
      return;
    }

    if (data.sdkSessionId) {
      currentSdkSessionId = data.sdkSessionId;
    }

    if (data.messages && data.messages.length > 0) {
      paginationState.useEvents = false;
      paginationState.totalCount = data.total_count || data.messages.length;
      paginationState.loadedCount = data.messages.length;
      paginationState.hasMore = data.has_more || false;

      _suppressAutoScroll = true;
      data.messages.forEach(msg => {
        addMessage(msg.role, msg.content, msg.status, msg.useMarkdown, msg.timestamp);
      });
      _suppressAutoScroll = false;
      scrollToBottomInstant();

      if (paginationState.hasMore) {
        showLoadMoreIndicator();
      }
    }
  } catch (error) {
    console.error('Failed to load session history:', error);
  }
}

// Load older messages when scrolling up (pagination)
async function loadOlderMessages() {
  if (!currentSessionId || paginationState.isLoadingMore || !paginationState.hasMore) return;

  paginationState.isLoadingMore = true;
  const indicator = messages.querySelector('.load-more-indicator');
  if (indicator) indicator.textContent = 'Loading older messages...';

  // Calculate offset: we need to load the batch BEFORE what we already have
  // totalCount - loadedCount gives us how many older messages exist
  // We want to load from the end of the remaining older messages
  const remaining = paginationState.totalCount - paginationState.loadedCount;
  const batchSize = Math.min(PAGE_SIZE, remaining);
  const offset = remaining - batchSize;

  try {
    const endpoint = paginationState.useEvents ? 'events' : 'messages';
    const res = await fetch(`/api/sessions/${currentSessionId}/${endpoint}?limit=${batchSize}&offset=${offset}`);
    const data = await res.json();

    // Bail if user switched sessions
    if (!currentSessionId) return;

    // Save scroll position before prepending
    const prevScrollHeight = messages.scrollHeight;
    const prevScrollTop = messages.scrollTop;

    _suppressAutoScroll = true;

    // Create a document fragment to batch-prepend
    const fragment = document.createDocumentFragment();

    if (paginationState.useEvents && data.events) {
      // Render events into fragment by temporarily swapping the messages container
      const tempContainer = document.createElement('div');
      const realContainer = messages;
      // Temporarily replace messages reference isn't possible since it's const,
      // so we render then move nodes
      renderPersistedEventsInto(data.events, tempContainer);
      while (tempContainer.firstChild) {
        fragment.appendChild(tempContainer.firstChild);
      }
      paginationState.loadedCount += data.events.length;
    } else if (data.messages) {
      data.messages.forEach(msg => {
        const messageDiv = createMessageElement(msg.role, msg.content, msg.status, msg.useMarkdown, msg.timestamp);
        fragment.appendChild(messageDiv);
      });
      paginationState.loadedCount += data.messages.length;
    }

    // Insert older messages at the top (after the load-more indicator if present)
    const firstMessage = messages.querySelector('.message, .tool-block');
    if (firstMessage) {
      messages.insertBefore(fragment, firstMessage);
    } else {
      messages.appendChild(fragment);
    }

    _suppressAutoScroll = false;

    // Restore scroll position so it doesn't jump
    const newScrollHeight = messages.scrollHeight;
    messages.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);

    // Update pagination state
    paginationState.hasMore = offset > 0;

    if (!paginationState.hasMore) {
      removeLoadMoreIndicator();
    } else if (indicator) {
      indicator.textContent = 'Scroll up for older messages';
    }
  } catch (error) {
    console.error('Failed to load older messages:', error);
    if (indicator) indicator.textContent = 'Failed to load — scroll up to retry';
  } finally {
    paginationState.isLoadingMore = false;
  }
}

function showLoadMoreIndicator() {
  removeLoadMoreIndicator();
  const indicator = document.createElement('div');
  indicator.className = 'load-more-indicator';
  indicator.textContent = 'Scroll up for older messages';
  messages.prepend(indicator);
}

function removeLoadMoreIndicator() {
  const existing = messages.querySelector('.load-more-indicator');
  if (existing) existing.remove();
}

// Create a message DOM element without appending it (used by pagination)
function createMessageElement(role, content, status = null, useMarkdown = false, timestamp = null) {
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message';

  const date = timestamp ? new Date(timestamp) : new Date();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let statusClass = '';
  if (status === 'error') statusClass = 'error';
  else if (status === 'success') statusClass = 'success';

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

  return messageDiv;
}

// Render persisted events into a target container (for pagination prepend)
function renderPersistedEventsInto(events, container) {
  for (const evt of events) {
    const event = evt.event_data;
    const ts = evt.timestamp;

    switch (evt.event_type) {
      case 'user':
        if (event.message) {
          const content = typeof event.message.content === 'string'
            ? event.message.content
            : (Array.isArray(event.message.content)
              ? event.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
              : String(event.message.content));
          if (content) {
            container.appendChild(createMessageElement('user', content, null, false, ts));
          }
        }
        break;

      case 'assistant':
        if (event.message && event.message.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              container.appendChild(createMessageElement('assistant', block.text, null, true, ts));
            } else if (block.type === 'tool_use') {
              container.appendChild(createToolUseElement(block));
            }
          }
        }
        break;

      case 'result':
        if (event.subtype === 'success') {
          const stats = `<span style="font-size:0.7rem;color:var(--text-tertiary)">${event.num_turns} turns · $${event.total_cost_usd?.toFixed(4) || '?'} · ${event.usage?.input_tokens || '?'}↓ ${event.usage?.output_tokens || '?'}↑</span>`;
          const msgDiv = document.createElement('div');
          msgDiv.className = 'message';
          const date = ts ? new Date(ts) : new Date();
          const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          msgDiv.innerHTML = `<div class="message-header"><span class="message-role system">system</span><span class="message-time">${time}</span></div><div class="message-content">${stats}</div>`;
          container.appendChild(msgDiv);
        } else if (event.subtype && event.subtype.startsWith('error_')) {
          const errorMsg = event.error || event.subtype;
          container.appendChild(createMessageElement('system', `Error: ${errorMsg}`, 'error', false, ts));
        }
        break;
    }
  }
}

// Create a tool-use DOM element without appending (for pagination prepend)
function createToolUseElement(toolUse) {
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

  toolDiv.querySelector('.tool-header').addEventListener('click', () => {
    toolDiv.classList.toggle('expanded');
  });

  return toolDiv;
}

// Render persisted SDK events from the events API
function renderPersistedEvents(events) {
  for (const evt of events) {
    const event = evt.event_data;
    const ts = evt.timestamp;

    switch (evt.event_type) {
      case 'user':
        if (event.message) {
          const content = typeof event.message.content === 'string'
            ? event.message.content
            : (Array.isArray(event.message.content)
              ? event.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
              : String(event.message.content));
          if (content) {
            addMessage('user', content, null, true, ts);
          }
        }
        break;

      case 'assistant':
        if (event.message && event.message.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              addMessage('assistant', block.text, null, true, ts);
            } else if (block.type === 'tool_use') {
              addToolUse(block);
            } else if (block.type === 'tool_result') {
              addToolResult(block);
            }
          }
        }
        break;

      case 'result':
        if (event.subtype === 'success') {
          const stats = `<span style="font-size:0.7rem;color:var(--text-tertiary)">${event.num_turns} turns · $${event.total_cost_usd?.toFixed(4) || '?'} · ${event.usage?.input_tokens || '?'}↓ ${event.usage?.output_tokens || '?'}↑</span>`;
          addSystemMessage(stats, ts);
        } else if (event.subtype && event.subtype.startsWith('error_')) {
          const errorMsg = event.errors?.join('\n') || 'Unknown error';
          addMessage('system', `Error: ${errorMsg}`, 'error', false, ts);
        }
        break;

      case 'system':
        if (event.subtype === 'init' && event.session_id) {
          currentSdkSessionId = event.session_id;
          if (event.mcp_servers && event.mcp_servers.length > 0) {
            const statusHtml = '<div class="mcp-status-bar">' +
              event.mcp_servers.map(server => {
                const dotClass = server.status === 'connected' ? '' : (server.status === 'connecting' ? 'pending' : 'error');
                return `<span class="mcp-status-item"><span class="status-dot ${dotClass}"></span>${escapeHtml(server.name)}</span>`;
              }).join('') +
              '</div>';
            addSystemMessage(statusHtml, ts);
          }
        }
        break;

      default:
        break;
    }
  }
}

// Render a tool result block (from persisted events)
function addToolResult(block) {
  const resultDiv = document.createElement('div');
  resultDiv.className = 'tool-block tool-result-block';

  let resultContent = '';
  if (block.content) {
    if (typeof block.content === 'string') {
      resultContent = block.content;
    } else if (Array.isArray(block.content)) {
      resultContent = block.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
  }

  const displayContent = resultContent.length > 500
    ? resultContent.substring(0, 500) + '... (truncated)'
    : resultContent;

  resultDiv.innerHTML = `
    <div class="tool-header">
      <span class="tool-icon">${block.is_error ? '❌' : '✅'}</span>
      <span class="tool-name">Result${block.is_error ? ' (error)' : ''}</span>
      <span class="tool-expand-icon">▼</span>
    </div>
    <div class="tool-content">${escapeHtml(displayContent)}</div>
  `;

  resultDiv.querySelector('.tool-header').addEventListener('click', () => {
    resultDiv.classList.toggle('expanded');
  });

  messages.appendChild(resultDiv);
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
    displayContent = thumbsHtml + (text ? marked.parse(text, { breaks: true }) : '');
    addMessageHtml('user', displayContent);
  } else {
    addMessage('user', text, null, true);
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

// ---- Smart scroll helpers ----
// When true, scrollToBottom() becomes a no-op.
// Used during bulk history loading so we don't scroll on every message.
let _suppressAutoScroll = false;

// Threshold (px) — if the user is within this distance of the bottom
// we consider them "anchored" and will auto-scroll on new content.
const SCROLL_ANCHOR_THRESHOLD = 150;

function isUserNearBottom() {
  const { scrollTop, scrollHeight, clientHeight } = messages;
  return scrollHeight - scrollTop - clientHeight <= SCROLL_ANCHOR_THRESHOLD;
}

function scrollToBottom() {
  if (_suppressAutoScroll) return;
  if (isUserNearBottom()) {
    requestAnimationFrame(() => {
      messages.scrollTop = messages.scrollHeight;
    });
  }
  // Otherwise do nothing — user is reading history, don't yank them away.
}

// Jump to bottom instantly & unconditionally (e.g. after loading history).
function scrollToBottomInstant() {
  messages.scrollTop = messages.scrollHeight;
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

// ============================
// Scheduled Tasks Management
// ============================

const taskEditorModal = document.getElementById('taskEditorModal');
const taskRunsModal = document.getElementById('taskRunsModal');
const taskList = document.getElementById('taskList');
const newTaskBtn = document.getElementById('newTaskBtn');

let scheduledTasks = [];
let editingTaskId = null; // null = creating new task

// Initialize task management
async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    scheduledTasks = await res.json();
    renderTaskList();
  } catch (e) {
    console.error('Failed to load tasks:', e);
  }
}

function renderTaskList() {
  if (!taskList) return;

  if (scheduledTasks.length === 0) {
    taskList.innerHTML = '<div class="task-list-empty">No scheduled tasks</div>';
    return;
  }

  taskList.innerHTML = scheduledTasks.map(task => {
    const dotClass = task.enabled ? 'enabled' : 'disabled';
    const typeIcon = task.type === 'webhook' ? '🔗' : '⏰';
    return `
      <div class="task-list-item" data-id="${task.id}">
        <span class="task-status-dot ${dotClass}"></span>
        <span class="task-item-name">${typeIcon} ${escapeHtml(task.name)}</span>
      </div>`;
  }).join('');

  taskList.querySelectorAll('.task-list-item').forEach(el => {
    el.addEventListener('click', () => openTaskEditor(el.dataset.id));
  });
}

// Task Editor
if (newTaskBtn) {
  newTaskBtn.addEventListener('click', () => openTaskEditor(null));
}

function openTaskEditor(taskId) {
  editingTaskId = taskId;
  const modal = taskEditorModal;
  if (!modal) return;

  const title = document.getElementById('taskEditorTitle');
  const nameInput = document.getElementById('teTaskName');
  const cronExpr = document.getElementById('teCronExpr');
  const timezone = document.getElementById('teTimezone');
  const webhookPath = document.getElementById('teWebhookPath');
  const webhookSecret = document.getElementById('teWebhookSecret');
  const prompt = document.getElementById('tePrompt');
  const sessionId = document.getElementById('teSessionId');
  const model = document.getElementById('teModel');
  const maxTurns = document.getElementById('teMaxTurns');
  const maxBudget = document.getElementById('teMaxBudget');
  const enabled = document.getElementById('teEnabled');
  const deleteBtn = document.getElementById('teDeleteBtn');
  const runNowBtn = document.getElementById('teRunNowBtn');
  const viewRunsBtn = document.getElementById('teViewRunsBtn');

  // Populate session dropdown
  sessionId.innerHTML = '<option value="">Select a session...</option>' +
    sessions.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');

  if (taskId) {
    // Editing existing task
    const task = scheduledTasks.find(t => t.id === taskId);
    if (!task) return;

    title.textContent = 'Edit Task';
    nameInput.value = task.name;
    cronExpr.value = task.cron_expression || '';
    timezone.value = task.timezone || 'UTC';
    webhookPath.value = task.webhook_path || '';
    webhookSecret.value = task.webhook_secret || '';
    prompt.value = task.prompt;
    sessionId.value = task.session_id || '';
    model.value = task.model || 'sonnet';
    maxTurns.value = task.max_turns || 10;
    maxBudget.value = task.max_budget_usd || 5.0;
    enabled.checked = !!task.enabled;

    // Set type toggle
    setToggle('cron', 'webhook', task.type === 'webhook');
    // Set mode toggle
    setToggle('new', 'reuse', task.session_mode === 'reuse');

    deleteBtn.style.display = 'block';
    runNowBtn.style.display = 'block';
    viewRunsBtn.style.display = 'block';
  } else {
    // Creating new task
    title.textContent = 'New Task';
    nameInput.value = '';
    cronExpr.value = '';
    timezone.value = 'Europe/London';
    webhookPath.value = '';
    webhookSecret.value = '';
    prompt.value = '';
    sessionId.value = '';
    model.value = 'opus';
    maxTurns.value = 0;
    maxBudget.value = 0;
    enabled.checked = true;

    setToggle('cron', 'webhook', false);
    setToggle('new', 'reuse', false);

    deleteBtn.style.display = 'none';
    runNowBtn.style.display = 'none';
    viewRunsBtn.style.display = 'none';
  }

  updateTaskEditorVisibility();
  modal.style.display = 'flex';
  sidebar.classList.remove('open');
}

function setToggle(val1, val2, isSecond) {
  const btn1Map = {
    'cron': document.getElementById('teTypeCron'),
    'new': document.getElementById('teModeNew'),
  };
  const btn2Map = {
    'webhook': document.getElementById('teTypeWebhook'),
    'reuse': document.getElementById('teModeReuse'),
  };

  const b1 = btn1Map[val1];
  const b2 = btn2Map[val2];
  if (b1 && b2) {
    b1.classList.toggle('active', !isSecond);
    b2.classList.toggle('active', isSecond);
  }
}

function updateTaskEditorVisibility() {
  const isCron = document.getElementById('teTypeCron')?.classList.contains('active');
  const isReuse = document.getElementById('teModeReuse')?.classList.contains('active');

  document.querySelectorAll('.te-cron-fields').forEach(el => {
    el.style.display = isCron ? 'flex' : 'none';
  });
  document.querySelectorAll('.te-webhook-fields').forEach(el => {
    el.style.display = isCron ? 'none' : 'flex';
  });
  document.querySelectorAll('.te-reuse-fields').forEach(el => {
    el.style.display = isReuse ? 'flex' : 'none';
  });

  // Update webhook URL hint
  const webhookUrl = document.getElementById('teWebhookUrl');
  const webhookPath = document.getElementById('teWebhookPath');
  if (webhookUrl && webhookPath) {
    const path = webhookPath.value || '<path>';
    webhookUrl.textContent = `${window.location.origin}/hook/${path}`;
  }
}

// Toggle button event handlers
document.getElementById('teTypeCron')?.addEventListener('click', () => {
  setToggle('cron', 'webhook', false);
  updateTaskEditorVisibility();
});
document.getElementById('teTypeWebhook')?.addEventListener('click', () => {
  setToggle('cron', 'webhook', true);
  updateTaskEditorVisibility();
});
document.getElementById('teModeNew')?.addEventListener('click', () => {
  setToggle('new', 'reuse', false);
  updateTaskEditorVisibility();
});
document.getElementById('teModeReuse')?.addEventListener('click', () => {
  setToggle('new', 'reuse', true);
  updateTaskEditorVisibility();
});

// Webhook path change updates URL hint
document.getElementById('teWebhookPath')?.addEventListener('input', updateTaskEditorVisibility);

// AI Cron Expression Generator
const cronAiBtn = document.getElementById('teCronAiBtn');
const cronAiInput = document.getElementById('teCronAiInput');
const cronAiPrompt = document.getElementById('teCronAiPrompt');
const cronAiGenerate = document.getElementById('teCronAiGenerate');

cronAiBtn?.addEventListener('click', () => {
  const isOpen = cronAiInput.style.display !== 'none';
  cronAiInput.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) {
    cronAiPrompt.focus();
  }
});

async function generateCronExpression() {
  const desc = cronAiPrompt.value.trim();
  if (!desc) return;

  cronAiBtn.classList.add('loading');
  cronAiGenerate.disabled = true;
  cronAiGenerate.textContent = '...';

  try {
    const res = await fetch('/api/generate-cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc }),
    });
    const data = await res.json();

    if (data.cron) {
      document.getElementById('teCronExpr').value = data.cron;
      cronAiInput.style.display = 'none';
      cronAiPrompt.value = '';
      showToast(`Generated: ${data.cron}`, 3000);
    } else {
      showToast('Failed to generate cron expression', 3000);
    }
  } catch (e) {
    showToast('Error: ' + e.message, 3000);
  } finally {
    cronAiBtn.classList.remove('loading');
    cronAiGenerate.disabled = false;
    cronAiGenerate.textContent = 'Go';
  }
}

cronAiGenerate?.addEventListener('click', generateCronExpression);
cronAiPrompt?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    generateCronExpression();
  }
});

// Close button
document.getElementById('taskEditorClose')?.addEventListener('click', () => {
  taskEditorModal.style.display = 'none';
});

// Save button
document.getElementById('teSaveBtn')?.addEventListener('click', async () => {
  const name = document.getElementById('teTaskName').value.trim();
  const prompt = document.getElementById('tePrompt').value.trim();

  if (!name) { alert('Name is required'); return; }
  if (!prompt) { alert('Prompt is required'); return; }

  const isCron = document.getElementById('teTypeCron')?.classList.contains('active');
  const isReuse = document.getElementById('teModeReuse')?.classList.contains('active');

  const payload = {
    name,
    type: isCron ? 'cron' : 'webhook',
    cron_expression: isCron ? document.getElementById('teCronExpr').value.trim() : null,
    timezone: document.getElementById('teTimezone').value,
    prompt,
    session_mode: isReuse ? 'reuse' : 'new',
    session_id: isReuse ? document.getElementById('teSessionId').value : null,
    webhook_path: !isCron ? document.getElementById('teWebhookPath').value.trim() : null,
    webhook_secret: !isCron ? document.getElementById('teWebhookSecret').value.trim() : null,
    enabled: document.getElementById('teEnabled').checked,
    model: document.getElementById('teModel').value,
    max_turns: parseInt(document.getElementById('teMaxTurns').value) || 0,
    max_budget_usd: parseFloat(document.getElementById('teMaxBudget').value) || 0,
  };

  try {
    if (editingTaskId) {
      await fetch(`/api/tasks/${editingTaskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('Task updated', 2000);
    } else {
      await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      showToast('Task created', 2000);
    }

    taskEditorModal.style.display = 'none';
    await loadTasks();
  } catch (e) {
    alert('Failed to save task: ' + e.message);
  }
});

// Delete button
document.getElementById('teDeleteBtn')?.addEventListener('click', async () => {
  if (!editingTaskId) return;
  if (!confirm('Delete this task?')) return;

  try {
    await fetch(`/api/tasks/${editingTaskId}`, { method: 'DELETE' });
    showToast('Task deleted', 2000);
    taskEditorModal.style.display = 'none';
    await loadTasks();
  } catch (e) {
    alert('Failed to delete task: ' + e.message);
  }
});

// Run Now button
document.getElementById('teRunNowBtn')?.addEventListener('click', async () => {
  if (!editingTaskId) return;
  try {
    await fetch(`/api/tasks/${editingTaskId}/run`, { method: 'POST' });
    showToast('Task triggered', 2000);
  } catch (e) {
    alert('Failed to trigger task: ' + e.message);
  }
});

// View Runs button
document.getElementById('teViewRunsBtn')?.addEventListener('click', async () => {
  if (!editingTaskId) return;
  openTaskRuns(editingTaskId);
});

// Task Runs Modal
async function openTaskRuns(taskId) {
  const modal = taskRunsModal;
  if (!modal) return;

  const task = scheduledTasks.find(t => t.id === taskId);
  const title = document.getElementById('taskRunsTitle');
  const list = document.getElementById('taskRunsList');

  title.textContent = task ? `Runs: ${task.name}` : 'Task Runs';
  list.innerHTML = '<div class="task-list-empty">Loading...</div>';
  modal.style.display = 'flex';

  try {
    const res = await fetch(`/api/tasks/${taskId}/runs`);
    const runs = await res.json();

    if (runs.length === 0) {
      list.innerHTML = '<div class="task-list-empty">No runs yet</div>';
      return;
    }

    list.innerHTML = runs.map(run => {
      const statusIcon = {
        completed: '✅', failed: '❌', running: '⏳', interrupted: '⚠️'
      }[run.status] || '❓';

      const time = new Date(run.started_at).toLocaleString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });

      let detail = run.result_summary || run.error || run.status;
      if (detail && detail.length > 60) detail = detail.substring(0, 60) + '...';

      return `
        <div class="task-run-item" data-session-id="${run.session_id || ''}">
          <span class="task-run-status">${statusIcon}</span>
          <div class="task-run-info">
            <div class="task-run-time">${time}</div>
            <div class="task-run-detail">${escapeHtml(detail)}</div>
          </div>
          <span class="task-run-trigger">${run.trigger_type}</span>
        </div>`;
    }).join('');

    // Click run to navigate to session
    list.querySelectorAll('.task-run-item').forEach(el => {
      el.addEventListener('click', () => {
        const sessId = el.dataset.sessionId;
        if (sessId) {
          modal.style.display = 'none';
          taskEditorModal.style.display = 'none';
          selectSession(sessId);
        }
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="task-list-empty">Error: ${e.message}</div>`;
  }
}

document.getElementById('taskRunsClose')?.addEventListener('click', () => {
  taskRunsModal.style.display = 'none';
});

// ============================
// In-Chat Message Search
// ============================

const searchToggleBtn = document.getElementById('searchToggleBtn');
const searchBar = document.getElementById('searchBar');
const searchInput = document.getElementById('searchInput');
const searchCounter = document.getElementById('searchCounter');
const searchPrevBtn = document.getElementById('searchPrevBtn');
const searchNextBtn = document.getElementById('searchNextBtn');
const searchCloseBtn = document.getElementById('searchCloseBtn');

let searchMatches = [];    // Array of <mark> elements
let currentMatchIndex = -1;
let searchDebounceTimer = null;
let searchIsOpen = false;

function toggleSearch() {
  if (searchIsOpen) {
    closeSearch();
  } else {
    openSearch();
  }
}

function openSearch() {
  searchIsOpen = true;
  searchBar.style.display = 'flex';
  searchInput.value = '';
  searchCounter.textContent = '';
  searchPrevBtn.disabled = true;
  searchNextBtn.disabled = true;
  // Auto-focus after display change
  requestAnimationFrame(() => searchInput.focus());
}

function closeSearch() {
  searchIsOpen = false;
  searchBar.style.display = 'none';
  searchInput.value = '';
  searchCounter.textContent = '';
  clearSearchHighlights();
  searchMatches = [];
  currentMatchIndex = -1;
}

function clearSearchHighlights() {
  const marks = messages.querySelectorAll('mark.search-highlight, mark.search-highlight-current');
  marks.forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    // Replace mark with its text content
    const textNode = document.createTextNode(mark.textContent);
    parent.replaceChild(textNode, mark);
    // Merge adjacent text nodes to avoid fragmented DOM
    parent.normalize();
  });
}

function performSearch(query) {
  // Clear previous highlights
  clearSearchHighlights();
  searchMatches = [];
  currentMatchIndex = -1;

  if (!query || query.length === 0) {
    searchCounter.textContent = '';
    searchPrevBtn.disabled = true;
    searchNextBtn.disabled = true;
    return;
  }

  const lowerQuery = query.toLowerCase();

  // Walk all text nodes inside #messages using TreeWalker
  const walker = document.createTreeWalker(
    messages,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        // Skip text nodes inside script, style, or the search bar itself
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        // Only search visible text
        if (node.textContent.trim().length === 0) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    textNodes.push(node);
  }

  // Process each text node — wrap matching substrings in <mark> tags
  for (const textNode of textNodes) {
    const text = textNode.textContent;
    const lowerText = text.toLowerCase();
    const indices = [];

    // Find all occurrences in this text node
    let startIdx = 0;
    while (true) {
      const idx = lowerText.indexOf(lowerQuery, startIdx);
      if (idx === -1) break;
      indices.push(idx);
      startIdx = idx + lowerQuery.length;
    }

    if (indices.length === 0) continue;

    // Build replacement fragment
    const frag = document.createDocumentFragment();
    let lastEnd = 0;

    for (const idx of indices) {
      // Text before match
      if (idx > lastEnd) {
        frag.appendChild(document.createTextNode(text.substring(lastEnd, idx)));
      }

      // The match wrapped in <mark>
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = text.substring(idx, idx + query.length);
      frag.appendChild(mark);
      searchMatches.push(mark);

      lastEnd = idx + query.length;
    }

    // Remaining text after last match
    if (lastEnd < text.length) {
      frag.appendChild(document.createTextNode(text.substring(lastEnd)));
    }

    // Replace the text node with our fragment
    textNode.parentNode.replaceChild(frag, textNode);
  }

  // Update counter and buttons
  updateSearchCounter();

  if (searchMatches.length > 0) {
    searchPrevBtn.disabled = false;
    searchNextBtn.disabled = false;
    // Navigate to first match
    currentMatchIndex = 0;
    highlightCurrentMatch();
  } else {
    searchPrevBtn.disabled = true;
    searchNextBtn.disabled = true;
  }
}

function highlightCurrentMatch() {
  // Remove current highlight from all
  searchMatches.forEach(m => {
    m.className = 'search-highlight';
  });

  if (currentMatchIndex >= 0 && currentMatchIndex < searchMatches.length) {
    const current = searchMatches[currentMatchIndex];
    current.className = 'search-highlight-current';
    current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  updateSearchCounter();
}

function navigateMatch(direction) {
  if (searchMatches.length === 0) return;

  if (direction === 'next') {
    currentMatchIndex = (currentMatchIndex + 1) % searchMatches.length;
  } else {
    currentMatchIndex = (currentMatchIndex - 1 + searchMatches.length) % searchMatches.length;
  }

  highlightCurrentMatch();
}

function updateSearchCounter() {
  if (searchMatches.length === 0) {
    searchCounter.textContent = searchInput.value.length > 0 ? '0 of 0' : '';
  } else {
    searchCounter.textContent = `${currentMatchIndex + 1} of ${searchMatches.length}`;
  }
}

// Wire up event listeners
searchToggleBtn.addEventListener('click', toggleSearch);
searchCloseBtn.addEventListener('click', closeSearch);
searchPrevBtn.addEventListener('click', () => navigateMatch('prev'));
searchNextBtn.addEventListener('click', () => navigateMatch('next'));

// Debounced search input
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    performSearch(searchInput.value);
  }, 150);
});

// Keyboard shortcuts in search input
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) {
      navigateMatch('prev');
    } else {
      navigateMatch('next');
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
});

// Global keyboard shortcut: Ctrl/Cmd+F to open search
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    // Only intercept if we're not in a modal or file viewer
    if (fvModal.style.display !== 'none') return;
    if (mcpModal.classList.contains('open')) return;
    if (taskEditorModal.style.display !== 'none') return;

    e.preventDefault();
    if (!searchIsOpen) {
      openSearch();
    } else {
      searchInput.focus();
      searchInput.select();
    }
  }
});

// Load tasks on init
loadTasks();

// ============================
// Swipe Gesture Navigation Between Sessions
// ============================
// Allows users to swipe left/right on the message area to switch sessions,
// matching the sort order shown in the sidebar.
// Only active on touch devices (@media (hover: none) is handled in CSS).

(function initSwipeNavigator() {
  const swipeMessages = document.getElementById('messages');
  const swipePreview = document.getElementById('swipePreview');
  if (!swipeMessages || !swipePreview) return;

  // --- Configuration ---
  const DEAD_ZONE     = 10;   // px before deciding horizontal vs vertical
  const SWIPE_THRESH  = 80;   // px horizontal to commit a session switch
  const MAX_VERTICAL  = 50;   // px vertical allowed during a horizontal swipe
  const OPACITY_FACTOR = 0.002; // opacity reduction per px of delta
  const PILL_FADE_START = 30; // px delta when pill starts appearing
  const PILL_FADE_FULL  = 60; // px delta when pill fully visible

  // --- Touch tracking state ---
  let startX = 0, startY = 0;
  let deltaX = 0, deltaY = 0;
  let axisLocked = null;  // null | 'horizontal' | 'vertical'
  let isSwiping = false;
  let targetIndex = -1;

  /**
   * Returns sessions sorted the same way as the sidebar:
   * - Sessions with isSending (for current session) are treated as "active query" first
   * - Then sorted by lastActive descending (most recent first)
   * Since we don't have per-session query state, we use the sessions array order
   * which comes from the server sorted by lastActive desc.
   */
  function getSortedSessions() {
    // sessions array is already sorted by the server (lastActive desc)
    // Return a shallow copy to avoid mutating the global array
    return sessions.slice();
  }

  /** Find the index of the current session in the sorted list */
  function getCurrentIndex(sorted) {
    return sorted.findIndex(s => s.id === currentSessionId);
  }

  /** Check if swipe should be blocked (modals, input focus, panels open) */
  function isSwipeBlocked() {
    // Text input focused — user might be selecting/typing
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return true;
    }

    // VNC viewer visible
    const vnc = document.getElementById('vncViewer');
    if (vnc && vnc.style.display !== 'none') return true;

    // File panel open
    const fp = document.getElementById('filePanel');
    if (fp && fp.style.display !== 'none') return true;

    // Modals: MCP config, file viewer, task editor, task runs
    const modals = ['mcpModal', 'fileViewerModal', 'taskEditorModal', 'taskRunsModal'];
    for (const id of modals) {
      const el = document.getElementById(id);
      if (el && (el.classList.contains('open') || el.style.display === 'flex' || el.style.display === 'block')) {
        return true;
      }
    }

    // Sidebar open on mobile
    const sb = document.getElementById('sidebar');
    if (sb && sb.classList.contains('open')) return true;

    return false;
  }

  /** Show the preview pill with target session info */
  function showPreviewPill(session, direction, progress) {
    if (!session) { hidePreviewPill(); return; }

    const arrow = direction === 'left' ? '→' : '←';
    // Check if target session has an active query (isSending only tracks current)
    // We show a green dot based on unread counts as a proxy for activity
    const hasActivity = unreadCounts[session.id] > 0;
    const dot = hasActivity ? '<span class="swipe-dot"></span>' : '';

    swipePreview.innerHTML = `<span class="swipe-arrow">${arrow}</span>${dot}${escapeHtml(session.name)}`;
    swipePreview.style.display = 'block';

    // Fade pill in based on swipe progress
    const pillOpacity = Math.min(1, Math.max(0, (progress - PILL_FADE_START) / (PILL_FADE_FULL - PILL_FADE_START)));
    swipePreview.classList.toggle('visible', pillOpacity > 0);
    swipePreview.style.opacity = pillOpacity;
  }

  function hidePreviewPill() {
    swipePreview.classList.remove('visible');
    swipePreview.style.display = 'none';
    swipePreview.style.opacity = 0;
  }

  /** Reset message container transform */
  function resetTransform() {
    swipeMessages.style.transform = '';
    swipeMessages.style.opacity = '';
    swipeMessages.classList.remove('swiping');
    axisLocked = null;
    isSwiping = false;
    targetIndex = -1;
  }

  // --- Touch event handlers ---

  function onTouchStart(e) {
    if (isSwipeBlocked()) return;
    if (e.touches.length !== 1) return; // Only single-finger swipe

    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    deltaX = 0;
    deltaY = 0;
    axisLocked = null;
    isSwiping = false;
    targetIndex = -1;
  }

  function onTouchMove(e) {
    if (isSwipeBlocked()) return;
    if (e.touches.length !== 1) return;
    if (axisLocked === 'vertical') return; // Already decided it's a scroll

    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
    deltaX = x - startX;
    deltaY = y - startY;
    const absDX = Math.abs(deltaX);
    const absDY = Math.abs(deltaY);

    // Dead zone — haven't moved enough to decide yet
    if (!axisLocked && absDX < DEAD_ZONE && absDY < DEAD_ZONE) return;

    // Decide axis lock
    if (!axisLocked) {
      if (absDY > absDX) {
        axisLocked = 'vertical';
        return; // Let the browser handle vertical scroll
      }
      axisLocked = 'horizontal';
      isSwiping = true;
      swipeMessages.classList.add('swiping');
    }

    // If vertical exceeded limit, cancel horizontal swipe
    if (absDY > MAX_VERTICAL) {
      resetTransform();
      hidePreviewPill();
      return;
    }

    // Prevent vertical scroll while swiping horizontally
    e.preventDefault();

    // Determine target session
    const sorted = getSortedSessions();
    const curIdx = getCurrentIndex(sorted);
    if (curIdx === -1) return;

    // Swiping left (deltaX < 0) → next session; swiping right (deltaX > 0) → previous session
    let nextIdx;
    if (deltaX < 0) {
      nextIdx = curIdx + 1; // Next session
    } else {
      nextIdx = curIdx - 1; // Previous session
    }

    // Edge detection — at boundary, apply resistance
    const atEdge = nextIdx < 0 || nextIdx >= sorted.length;
    let effectiveDelta = deltaX;

    if (atEdge) {
      // Rubber-band: reduce delta to 1/3 for resistance feel
      effectiveDelta = deltaX / 3;
      targetIndex = -1;
      hidePreviewPill();
    } else {
      targetIndex = nextIdx;
      const direction = deltaX < 0 ? 'left' : 'right';
      showPreviewPill(sorted[nextIdx], direction, absDX);
    }

    // Apply transform and opacity to messages container
    swipeMessages.style.transform = `translateX(${effectiveDelta}px)`;
    swipeMessages.style.opacity = Math.max(0.5, 1 - absDX * OPACITY_FACTOR);
  }

  function onTouchEnd(e) {
    if (!isSwiping) return;

    const absDX = Math.abs(deltaX);
    const sorted = getSortedSessions();
    const curIdx = getCurrentIndex(sorted);

    // Determine if we commit or snap back
    const atEdge = targetIndex < 0 || targetIndex >= sorted.length;

    if (atEdge) {
      // Edge bounce animation
      const bounceDir = deltaX > 0 ? '12px' : '-12px';
      swipeMessages.style.transform = '';
      swipeMessages.style.opacity = '';
      swipeMessages.classList.remove('swiping');
      swipeMessages.style.setProperty('--bounce-dir', bounceDir);
      swipeMessages.classList.add('swipe-edge-bounce');
      swipeMessages.addEventListener('animationend', function handler() {
        swipeMessages.classList.remove('swipe-edge-bounce');
        swipeMessages.removeEventListener('animationend', handler);
      });
      hidePreviewPill();
      axisLocked = null;
      isSwiping = false;
      targetIndex = -1;
      return;
    }

    if (absDX >= SWIPE_THRESH && targetIndex >= 0 && targetIndex < sorted.length) {
      // Commit: animate slide out, switch session, animate slide in
      const swipeDir = deltaX < 0 ? 'left' : 'right';
      const targetSession = sorted[targetIndex];

      // Set CSS custom properties for the animation start position
      swipeMessages.style.setProperty('--swipe-start-transform', `translateX(${deltaX}px)`);
      swipeMessages.style.setProperty('--swipe-start-opacity', swipeMessages.style.opacity || '1');
      swipeMessages.classList.remove('swiping');

      // Slide out
      swipeMessages.classList.add(`swipe-out-${swipeDir}`);
      hidePreviewPill();

      swipeMessages.addEventListener('animationend', function slideOutDone() {
        swipeMessages.removeEventListener('animationend', slideOutDone);
        swipeMessages.classList.remove(`swipe-out-${swipeDir}`);
        swipeMessages.style.transform = '';
        swipeMessages.style.opacity = '';

        // Switch session
        selectSession(targetSession.id);

        // Slide in from opposite side
        const slideInDir = swipeDir === 'left' ? 'left' : 'right';
        swipeMessages.classList.add(`swipe-in-${slideInDir}`);

        swipeMessages.addEventListener('animationend', function slideInDone() {
          swipeMessages.removeEventListener('animationend', slideInDone);
          swipeMessages.classList.remove(`swipe-in-${slideInDir}`);
        });
      });
    } else {
      // Snap back — didn't reach threshold
      swipeMessages.classList.remove('swiping');
      swipeMessages.classList.add('swipe-snap-back');
      hidePreviewPill();

      swipeMessages.addEventListener('transitionend', function snapDone() {
        swipeMessages.removeEventListener('transitionend', snapDone);
        swipeMessages.classList.remove('swipe-snap-back');
        swipeMessages.style.transform = '';
        swipeMessages.style.opacity = '';
      });

      // Fallback: in case transitionend doesn't fire
      setTimeout(() => {
        swipeMessages.classList.remove('swipe-snap-back');
        swipeMessages.style.transform = '';
        swipeMessages.style.opacity = '';
      }, 300);
    }

    axisLocked = null;
    isSwiping = false;
    targetIndex = -1;
  }

  // --- Attach touch listeners (passive: false for touchmove so we can preventDefault) ---
  swipeMessages.addEventListener('touchstart', onTouchStart, { passive: true });
  swipeMessages.addEventListener('touchmove', onTouchMove, { passive: false });
  swipeMessages.addEventListener('touchend', onTouchEnd, { passive: true });

  console.log('Swipe gesture navigation initialized');
})();
