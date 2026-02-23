
    const __SESSION_KEY = 'sui_session_id';
    const __WALLET_NAME_KEY = 'sui_wallet_name';
    const __WALLET_ADDRESS_KEY = 'sui_wallet_address';
    const __WALLET_NAME_ADDRESS_KEY = 'sui_wallet_name_address';

    function __skiCanUseSessionApi() {
      try {
        var protocol = window.location && window.location.protocol ? String(window.location.protocol) : '';
        return protocol === 'http:' || protocol === 'https:';
      } catch (_e) {
        return false;
      }
    }

    function connectWalletSession(walletName, address) {
      if (!walletName || !address) return Promise.resolve(false);
      localStorage.setItem(__WALLET_NAME_KEY, walletName);
      localStorage.setItem(__WALLET_ADDRESS_KEY, address);
      localStorage.setItem(__WALLET_NAME_ADDRESS_KEY, address);
      if (!__skiCanUseSessionApi()) return Promise.resolve(false);
      return fetch('/api/wallet/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: address, walletName: walletName }),
        credentials: 'include',
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.sessionId) localStorage.setItem(__SESSION_KEY, data.sessionId);
        return true;
      }).catch(function() { return false; });
    }

    function __skiReadCookie(name) {
      try {
        var pairs = document.cookie ? document.cookie.split(';') : [];
        for (var i = 0; i < pairs.length; i++) {
          var part = String(pairs[i] || '').trim();
          if (!part) continue;
          var eqIndex = part.indexOf('=');
          if (eqIndex <= 0) continue;
          if (part.slice(0, eqIndex).trim() !== name) continue;
          var raw = part.slice(eqIndex + 1).trim();
          try { return decodeURIComponent(raw); } catch (_e) { return raw; }
        }
      } catch (_e2) {}
      return '';
    }

    function __skiClearSessionCookies() {
      var names = ['session_id', 'wallet_address', 'wallet_name'];
      var host = '';
      try {
        host = String((window.location && window.location.hostname) || '').toLowerCase();
      } catch (_eHost) {}
      var domains = ['', '; domain=.sui.ski'];
      if (host) {
        domains.push('; domain=' + host);
        if (host.indexOf('.') !== -1) {
          domains.push('; domain=.' + host);
        }
      }
      var expiries = [
        '; path=/; max-age=0; samesite=lax',
        '; path=/; max-age=0',
        '; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; samesite=lax',
        '; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ];
      var secureFlags = ['', '; secure'];
      for (var n = 0; n < names.length; n++) {
        for (var d = 0; d < domains.length; d++) {
          for (var e = 0; e < expiries.length; e++) {
            for (var s = 0; s < secureFlags.length; s++) {
              document.cookie = names[n] + '=' + domains[d] + expiries[e] + secureFlags[s];
            }
          }
        }
      }
    }

    function disconnectWalletSession() {
      var sessionId = localStorage.getItem(__SESSION_KEY) || __skiReadCookie('session_id');
      localStorage.removeItem(__SESSION_KEY);
      localStorage.removeItem(__WALLET_NAME_KEY);
      localStorage.removeItem(__WALLET_ADDRESS_KEY);
      localStorage.removeItem(__WALLET_NAME_ADDRESS_KEY);
      try { localStorage.removeItem('sui_wallet_icon'); } catch (_eIcon) {}
      try { localStorage.removeItem('sui_ski_last_wallet'); } catch (_e) {}
      try { localStorage.removeItem('ski_wallet_history'); } catch (_e) {}
      __skiClearSessionCookies();
      if (!__skiCanUseSessionApi()) return;
      return fetch('/api/wallet/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
        credentials: 'include',
      }).catch(function() {});
    }

    function challengeAndConnect(walletName, address, signMessageFn) {
      if (!__skiCanUseSessionApi()) return Promise.resolve(false);
      return fetch('/api/wallet/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      }).then(function(r) { return r.json(); }).then(function(challengeData) {
        if (!challengeData.challenge) throw new Error('No challenge received');
        var messageBytes = new TextEncoder().encode(challengeData.challenge);
        return signMessageFn(messageBytes).then(function(signResult) {
          var signature = signResult.signature || signResult;
          return fetch('/api/wallet/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: address, walletName: walletName, signature: signature, challenge: challengeData.challenge }),
            credentials: 'include',
          });
        });
      }).then(function(r) {
        if (!r.ok) throw new Error('Key-In verification failed (status ' + r.status + ')');
        return r.json();
      }).then(function(data) {
        if (data.sessionId) {
          localStorage.setItem(__SESSION_KEY, data.sessionId);
          localStorage.setItem(__WALLET_NAME_KEY, walletName);
          localStorage.setItem(__WALLET_ADDRESS_KEY, address);
        }
        return true;
      });
    }

    function __skiNormalizeAddress(address) {
      var text = String(address || '').trim();
      if (!text) return '';
      if (text.indexOf('0x') !== 0 && text.indexOf('0X') !== 0) text = '0x' + text;
      return '0x' + text.slice(2).toLowerCase();
    }

    function getWalletSession() {
      var localAddress = '';
      var localWalletName = '';
      var localWalletNameAddress = '';
      try {
        localAddress = __skiNormalizeAddress(localStorage.getItem(__WALLET_ADDRESS_KEY) || '');
      } catch (_e) {}
      try {
        localWalletName = String(localStorage.getItem(__WALLET_NAME_KEY) || localStorage.getItem('sui_ski_last_wallet') || '').trim();
      } catch (_eLocalName) {}
      try {
        localWalletNameAddress = __skiNormalizeAddress(localStorage.getItem(__WALLET_NAME_ADDRESS_KEY) || '');
      } catch (_eLocalNameAddress) {}

      if (localWalletName && localAddress && (!localWalletNameAddress || localWalletNameAddress !== localAddress)) {
        localWalletName = '';
      }

      // Prefer local storage identity (set on successful wallet connect in this app)
      // so stale cookies can't force a previous wallet after refresh.
      if (localAddress && localAddress.startsWith('0x')) {
        return { walletName: localWalletName, address: localAddress };
      }

      var cookieAddress = __skiNormalizeAddress(__skiReadCookie('wallet_address'));
      var address = cookieAddress;
      if (!address || !address.startsWith('0x')) return null;
      var walletName = __skiReadCookie('wallet_name') || localWalletName || '';
      return { walletName: walletName, address: address };
    }

    function initSessionFromServer(sessionData) {
      if (!sessionData || !sessionData.address) return;
      if (typeof SuiWalletKit !== 'undefined' && SuiWalletKit.initFromSession) {
        SuiWalletKit.initFromSession(sessionData.address, sessionData.walletName || '');
      }
    }

    if (typeof window !== 'undefined') {
      window.connectWalletSession = connectWalletSession;
      window.disconnectWalletSession = disconnectWalletSession;
      window.challengeAndConnect = challengeAndConnect;
      window.getWalletSession = getWalletSession;
      window.initSessionFromServer = initSessionFromServer;
    }
  


    var SuiWalletKit = (function() {
      var __wkNetwork = "mainnet";
      var __wkAutoConnect = true;
      var __wkNoiseFiltersInstalled = false;

      function __wkIsIgnorableExtensionNoiseMessage(value) {
        var msg = String(value || '').toLowerCase();
        if (!msg) return false;
        var normalized = msg.split(String.fromCharCode(96)).join('');
        return (
          normalized.indexOf('cannot redefine property: ethereum') !== -1
          || normalized.indexOf('backpack couldn\'t override window.ethereum') !== -1
          || normalized.indexOf('couldn\'t override window.ethereum') !== -1
          || normalized.indexOf('redefine property') !== -1 && normalized.indexOf('ethereum') !== -1
          || normalized.indexOf('env value doesn\'t meet tag requirements') !== -1
          || normalized.indexOf('no storage available for session') !== -1
          || normalized.indexOf('peanut sdk') !== -1
          || normalized.indexOf('thanks for using the peanut') !== -1
        );
      }

      function __wkInstallNoiseFilters() {
        if (__wkNoiseFiltersInstalled) return;
        __wkNoiseFiltersInstalled = true;

        try {
          window.addEventListener('error', function(event) {
            var message = event && event.message ? String(event.message) : '';
            var filename = event && event.filename ? String(event.filename).toLowerCase() : '';
            var errorMessage = event && event.error && event.error.message ? String(event.error.message) : '';
            var fromKnownInjector = filename.indexOf('evmAsk.js'.toLowerCase()) !== -1 || filename.indexOf('injected.js') !== -1;
            if (!fromKnownInjector && !__wkIsIgnorableExtensionNoiseMessage(message) && !__wkIsIgnorableExtensionNoiseMessage(errorMessage)) {
              return;
            }
            try { if (event && typeof event.preventDefault === 'function') event.preventDefault(); } catch (_e) {}
            try { if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation(); } catch (_e) {}
            try { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); } catch (_e) {}
            return false;
          }, true);
        } catch (_e) {}

        try {
          window.addEventListener('unhandledrejection', function(event) {
            var reason = event && event.reason ? event.reason : '';
            var message = '';
            if (typeof reason === 'string') message = reason;
            else if (reason && typeof reason.message === 'string') message = reason.message;
            if (!__wkIsIgnorableExtensionNoiseMessage(message)) return;
            try { if (event && typeof event.preventDefault === 'function') event.preventDefault(); } catch (_e) {}
            try { if (event && typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation(); } catch (_e) {}
            try { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); } catch (_e) {}
            return false;
          }, true);
        } catch (_e) {}

        try {
          if (typeof console !== 'undefined') {
            var __wkConsoleError = console.error;
            if (typeof __wkConsoleError === 'function') {
              console.error = function() {
                if (arguments.length > 0) {
                  for (var i = 0; i < arguments.length; i++) {
                    if (__wkIsIgnorableExtensionNoiseMessage(arguments[i])) return;
                  }
                }
                return __wkConsoleError.apply(console, arguments);
              };
            }
            var __wkConsoleWarn = console.warn;
            if (typeof __wkConsoleWarn === 'function') {
              console.warn = function() {
                if (arguments.length > 0) {
                  for (var i = 0; i < arguments.length; i++) {
                    if (__wkIsIgnorableExtensionNoiseMessage(arguments[i])) return;
                  }
                }
                return __wkConsoleWarn.apply(console, arguments);
              };
            }
            var __wkConsoleLog = console.log;
            if (typeof __wkConsoleLog === 'function') {
              console.log = function() {
                if (arguments.length > 0) {
                  for (var i = 0; i < arguments.length; i++) {
                    if (__wkIsIgnorableExtensionNoiseMessage(arguments[i])) return;
                  }
                }
                return __wkConsoleLog.apply(console, arguments);
              };
            }
          }
        } catch (_e) {}
      }

      __wkInstallNoiseFilters();

      function __wkCreateStore(initial) {
        var value = initial;
        var listeners = [];
        return {
          get value() { return value; },
          set: function(next) {
            value = next;
            for (var i = 0; i < listeners.length; i++) listeners[i](value);
          },
          subscribe: function(fn) {
            listeners.push(fn);
            return function() {
              var idx = listeners.indexOf(fn);
              if (idx >= 0) listeners.splice(idx, 1);
            };
          }
        };
      }

      var $wallets = __wkCreateStore([]);
      var $connection = __wkCreateStore({
        wallet: null,
        account: null,
        address: null,
        status: 'disconnected',
        primaryName: null
      });
      var __wkWalletEventsUnsub = null;

      function subscribe(store, fn) {
        return store.subscribe(fn);
      }

      function __wkDetachWalletEvents() {
        if (typeof __wkWalletEventsUnsub === 'function') {
          try { __wkWalletEventsUnsub(); } catch (_e) {}
        }
        __wkWalletEventsUnsub = null;
      }

      function __wkSafeGetAccounts(obj) {
        if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return [];
        try {
          var accounts = null;
          // Use Reflect if available for proxy safety, with a fallback to direct access
          if (typeof Reflect !== 'undefined' && typeof Reflect.get === 'function') {
            try { accounts = Reflect.get(obj, 'accounts'); } catch(e) { accounts = obj.accounts; }
          } else {
            accounts = obj.accounts;
          }
          
          if (typeof accounts === 'function') {
            try { accounts = accounts.call(obj); } catch(e) {}
          }
          
          if (Array.isArray(accounts)) return accounts;
          
          // Legacy check for single account objects or nested accounts
          if (obj.address || obj.publicKey) return [obj];
          if (obj.account && (obj.account.address || obj.account.publicKey)) return [obj.account];
          
          // Deep check for injected providers
          if (obj._raw && obj._raw !== obj) return __wkSafeGetAccounts(obj._raw);
          if (obj.sui && obj.sui !== obj) return __wkSafeGetAccounts(obj.sui);
          
          return [];
        } catch (e) {
          return [];
        }
      }

	      function __wkNormalizeAccountAddress(account) {
	        if (!account) return '';
	        var rawAddress = '';
	        if (typeof account.address === 'string') {
	          rawAddress = account.address.trim();
	        } else if (account.address && typeof account.address.toString === 'function') {
	          rawAddress = String(account.address.toString()).trim();
	        } else if (typeof account.publicKey === 'string') {
	          rawAddress = account.publicKey.trim();
	        } else if (account.publicKey && typeof account.publicKey.toString === 'function') {
	          rawAddress = String(account.publicKey.toString()).trim();
	        }
	        if (!rawAddress) return '';
	        if (/^[0-9a-fA-F]{2,}$/.test(rawAddress) && rawAddress.indexOf('0x') !== 0) {
	          return '0x' + rawAddress;
	        }
	        return rawAddress;
	      }

	      function __wkBuildPhantomAccount(address) {
	        var normalized = __wkNormalizeAccountAddress({ address: address });
	        if (!normalized) return null;
	        if (!/^0x[0-9a-fA-F]{2,}$/.test(normalized)) return null;
	        return {
	          address: normalized,
	          chains: ['sui:mainnet', 'sui:testnet', 'sui:devnet']
	        };
	      }

	      function __wkExtractPhantomAddress(result) {
	        if (!result) return '';
	        if (typeof result === 'string') return __wkNormalizeAccountAddress({ address: result });
	        var direct = __wkNormalizeAccountAddress(result);
	        if (direct) return direct;
	        var accounts = __wkSafeGetAccounts(result);
	        if (accounts.length > 0) {
	          var first = __wkNormalizeAccountAddress(accounts[0]);
	          if (first) return first;
	        }
	        return '';
	      }

	      function __wkIsSuiAccount(account) {
	        if (!account) return false;
	        var accountChains = Array.isArray(account.chains) ? account.chains : [];
	        if (accountChains.length > 0) {
	          for (var i = 0; i < accountChains.length; i++) {
	            if (typeof accountChains[i] === 'string' && accountChains[i].indexOf('sui:') === 0) return true;
	          }
	          return false;
	        }
	        var addr = __wkNormalizeAccountAddress(account);
	        return /^0x[0-9a-fA-F]{2,}$/.test(addr);
	      }

      function __wkFilterSuiAccounts(accounts) {
        if (!Array.isArray(accounts)) return [];
        var result = [];
        for (var i = 0; i < accounts.length; i++) {
          var account = accounts[i];
          if (!__wkIsSuiAccount(account)) continue;
          var normalizedAddress = __wkNormalizeAccountAddress(account);
          if (normalizedAddress && account && typeof account === 'object') {
            if (typeof account.address !== 'string' || account.address !== normalizedAddress) {
              try { account.address = normalizedAddress; } catch (e) {}
            }
          }
          result.push(account);
        }
        return result;
      }

	      function __wkExtractConnectedAccounts(connectResult, wallet) {
	        var accounts = [];
	        if (Array.isArray(connectResult)) {
	          accounts = connectResult;
	        } else if (connectResult) {
	          accounts = __wkSafeGetAccounts(connectResult);
	        }
	        if (accounts.length === 0) {
	          accounts = __wkSafeGetAccounts(wallet);
	        }
	        return __wkFilterSuiAccounts(accounts);
	      }

	      function __wkIsUserRejection(err) {
	        if (!err) return false;
	        if (err.code === 4001) return true;
	        var message = '';
	        if (typeof err === 'string') message = err;
	        else if (err && typeof err.message === 'string') message = err.message;
	        message = String(message || '').toLowerCase();
	        if (!message) return false;
	        return (
	          message.indexOf('user rejected') !== -1
	          || message.indexOf('user denied') !== -1
	          || message.indexOf('user cancelled') !== -1
	          || message.indexOf('user canceled') !== -1
	          || message.indexOf('rejected by user') !== -1
	          || message.indexOf('request rejected') !== -1
	        );
	      }

	      function __wkIsPhantomAuthError(err) {
	        if (!err) return false;
	        var message = '';
	        if (typeof err === 'string') message = err;
	        else if (err && typeof err.message === 'string') message = err.message;
	        message = String(message || '').toLowerCase();
	        if (!message) return false;
	        return (
	          message.indexOf('not been authorized') !== -1
	          || message.indexOf('not authorized') !== -1
	          || message.indexOf('unauthorized') !== -1
	          || message.indexOf('user rejected') !== -1
	          || message.indexOf('user denied') !== -1
	          || message.indexOf('something went wrong') !== -1
	        );
	      }

	      function __wkIsSuiCapableWallet(wallet) {
	        if (!wallet) return false;
	        var features = wallet.features || {};
	        var hasSuiChain = Array.isArray(wallet.chains) && wallet.chains.some(function(c) {
	          return typeof c === 'string' && c.indexOf('sui:') === 0;
	        });
	        var hasConnect = !!(features['standard:connect'] || wallet.connect || wallet.requestAccounts || wallet.requestAccount);
	        var featureKeys = Object.keys(features);
	        var hasSuiNamespaceFeature = false;
        for (var i = 0; i < featureKeys.length; i++) {
          if (featureKeys[i].indexOf('sui:') === 0) { hasSuiNamespaceFeature = true; break; }
        }
        var hasSuiTxMethod = !!(
          features['sui:signAndExecuteTransactionBlock'] ||
          features['sui:signAndExecuteTransaction'] ||
          wallet.signAndExecuteTransactionBlock ||
          wallet.signAndExecuteTransaction
        );
	        var hasSuiHint = !!(
	          wallet.sui
	          || wallet.suiWallet
	          || wallet.isPhantom
	          || wallet.isBackpack
	          || wallet.isSlush
	          || wallet.isSuiet
	          || wallet.isSuiWallet
	        );
	        var walletNameKey = __wkWalletNameKey(wallet.name || '');
	        var hasKnownSuiName = (
	          walletNameKey === 'phantom'
	          || walletNameKey === 'phantomwallet'
	          || walletNameKey === 'backpack'
	          || walletNameKey === 'backpackwallet'
	          || walletNameKey === 'slush'
	          || walletNameKey === 'slushwallet'
	          || walletNameKey === 'suiet'
	          || walletNameKey === 'suietwallet'
	          || walletNameKey === 'sui'
	          || walletNameKey === 'suiwallet'
	          || walletNameKey === 'martian'
	          || walletNameKey === 'ethos'
	          || walletNameKey.indexOf('okx') !== -1
	        );
        return hasConnect && (hasSuiChain || hasSuiNamespaceFeature || hasSuiTxMethod || hasSuiHint || hasKnownSuiName);
      }

	      function __wkHasConnectMethod(wallet) {
	        if (!wallet || typeof wallet !== 'object') return false;
	        if (typeof wallet.connect === 'function') return true;
	        if (typeof wallet.requestAccounts === 'function') return true;
	        if (typeof wallet.requestAccount === 'function') return true;
	        return false;
	      }

	      function __wkHasSignMethod(wallet) {
	        if (!wallet || typeof wallet !== 'object') return false;
	        var features = wallet.features || {};
	        return !!(
	          (features['sui:signAndExecuteTransaction'] && features['sui:signAndExecuteTransaction'].signAndExecuteTransaction)
	          || (features['sui:signAndExecuteTransactionBlock'] && features['sui:signAndExecuteTransactionBlock'].signAndExecuteTransactionBlock)
	          || (features['sui:signTransaction'] && features['sui:signTransaction'].signTransaction)
	          || (features['sui:signTransactionBlock'] && features['sui:signTransactionBlock'].signTransactionBlock)
	          || typeof wallet.signAndExecuteTransaction === 'function'
	          || typeof wallet.signAndExecuteTransactionBlock === 'function'
	          || typeof wallet.signTransaction === 'function'
	          || typeof wallet.signTransactionBlock === 'function'
	        );
	      }

	      function __wkPickInjectedSource(primary, fallback) {
	        var candidates = [
	          primary && primary.sui,
	          primary && primary.suiWallet,
	          primary && primary.wallet && primary.wallet.sui,
	          primary && primary.provider && primary.provider.sui,
	          primary && primary.wallet,
	          primary && primary.provider,
	          primary,
	          fallback && fallback.sui,
	          fallback && fallback.suiWallet,
	          fallback && fallback.wallet && fallback.wallet.sui,
	          fallback && fallback.provider && fallback.provider.sui,
	          fallback && fallback.wallet,
	          fallback && fallback.provider,
	          fallback,
	        ];
	        for (var i = 0; i < candidates.length; i++) {
	          var candidate = candidates[i];
	          if (!candidate || typeof candidate !== 'object') continue;
	          if (__wkHasConnectMethod(candidate) && __wkHasSignMethod(candidate)) return candidate;
	        }
	        for (var j = 0; j < candidates.length; j++) {
	          var connectCandidate = candidates[j];
	          if (!connectCandidate || typeof connectCandidate !== 'object') continue;
	          if (__wkHasConnectMethod(connectCandidate)) return connectCandidate;
	        }
	        return null;
	      }

      var __wkWalletsApi = null;
      var __wkWalletApiEventsBound = false;
      var __wkWalletStandardLoading = null;
      try { if (typeof getWallets === 'function') __wkWalletsApi = getWallets(); } catch (e) {}

      function __wkInitWalletsApi() {
        if (__wkWalletsApi) return __wkWalletsApi;
        try {
          if (typeof getWallets === 'function') __wkWalletsApi = getWallets();
        } catch (e) {}
        if (__wkWalletsApi) return __wkWalletsApi;
        try {
          var wsReg = window['wallet-standard'];
          if (wsReg && typeof wsReg.get === 'function') {
            __wkWalletsApi = wsReg;
          }
        } catch (e) {}
        return __wkWalletsApi;
      }

      function __wkLoadWalletStandard() {
        if (__wkWalletsApi) return Promise.resolve();
        if (__wkWalletStandardLoading) return __wkWalletStandardLoading;
        try {
          if (typeof getWallets === 'function') {
            __wkWalletsApi = getWallets();
            __wkEnsureWalletApiEvents();
            return Promise.resolve();
          }
        } catch (e) {}
        __wkWalletStandardLoading = Promise.race([
          Promise.all([
            import('https://esm.sh/@wallet-standard/app@1.1.0').then(function(mod) {
              if (mod && typeof mod.getWallets === 'function') {
                window.getWallets = mod.getWallets;
                __wkWalletsApi = mod.getWallets();
                __wkEnsureWalletApiEvents();
              }
            }).catch(function() {}),
          ]),
          new Promise(function(r) { setTimeout(r, 5000); })
        ]);
        return __wkWalletStandardLoading;
      }

      try { __wkLoadWalletStandard(); } catch (_e) {}

      function __wkFindWalletByName(name) {
        var wallets = getSuiWallets();
        for (var i = 0; i < wallets.length; i++) {
          if (__wkWalletNamesMatch(wallets[i].name, name)) return wallets[i];
        }
        return null;
      }

      function __wkWalletNameKey(name) {
        var normalized = String(name || '').trim().toLowerCase();
        if (!normalized) return '';
        normalized = normalized.replace(/[^a-z0-9]+/g, ' ').trim();
        if (!normalized) return '';
        if (normalized.slice(-7) === ' wallet') {
          normalized = normalized.slice(0, -7).trim();
        }
        return normalized.replace(/\s+/g, '');
      }

      var __wkKnownAliases = [
        ['slush', 'slushwallet'],
        ['sui', 'suiwallet', 'mystenwallet'],
        ['suiet', 'suietwallet'],
        ['phantom', 'phantomwallet'],
        ['backpack', 'backpackwallet'],
      ];

      function __wkAliasMatch(a, b) {
        for (var g = 0; g < __wkKnownAliases.length; g++) {
          var group = __wkKnownAliases[g];
          var hasA = false, hasB = false;
          for (var i = 0; i < group.length; i++) {
            if (group[i] === a) hasA = true;
            if (group[i] === b) hasB = true;
          }
          if (hasA && hasB) return true;
        }
        return false;
      }

      function __wkWalletNamesMatch(left, right) {
        var leftRaw = String(left || '').trim().toLowerCase();
        var rightRaw = String(right || '').trim().toLowerCase();
        if (!leftRaw || !rightRaw) return false;
        if (leftRaw === rightRaw) return true;
        var leftKey = __wkWalletNameKey(leftRaw);
        var rightKey = __wkWalletNameKey(rightRaw);
        if (!leftKey || !rightKey) return false;
        if (leftKey === rightKey) return true;
        if (__wkAliasMatch(leftKey, rightKey)) return true;
        if (leftKey.length >= 5 && rightKey.length >= 5) {
          return leftKey.indexOf(rightKey) !== -1 || rightKey.indexOf(leftKey) !== -1;
        }
        return false;
      }

	      function __wkIsPopupBlockedConnectError(err) {
	        if (!err) return false;
	        var message = '';
	        if (typeof err === 'string') message = err;
	        else if (err && typeof err.message === 'string') message = err.message;
	        message = String(message || '').toLowerCase();
	        if (!message) return false;
	        return (
	          message.indexOf('failed to open new window') !== -1
	          || (message.indexOf('popup') !== -1 && message.indexOf('blocked') !== -1)
	          || (message.indexOf('new window') !== -1 && message.indexOf('failed') !== -1)
	        );
	      }

	      async function __wkInvokeConnectFeature(connectFeature, walletNameKey) {
	        var lastErr = null;
	        var methods = [];
	        var isSlushFamily = __wkAliasMatch(walletNameKey || '', 'slush');
	        if (typeof connectFeature === 'function') {
	          if (isSlushFamily) {
	            methods.push(function() { return connectFeature(); });
	          } else {
	            methods.push(function() { return connectFeature({ silent: false }); });
	            methods.push(function() { return connectFeature(); });
	          }
	        } else if (connectFeature && typeof connectFeature.connect === 'function') {
	          if (isSlushFamily) {
	            methods.push(function() { return connectFeature.connect(); });
	          } else {
	            methods.push(function() { return connectFeature.connect({ silent: false }); });
	            methods.push(function() { return connectFeature.connect(); });
	          }
	        }
	        for (var i = 0; i < methods.length; i++) {
	          try {
	            return await methods[i]();
	          } catch (err) {
	            lastErr = err;
	            if (__wkIsUserRejection(err)) throw err;
	          }
	        }
	        if (lastErr) throw lastErr;
	        throw new Error('Wallet does not support connection');
	      }

	      async function __wkTryProviderConnect(provider, singleAttempt) {
	        if (!provider || typeof provider !== 'object') return [];
	        var attempts = [];
	        if (typeof provider.requestAccounts === 'function') {
	          attempts.push(function() { return provider.requestAccounts(); });
	        }
	        if (typeof provider.requestAccount === 'function') {
	          attempts.push(function() { return provider.requestAccount(); });
	        }
	        if (typeof provider.connect === 'function') {
	          attempts.push(function() { return provider.connect({ silent: false }); });
	          if (!singleAttempt) attempts.push(function() { return provider.connect(); });
	        }
	        var lastErr = null;
	        for (var i = 0; i < attempts.length; i++) {
	          try {
	            var result = await attempts[i]();
	            var accounts = __wkFilterSuiAccounts(__wkSafeGetAccounts(result).concat(__wkSafeGetAccounts(provider)));
	            if (accounts.length > 0) return accounts;
	          } catch (err) {
	            lastErr = err;
	            if (__wkIsUserRejection(err)) throw err;
	          }
	        }
	        var discovered = __wkFilterSuiAccounts(__wkSafeGetAccounts(provider));
	        if (discovered.length > 0) return discovered;
	        if (lastErr) throw lastErr;
	        return [];
	      }

	      async function __wkTrySuiProviderFallback(wallet) {
	        var raw = wallet && wallet._raw;
	        var walletKey = __wkWalletNameKey(wallet && wallet.name ? wallet.name : '');
	        var singleAttempt = __wkAliasMatch(walletKey || '', 'slush');
	        var candidates = [
	          raw && raw.sui,
	          raw && raw.suiWallet,
	          raw && raw.wallet && raw.wallet.sui,
	          raw && raw.provider && raw.provider.sui,
	          raw && raw.wallet,
	          raw && raw.provider,
	          window.slush && window.slush.sui,
	          window.mystenWallet && window.mystenWallet.sui,
	          window.suiWallet,
	          window.sui,
	        ];
	        var seen = [];
	        var lastErr = null;
	        for (var i = 0; i < candidates.length; i++) {
	          var candidate = candidates[i];
	          if (!candidate || typeof candidate !== 'object') continue;
	          if (seen.indexOf(candidate) !== -1) continue;
	          seen.push(candidate);
	          try {
	            var accounts = await __wkTryProviderConnect(candidate, singleAttempt);
	            if (accounts && accounts.length > 0) return accounts;
	          } catch (err) {
	            lastErr = err;
	            if (__wkIsUserRejection(err)) throw err;
	          }
	        }
	        if (lastErr) throw lastErr;
	        return [];
	      }

      var __wkWaaPLoading = null;
      var __wkWaaPWallet = null;
      var __wkWaaPInitError = null;
      function __wkCanUseWaaPOnThisOrigin() {
        try {
          if (window.location.protocol === 'file:') return false;
          var origin = String(window.location.origin || '');
          return origin !== '' && origin !== 'null';
        } catch (_e) {
          return false;
        }
      }
      function __wkIsWaaPIframeBlockedOrSameOrigin(frame) {
        try {
          var href = frame && frame.contentWindow && frame.contentWindow.location
            ? String(frame.contentWindow.location.href || '')
            : '';
          if (!href || href === 'about:blank' || href.indexOf('about:srcdoc') === 0) return true;
          var origin = String((window.location && window.location.origin) || '');
          if (origin && href.indexOf(origin) === 0) return true;
          return false;
        } catch (_e) {
          // Cross-origin access throws when iframe booted correctly.
          return false;
        }
      }
      function __wkPrepareWaaPIframe(useStaging) {
        return new Promise(function(resolve) {
	          var origin = useStaging ? 'https://staging.waap.xyz' : 'https://waap.xyz';
	          var targetSrc = origin + '/iframe';
	          var containerId = 'waap-wallet-iframe-container';
	          var wrapperId = 'waap-wallet-iframe-wrapper';
	          var iframeId = 'waap-wallet-iframe';
	          var host = document.body || document.documentElement;
	          if (!host) {
	            window.addEventListener('DOMContentLoaded', function() {
	              __wkPrepareWaaPIframe(useStaging).then(resolve).catch(function() { resolve(false); });
	            }, { once: true });
	            return;
	          }

	          var container = document.getElementById(containerId);
	          if (!container) {
	            container = document.createElement('div');
	            container.id = containerId;
	            container.style.position = 'fixed';
	            container.style.top = '0';
	            container.style.left = '0';
	            container.style.right = '0';
	            container.style.bottom = '0';
	            container.style.width = '100%';
	            container.style.height = '100%';
	            container.style.display = 'none';
	            container.style.alignItems = 'center';
	            container.style.justifyContent = 'center';
	            container.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
	            container.style.zIndex = '9999999999';
	            host.appendChild(container);
	          } else if (container.parentNode !== host) {
	            host.appendChild(container);
	          }

	          var wrapper = document.getElementById(wrapperId);
	          if (!wrapper) {
	            wrapper = document.createElement('div');
	            wrapper.id = wrapperId;
	            wrapper.style.position = 'relative';
	            wrapper.style.display = 'flex';
	            wrapper.style.alignItems = 'center';
	            wrapper.style.justifyContent = 'center';
	            wrapper.style.padding = '0';
	            wrapper.style.margin = '0';
	            wrapper.style.height = '600px';
	            wrapper.style.width = '380px';
	            container.appendChild(wrapper);
	          } else if (wrapper.parentNode !== container) {
	            container.appendChild(wrapper);
	          }

	          var frame = document.getElementById(iframeId);
	          if (!frame) {
	            frame = document.createElement('iframe');
	            frame.id = iframeId;
	            frame.style.width = '100%';
	            frame.style.height = '100%';
	            frame.style.border = 'none';
	            frame.style.borderRadius = '24px';
	            frame.style.backgroundColor = 'transparent';
	            frame.style.background = 'transparent';
	            frame.style.padding = '0';
	            frame.style.margin = '0';
	            wrapper.appendChild(frame);
	          } else if (frame.parentNode !== wrapper) {
	            wrapper.appendChild(frame);
	          }

	          var done = false;
	          var timer = null;
	          function finish(ok) {
	            if (done) return;
	            done = true;
	            if (timer) clearTimeout(timer);
	            try {
	              frame.removeEventListener('load', onLoad);
	              frame.removeEventListener('error', onError);
	            } catch (_eRm) {}
	            resolve(ok);
	          }
	          function evaluate() {
	            finish(!__wkIsWaaPIframeBlockedOrSameOrigin(frame));
	          }
	          function onLoad() {
	            setTimeout(evaluate, 120);
	          }
	          function onError() {
	            finish(false);
	          }

	          frame.addEventListener('load', onLoad);
	          frame.addEventListener('error', onError);
	          timer = setTimeout(evaluate, 4500);

	          if (frame.getAttribute('src') !== targetSrc) {
	            frame.setAttribute('src', targetSrc);
	          } else {
	            setTimeout(evaluate, 80);
	          }
	        });
	      }
      function __wkGetWaaPInitFn(mod) {
        if (!mod) return null;
        if (typeof mod.initWaaPSui === 'function') return mod.initWaaPSui;
        if (mod.default && typeof mod.default === 'object' && typeof mod.default.initWaaPSui === 'function') {
          return mod.default.initWaaPSui;
        }
        return null;
      }
      function __wkRegisterWaaPWallet(wallet) {
        if (!wallet) return;
        __wkInitWalletsApi();
        if (__wkWalletsApi && typeof __wkWalletsApi.register === 'function') {
          __wkWalletsApi.register(wallet);
        } else if (typeof registerWallet === 'function') {
          registerWallet(wallet);
        } else {
          try {
            var stdMod = window.__suiWalletStandard;
            if (stdMod && typeof stdMod.registerWallet === 'function') {
              stdMod.registerWallet(wallet);
            }
          } catch (e) {}
        }
        try { __wkRefreshWalletStore(); } catch (_e) {}
      }
	      function __wkInitWaaP() {
	        if (__wkWaaPLoading) return __wkWaaPLoading;
	        __wkWaaPLoading = Promise.resolve().then(async function() {
	          var mod = null;
	          var lastImportErr = null;
	          var importSources = [
	            'https://esm.sh/@human.tech/waap-sdk@1.2.0',
	            'https://esm.sh/@human.tech/waap-sdk@1.2.0?bundle',
	          ];
	          for (var i = 0; i < importSources.length; i++) {
	            try {
	              mod = await import(importSources[i]);
	              if (mod) break;
	            } catch (importErr) {
	              lastImportErr = importErr;
	            }
	          }
	          if (!mod) throw (lastImportErr || new Error('Failed to import WaaP SDK'));
	          var initWaaPSui = __wkGetWaaPInitFn(mod);
	          if (typeof initWaaPSui !== 'function') {
	            throw new Error('WaaP SDK did not expose initWaaPSui');
	          }
	          var useStaging = false;
	          var iframeReady = false;
	          try {
	            iframeReady = await __wkPrepareWaaPIframe(useStaging);
	          } catch (_e) {
	            iframeReady = false;
	          }
	          if (!iframeReady) {
	            throw new Error('WaaP iframe did not finish loading (likely blocked by browser privacy settings or an extension).');
	          }
	          var options = { useStaging: useStaging };
	          try {
	            if (window.__wkWaaPConfig && typeof window.__wkWaaPConfig === 'object') {
	              options.config = window.__wkWaaPConfig;
	            }
	          } catch (_eConfig) {}
	          var rawWaaPWallet = initWaaPSui(options);
	          if (rawWaaPWallet && typeof rawWaaPWallet.then === 'function') {
	            rawWaaPWallet = await rawWaaPWallet;
	          }
	          if (!rawWaaPWallet || typeof rawWaaPWallet !== 'object') {
	            throw new Error('WaaP SDK returned an invalid wallet instance');
	          }
	          // Wrap with safe accounts getter so external consumers (dapp-kit-core
	          // autoconnect) never see undefined — they get [] until WaaP finishes login.
	          var wallet = Object.create(rawWaaPWallet, {
	            accounts: {
	              get: function() { return __wkSafeGetAccounts(rawWaaPWallet); },
	              enumerable: true,
	              configurable: true
	            }
	          });
	          __wkWaaPWallet = wallet;
	          window.__wkWaaPWallet = wallet;
	          __wkWaaPInitError = null;
	          window.__wkWaaPInitError = null;
	          __wkRegisterWaaPWallet(wallet);
	          return wallet;
        }).catch(function(e) {
          __wkWaaPWallet = null;
          window.__wkWaaPWallet = null;
          __wkWaaPInitError = e;
          window.__wkWaaPInitError = e;
          console.log('WaaP SDK load skipped:', e.message);
          __wkWaaPLoading = null;
          window.__wkWaaPLoading = null;
          return null;
        });
        window.__wkWaaPLoading = __wkWaaPLoading;
        return __wkWaaPLoading;
      }

      var __wkPasskeySdk = null;
      var __wkPasskeyStorageKey = 'sui_ski_passkey_public_key_b64_v1';
      var __wkPasskeyWalletName = 'Passkey Wallet';
      var __wkPasskeyRuntime = {
        provider: null,
        keypair: null,
        client: null,
        account: null
      };

      function __wkHasPasskeySupport() {
        try {
          return typeof window.PublicKeyCredential !== 'undefined'
            && !!navigator.credentials
            && typeof navigator.credentials.get === 'function'
            && typeof navigator.credentials.create === 'function';
        } catch (e) {
          return false;
        }
      }

      function __wkGetRpcUrlForNetwork() {
        if (__wkNetwork === 'testnet') return 'https://fullnode.testnet.sui.io:443';
        if (__wkNetwork === 'devnet') return 'https://fullnode.devnet.sui.io:443';
        return 'https://fullnode.mainnet.sui.io:443';
      }

      function __wkGetPasskeyRpId() {
        var host = window.location && window.location.hostname ? String(window.location.hostname) : '';
        if (!host) return 'sui.ski';
        if (host === 'sui.ski' || host.endsWith('.sui.ski')) return 'sui.ski';
        return host;
      }

      function __wkBytesToB64(bytes) {
        if (!bytes || typeof bytes.length !== 'number') return '';
        var CHUNK = 8192;
        var parts = [];
        for (var i = 0; i < bytes.length; i += CHUNK) {
          parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
        }
        return btoa(parts.join(''));
      }

      function __wkB64ToBytes(value) {
        if (!value || typeof value !== 'string') return null;
        var raw = atob(value);
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
      }

      var __wkPasskeyCookieName = 'passkey_pk';

      function __wkSetPasskeyCookie(b64Value) {
        var domain = '';
        try {
          var host = window.location.hostname;
          if (host === 'sui.ski' || host.endsWith('.sui.ski')) domain = '; domain=.sui.ski';
        } catch (_e) {}
        document.cookie = __wkPasskeyCookieName + '=' + encodeURIComponent(b64Value) + domain + '; path=/; max-age=31536000; secure; samesite=lax';
      }

      function __wkGetPasskeyCookie() {
        try {
          var cookies = document.cookie ? document.cookie.split(';') : [];
          for (var i = 0; i < cookies.length; i++) {
            var part = String(cookies[i] || '').trim();
            if (!part) continue;
            var eqIndex = part.indexOf('=');
            if (eqIndex <= 0) continue;
            if (part.slice(0, eqIndex).trim() !== __wkPasskeyCookieName) continue;
            return decodeURIComponent(part.slice(eqIndex + 1).trim());
          }
          return '';
        } catch (_e) { return ''; }
      }

      function __wkClearPasskeyCookie() {
        var domain = '';
        try {
          var host = window.location.hostname;
          if (host === 'sui.ski' || host.endsWith('.sui.ski')) domain = '; domain=.sui.ski';
        } catch (_e) {}
        document.cookie = __wkPasskeyCookieName + '=' + domain + '; path=/; max-age=0; secure; samesite=lax';
      }

      function __wkCreatePasskeyAccount(address, publicKey) {
        return {
          address: address,
          publicKey: publicKey,
          chains: ['sui:mainnet', 'sui:testnet', 'sui:devnet']
        };
      }

      function __wkClearPasskeyRuntime() {
        __wkPasskeyRuntime.provider = null;
        __wkPasskeyRuntime.keypair = null;
        __wkPasskeyRuntime.client = null;
        __wkPasskeyRuntime.account = null;
        try { localStorage.removeItem(__wkPasskeyStorageKey); } catch (_e) {}
        __wkClearPasskeyCookie();
      }

      async function __wkLoadPasskeySdk() {
        if (__wkPasskeySdk) return __wkPasskeySdk;
        var passkeyModule = await import('https://esm.sh/@mysten/sui@2.4.0/keypairs/passkey?bundle');
        var clientModule = await import('https://esm.sh/@mysten/sui@2.4.0/client?bundle');
        var PasskeyKeypair = passkeyModule && passkeyModule.PasskeyKeypair;
        var BrowserPasskeyProvider = passkeyModule && passkeyModule.BrowserPasskeyProvider;
        var SuiClient = clientModule && (clientModule.SuiClient || clientModule.SuiJsonRpcClient);
        if (!PasskeyKeypair || !BrowserPasskeyProvider || !SuiClient) {
          throw new Error('Passkey SDK unavailable in this browser');
        }
        __wkPasskeySdk = {
          PasskeyKeypair: PasskeyKeypair,
          BrowserPasskeyProvider: BrowserPasskeyProvider,
          SuiClient: SuiClient
        };
        return __wkPasskeySdk;
      }

      function __wkSetPasskeyKeypair(keypair, provider) {
        var publicKey = keypair && typeof keypair.getPublicKey === 'function' ? keypair.getPublicKey() : null;
        var address = publicKey && typeof publicKey.toSuiAddress === 'function' ? publicKey.toSuiAddress() : '';
        if (!address && keypair && typeof keypair.toSuiAddress === 'function') {
          address = keypair.toSuiAddress();
        }
        if (!address) throw new Error('Failed to derive passkey wallet address');
        var account = __wkCreatePasskeyAccount(address, publicKey || null);
        __wkPasskeyRuntime.provider = provider;
        __wkPasskeyRuntime.keypair = keypair;
        __wkPasskeyRuntime.account = account;
        if (!__wkPasskeyRuntime.client) {
          __wkPasskeyRuntime.client = new __wkPasskeySdk.SuiClient({ url: __wkGetRpcUrlForNetwork() });
        }
        if (publicKey && typeof publicKey.toRawBytes === 'function') {
          try {
            var rawBytes = publicKey.toRawBytes();
            if (rawBytes && rawBytes.length > 0) {
              var b64Pk = __wkBytesToB64(rawBytes);
              localStorage.setItem(__wkPasskeyStorageKey, b64Pk);
              __wkSetPasskeyCookie(b64Pk);
            }
          } catch (e) {}
        }
        return account;
      }

      async function __wkConnectPasskeyWallet() {
        if (!__wkHasPasskeySupport()) {
          throw new Error('Passkeys are not supported in this browser');
        }
        var sdk = await __wkLoadPasskeySdk();
        var provider = new sdk.BrowserPasskeyProvider('sui.ski', {
          rp: {
            id: __wkGetPasskeyRpId(),
            name: 'sui.ski'
          },
          timeout: 120000,
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'required'
          }
        });

        var storedPk = '';
        try { storedPk = localStorage.getItem(__wkPasskeyStorageKey) || ''; } catch (_e) {}
        if (!storedPk) storedPk = __wkGetPasskeyCookie();
        if (storedPk) {
          try {
            var restored = new sdk.PasskeyKeypair(__wkB64ToBytes(storedPk), provider);
            var restoredAccount = __wkSetPasskeyKeypair(restored, provider);
            return { accounts: [restoredAccount] };
          } catch (_e) {
            try { localStorage.removeItem(__wkPasskeyStorageKey); } catch (_ignore) {}
            __wkClearPasskeyCookie();
            __wkClearPasskeyRuntime();
          }
        }

        if (!sdk.PasskeyKeypair || typeof sdk.PasskeyKeypair.getPasskeyInstance !== 'function') {
          throw new Error('Passkey wallet creation is unavailable');
        }
        var created = await sdk.PasskeyKeypair.getPasskeyInstance(provider);
        var createdAccount = __wkSetPasskeyKeypair(created, provider);
        return { accounts: [createdAccount] };
      }

      async function __wkEnsurePasskeyWallet() {
        if (__wkPasskeyRuntime.keypair && __wkPasskeyRuntime.account) return __wkPasskeyRuntime;
        await __wkConnectPasskeyWallet();
        if (__wkPasskeyRuntime.keypair && __wkPasskeyRuntime.account) return __wkPasskeyRuntime;
        throw new Error('Failed to connect passkey wallet');
      }

      async function __wkPasskeyTryCalls(calls, fallbackMessage) {
        var lastErr = null;
        for (var i = 0; i < calls.length; i++) {
          try {
            var result = await calls[i]();
            if (typeof result !== 'undefined') return result;
          } catch (err) {
            lastErr = err;
          }
        }
        if (lastErr && lastErr.message) throw new Error(lastErr.message);
        throw new Error(fallbackMessage || 'Passkey wallet operation failed');
      }

      async function __wkPasskeySignAndExecute(input) {
        var runtime = await __wkEnsurePasskeyWallet();
        var keypair = runtime.keypair;
        var client = runtime.client;
        var tx = input && (input.transaction || input.transactionBlock);
        var options = input && input.options;
        if (!tx) throw new Error('Missing transaction for passkey execution');
        return __wkPasskeyTryCalls([
          async function() {
            if (!client || typeof client.signAndExecuteTransaction !== 'function') return undefined;
            return client.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: options || {} });
          },
          async function() {
            if (!client || typeof client.signAndExecuteTransactionBlock !== 'function') return undefined;
            return client.signAndExecuteTransactionBlock({ signer: keypair, transactionBlock: tx, options: options || {} });
          },
          async function() {
            if (!client || typeof client.signAndExecuteTransaction !== 'function') return undefined;
            return client.signAndExecuteTransaction({ signer: keypair, transactionBlock: tx, options: options || {} });
          },
        ], 'Passkey wallet cannot execute this transaction');
      }

      async function __wkPasskeySignTransaction(input) {
        var runtime = await __wkEnsurePasskeyWallet();
        var keypair = runtime.keypair;
        var client = runtime.client;
        var tx = input && (input.transaction || input.transactionBlock);
        if (!tx) throw new Error('Missing transaction for passkey signing');
        return __wkPasskeyTryCalls([
          async function() {
            if (!keypair || typeof keypair.signTransaction !== 'function') return undefined;
            return keypair.signTransaction(tx);
          },
          async function() {
            if (!keypair || typeof keypair.signTransactionBlock !== 'function') return undefined;
            return keypair.signTransactionBlock(tx);
          },
          async function() {
            if (!client || typeof client.signTransaction !== 'function') return undefined;
            return client.signTransaction({ signer: keypair, transaction: tx });
          },
          async function() {
            if (!client || typeof client.signTransactionBlock !== 'function') return undefined;
            return client.signTransactionBlock({ signer: keypair, transactionBlock: tx });
          },
        ], 'Passkey wallet cannot sign this transaction');
      }

      async function __wkPasskeySignPersonalMessage(input) {
        var runtime = await __wkEnsurePasskeyWallet();
        var keypair = runtime.keypair;
        var message = input && input.message ? input.message : input;
        if (!message || (typeof message.length !== 'number' && typeof message.byteLength !== 'number')) {
          throw new Error('Missing message bytes for passkey signing');
        }
        if (keypair && typeof keypair.signPersonalMessage === 'function') {
          try { return await keypair.signPersonalMessage({ message: message }); } catch (_e) {}
          return keypair.signPersonalMessage(message);
        }
        throw new Error('Passkey wallet does not support personal message signing');
      }

      function __wkCreatePasskeyWallet() {
        return {
          name: __wkPasskeyWalletName,
          icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHJ4PSI4IiBmaWxsPSIjMTExODI3Ii8+PHBhdGggZmlsbD0iIzYwQTVGQSIgZD0iTTI0IDE3YTYgNiAwIDEgMC04IDUuNjZWMjdoM3YtNGg0djRoM3YtNmgtNS4xQTMuOTkgMy45OSAwIDAgMSAyNCAxN1ptLTYtMmEyIDIgMCAxIDEgMCA0IDIgMiAwIDAgMSAwLTRaIi8+PC9zdmc+",
          chains: ['sui:mainnet', 'sui:testnet', 'sui:devnet'],
          features: {
            'standard:connect': { connect: __wkConnectPasskeyWallet },
            'standard:disconnect': { disconnect: __wkClearPasskeyRuntime },
            'sui:signAndExecuteTransaction': { signAndExecuteTransaction: __wkPasskeySignAndExecute },
            'sui:signAndExecuteTransactionBlock': { signAndExecuteTransactionBlock: __wkPasskeySignAndExecute },
            'sui:signTransaction': { signTransaction: __wkPasskeySignTransaction },
            'sui:signTransactionBlock': { signTransactionBlock: __wkPasskeySignTransaction },
            'sui:signPersonalMessage': { signPersonalMessage: __wkPasskeySignPersonalMessage }
          },
          get accounts() {
            return __wkPasskeyRuntime.account ? [__wkPasskeyRuntime.account] : [];
          },
          __isPasskey: true
        };
      }

	      var __wkWindowWallets = [
	        { check: function() { return window.phantom && window.phantom.sui; }, name: 'Phantom', icon: "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTA4IiBoZWlnaHQ9IjEwOCIgdmlld0JveD0iMCAwIDEwOCAxMDgiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIxMDgiIGhlaWdodD0iMTA4IiByeD0iMjYiIGZpbGw9IiNBQjlGRjIiLz4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik00Ni41MjY3IDY5LjkyMjlDNDIuMDA1NCA3Ni44NTA5IDM0LjQyOTIgODUuNjE4MiAyNC4zNDggODUuNjE4MkMxOS41ODI0IDg1LjYxODIgMTUgODMuNjU2MyAxNSA3NS4xMzQyQzE1IDUzLjQzMDUgNDQuNjMyNiAxOS44MzI3IDcyLjEyNjggMTkuODMyN0M4Ny43NjggMTkuODMyNyA5NCAzMC42ODQ2IDk0IDQzLjAwNzlDOTQgNTguODI1OCA4My43MzU1IDc2LjkxMjIgNzMuNTMyMSA3Ni45MTIyQzcwLjI5MzkgNzYuOTEyMiA2OC43MDUzIDc1LjEzNDIgNjguNzA1MyA3Mi4zMTRDNjguNzA1MyA3MS41NzgzIDY4LjgyNzUgNzAuNzgxMiA2OS4wNzE5IDY5LjkyMjlDNjUuNTg5MyA3NS44Njk5IDU4Ljg2ODUgODEuMzg3OCA1Mi41NzU0IDgxLjM4NzhDNDcuOTkzIDgxLjM4NzggNDUuNjcxMyA3OC41MDYzIDQ1LjY3MTMgNzQuNDU5OEM0NS42NzEzIDcyLjk4ODQgNDUuOTc2OCA3MS40NTU2IDQ2LjUyNjcgNjkuOTIyOVpNODMuNjc2MSA0Mi41Nzk0QzgzLjY3NjEgNDYuMTcwNCA4MS41NTc1IDQ3Ljk2NTggNzkuMTg3NSA0Ny45NjU4Qzc2Ljc4MTYgNDcuOTY1OCA3NC42OTg5IDQ2LjE3MDQgNzQuNjk4OSA0Mi41Nzk0Qzc0LjY5ODkgMzguOTg4NSA3Ni43ODE2IDM3LjE5MzEgNzkuMTg3NSAzNy4xOTMxQzgxLjU1NzUgMzcuMTkzMSA4My42NzYxIDM4Ljk4ODUgODMuNjc2MSA0Mi41Nzk0Wk03MC4yMTAzIDQyLjU3OTVDNzAuMjEwMyA0Ni4xNzA0IDY4LjA5MTYgNDcuOTY1OCA2NS43MjE2IDQ3Ljk2NThDNjMuMzE1NyA0Ny45NjU4IDYxLjIzMyA0Ni4xNzA0IDYxLjIzMyA0Mi41Nzk1QzYxLjIzMyAzOC45ODg1IDYzLjMxNTcgMzcuMTkzMSA2NS43MjE2IDM3LjE5MzFDNjguMDkxNiAzNy4xOTMxIDcwLjIxMDMgMzguOTg4NSA3MC4yMTAzIDQyLjU3OTVaIiBmaWxsPSIjRkZGREY4Ii8+Cjwvc3ZnPgo=" },
	        { check: function() { return (window.backpack && (window.backpack.sui || window.backpack)) || null; }, name: 'Backpack', icon: 'https://backpack.app/favicon.ico' },
        { check: function() {
          var slush = window.slush && (window.slush.sui || window.slush.wallet || window.slush);
          return slush || null;
        }, name: 'Slush', icon: './assets/slush-logo.svg' },
	        { check: function() { return (window.suiet && (window.suiet.sui || window.suiet.wallet || window.suiet)) || null; }, name: 'Suiet', icon: 'https://suiet.app/favicon.ico' },
	        { check: function() { return window.martian && window.martian.sui; }, name: 'Martian', icon: 'https://martianwallet.xyz/favicon.ico' },
	        { check: function() { return (window.ethos && (window.ethos.sui || window.ethos.wallet || window.ethos)) || null; }, name: 'Ethos', icon: 'https://ethoswallet.xyz/favicon.ico' },
	        { check: function() { return window.okxwallet && window.okxwallet.sui; }, name: 'OKX Wallet', icon: 'https://static.okx.com/cdn/assets/imgs/226/EB771A4D4E5CC234.png' },
	        { check: function() { return (window.mystenWallet && (window.mystenWallet.sui || window.mystenWallet)) || null; }, name: 'Sui Wallet', icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIGZpbGw9IiM2RkJDRjAiIHJ4PSI4Ii8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI4LjYsMTUuM2MtLjktMy4yLTQuNi01LjUtOS4yLTUuNXMtOC4zLDIuMy05LjIsNS41Yy0uMi44LS4zLDEuNi0uMywyLjRzLjEsMS43LjMsMi41Yy45LDMuMiw0LjYsNS41LDkuMiw1LjVzOC4zLTIuMyw5LjItNS41Yy4yLS44LjMtMS42LjMtMi41cy0uMS0xLjYtLjMtMi40WiIvPjxwYXRoIGZpbGw9IiM2RkJDRjAiIGQ9Ik0xOS40LDE0LjVjLTIuNCwwLTQuMywxLjQtNC4zLDMuMXMxLjksMy4xLDQuMywzLjEsNC4zLTEuNCw0LjMtMy4xLTEuOS0zLjEtNC4zLTMuMVoiLz48L3N2Zz4=" },
	        { check: function() { return window.suiWallet; }, name: 'Sui Wallet', icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIGZpbGw9IiM2RkJDRjAiIHJ4PSI4Ii8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI4LjYsMTUuM2MtLjktMy4yLTQuNi01LjUtOS4yLTUuNXMtOC4zLDIuMy05LjIsNS41Yy0uMi44LS4zLDEuNi0uMywyLjRzLjEsMS43LjMsMi41Yy45LDMuMiw0LjYsNS41LDkuMiw1LjVzOC4zLTIuMyw5LjItNS41Yy4yLS44LjMtMS42LjMtMi41cy0uMS0xLjYtLjMtMi40WiIvPjxwYXRoIGZpbGw9IiM2RkJDRjAiIGQ9Ik0xOS40LDE0LjVjLTIuNCwwLTQuMywxLjQtNC4zLDMuMXMxLjksMy4xLDQuMywzLjEsNC4zLTEuNCw0LjMtMy4xLTEuOS0zLjEtNC4zLTMuMVoiLz48L3N2Zz4=" },
	        { check: function() { return window.sui; }, name: 'Sui Wallet', icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48cmVjdCB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIGZpbGw9IiM2RkJDRjAiIHJ4PSI4Ii8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTI4LjYsMTUuM2MtLjktMy4yLTQuNi01LjUtOS4yLTUuNXMtOC4zLDIuMy05LjIsNS41Yy0uMi44LS4zLDEuNi0uMywyLjRzLjEsMS43LjMsMi41Yy45LDMuMiw0LjYsNS41LDkuMiw1LjVzOC4zLTIuMyw5LjItNS41Yy4yLS44LjMtMS42LjMtMi41cy0uMS0xLjYtLjMtMi40WiIvPjxwYXRoIGZpbGw9IiM2RkJDRjAiIGQ9Ik0xOS40LDE0LjVjLTIuNCwwLTQuMywxLjQtNC4zLDMuMXMxLjksMy4xLDQuMywzLjEsNC4zLTEuNCw0LjMtMy4xLTEuOS0zLjEtNC4zLTMuMVoiLz48L3N2Zz4=" }
	      ];

	      function __wkUnwrapWalletProvider(provider) {
	        if (!provider || typeof provider !== 'object') return null;
	        var candidates = [
	          provider.sui,
	          provider.suiWallet,
	          provider.wallet && provider.wallet.sui,
	          provider.provider && provider.provider.sui,
	          provider.wallet,
	          provider.provider,
	        ];
	        for (var i = 0; i < candidates.length; i++) {
	          var candidate = candidates[i];
	          if (!candidate || typeof candidate !== 'object') continue;
	          if (__wkIsSuiCapableWallet(candidate)) return candidate;
	        }
	        if (__wkIsSuiCapableWallet(provider)) return provider;
	        return provider;
	      }

	      function __wkGetProviderObject(wallet) {
	        if (!wallet || typeof wallet !== 'object') return null;
	        var raw = wallet._raw;
	        if (raw && typeof raw === 'object') return raw;
	        return wallet;
	      }

	      function __wkGetWalletSeenKey(wallet) {
	        if (!wallet || typeof wallet !== 'object') return '';
	        var name = wallet.name ? String(wallet.name) : '';
	        var icon = wallet.icon ? String(wallet.icon) : '';
	        var featureNames = [];
	        if (wallet.features && typeof wallet.features === 'object') {
	          featureNames = Object.keys(wallet.features).sort();
	        }
	        return name + '|' + icon + '|' + featureNames.join(',');
	      }

	      function __wkHasSeenWallet(wallet, seenProviders, seenKeys) {
	        var provider = __wkGetProviderObject(wallet);
	        if (provider && seenProviders) {
	          try {
	            if (seenProviders.has(provider)) return true;
	          } catch (e) {}
	        }
	        var key = __wkGetWalletSeenKey(wallet);
	        if (key && seenKeys[key]) return true;
	        var name = wallet && wallet.name ? String(wallet.name).toLowerCase() : '';
	        if (name && seenKeys['__name__' + name]) return true;
	        return false;
	      }

	      function __wkMarkSeenWallet(wallet, seenProviders, seenKeys) {
	        var provider = __wkGetProviderObject(wallet);
	        if (provider && seenProviders) {
	          try {
	            seenProviders.add(provider);
	          } catch (e) {}
	        }
	        var key = __wkGetWalletSeenKey(wallet);
	        if (key) seenKeys[key] = true;
	        var name = wallet && wallet.name ? String(wallet.name).toLowerCase() : '';
	        if (name) seenKeys['__name__' + name] = true;
	      }

	      function __wkWalletPriority(wallet) {
	        if (!wallet) return 50;
	        if (wallet.__isPasskey) return 99;
	        var name = __wkWalletNameKey(wallet.name);
	        if (name === 'phantom') return 0;
	        if (name === 'waap' || name.indexOf('waap') !== -1) return 1;
	        if (name === 'backpack') return 2;
	        if (name === 'slush' || name === 'slushwallet') return 3;
	        if (name === 'suiet') return 4;
	        if (name === 'sui' || name === 'martian' || name === 'ethos') return 5;
	        if (name.indexOf('okx') !== -1) return 6;
	        return 10;
	      }

	      function __wkSortWallets(wallets) {
	        if (!Array.isArray(wallets)) return [];
	        return wallets.slice().sort(function(a, b) {
	          var pa = __wkWalletPriority(a);
	          var pb = __wkWalletPriority(b);
	          if (pa !== pb) return pa - pb;
	          var an = a && a.name ? String(a.name) : '';
	          var bn = b && b.name ? String(b.name) : '';
	          return an.localeCompare(bn);
	        });
	      }

	      function __wkWalletListSignature(wallets) {
	        if (!Array.isArray(wallets) || wallets.length === 0) return '';
	        var parts = [];
	        for (var i = 0; i < wallets.length; i++) {
	          var wallet = wallets[i];
	          if (!wallet) continue;
	          var key = __wkWalletNameKey(wallet.name);
	          var icon = wallet.icon ? String(wallet.icon) : '';
	          var passkey = wallet.__isPasskey ? '1' : '0';
	          var hasRaw = wallet._raw ? '1' : '0';
	          parts.push(key + ':' + icon + ':' + passkey + ':' + hasRaw);
	        }
	        return parts.join('|');
	      }

	      function __wkWalletListsEqual(left, right) {
	        return __wkWalletListSignature(left) === __wkWalletListSignature(right);
	      }

	      function __wkSetWalletStoreIfChanged(wallets) {
	        var next = Array.isArray(wallets) ? wallets : [];
	        var current = $wallets.value || [];
	        if (!__wkWalletListsEqual(current, next)) {
	          $wallets.set(next);
	        }
	      }

	      function __wkRefreshWalletStore() {
	        __wkSetWalletStoreIfChanged(getSuiWallets());
	      }

	      function __wkEnsureWalletApiEvents() {
	        __wkInitWalletsApi();
	        if (!__wkWalletsApi || !__wkWalletsApi.on || __wkWalletApiEventsBound) return;
	        __wkWalletApiEventsBound = true;
	        var onChange = function() {
	          __wkRefreshWalletStore();
	        };
	        try { __wkWalletsApi.on('register', onChange); } catch (e) {}
	        try { __wkWalletsApi.on('unregister', onChange); } catch (e) {}
	        try { __wkWalletsApi.on('change', onChange); } catch (e) {}
	      }

      function getSuiWallets() {
        __wkInitWalletsApi();
        var wallets = [];
        var seenProviders = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
        var seenKeys = {};

        if (__wkWalletsApi) {
          try {
            var standardWallets = __wkWalletsApi.get();
            for (var i = 0; i < standardWallets.length; i++) {
              var sw = __wkUnwrapWalletProvider(standardWallets[i]);
              if (!sw || !__wkIsSuiCapableWallet(sw)) continue;
              if (__wkHasSeenWallet(sw, seenProviders, seenKeys)) continue;
              wallets.push(sw);
              __wkMarkSeenWallet(sw, seenProviders, seenKeys);
            }
          } catch (e) {}
        }

        var injected = Array.isArray(window.__sui_wallets__) ? window.__sui_wallets__ : [];
        for (var j = 0; j < injected.length; j++) {
          var iw = __wkUnwrapWalletProvider(injected[j]);
          if (!iw || !__wkIsSuiCapableWallet(iw)) continue;
          if (__wkHasSeenWallet(iw, seenProviders, seenKeys)) continue;
          wallets.push(iw);
          __wkMarkSeenWallet(iw, seenProviders, seenKeys);
        }

        for (var k = 0; k < __wkWindowWallets.length; k++) {
          var wc = __wkWindowWallets[k];
          try {
            var injectedProvider = wc.check();
            var w = __wkUnwrapWalletProvider(injectedProvider);
            if (w && typeof w === 'object') {
              var source = w;
              if (!__wkIsSuiCapableWallet(source)) {
                source = __wkPickInjectedSource(w, injectedProvider);
              }
              if (!source || typeof source !== 'object') continue;
              if (!__wkIsSuiCapableWallet(source) && !__wkHasConnectMethod(source)) continue;
              var wrappedWallet = {
                name: wc.name,
                icon: source.icon || w.icon || wc.icon,
	                chains: ['sui:mainnet', 'sui:testnet', 'sui:devnet'],
	                features: source.features || {
	                  'standard:connect': source.connect
	                    ? { connect: source.connect.bind(source) }
	                    : (source.requestAccounts
	                        ? { connect: source.requestAccounts.bind(source) }
	                        : (source.requestAccount ? { connect: source.requestAccount.bind(source) } : undefined)),
	                  'standard:disconnect': source.disconnect ? { disconnect: source.disconnect.bind(source) } : undefined,
	                  'sui:signAndExecuteTransaction': source.signAndExecuteTransaction
	                    ? { signAndExecuteTransaction: source.signAndExecuteTransaction.bind(source) } : undefined,
                  'sui:signAndExecuteTransactionBlock': source.signAndExecuteTransactionBlock
                    ? { signAndExecuteTransactionBlock: source.signAndExecuteTransactionBlock.bind(source) } : undefined,
	                  'sui:signTransaction': source.signTransaction
	                    ? { signTransaction: source.signTransaction.bind(source) } : undefined
                },
                get accounts() { 
                  var self = this;
                  if (!self) return [];
                  var raw = self._raw;
                  return __wkSafeGetAccounts(raw || self); 
                },
                _raw: source
              };
              if (__wkHasSeenWallet(wrappedWallet, seenProviders, seenKeys)) continue;
              wallets.push(wrappedWallet);
              __wkMarkSeenWallet(wrappedWallet, seenProviders, seenKeys);
            }
          } catch (e) {}
        }

        if (wallets.length === 0 && __wkHasPasskeySupport()) {
          var passkeyWallet = __wkCreatePasskeyWallet();
          wallets.push(passkeyWallet);
          __wkMarkSeenWallet(passkeyWallet, seenProviders, seenKeys);
        }

	        return __wkSortWallets(wallets);
	      }

      function __wkIsMobileDevice() {
        try {
          var ua = navigator.userAgent || '';
          var uaDataMobile = navigator.userAgentData && navigator.userAgentData.mobile === true;
          var uaMobile = /android|iphone|ipad|ipod|mobile/i.test(ua);
          var touchLike = navigator.maxTouchPoints > 1;
          var smallViewport = Math.min(window.innerWidth || 0, window.innerHeight || 0) <= 900;
          return Boolean(uaDataMobile || uaMobile || (touchLike && smallViewport));
        } catch (e) {
          return false;
        }
      }

      function __wkIsInAppBrowser() {
        var ua = navigator.userAgent || '';
        return /Phantom/i.test(ua) || /Slush/i.test(ua);
      }

      function __wkPollAccounts(getAccountsFn, maxAttempts, intervalMs) {
        return new Promise(function(resolve) {
          var attempt = 0;
          function check() {
            var accounts = getAccountsFn();
            if (accounts.length > 0) { resolve(accounts); return; }
            attempt++;
            if (attempt >= maxAttempts) { resolve([]); return; }
            setTimeout(check, intervalMs);
          }
          check();
        });
      }

      var __wkDetectWalletsInFlight = null;
      var __wkDetectWalletsLastResult = [];
      var __wkDetectWalletsLastAt = 0;

	      function detectWallets() {
	        if (__wkDetectWalletsInFlight) return __wkDetectWalletsInFlight;
	        var now = Date.now();
	        if ((now - __wkDetectWalletsLastAt) < 1500 && __wkDetectWalletsLastResult.length > 0) {
	          __wkSetWalletStoreIfChanged(__wkDetectWalletsLastResult);
	          return Promise.resolve(__wkDetectWalletsLastResult);
	        }
	        if (__wkIsSubdomain()) {
	          try { __wkInitSignBridge(); } catch (_e) {}
	        }
	        __wkLoadWalletStandard();
	        __wkEnsureWalletApiEvents();
	        var immediate = getSuiWallets();
	        if (immediate.length > 0) {
	          __wkSetWalletStoreIfChanged(immediate);
	        }
	        if (__wkIsSubdomain()) {
	          __wkSendWalletHintsToBridge(immediate);
	        }

	        __wkDetectWalletsInFlight = new Promise(function(resolve) {
          function scheduleBackgroundRefresh(attempt) {
            if (attempt >= 4) return;
            var delay = attempt === 0 ? 120 : attempt <= 2 ? 260 : attempt <= 5 ? 520 : 900;
            setTimeout(function() {
              __wkRefreshWalletStore();
              scheduleBackgroundRefresh(attempt + 1);
            }, delay);
          }

          scheduleBackgroundRefresh(0);

          if (__wkWalletStandardLoading) {
            __wkWalletStandardLoading.then(function() {
              __wkRefreshWalletStore();
            });
          }

          if (immediate.length > 0) {
            resolve(immediate);
            return;
          }

          var resolved = false;
          var attempts = 0;
          var maxAttempts = 12;

          function finish(wallets) {
            if (resolved) return;
            resolved = true;
            __wkSetWalletStoreIfChanged(wallets);
            __wkDetectWalletsLastResult = Array.isArray(wallets) ? wallets.slice() : [];
            __wkDetectWalletsLastAt = Date.now();
            if (__wkIsSubdomain()) {
              __wkSendWalletHintsToBridge(wallets);
            }
            resolve(wallets);
          }

          function poll() {
            if (resolved) return;
            var wallets = getSuiWallets();
            if (wallets.length > 0) { finish(wallets); return; }
            attempts++;
            if (attempts >= maxAttempts) { finish([]); return; }
            var delay = attempts <= 2 ? 120 : attempts <= 8 ? 240 : 500;
            setTimeout(poll, delay);
          }
          poll();
        });
	        return __wkDetectWalletsInFlight.finally(function() {
	          __wkDetectWalletsInFlight = null;
	        });
      }

	      function connect(wallet) {
	        if (!wallet) return Promise.reject(new Error('No wallet selected'));
        $connection.set({
          wallet: null, account: null, address: null,
          status: 'connecting', primaryName: null
        });

        return new Promise(function(resolve, reject) {
          (async function() {
            try {
              if (wallet && wallet.name && !wallet.features && !wallet._raw && !wallet.__isPasskey) {
                await __wkLoadWalletStandard();
                var realWallet = null;
                for (var __resolveAttempt = 0; __resolveAttempt < 20; __resolveAttempt++) {
                  realWallet = __wkFindWalletByName(wallet.name);
                  if (realWallet) break;
                  await new Promise(function(r) { setTimeout(r, 200); });
                }
                if (realWallet) {
                  wallet = realWallet;
                } else {
                  throw new Error(wallet.name + ' wallet extension not detected. Make sure it is installed and enabled, then refresh the page.');
                }
              }

              var phantomProvider = (window.phantom && window.phantom.sui) || window.sui;
              var isPhantom = phantomProvider && (
                __wkWalletNamesMatch(wallet.name, 'Phantom')
                || wallet._raw === phantomProvider
                || (wallet._raw && wallet._raw.isPhantom)
              );

	              if (isPhantom) {
	                var existing = __wkFilterSuiAccounts(
	                  __wkSafeGetAccounts(phantomProvider).concat(__wkSafeGetAccounts(wallet))
	                );
	                if (existing.length > 0) {
	                  __wkFinishConnect(wallet, existing);
	                  resolve(existing[0]); return;
	                }
	                var phantomLastError = null;

	                var phantomConnectFeature = wallet.features && wallet.features['standard:connect'];
	                if (phantomConnectFeature) {
	                  try {
	                    var standardConnectResult;
	                    if (typeof phantomConnectFeature === 'function') {
	                      standardConnectResult = await phantomConnectFeature();
	                    } else if (typeof phantomConnectFeature.connect === 'function') {
	                      standardConnectResult = await phantomConnectFeature.connect();
	                    }
	                    var standardConnectAccounts = __wkExtractConnectedAccounts(standardConnectResult, wallet);
	                    if (standardConnectAccounts.length > 0) {
	                      __wkFinishConnect(wallet, standardConnectAccounts);
	                      resolve(standardConnectAccounts[0]); return;
	                    }
	                    var standardConnectAddress = __wkExtractPhantomAddress(standardConnectResult);
	                    var standardConnectAccount = __wkBuildPhantomAccount(standardConnectAddress);
	                    if (standardConnectAccount) {
	                      __wkFinishConnect(wallet, [standardConnectAccount]);
	                      resolve(standardConnectAccount); return;
	                    }
	                  } catch (err) {
	                    phantomLastError = err;
	                  }
	                }

	                if (typeof phantomProvider.requestAccounts === 'function') {
	                  try {
	                    var requestAccountsResult = await phantomProvider.requestAccounts();
	                    var requestAccountsList = __wkExtractConnectedAccounts(requestAccountsResult, wallet);
	                    if (requestAccountsList.length > 0) {
	                      __wkFinishConnect(wallet, requestAccountsList);
	                      resolve(requestAccountsList[0]); return;
	                    }
	                    var requestAccountsAddress = __wkExtractPhantomAddress(requestAccountsResult);
	                    var requestAccountsAccount = __wkBuildPhantomAccount(requestAccountsAddress);
	                    if (requestAccountsAccount) {
	                      __wkFinishConnect(wallet, [requestAccountsAccount]);
	                      resolve(requestAccountsAccount); return;
	                    }
	                  } catch (err) {
	                    phantomLastError = err;
	                  }
	                }

	                if (typeof phantomProvider.requestAccount === 'function') {
	                  try {
	                    var requestResult = await phantomProvider.requestAccount();
	                    var requestAccounts = __wkExtractConnectedAccounts(requestResult, wallet);
	                    if (requestAccounts.length > 0) {
	                      __wkFinishConnect(wallet, requestAccounts);
	                      resolve(requestAccounts[0]); return;
	                    }
	                    var requestAddress = __wkExtractPhantomAddress(requestResult);
	                    var requestAccount = __wkBuildPhantomAccount(requestAddress);
	                    if (requestAccount) {
	                      __wkFinishConnect(wallet, [requestAccount]);
	                      resolve(requestAccount); return;
	                    }
	                  } catch (err) {
	                    phantomLastError = err;
	                  }
	                }

	                if (typeof phantomProvider.connect === 'function') {
	                  var connectVariants = [
	                    null,
	                    { onlyIfTrusted: false },
	                  ];
	                  for (var cv = 0; cv < connectVariants.length; cv++) {
	                    try {
	                      var connectVariant = connectVariants[cv];
	                      var connectResponse = connectVariant === null
	                        ? await phantomProvider.connect()
	                        : await phantomProvider.connect(connectVariant);
	                      var connectAccounts = __wkExtractConnectedAccounts(connectResponse, wallet);
	                      if (connectAccounts.length > 0) {
	                        __wkFinishConnect(wallet, connectAccounts);
	                        resolve(connectAccounts[0]); return;
	                      }
	                      var connectAddress = __wkExtractPhantomAddress(connectResponse);
	                      var connectAccount = __wkBuildPhantomAccount(connectAddress);
	                      if (connectAccount) {
	                        __wkFinishConnect(wallet, [connectAccount]);
	                        resolve(connectAccount); return;
	                      }
	                    } catch (err) {
	                      phantomLastError = err;
	                    }
	                  }
	                }

	                if (typeof phantomProvider.getAccounts === 'function') {
	                  try {
	                    var fetchedAccounts = await phantomProvider.getAccounts();
	                    var filteredFetched = __wkFilterSuiAccounts(fetchedAccounts);
	                    if (filteredFetched.length > 0) {
	                      __wkFinishConnect(wallet, filteredFetched);
	                      resolve(filteredFetched[0]); return;
	                    }
	                  } catch (err) {
	                    phantomLastError = err;
	                  }
	                }

	                var directAddress = __wkExtractPhantomAddress(phantomProvider);
	                var directAccount = __wkBuildPhantomAccount(directAddress);
	                if (directAccount) {
	                  __wkFinishConnect(wallet, [directAccount]);
	                  resolve(directAccount); return;
	                }

	                if (
	                  (phantomProvider && typeof phantomProvider.connect === 'function')
	                  || (phantomProvider && typeof phantomProvider.requestAccounts === 'function')
	                  || (phantomProvider && typeof phantomProvider.requestAccount === 'function')
	                ) {
	                  var polled = await __wkPollAccounts(
	                    function() { return __wkFilterSuiAccounts(__wkSafeGetAccounts(phantomProvider).concat(__wkSafeGetAccounts(wallet))); },
	                    10, 150
                  );
                  if (polled.length > 0) {
	                    __wkFinishConnect(wallet, polled);
	                    resolve(polled[0]); return;
	                  }
	                }
	                if (phantomLastError) {
	                  if (__wkIsUserRejection(phantomLastError)) {
	                    throw phantomLastError;
	                  }
	                  if (__wkIsPhantomAuthError(phantomLastError)) {
	                    throw new Error('Phantom blocked Sui account authorization for this site. In Phantom, approve this site for Sui accounts and retry.');
	                  }
	                  if (phantomLastError.message) {
	                    throw new Error(phantomLastError.message);
	                  }
	                }
	                throw new Error('Phantom connected, but no Sui address was returned. In Phantom, enable Sui and approve this site for Sui, then retry.');
	              }

	              var preExisting = __wkFilterSuiAccounts(__wkSafeGetAccounts(wallet));
	              if (preExisting.length > 0) {
	                __wkFinishConnect(wallet, preExisting);
	                resolve(preExisting[0]); return;
	              }

	              var connectFeature = (wallet.features && wallet.features['standard:connect']) || (wallet._raw && wallet._raw.connect);
	              if (!connectFeature && wallet._raw && typeof wallet._raw.requestAccounts === 'function') {
	                connectFeature = { connect: wallet._raw.requestAccounts.bind(wallet._raw) };
	              }
	              if (!connectFeature && wallet._raw && typeof wallet._raw.requestAccount === 'function') {
	                connectFeature = { connect: wallet._raw.requestAccount.bind(wallet._raw) };
	              }
	              if (!connectFeature) throw new Error('Wallet does not support connection');

	              var walletNameKey = __wkWalletNameKey(wallet && wallet.name ? wallet.name : '');
	              var isSlushFamilyWallet = __wkAliasMatch(walletNameKey || '', 'slush');
	              var connectResult = null;
	              var connectError = null;
	              try {
	                connectResult = await __wkInvokeConnectFeature(connectFeature, walletNameKey);
	              } catch (connectErr) {
	                connectError = connectErr;
	              }
	              if (connectError) {
	                if (__wkIsPopupBlockedConnectError(connectError) && !isSlushFamilyWallet) {
	                  try {
	                    var providerFallbackAccounts = await __wkTrySuiProviderFallback(wallet);
	                    if (providerFallbackAccounts && providerFallbackAccounts.length > 0) {
                      __wkFinishConnect(wallet, providerFallbackAccounts);
                      resolve(providerFallbackAccounts[0]); return;
                    }
                  } catch (fallbackErr) {
                    connectError = fallbackErr || connectError;
                  }
                }
                throw connectError;
              }

              var accounts = __wkExtractConnectedAccounts(connectResult, wallet);

              if (!accounts || accounts.length === 0) {
                await new Promise(function(r) { setTimeout(r, 200); });
                accounts = __wkExtractConnectedAccounts(null, wallet);
              }

              if (!accounts || accounts.length === 0) {
                throw new Error('No Sui accounts. Switch your wallet to Sui and try again.');
              }

              __wkFinishConnect(wallet, accounts);
              resolve(accounts[0]);
            } catch (e) {
              if (__wkIsUserRejection(e)) {
                $connection.set({
                  wallet: null, account: null, address: null,
                  status: 'disconnected', primaryName: null
                });
                reject(e);
                return;
              }
              try {
                var fallbackAccounts = __wkFilterSuiAccounts(
                  __wkSafeGetAccounts(wallet).concat(__wkSafeGetAccounts(wallet && wallet._raw))
                );
                if (fallbackAccounts.length > 0) {
                  __wkFinishConnect(wallet, fallbackAccounts);
                  resolve(fallbackAccounts[0]); return;
                }
              } catch (e3) {}
              var phantomFallback = (window.phantom && window.phantom.sui) || window.sui;
	              var isPhantomWallet = phantomFallback && (
	                __wkWalletNamesMatch(wallet.name, 'Phantom')
	                || wallet._raw === phantomFallback
	                || (phantomFallback.isPhantom && wallet._raw && wallet._raw.isPhantom)
	              );
	              if (phantomFallback && isPhantomWallet) {
	                try {
	                  var recovered = await __wkPollAccounts(
	                    function() { return __wkFilterSuiAccounts(__wkSafeGetAccounts(phantomFallback).concat(__wkSafeGetAccounts(wallet))); },
	                    8, 200
	                  );
                  if (recovered.length > 0) {
                    __wkFinishConnect(wallet, recovered);
                    resolve(recovered[0]); return;
                  }
                } catch (e2) {}
              }
              $connection.set({
                wallet: null, account: null, address: null,
                status: 'disconnected', primaryName: null
              });
              reject(e);
            }
          })();
        });
      }

      function __wkSignPersonalMessage(wallet, account, message) {
        var feature = wallet.features && wallet.features['sui:signPersonalMessage'];
        if (feature && feature.signPersonalMessage) {
          return feature.signPersonalMessage({ account: account, message: message });
        }
        var raw = wallet._raw;
        if (raw && typeof raw.signPersonalMessage === 'function') {
          return raw.signPersonalMessage({ message: message });
        }
        if (raw && raw.signMessage && typeof raw.signMessage === 'function') {
          return raw.signMessage({ message: message });
        }
        return Promise.reject(new Error('Wallet does not support message signing'));
      }

      function __wkExtractEventAccounts(changeEvent, wallet) {
        if (changeEvent && Array.isArray(changeEvent.accounts)) {
          return __wkFilterSuiAccounts(changeEvent.accounts);
        }
        if (changeEvent && Array.isArray(changeEvent.nextAccounts)) {
          return __wkFilterSuiAccounts(changeEvent.nextAccounts);
        }
        if (changeEvent && changeEvent.wallet && Array.isArray(changeEvent.wallet.accounts)) {
          return __wkFilterSuiAccounts(changeEvent.wallet.accounts);
        }
        return __wkFilterSuiAccounts(
          __wkSafeGetAccounts(wallet).concat(__wkSafeGetAccounts(wallet && wallet._raw))
        );
      }

      function __wkAttachWalletEvents(wallet) {
        __wkDetachWalletEvents();
        if (!wallet || !wallet.features) return;
        var eventsFeature = wallet.features['standard:events'];
        if (!eventsFeature || typeof eventsFeature.on !== 'function') return;
        try {
          __wkWalletEventsUnsub = eventsFeature.on('change', function(changeEvent) {
            var current = $connection.value;
            if (!current || current.wallet !== wallet) return;
            var accounts = __wkExtractEventAccounts(changeEvent, wallet);
            if (!accounts || accounts.length === 0) {
              __wkDetachWalletEvents();
              $connection.set({
                wallet: null,
                account: null,
                address: null,
                status: 'disconnected',
                primaryName: null
              });
              return;
            }
            var nextAccount = accounts[0];
            var nextAddress = __wkNormalizeAccountAddress(nextAccount);
            if (!nextAddress) return;
            var sameAddress = current.address === nextAddress;
            var sameStatus = current.status === 'connected';
            var nextPrimary = sameAddress ? current.primaryName : null;
            if (sameAddress && sameStatus && current.account === nextAccount) return;
            $connection.set({
              wallet: wallet,
              account: nextAccount,
              address: nextAddress,
              status: 'connected',
              primaryName: nextPrimary
            });
          });
        } catch (_e) {
          __wkWalletEventsUnsub = null;
        }
      }

      var __sessionReady = null;

      function __wkIsSubdomain() {
        var host = window.location.hostname;
        return host !== 'sui.ski' && host.endsWith('.sui.ski');
      }

      var __skiSignFrame = null;
      var __skiSignReady = null;
      var __wkBridgeWalletHintSignature = '';
      var __wkBridgeHiddenStyle = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;z-index:-1;background:transparent';
      function __wkSerializeWalletHint(wallet) {
        if (!wallet || !wallet.name) return null;
        var name = String(wallet.name);
        if (!name) return null;
        var icon = '';
        try {
          if (wallet.icon) icon = String(wallet.icon);
        } catch (_e) {}
        return {
          name: name,
          icon: icon,
          __isPasskey: !!wallet.__isPasskey
        };
      }

      function __wkCollectWalletHints(walletsInput) {
        var input = Array.isArray(walletsInput) ? walletsInput : getSuiWallets();
        var out = [];
        var seen = {};
        for (var i = 0; i < input.length; i++) {
          var serialized = __wkSerializeWalletHint(input[i]);
          if (!serialized) continue;
          var key = __wkWalletNameKey(serialized.name);
          if (!key) key = 'wallet-' + i;
          var existing = seen[key];
          if (!existing) {
            seen[key] = serialized;
            out.push(serialized);
            continue;
          }
          if (!existing.icon && serialized.icon) {
            existing.icon = serialized.icon;
          }
          if (existing.__isPasskey && !serialized.__isPasskey) {
            existing.__isPasskey = false;
          }
        }
        return out;
      }

      function __wkWalletHintSignature(wallets) {
        var list = Array.isArray(wallets) ? wallets : [];
        var parts = [];
        for (var i = 0; i < list.length; i++) {
          var wallet = list[i];
          if (!wallet || !wallet.name) continue;
          parts.push(
            __wkWalletNameKey(wallet.name)
            + '|' + String(wallet.icon || '')
            + '|' + (wallet.__isPasskey ? '1' : '0')
          );
        }
        return parts.join(',');
      }

      function __wkSendWalletHintsToBridge(walletsInput) {
        if (!__wkIsSubdomain()) return;
        var hints = __wkCollectWalletHints(walletsInput);
        if (hints.length === 0) return;
        var nextSignature = __wkWalletHintSignature(hints);
        if (nextSignature && nextSignature === __wkBridgeWalletHintSignature) return;
        if (!__skiSignFrame || !__skiSignReady) return;
        __skiSignReady.then(function(ready) {
          if (!ready || !__skiSignFrame || !__skiSignFrame.contentWindow) return;
          __wkBridgeWalletHintSignature = nextSignature;
          __skiSignFrame.contentWindow.postMessage({
            type: 'ski:wallet-hints',
            wallets: hints,
          }, 'https://sui.ski');
        }).catch(function() {});
      }

      function __wkInitSignBridge() {
        if (__skiSignFrame) return;
        var frame = document.createElement('iframe');
        frame.src = 'https://sui.ski/sign';
        frame.style.cssText = __wkBridgeHiddenStyle;
        frame.id = 'ski-sign-bridge';
        frame.setAttribute('allow', 'clipboard-read; clipboard-write');
        document.body.appendChild(frame);
        __skiSignFrame = frame;
        __skiSignReady = new Promise(function(resolve) {
          var resolved = false;
          window.addEventListener('message', function handler(e) {
            if (e.origin === 'https://sui.ski' && e.data && e.data.type === 'ski:ready') {
              window.removeEventListener('message', handler);
              resolved = true;
              resolve(true);
            }
          });
          setTimeout(function() { if (!resolved) resolve(false); }, 10000);
        });
      }

	      function __wkFinishConnect(wallet, accounts) {
          __wkDetachWalletEvents();
          __wkSessionWalletName = '';
	        var account = accounts[0];
	        var address = __wkNormalizeAccountAddress(account);
	        if (!address && account && typeof account.address === 'string') {
	          address = account.address;
        }
        var existingSession = typeof getWalletSession === 'function' ? getWalletSession() : null;
        var hasSessionCookie = document.cookie.indexOf('session_id=') !== -1;
        var existingWalletName = existingSession && existingSession.walletName ? String(existingSession.walletName) : '';
        var currentWalletName = wallet && wallet.name ? String(wallet.name) : '';
	        if (
            existingSession
            && existingSession.address === address
            && existingWalletName === currentWalletName
            && hasSessionCookie
          ) {
	          __sessionReady = Promise.resolve(true);
	        } else if (typeof connectWalletSession === 'function') {
	          var sessionResult = connectWalletSession(wallet.name, address);
	          __sessionReady = (sessionResult && typeof sessionResult.then === 'function')
	            ? sessionResult
	            : Promise.resolve(true);
	        } else {
	          __sessionReady = Promise.resolve(true);
	        }
        $connection.set({
          wallet: wallet,
          account: account,
          address: address,
          status: 'connected',
          primaryName: null
        });
        if (__wkIsSubdomain()) {
          try { __wkInitSignBridge(); } catch (_e) {}
        }
        __wkAttachWalletEvents(wallet);
      }

      var __wkSessionWalletName = '';

      function initFromSession(address, walletName) {
        if (!address) return;
        __wkDetachWalletEvents();
        __wkSessionWalletName = walletName || '';
        $connection.set({
          wallet: null,
          account: null,
          address: address,
          status: 'session',
          primaryName: null
        });
      }

	      function disconnect() {
	        var conn = $connection.value;
	        __wkSessionWalletName = '';
	        __wkPendingWaaPMethod = '';
	        __wkClearRequiredWaaPMethod();
	        __wkDetachWalletEvents();
        if (__wkIsSubdomain() && __skiSignFrame && __skiSignFrame.contentWindow) {
          try {
            __skiSignFrame.contentWindow.postMessage({ type: 'ski:disconnect' }, 'https://sui.ski');
          } catch (_e) {}
        }
        if (conn.wallet) {
          var disconnectFeature = conn.wallet.features && conn.wallet.features['standard:disconnect'];
          if (disconnectFeature && disconnectFeature.disconnect) {
            try { disconnectFeature.disconnect(); } catch (e) {}
          }
        }
        $connection.set({
          wallet: null, account: null, address: null,
          status: 'disconnected', primaryName: null
        });
        if (typeof disconnectWalletSession === 'function') {
          disconnectWalletSession();
        }
      }

      function connectPasskey() {
        if (!__wkHasPasskeySupport()) return Promise.reject(new Error('Passkeys not supported'));
        return connect(__wkCreatePasskeyWallet());
      }

      function __wkPickReconnectAccount(accounts, expectedAddress) {
        if (!Array.isArray(accounts) || accounts.length === 0) return null;
        var normalizedExpected = __wkNormalizeAccountAddress({ address: expectedAddress || '' });
        if (!normalizedExpected) return accounts[0];
        for (var i = 0; i < accounts.length; i++) {
          if (__wkNormalizeAccountAddress(accounts[i]) === normalizedExpected) {
            return accounts[i];
          }
        }
        return null;
      }

      function __wkTrySilentReconnect(wallet, expectedAddress) {
        if (!wallet) return false;
        try {
          var existing = __wkFilterSuiAccounts(
            __wkSafeGetAccounts(wallet).concat(__wkSafeGetAccounts(wallet && wallet._raw))
          );
          var selected = __wkPickReconnectAccount(existing, expectedAddress);
          if (selected) {
            __wkFinishConnect(wallet, [selected]);
            return true;
          }
        } catch (e) {}

        try {
          var phantomProvider = (window.phantom && window.phantom.sui) || window.sui;
          var isPhantom = phantomProvider && (
            __wkWalletNamesMatch(wallet.name, 'Phantom')
            || wallet._raw === phantomProvider
            || (wallet._raw && wallet._raw.isPhantom)
          );
          if (!isPhantom) return false;
          var phantomAccounts = __wkFilterSuiAccounts(
            __wkSafeGetAccounts(phantomProvider).concat(__wkSafeGetAccounts(wallet))
          );
          var selectedPhantom = __wkPickReconnectAccount(phantomAccounts, expectedAddress);
          if (selectedPhantom) {
            __wkFinishConnect(wallet, [selectedPhantom]);
            return true;
          }
          var phantomAddress = __wkExtractPhantomAddress(phantomProvider);
          if (phantomAddress) {
            var fallbackAccount = __wkBuildPhantomAccount(phantomAddress);
            if (fallbackAccount) {
              __wkFinishConnect(wallet, [fallbackAccount]);
              return true;
            }
          }
        } catch (e2) {}

        return false;
      }

	      function autoReconnect() {
	        if (!__wkAutoConnect) return Promise.resolve(false);
	        return new Promise(function(resolve) {
	          (async function() {
	            try {
	              var session = typeof getWalletSession === 'function' ? getWalletSession() : null;
	              if (!session || (!session.walletName && !session.address)) { resolve(false); return; }

	              if (__wkIsSubdomain() && session.address) {
	                initFromSession(session.address, session.walletName);
	                __wkInitSignBridge();
	                resolve(true);
	                return;
	              }

	              await new Promise(function(r) { setTimeout(r, 120); });

	              var wallets = getSuiWallets();
	              var keyWallets = wallets.filter(function(w) { return !w.__isPasskey; });
	              var match = null;
	              if (session.walletName && !__wkWalletNamesMatch(session.walletName, __wkPasskeyWalletName)) {
	                for (var i = 0; i < keyWallets.length; i++) {
	                  if (__wkWalletNamesMatch(keyWallets[i].name, session.walletName)) { match = keyWallets[i]; break; }
	                }
	              }
	              if (!match && !session.address && keyWallets.length > 0) {
	                match = keyWallets[0];
	              }

		              if (!match) {
		                if (__wkIsInAppBrowser()) {
		                  for (var attempt = 0; attempt < 5; attempt++) {
	                    await new Promise(function(r) { setTimeout(r, 300); });
	                    wallets = getSuiWallets();
	                    keyWallets = wallets.filter(function(w) { return !w.__isPasskey; });
	                    if (session.walletName && !__wkWalletNamesMatch(session.walletName, __wkPasskeyWalletName)) {
	                      for (var j = 0; j < keyWallets.length; j++) {
	                        if (__wkWalletNamesMatch(keyWallets[j].name, session.walletName)) { match = keyWallets[j]; break; }
	                      }
	                    }
		                    if (!match && !session.address && keyWallets.length > 0) {
		                      match = keyWallets[0];
		                    }
		                    if (match) break;
		                  }
		                }
		              }

		              if (!match && session.address && keyWallets.length > 0) {
		                for (var k = 0; k < keyWallets.length; k++) {
		                  if (__wkTrySilentReconnect(keyWallets[k], session.address)) {
		                    resolve(true);
		                    return;
		                  }
		                }
		              }

		              if (match && __wkTrySilentReconnect(match, session.address)) {
		                resolve(true);
		                return;
	              }

	              if (match && !match.__isPasskey && session.walletName) {
	                try {
	                  await connect(match);
	                  var connAfterReconnect = $connection.value;
	                  if (connAfterReconnect && connAfterReconnect.wallet) {
	                    resolve(true);
	                    return;
	                  }
	                } catch (_reconnectErr) {}
	              }

	              if (session.address) {
	                initFromSession(session.address, session.walletName);
	                resolve(true);
	                return;
	              }
	              resolve(false);
	            } catch (e) {
	              resolve(false);
	            }
	          })();
        });
      }

      function setPrimaryName(name) {
        var current = $connection.value;
        if (current.status !== 'connected' && current.status !== 'session') return;
        var nextName = typeof name === 'string' ? name.trim() : '';
        var currentName = typeof current.primaryName === 'string' ? current.primaryName.trim() : '';
        if (nextName === currentName) return;
        $connection.set({
          wallet: current.wallet,
          account: current.account,
          address: current.address,
          status: current.status,
          primaryName: nextName
        });
      }

      function signPersonalMessage(message) {
        var conn = $connection.value;
        if (!conn || !conn.wallet) return Promise.reject(new Error('No wallet connected'));
        return __wkSignPersonalMessage(conn.wallet, conn.account, message);
      }

      function switchChain(chain) {
        var conn = $connection.value;
        if (!conn || !conn.wallet) return Promise.reject(new Error('No wallet connected'));
        var chainName = String(chain || '').trim();
        if (!chainName) return Promise.reject(new Error('Missing chain identifier'));
        var feature = conn.wallet.features && conn.wallet.features['sui:switchChain'];
        if (feature && typeof feature.switchChain === 'function') {
          return feature.switchChain({ chain: chainName });
        }
        var raw = conn.wallet._raw;
        if (raw && raw.features && raw.features['sui:switchChain'] && typeof raw.features['sui:switchChain'].switchChain === 'function') {
          return raw.features['sui:switchChain'].switchChain({ chain: chainName });
        }
        return Promise.reject(new Error('Wallet does not support chain switching'));
      }

      function requestEmail() {
        var conn = $connection.value;
        if (!conn || !conn.wallet) return Promise.reject(new Error('No wallet connected'));
        if (typeof conn.wallet.requestEmail === 'function') {
          return conn.wallet.requestEmail();
        }
        var raw = conn.wallet._raw;
        if (raw && typeof raw.requestEmail === 'function') {
          return raw.requestEmail();
        }
        return Promise.reject(new Error('Current wallet does not support requestEmail'));
      }

      function initWaaP() {
        if (!__wkCanUseWaaPOnThisOrigin()) return Promise.resolve(null);
        return Promise.resolve(__wkInitWaaP()).then(function(wallet) {
          return wallet || null;
        });
      }

      return {
        __config: { network: __wkNetwork },
        $wallets: $wallets,
        $connection: $connection,
        subscribe: subscribe,
        getSuiWallets: getSuiWallets,
        detectWallets: detectWallets,
        initWaaP: initWaaP,
        connect: connect,
        connectPasskey: connectPasskey,
        disconnect: disconnect,
        autoReconnect: autoReconnect,
        setPrimaryName: setPrimaryName,
        signPersonalMessage: signPersonalMessage,
        switchChain: switchChain,
        requestEmail: requestEmail,
        initFromSession: initFromSession,
        get __sessionWalletName() { return __wkSessionWalletName; },
        get __sessionReady() { return __sessionReady; },
        get __skiSignFrame() { return __skiSignFrame; },
        get __skiSignReady() { return __skiSignReady; },
        __initSignBridge: __wkInitSignBridge,
        __isMobileDevice: __wkIsMobileDevice,
        __isInAppBrowser: __wkIsInAppBrowser,
        __filterSuiAccounts: __wkFilterSuiAccounts,
        __normalizeAccountAddress: __wkNormalizeAccountAddress
      };
    })();

    if (typeof window !== 'undefined') {
      window.SuiWalletKit = SuiWalletKit;
    }
  


    var __wkChain = 'sui:' + SuiWalletKit.__config.network;

    function __wkBytesToBase64(bytes) {
      if (typeof bytes === 'string') return bytes;
      if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
      if (Array.isArray(bytes)) bytes = Uint8Array.from(bytes);
      if (!bytes || typeof bytes.subarray !== 'function') {
        throw new Error('Expected byte array for base64 conversion');
      }
      var CHUNK = 8192;
      var parts = [];
      for (var i = 0; i < bytes.length; i += CHUNK) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length))));
      }
      return btoa(parts.join(''));
    }

    function __wkTryNormalizeBytes(value) {
      if (!value) return null;
      if (value instanceof Uint8Array) return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (Array.isArray(value)) return Uint8Array.from(value);
      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength || 0);
      }
      return null;
    }

    function __wkGetPhantomProvider() {
      var provider = window.phantom && window.phantom.sui;
      return provider && provider.isPhantom ? provider : null;
    }

    function __wkGetWallet() {
      var conn = SuiWalletKit.$connection.value;
      if (!conn || !conn.wallet) throw new Error('No wallet connected. Call SuiWalletKit.connect() first.');
      return conn;
    }

    function __wkNormalizeAccountAddress(account) {
      if (!account) return '';
      function __wkNormalizeRawAddress(rawAddress) {
        if (!rawAddress) return '';
        var clean = String(rawAddress).trim().toLowerCase();
        if (!clean) return '';
        if (clean.indexOf('0x') === 0) {
          clean = clean.slice(2);
        }
        if (!clean || clean.length > 64 || /[^0-9a-f]/.test(clean)) return '';
        clean = clean.replace(/^0+/, '');
        if (!clean) return '';
        return '0x' + clean.padStart(64, '0');
      }

      var normalizedFromAddress = '';
      if (typeof account === 'string') {
        normalizedFromAddress = __wkNormalizeRawAddress(account);
        if (normalizedFromAddress) return normalizedFromAddress;
      } else if (typeof account === 'object') {
        if (typeof account.address === 'string') {
          normalizedFromAddress = __wkNormalizeRawAddress(account.address);
        }
        if (!normalizedFromAddress && account.address && typeof account.address.toString === 'function') {
          normalizedFromAddress = __wkNormalizeRawAddress(account.address.toString());
        }
        if (normalizedFromAddress) return normalizedFromAddress;
        if (account.publicKey && typeof account.publicKey.toSuiAddress === 'function') {
          try {
            var fromKey = __wkNormalizeRawAddress(account.publicKey.toSuiAddress() || '');
            if (fromKey) return fromKey;
          } catch (_e) {}
        }
      }
      return '';
    }

    function __wkResolveConnectionAddress(conn, preferredAccount) {
      var preferred = __wkNormalizeAccountAddress(preferredAccount);
      if (preferred) return preferred;

      var fromConnAccount = __wkNormalizeAccountAddress(conn && conn.account);
      if (fromConnAccount) return fromConnAccount;
      var fromConnAddress = __wkNormalizeAccountAddress(conn && conn.address);
      if (fromConnAddress) return fromConnAddress;
      return '';
    }

    function __wkResolveWalletAccount(conn, preferredAccount) {
      var wallet = conn && conn.wallet;
      var resolved = preferredAccount || conn.account || null;
      var walletAccounts = [];
      var seenWalletAccounts = {};

      function __wkPushWalletAccount(account) {
        if (!account || typeof account !== 'object') return;
        var normalized = __wkNormalizeAccountAddress(account);
        if (!normalized || seenWalletAccounts[normalized]) return;
        seenWalletAccounts[normalized] = true;
        walletAccounts.push(account);
      }

      function __wkCollectWalletAccounts(source) {
        if (!source || (typeof source !== 'object' && typeof source !== 'function')) return;
        var accounts = null;
        try { accounts = source.accounts; } catch (_e) {}
        if (typeof accounts === 'function') {
          try { accounts = accounts.call(source); } catch (_e2) { accounts = null; }
        }
        if (Array.isArray(accounts)) {
          for (var i = 0; i < accounts.length; i++) __wkPushWalletAccount(accounts[i]);
        }
        var singleAccount = null;
        try { singleAccount = source.account; } catch (_e3) {}
        __wkPushWalletAccount(singleAccount);
      }

      __wkCollectWalletAccounts(wallet);
      __wkCollectWalletAccounts(wallet && wallet._raw);
      __wkCollectWalletAccounts(wallet && wallet.sui);

      var targetAddress = __wkNormalizeAccountAddress(resolved);
      if (!targetAddress) return null;
      if (!walletAccounts.length) return resolved;
      for (var i = 0; i < walletAccounts.length; i++) {
        if (__wkNormalizeAccountAddress(walletAccounts[i]) === targetAddress) {
          return walletAccounts[i];
        }
      }
      return null;
    }

    function __wkEnsureAccountForSign(conn, account, chain) {
      if (account && typeof account === 'object') {
        return account;
      }

      var fallbackAddress = __wkNormalizeAccountAddress(account);
      if (!fallbackAddress) fallbackAddress = __wkResolveConnectionAddress(conn);
      if (!fallbackAddress) return null;
      return {
        address: fallbackAddress,
        chains: [chain || __wkChain],
      };
    }

    function __wkResolveSigningChain(account, preferredChain) {
      if (preferredChain && typeof preferredChain === 'string') return preferredChain;
      if (account && Array.isArray(account.chains)) {
        for (var i = 0; i < account.chains.length; i++) {
          if (typeof account.chains[i] === 'string' && account.chains[i].indexOf('sui:') === 0) {
            return account.chains[i];
          }
        }
      }
      return __wkChain;
    }

    function __wkNetworkCandidates(chain) {
      var normalized = typeof chain === 'string' ? chain : __wkChain;
      if (normalized === 'sui:mainnet' || normalized === 'mainnet') return ['sui:mainnet', 'mainnet'];
      if (normalized === 'sui:testnet' || normalized === 'testnet') return ['sui:testnet', 'testnet'];
      if (normalized === 'sui:devnet' || normalized === 'devnet') return ['sui:devnet', 'devnet'];
      return [normalized, __wkChain];
    }

    function __wkGetRpcUrl() {
      var network = SuiWalletKit.__config && SuiWalletKit.__config.network
        ? String(SuiWalletKit.__config.network)
        : 'mainnet';
      if (network === 'testnet') return 'https://fullnode.testnet.sui.io:443';
      if (network === 'devnet') return 'https://fullnode.devnet.sui.io:443';
      return 'https://fullnode.mainnet.sui.io:443';
    }

    async function __wkExecuteSignedTransaction(signed, txInput, txOptions) {
      var signature = signed && (signed.signature || signed.signatures);
      var txBytes = signed && (
        signed.bytes ||
        signed.transactionBytes ||
        signed.transactionBlock ||
        signed.signedTransaction ||
        signed.transaction
      );

      if (!txBytes) txBytes = txInput;
      if (!signature) throw new Error('Missing signature from wallet');
      if (!txBytes) throw new Error('Missing signed transaction bytes from wallet');

      var txB64 = __wkBytesToBase64(txBytes);
      var signatures = Array.isArray(signature) ? signature : [signature];
      var rpcRes = await fetch(__wkGetRpcUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sui_executeTransactionBlock',
          params: [txB64, signatures, txOptions || {}],
        }),
      });
      var rpcJson = await rpcRes.json().catch(function() { return null; });
      if (!rpcRes.ok || !rpcJson || rpcJson.error || !rpcJson.result) {
        throw new Error(
          (rpcJson && rpcJson.error && rpcJson.error.message)
          || 'Failed to execute signed transaction',
        );
      }
      return rpcJson.result;
    }

    function __skiResolvePreferredWalletName() {
      var conn = SuiWalletKit.$connection.value || {};
      if (conn.wallet && conn.wallet.name) return String(conn.wallet.name);
      if (SuiWalletKit.__sessionWalletName) return String(SuiWalletKit.__sessionWalletName);
      try {
        var session = typeof getWalletSession === 'function' ? getWalletSession() : null;
        if (session && session.walletName) return String(session.walletName);
      } catch (_e) {}
      try {
        var remembered = String(localStorage.getItem('sui_ski_last_wallet') || '').trim();
        if (remembered) return remembered;
      } catch (_e2) {}
      return '';
    }



    async function __skiSerializeForWallet(txInput) {
      if (typeof txInput === 'string') return txInput;
      if (txInput instanceof Uint8Array) return txInput;
      if (txInput && typeof txInput.serialize === 'function') {
        return txInput;
      }
      return txInput;
    }

    function __skiIsSubdomainHost() {
      var host = window.location.hostname || '';
      return host !== 'sui.ski' && host.endsWith('.sui.ski');
    }

    function __skiIsSlushWalletName(name) {
      var key = __skiWalletNameKey(name);
      return (
        key === 'slush'
        || key === 'slushwallet'
        || key === 'sui'
        || key === 'suiwallet'
        || key === 'mystenwallet'
      );
    }

    function __skiLooksLikeSlushProvider(provider) {
      if (!provider || typeof provider !== 'object') return false;
      if (provider.isSlush || provider.__isSlush) return true;
      var providerName = '';
      try {
        if (typeof provider.name === 'string') {
          providerName = provider.name;
        } else if (provider.wallet && typeof provider.wallet.name === 'string') {
          providerName = provider.wallet.name;
        }
      } catch (_e) {}
      return __skiIsSlushWalletName(providerName);
    }

    function __skiCanDirectSlush() {
      try {
        if (window.slush && (window.slush.sui || window.slush.wallet || window.slush)) return true;
      } catch (_e) {}
      try {
        var sui = window.sui;
        if (!sui || sui.isPhantom) return false;
        return __skiLooksLikeSlushProvider(sui);
      } catch (_e2) {}
      return false;
    }

    function __skiShouldBypassBridgeForSlush(options) {
      if (__skiIsSubdomainHost()) return false;
      var preferredWalletName = '';
      if (options && options.walletName) {
        preferredWalletName = String(options.walletName);
      }
      if (!preferredWalletName && options && options.preferredWalletName) {
        preferredWalletName = String(options.preferredWalletName);
      }
      if (!preferredWalletName) {
        try {
          var conn = SuiWalletKit.$connection.value || {};
          preferredWalletName = conn && conn.wallet && conn.wallet.name ? String(conn.wallet.name) : '';
        } catch (_eConn) {}
      }
      if (!preferredWalletName) {
        preferredWalletName = __skiResolvePreferredWalletName();
      }
      if (!preferredWalletName) {
        try {
          preferredWalletName = String(localStorage.getItem('sui_ski_last_wallet') || '');
        } catch (_eLs) {}
      }
      if (!__skiIsSlushWalletName(preferredWalletName)) return false;
      return __skiCanDirectSlush();
    }

    function __skiWalletNameKey(name) {
      var normalized = String(name || '').trim().toLowerCase();
      if (!normalized) return '';
      normalized = normalized.replace(/[^a-z0-9]+/g, ' ').trim();
      if (!normalized) return '';
      if (normalized.slice(-7) === ' wallet') {
        normalized = normalized.slice(0, -7).trim();
      }
      return normalized.replace(/\s+/g, '');
    }

    function __skiWalletNamesMatch(left, right) {
      var leftRaw = String(left || '').trim().toLowerCase();
      var rightRaw = String(right || '').trim().toLowerCase();
      if (!leftRaw || !rightRaw) return false;
      if (leftRaw === rightRaw) return true;
      var leftKey = __skiWalletNameKey(leftRaw);
      var rightKey = __skiWalletNameKey(rightRaw);
      if (!leftKey || !rightKey) return false;
      if (leftKey === rightKey) return true;
      return leftKey.indexOf(rightKey) !== -1 || rightKey.indexOf(leftKey) !== -1;
    }

	    async function __skiEnsureConnectedWalletForSigning(preferredWalletName) {
	      var conn = SuiWalletKit.$connection.value || {};
	      if (conn.wallet) {
	        if (!preferredWalletName || __skiWalletNamesMatch(conn.wallet.name, preferredWalletName)) {
	          return conn;
	        }
	      }

	      var sessionWalletName = '';
	      try {
	        var session = typeof getWalletSession === 'function' ? getWalletSession() : null;
	        sessionWalletName = session && session.walletName ? String(session.walletName) : '';
	      } catch (_e) {}

	      if (window.__wkWaaPLoading) {
	        try { await window.__wkWaaPLoading; } catch (_e) {}
	      }

	      var wallets = [];
	      try {
	        wallets = await SuiWalletKit.detectWallets();
	      } catch (_e) {
	        wallets = SuiWalletKit.$wallets.value || [];
	      }
	      if (!wallets || wallets.length === 0) return null;

	      var match = null;
	      var keyWallets = wallets.filter(function(w) { return !w.__isPasskey; });

	      if (preferredWalletName) {
	        for (var p = 0; p < keyWallets.length; p++) {
	          if (keyWallets[p] && __skiWalletNamesMatch(keyWallets[p].name, preferredWalletName)) {
	            match = keyWallets[p];
	            break;
	          }
	        }
	      }

	      if (!match && sessionWalletName && !__skiWalletNamesMatch(sessionWalletName, 'Passkey Wallet')) {
	        for (var i = 0; i < keyWallets.length; i++) {
	          if (keyWallets[i] && __skiWalletNamesMatch(keyWallets[i].name, sessionWalletName)) {
	            match = keyWallets[i];
	            break;
	          }
	        }
	      }

	      if (!match && __skiWalletNamesMatch(sessionWalletName, 'Passkey Wallet') && typeof SuiWalletKit.connectPasskey === 'function') {
	        try {
	          await SuiWalletKit.connectPasskey();
	          conn = SuiWalletKit.$connection.value || {};
	          if (conn.wallet) return conn;
	        } catch (_e) {}
	      }

	      if (!match && !sessionWalletName && keyWallets.length > 0) {
	        match = keyWallets[0];
	      }

	      if (!match) return null;

	      try {
	        await SuiWalletKit.connect(match);
	      } catch (_e) {
	        return null;
	      }

	      conn = SuiWalletKit.$connection.value || {};
	      return conn.wallet ? conn : null;
	    }

    var __wkRejectionPatterns = /reject|denied|cancel|decline|dismissed|disapproved|user refused/i;
    function __wkIsUserRejection(err) {
      if (!err) return false;
      var msg = (err.message || (typeof err === 'string' ? err : ''));
      return __wkRejectionPatterns.test(msg);
    }


    function __skiRequiresTopFrameSigning(err) {
      if (!err) return false;
      var msg = String(err && err.message ? err.message : err).toLowerCase();
      if (!msg) return false;
      return (
        msg.indexOf('wallet requires top-frame signing') !== -1
        || msg.indexOf('open https://sui.ski/sign in this tab and retry') !== -1
        || msg.indexOf('failed to open new window') !== -1
        || (msg.indexOf('popup') !== -1 && msg.indexOf('blocked') !== -1)
        || (msg.indexOf('new window') !== -1 && msg.indexOf('failed') !== -1)
      );
    }

	    function __skiCanUseSessionSignBridge(conn) {
	      return !!(conn && !conn.wallet && conn.address && conn.status === 'session' && __skiIsSubdomainHost());
	    }

	    function __skiResolveRequestedWalletName(options) {
	      var walletName = '';
	      if (options && options.walletName) walletName = String(options.walletName).trim();
	      if (!walletName && options && options.preferredWalletName) walletName = String(options.preferredWalletName).trim();
	      if (!walletName) walletName = __skiResolvePreferredWalletName();
	      return walletName;
	    }

	    function __skiShouldTopFrameHandoffFromBridgeError(err) {
	      if (!err) return false;
	      if (__skiRequiresTopFrameSigning(err)) return true;
	      var msg = String(err && err.message ? err.message : err).toLowerCase();
	      if (!msg) return false;
	      return (
	        msg.indexOf('does not expose sui signing in this context') !== -1
	        || msg.indexOf('wallet session unavailable in bridge') !== -1
	        || msg.indexOf('wallet not connected in sign bridge') !== -1
	        || msg.indexOf('selected wallet not available') !== -1
	      );
	    }

	    function __skiStartTopFrameSignHandoff(walletName, sender) {
	      if (!__skiIsSubdomainHost()) return false;
	      try {
	        if (window.__skiTopFrameHandoffInFlight) return true;
	        try {
	          var sp = new URLSearchParams(window.location.search);
	          if (sp.get('ski_handoff') === '1') return false;
	        } catch (_ep) {}
	        var currentUrl = new URL(window.location.href);
	        currentUrl.searchParams.delete('ski_handoff');
	        currentUrl.searchParams.delete('ski_handoff_status');
	        currentUrl.searchParams.delete('ski_handoff_error');
	        var handoffUrl = new URL('https://sui.ski/sign');
	        handoffUrl.searchParams.set('bridge', 'handoff');
	        handoffUrl.searchParams.set('returnUrl', currentUrl.toString());
	        if (walletName) handoffUrl.searchParams.set('walletName', String(walletName).slice(0, 120));
	        if (sender) handoffUrl.searchParams.set('sender', String(sender).slice(0, 120));
	        window.__skiTopFrameHandoffInFlight = true;
	        window.location.assign(handoffUrl.toString());
	        return true;
	      } catch (_e) {
	        return false;
	      }
	    }

	    function __skiCollectBridgeWalletHints(preferredWalletName) {
	      var out = [];
	      var seen = {};
      function pushHint(name, icon, isPasskey) {
        var normalizedName = String(name || '').trim();
        if (!normalizedName) return;
        var key = __skiWalletNameKey(normalizedName) || normalizedName.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        out.push({
          name: normalizedName,
          icon: String(icon || ''),
          __isPasskey: !!isPasskey,
        });
      }
      if (preferredWalletName) {
        pushHint(preferredWalletName, '', false);
      }
      var wallets = [];
      try {
        wallets = SuiWalletKit.$wallets && Array.isArray(SuiWalletKit.$wallets.value)
          ? SuiWalletKit.$wallets.value
          : [];
      } catch (_e) {
        wallets = [];
      }
      for (var i = 0; i < wallets.length; i++) {
        var wallet = wallets[i] || {};
        pushHint(wallet.name, wallet.icon, wallet.__isPasskey);
      }
      return out;
    }

    async function __skiEnsureBridgeFrame() {
      var bridge = SuiWalletKit.__skiSignFrame;
      var bridgeReady = SuiWalletKit.__skiSignReady;
      if (!bridge && typeof SuiWalletKit.__initSignBridge === 'function') {
        SuiWalletKit.__initSignBridge();
        bridge = SuiWalletKit.__skiSignFrame;
        bridgeReady = SuiWalletKit.__skiSignReady;
      }
      if (bridgeReady) {
        var ready = await bridgeReady;
        if (!ready) return null;
      }
      if (!bridge || !bridge.contentWindow) return null;
      return bridge;
    }

    async function __skiWalletSignAndExecute(txInput, conn, options) {
      var txRaw = await __skiSerializeForWallet(txInput);
      var txBytes = txRaw;
      if (txRaw && typeof txRaw.serialize === 'function') {
        try {
          txBytes = await txRaw.serialize();
        } catch (_e) {
          if (txRaw && typeof txRaw.build === 'function') {
            try {
              var RpcClient = window.SuiJsonRpcClient || window.SuiClient;
              if (RpcClient) {
                var rpcClient = new RpcClient({ url: __wkGetRpcUrl() });
                txBytes = await txRaw.build({ client: rpcClient });
              }
            } catch (_e2) {}
          }
        }
      }
      var wallet = conn.wallet;
      var requestedChain = options && options.chain;
      var account = __wkEnsureAccountForSign(
        conn,
        __wkResolveWalletAccount(conn, options && options.account),
        requestedChain || __wkChain,
      );
      if (!account) {
        throw new Error('No wallet account available for signing. Reconnect wallet and retry.');
      }
      var chain = __wkResolveSigningChain(account, requestedChain);
      var txOptions = options && options.txOptions;
      var singleAttempt = !!(options && options.singleAttempt);
      var preferTransactionBlock = !!(options && options.preferTransactionBlock);
      var topFrameSigningError = null;
      var txB64 = txBytes;
      if (
        txBytes instanceof Uint8Array ||
        txBytes instanceof ArrayBuffer ||
        Array.isArray(txBytes)
      ) {
        txB64 = __wkBytesToBase64(txBytes);
      }

      async function __wkTryCalls(calls) {
        if (singleAttempt) {
          if (!Array.isArray(calls) || calls.length === 0) throw new Error('No compatible signing method found.');
          return await calls[0]();
        }
        var lastErr = null;
        for (var i = 0; i < calls.length; i++) {
          try {
            return await calls[i]();
          } catch (err) {
            lastErr = err;
            if (!topFrameSigningError && __skiRequiresTopFrameSigning(err)) {
              topFrameSigningError = err;
            }
            if (__wkIsUserRejection(err)) throw err;
          }
        }
        if (lastErr) throw lastErr;
        throw new Error('No compatible signing method found.');
      }

      var phantom = __wkGetPhantomProvider();
      var walletName = String((wallet && wallet.name) || '').toLowerCase();
      var isPhantomWallet = !!(
        (walletName && walletName.indexOf('phantom') !== -1)
        || (wallet && wallet.isPhantom)
        || (wallet && wallet._raw && wallet._raw.isPhantom)
        || (
          phantom && (
            wallet === phantom
            || (wallet && wallet._raw === phantom)
          )
        )
      );
      if (singleAttempt && phantom && isPhantomWallet) {
        var singleSenderAddress = __wkResolveConnectionAddress(conn, account);
        var singleNetworkCandidates = __wkNetworkCandidates(chain);
        if (preferTransactionBlock && typeof phantom.signAndExecuteTransactionBlock === 'function') {
          return await phantom.signAndExecuteTransactionBlock({
            transactionBlock: txB64,
            options: txOptions,
          });
        }
        if (typeof phantom.signAndExecuteTransaction === 'function') {
          return await phantom.signAndExecuteTransaction({
            transaction: txB64,
            address: singleSenderAddress,
            networkID: singleNetworkCandidates[0],
            options: txOptions,
          });
        }
      }

      var signExecFeature = wallet.features && wallet.features['sui:signAndExecuteTransaction'];
      var signExecBlockFeature = wallet.features && wallet.features['sui:signAndExecuteTransactionBlock'];

      async function __wkTrySignAndExecuteTransaction() {
        if (!signExecFeature || !signExecFeature.signAndExecuteTransaction) return null;
        try {
          return await __wkTryCalls([
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txRaw,
                account: account,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txBytes,
                account: account,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txB64,
                account: account,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txBytes,
                account: account,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txB64,
                account: account,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txRaw,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txBytes,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txB64,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txBytes,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txB64,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txRaw,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txBytes,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txB64,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txBytes,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txB64,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txRaw,
                chain: chain,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txBytes,
                chain: chain,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txB64,
                chain: chain,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txBytes,
                chain: chain,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txB64,
                chain: chain,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txRaw,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txBytes,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txB64,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txBytes,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txB64,
                options: txOptions,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txRaw,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txBytes,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transaction: txB64,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txBytes,
              });
            },
            function() {
              return signExecFeature.signAndExecuteTransaction({
                transactionBlock: txB64,
              });
            },
          ]);
        } catch (err) {
          if (singleAttempt) throw err;
          console.warn('signAndExecuteTransaction failed:', err.message);
        }
        return null;
      }

      async function __wkTrySignAndExecuteTransactionBlock() {
        if (!signExecBlockFeature || !signExecBlockFeature.signAndExecuteTransactionBlock) return null;
        try {
          return await __wkTryCalls([
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txRaw,
                account: account,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txBytes,
                account: account,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txB64,
                account: account,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transaction: txBytes,
                account: account,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transaction: txB64,
                account: account,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txRaw,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txBytes,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txB64,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txRaw,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txBytes,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txB64,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transaction: txBytes,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transaction: txB64,
                chain: chain,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txRaw,
                chain: chain,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txBytes,
                chain: chain,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txB64,
                chain: chain,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transaction: txBytes,
                chain: chain,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transaction: txB64,
                chain: chain,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txRaw,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txBytes,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txB64,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transaction: txBytes,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transaction: txB64,
                options: txOptions,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txRaw,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txBytes,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transactionBlock: txB64,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transaction: txBytes,
              });
            },
            function() {
              return signExecBlockFeature.signAndExecuteTransactionBlock({
                transaction: txB64,
              });
            },
          ]);
        } catch (err) {
          if (singleAttempt) throw err;
          console.warn('signAndExecuteTransactionBlock failed:', err.message);
        }
        return null;
      }

      if (preferTransactionBlock) {
        var byBlock = await __wkTrySignAndExecuteTransactionBlock();
        if (byBlock) return byBlock;
        var byTx = await __wkTrySignAndExecuteTransaction();
        if (byTx) return byTx;
      } else {
        var byTxDefault = await __wkTrySignAndExecuteTransaction();
        if (byTxDefault) return byTxDefault;
        var byBlockDefault = await __wkTrySignAndExecuteTransactionBlock();
        if (byBlockDefault) return byBlockDefault;
      }

      if (phantom && isPhantomWallet) {
        try {
          var networkCandidates = __wkNetworkCandidates(chain);
          var senderAddress = __wkResolveConnectionAddress(conn, account);
          return await __wkTryCalls([
            function() {
              if (typeof phantom.signAndExecuteTransactionBlock !== 'function') throw new Error('Unavailable');
              return phantom.signAndExecuteTransactionBlock({
                transactionBlock: txB64,
                options: txOptions,
              });
            },
            function() {
              if (typeof phantom.signAndExecuteTransaction !== 'function') throw new Error('Unavailable');
              return phantom.signAndExecuteTransaction({
                transaction: txB64,
                address: senderAddress,
                networkID: networkCandidates[0],
                options: txOptions,
              });
            },
            function() {
              if (typeof phantom.signAndExecuteTransaction !== 'function') throw new Error('Unavailable');
              return phantom.signAndExecuteTransaction({
                transaction: txB64,
                address: senderAddress,
                networkID: networkCandidates.length > 1 ? networkCandidates[1] : networkCandidates[0],
                options: txOptions,
              });
            },
            function() {
              if (typeof phantom.signAndExecuteTransaction !== 'function') throw new Error('Unavailable');
              return phantom.signAndExecuteTransaction({
                transaction: txB64,
                address: senderAddress,
              });
            },
            function() {
              if (typeof phantom.signAndExecuteTransaction !== 'function') throw new Error('Unavailable');
              return phantom.signAndExecuteTransaction({
                transaction: txB64,
                options: txOptions,
              });
            },
            function() {
              if (typeof phantom.signAndExecuteTransaction !== 'function') throw new Error('Unavailable');
              return phantom.signAndExecuteTransaction({
                transaction: txB64,
              });
            },
            function() {
              if (typeof phantom.signAndExecuteTransactionBlock !== 'function') throw new Error('Unavailable');
              return phantom.signAndExecuteTransactionBlock({
                transaction: txB64,
                options: txOptions,
              });
            },
            function() {
              if (typeof phantom.signAndExecuteTransactionBlock !== 'function') throw new Error('Unavailable');
              return phantom.signAndExecuteTransactionBlock({ transactionBlock: txB64 });
            },
            function() {
              if (typeof phantom.signAndExecuteTransactionBlock !== 'function') throw new Error('Unavailable');
              return phantom.signAndExecuteTransactionBlock({ transaction: txB64 });
            },
          ]);
        } catch (_e) {
          if (singleAttempt) throw _e;
          try {
            var signCalls = [];
            for (var ni = 0; ni < networkCandidates.length; ni++) {
              var networkID = networkCandidates[ni];
              signCalls.push(function(networkIDCopy) {
                return function() {
                  if (typeof phantom.signTransaction !== 'function') throw new Error('Unavailable');
                  return phantom.signTransaction({
                    transaction: txB64,
                    address: senderAddress,
                    networkID: networkIDCopy,
                  });
                };
              }(networkID));
            }
            signCalls.push(function() {
              if (typeof phantom.signTransaction !== 'function') throw new Error('Unavailable');
              return phantom.signTransaction({ transaction: txB64, address: senderAddress });
            });
            signCalls.push(function() {
              if (typeof phantom.signTransaction !== 'function') throw new Error('Unavailable');
              return phantom.signTransaction({ transaction: txB64 });
            });
            signCalls.push(function() {
              if (typeof phantom.signTransactionBlock !== 'function') throw new Error('Unavailable');
              return phantom.signTransactionBlock({ transactionBlock: txB64 });
            });
            signCalls.push(function() {
              if (typeof phantom.signTransactionBlock !== 'function') throw new Error('Unavailable');
              return phantom.signTransactionBlock({ transaction: txB64 });
            });

            var signedPhantom = await __wkTryCalls(signCalls);
            if (signedPhantom && signedPhantom.digest) return signedPhantom;
            return await __wkExecuteSignedTransaction(signedPhantom, txB64, txOptions);
          } catch (_e2) {
            if (singleAttempt) throw _e2;
            // Continue to other wallet fallbacks.
          }
        }
      }

      if (window.suiWallet && window.suiWallet.signAndExecuteTransactionBlock) {
        try {
          return await __wkTryCalls([
            function() {
              return window.suiWallet.signAndExecuteTransactionBlock({
                transactionBlock: txBytes,
                options: txOptions,
              });
            },
            function() {
              return window.suiWallet.signAndExecuteTransactionBlock({
                transaction: txBytes,
                options: txOptions,
              });
            },
            function() {
              return window.suiWallet.signAndExecuteTransactionBlock({
                transactionBlock: txB64,
                options: txOptions,
              });
            },
          ]);
        } catch (_e) {
          if (singleAttempt) throw _e;
        }
      }

      if (typeof SuiWalletKit.signTransaction === 'function') {
        try {
          var signed = await SuiWalletKit.signTransaction(txInput, {
            account: account,
            chain: chain,
          });
          if (signed && signed.digest) return signed;
          return await __wkExecuteSignedTransaction(signed, txB64, txOptions);
        } catch (_e) {
          if (singleAttempt) throw _e;
        }
      }

      if (topFrameSigningError) {
        throw new Error('Wallet requires reconnect in the bridge iframe. Reconnect wallet and retry.');
      }
      throw new Error('No compatible signing method found. Install a Sui wallet extension.');
    }

    async function __skiSignViaBridge(txInput, conn, options) {
      var bridgeHiddenCss = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;z-index:-1;background:transparent';
      var bridgeVisibleCss = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:13001;border:none;background:transparent;';
      var txRaw = await __skiSerializeForWallet(txInput);
      var txBytes = txRaw;
      if (txRaw && typeof txRaw.serialize === 'function') {
        try {
          txBytes = await txRaw.serialize();
        } catch (_e) {
          if (txRaw && typeof txRaw.build === 'function') {
            try {
              var RpcClient = window.SuiJsonRpcClient || window.SuiClient;
              if (RpcClient) {
                var rpcClient = new RpcClient({ url: __wkGetRpcUrl() });
                txBytes = await txRaw.build({ client: rpcClient });
              }
            } catch (_e2) {}
          }
        }
      }
      var txB64 = txBytes;
      if (txBytes instanceof Uint8Array || txBytes instanceof ArrayBuffer || Array.isArray(txBytes)) {
        txB64 = __wkBytesToBase64(txBytes);
      }
      var sender = __wkNormalizeAccountAddress(options && options.expectedSender);
      if (!sender) sender = __wkResolveConnectionAddress(conn, options && options.account);
      var walletName = '';
      if (options && options.walletName) walletName = String(options.walletName).trim();
      if (!walletName && options && options.preferredWalletName) walletName = String(options.preferredWalletName).trim();
      if (!walletName) walletName = __skiResolvePreferredWalletName();
      var walletHints = __skiCollectBridgeWalletHints(walletName);
      var requestId = 'sign-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      var bridge = await __skiEnsureBridgeFrame();
      if (!bridge) {
        throw new Error('Sign bridge not available. Reconnect wallet and retry.');
      }
      bridge.style.cssText = bridgeVisibleCss;
      return new Promise(function(resolve, reject) {
        var timeout = setTimeout(function() {
          cleanup();
          bridge.style.cssText = bridgeHiddenCss;
          reject(new Error('Transaction signing timed out'));
        }, 120000);
        function cleanup() {
          clearTimeout(timeout);
          window.removeEventListener('message', handleResponse);
        }
        function handleResponse(ev) {
          if (ev.origin !== 'https://sui.ski') return;
          if (!ev.data || ev.data.requestId !== requestId) return;
          if (ev.data.type === 'ski:signed') {
            cleanup();
            bridge.style.cssText = bridgeHiddenCss;
            resolve(ev.data);
          } else if (ev.data.type === 'ski:error') {
            cleanup();
            bridge.style.cssText = bridgeHiddenCss;
            reject(new Error(ev.data.error || 'Signing failed'));
          }
        }
        window.addEventListener('message', handleResponse);
        bridge.contentWindow.postMessage({
          type: 'ski:sign',
          txBytes: txB64,
          requestId: requestId,
          sender: sender,
          walletName: walletName,
          walletHints: walletHints,
          options: (options && options.txOptions) || {},
        }, 'https://sui.ski');
      });
    }

    function __skiMessageToBytes(message) {
      var normalized = __wkTryNormalizeBytes(message);
      if (normalized) return normalized;
      if (typeof message === 'string') {
        if (typeof TextEncoder !== 'undefined') {
          return new TextEncoder().encode(message);
        }
        var fallback = new Uint8Array(message.length);
        for (var i = 0; i < message.length; i++) {
          fallback[i] = message.charCodeAt(i) & 0xff;
        }
        return fallback;
      }
      return new Uint8Array(0);
    }

	    async function __skiSignPersonalMessageViaBridge(message, conn, options) {
      var bridgeHiddenCss = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;z-index:-1;background:transparent';
      var bridgeVisibleCss = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:13001;border:none;background:transparent;';
      var messageBytes = __skiMessageToBytes(message);
      if (!messageBytes || messageBytes.length === 0) {
        throw new Error('Message payload is empty');
      }
      var sender = __wkNormalizeAccountAddress(options && options.expectedSender);
      if (!sender) sender = __wkResolveConnectionAddress(conn, options && options.account);
      var walletName = '';
      if (options && options.walletName) walletName = String(options.walletName).trim();
      if (!walletName && options && options.preferredWalletName) walletName = String(options.preferredWalletName).trim();
      if (!walletName) walletName = __skiResolvePreferredWalletName();
      var walletHints = __skiCollectBridgeWalletHints(walletName);
      var requestId = 'sign-message-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      var bridge = await __skiEnsureBridgeFrame();
      if (!bridge) {
        throw new Error('Sign bridge not available. Reconnect wallet and retry.');
      }
      bridge.style.cssText = bridgeVisibleCss;
      return new Promise(function(resolve, reject) {
        var timeout = setTimeout(function() {
          cleanup();
          bridge.style.cssText = bridgeHiddenCss;
          reject(new Error('Message signing timed out'));
        }, 120000);
        function cleanup() {
          clearTimeout(timeout);
          window.removeEventListener('message', handleResponse);
        }
        function handleResponse(ev) {
          if (ev.origin !== 'https://sui.ski') return;
          if (!ev.data || ev.data.requestId !== requestId) return;
          if (ev.data.type === 'ski:signed-message') {
            cleanup();
            bridge.style.cssText = bridgeHiddenCss;
            resolve({
              signature: ev.data.signature || '',
              bytes: ev.data.bytes || __wkBytesToBase64(messageBytes),
            });
          } else if (ev.data.type === 'ski:error') {
            cleanup();
            bridge.style.cssText = bridgeHiddenCss;
            reject(new Error(ev.data.error || 'Message signing failed'));
          }
        }
        window.addEventListener('message', handleResponse);
        bridge.contentWindow.postMessage({
          type: 'ski:sign-message',
          message: __wkBytesToBase64(messageBytes),
          requestId: requestId,
          sender: sender,
          walletName: walletName,
          walletHints: walletHints,
        }, 'https://sui.ski');
      });
	    }

	    function __wkEmitTxSuccess(result) {
	      try {
	        var digest = '';
	        if (result && typeof result === 'object') {
	          digest = result.digest || (result.result && result.result.digest) || '';
	        }
	        window.dispatchEvent(new CustomEvent('wk:tx-success', {
	          detail: { digest: digest || '' },
	        }));
	      } catch (_e) {}
	    }

			    SuiWalletKit.signAndExecute = async function signAndExecute(txInput, options) {
			      var result;
			      var bypassBridgeForSlush = __skiShouldBypassBridgeForSlush(options);
		      if (bypassBridgeForSlush) {
		        var slushConn = await __skiEnsureConnectedWalletForSigning('Slush');
		        if (!slushConn || !slushConn.wallet) {
		          throw new Error('Slush extension not detected in this tab. Open Slush and retry.');
		        }
		        result = await __skiWalletSignAndExecute(txInput, slushConn, options);
		        __wkEmitTxSuccess(result);
		        return result;
		      }
			      var bridgeConn = SuiWalletKit.$connection.value || {};
			      if (__skiCanUseSessionSignBridge(bridgeConn)) {
			        var requestedWalletName = __skiResolveRequestedWalletName(options);
			        var localConn = await __skiEnsureConnectedWalletForSigning(requestedWalletName);
			        if (localConn && localConn.wallet) {
			          try {
			            result = await __skiWalletSignAndExecute(txInput, localConn, options);
			            __wkEmitTxSuccess(result);
			            return result;
			          } catch (_localSignErr) {
			            if (__wkIsUserRejection(_localSignErr)) throw _localSignErr;
			          }
			        }
			        try {
			          result = await __skiSignViaBridge(txInput, bridgeConn, options);
			          __wkEmitTxSuccess(result);
			          return result;
			        } catch (bridgeErr) {
			          if (__skiShouldTopFrameHandoffFromBridgeError(bridgeErr)) {
			            var handoffWalletName = requestedWalletName;
			            var handoffSender = __wkNormalizeAccountAddress(options && options.expectedSender);
			            if (!handoffSender) handoffSender = __wkResolveConnectionAddress(bridgeConn, options && options.account);
			            if (__skiStartTopFrameSignHandoff(handoffWalletName, handoffSender)) {
			              return new Promise(function() {});
			            }
			            throw new Error('Wallet signing unavailable. Please reconnect your wallet and retry.');
				          }
				          throw bridgeErr;
				        }
			      }
			      result = await __skiWalletSignAndExecute(txInput, __wkGetWallet(), options);
			      __wkEmitTxSuccess(result);
		      return result;
		    };

    SuiWalletKit.signAndExecuteFromBytes = SuiWalletKit.signAndExecute;

    var __wkNativeSignPersonalMessage = typeof SuiWalletKit.signPersonalMessage === 'function'
      ? SuiWalletKit.signPersonalMessage.bind(SuiWalletKit)
      : null;

    SuiWalletKit.signPersonalMessage = async function signPersonalMessage(message, options) {
      var bypassBridgeForSlush = __skiShouldBypassBridgeForSlush(options);
      if (bypassBridgeForSlush) {
        var slushMsgConn = await __skiEnsureConnectedWalletForSigning('Slush');
        if (!slushMsgConn || !slushMsgConn.wallet) {
          throw new Error('Slush extension not detected in this tab. Open Slush and retry.');
        }
      }

	      var bridgeMsgConn = SuiWalletKit.$connection.value || {};
	      if (__skiCanUseSessionSignBridge(bridgeMsgConn)) {
	        var requestedMsgWalletName = __skiResolveRequestedWalletName(options);
	        var localMsgConn = await __skiEnsureConnectedWalletForSigning(requestedMsgWalletName);
	        if (localMsgConn && localMsgConn.wallet && __wkNativeSignPersonalMessage) {
	          try {
	            return await __wkNativeSignPersonalMessage(message);
	          } catch (_localMsgSignErr) {}
	        }
	        try {
	          return await __skiSignPersonalMessageViaBridge(message, bridgeMsgConn, options);
	        } catch (bridgeMsgErr) {
	          if (__skiShouldTopFrameHandoffFromBridgeError(bridgeMsgErr)) {
	            var handoffMsgWalletName = requestedMsgWalletName;
	            var handoffMsgSender = __wkNormalizeAccountAddress(options && options.expectedSender);
	            if (!handoffMsgSender) handoffMsgSender = __wkResolveConnectionAddress(bridgeMsgConn, options && options.account);
	            if (__skiStartTopFrameSignHandoff(handoffMsgWalletName, handoffMsgSender)) {
	              return new Promise(function() {});
	            }
	          }
	          throw bridgeMsgErr;
	        }
	      }

      if (!__wkNativeSignPersonalMessage) {
        throw new Error('Current wallet does not support personal message signing');
      }
      return await __wkNativeSignPersonalMessage(message);
    };

	    SuiWalletKit.signTransaction = async function signTransaction(txInput, options) {
        var bypassBridgeForSlush = __skiShouldBypassBridgeForSlush(options);

      if (bypassBridgeForSlush) {
        var slushTxConn = await __skiEnsureConnectedWalletForSigning('Slush');
        if (!slushTxConn || !slushTxConn.wallet) {
          throw new Error('Slush extension not detected in this tab. Open Slush and retry.');
        }
      }

      var txRaw = await __skiSerializeForWallet(txInput);
      var txBytes = txRaw;
      if (txRaw && typeof txRaw.serialize === 'function') {
        try {
          txBytes = await txRaw.serialize();
        } catch (_e) {
          if (txRaw && typeof txRaw.build === 'function') {
            try {
              var RpcClient = window.SuiJsonRpcClient || window.SuiClient;
              if (RpcClient) {
                var rpcClient = new RpcClient({ url: __wkGetRpcUrl() });
                txBytes = await txRaw.build({ client: rpcClient });
              }
            } catch (_e2) {}
          }
        }
      }
      var txB64 = txBytes;
      if (
        txBytes instanceof Uint8Array ||
        txBytes instanceof ArrayBuffer ||
        Array.isArray(txBytes)
      ) {
        txB64 = __wkBytesToBase64(txBytes);
      }
      var conn = __wkGetWallet();
      var wallet = conn.wallet;
      var account = __wkResolveWalletAccount(conn, options && options.account);
      var chain = (options && options.chain) || __wkChain;
      async function __wkTryCalls(calls) {
        var lastErr = null;
        for (var i = 0; i < calls.length; i++) {
          try {
            return await calls[i]();
          } catch (err) {
            lastErr = err;
          }
        }
        if (lastErr) throw lastErr;
        throw new Error('Wallet does not support transaction signing. Try a different wallet or update your current one.');
      }

      var signFeature = wallet.features && wallet.features['sui:signTransaction'];
      if (signFeature && signFeature.signTransaction) {
        try {
          return await __wkTryCalls([
            function() {
              return signFeature.signTransaction({
                transaction: txRaw,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signFeature.signTransaction({
                transaction: txRaw,
                account: account,
              });
            },
            function() {
              return signFeature.signTransaction({
                transaction: txRaw,
              });
            },
            function() {
              return signFeature.signTransaction({
                transaction: txBytes,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signFeature.signTransaction({
                transaction: txBytes,
                account: account,
              });
            },
            function() {
              return signFeature.signTransaction({
                transaction: txBytes,
              });
            },
            function() {
              return signFeature.signTransaction({
                transaction: txB64,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signFeature.signTransaction({
                transaction: txB64,
                account: account,
              });
            },
            function() {
              return signFeature.signTransaction({
                transaction: txB64,
              });
            },
          ]);
        } catch (err) {
          console.warn('signTransaction failed:', err && err.message ? err.message : err);
        }
      }

      var signBlockFeature = wallet.features && wallet.features['sui:signTransactionBlock'];
      if (signBlockFeature && signBlockFeature.signTransactionBlock) {
        try {
          return await __wkTryCalls([
            function() {
              return signBlockFeature.signTransactionBlock({
                transactionBlock: txRaw,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transactionBlock: txRaw,
                account: account,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transactionBlock: txRaw,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transactionBlock: txBytes,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transactionBlock: txBytes,
                account: account,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transactionBlock: txBytes,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transactionBlock: txB64,
                account: account,
                chain: chain,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transactionBlock: txB64,
                account: account,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transactionBlock: txB64,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transaction: txRaw,
                account: account,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transaction: txBytes,
                account: account,
              });
            },
            function() {
              return signBlockFeature.signTransactionBlock({
                transaction: txB64,
                account: account,
              });
            },
          ]);
        } catch (err) {
          console.warn('signTransactionBlock failed:', err && err.message ? err.message : err);
        }
      }

      var phantom = __wkGetPhantomProvider();
      var walletName = String((wallet && wallet.name) || '').toLowerCase();
      var isPhantomWallet = !!(
        (walletName && walletName.indexOf('phantom') !== -1)
        || (wallet && wallet.isPhantom)
        || (wallet && wallet._raw && wallet._raw.isPhantom)
        || (
          phantom && (
            wallet === phantom
            || (wallet && wallet._raw === phantom)
          )
        )
      );
      if (phantom && phantom.signTransactionBlock && isPhantomWallet) {
        try {
          return await __wkTryCalls([
            function() { return phantom.signTransactionBlock({ transactionBlock: txRaw }); },
            function() { return phantom.signTransactionBlock({ transaction: txRaw }); },
            function() { return phantom.signTransactionBlock({ transactionBlock: txBytes }); },
            function() { return phantom.signTransactionBlock({ transaction: txBytes }); },
            function() { return phantom.signTransactionBlock({ transactionBlock: txB64 }); },
            function() { return phantom.signTransactionBlock({ transaction: txB64 }); },
          ]);
        } catch (_e) {
          // Continue to wallet fallback.
        }
      }

      if (window.suiWallet && window.suiWallet.signTransactionBlock) {
        try {
          return await __wkTryCalls([
            function() { return window.suiWallet.signTransactionBlock({ transactionBlock: txRaw }); },
            function() { return window.suiWallet.signTransactionBlock({ transaction: txRaw }); },
            function() { return window.suiWallet.signTransactionBlock({ transactionBlock: txBytes }); },
            function() { return window.suiWallet.signTransactionBlock({ transaction: txBytes }); },
            function() { return window.suiWallet.signTransactionBlock({ transactionBlock: txB64 }); },
            function() { return window.suiWallet.signTransactionBlock({ transaction: txB64 }); },
          ]);
        } catch (_e) {}
      }

      throw new Error('Wallet does not support transaction signing. Try a different wallet or update your current one.');
    };
  


    function __wkTruncAddr(addr) {
      return addr ? addr.slice(0, 6) + '...' + addr.slice(-4) : '';
    }

		function __wkNormalizeSuiAddress(addr) {
			var value = typeof addr === 'string' ? addr.trim() : '';
			if (!value) return '';
			if (value.indexOf('0x') !== 0 && /^[0-9a-fA-F]+$/.test(value)) {
				return '0x' + value;
			}
			return value;
		}

		function __wkIsValidSuiAddress(addr) {
			var normalized = __wkNormalizeSuiAddress(addr);
			return /^0x[0-9a-fA-F]{1,64}$/.test(normalized);
		}

		function __wkGetPrimaryNameSlug(value) {
			var slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
			if (!slug) return '';
			slug = slug.replace(/^@+/, '').replace(/\.sui$/i, '');
			if (!slug) return '';
			return slug;
		}

		function __wkGetPrimaryProfileHref(conn) {
			var slug = __wkGetPrimaryNameSlug(conn && conn.primaryName);
			if (!slug) return '';
			return 'https://' + encodeURIComponent(slug) + '.' + __wkPrimaryProfileHost;
		}

	    var __wkModalContainer = null;
	    var __wkWidgetContainer = null;
	    var __wkModalUnsub = null;
	    var __wkModalWalletsUnsub = null;
	    var __wkWidgetUnsub = null;
	    var __wkWidgetDocClickBound = false;
	    var __wkWidgetBtnMarkup = '';
	    var __wkWidgetBtnStateClass = '';
	    var __wkWidgetDropdownMarkup = '';
	    var __wkLastWalletKey = 'sui_ski_last_wallet';
	    var __wkShowPrimaryName = true;
	    var __wkKeepBrandLogoWhenConnected = false;
	    var __wkPrimaryProfileHost = "sui.ski";

	    function __wkAssetUrl(assetName) {
	      var base = "./assets/";
	      try {
	        if (typeof window !== "undefined" && window.__WALLET_ASSET_BASE) {
	          base = String(window.__WALLET_ASSET_BASE || base);
	        }
	      } catch (_e) {}
	      if (!base) base = "./assets/";
	      if (base.charAt(base.length - 1) !== "/") base += "/";
	      return base + assetName;
	    }
	    var __wkWidgetBrandLogoSrc = __wkAssetUrl('green_dotski.png');
	    var __wkWidgetDefaultMarkup = '<img src="' + __wkWidgetBrandLogoSrc + '" class="wk-widget-brand-logo" alt=".SKI" draggable="false">';

	    var __wkPortfolioTimer = null;
	    var __wkPortfolioData = null;
	    var __wkPortfolioRealtimeBound = false;
	    var __wkExpandedL1 = {};
	    var __wkLocalWalletMap = {};
	    var __wkBridgeWalletCache = {};
	    var __wkBridgeWalletOrder = [];
	    var __wkLastBridgeHintSignature = '';
	    var __wkBridgeHiddenStyle = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0;z-index:-1;background:transparent';
	    var __wkDetectedWalletCacheKey = 'sui_ski_detected_wallets_v1';
	    var __wkBridgeDetectedWalletCacheKey = 'sui_ski_bridge_detected_wallets_v1';
	    var __wkDetectedWalletCacheMaxAgeMs = 1000 * 60 * 60 * 24 * 14;

	    function __wkResetBridgeWalletCache() {
	      __wkBridgeWalletCache = {};
	      __wkBridgeWalletOrder = [];
	    }

	    function __wkGetBridgeWalletSnapshot() {
	      var out = [];
	      for (var i = 0; i < __wkBridgeWalletOrder.length; i++) {
	        var key = __wkBridgeWalletOrder[i];
	        if (__wkBridgeWalletCache[key]) out.push(__wkBridgeWalletCache[key]);
	      }
	      return out;
	    }

	    function __wkMergeBridgeWallets(wallets) {
	      var list = Array.isArray(wallets) ? wallets : [];
	      for (var i = 0; i < list.length; i++) {
	        var wallet = list[i];
	        if (!wallet || !wallet.name) continue;
	        var key = __wkWalletNameKey(wallet.name);
	        if (!key) key = 'wallet-' + i;
	        var existing = __wkBridgeWalletCache[key];
	        if (!existing) {
	          __wkBridgeWalletCache[key] = {
	            name: String(wallet.name),
	            icon: wallet.icon ? String(wallet.icon) : '',
	            __isPasskey: !!wallet.__isPasskey,
	          };
	          __wkBridgeWalletOrder.push(key);
	          continue;
	        }
	        if (!existing.icon && wallet.icon) {
	          existing.icon = String(wallet.icon);
	        }
	        if (existing.__isPasskey && !wallet.__isPasskey) {
	          existing.__isPasskey = false;
	        }
	      }
	      return __wkGetBridgeWalletSnapshot();
	    }

	    function __wkSerializeWalletForCache(wallet) {
	      if (!wallet || !wallet.name) return null;
	      return {
	        name: String(wallet.name),
	        icon: wallet.icon ? String(wallet.icon) : '',
	        __isPasskey: !!wallet.__isPasskey,
	      };
	    }

	    function __wkReadDetectedWalletCache(keyOverride) {
	      try {
	        var cacheKey = keyOverride || __wkDetectedWalletCacheKey;
	        var raw = localStorage.getItem(cacheKey);
	        if (!raw) return [];
	        var parsed = JSON.parse(raw);
	        if (!parsed || typeof parsed !== 'object') return [];
	        var ts = Number(parsed.ts || 0);
	        if (!Number.isFinite(ts) || ts <= 0) return [];
	        if ((Date.now() - ts) > __wkDetectedWalletCacheMaxAgeMs) return [];
	        var wallets = Array.isArray(parsed.wallets) ? parsed.wallets : [];
	        var out = [];
	        for (var i = 0; i < wallets.length; i++) {
	          var serialized = __wkSerializeWalletForCache(wallets[i]);
	          if (serialized) out.push(serialized);
	        }
	        return out;
	      } catch (_e) {
	        return [];
	      }
	    }

	    function __wkWriteDetectedWalletCache(wallets, keyOverride) {
	      try {
	        var cacheKey = keyOverride || __wkDetectedWalletCacheKey;
	        var list = Array.isArray(wallets) ? wallets : [];
	        var serialized = [];
	        for (var i = 0; i < list.length; i++) {
	          var item = __wkSerializeWalletForCache(list[i]);
	          if (item) serialized.push(item);
	        }
	        localStorage.setItem(cacheKey, JSON.stringify({
	          ts: Date.now(),
	          wallets: serialized,
	        }));
	      } catch (_e) {}
	    }

	    function __wkFormatBalance(sui) {
	      if (sui < 0.01) return '< 0.01';
	      if (sui < 10000) {
	        var snapped = Math.round(sui);
	        if (Math.abs(sui - snapped) <= 0.05) return String(snapped);
	      }
	      if (sui < 100) {
	        return sui.toFixed(2).replace(/\.?0+$/, '');
	      }
	      if (sui < 10000) return sui.toFixed(1);
	      if (sui < 1000000) return (sui / 1000).toFixed(1) + 'k';
	      return (sui / 1000000).toFixed(1) + 'M';
	    }

    function __wkFormatUsd(usd) {
      if (usd < 0.01) return '< $0.01';
      if (usd < 100) return '$' + usd.toFixed(2);
      if (usd < 10000) return '$' + usd.toFixed(0);
      if (usd < 1000000) return '$' + (usd / 1000).toFixed(1) + 'k';
      return '$' + (usd / 1000000).toFixed(1) + 'M';
    }

    function __wkNormalizeHoldingSymbol(name) {
      return String(name || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    }

    function __wkHoldingBucket(symbol) {
      if (!symbol) return '';
      if (symbol === 'SUI' || symbol === 'WSUI') return 'SUI';
      if (symbol === 'ETH' || symbol === 'WETH') return 'ETH';
      if (symbol === 'SOL' || symbol === 'WSOL') return 'SOL';
      return '';
    }

    function __wkIsStablecoin(symbol) {
      if (!symbol) return false;
      var s = symbol.toUpperCase();
      return s === 'USDC' || s === 'USDT' || s === 'DAI' || s === 'AUSD' || s === 'BUCK' || s === 'FDUSD' || s === 'WUSDC' || s === 'WUSDT';
    }

    function __wkGetStablecoinTotal(portfolioData) {
      if (!portfolioData || !Array.isArray(portfolioData.holdings)) return 0;
      var total = 0;
      for (var i = 0; i < portfolioData.holdings.length; i++) {
        var holding = portfolioData.holdings[i];
        var symbol = __wkNormalizeHoldingSymbol(holding && holding.name);
        if (!__wkIsStablecoin(symbol)) continue;
        var amount = Number(holding && holding.balance);
        if (Number.isFinite(amount) && amount > 0) total += amount;
      }
      return total;
    }

    function __wkFormatTokenAmount(value) {
      if (!Number.isFinite(value) || value <= 0) return '0';
      if (value < 0.0001) return '<0.0001';
      if (value < 1) return value.toFixed(4).replace(/\.?0+$/, '');
      if (value < 100) return value.toFixed(3).replace(/\.?0+$/, '');
      if (value < 10000) return value.toFixed(2).replace(/\.?0+$/, '');
      if (value < 1000000) return (value / 1000).toFixed(1) + 'k';
      return (value / 1000000).toFixed(1) + 'M';
    }

    function __wkGetNonL1Holdings(portfolioData) {
      if (!portfolioData || !Array.isArray(portfolioData.holdings)) return [];
      var merged = {};
      for (var i = 0; i < portfolioData.holdings.length; i++) {
        var holding = portfolioData.holdings[i];
        var symbol = __wkNormalizeHoldingSymbol(holding && holding.name);
        if (!symbol || __wkHoldingBucket(symbol)) continue;
        var amount = Number(holding && holding.balance);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        var suiValue = Number(holding && holding.suiValue);
        if (!merged[symbol]) {
          merged[symbol] = { name: symbol, balance: 0, suiValue: 0 };
        }
        merged[symbol].balance += amount;
        if (Number.isFinite(suiValue) && suiValue > 0) {
          merged[symbol].suiValue += suiValue;
        }
      }
      return Object.keys(merged)
        .map(function(key) { return merged[key]; })
        .sort(function(a, b) { return b.suiValue - a.suiValue; });
    }

    var __wkL1Order = ['SUI', 'ETH', 'SOL'];

    var __wkL1Icons = {
      SUI: '<svg viewBox="0 0 300 384" width="14" height="18" style="display:inline-block;vertical-align:-3px;fill:#4DA2FF;"><path fill-rule="evenodd" clip-rule="evenodd" d="M240.057 159.914C255.698 179.553 265.052 204.39 265.052 231.407C265.052 258.424 255.414 284.019 239.362 303.768L237.971 305.475L237.608 303.31C237.292 301.477 236.929 299.613 236.502 297.749C228.46 262.421 202.265 232.134 159.148 207.597C130.029 191.071 113.361 171.195 108.985 148.586C106.157 133.972 108.258 119.294 112.318 106.717C116.379 94.1569 122.414 83.6187 127.549 77.2831L144.328 56.7754C147.267 53.1731 152.781 53.1731 155.719 56.7754L240.073 159.914H240.057ZM266.584 139.422L154.155 1.96703C152.007 -0.655678 147.993 -0.655678 145.845 1.96703L33.4316 139.422L33.0683 139.881C12.3868 165.555 0 198.181 0 233.698C0 316.408 67.1635 383.461 150 383.461C232.837 383.461 300 316.408 300 233.698C300 198.181 287.613 165.555 266.932 139.896L266.568 139.438L266.584 139.422ZM60.3381 159.472L70.3866 147.164L70.6868 149.439C70.9237 151.24 71.2239 153.041 71.5715 154.858C78.0809 189.001 101.322 217.456 140.173 239.496C173.952 258.724 193.622 280.828 199.278 305.064C201.648 315.176 202.059 325.129 201.032 333.835L200.969 334.372L200.479 334.609C185.233 342.05 168.09 346.237 149.984 346.237C86.4546 346.237 34.9484 294.826 34.9484 231.391C34.9484 204.153 44.4439 179.142 60.3065 159.44L60.3381 159.472Z"></path></svg>',
      ETH: '<svg viewBox="0 0 256 417" width="10" height="18" style="display:inline-block;vertical-align:-3px;"><path d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z" fill="#627EEA"/><path d="M127.962 0L0 212.32l127.962 75.639V154.158z" fill="#8C8FE6"/><path d="M127.961 312.187l-1.575 1.92V414.79l1.575 4.6L256 236.587z" fill="#627EEA"/><path d="M127.962 419.39V312.187L0 236.587z" fill="#8C8FE6"/><path d="M127.961 287.958l127.96-75.637-127.96-58.162z" fill="#3C3C94"/><path d="M0 212.32l127.96 75.639V154.159z" fill="#627EEA"/></svg>',
      SOL: '<svg viewBox="0 0 398 312" width="16" height="14" style="display:inline-block;vertical-align:-2px;"><defs><linearGradient id="sol-a" x1="360.879" y1="351.455" x2="141.213" y2="-69.294" gradientUnits="userSpaceOnUse"><stop stop-color="#00FFA3"/><stop offset="1" stop-color="#DC1FFF"/></linearGradient><linearGradient id="sol-b" x1="264.829" y1="401.601" x2="45.163" y2="-19.148" gradientUnits="userSpaceOnUse"><stop stop-color="#00FFA3"/><stop offset="1" stop-color="#DC1FFF"/></linearGradient><linearGradient id="sol-c" x1="312.548" y1="376.688" x2="92.882" y2="-44.061" gradientUnits="userSpaceOnUse"><stop stop-color="#00FFA3"/><stop offset="1" stop-color="#DC1FFF"/></linearGradient></defs><path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1z" fill="url(#sol-a)"/><path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1z" fill="url(#sol-b)"/><path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1z" fill="url(#sol-c)"/></svg>'
    };

    function __wkGetL1Holdings(portfolioData) {
      if (!portfolioData || !Array.isArray(portfolioData.holdings)) return [];
      var buckets = {};
      for (var i = 0; i < portfolioData.holdings.length; i++) {
        var holding = portfolioData.holdings[i];
        var symbol = __wkNormalizeHoldingSymbol(holding && holding.name);
        var bucket = __wkHoldingBucket(symbol);
        if (!bucket) continue;
        var amount = Number(holding && holding.balance);
        if (!Number.isFinite(amount)) amount = 0;
        var suiValue = Number(holding && holding.suiValue);
        if (!Number.isFinite(suiValue)) suiValue = 0;
        if (!buckets[bucket]) {
          buckets[bucket] = { name: bucket, balance: 0, suiValue: 0 };
        }
        buckets[bucket].balance += amount;
        buckets[bucket].suiValue += suiValue;
      }
      var result = [];
      for (var o = 0; o < __wkL1Order.length; o++) {
        var key = __wkL1Order[o];
        if (buckets[key] && buckets[key].balance > 0) {
          result.push(buckets[key]);
        }
      }
      return result;
    }

    function __wkGetL1SubTokens(l1Name, portfolioData) {
      if (l1Name === 'SUI') return __wkGetNonL1Holdings(portfolioData);
      if (!portfolioData || !Array.isArray(portfolioData.holdings)) return [];
      var entries = [];
      for (var i = 0; i < portfolioData.holdings.length; i++) {
        var holding = portfolioData.holdings[i];
        var symbol = __wkNormalizeHoldingSymbol(holding && holding.name);
        if (__wkHoldingBucket(symbol) !== l1Name || symbol === l1Name) continue;
        var amount = Number(holding && holding.balance);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        var suiValue = Number(holding && holding.suiValue);
        entries.push({ name: symbol, balance: amount, suiValue: Number.isFinite(suiValue) ? suiValue : 0 });
      }
      return entries.sort(function(a, b) { return b.suiValue - a.suiValue; });
    }

    async function __wkFetchPortfolio(address) {
      try {
        var suiClient = typeof getSuiClient === 'function' ? getSuiClient() : null;
        if (!suiClient) return null;

        var SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
        var suiBal = await suiClient.getBalance({ owner: address, coinType: SUI_TYPE }).catch(function() { return { totalBalance: '0' }; });
        var suiAmount = Number(BigInt(suiBal.totalBalance)) / 1e9;
        var totalSui = suiAmount;
        var holdings = [{ name: 'SUI', balance: suiAmount, suiValue: suiAmount }];

        var poolsRaw = await fetch('/api/deepbook-pools').then(function(r) { return r.json(); }).catch(function() { return []; });
        var pools = [];
        if (Array.isArray(poolsRaw) && poolsRaw.length) {
          var poolByCoinType = {};
          for (var p = 0; p < poolsRaw.length; p++) {
            var pool = poolsRaw[p];
            if (!pool || typeof pool.coinType !== 'string' || !pool.coinType) continue;
            var existing = poolByCoinType[pool.coinType];
            if (!existing) {
              poolByCoinType[pool.coinType] = pool;
              continue;
            }
            if (!existing.isDirect && pool.isDirect) {
              poolByCoinType[pool.coinType] = pool;
              continue;
            }
            var nextRate = Number(pool.suiPerToken || 0);
            var existingRate = Number(existing.suiPerToken || 0);
            if (Number.isFinite(nextRate) && nextRate > existingRate) {
              poolByCoinType[pool.coinType] = pool;
            }
          }
          pools = Object.values(poolByCoinType);
        }
        if (pools.length) {
          var balances = await Promise.all(
            pools.map(function(p) {
              return suiClient.getBalance({ owner: address, coinType: p.coinType }).catch(function() { return { totalBalance: '0' }; });
            })
          );
          for (var i = 0; i < pools.length; i++) {
            var bal = Number(BigInt(balances[i].totalBalance));
            if (bal <= 0) continue;
            var tokenAmount = bal / Math.pow(10, pools[i].decimals);
            var suiValue = tokenAmount * pools[i].suiPerToken * 0.95;
            totalSui += suiValue;
            holdings.push({ name: pools[i].name, balance: tokenAmount, suiValue: suiValue });
          }
        }

        var usdcData = await fetch('/api/usdc-price').then(function(r) { return r.json(); }).catch(function() { return null; });
        var usdcPerSui = usdcData && usdcData.usdcPerSui ? usdcData.usdcPerSui : 0;

        return { totalSui: totalSui, usdcPerSui: usdcPerSui, holdings: holdings };
      } catch (e) {
        return null;
      }
    }

	    function __wkRefreshPortfolio(address) {
	      if (!address) return;
	      __wkFetchPortfolio(address).then(function(data) {
	        if (data) {
	          __wkPortfolioData = data;
	          __wkUpdateWidget(SuiWalletKit.$connection.value);
	        }
	      });
	    }

	    function __wkCurrentConnectedAddress() {
	      var conn = SuiWalletKit && SuiWalletKit.$connection ? SuiWalletKit.$connection.value : null;
	      var rawAddr = conn && (conn.status === 'connected' || conn.status === 'session') ? conn.address : '';
	      var normalized = __wkNormalizeSuiAddress(rawAddr || '');
	      return __wkIsValidSuiAddress(normalized) ? normalized : '';
	    }

	    function __wkStartPortfolioPolling(address) {
	      __wkStopPortfolioPolling();
	      function poll() {
	        __wkRefreshPortfolio(address);
	      }
	      poll();
	      __wkPortfolioTimer = setInterval(poll, 30000);
	      if (!__wkPortfolioRealtimeBound) {
	        __wkPortfolioRealtimeBound = true;
	        window.addEventListener('wk:tx-success', function() {
	          var addr = __wkCurrentConnectedAddress();
	          if (!addr) return;
	          __wkRefreshPortfolio(addr);
	          setTimeout(function() {
	            __wkRefreshPortfolio(addr);
	          }, 1800);
	        });
	        window.addEventListener('focus', function() {
	          var addr = __wkCurrentConnectedAddress();
	          if (!addr) return;
	          __wkRefreshPortfolio(addr);
	        });
	        document.addEventListener('visibilitychange', function() {
	          if (document.visibilityState !== 'visible') return;
	          var addr = __wkCurrentConnectedAddress();
	          if (!addr) return;
	          __wkRefreshPortfolio(addr);
	        });
	      }
	    }

    function __wkStopPortfolioPolling() {
      if (__wkPortfolioTimer) {
        clearInterval(__wkPortfolioTimer);
        __wkPortfolioTimer = null;
      }
      __wkPortfolioData = null;
    }

    function __wkDefaultIcon() {
      return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle fill="#818cf8" cx="16" cy="16" r="16"/></svg>');
    }

    var __wkWaaPIcon = __wkAssetUrl('waap-icon.svg');

	    var __wkSocialIcons = {
	      google: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>',
      github: '<svg viewBox="0 0 24 24" width="24" height="24" fill="#8e8ea4"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/></svg>',
      email: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#8e8ea4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m2 7 10 7 10-7"/></svg>',
      phone: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#8e8ea4" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="3"/><line x1="12" y1="18" x2="12.01" y2="18" stroke-width="2"/></svg>',
      x: '<span class="wk-social-x-icon" aria-hidden="true"><span class="wk-social-x-glyph">𝕏</span></span>',
      discord: '<svg viewBox="0 0 24 24" width="22" height="22" fill="#8e8ea4"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>',
	      coinbase: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><circle cx="12" cy="12" r="11" stroke="#8e8ea4" stroke-width="1.5"/><path d="M14.5 10.5h-5v3h5v-3z" fill="#8e8ea4" rx="0.5"/></svg>'
	    };

	    function __wkWidgetMethodIconSvg(method) {
	      var key = __wkNormalizeWaaPMethod(method);
	      if (!key) return '';
	      if (key === 'x') {
	        return '<span class="wk-widget-method-icon wk-social-x-icon" aria-hidden="true"><span class="wk-social-x-glyph">𝕏</span></span>';
	      }
	      return __wkSocialIcons[key]
	        ? __wkSocialIcons[key].replace(/width="\d+"/, 'width="18"').replace(/height="\d+"/, 'height="18"').replace(/fill="[^"]*"/, 'fill="#e2e8f0"')
	        : '';
	    }
	    var __wkLogoSvg = '<img class="wk-modal-logo-img" src="' + __wkAssetUrl('black_dotski.png?v=20260223b') + '" alt=".SKI" draggable="false" onerror="this.onerror=null;this.src=\'' + __wkAssetUrl('black_dotski.png') + '\';">';

    var __wkQrSvg = '<img src="' + __wkAssetUrl('waap-qr.svg') + '" alt="WaaP QR" style="display:block;width:100%;height:100%;border-radius:12px;" />'; 

    function __wkGetLastWallet() {
      try { return localStorage.getItem(__wkLastWalletKey) || ''; } catch (_e) { return ''; }
    }

	    function __wkSetLastWallet(name) {
	      try { localStorage.setItem(__wkLastWalletKey, name); } catch (_e) {}
	    }

	    function __wkWalletNameKey(name) {
	      var normalized = String(name || '').trim().toLowerCase();
	      if (!normalized) return '';
	      normalized = normalized.replace(/[^a-z0-9]+/g, ' ').trim();
	      if (!normalized) return '';
	      if (normalized.slice(-7) === ' wallet') {
	        normalized = normalized.slice(0, -7).trim();
	      }
	      return normalized.replace(/\s+/g, '');
	    }

    var __wkKnownAliasGroups = [
      ['slush', 'slushwallet'],
      ['sui', 'suiwallet', 'mystenwallet'],
      ['suiet', 'suietwallet'],
      ['phantom', 'phantomwallet'],
      ['backpack', 'backpackwallet'],
    ];

	    function __wkWalletKeysRelated(a, b) {
	      if (!a || !b) return false;
	      if (a === b) return true;
	      for (var g = 0; g < __wkKnownAliasGroups.length; g++) {
	        var group = __wkKnownAliasGroups[g];
	        var hasA = false, hasB = false;
	        for (var i = 0; i < group.length; i++) {
	          if (group[i] === a) hasA = true;
	          if (group[i] === b) hasB = true;
	        }
	        if (hasA && hasB) return true;
	      }
	      if (a.length >= 5 && b.length >= 5) {
	        return a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
	      }
	      return false;
	    }

	    var __wkWaaPMethodByAddressKey = 'sui_ski_waap_method_by_address_v1';
	    var __wkPendingWaaPMethod = '';
	    var __wkRequiredWaaPMethod = '';
	    var __wkWaaPMethodLabels = {
	      x: 'X',
	      phone: 'Phone',
	      email: 'Email',
	      google: 'Google',
	      coinbase: 'Coinbase',
	      discord: 'Discord',
	    };

	    function __wkNormalizeWaaPMethod(method) {
	      var key = String(method || '').trim().toLowerCase();
	      return __wkWaaPMethodLabels[key] ? key : '';
	    }

	    function __wkRememberPendingWaaPMethod(method) {
	      __wkPendingWaaPMethod = __wkNormalizeWaaPMethod(method);
	    }

	    function __wkSetRequiredWaaPMethod(method) {
	      __wkRequiredWaaPMethod = __wkNormalizeWaaPMethod(method);
	    }

	    function __wkClearRequiredWaaPMethod() {
	      __wkRequiredWaaPMethod = '';
	    }

	    function __wkReadSessionWalletName() {
	      try {
	        if (typeof getWalletSession !== 'function') return '';
	        var session = getWalletSession();
	        return session && session.walletName ? String(session.walletName) : '';
	      } catch (_e) {
	        return '';
	      }
	    }

	    function __wkGetConnectionWalletName(conn) {
	      if (conn && conn.wallet && conn.wallet.name) return String(conn.wallet.name);
	      if (SuiWalletKit.__sessionWalletName) return String(SuiWalletKit.__sessionWalletName);
	      return __wkReadSessionWalletName();
	    }

	    function __wkGetWaaPMethodMap() {
	      try {
	        var raw = localStorage.getItem(__wkWaaPMethodByAddressKey);
	        if (!raw) return {};
	        var parsed = JSON.parse(raw);
	        return parsed && typeof parsed === 'object' ? parsed : {};
	      } catch (_e) {
	        return {};
	      }
	    }

	    function __wkSetWaaPMethodMap(map) {
	      try {
	        localStorage.setItem(__wkWaaPMethodByAddressKey, JSON.stringify(map || {}));
	      } catch (_e) {}
	    }

	    function __wkSaveWaaPMethodForAddress(address, method) {
	      var normalizedAddress = __wkNormalizeSuiAddress(address).toLowerCase();
	      var normalizedMethod = __wkNormalizeWaaPMethod(method);
	      if (!normalizedAddress || !normalizedMethod) return;
	      var map = __wkGetWaaPMethodMap();
	      map[normalizedAddress] = normalizedMethod;
	      __wkSetWaaPMethodMap(map);
	    }

	    function __wkGetWaaPMethodForAddress(address) {
	      var normalizedAddress = __wkNormalizeSuiAddress(address).toLowerCase();
	      if (!normalizedAddress) return '';
	      var map = __wkGetWaaPMethodMap();
	      return __wkNormalizeWaaPMethod(map[normalizedAddress]);
	    }

	    var __wkWaaPLabelByAddressKey = 'sui_ski_waap_label_by_address_v1';

	    function __wkGetWaaPLabelMap() {
	      try {
	        var raw = localStorage.getItem(__wkWaaPLabelByAddressKey);
	        if (!raw) return {};
	        var parsed = JSON.parse(raw);
	        return parsed && typeof parsed === 'object' ? parsed : {};
	      } catch (_e) {
	        return {};
	      }
	    }

	    function __wkSaveWaaPLabelForAddress(address, label) {
	      var normalizedAddress = __wkNormalizeSuiAddress(address).toLowerCase();
	      if (!normalizedAddress || !label) return;
	      try {
	        var map = __wkGetWaaPLabelMap();
	        map[normalizedAddress] = String(label).trim();
	        localStorage.setItem(__wkWaaPLabelByAddressKey, JSON.stringify(map));
	      } catch (_e) {}
	    }

	    function __wkGetWaaPLabelForAddress(address) {
	      var normalizedAddress = __wkNormalizeSuiAddress(address).toLowerCase();
	      if (!normalizedAddress) return '';
	      var map = __wkGetWaaPLabelMap();
	      return typeof map[normalizedAddress] === 'string' ? map[normalizedAddress] : '';
	    }

	    function __wkPersistPendingWaaPMethod(address) {
	      if (!__wkPendingWaaPMethod) return;
	      __wkSaveWaaPMethodForAddress(address, __wkPendingWaaPMethod);
	      __wkPendingWaaPMethod = '';
	    }

	    function __wkMethodFromWaaPLabel(label) {
	      var raw = String(label || '').trim().toLowerCase();
	      if (!raw) return '';
	      if (raw === 'x' || raw === 'twitter' || raw.indexOf(' x ') !== -1 || raw.indexOf('twitter') !== -1) return 'x';
	      if (raw.indexOf('google') !== -1 || raw.indexOf('gmail') !== -1) return 'google';
	      if (raw.indexOf('discord') !== -1) return 'discord';
	      if (raw.indexOf('coinbase') !== -1) return 'coinbase';
	      if (raw.indexOf('email') !== -1 || raw.indexOf('mail') !== -1) return 'email';
	      if (raw.indexOf('phone') !== -1 || raw.indexOf('sms') !== -1) return 'phone';
	      return '';
	    }

	    function __wkResolveWaaPMethod(conn) {
	      if (!conn || !conn.address) return __wkPendingWaaPMethod || '';
	      var method = __wkGetWaaPMethodForAddress(conn.address) || __wkPendingWaaPMethod;
	      if (method) return method;
	      var liveLabel = (conn.account && typeof conn.account.label === 'string') ? conn.account.label : '';
	      method = __wkMethodFromWaaPLabel(liveLabel);
	      if (method) {
	        __wkSaveWaaPMethodForAddress(conn.address, method);
	        return method;
	      }
	      var savedLabel = __wkGetWaaPLabelForAddress(conn.address);
	      method = __wkMethodFromWaaPLabel(savedLabel);
	      if (method) {
	        __wkSaveWaaPMethodForAddress(conn.address, method);
	        return method;
	      }
	      return '';
	    }

	    function __wkFindWaaPMethodConflict(requiredMethod, address, liveMethod) {
	      var required = __wkNormalizeWaaPMethod(requiredMethod);
	      if (!required) return '';

	      var connected = __wkNormalizeWaaPMethod(liveMethod);
	      if (connected && connected !== required) return connected;

	      var storedMethod = __wkGetWaaPMethodForAddress(address);
	      if (storedMethod && storedMethod !== required) return storedMethod;

	      var storedLabelMethod = __wkMethodFromWaaPLabel(__wkGetWaaPLabelForAddress(address));
	      if (storedLabelMethod && storedLabelMethod !== required) return storedLabelMethod;
	      return '';
	    }

	    function __wkIsWaaPMethodAllowed(requiredMethod, address, liveMethod) {
	      return !__wkFindWaaPMethodConflict(requiredMethod, address, liveMethod);
	    }

	    function __wkCollectKnownWaaPMethods() {
	      var methods = [];
	      function push(method) {
	        var normalized = __wkNormalizeWaaPMethod(method);
	        if (!normalized) return;
	        for (var i = 0; i < methods.length; i++) {
	          if (methods[i] === normalized) return;
	        }
	        methods.push(normalized);
	      }

	      var conn = null;
	      var connWalletName = '';
	      try {
	        conn = SuiWalletKit.$connection.value || null;
	        connWalletName = __wkGetConnectionWalletName(conn);
	      } catch (_eConn) {}

	      if (conn && conn.address && __wkWalletNameKey(connWalletName || '') === 'waap') {
	        push(__wkGetWaaPMethodForAddress(conn.address));
	        if (conn.account && typeof conn.account.label === 'string') {
	          push(__wkMethodFromWaaPLabel(conn.account.label));
	        }
	      }

	      try {
	        var session = typeof getWalletSession === 'function' ? getWalletSession() : null;
	        if (session && session.address) {
	          var sessionWalletName = session.walletName || connWalletName;
	          if (__wkWalletNameKey(sessionWalletName || '') === 'waap') {
	            push(__wkGetWaaPMethodForAddress(session.address));
	            push(__wkMethodFromWaaPLabel(__wkGetWaaPLabelForAddress(session.address)));
	          }
	        }
	      } catch (_eSession) {}

	      return methods;
	    }

	    function __wkShouldResetWaaPSessionForMethod(method) {
	      var requested = __wkNormalizeWaaPMethod(method);
	      if (!requested) return false;
	      var known = __wkCollectKnownWaaPMethods();
	      for (var i = 0; i < known.length; i++) {
	        if (known[i] && known[i] !== requested) return true;
	      }
	      return false;
	    }

	    function __wkGetWaaPConnectionHint(conn) {
	      var walletName = __wkGetConnectionWalletName(conn).trim().toLowerCase();
	      if (walletName !== 'waap') return '';
	      var method = __wkResolveWaaPMethod(conn);
	      var methodLabel = method ? (__wkWaaPMethodLabels[method] || '') : '';
	      return methodLabel ? ('WaaP via ' + methodLabel) : 'WaaP connected';
	    }

    function __wkInstallLinksHtml() {
      return '<div class="wk-no-wallets">'
        + 'No wallets detected.'
        + '</div>';
    }

    function __wkEnsureSocialSectionStructure(container) {
      if (!container) return null;
      var socialEl = container.querySelector('.wk-social-section');
      if (!socialEl) return null;
      var grid = socialEl.querySelector('.wk-social-grid');
      if (!grid) {
        socialEl.innerHTML = '<div class="wk-social-grid"></div>'
          + '<a class="wk-powered-pill" href="https://waap.sui.ski" target="_blank" rel="noopener"><img src="' + __wkWaaPIcon + '" alt="WaaP"> powered by WaaP</a>';
      }
      return socialEl;
    }

	    function __wkFormatConnectError(err, walletName) {
      var message = '';
      if (err && typeof err.message === 'string' && err.message) {
        message = String(err.message);
      } else if (typeof err === 'string') {
        message = err;
      } else if (err && typeof err.name === 'string' && err.name) {
        message = err.name;
      } else {
        message = 'Connection failed';
      }
      var lower = message.toLowerCase();
      if (
        lower.indexOf('not been authorized') !== -1
        || lower.indexOf('not authorized') !== -1
        || lower.indexOf('unauthorized') !== -1
        || lower.indexOf('something went wrong') !== -1
      ) {
        if (walletName === 'Phantom') {
          return 'Phantom has not authorized Sui accounts for this site yet. Open Phantom app permissions for this site, allow Sui account access, then retry.';
        }
      }
      if (
        walletName === 'Passkey Wallet'
        && (
        lower.indexOf('unexpected') !== -1
        || lower.indexOf('notallowederror') !== -1
        || lower.indexOf('invalidstateerror') !== -1
        )
      ) {
        return 'Passkey setup failed. Use a supported browser profile with passkeys enabled and try again.';
      }
	      return message;
	    }

    var __wkSocialNoticeTimer = null;

    function __wkShowSocialNotice(containerEl, message) {
      var socialEl = containerEl;
      if (!socialEl || !socialEl.classList || !socialEl.classList.contains('wk-social-section')) {
        socialEl = __wkModalContainer ? __wkModalContainer.querySelector('.wk-social-section') : null;
      }
      if (!socialEl) return;
      var grid = socialEl.querySelector('.wk-social-grid');
      if (!grid) return;
      var notice = socialEl.querySelector('.wk-social-notice');
      if (!notice) {
        notice = document.createElement('div');
        notice.className = 'wk-social-notice';
        notice.setAttribute('role', 'status');
        socialEl.insertBefore(notice, grid);
      }
      notice.textContent = String(message || '').trim();
      notice.classList.remove('fade-out');
      if (__wkSocialNoticeTimer) {
        clearTimeout(__wkSocialNoticeTimer);
        __wkSocialNoticeTimer = null;
      }
      __wkSocialNoticeTimer = setTimeout(function() {
        notice.classList.add('fade-out');
        setTimeout(function() {
          if (notice && notice.parentNode) notice.parentNode.removeChild(notice);
        }, 280);
	      }, 3000);
	    }

	    function __wkShowConnectError(containerEl, err, walletName) {
      var message = __wkFormatConnectError(err, walletName);
      var lower = String(message || '').toLowerCase();
      var isUserRejection = (
        lower.indexOf('user rejected') !== -1
        || lower.indexOf('rejected the request') !== -1
        || lower.indexOf('request rejected') !== -1
        || lower.indexOf('denied the request') !== -1
      );
      if (walletName === 'WaaP') {
        try {
          if (__wkModalContainer) __wkRenderSocialSection(__wkModalContainer, SuiWalletKit.$wallets.value || []);
        } catch (_eRenderSocial) {}
        __wkShowSocialNotice(containerEl, isUserRejection ? 'User has denied the request..' : message);
        return;
      }

	      containerEl.innerHTML = '<div class="wk-detecting" style="color:#f87171;text-align:center;font-size:0.82rem;line-height:1.5;">'
	        + message
	        + '</div>';
	    }

    function __wkOriginSupportsWaaP() {
      try {
        if (typeof __wkCanUseWaaPOnThisOrigin === 'function') return __wkCanUseWaaPOnThisOrigin();
      } catch (_e) {}
      try {
        if (window.location.protocol === 'file:') return false;
        var origin = String(window.location.origin || '');
        return origin !== '' && origin !== 'null';
      } catch (_e2) {
        return false;
      }
    }

    function __wkShouldUseWaaPBridge() {
      try {
        if (__wkIsSubdomain()) return true;
      } catch (_eSubdomain) {}
      try {
        if (typeof window !== 'undefined' && window.__wkForceWaaPBridge === true) return true;
      } catch (_eFlag) {}
      return false;
    }

    function __wkGetWaaPLoadingPromise() {
      var loading = null;
      try {
        if (typeof __wkWaaPLoading !== 'undefined') loading = __wkWaaPLoading;
      } catch (_e) {}
      if (!loading) {
        try {
          if (typeof window !== 'undefined' && window.__wkWaaPLoading) {
            loading = window.__wkWaaPLoading;
          }
        } catch (_e2) {}
      }
      return loading || null;
    }

    function __wkEnsureWaaPLoadingPromise() {
      var loading = __wkGetWaaPLoadingPromise();
      if (loading) return loading;
      try {
        if (SuiWalletKit && typeof SuiWalletKit.initWaaP === 'function') {
          return Promise.resolve(SuiWalletKit.initWaaP());
        }
      } catch (_eInitPublic) {}
      try {
        if (typeof __wkInitWaaP === 'function') return __wkInitWaaP();
      } catch (_e) {}
      return Promise.reject(new Error('WaaP initialization entrypoint unavailable'));
    }

    function __wkFindWaaPWallet() {
      try {
        if (typeof __wkWaaPWallet !== 'undefined' && __wkWaaPWallet) return __wkWaaPWallet;
      } catch (_eVar) {}
      try {
        if (typeof window !== 'undefined' && window.__wkWaaPWallet) return window.__wkWaaPWallet;
      } catch (_e0) {}
      var sources = [SuiWalletKit.$wallets.value || []];
      try {
        var api = typeof getWallets === 'function' ? getWallets() : null;
        if (api) sources.push(api.get());
      } catch (e) {}
      for (var s = 0; s < sources.length; s++) {
        var list = sources[s];
        for (var i = 0; i < list.length; i++) {
          var name = list[i].name ? String(list[i].name).toLowerCase() : '';
          if (name === 'waap' || name.indexOf('waap') !== -1) return list[i];
        }
      }
      return null;
    }

	    function __wkConnectWaaPSocial(wallets, waapMethod) {
	      var requestedMethod = __wkNormalizeWaaPMethod(waapMethod);
	      __wkRememberPendingWaaPMethod(requestedMethod || waapMethod);
	      __wkSetRequiredWaaPMethod(requestedMethod);
	      var shouldResetForMethod = __wkShouldResetWaaPSessionForMethod(requestedMethod);
	      if (shouldResetForMethod) {
	        try { if (typeof disconnectWalletSession === 'function') disconnectWalletSession(); } catch (_eDisconnectSessionBefore) {}
	        try { SuiWalletKit.disconnect(); } catch (_eDisconnectWalletBefore) {}
	        // Disconnect clears pending/required method state; restore selection intent.
	        __wkRememberPendingWaaPMethod(requestedMethod || waapMethod);
	        __wkSetRequiredWaaPMethod(requestedMethod);
	      }
	      if (__wkShouldUseWaaPBridge()) {
	        __wkConnectWaaPViaBridge(requestedMethod || waapMethod, { forceReauth: !!requestedMethod });
	        return;
	      }
      if (!__wkOriginSupportsWaaP()) {
        var blockedSocialSection = __wkModalContainer && __wkModalContainer.querySelector('.wk-social-section');
        if (blockedSocialSection) {
          __wkShowConnectError(blockedSocialSection, { message: 'WaaP social login requires http(s) origin. Use http://localhost (not file://).' }, 'WaaP');
        }
        return;
      }
	      var waapWallet = __wkFindWaaPWallet();
	      if (!waapWallet) {
	        var socialSection = __wkModalContainer && __wkModalContainer.querySelector('.wk-social-section');
	        if (socialSection) {
	          socialSection.innerHTML = '<div class="wk-social-grid"><div class="wk-detecting"><div class="wk-spinner"></div> Loading WaaP...</div></div>'
	            + '<a class="wk-powered-pill" href="https://waap.sui.ski" target="_blank" rel="noopener"><img src="' + __wkWaaPIcon + '" alt="WaaP"> powered by WaaP</a>';
        }
        var waapLoading = __wkEnsureWaaPLoadingPromise();
        Promise.resolve(waapLoading).then(function() {
          if (!SuiWalletKit || typeof SuiWalletKit.detectWallets !== 'function') return [];
          return SuiWalletKit.detectWallets();
	        }).then(function() {
	          var loadedWallet = __wkFindWaaPWallet();
	          if (!loadedWallet) {
	            var initErr = null;
	            try {
	              if (typeof __wkWaaPInitError !== 'undefined' && __wkWaaPInitError) initErr = __wkWaaPInitError;
	            } catch (_eInitVar) {}
            if (!initErr) {
              try {
                if (typeof window !== 'undefined' && window.__wkWaaPInitError) initErr = window.__wkWaaPInitError;
              } catch (_eInitWindow) {}
            }
            var initMessage = (initErr && initErr.message) ? String(initErr.message) : '';
            throw new Error(initMessage ? ('WaaP wallet failed to initialize: ' + initMessage) : 'WaaP wallet is still loading, please try again');
          }
          __wkConnectWaaPSocial(SuiWalletKit.$wallets.value || wallets, waapMethod);
	        }).catch(function(err) {
          if (__wkShouldUseWaaPBridge()) {
            __wkConnectWaaPViaBridge(waapMethod);
            return;
          }
	          if (!__wkIsModalOpen()) return;
	          var section = __wkModalContainer && __wkModalContainer.querySelector('.wk-social-section');
	          if (section) {
	            __wkShowConnectError(section, err, 'WaaP');
	          }
        });
        return;
      }
	      SuiWalletKit.closeModal();
	      SuiWalletKit.connect(waapWallet).then(function() {
	        var conn = SuiWalletKit.$connection.value || null;
	        var requiredMethod = __wkRequiredWaaPMethod;
	        var connectedMethod = '';
	        if (conn && conn.account && typeof conn.account.label === 'string') {
	          connectedMethod = __wkMethodFromWaaPLabel(conn.account.label);
	        }
	        var connectedAddress = conn && conn.address ? conn.address : '';
	        var methodAllowed = __wkIsWaaPMethodAllowed(requiredMethod, connectedAddress, connectedMethod);
	        if (!methodAllowed) {
	          var conflictMethod = __wkFindWaaPMethodConflict(requiredMethod, connectedAddress, connectedMethod);
	          __wkPendingWaaPMethod = '';
	          __wkClearRequiredWaaPMethod();
	          try { if (typeof disconnectWalletSession === 'function') disconnectWalletSession(); } catch (_eDisconnectSession) {}
	          try { SuiWalletKit.disconnect(); } catch (_eDisconnectWallet) {}
	          SuiWalletKit.openModal();
	          setTimeout(function() {
	            var socialSection = __wkModalContainer && __wkModalContainer.querySelector('.wk-social-section');
	            if (socialSection) {
	              var expected = __wkWaaPMethodLabels[requiredMethod] || requiredMethod;
	              var got = __wkWaaPMethodLabels[conflictMethod] || conflictMethod;
	              __wkShowConnectError(socialSection, { message: 'Expected WaaP ' + expected + ' login, but resumed ' + got + '. Please retry ' + expected + '.' }, 'WaaP');
	            }
	          }, 100);
	          return;
	        }
	        if (conn && conn.address) {
	          // Only persist method mapping when we actually know what method connected.
	          if (connectedMethod) {
	            __wkSaveWaaPMethodForAddress(conn.address, connectedMethod);
	          }
	          if (conn.account && typeof conn.account.label === 'string' && conn.account.label.trim()) {
	            __wkSaveWaaPLabelForAddress(conn.address, conn.account.label.trim());
	          }
	        }
	        __wkPendingWaaPMethod = '';
	        __wkSetLastWallet('WaaP');
	        __wkClearRequiredWaaPMethod();
	      }).catch(function(err) {
	        __wkPendingWaaPMethod = '';
	        __wkClearRequiredWaaPMethod();
	        SuiWalletKit.openModal();
	        setTimeout(function() {
	          var socialSection = __wkModalContainer && __wkModalContainer.querySelector('.wk-social-section');
          if (socialSection) {
            __wkShowConnectError(socialSection, err, 'WaaP');
          }
        }, 100);
      });
    }

    function __wkConnectWaaPViaBridge(waapMethod, opts) {
	      var normalizedMethod = __wkNormalizeWaaPMethod(waapMethod);
	      __wkRememberPendingWaaPMethod(normalizedMethod || waapMethod);
      var forceReauth = !!(opts && opts.forceReauth);
	      SuiWalletKit.closeModal();
      var bridge = SuiWalletKit.__skiSignFrame;
      var bridgeReady = SuiWalletKit.__skiSignReady;
      if (!bridge) {
        SuiWalletKit.__initSignBridge();
        bridge = SuiWalletKit.__skiSignFrame;
        bridgeReady = SuiWalletKit.__skiSignReady;
      }
      var requestId = 'waap-' + Date.now();
      (bridgeReady || Promise.resolve(true)).then(function(ready) {
	        if (!ready || !bridge || !bridge.contentWindow) {
	          SuiWalletKit.openModal();
	          return;
	        }
		        bridge.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:13001;border:none;background:transparent;';
        function sendConnectRequest() {
	          bridge.contentWindow.postMessage({
	            type: 'ski:connect-waap',
	            requestId: requestId,
              method: normalizedMethod || '',
              waapMethod: normalizedMethod || '',
              preferredMethod: normalizedMethod || '',
              forceReauth: forceReauth
	          }, 'https://sui.ski');
        }
        if (forceReauth) {
          try {
            bridge.contentWindow.postMessage({ type: 'ski:disconnect' }, 'https://sui.ski');
          } catch (_bridgeDisconnectError) {}
          setTimeout(sendConnectRequest, 80);
        } else {
          sendConnectRequest();
        }
	        var timeout = setTimeout(function() {
	          cleanup();
	          bridge.style.cssText = __wkBridgeHiddenStyle;
	          __wkPendingWaaPMethod = '';
	          __wkClearRequiredWaaPMethod();
	          SuiWalletKit.openModal();
	        }, 15000);
        function cleanup() {
          clearTimeout(timeout);
          window.removeEventListener('message', handleResponse);
        }
	        function handleResponse(ev) {
	          if (ev.origin !== 'https://sui.ski') return;
	          if (!ev.data || ev.data.requestId !== requestId) return;
	          if (ev.data.type === 'ski:connected') {
	            cleanup();
	            bridge.style.cssText = __wkBridgeHiddenStyle;
	            var requiredMethod = __wkRequiredWaaPMethod;
	            var bridgeMethod = __wkNormalizeWaaPMethod(
	              (ev.data && (ev.data.method || ev.data.waapMethod || ev.data.preferredMethod || ev.data.provider || ev.data.loginMethod)) || ''
	            );
	            var bridgeConflictMethod = __wkFindWaaPMethodConflict(requiredMethod, ev.data && ev.data.address ? ev.data.address : '', bridgeMethod);
	            if (bridgeConflictMethod) {
	              __wkPendingWaaPMethod = '';
	              __wkClearRequiredWaaPMethod();
	              SuiWalletKit.openModal();
	              setTimeout(function() {
	                var socialSection = __wkModalContainer && __wkModalContainer.querySelector('.wk-social-section');
	                if (socialSection) {
	                  var expected = __wkWaaPMethodLabels[requiredMethod] || requiredMethod;
	                  var got = __wkWaaPMethodLabels[bridgeConflictMethod] || bridgeConflictMethod;
	                  __wkShowConnectError(socialSection, { message: 'Expected WaaP ' + expected + ' login, but resumed ' + got + '. Please retry ' + expected + '.' }, 'WaaP');
	                }
	              }, 100);
	              return;
	            }
	            SuiWalletKit.initFromSession(ev.data.address, 'WaaP');
	            if (bridgeMethod) {
	              __wkSaveWaaPMethodForAddress(ev.data.address, bridgeMethod);
	            }
	            __wkPendingWaaPMethod = '';
	            __wkSetLastWallet('WaaP');
	            if (typeof connectWalletSession === 'function') {
	              connectWalletSession('WaaP', ev.data.address);
	            }
	            __wkClearRequiredWaaPMethod();
	          } else if (ev.data.type === 'ski:connect-error') {
	            __wkPendingWaaPMethod = '';
	            __wkClearRequiredWaaPMethod();
	            cleanup();
	            bridge.style.cssText = __wkBridgeHiddenStyle;
	            SuiWalletKit.openModal();
            setTimeout(function() {
              var socialSection = __wkModalContainer && __wkModalContainer.querySelector('.wk-social-section');
              if (socialSection) {
                __wkShowConnectError(socialSection, { message: ev.data.error }, 'WaaP');
              }
            }, 100);
          }
        }
        window.addEventListener('message', handleResponse);
      });
    }

    function __wkRenderSocialSection(container, wallets) {
      var dividerEl = container.querySelector('.wk-divider');
      var socialEl = __wkEnsureSocialSectionStructure(container);
      if (!socialEl) return;

      socialEl.style.display = '';
      if (dividerEl) dividerEl.style.display = '';

      var grid = socialEl.querySelector('.wk-social-grid');
      if (!grid) return;

      var socialOptions = [
        { key: 'x', label: 'X', sep: false },
        { key: 'google', label: 'Google', sep: false },
        { key: 'email', label: 'Email', sep: true },
        { key: 'discord', label: 'Discord', sep: false },
        { key: 'coinbase', label: 'Coinbase', sep: false },
        { key: 'phone', label: 'Phone', sep: true }
      ];

	      grid.innerHTML = '';
	      for (var s = 0; s < socialOptions.length; s++) {
	        (function(opt) {
	          var btn = document.createElement('button');
	          btn.className = 'wk-social-btn' + (opt.sep ? ' wk-sep-left' : '');
	          btn.innerHTML = (__wkSocialIcons[opt.key] || '') + '<span>' + opt.label + '</span>';
	          btn.addEventListener('click', function() {
	            __wkConnectWaaPSocial(SuiWalletKit.$wallets.value || wallets, opt.key);
	          });
	          grid.appendChild(btn);
	        })(socialOptions[s]);
	      }
	    }

	    function __wkSortWithRecent(wallets) {
	      var lastWalletName = __wkWalletNameKey(__wkGetLastWallet());
	      if (!lastWalletName) return wallets;
      var recent = [];
      var rest = [];
      for (var i = 0; i < wallets.length; i++) {
        var wName = __wkWalletNameKey(wallets[i].name);
        if (wName === lastWalletName) {
          recent.push(wallets[i]);
        } else {
          rest.push(wallets[i]);
        }
      }
	      return recent.concat(rest);
	    }

	    var __wkKnownWalletRows = [
	      {
	        key: 'phantom',
	        name: 'Phantom',
	        installUrl: 'https://phantom.app/download',
	        icon: __wkAssetUrl('wallet-phantom.svg'),
	      },
	      {
	        key: 'backpack',
	        name: 'Backpack',
	        installUrl: 'https://backpack.app',
	        icon: __wkAssetUrl('wallet-backpack.svg'),
	      },
	      {
	        key: 'slush',
	        name: 'Slush',
	        installUrl: 'https://slush.app',
	        icon: __wkAssetUrl('wallet-slush.svg'),
	      },
	      {
	        key: 'slushwallet',
	        name: 'Slush Wallet',
	        installUrl: 'https://slush.app',
	        icon: __wkAssetUrl('wallet-slush.svg'),
	      },
	      {
	        key: 'suiet',
	        name: 'Suiet',
	        installUrl: 'https://suiet.app',
	        icon: __wkAssetUrl('wallet-suiet.svg'),
	      },
	    ];

	    function __wkKnownWalletIconByName(name) {
	      var key = __wkWalletNameKey(name);
	      if (!key) return '';
	      for (var i = 0; i < __wkKnownWalletRows.length; i++) {
	        if (__wkKnownWalletRows[i].key === key) return __wkKnownWalletRows[i].icon;
	      }
	      return '';
	    }

	    function __wkFindDetectedWalletByKey(targetKey) {
	      if (!targetKey) return null;
	      var sources = [
	        SuiWalletKit.$wallets.value || [],
	        __wkReadDetectedWalletCache(__wkDetectedWalletCacheKey),
	        __wkReadDetectedWalletCache(__wkBridgeDetectedWalletCacheKey),
	        __wkGetBridgeWalletSnapshot(),
	      ];
	      var best = null;
	      for (var s = 0; s < sources.length; s++) {
	        var list = Array.isArray(sources[s]) ? sources[s] : [];
	        for (var i = 0; i < list.length; i++) {
	          var wallet = list[i];
	          if (!wallet || !wallet.name) continue;
	          var key = __wkWalletNameKey(wallet.name);
	          if (!key || !__wkWalletKeysRelated(key, targetKey)) continue;
	          var candidate = {
	            name: String(wallet.name),
	            icon: wallet.icon ? String(wallet.icon) : '',
	          };
	          if (key === targetKey && candidate.icon) return candidate;
	          if (!best || (!best.icon && candidate.icon) || (key === targetKey && !best.keyExact)) {
	            best = {
	              name: candidate.name,
	              icon: candidate.icon,
	              keyExact: key === targetKey,
	            };
	          }
	        }
	      }
	      if (!best) return null;
	      return {
	        name: best.name,
	        icon: best.icon,
	      };
	    }

	    function __wkResolveWidgetWallet(conn) {
	      var walletName = __wkGetConnectionWalletName(conn);
	      var walletIcon = conn && conn.wallet && conn.wallet.icon ? String(conn.wallet.icon) : '';
	      var walletKey = __wkWalletNameKey(walletName);
	      if (walletKey) {
	        var matched = __wkFindDetectedWalletByKey(walletKey);
	        if (matched) {
	          if (!walletName && matched.name) walletName = matched.name;
	          if (!walletIcon && matched.icon) walletIcon = matched.icon;
	        }
	      } else {
	        var remembered = __wkGetLastWallet();
	        var rememberedKey = __wkWalletNameKey(remembered);
	        if (rememberedKey) {
	          var rememberedMatch = __wkFindDetectedWalletByKey(rememberedKey);
	          if (rememberedMatch) {
	            walletName = rememberedMatch.name || remembered;
	            if (!walletIcon && rememberedMatch.icon) walletIcon = rememberedMatch.icon;
	          } else {
	            walletName = remembered;
	          }
	        }
	      }
	      if (!walletIcon && walletName) {
	        walletIcon = __wkKnownWalletIconByName(walletName);
	      }
	      return {
	        name: walletName,
	        icon: walletIcon,
	      };
	    }

	    function __wkResolveWalletIcon(wallet) {
	      var name = wallet && wallet.name ? String(wallet.name) : '';
	      var knownIcon = __wkKnownWalletIconByName(name);
	      var walletIcon = wallet && wallet.icon ? String(wallet.icon) : '';
	      return walletIcon || knownIcon || __wkDefaultIcon();
	    }

	    function __wkBuildWalletDisplayList(wallets) {
	      var input = Array.isArray(wallets) ? wallets : [];
	      var byKey = {};
	      var order = [];
	      for (var i = 0; i < input.length; i++) {
	        var wallet = input[i];
	        if (!wallet || !wallet.name) continue;
	        var key = __wkWalletNameKey(wallet.name);
	        if (!key) key = 'wallet-' + i;
	        var existing = byKey[key];
	        if (!existing) {
	          byKey[key] = wallet;
	          order.push(key);
	          continue;
	        }
	        if ((!existing.icon || String(existing.icon).trim() === '') && wallet.icon) {
	          existing.icon = wallet.icon;
	        }
	      }
	      var rows = [];
	      for (var o = 0; o < order.length; o++) {
	        if (byKey[order[o]]) rows.push(byKey[order[o]]);
	      }
	      return rows;
	    }

	    function __wkCombineWalletSources(localWallets, bridgeWallets) {
	      var local = Array.isArray(localWallets) ? localWallets : [];
	      var bridge = Array.isArray(bridgeWallets) ? bridgeWallets : [];
	      if (local.length === 0) return __wkBuildWalletDisplayList(bridge);
	      if (bridge.length === 0) return __wkBuildWalletDisplayList(local);
	      return __wkBuildWalletDisplayList(local.concat(bridge));
	    }

	    function __wkRememberDetectedWallets(wallets, bridgeOnly) {
	      var current = Array.isArray(wallets) ? wallets : [];
	      if (current.length === 0) return;
	      var cacheKey = bridgeOnly ? __wkBridgeDetectedWalletCacheKey : __wkDetectedWalletCacheKey;
	      var cached = __wkReadDetectedWalletCache(cacheKey);
	      var merged = __wkCombineWalletSources(current, cached);
	      __wkWriteDetectedWalletCache(merged, cacheKey);
	    }

	    function __wkCollectBridgeWalletHints(walletsInput) {
	      var out = [];
	      var byKey = {};
	      var sources = [];
	      if (Array.isArray(walletsInput)) sources.push(walletsInput);
	      sources.push(SuiWalletKit.$wallets.value || []);
	      sources.push(__wkReadDetectedWalletCache(__wkDetectedWalletCacheKey));
	      for (var s = 0; s < sources.length; s++) {
	        var list = Array.isArray(sources[s]) ? sources[s] : [];
	        for (var i = 0; i < list.length; i++) {
	          var wallet = list[i];
	          if (!wallet || !wallet.name) continue;
	          var name = String(wallet.name);
	          var key = __wkWalletNameKey(name);
	          if (!key) key = 'wallet-' + s + '-' + i;
	          var icon = wallet.icon ? String(wallet.icon) : '';
	          if (!icon) icon = __wkKnownWalletIconByName(name);
	          var existing = byKey[key];
	          if (!existing) {
	            existing = {
	              name: name,
	              icon: icon,
	              __isPasskey: !!wallet.__isPasskey,
	            };
	            byKey[key] = existing;
	            out.push(existing);
	            continue;
	          }
	          if (!existing.icon && icon) existing.icon = icon;
	          if (existing.__isPasskey && !wallet.__isPasskey) existing.__isPasskey = false;
	        }
	      }
	      return out;
	    }

	    function __wkBridgeWalletHintSignature(wallets) {
	      var list = Array.isArray(wallets) ? wallets : [];
	      var parts = [];
	      for (var i = 0; i < list.length; i++) {
	        var wallet = list[i];
	        if (!wallet || !wallet.name) continue;
	        parts.push(
	          __wkWalletNameKey(wallet.name)
	          + '|' + String(wallet.icon || '')
	          + '|' + (wallet.__isPasskey ? '1' : '0')
	        );
	      }
	      return parts.join(',');
	    }

	    function __wkSendBridgeWalletHints(walletsInput, force) {
	      if (!__wkIsSubdomain()) return [];
	      var hints = __wkCollectBridgeWalletHints(walletsInput);
	      if (hints.length === 0) return [];
	      var signature = __wkBridgeWalletHintSignature(hints);
	      if (!force && signature && signature === __wkLastBridgeHintSignature) return hints;
	      var bridge = SuiWalletKit.__skiSignFrame;
	      var bridgeReady = SuiWalletKit.__skiSignReady;
	      if (!bridge) {
	        SuiWalletKit.__initSignBridge();
	        bridge = SuiWalletKit.__skiSignFrame;
	        bridgeReady = SuiWalletKit.__skiSignReady;
	      }
	      (bridgeReady || Promise.resolve(true)).then(function(ready) {
	        if (!ready || !bridge || !bridge.contentWindow) return;
	        __wkLastBridgeHintSignature = signature;
	        bridge.contentWindow.postMessage({
	          type: 'ski:wallet-hints',
	          wallets: hints,
	        }, 'https://sui.ski');
	      }).catch(function() {});
	      return hints;
	    }

	    function __wkFetchWalletsViaBridge() {
      var bridge = SuiWalletKit.__skiSignFrame;
      var bridgeReady = SuiWalletKit.__skiSignReady;
      if (!bridge) {
        SuiWalletKit.__initSignBridge();
        bridge = SuiWalletKit.__skiSignFrame;
        bridgeReady = SuiWalletKit.__skiSignReady;
      }
      var walletHints = __wkSendBridgeWalletHints();
      var requestId = 'wallets-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      return new Promise(function(resolve, reject) {
        (bridgeReady || Promise.resolve(true)).then(function(ready) {
          if (!ready || !bridge || !bridge.contentWindow) {
            reject(new Error('Bridge not available'));
            return;
          }
          var timeout = setTimeout(function() {
            cleanup();
            reject(new Error('Wallet discovery timed out'));
          }, 12000);
          function cleanup() {
            clearTimeout(timeout);
            window.removeEventListener('message', handleResponse);
          }
          function handleResponse(ev) {
            if (ev.origin !== 'https://sui.ski') return;
            if (!ev.data || ev.data.requestId !== requestId) return;
            if (ev.data.type === 'ski:wallets-result') {
              cleanup();
              resolve(Array.isArray(ev.data.wallets) ? ev.data.wallets : []);
            } else if (ev.data.type === 'ski:wallets-error') {
              cleanup();
              reject(new Error(ev.data.error || 'Wallet discovery failed'));
            }
          }
          window.addEventListener('message', handleResponse);
          bridge.contentWindow.postMessage({
            type: 'ski:wallets',
            requestId: requestId,
            walletHints: walletHints,
          }, 'https://sui.ski');
        }).catch(reject);
      });
    }

    function __wkRenderWalletItems(listEl, wallets) {
      if (!wallets || wallets.length === 0) {
        try {
          listEl.classList.add('wk-wallet-list-no-scroll');
          listEl.classList.remove('wk-wallet-list-scroll');
        } catch (_e) {}
        listEl.innerHTML = __wkInstallLinksHtml();
        return;
      }
      var lastWalletName = __wkWalletNameKey(__wkGetLastWallet());
      var sorted = __wkBuildWalletDisplayList(__wkSortWithRecent(wallets));
      var shouldScrollWallets = sorted.length >= 5;
      try {
        listEl.classList.toggle('wk-wallet-list-no-scroll', !shouldScrollWallets);
        listEl.classList.toggle('wk-wallet-list-scroll', shouldScrollWallets);
      } catch (_e) {}
      var isSubdomain = __wkIsSubdomain();
      listEl.innerHTML = '';
      for (var i = 0; i < sorted.length; i++) {
        (function(wallet) {
          var item = document.createElement('button');
          item.className = 'wk-wallet-item';
          var name = wallet.name || 'Unknown';
          var iconSrc = __wkResolveWalletIcon(wallet);
          var fallbackIcon = __wkKnownWalletIconByName(name) || __wkDefaultIcon();
          var isRecent = lastWalletName && __wkWalletNameKey(name) === lastWalletName;
	          item.innerHTML = '<img alt="">'
	            + '<span class="wk-wallet-name">' + name + '</span>'
	            + (isRecent ? '<span class="wk-recent-badge">Recent</span>' : '');
	          var iconEl = item.querySelector('img');
	          if (iconEl) {
	            iconEl.src = iconSrc;
	            iconEl.addEventListener('error', function() {
	              if (iconEl.getAttribute('data-fallback') === '1') {
	                iconEl.style.display = 'none';
	                return;
	              }
	              iconEl.setAttribute('data-fallback', '1');
	              iconEl.src = fallbackIcon;
	            });
	          }
				          item.addEventListener('click', function() {
				            listEl.innerHTML = '<div class="wk-detecting"><div class="wk-spinner"></div> Connecting...</div>';
				            var targetKey = __wkWalletNameKey(name);
				            var isSlushFamily = __wkWalletKeysRelated(targetKey, 'slush');
				            var connectWithTarget = function(targetWallet) {
				              SuiWalletKit.connect(targetWallet).then(function() {
				                __wkSetLastWallet(name);
				              }).catch(function(err) {
				                __wkShowConnectError(listEl, err, name);
				              });
				            };
				            var pickTargetFromCurrentWallets = function() {
				              var target = wallet;
				              var currentWallets = SuiWalletKit.$wallets.value || [];
				              for (var cw = 0; cw < currentWallets.length; cw++) {
				                var cwKey = __wkWalletNameKey(currentWallets[cw].name);
				                if (cwKey && targetKey && __wkWalletKeysRelated(cwKey, targetKey)) {
				                  target = currentWallets[cw];
				                  break;
				                }
				              }
				              return target;
				            };
				            if (!isSlushFamily) {
				              connectWithTarget(pickTargetFromCurrentWallets());
				              return;
				            }
				            Promise.resolve().then(function() {
				              return typeof SuiWalletKit.detectWallets === 'function'
				                ? SuiWalletKit.detectWallets().catch(function() { return []; })
				                : [];
				            }).then(function() {
				              var localTarget = pickTargetFromCurrentWallets();
				              var localTargetKey = __wkWalletNameKey(localTarget && localTarget.name ? localTarget.name : '');
				              if (localTargetKey && __wkWalletKeysRelated(localTargetKey, 'slush')) {
				                connectWithTarget(localTarget);
				                return;
				              }
                              var provider = (window.slush && (window.slush.sui || window.slush.wallet || window.slush))
                                || null;
				              if (!provider || typeof provider !== 'object') {
				                throw new Error('Slush extension not detected in this page context');
				              }
				              var source = provider.sui && typeof provider.sui === 'object' ? provider.sui : provider;
				              var connectFeature = source.features && source.features['standard:connect']
				                ? source.features['standard:connect']
				                : (typeof source.connect === 'function'
				                    ? { connect: source.connect.bind(source) }
				                    : (typeof source.requestAccounts === 'function'
				                        ? { connect: source.requestAccounts.bind(source) }
				                        : (typeof source.requestAccount === 'function'
				                            ? { connect: source.requestAccount.bind(source) }
				                            : undefined)));
				              if (!connectFeature) {
				                throw new Error('Slush extension detected but no connect method is available');
				              }
				              connectWithTarget({
				                name: name,
				                icon: source.icon || iconSrc || fallbackIcon,
				                chains: ['sui:mainnet', 'sui:testnet', 'sui:devnet'],
				                features: {
				                  'standard:connect': connectFeature,
				                  'standard:disconnect': typeof source.disconnect === 'function'
				                    ? { disconnect: source.disconnect.bind(source) }
				                    : undefined,
				                  'sui:signAndExecuteTransaction': typeof source.signAndExecuteTransaction === 'function'
				                    ? { signAndExecuteTransaction: source.signAndExecuteTransaction.bind(source) }
				                    : undefined,
				                  'sui:signAndExecuteTransactionBlock': typeof source.signAndExecuteTransactionBlock === 'function'
				                    ? { signAndExecuteTransactionBlock: source.signAndExecuteTransactionBlock.bind(source) }
				                    : undefined,
				                  'sui:signTransaction': typeof source.signTransaction === 'function'
				                    ? { signTransaction: source.signTransaction.bind(source) }
				                    : undefined,
				                  'sui:signPersonalMessage': typeof source.signPersonalMessage === 'function'
				                    ? { signPersonalMessage: source.signPersonalMessage.bind(source) }
				                    : undefined,
				                },
				                get accounts() {
				                  return Array.isArray(source.accounts) ? source.accounts : [];
				                },
				                _raw: source,
				              });
				            }).catch(function(err) {
				              __wkShowConnectError(listEl, err, name);
				            });
				          });
			          listEl.appendChild(item);
			        })(sorted[i]);
			      }
	    }

	    function __wkRenderSplit(wallets, options) {
	      if (!__wkModalContainer) return;
	      var listEl = __wkModalContainer.querySelector('.wk-wallet-list');
	      if (!listEl) return;
	      var bridgeOnly = !!(options && options.bridgeOnly);
	      if (Array.isArray(wallets) && wallets.length > 0) {
	        __wkRememberDetectedWallets(wallets, bridgeOnly);
	      }

      var nonWaaPWallets = [];
      for (var i = 0; i < wallets.length; i++) {
        var name = wallets[i].name ? String(wallets[i].name).toLowerCase() : '';
        if (name.indexOf('waap') === -1) {
          nonWaaPWallets.push(wallets[i]);
        }
      }

	      __wkRenderSocialSection(__wkModalContainer, wallets);
	      __wkRenderWalletItems(listEl, nonWaaPWallets);
	    }

	    function __wkIsModalOpen() {
	      if (!__wkModalContainer) return false;
	      var overlayEl = __wkModalContainer.querySelector('.wk-modal-overlay');
	      return !!(overlayEl && overlayEl.classList.contains('open'));
	    }

	    function __wkPopulateModal() {
	      if (!__wkModalContainer) return;
	      var listEl = __wkModalContainer.querySelector('.wk-wallet-list');
      if (!listEl) return;
      listEl.innerHTML = '<div class="wk-detecting"><div class="wk-spinner"></div> Detecting wallets...</div>';
      var isSubdomain = __wkIsSubdomain();
      var immediate = SuiWalletKit.$wallets.value;
      if (isSubdomain) {
        __wkSendBridgeWalletHints(Array.isArray(immediate) ? immediate : [], true);
      }
	      var cached = isSubdomain
	        ? __wkReadDetectedWalletCache(__wkBridgeDetectedWalletCacheKey)
	        : __wkReadDetectedWalletCache();
	      var warmWallets = isSubdomain
	        ? __wkBuildWalletDisplayList(cached)
	        : __wkCombineWalletSources(Array.isArray(immediate) ? immediate : [], cached);
	      __wkRenderSocialSection(__wkModalContainer, Array.isArray(immediate) ? immediate : []);
      if (isSubdomain && typeof SuiWalletKit.__initSignBridge === 'function') {
        try { SuiWalletKit.__initSignBridge(); } catch (_e) {}
      }
      if (isSubdomain && typeof SuiWalletKit.detectWallets === 'function') {
        SuiWalletKit.detectWallets().then(function(localWallets) {
          var hints = __wkSendBridgeWalletHints(localWallets, true);
          if (!__wkIsModalOpen()) return;
          if (hints.length > 0) {
            var hintMerged = __wkMergeBridgeWallets(hints);
            var hintAvailable = __wkBuildWalletDisplayList(hintMerged);
            if (hintAvailable.length > 0) {
              __wkRenderSplit(hintAvailable, { bridgeOnly: true });
            }
          }
        }).catch(function() {});
      }

	      if (warmWallets.length > 0 && !isSubdomain) {
	        __wkRenderSplit(warmWallets);
	      }
	      if (isSubdomain) {
	        __wkResetBridgeWalletCache();
	        var bridgeAttempts = 0;
	        function __wkPollBridge(initialAttempt) {
	          if (!__wkIsModalOpen()) return;
	          __wkFetchWalletsViaBridge().then(function(wallets) {
	            if (!__wkIsModalOpen()) return;
	            var merged = __wkMergeBridgeWallets(wallets);
	            var available = __wkBuildWalletDisplayList(merged);
	            if (available.length > 0) {
	              __wkRenderSplit(available, { bridgeOnly: true });
	            } else if (initialAttempt) {
	              listEl.innerHTML = __wkInstallLinksHtml();
	            }
	          }).catch(function() {
	            if (!__wkIsModalOpen()) return;
	            var snapshot = __wkGetBridgeWalletSnapshot();
	            var available = __wkBuildWalletDisplayList(snapshot);
	            if (available.length > 0) {
	              __wkRenderSplit(available, { bridgeOnly: true });
	            } else if (initialAttempt) {
	              listEl.innerHTML = __wkInstallLinksHtml();
	            }
	          }).finally(function() {
	            bridgeAttempts++;
	            if (bridgeAttempts < 6 && __wkIsModalOpen()) {
	              setTimeout(function() {
	                __wkPollBridge(false);
	              }, 500);
	            }
	          });
	        }
	        __wkPollBridge(true);
	        return;
	      }
	      SuiWalletKit.detectWallets().then(function(wallets) {
        if (wallets && wallets.length > 0) {
          __wkRenderSplit(wallets);
        } else if (warmWallets.length === 0) {
          listEl.innerHTML = __wkInstallLinksHtml();
        }
	      }).catch(function() {
	        if (warmWallets.length === 0) {
	          listEl.innerHTML = __wkInstallLinksHtml();
	        }
	      });
	    }

      var __wkWaaPPrefetchInFlight = null;
      function __wkPrefetchWaaPForModal() {
        if (__wkWaaPPrefetchInFlight) return;
        if (__wkIsSubdomain()) return;
        if (!__wkOriginSupportsWaaP()) return;
        if (__wkFindWaaPWallet()) return;
        var loading = __wkEnsureWaaPLoadingPromise();
        if (!loading) return;
        __wkWaaPPrefetchInFlight = Promise.resolve(loading).then(function() {
          if (!SuiWalletKit || typeof SuiWalletKit.detectWallets !== 'function') return [];
          return SuiWalletKit.detectWallets();
        }).then(function(wallets) {
          if (!__wkIsModalOpen()) return;
          if (wallets && wallets.length > 0) {
            __wkRenderSplit(wallets);
          } else {
            __wkPopulateModal();
          }
        }).catch(function() {
          if (__wkIsModalOpen()) __wkPopulateModal();
        }).finally(function() {
          __wkWaaPPrefetchInFlight = null;
        });
      }

    SuiWalletKit.renderModal = function renderModal(containerId) {
      var container = document.getElementById(containerId);
      if (!container) throw new Error('Modal container not found: ' + containerId);
      __wkModalContainer = container;

      var __wkQrUrl = 'https://waap.sui.ski?ref=ski-keyin&src=wallet-modal';
      container.innerHTML = '<div class="wk-modal-overlay" id="__wk-overlay">'
        + '<div class="wk-modal-wrap">'
        + '<div class="wk-modal">'
        + '<div class="wk-snow-layer"></div>'
        + '<div class="wk-modal-header">'
        + '<div class="wk-modal-header-left">'
        + '<div class="wk-modal-brand-row">'
        + '<span class="wk-modal-logo">' + __wkLogoSvg + '</span>'
        + '<div class="wk-modal-title-wrap">'
        + '<h3>.Sui Key-In</h3>'
        + '<div class="wk-modal-subtitle"><span>once,</span><span>everywhere</span></div>'
        + '</div>'
        + '</div>'
        + '</div>'
        + '<button class="wk-modal-close" id="__wk-close">\u00D7</button>'
        + '</div>'
        + '<div class="wk-social-section" style="display:none">'
        + '<div class="wk-social-grid"></div>'
        + '<a class="wk-powered-pill" href="https://waap.sui.ski" target="_blank" rel="noopener"><img src="' + __wkWaaPIcon + '" alt="WaaP"> powered by WaaP</a>'
        + '</div>'
        + '<div class="wk-modal-main">'
        + '<div class="wk-waap-column">'
        + '<a class="wk-qr-link" href="' + __wkQrUrl + '" target="_blank" rel="noopener">'
        + __wkQrSvg
        + '<div class="wk-qr-center-logo"><img src="' + __wkWaaPIcon + '" alt="WaaP"></div>'
        + '</a>'
        + '<button class="wk-qr-copy" id="__wk-qr-copy" title="Copy WaaP link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>'
        + '</div>'
        + '<div class="wk-trad-column">'
        + '<div class="wk-divider" style="display:none"><span>Trad Wallet</span></div>'
        + '<div class="wk-wallet-list"></div>'
        + '</div>'
        + '</div>'
        + '</div>'
        + '</div>'
        + '</div>';

      var overlay = document.getElementById('__wk-overlay');
      var closeBtn = document.getElementById('__wk-close');

      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) SuiWalletKit.closeModal();
      });
      closeBtn.addEventListener('click', function() {
        SuiWalletKit.closeModal();
      });
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && document.body.classList.contains('wk-modal-open')) {
          SuiWalletKit.closeModal();
        }
      });

      var __wkCopyIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      var __wkCheckIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      function __wkBindCopy(btn) {
        if (!btn) return;
        btn.addEventListener('click', function() {
          navigator.clipboard.writeText(__wkQrUrl).then(function() {
            btn.innerHTML = __wkCheckIcon;
            btn.style.color = '#4ade80';
            setTimeout(function() { btn.innerHTML = __wkCopyIcon; btn.style.color = ''; }, 1500);
          }).catch(function() {});
        });
      }
	      __wkBindCopy(document.getElementById('__wk-qr-copy'));

	      if (__wkModalUnsub) __wkModalUnsub();
	      __wkModalUnsub = SuiWalletKit.subscribe(SuiWalletKit.$connection, function(conn) {
	        var shouldCloseForConnected = false;
	        if (conn && conn.status === 'connected') {
	          shouldCloseForConnected = true;
	        } else if (conn && conn.status === 'session') {
	          var sessionWalletName = '';
	          try { sessionWalletName = __wkGetConnectionWalletName(conn).trim().toLowerCase(); } catch (_e) {}
	          if (__wkPendingWaaPMethod || sessionWalletName.indexOf('waap') !== -1) {
	            shouldCloseForConnected = true;
	          }
	        }
	        if (shouldCloseForConnected) {
	          SuiWalletKit.closeModal();
	          if (typeof window['onWalletConnected'] === 'function') window['onWalletConnected']();
	        }
        if (conn && conn.status === 'disconnected') {
          if (typeof window['onWalletDisconnected'] === 'function') window['onWalletDisconnected']();
        }
      });
	      if (__wkModalWalletsUnsub) __wkModalWalletsUnsub();
		      __wkModalWalletsUnsub = SuiWalletKit.subscribe(SuiWalletKit.$wallets, function(wallets) {
		        if (!__wkModalContainer) return;
		        if (!__wkIsModalOpen()) return;
		        var connState = SuiWalletKit.$connection.value;
		        if (connState && connState.status === 'connecting') return;
		        if (__wkIsSubdomain()) {
		          __wkSendBridgeWalletHints(Array.isArray(wallets) ? wallets : [], true);
		          __wkFetchWalletsViaBridge().then(function(remoteWallets) {
		            if (!__wkIsModalOpen()) return;
		            var merged = __wkMergeBridgeWallets(remoteWallets);
		            var available = __wkBuildWalletDisplayList(merged);
		            if (available.length > 0) {
		              __wkRenderSplit(available, { bridgeOnly: true });
		              return;
		            }
		            var snapshot = __wkGetBridgeWalletSnapshot();
		            if (snapshot.length > 0) {
		              __wkRenderSplit(__wkBuildWalletDisplayList(snapshot), { bridgeOnly: true });
		            }
		          }).catch(function() {
		            if (!__wkIsModalOpen()) return;
		            var snapshot = __wkGetBridgeWalletSnapshot();
		            if (snapshot.length > 0) {
		              __wkRenderSplit(__wkBuildWalletDisplayList(snapshot), { bridgeOnly: true });
		            }
		          });
		          return;
		        }
	        __wkRenderSplit(Array.isArray(wallets) ? wallets : []);
	      });
	    };

	    function __wkIsSubdomain() {
	      var host = window.location.hostname;
	      return host !== 'sui.ski' && host.endsWith('.sui.ski');
	    }

	    SuiWalletKit.openModal = function openModal() {
	      if (!__wkModalContainer) return;
	      var overlay = __wkModalContainer.querySelector('.wk-modal-overlay');
	      if (overlay) {
	        overlay.classList.add('open');
	        try { document.body.classList.add('wk-modal-open'); } catch (_e) {}
	        try { document.documentElement.classList.add('wk-modal-open'); } catch (_e) {}
          __wkPrefetchWaaPForModal();
	        __wkPopulateModal();
	      }
	    };

	    SuiWalletKit.closeModal = function closeModal() {
	      if (!__wkModalContainer) return;
	      var overlay = __wkModalContainer.querySelector('.wk-modal-overlay');
	      if (overlay) overlay.classList.remove('open');
	      try { document.body.classList.remove('wk-modal-open'); } catch (_e) {}
	      try { document.documentElement.classList.remove('wk-modal-open'); } catch (_e) {}
	    };

		    function __wkBuildDropdownHtml(conn) {
	      var rawAddr = conn && conn.address ? conn.address : '';
	      var normalizedAddr = __wkNormalizeSuiAddress(rawAddr);
	      var addr = normalizedAddr || rawAddr;
	      var primaryName = true ? (conn && conn.primaryName ? conn.primaryName : null) : null;
	      var connectionHint = __wkGetWaaPConnectionHint(conn);
	      var html = '';

      if (addr) {
        html += '<div style="padding:6px 10px 6px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:4px;cursor:pointer;" id="__wk-dd-addr-display" title="Click to copy full address">';
        html += '<div style="font-size:0.65rem;color:#e2e8f0;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px">Your Address</div>';
        html += '<div style="font-size:0.68rem;color:#94a3b8;word-break:break-all;line-height:1.35;font-family:SF Mono,Fira Code,monospace">' + __wkEscapeHtml(addr) + '</div>';
	        if (connectionHint) {
	          html += '<div style="font-size:0.62rem;margin-top:4px;color:#cbd5e1;">' + __wkEscapeHtml(connectionHint) + '</div>';
	        }
	        html += '</div>';
	      }

      if (__wkPortfolioData && __wkPortfolioData.holdings && __wkPortfolioData.holdings.length > 0) {
        var l1Holdings = __wkGetL1Holdings(__wkPortfolioData);
        if (l1Holdings.length > 0) {
          html += '<div style="padding:4px 4px 2px;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:4px;">';
          for (var l = 0; l < l1Holdings.length; l++) {
            var l1 = l1Holdings[l];
            var l1BalFmt = __wkFormatTokenAmount(l1.balance);
            var l1UsdVal = __wkPortfolioData.usdcPerSui > 0 ? __wkFormatUsd(l1.suiValue * __wkPortfolioData.usdcPerSui) : '';
            var l1Icon = __wkL1Icons[l1.name] || '';
            var subTokens = __wkGetL1SubTokens(l1.name, __wkPortfolioData);
            var hasSubTokens = subTokens.length > 0;
            var isExpanded = !!__wkExpandedL1[l1.name];
            html += '<button class="wk-dropdown-item' + (hasSubTokens ? ' __wk-dd-l1-toggle' : '') + '" data-l1="' + __wkEscapeHtml(l1.name) + '" style="padding:6px 8px;font-size:0.76rem;justify-content:space-between;' + (hasSubTokens ? 'cursor:pointer;' : 'cursor:default;') + '">';
            html += '<span style="display:flex;align-items:center;gap:8px;">';
            html += '<span style="width:18px;text-align:center;flex-shrink:0;">' + l1Icon + '</span>';
            html += '<span style="color:#e2e8f0;font-weight:700;">' + __wkEscapeHtml(l1.name) + '</span>';
            if (hasSubTokens) {
              html += '<span style="opacity:0.5;font-size:0.6rem;margin-left:2px;">' + (isExpanded ? '\u25B2' : '\u25BC') + '</span>';
            }
            html += '</span>';
            html += '<span style="display:flex;flex-direction:column;align-items:flex-end;gap:1px;">';
            html += '<span style="color:#e2e8f0;font-weight:600;">' + __wkEscapeHtml(l1BalFmt) + '</span>';
            if (l1UsdVal) {
              html += '<span style="font-size:0.58rem;color:#94a3b8;">~' + __wkEscapeHtml(l1UsdVal) + '</span>';
            }
            html += '</span>';
            html += '</button>';
            if (hasSubTokens && isExpanded) {
              html += '<div style="margin:0 0 2px 28px;display:flex;flex-direction:column;gap:1px;">';
              for (var s = 0; s < subTokens.length; s++) {
                var sub = subTokens[s];
                var subBalFmt = __wkFormatTokenAmount(sub.balance);
                var subSuiVal = __wkFormatBalance(sub.suiValue);
                html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 8px 3px 0;font-size:0.7rem;color:#9fb0c7;">';
                html += '<span>' + __wkEscapeHtml(sub.name) + '</span>';
                html += '<span style="color:#cbd5e1;">' + __wkEscapeHtml(subBalFmt) + ' <span style="opacity:0.5;">(' + __wkEscapeHtml(subSuiVal) + __wkSuiIconSvg + ')</span></span>';
                html += '</div>';
              }
              html += '</div>';
            }
          }
          html += '</div>';
        }
      }

      html += '<button class="wk-dropdown-item" id="__wk-dd-copy" style="position:relative;">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
        + 'Copy Address</button>';

      html += '<button class="wk-dropdown-item" id="__wk-dd-switch">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></svg>'
        + 'Switch Wallet</button>';

      html += '<button class="wk-dropdown-item disconnect" id="__wk-dd-disconnect">'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>'
        + 'Disconnect</button>';

	      return html;
	    }

		    function __wkEscapeHtml(value) {
		      var text = String(value || '');
		      return text
		        .replace(/&/g, '&amp;')
		        .replace(/</g, '&lt;')
		        .replace(/>/g, '&gt;')
		        .replace(/"/g, '&quot;')
		        .replace(/'/g, '&#39;');
		    }

		    var __wkSuiIconSvg = '<svg viewBox="0 0 300 384" width="10" height="13" aria-hidden="true" focusable="false" style="display:inline-block;vertical-align:-2px;margin-left:4px;fill:#4DA2FF;"><path fill-rule="evenodd" clip-rule="evenodd" d="M240.057 159.914C255.698 179.553 265.052 204.39 265.052 231.407C265.052 258.424 255.414 284.019 239.362 303.768L237.971 305.475L237.608 303.31C237.292 301.477 236.929 299.613 236.502 297.749C228.46 262.421 202.265 232.134 159.148 207.597C130.029 191.071 113.361 171.195 108.985 148.586C106.157 133.972 108.258 119.294 112.318 106.717C116.379 94.1569 122.414 83.6187 127.549 77.2831L144.328 56.7754C147.267 53.1731 152.781 53.1731 155.719 56.7754L240.073 159.914H240.057ZM266.584 139.422L154.155 1.96703C152.007 -0.655678 147.993 -0.655678 145.845 1.96703L33.4316 139.422L33.0683 139.881C12.3868 165.555 0 198.181 0 233.698C0 316.408 67.1635 383.461 150 383.461C232.837 383.461 300 316.408 300 233.698C300 198.181 287.613 165.555 266.932 139.896L266.568 139.438L266.584 139.422ZM60.3381 159.472L70.3866 147.164L70.6868 149.439C70.9237 151.24 71.2239 153.041 71.5715 154.858C78.0809 189.001 101.322 217.456 140.173 239.496C173.952 258.724 193.622 280.828 199.278 305.064C201.648 315.176 202.059 325.129 201.032 333.835L200.969 334.372L200.479 334.609C185.233 342.05 168.09 346.237 149.984 346.237C86.4546 346.237 34.9484 294.826 34.9484 231.391C34.9484 204.153 44.4439 179.142 60.3065 159.44L60.3381 159.472Z"></path></svg>';

	    function __wkBindDropdownEvents(conn) {
      var copyBtn = document.getElementById('__wk-dd-copy');
      var addrDisplay = document.getElementById('__wk-dd-addr-display');
      var l1Toggles = document.querySelectorAll('.__wk-dd-l1-toggle');
      var switchBtn = document.getElementById('__wk-dd-switch');
      var disconnectBtn = document.getElementById('__wk-dd-disconnect');

      function __wkCopyAddress(targetEl) {
        var rawAddr = conn && conn.address ? conn.address : '';
        var normalizedAddr = __wkNormalizeSuiAddress(rawAddr);
        var addr = __wkIsValidSuiAddress(normalizedAddr) ? normalizedAddr : rawAddr;
        if (!addr) return;
        navigator.clipboard.writeText(addr).then(function() {
          var flash = document.createElement('span');
          flash.className = 'wk-copied-flash';
          flash.textContent = 'Copied!';
          targetEl.appendChild(flash);
          setTimeout(function() { flash.remove(); }, 1500);
        });
      }
      if (copyBtn) {
        copyBtn.addEventListener('click', function() { __wkCopyAddress(copyBtn); });
      }
      if (addrDisplay) {
        addrDisplay.addEventListener('click', function() { __wkCopyAddress(addrDisplay); });
      }
      for (var t = 0; t < l1Toggles.length; t++) {
        (function(btn) {
          btn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            var l1Name = btn.getAttribute('data-l1');
            if (!l1Name) return;
            var wasOpen = false;
            var dropdown = __wkWidgetContainer && __wkWidgetContainer.querySelector('.wk-dropdown');
            if (dropdown && dropdown.classList.contains('open')) wasOpen = true;
            __wkExpandedL1[l1Name] = !__wkExpandedL1[l1Name];
            __wkUpdateWidget(SuiWalletKit.$connection.value);
            if (wasOpen) {
              var nextDropdown = __wkWidgetContainer && __wkWidgetContainer.querySelector('.wk-dropdown');
              if (nextDropdown) nextDropdown.classList.add('open');
            }
          });
        })(l1Toggles[t]);
      }
      if (switchBtn) {
        switchBtn.addEventListener('click', function() {
          var dropdown = __wkWidgetContainer && __wkWidgetContainer.querySelector('.wk-dropdown');
          if (dropdown) dropdown.classList.remove('open');
          var bridge = SuiWalletKit.__skiSignFrame;
          if (bridge && bridge.contentWindow) {
            bridge.contentWindow.postMessage({ type: 'ski:disconnect' }, 'https://sui.ski');
          }
          SuiWalletKit.disconnect();
          setTimeout(function() { SuiWalletKit.openModal(); }, 120);
        });
      }
      if (disconnectBtn) {
        disconnectBtn.addEventListener('click', function() {
          var dropdown = __wkWidgetContainer && __wkWidgetContainer.querySelector('.wk-dropdown');
          if (dropdown) dropdown.classList.remove('open');
          var bridge = SuiWalletKit.__skiSignFrame;
          if (bridge && bridge.contentWindow) {
            bridge.contentWindow.postMessage({ type: 'ski:disconnect' }, 'https://sui.ski');
          }
          SuiWalletKit.disconnect();
        });
      }
    }

	    	    function __wkUpdateWidget(conn) {
	      if (!__wkWidgetContainer) return;
	      var widget = __wkWidgetContainer.querySelector('.wk-widget');
	      if (!widget) return;
	      var btn = widget.querySelector('.wk-widget-btn');
	      var dropdown = widget.querySelector('.wk-dropdown');
	      if (!btn || !dropdown) return;

	      var isActive = conn && (conn.status === 'connected' || conn.status === 'session') && conn.address;
	      if (isActive) {
	        if (__wkKeepBrandLogoWhenConnected) {
	          if (__wkWidgetBtnMarkup !== __wkWidgetDefaultMarkup) {
	            btn.innerHTML = __wkWidgetDefaultMarkup;
	            __wkWidgetBtnMarkup = __wkWidgetDefaultMarkup;
	          }
	          if (__wkWidgetBtnStateClass) {
	            btn.classList.remove('connected', 'session-only');
	            __wkWidgetBtnStateClass = '';
	          }
	          if (__wkWidgetDropdownMarkup) {
	            dropdown.innerHTML = '';
	            __wkWidgetDropdownMarkup = '';
	          }
	          dropdown.classList.remove('open');
	          return;
	        }
	        var normalizedAddress = __wkNormalizeSuiAddress(conn.address);
	        var hasValidAddress = __wkIsValidSuiAddress(normalizedAddress);
	        var addressForLabel = hasValidAddress ? normalizedAddress : String(conn.address || '');
	        var isPrimaryName = true && conn.primaryName;
	        var label = isPrimaryName ? conn.primaryName : __wkTruncAddr(addressForLabel);
	        var safeLabel = isPrimaryName
	          ? '<span class="wk-widget-primary-name">' + __wkEscapeHtml(label) + '</span>'
	          : __wkEscapeHtml(label);
	        var widgetWallet = __wkResolveWidgetWallet(conn);
	        var walletIcon = widgetWallet.icon;
	        var connectionHint = __wkGetWaaPConnectionHint(conn);
	        var waapMethod = connectionHint ? __wkResolveWaaPMethod(conn) : '';
	        var methodSvg = (connectionHint && waapMethod) ? __wkWidgetMethodIconSvg(waapMethod) : '';
	        var balanceLine = '';
	        if (__wkPortfolioData) {
	          var suiSummary = __wkFormatBalance(__wkPortfolioData.totalSui);
	          var stableTotal = __wkGetStablecoinTotal(__wkPortfolioData);
	          var stableSummary = stableTotal >= 0.01 ? __wkFormatUsd(stableTotal) : '';
	          if (suiSummary || stableSummary) {
	            balanceLine = '<span class="wk-widget-balance-wrap">';
	            if (suiSummary) {
	              balanceLine += '<span class="wk-widget-token-row">' + __wkEscapeHtml(suiSummary) + __wkSuiIconSvg + '</span>';
	            }
	            if (stableSummary) {
	              balanceLine += '<span class="wk-widget-usd-row">' + __wkEscapeHtml(stableSummary) + '</span>';
	            }
	            balanceLine += '</span>';
	          }
	        }
	        var labelMarkup = '<span class="wk-widget-label-wrap"><span class="wk-widget-title">' + safeLabel + '</span></span>';
	        var nextBtnMarkup = '';
	        var waapBadge = connectionHint ? '<img src="' + __wkWaaPIcon + '" class="wk-widget-icon wk-waap-badge" alt="WaaP" onerror="this.style.display=\'none\'">' : '';
	        if (connectionHint) {
	          if (methodSvg) {
	            nextBtnMarkup = waapBadge + '<span class="wk-widget-icon-fallback">' + methodSvg + '</span>' + labelMarkup + balanceLine;
	          } else {
	            nextBtnMarkup = waapBadge + labelMarkup + balanceLine;
	          }
	        } else if (walletIcon) {
	          nextBtnMarkup = '<img src="' + walletIcon + '" class="wk-widget-icon" alt="" onerror="this.style.display=\'none\'">' + labelMarkup + balanceLine;
	        } else if (conn.status === 'session') {
	          nextBtnMarkup = '<span class="wk-widget-icon-fallback"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.6"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>' + labelMarkup + balanceLine;
	        } else {
	          nextBtnMarkup = labelMarkup + balanceLine;
	        }
	        if (__wkWidgetBtnMarkup !== nextBtnMarkup) {
	          btn.innerHTML = nextBtnMarkup;
	          __wkWidgetBtnMarkup = nextBtnMarkup;
	        }
	        var nextBtnStateClass = 'connected';
	        if (__wkWidgetBtnStateClass !== nextBtnStateClass) {
	          btn.classList.remove('connected', 'session-only');
	          btn.classList.add(nextBtnStateClass);
	          __wkWidgetBtnStateClass = nextBtnStateClass;
	        }
	        var nextDropdownMarkup = __wkBuildDropdownHtml(conn);
	        if (__wkWidgetDropdownMarkup !== nextDropdownMarkup) {
	          dropdown.innerHTML = nextDropdownMarkup;
	          __wkWidgetDropdownMarkup = nextDropdownMarkup;
	          __wkBindDropdownEvents(conn);
	        }
	      } else {
	        __wkStopPortfolioPolling();
	        if (__wkWidgetBtnMarkup !== __wkWidgetDefaultMarkup) {
	          btn.innerHTML = __wkWidgetDefaultMarkup;
	          __wkWidgetBtnMarkup = __wkWidgetDefaultMarkup;
	        }
	        if (__wkWidgetBtnStateClass) {
	          btn.classList.remove('connected', 'session-only');
	          __wkWidgetBtnStateClass = '';
	        }
	        if (__wkWidgetDropdownMarkup) {
	          dropdown.innerHTML = '';
	          __wkWidgetDropdownMarkup = '';
	        }
	        dropdown.classList.remove('open');
	      }
	    }


	    var __wkResolvingPrimaryAddr = null;
	    function __wkAutoResolvePrimaryName(addr) {
	      if (__wkResolvingPrimaryAddr === addr) return;
	      __wkResolvingPrimaryAddr = addr;
	      var url = 'https://' + __wkPrimaryProfileHost + '/api/primary-name?address=' + encodeURIComponent(addr);
	      fetch(url).then(function(res) {
	        if (!res.ok) throw new Error('HTTP ' + res.status);
	        return res.json();
	      }).then(function(data) {
	        if (__wkResolvingPrimaryAddr !== addr) return;
	        __wkResolvingPrimaryAddr = null;
	        if (data && data.name) {
	          SuiWalletKit.setPrimaryName(data.name);
	        }
	      }).catch(function() {
	        if (__wkResolvingPrimaryAddr === addr) __wkResolvingPrimaryAddr = null;
	      });
	    }

	    SuiWalletKit.renderWidget = function renderWidget(containerId) {
	      var container = document.getElementById(containerId);
	      if (!container) throw new Error('Widget container not found: ' + containerId);
	      __wkWidgetContainer = container;

	      var widget = container.querySelector('.wk-widget');
	      if (!widget) {
	        container.innerHTML = '<div class="wk-widget">'
	          + '<button class="wk-widget-btn" data-wk-role="toggle">' + __wkWidgetDefaultMarkup + '</button>'
	          + '<div class="wk-dropdown"></div>'
	          + '</div>';
	        widget = container.querySelector('.wk-widget');
	        __wkWidgetBtnMarkup = '';
	        __wkWidgetBtnStateClass = '';
	        __wkWidgetDropdownMarkup = '';
	      }

	      var btn = container.querySelector('.wk-widget-btn');
	      if (btn && container.dataset.wkWidgetBound !== '1') {
	        container.dataset.wkWidgetBound = '1';
	        btn.addEventListener('click', function() {
	          var activeWidget = __wkWidgetContainer && __wkWidgetContainer.querySelector('.wk-widget');
	          var dropdown = __wkWidgetContainer && __wkWidgetContainer.querySelector('.wk-dropdown');
	          if (!activeWidget || !dropdown) return;
	          var conn = SuiWalletKit.$connection.value;
	          if (conn && (conn.status === 'connected' || conn.status === 'session')) {
	            if (__wkKeepBrandLogoWhenConnected) {
	              var profileHref = __wkGetPrimaryProfileHref(conn);
	              window.location.href = profileHref || ('https://' + __wkPrimaryProfileHost);
	              return;
	            }
	            dropdown.classList.toggle('open');
	          } else {
	            var modalOpen = document.body && document.body.classList.contains('wk-modal-open');
	            if (modalOpen) { SuiWalletKit.closeModal(); } else { SuiWalletKit.openModal(); }
	          }
	        });
	      }
	      if (btn) {
	        try { window.__wkWidgetButton = btn; } catch (_) {}
	        try {
	          window.getWalletWidgetButton = window.getWalletWidgetButton || function() {
	            return document.querySelector('#wk-widget > div > button') || document.querySelector('#wk-widget .wk-widget-btn');
	          };
	        } catch (_) {}
	        try { window.dispatchEvent(new CustomEvent('wk-widget-ready')); } catch (_) {}
	      }

	      if (!__wkWidgetDocClickBound) {
	        __wkWidgetDocClickBound = true;
	        document.addEventListener('click', function(e) {
	          var activeContainer = __wkWidgetContainer;
	          if (!activeContainer) return;
	          var activeWidget = activeContainer.querySelector('.wk-widget');
	          var dropdown = activeContainer.querySelector('.wk-dropdown');
	          if (activeWidget && dropdown && !activeWidget.contains(e.target)) {
	            dropdown.classList.remove('open');
	          }
	        });
	      }

	      if (__wkWidgetUnsub) __wkWidgetUnsub();
	      var __wkLastPollingAddr = null;
	      __wkWidgetUnsub = SuiWalletKit.subscribe(SuiWalletKit.$connection, function(conn) {
	        var rawAddr = conn && (conn.status === 'connected' || conn.status === 'session') ? conn.address : null;
	        var normalizedAddr = __wkNormalizeSuiAddress(rawAddr || '');
	        var addr = __wkIsValidSuiAddress(normalizedAddr) ? normalizedAddr : null;
	        if (addr && addr !== __wkLastPollingAddr) {
	          __wkLastPollingAddr = addr;
	          __wkStartPortfolioPolling(addr);
	        } else if (!addr && __wkLastPollingAddr) {
	          __wkLastPollingAddr = null;
	          __wkStopPortfolioPolling();
	        }
	        if (true && addr && !conn.primaryName) {
	          __wkAutoResolvePrimaryName(addr);
	        }
	        __wkUpdateWidget(conn);
	      });

	      var initConn = SuiWalletKit.$connection.value;
	      if (initConn && (initConn.status === 'connected' || initConn.status === 'session') && initConn.address) {
	        var initAddr = __wkNormalizeSuiAddress(initConn.address || '');
	        if (__wkIsValidSuiAddress(initAddr)) {
	          __wkLastPollingAddr = initAddr;
	          __wkStartPortfolioPolling(initAddr);
	        }
	      }
	      __wkUpdateWidget(initConn);
	    };
	  
