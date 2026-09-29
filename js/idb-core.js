/* IndexedDB 极简 Promise 封装，主线程与 Web Worker 均可加载（无 window 依赖）。
 * 存储模型：固定 database/store，记录为 { key, value, meta }。
 */
(function (root) {
  'use strict';
  var CMT = (root.CMT = root.CMT || {});

  function getIndexedDB() {
    if (typeof indexedDB !== 'undefined') return indexedDB;
    if (typeof window !== 'undefined') {
      return window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
    }
    return null;
  }

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IDB request error')); };
      request.onblocked = function () { reject(new Error('IDB blocked: 请关闭其它打开该数据库的标签页')); };
    });
  }

  function openDB(name, version) {
    var idb = getIndexedDB();
    return new Promise(function (resolve, reject) {
      if (!idb) { reject(new Error('IndexedDB 不可用')); return; }
      var req;
      try {
        req = idb.open(name, version);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打开数据库失败')); };
      req.onblocked = function () { reject(new Error('数据库升级被阻塞')); };
    });
  }

  function tx(db, stores, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(stores, mode);
      var storeNames = Array.isArray(stores) ? stores : [stores];
      var handles = storeNames.map(function (n) { return t.objectStore(n); });
      var maybePromise;
      try {
        maybePromise = fn.apply(null, handles.length === 1 ? [handles[0], t] : handles.concat([t]));
      } catch (e) { reject(e); return; }
      t.oncomplete = function () {
        Promise.resolve(maybePromise).then(resolve, reject);
      };
      t.onerror = function () { reject(t.error || new Error('事务失败')); };
      t.onabort = function () { reject(t.error || new Error('事务中止')); };
    });
  }

  function IdbKV(dbName, version) {
    this.dbName = dbName || 'cmt-migration';
    this.version = version || 1;
    this._db = null;
  }

  IdbKV.prototype._open = function () {
    var self = this;
    if (this._db) return Promise.resolve(this._db);
    return openDB(this.dbName, this.version).then(function (db) { self._db = db; return db; });
  };

  IdbKV.prototype.get = function (key) {
    return this._open().then(function (db) {
      return tx(db, 'kv', 'readonly', function (store) {
        return reqToPromise(store.get(key));
      });
    });
  };

  IdbKV.prototype.set = function (key, value, meta) {
    var record = { key: key, value: value, meta: meta || {} };
    return this._open().then(function (db) {
      return tx(db, 'kv', 'readwrite', function (store) {
        return reqToPromise(store.put(record));
      });
    }).then(function () { return record; });
  };

  IdbKV.prototype.delete = function (key) {
    return this._open().then(function (db) {
      return tx(db, 'kv', 'readwrite', function (store) {
        return reqToPromise(store.delete(key));
      });
    });
  };

  IdbKV.prototype.keys = function () {
    return this._open().then(function (db) {
      return tx(db, 'kv', 'readonly', function (store) {
        return reqToPromise(store.getAllKeys());
      });
    });
  };

  IdbKV.prototype.all = function () {
    return this._open().then(function (db) {
      return tx(db, 'kv', 'readonly', function (store) {
        return reqToPromise(store.getAll());
      });
    });
  };

  IdbKV.prototype.close = function () {
    if (this._db) { try { this._db.close(); } catch (e) {} this._db = null; }
  };

  CMT.IdbKV = IdbKV;
  CMT.idbCore = { openDB: openDB, reqToPromise: reqToPromise, tx: tx, getIndexedDB: getIndexedDB };
})(typeof self !== 'undefined' ? self : this);
