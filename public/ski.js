(function () {
  var STORAGE_KEY = 'ski_signed_session_v1';
  var SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

  function normalizeAddress(value) {
    var text = String(value || '').trim().toLowerCase();
    if (!text) return '';
    if (text.indexOf('0x') !== 0) text = '0x' + text;
    return text;
  }

  function randomNonce() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (_e) {}
    try {
      var bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      var out = '';
      for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
      return out;
    } catch (_e2) {}
    return String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  }

  function bytesToBase64(bytes) {
    var chunkSize = 0x8000;
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function extractSignature(result) {
    if (!result) return '';
    if (typeof result === 'string') return result.trim();
    var signature = result.signature != null ? result.signature : result;
    if (typeof signature === 'string') return signature.trim();
    if (signature instanceof Uint8Array) return 'base64:' + bytesToBase64(signature);
    if (Array.isArray(signature)) {
      var validArray = true;
      for (var i = 0; i < signature.length; i++) {
        if (!Number.isFinite(Number(signature[i]))) {
          validArray = false;
          break;
        }
      }
      if (validArray) {
        return 'base64:' + bytesToBase64(Uint8Array.from(signature));
      }
      try { return 'json:' + JSON.stringify(signature); } catch (_e) { return ''; }
    }
    try {
      var maybeText = String(signature || '');
      if (maybeText && maybeText !== '[object Object]') return maybeText;
    } catch (_e2) {}
    try {
      return 'json:' + JSON.stringify(signature);
    } catch (_e3) {
      return '';
    }
  }

  function createPayload(address, statement) {
    var nowMs = Date.now();
    var expiresAtMs = nowMs + SESSION_DURATION_MS;
    return {
      version: 1,
      domain: window.location.host,
      uri: window.location.origin,
      address: normalizeAddress(address),
      nonce: randomNonce(),
      issuedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs: expiresAtMs,
      statement: String(statement || '').trim() || 'This signature activates your local .SKI session and costs no gas.'
    };
  }

  function buildMessage(payload) {
    return [
      payload.domain + ' wants you to .SKI',
      '',
      payload.address,
      '',
      'URI: ' + payload.uri,
      'Version: ' + payload.version,
      'Nonce: ' + payload.nonce,
      'Issued At: ' + payload.issuedAt,
      'Expires At: ' + payload.expiresAt,
      '',
      payload.statement
    ].join('\n');
  }

  function readSession() {
    var raw = '';
    try { raw = localStorage.getItem(STORAGE_KEY) || ''; } catch (_e) { return null; }
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_e2) {
      try { localStorage.removeItem(STORAGE_KEY); } catch (_e3) {}
      return null;
    }
  }

  function clearSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_e) {}
  }

  function isSessionValid(session, expectedAddress) {
    if (!session || typeof session !== 'object') return false;
    var expiresAtMs = Number(session.expiresAtMs || 0);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return false;

    var domain = String(session.domain || '');
    var uri = String(session.uri || '');
    var address = normalizeAddress(session.address || '');
    var signature = String(session.signature || '');
    var message = String(session.message || '');
    if (!domain || !uri || !address || !signature || !message) return false;
    if (domain !== window.location.host) return false;
    if (uri !== window.location.origin) return false;

    var normalizedExpected = normalizeAddress(expectedAddress || '');
    if (normalizedExpected && address !== normalizedExpected) return false;
    return true;
  }

  function createMessage(address, statement) {
    var payload = createPayload(address, statement);
    return buildMessage(payload);
  }

  async function signIn(options) {
    var opts = typeof options === 'string' ? { statement: options } : (options || {});
    var requestedAddress = normalizeAddress(opts.address || '');
    var statement = String(opts.statement || '').trim();

    if (!window.SuiWalletKit || !window.SuiWalletKit.$connection) {
      throw new Error('Wallet runtime unavailable');
    }
    var conn = window.SuiWalletKit.$connection.value || {};
    if (!conn || (conn.status !== 'connected' && conn.status !== 'session') || !conn.address) {
      throw new Error('Connect wallet before signing .SKI');
    }
    if (!conn.wallet) {
      throw new Error('Active wallet connection required for .SKI signing');
    }
    if (typeof window.SuiWalletKit.signPersonalMessage !== 'function') {
      throw new Error('Wallet does not support personal message signing');
    }

    var address = normalizeAddress(conn.address);
    if (requestedAddress && requestedAddress !== address) {
      throw new Error('Wallet address changed, retry .SKI signing');
    }

    var payload = createPayload(address, statement);
    var message = buildMessage(payload);
    var messageBytes = new TextEncoder().encode(message);
    var signResult = await window.SuiWalletKit.signPersonalMessage(messageBytes);
    var signature = extractSignature(signResult);
    if (!signature) throw new Error('Wallet returned empty signature');

    var session = {
      version: payload.version,
      domain: payload.domain,
      uri: payload.uri,
      address: payload.address,
      nonce: payload.nonce,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      expiresAtMs: payload.expiresAtMs,
      statement: payload.statement,
      message: message,
      signature: signature,
      walletName: conn.wallet && conn.wallet.name ? String(conn.wallet.name) : ''
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch (_eStore) {
      throw new Error('Unable to persist .SKI session');
    }
    return session;
  }

  function getSession(options) {
    var opts = typeof options === 'string' ? { address: options } : (options || {});
    var expectedAddress = normalizeAddress(opts.address || '');
    var session = readSession();
    if (!session) return null;
    if (!isSessionValid(session, expectedAddress)) {
      clearSession();
      return null;
    }
    return session;
  }

  function signOut() {
    clearSession();
  }

  window.SKI = {
    STORAGE_KEY: STORAGE_KEY,
    SESSION_DURATION_MS: SESSION_DURATION_MS,
    createMessage: createMessage,
    signIn: signIn,
    getSession: getSession,
    signOut: signOut
  };
})();
