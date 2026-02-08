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

// Initialize
init();

async function init() {
  setupEventListeners();
  connectWebSocket();
  await loadSessions();

  // Create or load first session
  if (sessions.length === 0) {
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

  ws.onopen = () => {
    console.log('WebSocket connected');
    isConnected = true;

    // Reset UI state on reconnection
    isSending = false;
    sendBtn.disabled = false;
    interruptBtn.style.display = 'none';

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

    // Reconnect after delay
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
}

function handleServerMessage(data) {
  console.log('Server message:', data);

  switch (data.type) {
    case 'session_started':
      console.log('Session started:', data.sessionId);
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
      break;

    case 'interrupted':
      if (sendingTimeout) {
        clearTimeout(sendingTimeout);
        sendingTimeout = null;
      }
      isSending = false;
      sendBtn.disabled = false;
      interruptBtn.style.display = 'none';
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
      addMessage('system', `Error: ${data.error}`, 'error');
      break;

    case 'mcp_servers_updated':
      addMessage('system', 'MCP servers updated successfully', 'success');
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
      handleAssistantMessage(event);
      break;

    case 'user':
      if (!event.isSynthetic) {
        // Skip synthetic user messages (tool results)
        addMessage('user', extractContent(event.message));
      }
      break;

    case 'result':
      handleResultMessage(event);
      break;

    case 'tool_progress':
      updateToolProgress(event);
      break;
  }
}

function handleSystemEvent(event) {
  if (event.subtype === 'init') {
    // Store SDK session ID for resumption
    currentSdkSessionId = event.session_id;

    // Show MCP server status
    if (event.mcp_servers && event.mcp_servers.length > 0) {
      const statusHtml = event.mcp_servers
        .map(server => `
          <div class="status-indicator">
            <span class="status-dot ${server.status === 'connected' ? '' : 'error'}"></span>
            <span>${server.name}: ${server.status}</span>
          </div>
        `)
        .join('');
      addSystemMessage(statusHtml);
    }
  } else if (event.subtype === 'status') {
    if (event.status === 'compacting') {
      addSystemMessage('Compacting conversation context...');
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
    const stats = `
      Turns: ${event.num_turns} |
      Cost: $${event.total_cost_usd.toFixed(4)} |
      Tokens: ${event.usage.input_tokens}/${event.usage.output_tokens}
    `;
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

    return `
      <div class="session-item ${session.id === currentSessionId ? 'active' : ''}"
           data-id="${session.id}">
        <div class="session-name">${escapeHtml(session.name)}</div>
        <div class="session-time">${timeStr}</div>
      </div>
    `;
  }).join('');

  // Add click listeners
  document.querySelectorAll('.session-item').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.id;
      selectSession(id);
      sidebar.classList.remove('open');
    });
  });
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
  currentSessionId = sessionId;
  currentSdkSessionId = null; // Will be loaded from server

  const session = sessions.find(s => s.id === sessionId);
  if (session) {
    sessionTitle.textContent = session.name;
  }

  // Clear messages
  messages.innerHTML = '';

  // Load message history
  await loadSessionHistory(sessionId);

  // Re-render session list to update active state
  renderSessions();

  // Start session with server
  if (isConnected) {
    startSession(sessionId);
  }
}

async function loadSessionHistory(sessionId) {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/messages`);
    const data = await response.json();

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
    // Unregister all service workers
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(r => r.unregister()));
    }

    // Clear all caches
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));

    // Hard reload
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
