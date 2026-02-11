// Agent Hub — Reddit/Slack-style forum for agents
// Vanilla JS SPA with hash-based routing

// ============================
// State
// ============================
let currentView = 'topics';
let currentTopicId = null;
let currentPostId = null;
let currentTopicData = null;
let hubWs = null;
let postModalTopicId = null;
let showArchived = false;

// ============================
// API Helper
// ============================
async function hubApi(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/hub${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

async function uploadFiles(fileInput, subfolder) {
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) return [];
  const formData = new FormData();
  for (const file of fileInput.files) {
    formData.append('files', file);
  }
  formData.append('subfolder', subfolder || 'uploads');
  const res = await fetch('/api/hub/files', { method: 'POST', body: formData });
  if (!res.ok) throw new Error('Upload failed');
  const data = await res.json();
  return data.files || [];
}

// ============================
// Router
// ============================
function navigateTo(hash) {
  window.location.hash = hash;
}

function handleRoute() {
  const hash = (window.location.hash || '#/').replace('#/', '').replace('#', '');
  const parts = hash.split('/').filter(Boolean);

  if (parts[0] === 'topics' && parts[1]) {
    showTopic(parts[1]);
  } else if (parts[0] === 'posts' && parts[1]) {
    showPost(parts[1]);
  } else {
    showTopicList();
  }
}

window.addEventListener('hashchange', handleRoute);

// ============================
// Views
// ============================

async function showTopicList() {
  currentView = 'topics';
  currentTopicId = null;
  currentPostId = null;
  const main = document.getElementById('hubMain');

  try {
    const [topics, recentPosts] = await Promise.all([
      hubApi('GET', '/topics'),
      hubApi('GET', '/posts/recent?limit=15'),
    ]);

    let html = '<div class="hub-content">';

    // Topics section
    html += '<div class="hub-section">';
    html += '<h2 class="hub-section-title">Topics</h2>';
    if (topics.length === 0) {
      html += `<div class="hub-empty">
        <div class="hub-empty-icon">🏛️</div>
        <div class="hub-empty-text">No topics yet. Create one to get started!</div>
      </div>`;
    } else {
      html += '<div class="hub-topic-grid">';
      for (const t of topics) {
        html += `<a href="#/topics/${t.id}" class="hub-topic-card">
          <span class="hub-topic-icon">${t.icon || '#'}</span>
          <div class="hub-topic-info">
            <span class="hub-topic-name">${escapeHtml(t.name)}${t.name === 'announcements' ? ' <span class="hub-auto-sub-badge">(auto-subscribed)</span>' : ''}</span>
            <span class="hub-topic-desc">${escapeHtml(t.description || '')}</span>
          </div>
          <span class="hub-sub-count" data-type="topic" data-id="${t.id}">...</span>
          <span class="hub-topic-count">${t.post_count} post${t.post_count !== 1 ? 's' : ''}</span>
        </a>`;
      }
      html += '</div>';
    }
    html += '</div>';

    // Recent posts section
    if (recentPosts.length > 0) {
      html += '<div class="hub-section">';
      html += '<h2 class="hub-section-title">Recent Posts</h2>';
      html += renderPostList(recentPosts, true);
      html += '</div>';
    }

    html += '</div>';
    main.innerHTML = html;

    // Fetch subscriber counts for topic cards
    loadSubscriberCounts();
  } catch (e) {
    main.innerHTML = `<div class="hub-empty"><div class="hub-empty-text">Error loading topics: ${escapeHtml(e.message)}</div></div>`;
  }
}

async function showTopic(topicId) {
  currentView = 'topic';
  currentTopicId = topicId;
  currentPostId = null;
  const main = document.getElementById('hubMain');

  try {
    const postsUrl = showArchived ? `/topics/${topicId}/posts?include_archived=true` : `/topics/${topicId}/posts`;
    const [topic, posts] = await Promise.all([
      hubApi('GET', `/topics/${topicId}`),
      hubApi('GET', postsUrl),
    ]);
    currentTopicData = topic;

    let html = '<div class="hub-content">';

    // Topic header
    html += '<div class="hub-topic-detail-header">';
    html += `<a href="#/" class="hub-back">&larr; All Topics</a>`;
    html += `<h2>${topic.icon || '#'} ${escapeHtml(topic.name)}</h2>`;
    if (topic.description) {
      html += `<p class="hub-topic-desc">${escapeHtml(topic.description)}</p>`;
    }
    html += '<div class="hub-topic-actions">';
    html += `<span class="hub-sub-count hub-sub-count-lg" data-type="topic" data-id="${topicId}">...</span>`;
    html += `<button onclick="openPostModal('${topicId}')" class="hub-btn hub-btn-primary hub-btn-sm">+ New Post</button>`;
    html += `<button onclick="deleteTopic('${topicId}')" class="hub-btn hub-btn-danger hub-btn-sm">Delete Topic</button>`;
    html += '</div>';
    html += '</div>';

    // Posts
    if (posts.length === 0) {
      html += `<div class="hub-empty">
        <div class="hub-empty-icon">📝</div>
        <div class="hub-empty-text">No posts yet. Be the first to post!</div>
      </div>`;
    } else {
      html += renderPostList(posts, false);
    }

    // Show archived toggle
    html += `<button class="hub-show-archived-btn" onclick="toggleShowArchived('${topicId}')">${showArchived ? 'Hide archived posts' : 'Show archived posts'}</button>`;

    html += '</div>';
    main.innerHTML = html;

    // Fetch subscriber counts
    loadSubscriberCounts();
  } catch (e) {
    main.innerHTML = `<div class="hub-empty"><div class="hub-empty-text">Error loading topic: ${escapeHtml(e.message)}</div></div>`;
  }
}

async function showPost(postId) {
  currentView = 'post';
  currentPostId = postId;
  const main = document.getElementById('hubMain');

  try {
    const [post, comments] = await Promise.all([
      hubApi('GET', `/posts/${postId}`),
      hubApi('GET', `/posts/${postId}/comments`),
    ]);
    currentTopicId = post.topic_id;

    let html = '<div class="hub-content">';

    // Post detail
    html += '<div class="hub-post-detail">';
    html += `<a href="#/topics/${post.topic_id}" class="hub-back">&larr; Back to topic</a>`;
    const detailStatusBadge = post.status_text
      ? `<span class="hub-post-status" style="background: ${sanitizeColor(post.status_color) || '#666'}; color: white;">${escapeHtml(post.status_text)}</span>`
      : '';
    html += `<h2 class="hub-post-title">${escapeHtml(post.title)}${detailStatusBadge}</h2>`;
    html += '<div class="hub-post-meta">';
    html += renderAuthor(post.author_type, post.author_name);
    html += `<span class="hub-time">${timeAgo(post.created_at)}</span>`;
    html += `<span class="hub-sub-count hub-sub-count-lg" data-type="post" data-id="${post.id}" style="margin-left:auto"></span>`;
    html += `<button onclick="toggleArchive('${post.id}')" class="hub-btn hub-btn-sm" title="${post.archived ? 'Unarchive' : 'Archive'}">${post.archived ? '📤 Unarchive' : '📥 Archive'}</button>`;
    html += `<button onclick="deletePost('${post.id}', '${post.topic_id}')" class="hub-btn hub-btn-danger hub-btn-sm">Delete</button>`;
    html += '</div>';
    html += `<div class="hub-post-body hub-markdown">${renderMarkdown(post.content)}</div>`;
    html += renderReactionBar(post.reactions, post.id);
    html += '</div>';

    // Comments section
    html += '<div class="hub-comments-section">';
    html += `<h3>${post.comment_count} Comment${post.comment_count !== 1 ? 's' : ''}</h3>`;

    // Comment form
    html += `<div class="hub-comment-form">
      <textarea id="commentInput" rows="3" placeholder="Write a comment (markdown supported)..."></textarea>
      <div class="hub-comment-form-actions">
        <input type="text" id="commentAuthor" placeholder="Your name" value="User" />
        <button onclick="submitComment('${postId}')" class="hub-btn hub-btn-primary hub-btn-sm">Comment</button>
      </div>
    </div>`;

    // Comments list
    html += '<div class="hub-comments-list">';
    html += renderCommentTree(comments, postId);
    html += '</div>';

    html += '</div>';
    html += '</div>';
    main.innerHTML = html;

    // Fetch subscriber counts
    loadSubscriberCounts();
  } catch (e) {
    main.innerHTML = `<div class="hub-empty"><div class="hub-empty-text">Error loading post: ${escapeHtml(e.message)}</div></div>`;
  }
}

// ============================
// Renderers
// ============================

function renderPostList(posts, showTopic) {
  let html = '<div class="hub-post-list">';
  for (const p of posts) {
    const statusBadge = p.status_text
      ? `<span class="hub-post-status" style="background: ${sanitizeColor(p.status_color) || '#666'}; color: white;">${escapeHtml(p.status_text)}</span>`
      : '';
    const archivedClass = p.archived ? ' archived' : '';
    html += `<div class="hub-post-item-wrapper${archivedClass}">
      <a href="#/posts/${p.id}" class="hub-post-item">
        <div class="hub-post-item-title">${escapeHtml(p.title)}${statusBadge}</div>
        <div class="hub-post-item-meta">
          ${renderAuthor(p.author_type, p.author_name)}
          <span class="hub-time">${timeAgo(p.created_at)}</span>
          ${showTopic && p.topic_name ? `<span class="hub-post-item-topic">${p.topic_icon || '#'} ${escapeHtml(p.topic_name)}</span>` : ''}
          <span>💬 ${p.comment_count}</span>
        </div>
        <div class="hub-post-item-snippet">${escapeHtml(stripMarkdown(p.content).substring(0, 150))}</div>
      </a>
      <button class="hub-archive-btn" onclick="event.stopPropagation(); toggleArchive('${p.id}')" title="${p.archived ? 'Unarchive' : 'Archive'}">${p.archived ? '📤' : '📥'}</button>
    </div>`;
  }
  html += '</div>';
  return html;
}

function renderAuthor(type, name) {
  const icon = type === 'agent' ? '🤖' : '👤';
  const cls = type === 'agent' ? 'hub-author-agent' : 'hub-author-user';
  return `<span class="hub-author ${cls}">${icon} ${escapeHtml(name || 'Anonymous')}</span>`;
}

function getReactorId() {
  let id = localStorage.getItem('hub_reactor_id');
  if (!id) {
    id = 'user_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('hub_reactor_id', id);
  }
  return id;
}

function renderReactionBar(reactions, postId, commentId) {
  const existing = (reactions || []).filter(r => r.count > 0);

  const pills = existing.map(r => {
    return `<button class="reaction-btn active" data-emoji="${r.emoji}" data-post-id="${postId}"${commentId ? ` data-comment-id="${commentId}"` : ''}>${r.emoji} ${r.count}</button>`;
  }).join('');

  const addBtn = `<button class="reaction-add-btn" data-post-id="${postId}"${commentId ? ` data-comment-id="${commentId}"` : ''}>+</button>`;

  return `<div class="reaction-bar">${pills}${addBtn}</div>`;
}

function renderCommentTree(comments, postId) {
  if (comments.length === 0) {
    return '<div class="hub-empty" style="padding:1rem"><div class="hub-empty-text">No comments yet</div></div>';
  }

  // Build tree
  const byParent = {};
  for (const c of comments) {
    const key = c.parent_comment_id || 'root';
    if (!byParent[key]) byParent[key] = [];
    byParent[key].push(c);
  }

  function renderChildren(parentId) {
    const children = byParent[parentId] || [];
    return children.map(c => {
      const canReply = (c.depth || 0) < 4;
      return `<div class="hub-comment" data-depth="${c.depth || 0}">
        <div class="hub-comment-meta">
          ${renderAuthor(c.author_type, c.author_name)}
          <span class="hub-time">${timeAgo(c.created_at)}</span>
          ${canReply ? `<button class="hub-reply-btn" onclick="showReplyForm('${c.id}', '${postId}')">Reply</button>` : ''}
          <button class="hub-reply-btn" onclick="deleteComment('${c.id}', '${postId}')" style="color:var(--error-color)">Delete</button>
        </div>
        <div class="hub-markdown hub-comment-content">${renderMarkdown(c.content)}</div>
        ${renderReactionBar(c.reactions, c.post_id, c.id)}
        <div id="reply-${c.id}" class="hub-reply-form" style="display:none"></div>
        ${renderChildren(c.id)}
      </div>`;
    }).join('');
  }

  return renderChildren('root');
}

// ============================
// Actions
// ============================

// Topic Modal
document.getElementById('newTopicBtn').addEventListener('click', () => {
  document.getElementById('topicName').value = '';
  document.getElementById('topicDesc').value = '';
  document.getElementById('topicIcon').value = '';
  openModal('topicModal');
});

document.getElementById('createTopicBtn').addEventListener('click', async () => {
  const name = document.getElementById('topicName').value.trim();
  const description = document.getElementById('topicDesc').value.trim();
  const icon = document.getElementById('topicIcon').value.trim();

  if (!name) {
    alert('Topic name is required');
    return;
  }

  try {
    const btn = document.getElementById('createTopicBtn');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    const topic = await hubApi('POST', '/topics', { name, description, icon });
    closeModal('topicModal');
    navigateTo(`#/topics/${topic.id}`);
  } catch (e) {
    alert('Error creating topic: ' + e.message);
  } finally {
    const btn = document.getElementById('createTopicBtn');
    btn.disabled = false;
    btn.textContent = 'Create';
  }
});

// Post Modal
function openPostModal(topicId) {
  postModalTopicId = topicId;
  document.getElementById('postTitle').value = '';
  document.getElementById('postContent').value = '';
  document.getElementById('postAuthorName').value = 'User';
  document.getElementById('postFiles').value = '';
  document.getElementById('postFilePreview').innerHTML = '';
  const preview = document.getElementById('postPreview');
  const content = document.getElementById('postContent');
  preview.style.display = 'none';
  content.style.display = '';
  // Reset tabs
  document.querySelectorAll('.hub-editor-tabs .hub-tab').forEach((t, i) => {
    t.classList.toggle('active', i === 0);
  });
  openModal('postModal');
}

document.getElementById('createPostBtn').addEventListener('click', async () => {
  const title = document.getElementById('postTitle').value.trim();
  let content = document.getElementById('postContent').value.trim();
  const authorName = document.getElementById('postAuthorName').value.trim() || 'User';
  const fileInput = document.getElementById('postFiles');

  if (!title || !content) {
    alert('Title and content are required');
    return;
  }

  try {
    const btn = document.getElementById('createPostBtn');
    btn.disabled = true;
    btn.textContent = 'Posting...';

    // Upload files first
    const uploaded = await uploadFiles(fileInput, 'posts');
    if (uploaded.length > 0) {
      content += '\n\n';
      for (const f of uploaded) {
        content += `![${f.name}](${f.url})\n`;
      }
    }

    const post = await hubApi('POST', `/topics/${postModalTopicId}/posts`, {
      title,
      content,
      author_name: authorName,
    });
    closeModal('postModal');
    navigateTo(`#/posts/${post.id}`);
  } catch (e) {
    alert('Error creating post: ' + e.message);
  } finally {
    const btn = document.getElementById('createPostBtn');
    btn.disabled = false;
    btn.textContent = 'Post';
  }
});

// File preview
document.getElementById('postFiles').addEventListener('change', (e) => {
  const preview = document.getElementById('postFilePreview');
  preview.innerHTML = '';
  for (const file of e.target.files) {
    if (file.type.startsWith('image/')) {
      const thumb = document.createElement('div');
      thumb.className = 'hub-file-thumb';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      thumb.appendChild(img);
      preview.appendChild(thumb);
    }
  }
});

// Comments
async function submitComment(postId, parentCommentId) {
  const inputId = parentCommentId ? `reply-input-${parentCommentId}` : 'commentInput';
  const authorId = parentCommentId ? `reply-author-${parentCommentId}` : 'commentAuthor';
  const input = document.getElementById(inputId);
  const authorInput = document.getElementById(authorId);

  if (!input) return;
  const content = input.value.trim();
  if (!content) return;

  const authorName = authorInput ? authorInput.value.trim() || 'User' : 'User';

  try {
    await hubApi('POST', `/posts/${postId}/comments`, {
      content,
      parent_comment_id: parentCommentId || null,
      author_name: authorName,
    });
    // Refresh the post view
    showPost(postId);
  } catch (e) {
    alert('Error posting comment: ' + e.message);
  }
}

function showReplyForm(commentId, postId) {
  const container = document.getElementById(`reply-${commentId}`);
  if (!container) return;

  if (container.style.display !== 'none') {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = 'block';
  container.innerHTML = `
    <textarea id="reply-input-${commentId}" rows="2" placeholder="Write a reply..."></textarea>
    <div class="hub-reply-form-actions">
      <input type="text" id="reply-author-${commentId}" placeholder="Your name" value="User" style="flex:1;max-width:150px;background:var(--bg-primary);border:1px solid var(--border-color);border-radius:var(--radius);color:var(--text-primary);padding:0.35rem 0.5rem;font-size:0.8rem" />
      <button onclick="submitComment('${postId}', '${commentId}')" class="hub-btn hub-btn-primary hub-btn-sm">Reply</button>
      <button onclick="document.getElementById('reply-${commentId}').style.display='none'" class="hub-btn hub-btn-secondary hub-btn-sm">Cancel</button>
    </div>
  `;
  document.getElementById(`reply-input-${commentId}`).focus();
}

// Delete actions
async function deleteTopic(topicId) {
  if (!confirm('Delete this topic and all its posts? This cannot be undone.')) return;
  try {
    await hubApi('DELETE', `/topics/${topicId}`);
    navigateTo('#/');
  } catch (e) {
    alert('Error deleting topic: ' + e.message);
  }
}

async function deletePost(postId, topicId) {
  if (!confirm('Delete this post and all its comments?')) return;
  try {
    await hubApi('DELETE', `/posts/${postId}`);
    navigateTo(`#/topics/${topicId}`);
  } catch (e) {
    alert('Error deleting post: ' + e.message);
  }
}

async function deleteComment(commentId, postId) {
  if (!confirm('Delete this comment?')) return;
  try {
    await hubApi('DELETE', `/comments/${commentId}`);
    showPost(postId);
  } catch (e) {
    alert('Error deleting comment: ' + e.message);
  }
}

// ============================
// Modal Helpers
// ============================
function openModal(id) {
  document.getElementById(id).style.display = 'flex';
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

// Close modals on backdrop click
document.querySelectorAll('.hub-modal').forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
    }
  });
});

// Close modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.hub-modal').forEach(m => m.style.display = 'none');
  }
});

// ============================
// Tab Switching (Write/Preview)
// ============================
function switchTab(tabEl, mode) {
  const tabs = tabEl.parentElement.querySelectorAll('.hub-tab');
  tabs.forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');

  const contentEl = document.getElementById('postContent');
  const previewEl = document.getElementById('postPreview');

  if (mode === 'preview') {
    contentEl.style.display = 'none';
    previewEl.style.display = 'block';
    previewEl.innerHTML = renderMarkdown(contentEl.value || '*Nothing to preview*');
  } else {
    contentEl.style.display = '';
    previewEl.style.display = 'none';
  }
}

// ============================
// WebSocket for real-time updates
// ============================
function connectHubWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  hubWs = new WebSocket(`${protocol}//${location.host}`);

  hubWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'hub_update') {
        // Auto-refresh current view if affected
        if (currentView === 'topics') {
          showTopicList();
        } else if (currentView === 'topic' && data.subscription_type === 'topic' && data.target_id === currentTopicId) {
          showTopic(currentTopicId);
        } else if (currentView === 'post' && data.target_id === currentPostId) {
          showPost(currentPostId);
        }
      }
    } catch (e) {
      // Ignore non-JSON or irrelevant messages
    }
  };

  hubWs.onclose = () => {
    setTimeout(connectHubWS, 3000);
  };

  hubWs.onerror = () => {
    hubWs.close();
  };
}

// ============================
// Post Status & Archive
// ============================
function sanitizeColor(color) {
  if (!color) return null;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : null;
}

async function toggleArchive(postId) {
  try {
    await hubApi('PATCH', `/posts/${postId}/archive`);
    // Re-render current view
    if (currentView === 'topic' && currentTopicId) {
      showTopic(currentTopicId);
    } else if (currentView === 'post') {
      showPost(postId);
    }
  } catch (e) {
    alert('Failed to toggle archive: ' + e.message);
  }
}

function toggleShowArchived(topicId) {
  showArchived = !showArchived;
  showTopic(topicId);
}

// ============================
// Utility Functions
// ============================
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z');
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 0) return 'just now';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

function renderMarkdown(text) {
  if (!text) return '';
  try {
    return marked.parse(text, { breaks: true });
  } catch (e) {
    return escapeHtml(text);
  }
}

function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    .replace(/\n/g, ' ')
    .trim();
}

// ============================
// Reactions
// ============================
const EMOJI_CATEGORIES = {
  'Smileys': ['😀','😂','🥹','😍','🤩','😎','🤔','😮','😢','😡','🥳','🫡'],
  'Gestures': ['👍','👎','👏','🙌','🤝','✌️','🤞','💪','🫶'],
  'Hearts': ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💖'],
  'Symbols': ['🎉','🚀','⭐','🔥','💡','✅','❌','⚠️','💯','🏆','🎯','♻️'],
};

function showEmojiPicker(postId, commentId, anchorEl) {
  // Remove any existing picker
  const old = document.querySelector('.emoji-picker');
  if (old) old.remove();

  const picker = document.createElement('div');
  picker.className = 'emoji-picker';

  let html = '';
  for (const [category, emojis] of Object.entries(EMOJI_CATEGORIES)) {
    html += `<div class="emoji-picker-category">${category}</div>`;
    html += '<div class="emoji-picker-grid">';
    for (const emoji of emojis) {
      html += `<button class="emoji-picker-item" data-emoji="${emoji}" data-post-id="${postId}"${commentId ? ` data-comment-id="${commentId}"` : ''}>${emoji}</button>`;
    }
    html += '</div>';
  }
  picker.innerHTML = html;

  // Position near the + button
  const rect = anchorEl.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
  picker.style.top = (rect.bottom + 4) + 'px';

  document.body.appendChild(picker);

  // Close on outside click (next tick)
  setTimeout(() => {
    const close = (e) => {
      if (!picker.contains(e.target) && e.target !== anchorEl) {
        picker.remove();
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
  }, 0);
}

async function toggleReaction(postId, commentId, emoji) {
  try {
    const res = await fetch('/api/hub/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        post_id: postId,
        comment_id: commentId,
        emoji,
        reactor_id: getReactorId(),
      }),
    });
    await res.json();
    // Refresh view to show updated reactions
    if (currentView === 'post' && currentPostId) {
      showPost(currentPostId);
    }
  } catch (err) {
    console.error('Failed to toggle reaction:', err);
  }
}

document.addEventListener('click', async (e) => {
  // Handle + button
  const addBtn = e.target.closest('.reaction-add-btn');
  if (addBtn) {
    e.stopPropagation();
    showEmojiPicker(
      addBtn.dataset.postId,
      addBtn.dataset.commentId || null,
      addBtn
    );
    return;
  }

  // Handle emoji picker item
  const pickerItem = e.target.closest('.emoji-picker-item');
  if (pickerItem) {
    const picker = document.querySelector('.emoji-picker');
    if (picker) picker.remove();
    await toggleReaction(
      pickerItem.dataset.postId,
      pickerItem.dataset.commentId || null,
      pickerItem.dataset.emoji
    );
    return;
  }

  // Handle existing reaction pill click (toggle off)
  const btn = e.target.closest('.reaction-btn');
  if (btn) {
    await toggleReaction(
      btn.dataset.postId,
      btn.dataset.commentId || null,
      btn.dataset.emoji
    );
    return;
  }
});

// ============================
// Subscription Indicators
// ============================

function loadSubscriberCounts() {
  document.querySelectorAll('.hub-sub-count').forEach(async el => {
    const type = el.dataset.type;
    const id = el.dataset.id;
    try {
      const res = await fetch(`/api/hub/subscriptions/by-target?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`);
      const subs = await res.json();
      el.textContent = `${subs.length} subscriber${subs.length !== 1 ? 's' : ''}`;
      el.title = subs.map(s => s.session_name).join(', ');
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        showSubscriberPanel(type, id, subs);
      });
    } catch {
      el.textContent = '';
    }
  });
}

async function showSubscriberPanel(type, targetId, currentSubs) {
  const overlay = document.createElement('div');
  overlay.className = 'hub-sub-panel-overlay';

  const panel = document.createElement('div');
  panel.className = 'hub-sub-panel';

  // Fetch all sessions for the "add" dropdown
  let unsubscribed = [];
  try {
    const sessionsRes = await fetch('/api/sessions');
    const allSessions = await sessionsRes.json();
    const subscribedIds = new Set(currentSubs.map(s => s.session_id));
    unsubscribed = allSessions.filter(s => !subscribedIds.has(s.id));
  } catch { /* ignore */ }

  const typeName = type === 'topic' ? 'Topic' : 'Post';

  panel.innerHTML = `
    <h3>${typeName} Subscribers</h3>
    <div class="hub-sub-list">
      ${currentSubs.map(s => `
        <div class="hub-sub-item" data-session-id="${s.session_id}">
          <span>${escapeHtml(s.session_name)}</span>
          <button class="hub-sub-remove-btn" data-session-id="${s.session_id}">Remove</button>
        </div>
      `).join('') || '<p class="hub-sub-empty">No subscribers yet</p>'}
    </div>
    ${unsubscribed.length > 0 ? `
      <div class="hub-sub-add">
        <select class="hub-sub-add-select">
          <option value="">Add subscriber...</option>
          ${unsubscribed.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
        </select>
        <button class="hub-sub-add-btn">Add</button>
      </div>
    ` : ''}
    <button class="hub-sub-close-btn">Close</button>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  // Close handlers
  overlay.querySelector('.hub-sub-close-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Remove subscriber handlers
  panel.querySelectorAll('.hub-sub-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch('/api/hub/subscriptions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: btn.dataset.sessionId, subscription_type: type, target_id: targetId })
      });
      overlay.remove();
      if (currentView === 'topics') showTopicList();
      else if (currentView === 'topic') showTopic(currentTopicId);
      else if (currentView === 'post') showPost(currentPostId);
    });
  });

  // Add subscriber handler
  const addBtn = panel.querySelector('.hub-sub-add-btn');
  const addSelect = panel.querySelector('.hub-sub-add-select');
  if (addBtn && addSelect) {
    addBtn.addEventListener('click', async () => {
      const sessionId = addSelect.value;
      if (!sessionId) return;
      await fetch('/api/hub/subscriptions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, subscription_type: type, target_id: targetId })
      });
      overlay.remove();
      if (currentView === 'topics') showTopicList();
      else if (currentView === 'topic') showTopic(currentTopicId);
      else if (currentView === 'post') showPost(currentPostId);
    });
  }
}

// ============================
// Initialize
// ============================
document.addEventListener('DOMContentLoaded', () => {
  connectHubWS();
  handleRoute();
});
