(function () {
  var RUNTIME_SCRIPT_SRC = './generated/wallet-runtime.js';
  var ASSETS = {
    logoBlack: './assets/black_dotskitxt.png',
    logoBlue: './assets/blue_dotski.png',
    logoGreen: './assets/green_dotski.png',
    suiDrop: './assets/sui-drop.svg',
    xIcon: './assets/x-social-icon.svg',
    waapIcon: './assets/waap-icon.svg',
    slushIcon: './assets/wallet-slush.svg',
    phantomIcon: './assets/wallet-phantom.svg',
    backpackIcon: './assets/wallet-backpack.svg',
    suietIcon: './assets/wallet-suiet.svg'
  };
  var WAAP_GOOGLE_ICON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>';

  var GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';
  var COINGECKO_SUI_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';
  var SUI_COIN_TYPE = '0x2::sui::SUI';
  var PORTFOLIO_REFRESH_INTERVAL_MS = 25000;
  var PRICE_CACHE_TTL_MS = 15 * 60 * 1000;
  var PRICE_ERROR_BACKOFF_MS = 30 * 60 * 1000;
  var PRICE_CACHE_STORAGE_KEY = 'ski_cached_sui_usd_price_v1';
  var FOREGROUND_REFRESH_THROTTLE_MS = 30000;

  var state = {
    connected: false,
    sessionOnly: false,
    address: '',
    primaryName: '',
    walletName: '',
    walletIcon: '',
    method: 'wallet',
    sui: 0,
    usd: null,
    menuOpen: false,
    copied: false,
    copiedTimer: null,
    pollTimer: null,
    resolvingName: false,
    lastSessionSyncKey: '',
    lastIkaToastKey: '',
    lastPortfolioFetchMs: 0,
    lastPriceFetchMs: 0,
    priceFetchBlockedUntilMs: 0,
    lastForegroundRefreshMs: 0,
    cachedSuiUsdPrice: null,
    refreshInFlight: false,
    skiActive: false,
    skiBusy: false,
    skiExpiresAtMs: 0
  };

  var els = {
    walletWidget: document.getElementById('wallet-widget'),
    wkWidget: document.getElementById('wk-widget'),
    profileBtn: document.getElementById('wallet-profile-btn'),
    menuRoot: document.getElementById('wallet-menu-root')
  };
  var modalRendered = false;
  var runtimeBootPromise = null;
  var runtimeBound = false;
  var priceFetchInFlight = null;
  var toastSeq = 0;
  var suppressDisconnectedFlash = false;
  var bootHydrating = true;
  var noiseFiltersInstalled = false;

  function isIgnorableWalletNoise(value) {
    var text = String(value || '').toLowerCase();
    if (!text) return false;
    return (
      text.indexOf('cannot redefine property: ethereum') !== -1
      || (
        text.indexOf("failed to execute 'postmessage' on 'window'") !== -1
        && text.indexOf("invalid target origin ''") !== -1
      )
      || text.indexOf('failed to notify account change') !== -1
    );
  }

  function installNoiseFilters() {
    if (noiseFiltersInstalled) return;
    noiseFiltersInstalled = true;

    try {
      window.addEventListener('error', function (event) {
        var message = event && event.message ? String(event.message) : '';
        var file = event && event.filename ? String(event.filename).toLowerCase() : '';
        var knownInjector = file.indexOf('evmask.js') !== -1 || file.indexOf('injected.js') !== -1 || file.indexOf('contentscript.js') !== -1;
        if (!knownInjector && !isIgnorableWalletNoise(message)) return;
        try { if (event && typeof event.preventDefault === 'function') event.preventDefault(); } catch (_e) {}
        try { if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation(); } catch (_e) {}
        try { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); } catch (_e) {}
      }, true);
    } catch (_e) {}
  }

  function parseSuiUsdPrice(payload) {
    var direct = Number(payload && payload.sui && payload.sui.usd);
    if (Number.isFinite(direct) && direct > 0) return direct;
    var flat = Number(payload && payload.usd);
    if (Number.isFinite(flat) && flat > 0) return flat;
    var nested = Number(payload && payload.price && payload.price.usd);
    if (Number.isFinite(nested) && nested > 0) return nested;
    return 0;
  }

  function loadCachedPrice() {
    try {
      var raw = localStorage.getItem(PRICE_CACHE_STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      var price = Number(parsed && parsed.price);
      var ts = Number(parsed && parsed.ts);
      if (!Number.isFinite(price) || price <= 0) return;
      if (!Number.isFinite(ts) || ts <= 0) return;
      state.cachedSuiUsdPrice = price;
      state.lastPriceFetchMs = ts;
    } catch (_e) {}
  }

  function persistCachedPrice(price) {
    try {
      localStorage.setItem(PRICE_CACHE_STORAGE_KEY, JSON.stringify({
        price: price,
        ts: Date.now()
      }));
    } catch (_e) {}
  }

  function getPriceEndpointOverride() {
    try {
      if (typeof window === 'undefined') return '';
      if (typeof window.__wkSuiUsdPriceEndpoint === 'string') {
        return String(window.__wkSuiUsdPriceEndpoint || '').trim();
      }
    } catch (_e) {}
    return '';
  }

  function canUseDirectCoinGecko() {
    try {
      return typeof window !== 'undefined' && window.__wkEnableDirectCoinGecko === true;
    } catch (_e) {
      return false;
    }
  }

  function requestSuiUsdPrice() {
    var now = Date.now();
    if (Number.isFinite(state.cachedSuiUsdPrice) && (now - state.lastPriceFetchMs) < PRICE_CACHE_TTL_MS) {
      return Promise.resolve(state.cachedSuiUsdPrice);
    }
    if (now < state.priceFetchBlockedUntilMs) return Promise.resolve(0);
    if (priceFetchInFlight) return priceFetchInFlight;

    var endpoint = getPriceEndpointOverride();
    var allowDirect = canUseDirectCoinGecko();
    var url = endpoint || (allowDirect ? COINGECKO_SUI_PRICE_URL : '');
    if (!url) {
      state.priceFetchBlockedUntilMs = now + PRICE_ERROR_BACKOFF_MS;
      return Promise.resolve(0);
    }

    priceFetchInFlight = fetch(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit'
    })
      .then(function (response) {
        if (!response || !response.ok) throw new Error('Price fetch failed');
        return response.json();
      })
      .then(function (payload) {
        var price = parseSuiUsdPrice(payload);
        if (!Number.isFinite(price) || price <= 0) {
          state.priceFetchBlockedUntilMs = Date.now() + PRICE_ERROR_BACKOFF_MS;
          return 0;
        }
        state.cachedSuiUsdPrice = price;
        state.lastPriceFetchMs = Date.now();
        state.priceFetchBlockedUntilMs = 0;
        persistCachedPrice(price);
        return price;
      })
      .catch(function () {
        state.priceFetchBlockedUntilMs = Date.now() + PRICE_ERROR_BACKOFF_MS;
        return 0;
      })
      .finally(function () {
        priceFetchInFlight = null;
      });
    return priceFetchInFlight;
  }

  function loadRuntimeScript() {
    if (window.SuiWalletKit) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-wallet-runtime="1"]');
      if (existing) {
        if (existing.dataset.loaded === '1') {
          resolve();
          return;
        }
        existing.addEventListener('load', function onLoad() {
          existing.removeEventListener('load', onLoad);
          existing.removeEventListener('error', onError);
          resolve();
        });
        existing.addEventListener('error', function onError(event) {
          existing.removeEventListener('load', onLoad);
          existing.removeEventListener('error', onError);
          reject(event || new Error('Failed to load wallet runtime'));
        });
        return;
      }

      var script = document.createElement('script');
      script.src = RUNTIME_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.dataset.walletRuntime = '1';
      script.addEventListener('load', function () {
        script.dataset.loaded = '1';
        resolve();
      });
      script.addEventListener('error', function (event) {
        reject(event || new Error('Failed to load wallet runtime'));
      });
      document.head.appendChild(script);
    });
  }

  function ensureWalletRuntime() {
    if (runtimeBootPromise) return runtimeBootPromise;
    runtimeBootPromise = loadRuntimeScript()
      .then(function () { return initWalletRuntime(); })
      .catch(function (error) {
        runtimeBootPromise = null;
        throw error;
      });
    return runtimeBootPromise;
  }

  function ensureToastRoot() {
    var root = document.getElementById('app-toast-root');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'app-toast-root';
    root.className = 'app-toast-root';
    document.body.appendChild(root);
    return root;
  }

  function showToast(message) {
    var text = String(message || '').trim();
    if (!text) return;
    var root = ensureToastRoot();
    var toast = document.createElement('div');
    var toastId = 'app-toast-' + (++toastSeq);
    toast.className = 'app-toast';
    toast.id = toastId;
    toast.setAttribute('role', 'status');
    toast.textContent = text;
    root.appendChild(toast);

    requestAnimationFrame(function () {
      var el = document.getElementById(toastId);
      if (el) el.classList.add('show');
    });

    var remove = function () {
      toast.classList.remove('show');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 180);
    };

    setTimeout(remove, 3800);
    toast.addEventListener('click', remove);
  }

  function getRememberedWalletName(expectedAddress) {
    try {
      var rememberedName = String(localStorage.getItem('sui_wallet_name') || localStorage.getItem('sui_ski_last_wallet') || '').trim();
      if (!rememberedName) return '';
      var addressGate = normalizeAddress(localStorage.getItem('sui_wallet_name_address') || '');
      var expected = normalizeAddress(expectedAddress || '');
      if (expected && (!addressGate || expected !== addressGate)) return '';
      return rememberedName;
    } catch (_error) {
      return '';
    }
  }

  function getRememberedWalletIcon() {
    try {
      return String(localStorage.getItem('sui_wallet_icon') || '').trim();
    } catch (_error) {
      return '';
    }
  }

  function normalizeWalletName(value) {
    var normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return '';
    normalized = normalized.replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.slice(-7) === ' wallet') normalized = normalized.slice(0, -7).trim();
    return normalized.replace(/\s+/g, '');
  }

  function isStableWalletIcon(icon) {
    var value = String(icon || '').trim();
    if (!value) return false;
    var lower = value.toLowerCase();
    var upper = value.toUpperCase();
    if (lower.indexOf('chrome-extension://') === 0) return false;
    if (lower.indexOf('moz-extension://') === 0) return false;
    if (lower.indexOf('safari-web-extension://') === 0) return false;
    if (lower.indexOf('blob:') === 0) return false;
    // Reject legacy Phantom fallback icon payload from older runtime builds.
    if (upper.indexOf('NTM0QKI1') !== -1 && upper.indexOf('NTUXQKY5') !== -1) return false;
    // Reject app-authored fallback wallet SVGs; prefer actual wallet-provided icons.
    if (lower.indexOf('/assets/wallet-phantom.svg') !== -1 || lower.indexOf('./assets/wallet-phantom.svg') !== -1) return false;
    if (lower.indexOf('/assets/wallet-backpack.svg') !== -1 || lower.indexOf('./assets/wallet-backpack.svg') !== -1) return false;
    if (lower.indexOf('/assets/wallet-suiet.svg') !== -1 || lower.indexOf('./assets/wallet-suiet.svg') !== -1) return false;
    if (lower.indexOf('/assets/wallet-slush.svg') !== -1 || lower.indexOf('./assets/wallet-slush.svg') !== -1) return false;
    return true;
  }

  function resolveWalletIcon(conn, walletName) {
    var key = normalizeWalletName(walletName);
    var wantsPhantom = key.indexOf('phantom') !== -1;
    var candidates = [
      conn && conn.wallet && conn.wallet.icon ? conn.wallet.icon : '',
      getRuntimeWalletIcon(walletName),
      getRememberedWalletIcon()
    ];

    for (var i = 0; i < candidates.length; i++) {
      var candidate = String(candidates[i] || '').trim();
      if (!candidate) continue;
      if (wantsPhantom) {
        var upper = candidate.toUpperCase();
        // Ignore legacy Phantom fallback icon cached from older builds.
        if (upper.indexOf('NTM0QKI1') !== -1 && upper.indexOf('NTUXQKY5') !== -1) continue;
      }
      if (!isStableWalletIcon(candidate)) continue;
      return candidate;
    }
    return '';
  }

  function getRuntimeWalletIcon(walletName) {
    if (!walletName || !window.SuiWalletKit || !window.SuiWalletKit.$wallets) return '';
    var wallets = Array.isArray(window.SuiWalletKit.$wallets.value) ? window.SuiWalletKit.$wallets.value : [];
    var target = normalizeWalletName(walletName);
    if (!target) return '';
    for (var i = 0; i < wallets.length; i++) {
      var wallet = wallets[i];
      if (!wallet || !wallet.name) continue;
      if (normalizeWalletName(wallet.name) !== target) continue;
      if (wallet.icon) return String(wallet.icon);
    }
    return '';
  }

  function normalizeAddress(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    var cleaned = text.toLowerCase();
    if (cleaned.indexOf('0x') !== 0) cleaned = '0x' + cleaned;
    return cleaned;
  }

  function hydrateFromLocalSessionSnapshot() {
    var address = '';
    var walletName = '';
    var walletIcon = '';
    var walletNameAddress = '';
    try {
      address = normalizeAddress(localStorage.getItem('sui_wallet_address') || '');
      walletName = String(localStorage.getItem('sui_wallet_name') || localStorage.getItem('sui_ski_last_wallet') || '').trim();
      walletIcon = String(localStorage.getItem('sui_wallet_icon') || '').trim();
      walletNameAddress = normalizeAddress(localStorage.getItem('sui_wallet_name_address') || '');
    } catch (_e) {
      return false;
    }
    if (!address) return false;
    if (walletName && (!walletNameAddress || walletNameAddress !== address)) {
      walletName = '';
    }
    state.connected = true;
    state.address = address;
    state.walletName = walletName;
    if (walletIcon && !isStableWalletIcon(walletIcon)) {
      try { localStorage.removeItem('sui_wallet_icon'); } catch (_eClearIcon) {}
      walletIcon = '';
    }
    state.walletIcon = resolveWalletIcon(null, walletName) || (isStableWalletIcon(walletIcon) ? walletIcon : '');
    state.method = walletName && walletName.toLowerCase().indexOf('waap') !== -1 ? 'waap' : 'wallet';
    suppressDisconnectedFlash = true;
    return true;
  }

  function sanitizeName(value) {
    return String(value || '').trim().toLowerCase().replace(/^@+/, '').replace(/\.sui$/i, '');
  }

  function truncateAddress(address) {
    var text = String(address || '').trim();
    if (!text) return '';
    if (text.length <= 16) return text;
    return text.slice(0, 7) + '...' + text.slice(-6);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatSui(amount) {
    var n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n < 0.01) return '< 0.01';
    if (n < 100) return n.toFixed(2).replace(/\.?0+$/, '');
    if (n < 10000) return n.toFixed(1);
    if (n < 1000000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1000000).toFixed(1) + 'M';
  }

  function formatUsd(amount) {
    var n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 0.01) return '< $0.01';
    if (n < 100) return '$' + n.toFixed(2);
    if (n < 10000) return '$' + n.toFixed(0);
    if (n < 1000000) return '$' + (n / 1000).toFixed(1) + 'k';
    return '$' + (n / 1000000).toFixed(1) + 'M';
  }

  function graphql(query, variables) {
    return fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) {
      return r.json();
    }).then(function (json) {
      if (!json || (Array.isArray(json.errors) && json.errors.length)) {
        var message = (json && json.errors && json.errors[0] && json.errors[0].message) || 'GraphQL error';
        throw new Error(message);
      }
      return json.data || {};
    });
  }

  function getWaaPMethod(address) {
    try {
      var raw = localStorage.getItem('sui_ski_waap_method_by_address_v1');
      if (!raw) return '';
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return '';
      var key = normalizeAddress(address);
      var value = parsed[key] || parsed[key.toLowerCase()] || '';
      var method = String(value || '').toLowerCase();
      if (method === 'twitter') return 'x';
      if (method === 'x' || method === 'google' || method === 'wallet') return method;
    } catch (_error) {}
    return '';
  }

  function inferMethod(conn) {
    var waapMethod = getWaaPMethod(state.address);
    if (waapMethod) return waapMethod;

    var walletName = String(
      conn && conn.wallet && conn.wallet.name
        ? conn.wallet.name
        : (state.walletName || getRememberedWalletName(state.address))
    ).toLowerCase();
    if (walletName.indexOf('slush') !== -1) return 'slush';
    if (walletName.indexOf('waap') !== -1) return 'waap';
    if (walletName.indexOf('google') !== -1) return 'google';
    return 'wallet';
  }

  function getMethodIconHtml(method) {
    if ((method === 'wallet' || method === 'slush') && state.walletIcon) {
      return '<span class="wk-widget-method-icon"><img src="' + escapeHtml(state.walletIcon) + '" alt="' + escapeHtml(state.walletName || 'Wallet') + '"></span>';
    }
    if (method === 'x') {
      var waapMethod = getWaaPMethod(state.address);
      if (waapMethod === 'x') {
        return '' +
          '<span class="wk-widget-method-dual">' +
            '<span class="wk-widget-method-icon"><img src="' + ASSETS.waapIcon + '" alt="WaaP"></span>' +
            '<span class="wk-widget-method-icon"><img src="' + ASSETS.xIcon + '" alt="X"></span>' +
          '</span>';
      }
      return '<span class="wk-widget-method-icon"><img src="' + ASSETS.xIcon + '" alt="X"></span>';
    }
    if (method === 'google') {
      return '' +
        '<span class="wk-widget-method-dual">' +
          '<span class="wk-widget-method-icon"><img src="' + ASSETS.waapIcon + '" alt="WaaP"></span>' +
          '<span class="wk-widget-method-icon" title="Google">' + WAAP_GOOGLE_ICON_SVG + '</span>' +
        '</span>';
    }
    if (method === 'waap') {
      return '<span class="wk-widget-icon-fallback" title="WaaP" style="background:#0f172a;font-weight:700;font-size:10px;color:#93c5fd">W</span>';
    }
    if (method === 'slush') {
      return '<span class="wk-widget-method-icon"><img src="' + ASSETS.slushIcon + '" alt="Slush"></span>';
    }
    return '<span class="wk-widget-icon-fallback" title="Wallet" style="background:#111827;font-weight:700;font-size:11px">◎</span>';
  }

  function getProfileHref() {
    var name = sanitizeName(state.primaryName);
    if (name) {
      return 'https://' + encodeURIComponent(name) + '.sui.ski';
    }
    return 'https://sui.ski';
  }

  function clearCopiedTimer() {
    if (!state.copiedTimer) return;
    clearTimeout(state.copiedTimer);
    state.copiedTimer = null;
  }

  function showCopiedState() {
    clearCopiedTimer();
    state.copied = true;
    render();
    state.copiedTimer = setTimeout(function () {
      state.copied = false;
      state.copiedTimer = null;
      render();
    }, 2200);
  }

  function fallbackCopy(text) {
    if (!document.body) return false;
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    var copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (_error) {
      copied = false;
    }

    document.body.removeChild(textarea);
    return copied;
  }

  function copyAddress() {
    var text = String(state.address || '').trim();
    if (!text) return;

    var onSuccess = function () {
      showCopiedState();
    };

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(onSuccess).catch(function () {
        if (fallbackCopy(text)) onSuccess();
      });
      return;
    }

    if (fallbackCopy(text)) onSuccess();
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(function () {
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      refreshPortfolio();
    }, 120000);
  }

  function fetchPrimaryName(address) {
    if (!address) return Promise.resolve('');
    return fetch('https://sui.ski/api/primary-name?address=' + encodeURIComponent(address))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var name = data && typeof data.name === 'string' ? sanitizeName(data.name) : '';
        return name;
      })
      .catch(function () {
        return '';
      });
  }

  function getSkiApi() {
    var ski = window.SKI;
    if (!ski || typeof ski !== 'object') return null;
    if (typeof ski.signIn !== 'function') return null;
    if (typeof ski.getSession !== 'function') return null;
    if (typeof ski.signOut !== 'function') return null;
    return ski;
  }

  function formatSkiExpiry(ms) {
    var value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return '';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function syncSkiSessionState() {
    var ski = getSkiApi();
    if (!ski) {
      state.skiActive = false;
      state.skiExpiresAtMs = 0;
      return;
    }
    var session = null;
    try {
      session = ski.getSession({ address: state.connected ? state.address : '' });
    } catch (_e) {
      session = null;
    }
    state.skiActive = !!session;
    state.skiExpiresAtMs = session && Number(session.expiresAtMs) > 0 ? Number(session.expiresAtMs) : 0;
  }

  function activateSkiSession() {
    if (state.skiBusy) return;
    if (!state.connected || !state.address) {
      showToast('Connect wallet before activating .SKI.');
      return;
    }
    if (state.sessionOnly) {
      showToast('Switch to an active wallet to sign .SKI.');
      return;
    }
    var ski = getSkiApi();
    if (!ski) {
      showToast('.SKI signing layer unavailable.');
      return;
    }

    state.skiBusy = true;
    render();

    Promise.resolve(
      ski.signIn({
        address: state.address,
        statement: 'SKI to activate your local .SKI session.'
      })
    )
      .then(function () {
        syncSkiSessionState();
        if (state.skiActive) showToast('.SKI session active.');
      })
      .catch(function (error) {
        var message = error && error.message ? String(error.message) : 'Unable to activate .SKI.';
        showToast(message);
      })
      .finally(function () {
        state.skiBusy = false;
        render();
      });
  }

  function signOutSkiSession() {
    var ski = getSkiApi();
    if (ski) {
      try { ski.signOut(); } catch (_e) {}
    }
    state.skiActive = false;
    state.skiExpiresAtMs = 0;
    state.skiBusy = false;
    showToast('.SKI session signed out.');
    render();
  }

  function clearWaaPSocialCache() {
    try { localStorage.removeItem('sui_ski_waap_method_by_address_v1'); } catch (_e1) {}
    try { localStorage.removeItem('sui_ski_waap_label_by_address_v1'); } catch (_e2) {}
    showToast('Cleared WaaP social cache.');

    try {
      if (window.SuiWalletKit && window.SuiWalletKit.$connection) {
        updateFromConnection(window.SuiWalletKit.$connection.value || {});
        return;
      }
    } catch (_refreshErr) {}
    render();
  }

  function refreshPortfolio(options) {
    if (!state.connected || !state.address) return Promise.resolve();
    var force = !!(options && options.force);
    var now = Date.now();
    if (!force && state.refreshInFlight) return Promise.resolve();
    if (!force && (now - state.lastPortfolioFetchMs) < PORTFOLIO_REFRESH_INTERVAL_MS) return Promise.resolve();
    var address = state.address;

    var balanceQuery = 'query($address:SuiAddress!,$coinType:String!){ address(address:$address){ balance(coinType:$coinType){ totalBalance } } }';

    state.refreshInFlight = true;
    state.lastPortfolioFetchMs = now;
    return graphql(balanceQuery, { address: address, coinType: SUI_COIN_TYPE })
      .then(function (data) {
        var mist = Number(data && data.address && data.address.balance && data.address.balance.totalBalance ? data.address.balance.totalBalance : 0);
        state.sui = Number.isFinite(mist) ? mist / 1e9 : 0;
        if (state.sui <= 0) return 0;
        return requestSuiUsdPrice();
      })
      .then(function (price) {
        if (Number.isFinite(price) && price > 0) {
          state.usd = state.sui * price;
        } else {
          state.usd = Number.isFinite(state.cachedSuiUsdPrice) && state.cachedSuiUsdPrice > 0
            ? state.sui * state.cachedSuiUsdPrice
            : null;
        }
      })
      .catch(function () {
        if (Number.isFinite(state.cachedSuiUsdPrice) && state.cachedSuiUsdPrice > 0) {
          state.usd = state.sui * state.cachedSuiUsdPrice;
        } else {
          state.usd = null;
        }
      })
      .finally(function () {
        state.refreshInFlight = false;
        render();
      });
  }

  function triggerForegroundRefresh() {
    if (!state.connected) return;
    var now = Date.now();
    if ((now - state.lastForegroundRefreshMs) < FOREGROUND_REFRESH_THROTTLE_MS) return;
    state.lastForegroundRefreshMs = now;
    refreshPortfolio({ force: true });
  }

  function renderMenu() {
    if (!els.menuRoot) return;
    syncSkiSessionState();
    if (!state.connected || !state.menuOpen) {
      els.menuRoot.innerHTML = '';
      return;
    }

    var copiedText = 'Copied! \u2713';
    var addressOrCopied = state.copied ? copiedText : state.address;
    var skiLabel = state.skiBusy
      ? 'Activating .SKI...'
      : (state.skiActive ? 'Sign Out .SKI' : 'Activate .SKI');
    var skiSuffix = state.skiActive && state.skiExpiresAtMs
      ? ' (until ' + formatSkiExpiry(state.skiExpiresAtMs) + ')'
      : '';

    els.menuRoot.innerHTML = (
      '<div class="wk-dropdown open">' +
        '<button class="wk-dd-address-banner' + (state.copied ? ' copied' : '') + '" id="wk-dd-address-copy" type="button" title="Copy address">' +
          '<span class="wk-dd-address-text">' + escapeHtml(addressOrCopied) + '</span>' +
        '</button>' +
        '<button class="wk-dd-item" id="wk-dd-ski" type="button"' + (state.skiBusy ? ' disabled aria-disabled="true"' : '') + '>' + escapeHtml(skiLabel + skiSuffix) + '</button>' +
        '<button class="wk-dd-item" id="wk-dd-switch">Switch Wallet</button>' +
        '<button class="wk-dd-item disconnect" id="wk-dd-disconnect">Disconnect</button>' +
      '</div>'
    );

    var copyBtn = document.getElementById('wk-dd-address-copy');
    var skiBtn = document.getElementById('wk-dd-ski');
    var switchBtn = document.getElementById('wk-dd-switch');
    var disconnectBtn = document.getElementById('wk-dd-disconnect');

    if (copyBtn) {
      copyBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        copyAddress();
      });
    }

    if (skiBtn) {
      skiBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (state.skiBusy) return;
        if (state.skiActive) {
          signOutSkiSession();
          return;
        }
        activateSkiSession();
      });
    }

    if (switchBtn) {
      switchBtn.addEventListener('click', function () {
        manualDisconnect(true);
      });
    }

    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', function () {
        manualDisconnect(false);
      });
    }
  }

  function ensureWaaPClearButton() {
    if (document.getElementById('wk-waap-clear-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'wk-waap-clear-btn';
    btn.className = 'wk-waap-clear-btn';
    btn.type = 'button';
    btn.title = 'Clears remembered WaaP social mapping';
    btn.textContent = 'Clear WaaP';
    btn.addEventListener('click', function (event) {
      event.stopPropagation();
      clearWaaPSocialCache();
    });
    document.body.appendChild(btn);
  }

  function renderWidget() {
    if (!els.wkWidget) return;

    if (!state.connected) {
      if (bootHydrating) {
        els.wkWidget.innerHTML = (
          '<div class="wk-widget">' +
            '<button class="wk-widget-btn" id="wallet-pill-btn" type="button" title="Loading wallet" style="visibility:hidden;pointer-events:none">' +
              '<img src="' + ASSETS.logoGreen + '" class="wk-widget-brand-logo" alt=".SKI">' +
            '</button>' +
          '</div>'
        );
        return;
      }
      els.wkWidget.innerHTML = (
        '<div class="wk-widget">' +
          '<button class="wk-widget-btn" id="wallet-pill-btn" type="button" title="Connect wallet">' +
            '<img src="' + ASSETS.logoGreen + '" class="wk-widget-brand-logo" alt=".SKI">' +
          '</button>' +
        '</div>'
      );
      return;
    }

    var hasPrimary = Boolean(sanitizeName(state.primaryName));
    var label = hasPrimary ? sanitizeName(state.primaryName) : truncateAddress(state.address);
    var labelClass = hasPrimary ? 'wk-widget-title' : 'wk-widget-title is-address';
    var tokenText = formatSui(state.sui);
    var usdText = formatUsd(state.usd);

    var balanceHtml = '';
    if (tokenText || usdText) {
      balanceHtml = '<span class="wk-widget-balance-wrap">';
      if (tokenText) {
        balanceHtml += '<span class="wk-widget-token-row">' + escapeHtml(tokenText) + '<img class="sui-icon" src="' + ASSETS.suiDrop + '" alt="SUI"></span>';
      }
      if (usdText) {
        balanceHtml += '<span class="wk-widget-usd-row">' + escapeHtml(usdText) + '</span>';
      }
      balanceHtml += '</span>';
    }

    els.wkWidget.innerHTML = (
      '<div class="wk-widget">' +
        '<button class="wk-widget-btn connected" id="wallet-pill-btn" type="button" title="Open profile">' +
          getMethodIconHtml(state.method) +
          '<span class="wk-widget-label-wrap"><span class="' + labelClass + '"><span class="wk-widget-primary-name">' + escapeHtml(label) + '</span></span></span>' +
          balanceHtml +
        '</button>' +
      '</div>'
    );
  }

  function renderProfileButton() {
    if (!els.profileBtn) return;

    if (!state.connected) {
      els.profileBtn.style.display = 'none';
      els.profileBtn.classList.remove('has-primary', 'no-primary');
      return;
    }

    var hasPrimary = Boolean(sanitizeName(state.primaryName));
    var img = els.profileBtn.querySelector('.wallet-profile-logo');

    els.profileBtn.style.display = '';
    els.profileBtn.title = 'Open wallet menu';
    els.profileBtn.classList.toggle('has-primary', hasPrimary);
    els.profileBtn.classList.toggle('no-primary', !hasPrimary);

    if (img) {
      img.src = hasPrimary ? ASSETS.logoBlue : ASSETS.logoBlack;
    }
  }

  function render() {
    if (els.walletWidget) {
      els.walletWidget.classList.toggle('has-black-diamond', !state.connected);
    }
    renderWidget();
    renderProfileButton();
    renderMenu();

    var pillBtn = document.getElementById('wallet-pill-btn');
    if (pillBtn) {
      pillBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (!state.connected) {
          openModal();
          return;
        }
        window.open(getProfileHref(), '_blank', 'noopener,noreferrer');
      });
    }
  }

  function openModal() {
    ensureWalletRuntime().then(function () {
      if (!modalRendered && window.SuiWalletKit && typeof window.SuiWalletKit.renderModal === 'function') {
        try {
          window.SuiWalletKit.renderModal('wk-modal');
          modalRendered = true;
        } catch (_error) {}
      }
      if (!window.SuiWalletKit || typeof window.SuiWalletKit.openModal !== 'function') return;
      window.SuiWalletKit.openModal();
    }).catch(function (error) {
      console.error('Unable to open wallet modal', error);
    });
  }

  function safeDisconnectSession() {
    if (typeof window.disconnectWalletSession !== 'function') return;
    try {
      return window.disconnectWalletSession();
    } catch (_error) {}
    return null;
  }

  function clearLocalWalletIdentity() {
    var keys = [
      'sui_wallet_name',
      'sui_wallet_name_address',
      'sui_wallet_address',
      'sui_wallet_icon',
      'sui_ski_last_wallet',
      'ski_wallet_history'
    ];
    for (var i = 0; i < keys.length; i++) {
      try { localStorage.removeItem(keys[i]); } catch (_e) {}
    }
    state.lastSessionSyncKey = '';
    suppressDisconnectedFlash = false;
  }

  function manualDisconnect(openAfter) {
    state.menuOpen = false;
    state.copied = false;
    clearCopiedTimer();
    render();

    var disconnectTask = Promise.resolve();
    var usedRuntimeDisconnect = false;
    if (window.SuiWalletKit && typeof window.SuiWalletKit.disconnect === 'function') {
      try {
        var runtimeResult = window.SuiWalletKit.disconnect();
        usedRuntimeDisconnect = true;
        if (runtimeResult && typeof runtimeResult.then === 'function') {
          disconnectTask = runtimeResult.catch(function () {});
        }
      } catch (_error) {
        usedRuntimeDisconnect = false;
      }
    }
    if (!usedRuntimeDisconnect) {
      try {
        var sessionResult = safeDisconnectSession();
        if (sessionResult && typeof sessionResult.then === 'function') {
          disconnectTask = sessionResult.catch(function () {});
        }
      } catch (_sessionError) {}
    }
    clearLocalWalletIdentity();

    if (openAfter) {
      disconnectTask.finally(function () {
        setTimeout(function () {
          openModal();
        }, 180);
      });
    }
  }

  function updateFromConnection(conn) {
    var prevConnected = state.connected;
    var prevAddress = state.address;
    var prevPrimaryName = state.primaryName;
    var prevWalletName = state.walletName;
    var prevMethod = state.method;
    var status = conn && conn.status ? String(conn.status) : 'disconnected';
    var connected = status === 'connected' || status === 'session';
    if (!connected && suppressDisconnectedFlash && state.connected && state.address) {
      return;
    }
    if (connected) {
      suppressDisconnectedFlash = false;
    }
    var sessionWalletName = '';
    if (window.SuiWalletKit && window.SuiWalletKit.__sessionWalletName) {
      sessionWalletName = String(window.SuiWalletKit.__sessionWalletName || '');
    }
    var connectedAddress = connected ? normalizeAddress(conn.address || '') : '';
    if (!sessionWalletName && connectedAddress && typeof window.getWalletSession === 'function') {
      try {
        var session = window.getWalletSession();
        var sessionAddress = normalizeAddress(session && session.address ? session.address : '');
        if (sessionAddress && sessionAddress === connectedAddress) {
          sessionWalletName = String(session && session.walletName ? session.walletName : '');
        }
      } catch (_sessionNameError) {}
    }
    var runtimeWalletName = conn && conn.wallet && conn.wallet.name ? String(conn.wallet.name) : '';

    state.connected = connected;
    state.sessionOnly = connected && status === 'session' && !(conn && conn.wallet);
    state.address = connectedAddress;
    state.primaryName = connected ? sanitizeName(conn.primaryName || '') : '';
    state.walletName = connected
      ? String(
          runtimeWalletName
            ? runtimeWalletName
            : (status === 'session' ? (sessionWalletName || getRememberedWalletName(connectedAddress)) : '')
        )
      : '';
    state.walletIcon = connected
      ? resolveWalletIcon(conn, state.walletName)
      : '';
    state.method = connected ? inferMethod(conn) : 'wallet';
    syncSkiSessionState();

    if (!connected) {
      state.sessionOnly = false;
      state.menuOpen = false;
      state.copied = false;
      state.lastSessionSyncKey = '';
      state.skiActive = false;
      state.skiExpiresAtMs = 0;
      state.skiBusy = false;
      clearCopiedTimer();
      stopPolling();
      state.sui = 0;
      state.usd = null;
      state.refreshInFlight = false;
      state.priceFetchBlockedUntilMs = 0;
      render();
      return;
    }

    if (state.address) {
      var ikaToastKey = state.address;
      if (state.lastIkaToastKey !== ikaToastKey) {
        state.lastIkaToastKey = ikaToastKey;
        showToast('IKA dWallet check: connect or create your IKA dWallet to complete setup.');
      }
    }

    try {
      if (state.walletName) localStorage.setItem('sui_wallet_name', state.walletName);
      if (state.walletName && state.address) localStorage.setItem('sui_wallet_name_address', state.address);
      if (!state.walletName) localStorage.removeItem('sui_wallet_name');
      if (!state.walletName || !state.address) localStorage.removeItem('sui_wallet_name_address');
      if (state.address) localStorage.setItem('sui_wallet_address', state.address);
      if (state.walletIcon) localStorage.setItem('sui_wallet_icon', state.walletIcon);
      else localStorage.removeItem('sui_wallet_icon');
    } catch (_storageError) {}

    if (!state.primaryName && !state.resolvingName) {
      state.resolvingName = true;
      fetchPrimaryName(state.address).then(function (name) {
        if (!name) return;
        if (window.SuiWalletKit && typeof window.SuiWalletKit.setPrimaryName === 'function') {
          try { window.SuiWalletKit.setPrimaryName(name); } catch (_error) {}
        }
      }).finally(function () {
        state.resolvingName = false;
      });
    }

    var sessionSyncKey = state.walletName + '|' + state.address;
    if (
      typeof window.connectWalletSession === 'function'
      && state.walletName
      && state.address
      && state.lastSessionSyncKey !== sessionSyncKey
    ) {
      state.lastSessionSyncKey = sessionSyncKey;
      try {
        window.connectWalletSession(state.walletName, state.address).catch(function () {});
      } catch (_error) {}
    }

    var identityUnchanged = prevConnected
      && connected
      && prevAddress === state.address
      && prevPrimaryName === state.primaryName
      && prevWalletName === state.walletName
      && prevMethod === state.method;
    if (identityUnchanged) {
      render();
      return;
    }

    startPolling();
    refreshPortfolio({ force: true });
    render();
  }

  function bindGlobalEvents() {
    if (els.profileBtn) {
      els.profileBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        if (!state.connected) return;
        state.menuOpen = !state.menuOpen;
        render();
      });
    }

    document.addEventListener('click', function (event) {
      if (!state.menuOpen) return;
      if (els.profileBtn && els.profileBtn.contains(event.target)) return;
      if (els.menuRoot && els.menuRoot.contains(event.target)) return;
      state.menuOpen = false;
      render();
    });

    window.addEventListener('focus', function () {
      triggerForegroundRefresh();
    });

    document.addEventListener('visibilitychange', function () {
      if (!state.connected) return;
      if (document.visibilityState === 'visible') {
        triggerForegroundRefresh();
      }
    });
  }

  async function initWalletRuntime() {
    if (runtimeBound) return;
    if (!window.SuiWalletKit) {
      console.error('SuiWalletKit runtime is unavailable');
      return;
    }
    runtimeBound = true;

    window.onWalletConnected = function () {
      try {
        updateFromConnection(window.SuiWalletKit.$connection.value || {});
      } catch (_error) {}
    };

    window.onWalletDisconnected = function () {
      try {
        updateFromConnection(window.SuiWalletKit.$connection.value || {});
      } catch (_error) {}
    };

    if (window.SuiWalletKit.$connection && typeof window.SuiWalletKit.subscribe === 'function') {
      window.SuiWalletKit.subscribe(window.SuiWalletKit.$connection, function (conn) {
        updateFromConnection(conn || {});
      });
      updateFromConnection(window.SuiWalletKit.$connection.value || {});
    }

    try {
      if (typeof window.getWalletSession === 'function' && typeof window.SuiWalletKit.initFromSession === 'function') {
        var session = window.getWalletSession();
        if (session && session.address) {
          window.SuiWalletKit.initFromSession(session.address, session.walletName || '');
          updateFromConnection(window.SuiWalletKit.$connection.value || {});
        }
      }
    } catch (_sessionHydrateError) {}

    var shouldPrewarmWaaP = false;
    try {
      shouldPrewarmWaaP = typeof window !== 'undefined' && window.__wkPrewarmWaaP === true;
    } catch (_waapPrewarmFlagError) {}
    if (shouldPrewarmWaaP) {
      try {
        if (typeof window.SuiWalletKit.initWaaP === 'function') {
          Promise.resolve(window.SuiWalletKit.initWaaP()).catch(function () {});
        }
      } catch (_waapInitError) {}
    }

    try {
      await window.SuiWalletKit.detectWallets();
    } catch (_detectError) {}

    try {
      await window.SuiWalletKit.autoReconnect();
    } catch (_error2) {}

    suppressDisconnectedFlash = false;
    bootHydrating = false;
    updateFromConnection(window.SuiWalletKit.$connection.value || {});
  }

  installNoiseFilters();
  hydrateFromLocalSessionSnapshot();
  loadCachedPrice();
  syncSkiSessionState();
  bindGlobalEvents();
  ensureWaaPClearButton();
  render();
  ensureWalletRuntime().catch(function (error) {
    bootHydrating = false;
    render();
    console.error('Wallet runtime init failed', error);
  });
})();
