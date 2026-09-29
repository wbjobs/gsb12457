/* 迁移编排器：
 * 1. 迁移前写 journal（先落日志，再写数据），中断后可 resume / rollback。
 * 2. 目标存储按链降级：indexedDB -> localStorage -> memory（均可自定义顺序）。
 * 3. 每条数据写后读回 + 校验和比对，保证降级后数据一致。
 * 4. 回滚时删除目标数据，并尽力还原源 Cookie（按能力检测修正 SameSite/分区属性）。
 */
(function () {
  'use strict';
  var CMT = (window.CMT = window.CMT || {});
  var u = CMT.util;

  var JOURNAL_LS_PREFIX = '__cmt_journal__:';
  var RUN_INDEX_KEY = '__cmt_runs__';

  /* ---------------- Journal 存储（LS 优先，IDB 次之，内存兜底） ---------------- */
  function JournalStore() {
    this.backend = null;
    this.idb = null;
  }
  JournalStore.prototype.init = function () {
    var self = this;
    if (CMT.storageLocal.isAvailable()) {
      this.backend = 'localStorage';
      return Promise.resolve();
    }
    if (CMT.storageIdb.isAvailable()) {
      self.idb = new CMT.IdbKV('cmt-journal', 1);
      return self.idb.get('__probe__').then(function () {
        self.backend = 'indexedDB';
      }, function () {
        self.backend = 'memory';
        self.mem = new Map();
      });
    }
    this.backend = 'memory';
    this.mem = new Map();
    return Promise.resolve();
  };
  JournalStore.prototype.save = function (doc) {
    doc.updatedAt = Date.now();
    var raw = JSON.stringify(doc);
    if (this.backend === 'localStorage') {
      try {
        localStorage.setItem(JOURNAL_LS_PREFIX + doc.id, raw);
        return Promise.resolve();
      } catch (e) {
        this.backend = 'memory'; this.mem = this.mem || new Map();
      }
    }
    if (this.backend === 'indexedDB') {
      return this.idb.set(doc.id, raw).then(function () {}, function () {
        this.backend = 'memory'; this.mem = this.mem || new Map();
        this.mem.set(doc.id, raw);
      }.bind(this));
    }
    this.mem.set(doc.id, raw);
    return Promise.resolve();
  };
  JournalStore.prototype.load = function (id) {
    if (this.backend === 'localStorage') {
      var raw = localStorage.getItem(JOURNAL_LS_PREFIX + id);
      return Promise.resolve(raw ? JSON.parse(raw) : null);
    }
    if (this.backend === 'indexedDB') {
      return this.idb.get(id).then(function (r) { return r ? JSON.parse(r.v) : null; });
    }
    var m = this.mem.get(id);
    return Promise.resolve(m ? JSON.parse(m) : null);
  };
  JournalStore.prototype.list = function () {
    if (this.backend === 'localStorage') {
      var out = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(JOURNAL_LS_PREFIX) === 0) {
          try { out.push(JSON.parse(localStorage.getItem(k))); } catch (e) {}
        }
      }
      return Promise.resolve(out.sort(byTime));
    }
    if (this.backend === 'indexedDB') {
      return this.idb.all().then(function (rows) {
        return rows.map(function (r) { try { return JSON.parse(r.v); } catch (e) { return null; } })
          .filter(Boolean).sort(byTime);
      });
    }
    return Promise.resolve(Array.from(this.mem.values()).map(function (s) {
      try { return JSON.parse(s); } catch (e) { return null; }
    }).filter(Boolean).sort(byTime));
  };
  JournalStore.prototype.remove = function (id) {
    if (this.backend === 'localStorage') { localStorage.removeItem(JOURNAL_LS_PREFIX + id); return Promise.resolve(); }
    if (this.backend === 'indexedDB') return this.idb.delete(id);
    this.mem.delete(id);
    return Promise.resolve();
  };
  function byTime(a, b) { return b.startedAt - a.startedAt; }

  /* ---------------- Migrator ---------------- */
  function Migrator(options) {
    options = options || {};
    this.options = Object.assign({
      target: 'auto',           // auto | indexeddb | localStorage | memory
      targetOrder: ['indexedDB', 'localStorage', 'memory'],
      useWorker: true,
      workerUrl: 'worker/idb-worker.js',
      dbName: 'cmt-migration',
      deleteSource: false,      // 默认保留源 Cookie；true 表示成功迁移后删除
      failFast: false,
      simulateCrashAt: 0,       // >0：迁移到第 N 条后模拟崩溃（中断恢复演示）
      excludeProbes: true,
      onEvent: null
    }, options);
    this.journals = new JournalStore();
    this.adapters = new Map();
    this.aborted = false;
  }

  Migrator.prototype._emit = function (type, payload) {
    if (typeof this.options.onEvent === 'function') {
      try { this.options.onEvent(Object.assign({ type: type, at: Date.now() }, payload)); } catch (e) {}
    }
  };

  Migrator.prototype._init = function () {
    if (this._ready) return this._ready;
    this._ready = this.journals.init();
    return this._ready;
  };

  /* 根据能力检测 + 配置，返回按优先级排列的目标类型 */
  Migrator.prototype._planTargets = function (caps) {
    var order = this.options.targetOrder.slice();
    if (this.options.target !== 'auto') order = [this.options.target];
    var usable = [];
    var rejected = [];
    order.forEach(function (t) {
      if (t === 'localStorage') {
        var ls = caps.localStorage || {};
        if (ls.available) usable.push('localStorage');
        else rejected.push({ target: 'localStorage', reason: 'localStorage 不可用：' + (ls.error || '被禁用或处于隐私模式') });
      } else if (t === 'indexedDB') {
        var idb = caps.indexedDB || {};
        if (idb.available) usable.push('indexedDB');
        else rejected.push({ target: 'indexedDB', reason: 'IndexedDB 不可用：' + (idb.error || '被禁用') });
      } else if (t === 'memory') {
        usable.push('memory');
      }
    });
    /* 第三方上下文中 LS/IDB 实测被禁：运行时错误会在写入时把条目降级到 memory */
    return { usable: usable, rejected: rejected };
  };

  Migrator.prototype._getAdapter = function (type) {
    if (this.adapters.has(type)) return this.adapters.get(type);
    var promise;
    if (type === 'localStorage') {
      promise = Promise.resolve(new CMT.LocalAdapter(this.options.dbName));
    } else if (type === 'indexedDB') {
      promise = CMT.createIdbAdapter({
        useWorker: this.options.useWorker,
        workerUrl: this.options.workerUrl,
        dbName: this.options.dbName
      }).then(function (r) {
        this._workerInfo = { via: r.via, reason: r.reason };
        return r.adapter;
      }.bind(this));
    } else {
      promise = Promise.resolve(new CMT.MemoryAdapter());
    }
    this.adapters.set(type, promise);
    return promise;
  };

  /* ---------------- 开始迁移 ---------------- */
  Migrator.prototype.start = function (caps, cookies) {
    var self = this;
    this.aborted = false;
    var runId = u.uid('run');
    var plan = this._planTargets(caps || {});
    var warnings = plan.rejected.slice();
    var tp = caps && caps.thirdParty;
    if (tp && tp.confidence === 'runtime') {
      if (tp.localStorage === false) warnings.push({ target: 'localStorage', reason: '第三方上下文中 localStorage 被禁' });
      if (tp.indexedDB === false) warnings.push({ target: 'indexedDB', reason: '第三方上下文中 IndexedDB 被禁' });
      if (tp.cookies === false) warnings.push({ target: 'cookies', reason: '第三方 Cookie 被禁，源数据删除后将无法回写恢复' });
    } else if (tp && tp.context === 'third-party' && tp.confidence === 'unknown') {
      warnings.push({ target: 'third-party', reason: '第三方 Cookie/存储状态未知（未提供跨站探测页），按可能受限处理' });
    }

    var doc;
    return this._init().then(function () {
      return CMT.cookie.readAll();
    }).then(function (all) {
      var list = cookies || all;
      if (self.options.excludeProbes) {
        list = list.filter(function (c) { return c.name.indexOf('__cmt_probe') !== 0; });
      }
      var entries = list.map(function (c) {
        var checksum = u.fnv1a(JSON.stringify({ n: c.name, v: c.value }));
        return {
          id: u.uid('item'),
          name: c.name,
          source: { value: c.value, attrs: c.attrs, size: c.size },
          checksum: checksum,
          size: c.size,
          status: 'pending',
          target: null,
          attempts: [],
          error: null
        };
      });
      doc = {
        id: runId,
        state: 'running',
        startedAt: Date.now(),
        finishedAt: null,
        plan: plan.usable,
        warnings: warnings,
        workerInfo: null,
        deleteSource: self.options.deleteSource,
        total: entries.length,
        entries: entries
      };
      self._emit('run-start', { runId: runId, total: entries.length, plan: plan.usable, warnings: warnings });
      return self.journals.save(doc).then(function () { return doc; });
    }).then(function () {
      return self._runEntries(doc, caps);
    }).then(function () {
      return self._finish(doc);
    }, function (err) {
      if (err && err.crashed) { err.doc = doc; throw err; }
      throw err;
    }).then(function () { return self._summary(doc); });
  };

  Migrator.prototype._runEntries = function (doc, caps) {
    var self = this;
    var i = 0;
    function next() {
      if (self.aborted) {
        doc.state = 'aborted';
        self._emit('run-abort', { runId: doc.id });
        return self.journals.save(doc);
      }
      if (i >= doc.entries.length) return Promise.resolve();
      var index = i++;
      var entry = doc.entries[index];
      if (entry.status === 'migrated' || entry.status === 'failed') {
        return self.journals.save(doc).then(next);
      }
      var startedAt = Date.now();
      self._emit('item-start', { runId: doc.id, index: index, name: entry.name, size: entry.size });
      return self._migrateOne(doc, entry, caps).then(function (migrated) {
        var done = doc.entries.filter(function (e) {
          return e.status === 'migrated' || e.status === 'failed';
        }).length;
        self._emit('item-done', {
          runId: doc.id, index: index, name: entry.name,
          status: entry.status, target: entry.target,
          degraded: (entry.attempts || []).length > 1,
          attempts: entry.attempts, error: entry.error,
          duration: Date.now() - startedAt,
          progress: done, total: doc.total,
          percent: Math.round((done / doc.total) * 100)
        });
        return self.journals.save(doc).then(u.tick).then(function () {
          if (self.options.simulateCrashAt &&
              doc.entries.filter(function (e) { return e.status === 'migrated'; }).length >= self.options.simulateCrashAt) {
            var crash = new Error('模拟迁移中断（第 ' + self.options.simulateCrashAt + ' 条后崩溃）');
            crash.crashed = true;
            doc.state = 'interrupted';
            self._emit('run-crash', { runId: doc.id, reason: crash.message });
            return self.journals.save(doc).then(function () { throw crash; });
          }
        }).then(next);
      });
    }
    return next();
  };

  /* 单条：沿目标链写入 + 读回校验 */
  Migrator.prototype._migrateOne = function (doc, entry, caps) {
    var self = this;
    var chain = doc.plan.slice();
    if (self.options.target !== 'auto' && chain.indexOf(self.options.target) !== -1) {
      chain = chain.filter(function (t) { return t === self.options.target; })
        .concat(chain.filter(function (t) { return t !== self.options.target; }));
    }
    return chain.reduce(function (p, targetType) {
      return p.then(function (result) {
        if (result) return result;
        return self._writeAndVerify(targetType, entry).then(function () {
          entry.status = 'migrated';
          entry.target = targetType;
          entry.targetKey = entry.name;
          return true;
        }, function (err) {
          entry.attempts.push({
            target: targetType,
            reason: friendlyReason(err, targetType, caps),
            isQuota: !!(err && err.isQuota),
            at: Date.now()
          });
          self._emit('item-degrade', {
            runId: doc.id, name: entry.name,
            from: targetType,
            next: chain[chain.indexOf(targetType) + 1] || null,
            reason: friendlyReason(err, targetType, caps)
          });
          return null;
        });
      });
    }, Promise.resolve(null)).then(function (migrated) {
      if (!migrated) {
        entry.status = 'failed';
        entry.error = (entry.attempts[entry.attempts.length - 1] || {}).reason || '所有目标存储均不可用';
        if (self.options.failFast) {
          var e = new Error('failFast: ' + entry.name + ' 迁移失败 - ' + entry.error);
          e.failFast = true;
          throw e;
        }
      }
      return migrated;
    });
  };

  Migrator.prototype._writeAndVerify = function (targetType, entry) {
    var self = this;
    return self._getAdapter(targetType).then(function (adapter) {
      var meta = {
        source: 'cookie', migratedAt: Date.now(),
        originalSize: entry.size,
        originalAttrs: entry.source.attrs,
        checksum: entry.checksum
      };
      return adapter.set(entry.name, entry.source.value, meta).then(function () {
        return adapter.get(entry.name);
      }).then(function (record) {
        if (!record) throw verifyError('写后读回为空（存储可能被策略阻止）');
        var readValue = record.v != null ? record.v : (record.value != null ? record.value : record);
        if (String(readValue) !== String(entry.source.value)) {
          throw verifyError('读回值与源 Cookie 不一致');
        }
        var recheck = u.fnv1a(JSON.stringify({ n: entry.name, v: String(readValue) }));
        if (recheck !== entry.checksum) throw verifyError('校验和不一致（期望 ' + entry.checksum + '，实际 ' + recheck + '）');
      });
    });
  };
  function verifyError(msg) { var e = new Error(msg); e.verifyFailed = true; return e; }

  function friendlyReason(err, targetType, caps) {
    if (!err) return '未知错误';
    if (err.verifyFailed) return err.message;
    if (err.isQuota) {
      return targetType + ' 容量超限（QuotaExceededError），自动降级';
    }
    if (/SecurityError|access.*denied|insecure/i.test(err.message || '')) {
      return targetType + ' 被安全策略/第三方策略拒绝：' + err.message;
    }
    if (/Worker/.test(err.message || '')) {
      return 'Worker 不可用（' + err.message + '），已回退主线程';
    }
    return u.errName(err) + ': ' + (err.message || '');
  }

  /* 单条 Cookie 大小超限检查（迁移前用能力检测的 cookieMaxBytes 判定） */
  Migrator.checkOversize = function (cookies, caps) {
    var limit = caps && caps.cookieMaxBytes ? caps.cookieMaxBytes.value : 4096;
    return cookies.map(function (c) {
      return {
        name: c.name,
        size: c.size,
        limit: limit,
        oversize: c.size > limit
      };
    }).filter(function (r) { return r.oversize; });
  };

  Migrator.prototype._finish = function (doc) {
    var self = this;
    doc.workerInfo = this._workerInfo || null;
    if (doc.state === 'aborted' || doc.state === 'interrupted') {
      return self.journals.save(doc);
    }
    var failed = doc.entries.filter(function (e) { return e.status === 'failed'; });
    doc.state = failed.length === doc.entries.length ? 'failed' : (failed.length ? 'partial' : 'completed');
    if (doc.state === 'completed' && this.options.deleteSource) {
      doc.entries.forEach(function (entry) {
        var removed = CMT.cookie.removeCookie(entry.name, entry.source.attrs || {});
        entry.sourceDeleted = removed;
        if (!removed) {
          doc.warnings.push({ target: 'cookies', reason: '源 Cookie 删除失败: ' + entry.name });
        }
      });
    }
    doc.finishedAt = Date.now();
    self._emit('run-finish', self._summary(doc));
    return self.journals.save(doc);
  };

  Migrator.prototype._summary = function (doc) {
    var migrated = doc.entries.filter(function (e) { return e.status === 'migrated'; });
    var failed = doc.entries.filter(function (e) { return e.status === 'failed'; });
    var pending = doc.entries.filter(function (e) { return e.status === 'pending'; });
    var byTarget = {};
    migrated.forEach(function (e) { byTarget[e.target] = (byTarget[e.target] || 0) + 1; });
    var degraded = migrated.filter(function (e) { return (e.attempts || []).length > 0; });
    return {
      runId: doc.id,
      state: doc.state,
      total: doc.total,
      migrated: migrated.length,
      failed: failed.length,
      pending: pending.length,
      byTarget: byTarget,
      degraded: degraded.length,
      warnings: doc.warnings,
      workerInfo: doc.workerInfo,
      entries: doc.entries
    };
  };

  Migrator.prototype.getSummary = function (runId) {
    return this._init().then(function () {}).then(this.journals.load.bind(this.journals, runId))
      .then(function (doc) { return doc ? this._summary(doc) : null; }.bind(this));
  };

  Migrator.prototype.listRuns = function () {
    return this._init().then(function () {}).then(this.journals.list.bind(this.journals));
  };

  Migrator.prototype.abort = function () { this.aborted = true; };

  /* 断点续传：重放 pending 条目，已 migrated/failed 的保持不变（可重入） */
  Migrator.prototype.resume = function (runId, caps) {
    var self = this;
    this.aborted = false;
    return this._init().then(function () {
      return self.journals.load(runId);
    }).then(function (doc) {
      if (!doc) throw new Error('找不到迁移日志: ' + runId);
      if (doc.state === 'completed') return self._summary(doc);
      doc.state = 'running';
      self._emit('run-resume', { runId: doc.id });
      return self.journals.save(doc).then(function () {
        return self._runEntries(doc, caps);
      }).then(function () {
        return self._finish(doc);
      }).then(function () { return self._summary(doc); });
    });
  };

  /* ---------------- 回滚 ---------------- */
  Migrator.prototype.rollback = function (runId, caps) {
    var self = this;
    return this._init().then(function () {
      return self.journals.load(runId);
    }).then(function (doc) {
      if (!doc) throw new Error('找不到迁移日志: ' + runId);
      self._emit('rollback-start', { runId: runId, total: doc.total });
      var restored = 0, deleted = 0, failures = [];
      var groups = new Map();
      doc.entries.forEach(function (e) {
        if (!e.target || e.status !== 'migrated') return;
        if (!groups.has(e.target)) groups.set(e.target, []);
        groups.get(e.target).push(e);
      });

      var chain = Promise.resolve();
      groups.forEach(function (entries, targetType) {
        chain = chain.then(function () {
          return self._getAdapter(targetType);
        }).then(function (adapter) {
          return entries.reduce(function (p, entry, idx) {
            return p.then(function () {
              /* 1) 还原源 Cookie（按能力检测修正属性，SameSite/分区不支持则降级属性） */
              var restore = self._restoreCookie(entry, caps);
              if (restore.ok) restored++;
              else failures.push({ name: entry.name, phase: 'restore-cookie', reason: restore.reason });
              /* 2) 删除目标存储里的副本 */
              return adapter.remove(entry.targetKey || entry.name).then(function () {
                deleted++;
                entry.status = 'rolled-back';
              }, function (err) {
                failures.push({ name: entry.name, phase: 'remove-target', reason: friendlyReason(err, targetType, caps) });
              }).then(function () {
                self._emit('rollback-progress', {
                  runId: runId,
                  done: restored + failures.filter(function (f) { return f.phase === 'restore-cookie'; }).length,
                  total: doc.total,
                  percent: Math.round(((restored + failures.filter(function (f) { return f.phase === 'restore-cookie'; }).length) / doc.total) * 100),
                  name: entry.name
                });
                return self.journals.save(doc);
              });
            });
          }, Promise.resolve());
        });
      });

      return chain.then(function () {
        /* 3) 校验：回滚后源 Cookie 全部可读且值一致 */
        return CMT.cookie.readAll().then(function (jar) {
          var jarMap = new Map(jar.map(function (c) { return [c.name, c.value]; }));
          doc.entries.forEach(function (entry) {
            if (entry.status !== 'rolled-back') return;
            if (!jarMap.has(entry.name)) {
              failures.push({ name: entry.name, phase: 'verify', reason: '回滚后源 Cookie 不存在' });
            } else if (jarMap.get(entry.name) !== entry.source.value) {
              failures.push({ name: entry.name, phase: 'verify', reason: '回滚后值不一致' });
            }
          });
        });
      }).then(function () {
        doc.state = failures.length ? 'rollback-partial' : 'rolled-back';
        doc.finishedAt = Date.now();
        doc.rollback = { restored: restored, deleted: deleted, failures: failures };
        return self.journals.save(doc);
      }).then(function () {
        var summary = Object.assign(self._summary(doc), { rollback: doc.rollback });
        self._emit('rollback-finish', summary);
        return summary;
      });
    });
  };

  /* 按能力检测修正 Cookie 属性后写回，规避 SameSite=None / partitioned 不支持 */
  Migrator.prototype._restoreCookie = function (entry, caps) {
    var attrs = Object.assign({ path: '/' }, entry.source.attrs || {});
    var reasons = [];
    /* 已存在且值一致，视为还原成功（幂等） */
    var current = CMT.cookie.parseJar().get(entry.name);
    if (current === entry.source.value) {
      return { ok: true, alreadyPresent: true };
    }
    if (caps && caps.cookieMaxBytes && entry.size > caps.cookieMaxBytes.value) {
      return { ok: false, reason: 'Cookie 超过当前浏览器 ' + caps.cookieMaxBytes.value + ' 字节上限，无法还原' };
    }
    if (attrs.sameSite === 'none' && caps && caps.sameSite && caps.sameSite.none === false) {
      attrs.sameSite = 'lax';
      delete attrs.secure;
      reasons.push('SameSite=None 不支持，降级为 Lax');
    }
    if (attrs.sameSite === 'strict' && caps && caps.sameSite && caps.sameSite.strict === false) {
      attrs.sameSite = 'lax';
      reasons.push('SameSite=Strict 不支持，降级为 Lax');
    }
    if (attrs.partitioned && caps && caps.partitioned && caps.partitioned.supported === false) {
      delete attrs.partitioned;
      if (attrs.sameSite === 'none') attrs.sameSite = 'lax';
      reasons.push('分区 Cookie 不支持，移除 partitioned 并降级 SameSite');
    }
    var tp = caps && caps.thirdParty;
    if (tp && tp.context === 'third-party' && tp.cookies === false) {
      return { ok: false, reason: '第三方 Cookie 被禁，无法写回；目标数据已保留在 ' + entry.target };
    }
    delete attrs.expires;
    delete attrs.httpOnly;
    var r = CMT.cookie.setCookie(entry.name, entry.source.value, attrs);
    if (!r.ok) {
      /* 最后兜底：去掉所有现代属性再写一次 */
      var fallback = { path: attrs.path || '/' };
      var r2 = CMT.cookie.setCookie(entry.name, entry.source.value, fallback);
      if (!r2.ok) return { ok: false, reason: '浏览器拒绝写入 Cookie' };
      reasons.push('去除 secure/sameSite 后写入成功');
    }
    var verify = CMT.cookie.parseJar().get(entry.name);
    if (verify !== entry.source.value) {
      return { ok: false, reason: '写回校验失败' };
    }
    return { ok: true, reasons: reasons };
  };

  /* ---------------- 迁移后一致性校验（源 vs 目标，全量） ---------------- */
  Migrator.prototype.verifyConsistency = function (runId) {
    var self = this;
    return this._init().then(function () {
      return self.journals.load(runId);
    }).then(function (doc) {
      if (!doc) throw new Error('找不到迁移日志: ' + runId);
      var migrated = doc.entries.filter(function (e) { return e.status === 'migrated'; });
      var groups = new Map();
      migrated.forEach(function (e) {
        if (!groups.has(e.target)) groups.set(e.target, []);
        groups.get(e.target).push(e);
      });
      var mismatches = [];
      var chain = Promise.resolve();
      groups.forEach(function (entries, targetType) {
        chain = chain.then(function () { return self._getAdapter(targetType); }).then(function (adapter) {
          return entries.reduce(function (p, entry) {
            return p.then(function () {
              return adapter.get(entry.targetKey || entry.name).then(function (record) {
                var readValue = record == null ? null
                  : (record.v != null ? record.v : (record.value != null ? record.value : record));
                if (String(readValue) !== String(entry.source.value)) {
                  mismatches.push({
                    name: entry.name, target: targetType,
                    reason: readValue == null ? '目标中不存在该数据' : '值与源不一致'
                  });
                } else if (record && record.meta && record.meta.checksum &&
                  record.meta.checksum !== entry.checksum) {
                  mismatches.push({ name: entry.name, target: targetType, reason: '校验和不匹配' });
                }
              });
            });
          }, Promise.resolve());
        });
      });
      return chain.then(function () {
        var sourceJar = CMT.cookie.parseJar();
        var sourceMissing = [];
        if (!doc.deleteSource) {
          migrated.forEach(function (e) {
            if (!sourceJar.has(e.name)) sourceMissing.push(e.name);
          });
        }
        var result = {
          runId: runId,
          consistent: mismatches.length === 0,
          checked: migrated.length,
          mismatches: mismatches,
          sourceMissing: sourceMissing
        };
        self._emit('verify', result);
        return result;
      });
    });
  };

  Migrator.prototype.deleteJournal = function (runId) {
    return this._init().then(this.journals.remove.bind(this.journals, runId));
  };

  Migrator.prototype.close = function () {
    this.adapters.forEach(function (p) {
      Promise.resolve(p).then(function (a) { if (a && a.close) a.close(); }, function () {});
    });
  };

  CMT.Migrator = Migrator;
})();
