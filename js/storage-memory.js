/* 内存适配器：所有持久化存储都不可用时的最后兜底（隐私模式 / 第三方全禁）。
 * 数据仅存活于当前页面会话，并通过 storage 事件提示用户不要刷新。
 */
(function () {
  'use strict';
  var CMT = (window.CMT = window.CMT || {});

  function MemoryAdapter() {
    this.type = 'memory';
    this._map = new Map();
    this.volatile = true;
  }
  MemoryAdapter.prototype.get = function (key) {
    return Promise.resolve(this._map.has(key) ? clone(this._map.get(key)) : null);
  };
  MemoryAdapter.prototype.set = function (key, value, meta) {
    this._map.set(key, { v: value, meta: meta || {} });
    return Promise.resolve();
  };
  MemoryAdapter.prototype.remove = function (key) { this._map.delete(key); return Promise.resolve(); };
  MemoryAdapter.prototype.keys = function () { return Promise.resolve(Array.from(this._map.keys())); };
  MemoryAdapter.prototype.all = function () {
    return Promise.resolve(Array.from(this._map.values()).map(clone));
  };
  MemoryAdapter.prototype.clearAll = function () { this._map.clear(); return Promise.resolve(); };
  MemoryAdapter.prototype.info = function () {
    return Promise.resolve({ type: 'memory', quota: null, usage: null, volatile: true });
  };
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  CMT.MemoryAdapter = MemoryAdapter;
})();
