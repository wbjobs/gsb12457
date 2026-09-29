// 迁移引擎：快照 -> 逐条迁移 -> 校验 -> （可选）删除原 Cookie。
// 支持：进度回调、失败计数、自动降级（含降级原因）、中断回滚、手动回滚。
// 回滚日志（journal）持久化到 localStorage，页面崩溃/刷新后仍可回滚。

import { LocalStorageAdapter, IndexedDBAdapter } from './storage.js';
import { deleteCookie, setCookie } from './cookieStore.js';
import { hashText } from './hash.js';

const JOURNAL_KEY = '__cm_journal__';
const yieldToUI = () => new Promise(r => setTimeout(r, 0));

function makeAdapters() {
  return {
    localStorage: new LocalStorageAdapter(),
    indexedDB: new IndexedDBAdapter(),
  };
}

export function loadJournal() {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveJournal(journal) {
  try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal)); } catch { /* 内存中仍有 */ }
}

function clearJournal() {
  try { localStorage.removeItem(JOURNAL_KEY); } catch { /* ignore */ }
}

export class Migrator {
  constructor({ onProgress, onLog } = {}) {
    this.onProgress = onProgress || (() => {});
    this.onLog = onLog || (() => {});
    this.aborted = false;
    this.running = false;
    this.journal = null;
  }

  abort() { this.aborted = true; }

  _log(level, msg) { this.onLog(level, msg); }

  _emitProgress(stats) { this.onProgress({ ...stats }); }

  async migrate(cookies, { preferred = 'localStorage', deleteAfter = false, autoFallback = true } = {}) {
    this.aborted = false;
    this.running = true;

    const adapters = makeAdapters();
    const chain = preferred === 'indexedDB'
      ? ['indexedDB', 'localStorage']
      : ['localStorage', 'indexedDB'];

    const stats = { total: cookies.length, done: 0, success: 0, failed: 0, fallback: 0, status: '迁移中' };
    this.journal = { createdAt: Date.now(), entries: [], finished: false };
    saveJournal(this.journal);
    this._emitProgress(stats);

    for (const cookie of cookies) {
      if (this.aborted) {
        this._log('warn', '迁移被中断，开始自动回滚已写入的数据…');
        await this.rollback();
        stats.status = '已中断并回滚';
        this._emitProgress(stats);
        this.running = false;
        return stats;
      }

      const payload = {
        name: cookie.name,
        value: cookie.value,
        size: cookie.size,
        migratedAt: Date.now(),
        hash: await hashText(cookie.value),
      };

      let migrated = false;
      let lastError = null;
      const tried = autoFallback ? chain : chain.slice(0, 1);

      for (const kind of tried) {
        const adapter = adapters[kind];
        try {
          // 快照目标位置的旧值，供回滚恢复
          const prevValue = await adapter.get(cookie.name);
          await adapter.set(cookie.name, payload);

          // 一致性校验：读回并比对哈希
          const back = await adapter.get(cookie.name);
          const backHash = back ? await hashText(back.value) : null;
          if (!back || backHash !== payload.hash) {
            throw new Error('写后校验失败（数据不一致）');
          }

          this.journal.entries.push({
            name: cookie.name,
            value: cookie.value,
            targetKind: kind,
            prevValue,
            cookieDeleted: false,
          });
          saveJournal(this.journal);

          if (kind !== preferred) {
            stats.fallback++;
            this._log('warn', `「${cookie.name}」降级到 ${kind}：${preferred} 写入失败（${lastError}）`);
          }
          migrated = true;
          break;
        } catch (err) {
          lastError = err && err.name === 'QuotaExceededError' ? '存储配额已满' : String(err && err.message || err);
          this._log('warn', `「${cookie.name}」写入 ${kind} 失败：${lastError}`);
          try { await adapter.delete(cookie.name); } catch { /* 清理残留 */ }
        }
      }

      if (migrated) {
        stats.success++;
        if (deleteAfter) {
          deleteCookie(cookie.name);
          this.journal.entries[this.journal.entries.length - 1].cookieDeleted = true;
          saveJournal(this.journal);
          this._log('ok', `「${cookie.name}」迁移成功，原 Cookie 已删除`);
        } else {
          this._log('ok', `「${cookie.name}」迁移成功（${cookie.size} 字节）`);
        }
      } else {
        stats.failed++;
        this._log('err', `「${cookie.name}」迁移失败：${lastError}`);
      }

      stats.done++;
      this._emitProgress(stats);
      await yieldToUI();
    }

    this.journal.finished = true;
    saveJournal(this.journal);
    stats.status = stats.failed === 0 ? '迁移完成' : `完成，${stats.failed} 条失败`;
    this._emitProgress(stats);
    this.running = false;
    return stats;
  }

  // 回滚：恢复目标存储的旧值、删除新写入的键、还原被删除的 Cookie
  async rollback(journal = this.journal) {
    if (!journal || !journal.entries.length) {
      this._log('warn', '没有可回滚的记录');
      clearJournal();
      return 0;
    }
    const adapters = makeAdapters();
    let restored = 0;

    for (const entry of [...journal.entries].reverse()) {
      const adapter = adapters[entry.targetKind];
      try {
        if (entry.prevValue === undefined || entry.prevValue === null) {
          await adapter.delete(entry.name);
        } else {
          await adapter.set(entry.name, entry.prevValue);
        }
        if (entry.cookieDeleted) {
          setCookie(entry.name, entry.value);
        }
        restored++;
      } catch (err) {
        this._log('err', `回滚「${entry.name}」失败：${err && err.message || err}`);
      }
    }

    this._log('ok', `回滚完成，恢复 ${restored}/${journal.entries.length} 条`);
    clearJournal();
    this.journal = null;
    return restored;
  }
}
