/**
 * DjinnBot Cookie Bridge — Popup Script
 */

const api = typeof browser !== 'undefined' ? browser : chrome;

const $apiUrl = document.getElementById('apiUrl');
const $token = document.getElementById('token');
const $domain = document.getElementById('domain');
const $name = document.getElementById('name');
const $extractAndUpload = document.getElementById('extractAndUpload');
const $extractOnly = document.getElementById('extractOnly');
const $status = document.getElementById('status');
const $preview = document.getElementById('preview');
const $saved = document.getElementById('saved');
const $trackedList = document.getElementById('trackedList');
const $syncAllBtn = document.getElementById('syncAllBtn');
const $syncInfo = document.getElementById('syncInfo');

// ── Persist settings ──────────────────────────────────────────────────────

async function loadSettings() {
  const data = await api.storage.local.get(['apiUrl', 'token']);
  if (data.apiUrl) $apiUrl.value = data.apiUrl;
  if (data.token) $token.value = data.token;
}

async function saveSettings() {
  await api.storage.local.set({
    apiUrl: $apiUrl.value.trim(),
    token: $token.value.trim(),
  });
  $saved.classList.add('visible');
  setTimeout(() => $saved.classList.remove('visible'), 1500);
}

$apiUrl.addEventListener('change', saveSettings);
$token.addEventListener('change', saveSettings);

// ── Quick domain buttons ──────────────────────────────────────────────────

document.querySelectorAll('.quick-domain').forEach(btn => {
  btn.addEventListener('click', () => {
    const domain = btn.dataset.domain;
    $domain.value = domain;
    if (!$name.value.trim()) {
      $name.value = btn.textContent;
    }
  });
});

$domain.addEventListener('input', () => {
  if ($name.value.trim()) return;
  const domain = $domain.value.trim();
  if (domain) {
    const base = domain.replace(/^\./, '').split('.')[0];
    $name.value = base.charAt(0).toUpperCase() + base.slice(1);
  }
});

// ── Status display ────────────────────────────────────────────────────────

function showStatus(type, text) {
  $status.className = `status ${type}`;
  $status.textContent = text;
}

function clearStatus() {
  $status.className = 'status';
  $status.textContent = '';
}

function setLoading(btn, loading) {
  btn.disabled = loading;
  if (loading) {
    btn.dataset.originalText = btn.innerHTML;
    btn.innerHTML = '<div class="spinner"></div> Working...';
  } else {
    btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
  }
}

// ── Time formatting ───────────────────────────────────────────────────────

function timeAgo(ms) {
  if (!ms) return 'never';
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ── Extract & Upload ──────────────────────────────────────────────────────

$extractAndUpload.addEventListener('click', async () => {
  const domain = $domain.value.trim();
  const name = $name.value.trim();
  const apiUrl = $apiUrl.value.trim();
  const token = $token.value.trim();

  if (!domain) { showStatus('error', 'Enter a domain'); return; }
  if (!name) { showStatus('error', 'Enter a name for this cookie set'); return; }
  if (!apiUrl) { showStatus('error', 'Enter your DjinnBot API URL in settings'); return; }

  clearStatus();
  $preview.style.display = 'none';
  setLoading($extractAndUpload, true);

  try {
    const response = await api.runtime.sendMessage({
      type: 'EXTRACT_AND_UPLOAD',
      domain, name, apiUrl, token,
    });

    if (response.success) {
      showStatus('success',
        `Sent ${response.count} cookies to DjinnBot (${response.result.domain}). ` +
        `Now tracking for auto-sync.`
      );
      // Refresh tracked list
      await loadTrackedSites();
    } else {
      showStatus('error', response.error || 'Unknown error');
    }
  } catch (err) {
    showStatus('error', `Failed: ${err.message}`);
  } finally {
    setLoading($extractAndUpload, false);
  }
});

// ── Preview only ──────────────────────────────────────────────────────────

$extractOnly.addEventListener('click', async () => {
  const domain = $domain.value.trim();
  if (!domain) { showStatus('error', 'Enter a domain'); return; }

  clearStatus();
  setLoading($extractOnly, true);

  try {
    const response = await api.runtime.sendMessage({
      type: 'EXTRACT_COOKIES',
      domain,
    });

    if (response.success) {
      showStatus('info', `Found ${response.count} cookies for ${domain}`);
      if (response.count > 0) {
        const lines = response.netscape.split('\n');
        const preview = lines.slice(0, 12).join('\n') +
          (lines.length > 12 ? `\n... (${lines.length - 2} total cookies)` : '');
        $preview.textContent = preview;
        $preview.style.display = 'block';
      }
    } else {
      showStatus('error', response.error || 'Unknown error');
    }
  } catch (err) {
    showStatus('error', `Failed: ${err.message}`);
  } finally {
    setLoading($extractOnly, false);
  }
});

// ── Tracked sites ─────────────────────────────────────────────────────────

async function loadTrackedSites() {
  try {
    const response = await api.runtime.sendMessage({ type: 'GET_TRACKED_SITES' });
    if (!response.success) return;
    renderTrackedSites(response.sites);
  } catch (err) {
    console.error('Failed to load tracked sites:', err);
  }
}

function renderTrackedSites(sites) {
  if (!sites || sites.length === 0) {
    $trackedList.innerHTML = '<div class="tracked-empty">No tracked sites. Send cookies to DjinnBot to start auto-syncing.</div>';
    $syncAllBtn.style.display = 'none';
    $syncInfo.textContent = '';
    return;
  }

  $syncAllBtn.style.display = '';
  const okCount = sites.filter(s => s.status === 'ok').length;
  $syncInfo.textContent = `${okCount}/${sites.length} synced`;

  $trackedList.innerHTML = sites.map(site => `
    <div class="tracked-site" data-id="${site.cookieSetId}">
      <div class="status-dot ${site.status}" title="${site.status}${site.lastError ? ': ' + site.lastError : ''}"></div>
      <div class="tracked-info">
        <div class="tracked-name">${escapeHtml(site.name)}</div>
        <div class="tracked-meta">
          ${escapeHtml(site.domain)}
          &middot; synced ${timeAgo(site.lastSyncedAt)}
          ${site.status === 'disconnected' ? ' &middot; <span style="color:#f87171">deleted on server</span>' : ''}
          ${site.status === 'error' && site.lastError ? ' &middot; <span style="color:#f87171">error</span>' : ''}
        </div>
      </div>
      <div class="tracked-actions">
        ${site.status !== 'disconnected' ? `<button class="btn btn-secondary btn-sm sync-one-btn" data-id="${site.cookieSetId}" title="Sync now">Sync</button>` : ''}
        <button class="btn btn-danger btn-sm remove-btn" data-id="${site.cookieSetId}" title="Stop tracking">Remove</button>
      </div>
    </div>
  `).join('');

  // Attach event listeners
  $trackedList.querySelectorAll('.sync-one-btn').forEach(btn => {
    btn.addEventListener('click', () => syncOneSite(btn.dataset.id, btn));
  });
  $trackedList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeSite(btn.dataset.id));
  });
}

async function syncOneSite(cookieSetId, btn) {
  if (btn) setLoading(btn, true);
  try {
    const response = await api.runtime.sendMessage({
      type: 'SYNC_SITE',
      cookieSetId,
    });
    if (response.success) {
      await loadTrackedSites();
    } else {
      showStatus('error', response.error || 'Sync failed');
    }
  } catch (err) {
    showStatus('error', `Sync failed: ${err.message}`);
  } finally {
    if (btn) setLoading(btn, false);
  }
}

async function removeSite(cookieSetId) {
  try {
    const response = await api.runtime.sendMessage({
      type: 'REMOVE_TRACKED_SITE',
      cookieSetId,
    });
    if (response.success) {
      renderTrackedSites(response.sites);
    }
  } catch (err) {
    showStatus('error', `Remove failed: ${err.message}`);
  }
}

$syncAllBtn.addEventListener('click', async () => {
  setLoading($syncAllBtn, true);
  try {
    const response = await api.runtime.sendMessage({ type: 'SYNC_ALL' });
    if (response.success) {
      renderTrackedSites(response.sites);
    } else {
      showStatus('error', response.error || 'Sync failed');
    }
  } catch (err) {
    showStatus('error', `Sync failed: ${err.message}`);
  } finally {
    setLoading($syncAllBtn, false);
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Init ──────────────────────────────────────────────────────────────────

loadSettings();
loadTrackedSites();
