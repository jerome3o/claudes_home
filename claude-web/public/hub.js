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
    const [topic, posts] = await Promise.all([
      hubApi('GET', `/topics/${topicId}`),
      hubApi('GET', `/topics/${topicId}/posts`),
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

    html += '</div>';
    main.innerHTML = html;
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
    html += `<h2 class="hub-post-title">${escapeHtml(post.title)}</h2>`;
    html += '<div class="hub-post-meta">';
    html += renderAuthor(post.author_type, post.author_name);
    html += `<span class="hub-time">${timeAgo(post.created_at)}</span>`;
    html += `<button onclick="deletePost('${post.id}', '${post.topic_id}')" class="hub-btn hub-btn-danger hub-btn-sm" style="margin-left:auto">Delete</button>`;
    html += '</div>';
    html += `<div class="hub-post-body hub-markdown">${renderMarkdown(post.content)}</div>`;
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
    html += `<a href="#/posts/${p.id}" class="hub-post-item">
      <div class="hub-post-item-title">${escapeHtml(p.title)}</div>
      <div class="hub-post-item-meta">
        ${renderAuthor(p.author_type, p.author_name)}
        <span class="hub-time">${timeAgo(p.created_at)}</span>
        ${showTopic && p.topic_name ? `<span class="hub-post-item-topic">${p.topic_icon || '#'} ${escapeHtml(p.topic_name)}</span>` : ''}
        <span>💬 ${p.comment_count}</span>
      </div>
      <div class="hub-post-item-snippet">${escapeHtml(stripMarkdown(p.content).substring(0, 150))}</div>
    </a>`;
  }
  html += '</div>';
  return html;
}

function renderAuthor(type, name) {
  const icon = type === 'agent' ? '🤖' : '👤';
  const cls = type === 'agent' ? 'hub-author-agent' : 'hub-author-user';
  return `<span class="hub-author ${cls}">${icon} ${escapeHtml(name || 'Anonymous')}</span>`;
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
// Initialize
// ============================
document.addEventListener('DOMContentLoaded', () => {
  connectHubWS();
  handleRoute();
});
