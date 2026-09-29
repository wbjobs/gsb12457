/* 通用工具：字节大小、校验和、Promise 辅助、HTML 转义等（无框架、无依赖） */
(function () {
  'use strict';
  var CMT = (window.CMT = window.CMT || {});

  function byteLength(str) {
    var s = String(str == null ? '' : str);
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(s).length;
    }
    var bytes = 0;
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; }
      else bytes += 3;
    }
    return bytes;
  }

  /* FNV-1a（32 位）：快、零依赖、主线程与 Worker 结果一致，用于迁移前后一致性校验 */
  function fnv1a(str) {
    var s = String(str == null ? '' : str);
    var hash = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return ('0000000' + (hash >>> 0).toString(16)).slice(-8);
  }

  /* 安全上下文下可用的强校验；不支持时返回 null，回退 FNV */
  function sha256(str) {
    if (!window.crypto || !crypto.subtle || typeof TextEncoder === 'undefined') {
      return Promise.resolve(null);
    }
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str))).then(
      function (buf) {
        var arr = Array.prototype.slice.call(new Uint8Array(buf));
        return arr.map(function (b) { return ('00' + b.toString(16)).slice(-2); }).join('');
      },
      function () { return null; }
    );
  }

  function uid(prefix) {
    return (prefix || 'cm') + '-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  function tick() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function deferred() {
    var d = {};
    d.promise = new Promise(function (resolve, reject) { d.resolve = resolve; d.reject = reject; });
    return d;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatBytes(n) {
    if (n == null || isNaN(n)) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function errName(err) {
    if (!err) return '';
    return err.name || (err.constructor && err.constructor.name) || 'Error';
  }

  CMT.util = {
    byteLength: byteLength,
    fnv1a: fnv1a,
    sha256: sha256,
    uid: uid,
    tick: tick,
    wait: wait,
    deferred: deferred,
    escapeHtml: escapeHtml,
    formatBytes: formatBytes,
    errName: errName
  };
})();
