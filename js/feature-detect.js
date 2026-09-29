/* 浏览器能力检测：
 * cookieMaxBytes   实测单条 Cookie 可写上限（二分探测 + UA 兜底）
 * sameSite         Strict/Lax/None 支持度（cookieStore 运行时实测 + UA 矩阵启发式）
 * partitioned      CHIPS 分区 Cookie 支持度
 * thirdParty       第三方上下文 Cookie/存储可用性（需跨域探测页）
 * storage          localStorage / IndexedDB / Worker / 安全上下文
 * confidence: 'runtime' 表示运行时实测，'heuristic' 表示 UA 推断，'unknown' 表示无法判定
 */
(function () {
  'use strict';
  var CMT = (window.CMT = window.CMT || {});
  var u = CMT.util;

  /* ----------------------- UA 解析 ----------------------- */
  function parseUA(ua) {
    ua = ua || (navigator.userAgent || '');
    var out = { ua: ua, browser: 'unknown', version: null, os: 'unknown', osVersion: null };
    var m;
    if (/iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      out.os = 'ios';
      m = ua.match(/(?:OS |CPU OS )(\d+)[._](\d+)/);
      if (m) out.osVersion = parseFloat(m[1] + '.' + m[2]);
    } else if (/Android/.test(ua)) {
      out.os = 'android';
      m = ua.match(/Android (\d+(?:\.\d+)?)/);
      if (m) out.osVersion = parseFloat(m[1]);
    } else if (/Mac OS X/.test(ua)) {
      out.os = 'macos';
    } else if (/Windows/.test(ua)) {
      out.os = 'windows';
    } else if (/Linux/.test(ua)) {
      out.os = 'linux';
    }

    if ((m = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/))) { out.browser = 'edge'; out.version = +m[1]; }
    else if ((m = ua.match(/OPR\/(\d+)/))) { out.browser = 'opera'; out.version = +m[1]; }
    else if ((m = ua.match(/SamsungBrowser\/(\d+)/))) { out.browser = 'samsung'; out.version = +m[1]; }
    else if ((m = ua.match(/Chrome\/(\d+)/)) && /Google Inc/.test(navigator.vendor || '')) { out.browser = 'chrome'; out.version = +m[1]; }
    else if ((m = ua.match(/Chrome\/(\d+)/))) { out.browser = 'chromium'; out.version = +m[1]; }
    else if ((m = ua.match(/Firefox\/(\d+)/))) { out.browser = 'firefox'; out.version = +m[1]; }
    else if ((m = ua.match(/Version\/(\d+).*Safari\//))) { out.browser = 'safari'; out.version = +m[1]; }
    return out;
  }

  /* 各内核常见单条 Cookie 上限（字节），实测失败时兜底 */
  var KNOWN_COOKIE_LIMITS = {
    chrome: 4096, chromium: 4096, edge: 4096, opera: 4096, samsung: 4096,
    firefox: 4095, safari: 4093
  };

  /* ----------------------- Cookie 大小实测 ----------------------- */
  /* 探测键：__cmt_probe_size__，写完立即删除；采用指数扩容 + 二分，~14 次写入 */
  function probeMaxCookieBytes(timeoutMs) {
    var key = '__cmt_probe_size__';
    function writeable(byteTarget) {
      /* 构造 value 使 name=value 的字节数恰好约等于 byteTarget */
      var overhead = u.byteLength(key + '=') + 2;
      var value = repeatToBytes('a', Math.max(1, byteTarget - overhead));
      try {
        document.cookie = encodeURIComponent(key) + '=' + value + '; path=/; samesite=lax';
      } catch (e) {
        return false;
      }
      var ok = CMT.cookie.parseJar().get(key) != null;
      erase(key);
      return ok;
    }
    function erase(k) {
      document.cookie = encodeURIComponent(k) + '=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0';
    }
    function repeatToBytes(ch, bytes) {
      var s = '';
      while (u.byteLength(s) < bytes) s += ch;
      return s;
    }
    var deadline = Date.now() + (timeoutMs || 4000);
    return u.wait(0).then(function () {
      if (!writeable(10)) return null;
      var lo = 10, hi = 16;
      while (hi < 16384 && Date.now() < deadline) {
        if (!writeable(hi)) break;
        lo = hi;
        hi *= 2;
      }
      while (lo + 64 < hi && Date.now() < deadline) {
        var mid = Math.floor((lo + hi) / 2 / 32) * 32;
        if (writeable(mid)) lo = mid; else hi = mid;
      }
      erase(key);
      return lo;
    });
  }

  function detectCookieSize(info) {
    var fallback = KNOWN_COOKIE_LIMITS[info.browser] || 4096;
    return probeMaxCookieBytes().then(function (measured) {
      if (!measured) {
        return { value: fallback, confidence: 'heuristic', note: '探测 Cookie 写入失败，使用浏览器已知限制' };
      }
      return {
        value: measured,
        confidence: 'runtime',
        note: '实测可写上限（' + measured + ' 字节），浏览器声明限制约 ' + fallback + ' 字节'
      };
    });
  }

  /* ----------------------- SameSite / Partitioned ----------------------- */
  var PROBE = '__cmt_probe_ss__';

  function ssHeuristics(info) {
    var v = info.version, osV = info.osVersion, r = {
      strict: true, lax: true, none: true, confidence: 'heuristic'
    };
    function noNone() { r.none = false; }
    switch (info.browser) {
      case 'chrome': case 'edge': case 'chromium': case 'opera':
        if (v < 51) { r.strict = r.lax = false; }
        else if (v < 80) { noNone(); }
        /* Chrome 51-66 对 SameSite=None 会把 Cookie 当成 Strict；视为不可用 */
        break;
      case 'samsung':
        if (v < 11) noNone();
        break;
      case 'firefox':
        if (v < 60) { r.strict = r.lax = false; }
        else if (v < 63) { noNone(); }
        break;
      case 'safari':
        /* Safari 13 (iOS13/macOS10.15) 才正确支持 SameSite=None */
        if (info.os === 'ios' ? osV < 13 : v < 13) {
          r.strict = false; r.lax = false; r.none = false;
        }
        break;
      default:
        r.confidence = 'unknown';
    }
    return r;
  }

  function chipsHeuristic(info) {
    var v = info.version;
    switch (info.browser) {
      case 'chrome': case 'edge': case 'chromium':
        return { supported: v >= 113, confidence: 'heuristic' };
      case 'opera':
        return { supported: v >= 99, confidence: 'heuristic' };
      case 'samsung':
        return { supported: v >= 23, confidence: 'heuristic' };
      case 'firefox':
        return { supported: v >= 129, confidence: 'heuristic' };
      case 'safari':
        return { supported: false, confidence: 'heuristic', note: 'Safari 使用 Storage Access API，不支持 CHIPS partitioned 属性' };
      default:
        return { supported: null, confidence: 'unknown' };
    }
  }

  /* cookieStore 运行时实测：按期望属性写入再读回比对，最后删除 */
  function runtimeSameSiteProbe() {
    if (typeof cookieStore === 'undefined' || !window.isSecureContext) return null;
    var modes = ['strict', 'lax', 'none'];
    return modes.reduce(function (p, mode) {
      return p.then(function (acc) {
        var name = PROBE + '_' + mode;
        var opts = { path: '/', sameSite: mode };
        if (mode === 'none') opts.secure = true;
        return cookieStore.set(Object.assign({ name: name, value: '1' }, opts)).then(function () {
          return cookieStore.get(name).then(function (c) {
            acc[mode] = !!(c && String(c.sameSite).toLowerCase() === mode);
          }, function () { acc[mode] = false; }).then(function () {
            return cookieStore.delete({ name: name, path: '/' }).catch(function () {});
          }).then(function () { return acc; });
        }, function () { acc[mode] = false; return acc; });
      });
    }, Promise.resolve({})).then(function (acc) {
      acc.confidence = 'runtime';
      return acc;
    }, function () { return null; });
  }

  function runtimePartitionedProbe() {
    if (typeof cookieStore === 'undefined' || !window.isSecureContext) {
      return Promise.resolve(null);
    }
    var name = '__cmt_probe_chips__';
    return cookieStore.set({
      name: name, value: '1', path: '/',
      sameSite: 'none', secure: true, partitioned: true
    }).then(function () {
      return cookieStore.get({ name: name, partitioned: true }).then(function (c) {
        var accepted = !!(c && c.partitioned === true);
        return cookieStore.delete({ name: name, path: '/', partitioned: true })
          .catch(function () {})
          .then(function () {
            return {
              supported: accepted,
              confidence: 'runtime',
              note: accepted
                ? '浏览器接受并回读 partitioned 属性（跨站隔离语义仍需跨站环境验证）'
                : '分区 Cookie 被写入但回读不到 partitioned 标记'
            };
          });
      }, function () {
        return { supported: false, confidence: 'runtime', note: 'partitioned 属性被拒绝' };
      });
    }, function () {
      return { supported: false, confidence: 'runtime', note: 'partitioned Cookie 写入被拒绝' };
    });
  }

  /* ----------------------- 第三方上下文 ----------------------- */
  function isEmbedded() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true; /* 跨域访问 top 抛错，说明被跨站嵌入 */
    }
  }

  /* 加载跨站探测页（probes/third-party.html 部署到另一个源），postMessage 握手。
   * 不提供 probeUrl、或超时：返回 unknown，迁移时按"可能受限"保守处理。 */
  function detectThirdParty(probeUrl, timeoutMs) {
    var ctx = isEmbedded();
    if (!probeUrl) {
      return Promise.resolve({
        context: ctx ? 'third-party' : 'first-party',
        cookies: null, localStorage: null, indexedDB: null,
        confidence: 'unknown',
        note: ctx
          ? '当前处于第三方 iframe，但未配置跨站探测页，无法实测'
          : '顶层页面无法实测第三方 Cookie（需部署跨站探测页）'
      });
    }
    return new Promise(function (resolve) {
      var frame = document.createElement('iframe');
      var origin = (function () { try { return new URL(probeUrl, location.href).origin; } catch (e) { return '*'; } })();
      var done = false;
      var timer = setTimeout(function () {
        finish({
          context: 'third-party', cookies: null, localStorage: null, indexedDB: null,
          confidence: 'unknown', note: '跨站探测超时（' + (timeoutMs || 3000) + 'ms）'
        });
      }, timeoutMs || 3000);

      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        if (frame.parentNode) frame.parentNode.removeChild(frame);
        resolve(result);
      }
      function onMessage(ev) {
        if (origin !== '*' && ev.origin !== origin) return;
        var d = ev.data;
        if (!d || d.__cmt !== 'probe-result') return;
        finish({
          context: 'third-party',
          cookies: d.cookies, localStorage: d.localStorage, indexedDB: d.indexedDB,
          confidence: 'runtime',
          note: summarizeThirdParty(d)
        });
      }
      window.addEventListener('message', onMessage);
      frame.hidden = true;
      frame.style.cssText = 'display:none;width:1px;height:1px;';
      frame.addEventListener('load', function () {
        try { frame.contentWindow.postMessage({ __cmt: 'probe-start' }, origin); } catch (e) {}
      });
      frame.src = probeUrl;
      document.body.appendChild(frame);
    });
  }

  function summarizeThirdParty(d) {
    var parts = [];
    parts.push('第三方 Cookie: ' + zh(d.cookies));
    parts.push('localStorage: ' + zh(d.localStorage));
    parts.push('IndexedDB: ' + zh(d.indexedDB));
    return parts.join('，');
  }
  function zh(v) { return v === true ? '可用' : v === false ? '被禁' : '未知'; }

  /* ----------------------- 存储能力 ----------------------- */
  function detectLocalStorage() {
    var available = false, quota = null, error = null;
    try {
      var k = '__cmt_probe_ls__';
      window.localStorage.setItem(k, '1');
      available = window.localStorage.getItem(k) === '1';
      window.localStorage.removeItem(k);
      try {
        var probe = new Array(1024).join('x');
        var s = '';
        while (s.length < 6 * 1024 * 1024) {
          window.localStorage.setItem(k, s += probe);
        }
      } catch (e) {
        var used = (window.localStorage.getItem(k) || '').length;
        if (used) quota = used * 2;
        window.localStorage.removeItem(k);
      }
    } catch (e) {
      available = false;
      error = u.errName(e) + ': ' + e.message;
    }
    return { available: available, quotaApprox: quota, error: error, confidence: 'runtime' };
  }

  function detectIndexedDB() {
    return new Promise(function (resolve) {
      var idb = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
      if (!idb) {
        resolve({ available: false, confidence: 'runtime', error: 'indexedDB 不存在（隐私模式可能被禁用）' });
        return;
      }
      var req, finished = false;
      var timer = setTimeout(done, 2500, {
        available: false, confidence: 'runtime', error: '打开 IndexedDB 超时（可能处于被禁的第三方上下文）'
      });
      function done(result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { if (req && typeof req.result !== 'undefined' && req.result.close) req.result.close(); } catch (e) {}
        try { idb.deleteDatabase('__cmt_probe_idb__'); } catch (e) {}
        resolve(result);
      }
      try {
        req = idb.open('__cmt_probe_idb__');
        req.onupgradeneeded = function () {
          req.result.createObjectStore('probe');
        };
        req.onsuccess = function () { done({ available: true, confidence: 'runtime' }); };
        req.onerror = function () {
          done({ available: false, confidence: 'runtime', error: String(req.error && req.error.message || req.error || 'open error') });
        };
        req.onblocked = function () {
          done({ available: false, confidence: 'runtime', error: '数据库被阻塞' });
        };
      } catch (e) {
        done({ available: false, confidence: 'runtime', error: u.errName(e) + ': ' + e.message });
      }
    });
  }

  function detectWorkers() {
    var worker = false, moduleWorker = false;
    if (typeof Worker !== 'undefined') worker = true;
    try {
      if (typeof Worker === 'function') {
        /* 仅检测构造选项支持，不真正加载 */
        new Worker(URL.createObjectURL(new Blob(['//'], { type: 'text/javascript' })), { type: 'module' }).terminate();
        moduleWorker = true;
      }
    } catch (e) { moduleWorker = false; }
    return { worker: worker, moduleWorker: moduleWorker };
  }

  /* ----------------------- 汇总 ----------------------- */
  function detectAll(options) {
    options = options || {};
    var info = parseUA(options.ua);
    var result = {
      ua: info,
      secureContext: window.isSecureContext === true,
      cookieStore: CMT.cookie.hasCookieStore(),
      embedded: isEmbedded()
    };
    var tasks = [
      detectCookieSize(info).then(function (r) { result.cookieMaxBytes = r; }),
      runtimeSameSiteProbe().then(function (runtime) {
        result.sameSite = runtime || ssHeuristics(info);
        if (runtime && info.browser) result.sameSite.uaMatrix = ssHeuristics(info);
      }),
      runtimePartitionedProbe().then(function (runtime) {
        result.partitioned = runtime && runtime.supported != null ? runtime : chipsHeuristic(info);
      }),
      detectIndexedDB().then(function (r) { result.indexedDB = r; }),
      detectThirdParty(options.thirdPartyProbeUrl, options.thirdPartyTimeout)
        .then(function (r) { result.thirdParty = r; })
    ];
    result.localStorage = detectLocalStorage();
    var w = detectWorkers();
    result.webWorker = w.worker;
    result.moduleWorker = w.moduleWorker;
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      result.storageEstimateSupported = true;
    }
    return Promise.all(tasks).then(function () { return result; });
  }

  function statusOf(flag) {
    if (flag === true) return 'supported';
    if (flag === false) return 'unsupported';
    return 'unknown';
  }

  CMT.detect = {
    detectAll: detectAll,
    parseUA: parseUA,
    isEmbedded: isEmbedded,
    statusOf: statusOf,
    detectLocalStorage: detectLocalStorage,
    detectIndexedDB: detectIndexedDB,
    detectThirdParty: detectThirdParty
  };
})();
