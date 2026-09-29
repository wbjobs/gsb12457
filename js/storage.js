// 存储适配层：localStorage 与 IndexedDB 统一为相同接口。
// get / set / delete / keys / snapshot / restore，供迁移引擎与回滚使用。

const LS_PREFIX = 'migrated:';
const IDB_NAME = 'cookie-migration';
const IDB_STORE = 'kv';

export class LocalStorageAdapter {
  constructor() { this.kind = 'localStorage'; }

  static isAvailable() {
    try {
      const k = '__probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch {
      return false; // 隐私模式 / 被禁用 / 配额为 0
    }
  }

  async set(key, value) {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); // 可能抛 QuotaExceededError
  }

  async get(key) {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  }

  async delete(key) { localStorage.removeItem(LS_PREFIX + key); }

  async keys() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) out.push(k.slice(LS_PREFIX.length));
    }
    return out;
  }
}

export class IndexedDBAdapter {
  constructor() { this.kind = 'indexedDB'; this._db = null; }

  static isAvailable() {
    return typeof indexedDB !== 'undefined';
  }

  async _open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
      req.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞'));
    });
    return this._db;
  }

  _tx(mode, fn) {
    return this._open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const store = tx.objectStore(IDB_STORE);
      const result = fn(store);
      tx.oncomplete = () => resolve(result && result._value !== undefined ? result._value : undefined);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
    }));
  }

  async set(key, value) {
    await this._tx('readwrite', store => store.put(value, key));
  }

  async get(key) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(key) {
    await this._tx('readwrite', store => store.delete(key));
  }

  async keys() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result.map(String));
      req.onerror = () => reject(req.error);
    });
  }
}

// 按优先级构建可用目标链：localStorage -> indexedDB
export function buildFallbackChain(preferred) {
  const order = preferred === 'indexedDB'
    ? [IndexedDBAdapter, LocalStorageAdapter]
    : [LocalStorageAdapter, IndexedDBAdapter];
  return order;
}
