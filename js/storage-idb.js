/* IndexedDB 适配器：
 * - 优先经 Web Worker 执行（不阻塞主线程 / DOM），Worker 不可用时自动回退主线程。
 * - Worker 加载失败（file:// 协议、CSP、404）也自动回退，并在 info 中标记。
 */
(function () {
  'use strict';
  var CMT = (window.CMT = window.CMT || {});

  function isAvailable() {
    return !!(window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB);
  }

  /* ---------------- 主线程直连适配器 ---------------- */
  function IdbAdapter(dbName) {
    this.type = 'indexedDB';
    this.dbName = dbName || 'cmt-migration';
    this.kv = new CMT.IdbKV(this.dbName, 1);
  }
  IdbAdapter.prototype.get = function (key) { return this.kv.get(key); };
  IdbAdapter.prototype.set = function (key, value, meta) {
    return this.kv.set(key, value, meta).then(function () { return undefined; });
  };
  IdbAdapter.prototype.remove = function (key) { return this.kv.delete(key); };
  IdbAdapter.prototype.keys = function () { return this.kv.keys(); };
  IdbAdapter.prototype.all = function () { return this.kv.all(); };
  IdbAdapter.prototype.clearAll = function () {
    var self = this;
    return this.kv.keys().then(function (ks) {
      return ks.reduce(function (p, k) { return p.then(function () { return self.kv.delete(k); }); }, Promise.resolve());
    });
  };
  IdbAdapter.prototype.info = function () {
    var est = navigator.storage && navigator.storage.estimate
      ? navigator.storage.estimate().catch(function () { return null; }) : Promise.resolve(null);
    return est.then(function (e) { return { type: 'indexedDB', quota: e && e.quota, usage: e && e.usage }; });
  };
  IdbAdapter.prototype.close = function () { this.kv.close(); };

  /* ---------------- Worker 客户端 ---------------- */
  function WorkerAdapter(workerUrl, dbName) {
    this.type = 'indexedDB-worker';
    this.workerUrl = workerUrl || 'worker/idb-worker.js';
    this.dbName = dbName || 'cmt-migration';
    this._worker = null;
    this._seq = 0;
    this._pending = new Map();
  }

  WorkerAdapter.prototype._ensure = function () {
    if (this._worker) return Promise.resolve(this._worker);
    if (typeof Worker === 'undefined') return Promise.reject(new Error('Web Worker 不支持'));
    var self = this;
    return new Promise(function (resolve, reject) {
      var w;
      try {
        w = new Worker(self.workerUrl);
      } catch (e) { reject(e); return; }
      var ready = false;
      var timer = setTimeout(function () {
        if (ready) return;
        try { w.terminate(); } catch (e) {}
        reject(new Error('Worker 启动超时（file:// 协议下浏览器会禁止加载 Worker）'));
      }, 3000);
      w.onmessage = function (ev) {
        var d = ev.data;
        if (!d) return;
        if (d.__cmt === 'ready') {
          ready = true; clearTimeout(timer);
          self._worker = w; resolve(w);
          return;
        }
        if (d.__cmt === 'rpc') {
          var p = self._pending.get(d.id);
          if (!p) return;
          self._pending.delete(d.id);
          if (d.error) p.reject(new Error(d.error)); else p.resolve(d.result);
        }
      };
      w.onerror = function (e) {
        clearTimeout(timer);
        try { w.terminate(); } catch (err) {}
        reject(new Error('Worker 加载失败: ' + (e.message || self.workerUrl)));
      };
    });
  };

  WorkerAdapter.prototype._rpc = function (action, key, value, meta) {
    var self = this;
    return this._ensure().then(function (w) {
      var id = ++self._seq;
      var def = CMT.util.deferred();
      self._pending.set(id, def);
      w.postMessage({ __cmt: 'rpc', id: id, db: self.dbName, action: action, key: key, value: value, meta: meta });
      return def.promise;
    });
  };

  WorkerAdapter.prototype.get = function (key) { return this._rpc('get', key); };
  WorkerAdapter.prototype.set = function (key, value, meta) { return this._rpc('set', key, value, meta); };
  WorkerAdapter.prototype.remove = function (key) { return this._rpc('remove', key); };
  WorkerAdapter.prototype.keys = function () { return this._rpc('keys'); };
  WorkerAdapter.prototype.all = function () { return this._rpc('all'); };
  WorkerAdapter.prototype.clearAll = function () { return this._rpc('clear'); };
  WorkerAdapter.prototype.close = function () {
    if (this._worker) { try { this._worker.terminate(); } catch (e) {} this._worker = null; }
  };
  WorkerAdapter.prototype.info = function () {
    return Promise.resolve({ type: 'indexedDB-worker', quota: null, usage: null });
  };

  /* 创建 IDB 适配器：先尝试 Worker，失败则回退主线程 */
  function createIdbAdapter(options) {
    options = options || {};
    if (options.useWorker === false) {
      return Promise.resolve({ adapter: new IdbAdapter(options.dbName), via: 'main-thread', reason: null });
    }
    var wa = new WorkerAdapter(options.workerUrl, options.dbName);
    return wa._ensure().then(function () {
      return { adapter: wa, via: 'worker', reason: null };
    }, function (err) {
      if (!isAvailable()) return Promise.reject(err);
      return { adapter: new IdbAdapter(options.dbName), via: 'main-thread', reason: err.message };
    });
  }

  CMT.IdbAdapter = IdbAdapter;
  CMT.WorkerAdapter = WorkerAdapter;
  CMT.createIdbAdapter = createIdbAdapter;
  CMT.storageIdb = { isAvailable: isAvailable };
})();
