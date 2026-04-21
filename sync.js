/**
 * JodyOS GitHub Sync Module
 * Version: 3.0.0
 *
 * Bidirectional sync between localStorage (jos_ prefix) and a single
 * data.json file in a GitHub repo via the GitHub Contents API.
 * Authentication uses a Personal Access Token (PAT) — no OAuth, no CORS issues.
 *
 * ─── Public API ───────────────────────────────────────────────────────────
 *   JodySync.init()          — call on page load, pulls if remote is newer
 *   JodySync.pull()          — fetch data.json from GitHub → localStorage
 *   JodySync.push()          — localStorage snapshot → GitHub data.json
 *   JodySync.schedulePush()  — debounced 3s push, call after every save
 *   JodySync.configure({pat, repo, device}) — save config
 *   JodySync.clearConfig()   — disconnect
 *   JodySync.getStatus()     — { configured, device, lastSync, pushing }
 *   JodySync.onStatusChange(fn) — subscribe to status changes
 *
 * ─── Config keys (jos_sync_ prefix) ──────────────────────────────────────
 *   jos_sync_pat      GitHub Personal Access Token
 *   jos_sync_repo     GitHub repo e.g. "escheron-repoadmin/jody-os"
 *   jos_sync_device   Device label e.g. "iOS", "Desktop"
 *   jos_sync_last     ISO timestamp of last successful sync
 *   jos_sync_sha      Latest data.json blob SHA (required for updates)
 *
 * ─── GitHub PAT setup (2 minutes) ────────────────────────────────────────
 *   1. github.com → Settings → Developer settings → Personal access tokens
 *      → Fine-grained tokens → Generate new token
 *   2. Repository access: Only select repositories → jody-os
 *   3. Permissions → Repository permissions → Contents → Read and write
 *   4. Generate token → copy it → paste into JodyOS sync setup
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.JodySync = factory(); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const DATA_PREFIX   = 'jos_';
  const CONFIG_PREFIX = 'jos_sync_';
  const DATA_VERSION  = 3;
  const PUSH_DEBOUNCE = 3000;
  const META_KEY      = '_meta';
  const DATA_FILE     = 'data.json';

  let _pushTimer  = null;
  let _pushing    = false;
  let _listeners  = [];

  // ── Config ────────────────────────────────────────────────────────────────
  const cfgGet = (k, d = '') => { try { const v = localStorage.getItem(CONFIG_PREFIX + k); return v !== null ? v : d; } catch { return d; } };
  const cfgSet = (k, v)      => { try { localStorage.setItem(CONFIG_PREFIX + k, String(v)); } catch {} };
  const cfgDel = k           => { try { localStorage.removeItem(CONFIG_PREFIX + k); } catch {} };

  function getConfig() {
    return {
      pat:    cfgGet('pat'),
      repo:   cfgGet('repo'),
      device: cfgGet('device', _defaultDevice()),
      last:   cfgGet('last'),
      sha:    cfgGet('sha'),
    };
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c.pat && c.repo);
  }

  function _defaultDevice() {
    try {
      const ua = navigator.userAgent;
      if (/iPhone|iPad/.test(ua)) return 'iOS';
      if (/Android/.test(ua))     return 'Android';
      if (/Mac/.test(ua))         return 'Mac';
      if (/Win/.test(ua))         return 'Windows';
    } catch {}
    return 'Desktop';
  }

  // ── GitHub API ────────────────────────────────────────────────────────────
  function _apiUrl() {
    const { repo } = getConfig();
    return `https://api.github.com/repos/${repo}/contents/${DATA_FILE}`;
  }

  async function _ghGet() {
    const { pat } = getConfig();
    const res = await fetch(_apiUrl(), {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`GitHub GET ${res.status}: ${txt}`);
    }
    const j = await res.json();
    cfgSet('sha', j.sha);
    // Content is base64 encoded
    const decoded = atob(j.content.replace(/\n/g, ''));
    return decoded;
  }

  async function _ghPut(content) {
    const { pat, device, sha } = getConfig();
    const encoded = btoa(unescape(encodeURIComponent(content)));
    const body = {
      message: `JodyOS sync from ${device} · ${new Date().toISOString()}`,
      content: encoded,
      ...(sha ? { sha } : {}),
    };
    const res = await fetch(_apiUrl(), {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      const err = new Error(`GitHub PUT ${res.status}: ${txt}`);
      err.status = res.status;
      throw err;
    }
    const j = await res.json();
    cfgSet('sha', j.content.sha);
    return true;
  }

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
    } catch {}
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

  // ── Status ────────────────────────────────────────────────────────────────
  function _notify() { _listeners.forEach(fn => { try { fn(getStatus()); } catch {} }); }

  function getStatus() {
    const c = getConfig();
    return { configured: isConfigured(), device: c.device, lastSync: c.last || null, pushing: _pushing };
  }

  function onStatusChange(fn) {
    _listeners.push(fn);
    return () => { _listeners = _listeners.filter(f => f !== fn); };
  }

  // ── PULL ──────────────────────────────────────────────────────────────────
  async function pull() {
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };
    try {
      const raw = await _ghGet();
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


  async function _refreshSha() {
    try {
      const { pat } = getConfig();
      const res = await fetch(_apiUrl(), {
        headers: {
          'Authorization': `Bearer ${pat}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }
      });
      if (res.ok) { const j = await res.json(); cfgSet('sha', j.sha); return true; }
    } catch {}
    return false;
  }

  // ── PUSH ──────────────────────────────────────────────────────────────────
  async function push() {
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };
    if (_pushing)        return { ok: false, reason: 'already_pushing' };

    _pushing = true;
    _notify();

    try {
      // Always pull first so our SHA is current and we don't overwrite newer remote data
      const raw = await _ghGet();
      if (raw) {
        const remote     = JSON.parse(raw);
        const remoteMeta = remote[META_KEY] || {};
        const remoteTime = remoteMeta.updated ? new Date(remoteMeta.updated).getTime() : 0;
        const lastTime   = cfgGet('last') ? new Date(cfgGet('last')).getTime() : 0;
        if (remoteTime > lastTime) {
          _apply(remote);
          cfgSet('last', remoteMeta.updated || new Date().toISOString());
          _notify();
        }
      }

      const now = new Date().toISOString();
      const snapshot = _snapshot();
      snapshot[META_KEY] = { updated: now, device: cfgGet('device', _defaultDevice()), version: DATA_VERSION };
      await _ghPut(JSON.stringify(snapshot, null, 2));
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
  function configure({ pat, repo, device } = {}) {
    if (pat)    cfgSet('pat',    pat.trim());
    if (repo)   cfgSet('repo',   repo.trim());
    if (device) cfgSet('device', device.trim());
    _notify();
  }

  function clearConfig() {
    ['pat','repo','device','last','sha'].forEach(k => cfgDel(k));
    _notify();
  }

  // ── INIT ──────────────────────────────────────────────────────────────────
  async function init() {
    if (!isConfigured()) return { ok: false, reason: 'not_configured' };
    return pull();
  }

  return { init, pull, push, schedulePush, configure, clearConfig, getStatus, onStatusChange, _snapshot };
}));
