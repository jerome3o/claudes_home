// Dashboard - Agent Activity Overview
// ====================================

// State
let activityChart = null;
let costChart = null;
let lastUpdateTime = Date.now();
let autoRefreshInterval = null;
let healthRefreshInterval = null;

// ============================
// API Helper
// ============================
async function dashApi(path) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`Dashboard API error (${path}):`, e);
    return null;
  }
}

// ============================
// Time Helpers
// ============================
function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatUptime(seconds) {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return `${d}d ${h}h`;
}

function formatHour(dateStr) {
  const d = new Date(dateStr);
  const h = d.getHours();
  return `${h.toString().padStart(2, '0')}:00`;
}

// ============================
// Update "Last updated" indicator
// ============================
function updateTimestamp() {
  lastUpdateTime = Date.now();
  document.getElementById('dashLastUpdated').textContent = 'Updated just now';
}

function tickTimestamp() {
  const el = document.getElementById('dashLastUpdated');
  const secs = Math.floor((Date.now() - lastUpdateTime) / 1000);
  if (secs < 5) {
    el.textContent = 'Updated just now';
  } else if (secs < 60) {
    el.textContent = `Updated ${secs}s ago`;
  } else {
    el.textContent = `Updated ${Math.floor(secs / 60)}m ago`;
  }
}

// ============================
// Chart Defaults
// ============================
function configureChartDefaults() {
  Chart.defaults.color = '#888';
  Chart.defaults.borderColor = '#2a2a2a';
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;
}

// ============================
// Activity Timeline (Stacked Bar Chart)
// ============================
async function loadActivityChart() {
  const data = await dashApi('/api/stats/activity');
  const canvas = document.getElementById('activityChart');
  const emptyEl = document.getElementById('activityEmpty');

  if (!data || data.length === 0) {
    canvas.style.display = 'none';
    emptyEl.style.display = 'flex';
    if (activityChart) { activityChart.destroy(); activityChart = null; }
    return;
  }

  canvas.style.display = 'block';
  emptyEl.style.display = 'none';

  const labels = data.map(d => formatHour(d.hour));
  const userCounts = data.map(d => d.user || 0);
  const assistantCounts = data.map(d => d.assistant || 0);
  const systemCounts = data.map(d => d.system || 0);

  const config = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'User',
          data: userCounts,
          backgroundColor: 'rgba(99, 102, 241, 0.7)',
          borderColor: '#6366f1',
          borderWidth: 1,
          borderRadius: 2,
        },
        {
          label: 'Assistant',
          data: assistantCounts,
          backgroundColor: 'rgba(16, 185, 129, 0.7)',
          borderColor: '#10b981',
          borderWidth: 1,
          borderRadius: 2,
        },
        {
          label: 'System',
          data: systemCounts,
          backgroundColor: 'rgba(136, 136, 136, 0.5)',
          borderColor: '#888',
          borderWidth: 1,
          borderRadius: 2,
        }
      ]
    },
    options: {
      plugins: {
        legend: {
          position: 'top',
          labels: { boxWidth: 12, padding: 15 }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
        }
      },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: 'rgba(42, 42, 42, 0.5)' },
          ticks: { precision: 0 }
        }
      },
      interaction: { mode: 'index', intersect: false }
    }
  };

  if (activityChart) {
    activityChart.data = config.data;
    activityChart.update();
  } else {
    activityChart = new Chart(canvas, config);
  }
}

// ============================
// Cost & Token Usage (Line Chart)
// ============================
async function loadCostChart() {
  const data = await dashApi('/api/stats/costs');
  const canvas = document.getElementById('costChart');
  const emptyEl = document.getElementById('costEmpty');

  if (!data || data.length === 0) {
    canvas.style.display = 'none';
    emptyEl.style.display = 'flex';
    if (costChart) { costChart.destroy(); costChart = null; }
    return;
  }

  canvas.style.display = 'block';
  emptyEl.style.display = 'none';

  const labels = data.map(d => formatHour(d.hour));
  const costs = data.map(d => d.total_cost_usd || 0);
  const inputTokens = data.map(d => (d.input_tokens || 0) / 1000); // Show in K
  const outputTokens = data.map(d => (d.output_tokens || 0) / 1000);

  const config = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Cost ($)',
          data: costs,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          fill: true,
          tension: 0.3,
          yAxisID: 'y',
          pointRadius: 2,
          pointHoverRadius: 5,
        },
        {
          label: 'Input Tokens (K)',
          data: inputTokens,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: false,
          tension: 0.3,
          yAxisID: 'y1',
          pointRadius: 2,
          pointHoverRadius: 5,
        },
        {
          label: 'Output Tokens (K)',
          data: outputTokens,
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          fill: false,
          tension: 0.3,
          yAxisID: 'y1',
          pointRadius: 2,
          pointHoverRadius: 5,
        }
      ]
    },
    options: {
      plugins: {
        legend: {
          position: 'top',
          labels: { boxWidth: 12, padding: 10 }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: function(ctx) {
              if (ctx.datasetIndex === 0) {
                return `Cost: $${ctx.parsed.y.toFixed(4)}`;
              }
              return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}K`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
        },
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          beginAtZero: true,
          title: { display: true, text: 'Cost ($)', color: '#f59e0b' },
          grid: { color: 'rgba(42, 42, 42, 0.5)' },
          ticks: {
            callback: function(val) { return '$' + val.toFixed(2); }
          }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          beginAtZero: true,
          title: { display: true, text: 'Tokens (K)', color: '#6366f1' },
          grid: { drawOnChartArea: false }
        }
      },
      interaction: { mode: 'index', intersect: false }
    }
  };

  if (costChart) {
    costChart.data = config.data;
    costChart.update();
  } else {
    costChart = new Chart(canvas, config);
  }
}

// ============================
// System Health
// ============================
async function loadSystemHealth() {
  const data = await dashApi('/api/system-status');
  if (!data) return;

  // CPU - use 1min load average, normalize to percentage (approx)
  const cpuPct = Math.min(100, Math.round(data.load[0] * 100 / (navigator.hardwareConcurrency || 4)));
  const cpuBar = document.getElementById('cpuBar');
  cpuBar.style.width = cpuPct + '%';
  cpuBar.className = 'dash-progress-fill dash-progress-cpu' + (cpuPct > 80 ? ' danger' : cpuPct > 60 ? ' warn' : '');
  document.getElementById('cpuValue').textContent = `${data.load[0].toFixed(2)} / ${data.load[1].toFixed(2)} / ${data.load[2].toFixed(2)}`;

  // Memory
  const memPct = data.mem.total > 0 ? Math.round((data.mem.used / data.mem.total) * 100) : 0;
  const memBar = document.getElementById('memBar');
  memBar.style.width = memPct + '%';
  memBar.className = 'dash-progress-fill dash-progress-mem' + (memPct > 85 ? ' danger' : memPct > 70 ? ' warn' : '');
  document.getElementById('memValue').textContent = `${data.mem.used} MB / ${data.mem.total} MB (${memPct}%)`;

  // Queries
  document.getElementById('queriesValue').textContent = data.queries;
  document.getElementById('queriesValue').style.color = data.queries > 0 ? '#10b981' : '';

  // Disk
  document.getElementById('diskValue').textContent = data.diskUsage || '—';

  // Uptime
  document.getElementById('uptimeValue').textContent = formatUptime(data.uptime);

  // Git
  const git = data.git;
  let gitText = git.branch || '—';
  if (git.dirty > 0 || git.untracked > 0) {
    gitText += ` (${git.dirty}Δ ${git.untracked}?)`;
  }
  document.getElementById('gitValue').textContent = gitText;
}

// ============================
// Sessions Overview
// ============================
async function loadSessions() {
  const data = await dashApi('/api/stats/sessions');
  const container = document.getElementById('sessionsGrid');
  const countEl = document.getElementById('sessionsCount');

  if (!data || data.length === 0) {
    container.innerHTML = `
      <div class="dash-empty">
        <div class="dash-empty-icon">💬</div>
        <div class="dash-empty-text">No sessions yet</div>
      </div>`;
    countEl.textContent = '0 sessions';
    return;
  }

  countEl.textContent = `${data.length} session${data.length !== 1 ? 's' : ''}`;

  // Show only first 12 sessions max
  const sessions = data.slice(0, 12);
  container.innerHTML = sessions.map(s => {
    const isActive = s.isActive;
    const lastActive = s.lastActive ? timeAgo(s.lastActive) : 'never';
    const folder = s.folder ? s.folder.split('/').pop() : '';
    return `
      <div class="dash-session-card ${isActive ? 'active' : ''}">
        <div class="dash-session-status ${isActive ? 'active' : ''}"></div>
        <div class="dash-session-info">
          <div class="dash-session-name">${escapeHtml(s.name)}</div>
          <div class="dash-session-meta">${folder ? escapeHtml(folder) + ' · ' : ''}${lastActive}</div>
        </div>
        <div class="dash-session-msgs">${s.messageCount || 0} msgs</div>
      </div>
    `;
  }).join('');

  if (data.length > 12) {
    container.innerHTML += `<div class="dash-session-card" style="justify-content:center;color:var(--text-tertiary);">+${data.length - 12} more</div>`;
  }
}

// ============================
// Task Run History
// ============================
async function loadTaskRuns() {
  const data = await dashApi('/api/stats/task-runs');
  const container = document.getElementById('taskRunsTable');

  if (!data || data.length === 0) {
    container.innerHTML = `
      <div class="dash-empty">
        <div class="dash-empty-icon">⏰</div>
        <div class="dash-empty-text">No task runs yet</div>
      </div>`;
    return;
  }

  const rows = data.map(run => {
    const statusClass = `dash-status-${run.status}`;
    const startedAt = run.started_at ? new Date(run.started_at).toLocaleString() : '—';
    let duration = '—';
    if (run.started_at && run.finished_at) {
      const ms = new Date(run.finished_at) - new Date(run.started_at);
      duration = formatDuration(ms / 1000);
    } else if (run.status === 'running') {
      duration = 'running...';
    }
    return `
      <tr>
        <td>${escapeHtml(run.task_name || run.task_id)}</td>
        <td><span class="dash-status ${statusClass}">${run.status}</span></td>
        <td>${run.trigger_type || '—'}</td>
        <td>${startedAt}</td>
        <td>${duration}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="dash-table">
      <thead>
        <tr>
          <th>Task</th>
          <th>Status</th>
          <th>Trigger</th>
          <th>Started</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ============================
// Escape HTML
// ============================
function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text || '';
  return el.innerHTML;
}

// ============================
// Load All Data
// ============================
async function loadAll() {
  await Promise.all([
    loadActivityChart(),
    loadCostChart(),
    loadSystemHealth(),
    loadSessions(),
    loadTaskRuns(),
  ]);
  updateTimestamp();
}

// ============================
// Initialization
// ============================
document.addEventListener('DOMContentLoaded', () => {
  configureChartDefaults();

  // Initial load
  loadAll();

  // Refresh button
  document.getElementById('dashRefreshBtn').addEventListener('click', () => {
    loadAll();
  });

  // Auto-refresh data every 30 seconds
  autoRefreshInterval = setInterval(() => {
    loadAll();
  }, 30000);

  // System health refresh every 10 seconds
  healthRefreshInterval = setInterval(() => {
    loadSystemHealth();
  }, 10000);

  // Update "last updated" display every second
  setInterval(tickTimestamp, 1000);
});
