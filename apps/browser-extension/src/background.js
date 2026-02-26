/**
 * DjinnBot Cookie Bridge — Background Service Worker
 *
 * Handles cookie extraction and upload to the DjinnBot API.
 * Runs as a service worker (Chrome) or background script (Firefox).
 */

// Use browser namespace if available (Firefox), fall back to chrome (Chrome)
const api = typeof browser !== 'undefined' ? browser : chrome;

/**
 * Get all cookies for a domain, including HttpOnly ones.
 */
async function getCookiesForDomain(domain) {
  // Normalize domain — ensure it starts with a dot for subdomain matching
  const normalizedDomain = domain.startsWith('.') ? domain : `.${domain}`;

  // Get cookies for both the exact domain and the dot-prefixed domain
  const [exact, dotPrefixed] = await Promise.all([
    api.cookies.getAll({ domain: domain }),
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

/**
 * Upload cookies to DjinnBot API.
 */
async function uploadToDjinnBot(apiUrl, token, name, cookieText) {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('user_id', 'system');
  formData.append('cookie_file', new Blob([cookieText], { type: 'text/plain' }), `${name}.txt`);

  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${apiUrl}/v1/browser/cookies`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  return response.json();
}

// Listen for messages from the popup
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'EXTRACT_COOKIES') {
    getCookiesForDomain(message.domain)
      .then(cookies => {
        const netscape = toNetscapeFormat(cookies);
        sendResponse({ success: true, count: cookies.length, netscape });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // async response
  }

  if (message.type === 'UPLOAD_COOKIES') {
    uploadToDjinnBot(message.apiUrl, message.token, message.name, message.netscape)
      .then(result => {
        sendResponse({ success: true, result });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // async response
  }

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
        sendResponse({ success: true, count: cookies.length, result });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // async response
  }
});
