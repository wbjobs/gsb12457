/* IDB Worker：把 IndexedDB 读写移出主线程，避免大批量迁移阻塞 DOM。
 * 消息协议：{ __cmt:'rpc', id, db, action, key, value, meta }
 * action: get/set/remove/keys/all/clear/ping
 */
'use strict';
importScripts('../js/idb-core.js');
/* 注意：importScripts 路径相对 worker 脚本自身解析（worker/idb-worker.js -> ../js/） */

var kvs = Object.create(null);
function kv(dbName) {
  if (!kvs[dbName]) kvs[dbName] = new self.CMT.IdbKV(dbName, 1);
  return kvs[dbName];
}

self.onmessage = function (ev) {
  var d = ev.data;
  if (!d || d.__cmt !== 'rpc') return;
  function reply(result, error) {
    self.postMessage({ __cmt: 'rpc', id: d.id, result: result, error: error || null });
  }
  var store;
  try {
    store = kv(d.db || 'cmt-migration');
  } catch (e) {
    reply(null, '打开数据库失败: ' + e.message);
    return;
  }
  Promise.resolve().then(function () {
    switch (d.action) {
      case 'ping': return 'pong';
      case 'get': return store.get(d.key);
      case 'set': return store.set(d.key, d.value, d.meta).then(function () { return undefined; });
      case 'remove': return store.remove(d.key);
      case 'keys': return store.keys();
      case 'all': return store.all();
      case 'clear': return store.all().then(function (rows) {
        return rows.reduce(function (p, row) {
          return p.then(function () { return store.delete(row.key); });
        }, Promise.resolve());
      });
      default: throw new Error('未知 action: ' + d.action);
    }
  }).then(function (result) { reply(result, null); }, function (err) {
    reply(null, (err && err.message) || String(err));
  });
};

self.postMessage({ __cmt: 'ready' });
