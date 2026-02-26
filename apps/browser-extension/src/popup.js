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
    // Auto-fill name from button text
    if (!$name.value.trim()) {
      $name.value = btn.textContent;
    }
  });
});

// Auto-fill name when domain changes
$domain.addEventListener('input', () => {
  if ($name.value.trim()) return;
  const domain = $domain.value.trim();
  if (domain) {
    // Capitalize first letter of domain without TLD
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
        `Cookie set ID: ${response.result.id}`
      );
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
        // Show first few lines as preview
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

// ── Init ──────────────────────────────────────────────────────────────────

loadSettings();
