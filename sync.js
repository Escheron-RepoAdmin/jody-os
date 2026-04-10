/**
 * JodyOS OneDrive Sync Module
 * Version: 2.0.0
 *
 * Bidirectional sync between localStorage (jos_ prefix) and a single
 * data.json file in OneDrive via the Microsoft Graph API.
 * Authentication uses the OAuth2 device code flow — no redirect URI,
 * no server, no secrets stored anywhere except refresh tokens in localStorage.
 *
 * ─── Public API ───────────────────────────────────────────────────────────
 *
 *   JodySync.init()
 *     Call once on page load. Pulls remote data if configured and newer.
 *     Returns { ok, applied?, skipped?, empty?, reason? }
 *
 *   JodySync.pull()
 *     Fetch data.json from OneDrive → apply to localStorage if remote is newer.
 *     Returns { ok, applied?, skipped?, empty?, reason? }
 *
 *   JodySync.push()
 *     Write localStorage snapshot → OneDrive data.json.
 *     Returns { ok, reason? }
 *
 *   JodySync.schedulePush()
 *     Debounced push (3s). Call after every localStorage write.
 *
 *   JodySync.startDeviceFlow(clientId)
 *     Starts the device code auth flow.
 *     Returns { device_code, user_code, verification_uri, expires_in, interval }
 *
 *   JodySync.pollDeviceFlow(clientId, deviceCode, interval, onUpdate?)
 *     Polls for token after user signs in. Saves tokens on success.
 *     onUpdate(status) called with 'pending' | 'network_error' each poll.
 *     Returns { ok, reason? }
 *
 *   JodySync.cancelDeviceFlow()
 *     Cancels an in-progress poll.
 *
 *   JodySync.configure({ clientId?, device? })
 *     Save config values to localStorage.
 *
 *   JodySync.clearConfig()
 *     Remove all sync config. Data is untouched.
 *
 *   JodySync.getStatus()
 *     Returns { configured, device, lastSync, pushing, tokenExpiry }
 *
 *   JodySync.onStatusChange(fn)
 *     Subscribe to status changes. Returns unsubscribe function.
 *
 * ─── Config keys (jos_sync_ prefix in localStorage) ──────────────────────
 *
 *   jos_sync_client_id      Azure App (client) ID
 *   jos_sync_access_token   Current access token (expires ~1hr)
 *   jos_sync_refresh_token  Refresh token (valid 90 days, renews on use)
 *   jos_sync_token_expiry   ISO timestamp of access token expiry
 *   jos_sync_last           ISO timestamp of last successful sync
 *   jos_sync_device         Device label (e.g. "Desktop", "iOS")
 *
 * ─── data.json format ────────────────────────────────────────────────────
 *
 *   {
 *     "_meta": { "updated": "ISO", "device": "Desktop", "version": 2 },
 *     "jos_tasks_creation": "[...]",
 *     "jos_tasks_admin": "[...]",
 *     ... all jos_ keys exactly as stored in localStorage
 *   }
 *
 * ─── Azure App setup (one-time, ~5 minutes) ───────────────────────────────
 *
 *   1. portal.azure.com → Azure Active Directory → App registrations → New
 *   2. Supported account types: Personal Microsoft accounts only
 *   3. Redirect URI: Mobile and desktop applications →
 *      https://login.microsoftonline.com/common/oauth2/nativeclient
 *   4. Under Authentication → enable "Allow public client flows" → Yes
 *   5. Copy the Application (client) ID
 *
 * ─── PWA wiring ───────────────────────────────────────────────────────────
 *
 *   // After your ls_set / ls_setJSON definitions:
 *   const _orig = ls_set;
 *   ls_set = (k, v) => { _orig(k, v); JodySync.schedulePush(); };
 *
 *   // On app load:
 *   JodySync.init().then(r => { if (r.applied) reloadViews(); });
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JodySync = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const DATA_PREFIX    = 'jos_';
  const CONFIG_PREFIX  = 'jos_sync_';
  const DATA_VERSION   = 2;
  const PUSH_DEBOUNCE  = 3000;
  const META_KEY       = '_meta';
  const GRAPH_FILE_URL = 'https://graph.microsoft.com/v1.0/me/drive/root:/JodyOS/data.json:/content';
  const TOKEN_URL      = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const DEVICE_URL     = 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode';
  const SCOPE          = 'Files.ReadWrite offline_access';

  let _pushTimer  = null;
  let _pushing    = false;
  let _listeners  = [];
  let _pollCancel = false;

  // ── Config helpers ────────────────────────────────────────────────────────
  const cfgGet = (k, d = '') => {
    try { const v = localStorage.getItem(CONFIG_PREFIX + k); return v !== null ? v : d; }
    catch (e) { return d; }
  };
  const cfgSet = (k, v) => { try { localStorage.setItem(CONFIG_PREFIX + k, String(v)); } catch (e) {} };
  const cfgDel = k       => { try { localStorage.removeItem(CONFIG_PREFIX + k); } catch (e) {} };

  function getConfig() {
    return {
      clientId:     cfgGet('client_id'),
      accessToken:  cfgGet('access_token'),
      refreshToken: cfgGet('refresh_token'),
      tokenExpiry:  cfgGet('token_expiry'),
      last:         cfgGet('last'),
      device:       cfgGet('device', _defaultDevice()),
    };
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c.clientId && c.refreshToken);
  }

  function _defaultDevice() {
    try {
      const ua = navigator.userAgent;
      if (/iPhone|iPad/.test(ua)) return 'iOS';
      if (/Android/.test(ua))     return 'Android';
      if (/Mac/.test(ua))         return 'Mac';
      if (/Win/.test(ua))         return 'Windows';
    } catch (e) {}
    return 'Desktop';
  }

  // ── Token management ──────────────────────────────────────────────────────
  function _isTokenExpired() {
    const expiry = cfgGet('token_expiry');
    if (!expiry) return true;
    return Date.now() > new Date(expiry).getTime() - 60000;
  }

  async function _refreshAccessToken() {
    const c = getConfig();
    if (!c.clientId || !c.refreshToken) throw new Error('No refresh token available');
    const body = new URLSearchParams({
      client_id:     c.clientId,
      grant_type:    'refresh_token',
      refresh_token: c.refreshToken,
      scope:         SCOPE,
    });
    const res = await fetch(TOKEN_URL, { method: 'POST', body });
    if (!res.ok) {
      const txt = await res.text();
      throw Object.assign(new Error('Token refresh failed: ' + res.status), { status: res.status, body: txt });
    }
    const j = await res.json();
    cfgSet('access_token',  j.access_token);
    cfgSet('refresh_token', j.refresh_token || c.refreshToken);
    cfgSet('token_expiry',  new Date(Date.now() + j.expires_in * 1000).toISOString());
    return j.access_token;
  }

  async function _getToken() {
    if (_isTokenExpired()) return _refreshAccessToken();
    return cfgGet('access_token');
  }

  // ── Device code flow ──────────────────────────────────────────────────────
  async function startDeviceFlow(clientId) {
    const body = new URLSearchParams({ client_id: clientId, scope: SCOPE });
    const res  = await fetch(DEVICE_URL, { method: 'POST', body });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error('Device code request failed (' + res.status + '): ' + txt);
    }
    return res.json();
  }

  async function pollDeviceFlow(clientId, deviceCode, interval, onUpdate) {
    _pollCancel  = false;
    const waitMs = Math.max((interval || 5) + 1, 5) * 1000;
    const wait   = ms => new Promise(r => setTimeout(r, ms));

    while (!_pollCancel) {
      await wait(waitMs);
      if (_pollCancel) break;

      try {
        const body = new URLSearchParams({
          client_id:   clientId,
          grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
        });
        const res = await fetch(TOKEN_URL, { method: 'POST', body });
        const j   = await res.json();

        if (j.access_token) {
          cfgSet('client_id',     clientId);
          cfgSet('access_token',  j.access_token);
          cfgSet('refresh_token', j.refresh_token);
          cfgSet('token_expiry',  new Date(Date.now() + j.expires_in * 1000).toISOString());
          _notify();
          return { ok: true };
        }

        if (j.error === 'authorization_pending') { if (onUpdate) onUpdate('pending'); continue; }
        if (j.error === 'slow_down')             { await wait(5000); continue; }

        return { ok: false, reason: j.error_description || j.error || 'unknown' };

      } catch (e) {
        if (onUpdate) onUpdate('network_error');
      }
    }
    return { ok: false, reason: 'cancelled' };
  }

  function cancelDeviceFlow() { _pollCancel = true; }

  // ── Data snapshot ─────────────────────────────────────────────────────────
  function _snapshot() {
    const data = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(DATA_PREFIX) && !k.startsWith(CONFIG_PREFIX)) {
          data[k] = localStorage.getItem(k);
        }
      }
    } catch (e) {}
    return data;
  }

  function _apply(data) {
    try {
      Object.entries(data).forEach(([k, v]) => {
        if (k.startsWith(DATA_PREFIX) && !k.startsWith(CONFIG_PREFIX) && k !== META_KEY) {
          localStorage.setItem(k, v);
        }
      });
    } catch (e) { console.warn('[JodySync] apply failed:', e); }
  }

  // ── Graph API ─────────────────────────────────────────────────────────────
  async function _graphGet() {
    const token = await _getToken();
    const res   = await fetch(GRAPH_FILE_URL, { headers: { 'Authorization': 'Bearer ' + token } });
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error('Graph GET ' + res.status), { status: res.status });
    return res.text();
  }

  async function _graphPut(content) {
    const token = await _getToken();
    const res   = await fetch(GRAPH_FILE_URL, {
      method:  'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body:    content,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw Object.assign(new Error('Graph PUT ' + res.status), { status: res.status, body: txt });
    }
    return true;
  }

  // ── Status ────────────────────────────────────────────────────────────────
  function _notify() { _listeners.forEach(fn => { try { fn(getStatus()); } catch (e) {} }); }

  function getStatus() {
    const c = getConfig();
    return {
      configured:  isConfigured(),
      device:      c.device,
      lastSync:    c.last        || null,
      tokenExpiry: c.tokenExpiry || null,
      pushing:     _pushing,
    };
  }

  function onStatusChange(fn) {
    _listeners.push(fn);
    return () => { _listeners = _listeners.filter(f => f !== fn); };
  }

  // ── PULL ──────────────────────────────────────────────────────────────────
  async function pull() {
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };
    try {
      const raw = await _graphGet();
      if (!raw) return { ok: true, empty: true };

      const remote     = JSON.parse(raw);
      const remoteMeta = remote[META_KEY] || {};
      const remoteTime = remoteMeta.updated ? new Date(remoteMeta.updated).getTime() : 0;
      const lastTime   = cfgGet('last') ? new Date(cfgGet('last')).getTime() : 0;

      if (remoteTime <= lastTime) return { ok: true, skipped: true };

      _apply(remote);
      cfgSet('last', remoteMeta.updated || new Date().toISOString());
      _notify();
      return { ok: true, applied: true, device: remoteMeta.device };

    } catch (e) {
      console.warn('[JodySync] pull failed:', e);
      return { ok: false, reason: e.message };
    }
  }

  // ── PUSH ──────────────────────────────────────────────────────────────────
  async function push() {
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };
    if (_pushing)        return { ok: false, reason: 'already_pushing' };

    _pushing = true;
    _notify();

    const now = new Date().toISOString();
    try {
      const snapshot   = _snapshot();
      snapshot[META_KEY] = { updated: now, device: cfgGet('device', _defaultDevice()), version: DATA_VERSION };
      await _graphPut(JSON.stringify(snapshot, null, 2));
      cfgSet('last', now);
      _pushing = false;
      _notify();
      return { ok: true };

    } catch (e) {
      _pushing = false;
      _notify();
      console.warn('[JodySync] push failed:', e);
      return { ok: false, reason: e.message };
    }
  }

  // ── SCHEDULED PUSH ────────────────────────────────────────────────────────
  function schedulePush() {
    if (!isConfigured()) return;
    clearTimeout(_pushTimer);
    _pushTimer = setTimeout(() => push(), PUSH_DEBOUNCE);
  }

  // ── CONFIG ────────────────────────────────────────────────────────────────
  function configure({ clientId, device } = {}) {
    if (clientId) cfgSet('client_id', clientId.trim());
    if (device)   cfgSet('device',    device.trim());
    _notify();
  }

  function clearConfig() {
    ['client_id','access_token','refresh_token','token_expiry','last','device'].forEach(k => cfgDel(k));
    _notify();
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  async function init() {
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };
    return pull();
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    init,
    pull,
    push,
    schedulePush,
    configure,
    clearConfig,
    getStatus,
    onStatusChange,
    startDeviceFlow,
    pollDeviceFlow,
    cancelDeviceFlow,
    _snapshot,
  };

}));
