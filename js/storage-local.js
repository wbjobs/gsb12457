/* localStorage 适配器。接口与 IDB/内存适配器一致：
 * get/set/remove/keys/clear/info
 * 存储格式：cmt:<name> => JSON({ v, meta })
 */
(function () {
  'use strict';
  var CMT = (window.CMT = window.CMT || {});
  var PREFIX = 'cmt:';

  function fullKey(key) { return PREFIX + key; }

  function isAvailable() {
    try {
      var k = '__cmt_ls_probe__';
      localStorage.setItem(k, '1');
      var ok = localStorage.getItem(k) === '1';
      localStorage.removeItem(k);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function LocalAdapter(namespace) {
    this.type = 'localStorage';
    this.namespace = namespace || 'default';
  }

  LocalAdapter.prototype.get = function (key) {
    try {
      var raw = localStorage.getItem(fullKey(key));
      return Promise.resolve(raw == null ? null : JSON.parse(raw));
    } catch (e) { return Promise.reject(e); }
  };

  LocalAdapter.prototype.set = function (key, value, meta) {
    try {
      localStorage.setItem(fullKey(key), JSON.stringify({ v: value, meta: meta || {} }));
      return Promise.resolve();
    } catch (e) {
      var normalized = normalizeQuotaError(e);
      return Promise.reject(normalized);
    }
  };

  LocalAdapter.prototype.remove = function (key) {
    try { localStorage.removeItem(fullKey(key)); } catch (e) { return Promise.reject(e); }
    return Promise.resolve();
  };

  LocalAdapter.prototype.keys = function () {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) out.push(k.slice(PREFIX.length));
      }
    } catch (e) { return Promise.reject(e); }
    return Promise.resolve(out);
  };

  LocalAdapter.prototype.clearAll = function () {
    try {
      this.keys().then(function (ks) {
        ks.forEach(function (k) { localStorage.removeItem(fullKey(k)); });
      });
    } catch (e) { return Promise.reject(e); }
    return Promise.resolve();
  };

  LocalAdapter.prototype.info = function () {
    var quota = null;
    if (navigator.storage && navigator.storage.estimate) {
      return navigator.storage.estimate().then(function (est) {
        return { type: 'localStorage', quota: est.quota, usage: est.usage };
      }, function () { return { type: 'localStorage', quota: null, usage: null }; });
    }
    return Promise.resolve({ type: 'localStorage', quota: null, usage: null });
  };

  function normalizeQuotaError(e) {
    if (e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e.code === 22 || e.code === 1014)) {
      e.isQuota = true;
    }
    return e;
  }

  CMT.LocalAdapter = LocalAdapter;
  CMT.storageLocal = { isAvailable: isAvailable, PREFIX: PREFIX };
})();
