/* Cookie 读取 / 写入 / 删除。
 * - document.cookie 只能读到非 HttpOnly 的键值；HttpOnly Cookie 无法被 JS 迁移。
 * - 支持 cookieStore 时可额外拿到 path/domain/expires/sameSite/secure/partitioned 属性。
 */
(function () {
  'use strict';
  var CMT = (window.CMT = window.CMT || {});
  var u = CMT.util;

  /* 每条 Cookie 在请求头中的体积近似：name + "=" + value + "; " 分隔开销 */
  function cookieSize(name, value) {
    return u.byteLength(name) + 1 + u.byteLength(value) + 2;
  }

  function parseJar() {
    var raw = document.cookie || '';
    var map = new Map();
    if (!raw) return map;
    raw.split(/; /).forEach(function (pair) {
      if (!pair) return;
      var idx = pair.indexOf('=');
      var name = idx === -1 ? pair : decodeURIComponent(pair.slice(0, idx));
      var value = idx === -1 ? '' : decodeURIComponent(pair.slice(idx + 1));
      map.set(name, value);
    });
    return map;
  }

  /* 合并 document.cookie（权威键值）与 cookieStore（权威属性） */
  function readAll(options) {
    options = options || {};
    var jar = parseJar();
    var result = [];
    if (window.CookieChangeEvent && typeof cookieStore.getAll === 'function') {
      return cookieStore.getAll().then(function (list) {
        var byKey = new Map();
        (list || []).forEach(function (c) { byKey.set(c.name, c); });
        jar.forEach(function (value, name) {
          var c = byKey.get(name) || {};
          result.push(normalize(name, value, c, 'cookieStore'));
        });
        return result;
      }, function () {
        jar.forEach(function (value, name) { result.push(normalize(name, value, {}, 'document')); });
        return result;
      });
    }
    jar.forEach(function (value, name) { result.push(normalize(name, value, {}, 'document')); });
    return Promise.resolve(result);
  }

  function normalize(name, value, c, attrsSource) {
    var sameSite = c.sameSite == null ? null : String(c.sameSite).toLowerCase();
    return {
      name: name,
      value: value,
      size: cookieSize(name, value),
      attrs: {
        path: c.path == null ? null : c.path,
        domain: c.domain == null ? null : c.domain,
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: sameSite,
        partitioned: !!c.partitioned,
        expires: c.expires instanceof Date ? c.expires.getTime()
          : (typeof c.expires === 'number' ? c.expires : null)
      },
      attrsSource: attrsSource
    };
  }

  function buildAttrString(attrs) {
    attrs = attrs || {};
    var s = '';
    if (attrs.path) s += '; path=' + attrs.path;
    if (attrs.domain) s += '; domain=' + attrs.domain;
    if (attrs.expires) {
      var d = attrs.expires instanceof Date ? attrs.expires
        : new Date(typeof attrs.expires === 'number' ? attrs.expires : Date.parse(attrs.expires));
      if (!isNaN(d.getTime())) s += '; expires=' + d.toUTCString();
    }
    if (attrs.maxAge != null) s += '; max-age=' + attrs.maxAge;
    if (attrs.secure) s += '; secure';
    /* SameSite=None 必须同时带 secure，否则现代浏览器会直接丢弃 */
    if (attrs.sameSite) {
      var ss = String(attrs.sameSite).toLowerCase();
      s += '; samesite=' + ss;
      if (ss === 'none' && !attrs.secure && window.isSecureContext) s += '; secure';
    }
    if (attrs.partitioned) s += '; partitioned';
    return s;
  }

  /* 写入并读回验证；返回 { ok, accepted }，accepted=false 表示浏览器静默丢弃 */
  function setCookie(name, value, attrs) {
    var before = parseJar().has(name);
    document.cookie = encodeURIComponent(name) + '=' + encodeURIComponent(value == null ? '' : value) +
      buildAttrString(attrs);
    var exists = parseJar().has(name);
    return { ok: exists, accepted: before || exists, beforeExisted: before };
  }

  /* 删除：对常见 domain/path 组合做多次过期写入，覆盖属性未知的旧 Cookie */
  function removeCookie(name, attrs) {
    attrs = attrs || {};
    var paths = attrs.path ? [attrs.path] : ['/', ''];
    var domains = attrs.domain ? [attrs.domain, leadingDot(attrs.domain)] : [''];
    paths.forEach(function (path) {
      domains.forEach(function (domain) {
        document.cookie = encodeURIComponent(name) + '=; ' +
          (path ? 'path=' + path + '; ' : '') +
          (domain ? 'domain=' + domain + '; ' : '') +
          'expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0';
      });
    });
    return !parseJar().has(name);
  }

  function leadingDot(domain) {
    return domain.charAt(0) === '.' ? domain : '.' + domain;
  }

  function hasCookieStore() {
    return typeof window !== 'undefined' && typeof window.cookieStore !== 'undefined' &&
      typeof cookieStore.getAll === 'function';
  }

  CMT.cookie = {
    readAll: readAll,
    parseJar: parseJar,
    cookieSize: cookieSize,
    setCookie: setCookie,
    removeCookie: removeCookie,
    buildAttrString: buildAttrString,
    hasCookieStore: hasCookieStore
  };
})();
