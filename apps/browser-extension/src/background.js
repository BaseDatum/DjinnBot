/**
 * DjinnBot Cookie Bridge — Background Service Worker
 *
 * Handles cookie extraction, upload, and periodic auto-sync to the
 * DjinnBot API.  Tracked sites are re-synced every 30 minutes so
 * that granted agents always have fresh session cookies.
 *
 * Runs as a service worker (Chrome) or background script (Firefox).
 */

// Use browser namespace if available (Firefox), fall back to chrome (Chrome)
const api = typeof browser !== 'undefined' ? browser : chrome;

/** Alarm name used for the periodic cookie sync. */
const SYNC_ALARM = 'cookie-sync';

/** Sync interval — Chrome alarms minimum is 1 minute. */
const SYNC_INTERVAL_MINUTES = 30;

// ── Cookie helpers ────────────────────────────────────────────────────────

/**
 * Get all cookies for a domain, including HttpOnly ones.
 */
async function getCookiesForDomain(domain) {
  const normalizedDomain = domain.startsWith('.') ? domain : `.${domain}`;

  const [exact, dotPrefixed] = await Promise.all([
    api.cookies.getAll({ domain }),
    api.cookies.getAll({ domain: normalizedDomain }),
  ]);

  // Deduplicate by name+domain+path
  const seen = new Set();
  const all = [];
  for (const cookie of [...exact, ...dotPrefixed]) {
    const key = `${cookie.name}|${cookie.domain}|${cookie.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(cookie);
    }
  }
  return all;
}

/**
 * Convert browser cookies to Netscape cookie format string.
 */
function toNetscapeFormat(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Exported by DjinnBot Cookie Bridge'];
  for (const c of cookies) {
    const httpOnly = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expires = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push(`${c.domain}\t${httpOnly}\t${c.path}\t${secure}\t${expires}\t${c.name}\t${c.value}`);
  }
  return lines.join('\n');
}

// ── Tracked sites storage ─────────────────────────────────────────────────

/**
 * @typedef {Object} TrackedSite
 * @property {string} domain       — e.g. "linkedin.com"
 * @property {string} name         — human label, e.g. "LinkedIn"
 * @property {string} cookieSetId  — DjinnBot cookie set ID (ck_xxx)
 * @property {number} addedAt      — epoch ms when tracking started
 * @property {number} lastSyncedAt — epoch ms of last successful sync (0 = never)
 * @property {string} status       — "ok" | "error" | "disconnected"
 * @property {string} [lastError]  — last error message (if status != "ok")
 */

/** Load tracked sites from storage. */
async function getTrackedSites() {
  const data = await api.storage.local.get(['trackedSites']);
  return data.trackedSites || [];
}

/** Save tracked sites to storage. */
async function setTrackedSites(sites) {
  await api.storage.local.set({ trackedSites: sites });
}

/** Add a site to the tracked list. */
async function addTrackedSite(domain, name, cookieSetId) {
  const sites = await getTrackedSites();
  // Replace if same domain+name already tracked
  const idx = sites.findIndex(s => s.cookieSetId === cookieSetId);
  const entry = {
    domain,
    name,
    cookieSetId,
    addedAt: Date.now(),
    lastSyncedAt: Date.now(), // just uploaded, counts as synced
    status: 'ok',
  };
  if (idx >= 0) {
    sites[idx] = entry;
  } else {
    sites.push(entry);
  }
  await setTrackedSites(sites);
  await ensureSyncAlarm();
  return entry;
}

/** Remove a site from the tracked list. */
async function removeTrackedSite(cookieSetId) {
  const sites = await getTrackedSites();
  const filtered = sites.filter(s => s.cookieSetId !== cookieSetId);
  await setTrackedSites(filtered);
  // If no more sites, clear the alarm
  if (filtered.length === 0) {
    api.alarms.clear(SYNC_ALARM);
  }
}

// ── API calls ─────────────────────────────────────────────────────────────

/** Load API settings from storage. */
async function getApiSettings() {
  const data = await api.storage.local.get(['apiUrl', 'token']);
  return { apiUrl: data.apiUrl || '', token: data.token || '' };
}

/** Build auth headers. */
function authHeaders(token) {
  const h = {};
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/**
 * Upload cookies as a NEW cookie set (POST).
 */
async function uploadToDjinnBot(apiUrl, token, name, cookieText) {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('cookie_file', new Blob([cookieText], { type: 'text/plain' }), `${name}.txt`);

  const response = await fetch(`${apiUrl}/v1/browser/cookies`, {
    method: 'POST',
    headers: authHeaders(token),
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json();
}

/**
 * Update cookies for an EXISTING cookie set (PUT).
 * This is the endpoint used for periodic sync.
 */
async function updateCookiesOnApi(apiUrl, token, cookieSetId, cookieText) {
  const formData = new FormData();
  formData.append('cookie_file', new Blob([cookieText], { type: 'text/plain' }), 'cookies.txt');

  const response = await fetch(`${apiUrl}/v1/browser/cookies/${cookieSetId}/content`, {
    method: 'PUT',
    headers: authHeaders(token),
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${response.status}: ${text}`);
  }

  return response.json();
}

// ── Sync engine ───────────────────────────────────────────────────────────

/**
 * Sync a single tracked site: re-extract cookies and push to API.
 * Returns the updated site entry.
 */
async function syncSite(site) {
  const { apiUrl, token } = await getApiSettings();
  if (!apiUrl) {
    return { ...site, status: 'error', lastError: 'API URL not configured' };
  }

  try {
    const cookies = await getCookiesForDomain(site.domain);
    if (cookies.length === 0) {
      return { ...site, status: 'error', lastError: 'No cookies found for domain' };
    }

    const netscape = toNetscapeFormat(cookies);
    await updateCookiesOnApi(apiUrl, token, site.cookieSetId, netscape);

    return {
      ...site,
      lastSyncedAt: Date.now(),
      status: 'ok',
      lastError: undefined,
    };
  } catch (err) {
    const msg = err.message || String(err);
    // 404 means the cookie set was deleted on the server
    if (msg.includes('404')) {
      return { ...site, status: 'disconnected', lastError: 'Cookie set deleted on server' };
    }
    return { ...site, status: 'error', lastError: msg };
  }
}

/**
 * Sync all tracked sites that are not disconnected.
 */
async function syncAllTracked() {
  const sites = await getTrackedSites();
  if (sites.length === 0) return;

  console.log(`[Cookie Bridge] Syncing ${sites.length} tracked site(s)...`);

  const updated = [];
  for (const site of sites) {
    if (site.status === 'disconnected') {
      updated.push(site); // skip disconnected
      continue;
    }
    const result = await syncSite(site);
    updated.push(result);
  }

  await setTrackedSites(updated);
  updateBadge(updated);
  console.log('[Cookie Bridge] Sync complete.');
}

// ── Alarm / startup ───────────────────────────────────────────────────────

/** Ensure the periodic sync alarm exists if there are tracked sites. */
async function ensureSyncAlarm() {
  const sites = await getTrackedSites();
  if (sites.length > 0) {
    const existing = await api.alarms.get(SYNC_ALARM);
    if (!existing) {
      api.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
      console.log(`[Cookie Bridge] Sync alarm created (every ${SYNC_INTERVAL_MINUTES}m)`);
    }
  }
}

/** Update the extension badge to show error count. */
function updateBadge(sites) {
  const errorCount = sites.filter(s => s.status !== 'ok').length;
  if (errorCount > 0) {
    api.action.setBadgeText({ text: String(errorCount) });
    api.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    api.action.setBadgeText({ text: '' });
  }
}

// Alarm listener — fires every SYNC_INTERVAL_MINUTES
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) {
    syncAllTracked();
  }
});

// Browser startup — sync immediately and ensure alarm is running
api.runtime.onStartup.addListener(() => {
  console.log('[Cookie Bridge] Browser startup — running sync');
  ensureSyncAlarm();
  syncAllTracked();
});

// Extension install/update — set up alarm
api.runtime.onInstalled.addListener(() => {
  ensureSyncAlarm();
});

// ── Message listener ──────────────────────────────────────────────────────

api.runtime.onMessage.addListener((message, sender, sendResponse) => {

  // Preview cookies for a domain (no upload)
  if (message.type === 'EXTRACT_COOKIES') {
    getCookiesForDomain(message.domain)
      .then(cookies => {
        const netscape = toNetscapeFormat(cookies);
        sendResponse({ success: true, count: cookies.length, netscape });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // Extract cookies from browser and upload as a NEW cookie set,
  // then add to the tracked sites list for auto-sync.
  if (message.type === 'EXTRACT_AND_UPLOAD') {
    getCookiesForDomain(message.domain)
      .then(async cookies => {
        if (cookies.length === 0) {
          sendResponse({ success: false, error: 'No cookies found for this domain' });
          return;
        }
        const netscape = toNetscapeFormat(cookies);
        const result = await uploadToDjinnBot(
          message.apiUrl, message.token, message.name, netscape
        );
        // Auto-track this site for periodic sync
        await addTrackedSite(message.domain, message.name, result.id);
        sendResponse({ success: true, count: cookies.length, result });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  // Get the tracked sites list (for popup display)
  if (message.type === 'GET_TRACKED_SITES') {
    getTrackedSites()
      .then(sites => sendResponse({ success: true, sites }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Sync a single tracked site right now
  if (message.type === 'SYNC_SITE') {
    (async () => {
      const sites = await getTrackedSites();
      const idx = sites.findIndex(s => s.cookieSetId === message.cookieSetId);
      if (idx < 0) {
        sendResponse({ success: false, error: 'Site not tracked' });
        return;
      }
      const updated = await syncSite(sites[idx]);
      sites[idx] = updated;
      await setTrackedSites(sites);
      updateBadge(sites);
      sendResponse({ success: true, site: updated });
    })().catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Sync all tracked sites right now
  if (message.type === 'SYNC_ALL') {
    syncAllTracked()
      .then(async () => {
        const sites = await getTrackedSites();
        sendResponse({ success: true, sites });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Remove a site from tracking
  if (message.type === 'REMOVE_TRACKED_SITE') {
    removeTrackedSite(message.cookieSetId)
      .then(async () => {
        const sites = await getTrackedSites();
        updateBadge(sites);
        sendResponse({ success: true, sites });
      })
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
