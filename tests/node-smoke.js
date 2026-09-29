/* Node 冒烟测试：用极简浏览器环境桩（document.cookie / localStorage / 内存版 indexedDB）
 * 验证库核心逻辑，不依赖任何第三方包。运行：node tests/node-smoke.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

/* ---------------- 极简浏览器桩 ---------------- */
const store = new Map();
const jar = new Map();

function jarToCookieString() {
  return Array.from(jar.entries())
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('; ');
}
function parseCookieWrite(str) {
  /* 只模拟浏览器行为：max-age=0/expires 过去 => 删除；maxLength 4096 截断丢弃 */
  const first = str.split(';')[0];
  const eq = first.indexOf('=');
  const name = decodeURIComponent(first.slice(0, eq));
  let value = decodeURIComponent(first.slice(eq + 1));
  const lower = str.toLowerCase();
  if (/max-age=0|expires=thu, 01 jan 1970/.test(lower)) { jar.delete(name); return; }
  if (Buffer.byteLength(name + '=' + value, 'utf8') > 4096) return; // 静默丢弃
  jar.set(name, value);
}

global.window = global;
global.self = global;
global.document = {
  get cookie() { return jarToCookieString(); },
  set cookie(v) { parseCookieWrite(v); },
  createElement() { return { style: {}, addEventListener() {}, set src(_) {}, appendChild() {} }; },
  body: { appendChild() {} }
};
Object.defineProperty(global, 'navigator', {
  value: { userAgent: 'NodeTest/1.0', vendor: '', platform: 'linux', storage: { estimate: null } },
  configurable: true, writable: true
});
global.isSecureContext = false;

/* localStorage 桩：默认可用，可切到抛 QuotaExceededError */
let lsThrowQuota = false;
let lsDisabled = false;
global.localStorage = {
  get length() { return store.size; },
  key(i) { return Array.from(store.keys())[i]; },
  getItem(k) { if (lsDisabled) throw new Error('disabled'); return store.has(k) ? store.get(k) : null; },
  setItem(k, v) {
    if (lsDisabled) throw new Error('disabled');
    if (lsThrowQuota) { const e = new Error('QuotaExceeded'); e.name = 'QuotaExceededError'; throw e; }
    store.set(k, String(v));
  },
  removeItem(k) { store.delete(k); }
};

/* indexedDB 桩：可开关；单定时器模拟异步，时序贴近真实事件循环 */
let idbDisabled = false;
let idbRuntimeFail = false;
const idbData = { kv: new Map(), meta: new Map() };

function fakeRequest(execute) {
  const r = {};
  ['onsuccess', 'onerror', 'onupgradeneeded', 'onblocked'].forEach(h => { r[h] = null; });
  setTimeout(() => {
    try {
      execute(r);
      if (r.__fail) { if (r.onerror) r.onerror(); }
      else if (r.onsuccess) r.onsuccess();
    } catch (e) {
      r.error = e;
      if (r.onerror) r.onerror();
    }
  }, 0);
  return r;
}

function fakeStore(name) {
  return {
    put(record) {
      return fakeRequest(r => { idbData[name].set(record.key, record); r.result = record.key; });
    },
    get(key) {
      return fakeRequest(r => { r.result = idbData[name].get(key); });
    },
    delete(key) {
      return fakeRequest(r => { idbData[name].delete(key); r.result = undefined; });
    },
    getAllKeys() {
      return fakeRequest(r => { r.result = Array.from(idbData[name].keys()); });
    },
    getAll() {
      return fakeRequest(r => { r.result = Array.from(idbData[name].values()); });
    }
  };
}

function fakeDB() {
  return {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    close() {},
    transaction(stores) {
      const t = {
        error: null, oncomplete: null, onerror: null, onabort: null,
        objectStore(n) { return fakeStore(n); }
      };
      setTimeout(() => { if (t.oncomplete) t.oncomplete(); }, 1);
      return t;
    }
  };
}

global.indexedDB = {
  open() {
    return fakeRequest(r => {
      if (idbDisabled || idbRuntimeFail) {
        r.__fail = true;
        r.error = Object.assign(new Error('SecurityError: IDB blocked'), { name: 'SecurityError' });
        return;
      }
      r.result = fakeDB();
      if (r.onupgradeneeded) {
        /* upgradeneeded 先于 success；桩里顺序直接调用 */
        r.onsuccess = (orig => () => { if (r.onupgradeneeded) {} ; if (orig) orig(); })(r.onsuccess);
      }
    });
  },
  deleteDatabase() {
    return fakeRequest(r => { r.result = undefined; });
  }
};

/* ---------------- 加载源码（拼到一个作用域） ---------------- */
const root = path.resolve(__dirname, '..');
const files = [
  'js/util.js', 'js/cookie.js', 'js/feature-detect.js', 'js/idb-core.js',
  'js/storage-local.js', 'js/storage-idb.js', 'js/storage-memory.js', 'js/migrator.js'
];
let bundle = '(function(){\n';
files.forEach(f => {
  bundle += fs.readFileSync(path.join(root, f), 'utf8')
    .replace(/^\(function \(\) \{\n'use strict';/, '(function(){')
    .replace(/\(window\.CMT = window\.CMT \|\| \{\}\)/g, '(global.CMT = global.CMT || {})')
    .replace(/var CMT = \(window\.CMT = window\.CMT \|\| \{\}\);/g, 'var CMT = (global.CMT = global.CMT || {});')
    .replace(/\}\)\(\);?\s*$/, '})();');
});
bundle += '\n})();';
eval(bundle);

const CMT = global.CMT;

/* ---------------- 测试用例 ---------------- */
let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++; console.log('  ✓ ' + name);
  }).catch(e => { console.error('  ✗ ' + name); console.error('    ' + (e.stack || e)); process.exitCode = 1; });
}

const events = [];
function migrator(opts) {
  return new CMT.Migrator(Object.assign({
    useWorker: false, target: 'auto', onEvent: e => events.push(e)
  }, opts || {}));
}
const caps = {
  cookieMaxBytes: { value: 4096, confidence: 'runtime' },
  sameSite: { strict: true, lax: true, none: true, confidence: 'runtime' },
  partitioned: { supported: true, confidence: 'runtime' },
  localStorage: { available: true },
  indexedDB: { available: true },
  thirdParty: { context: 'first-party', confidence: 'unknown', cookies: null, localStorage: null, indexedDB: null }
};

function seedJar() {
  jar.clear();
  jar.set('sid', 'abc123');
  jar.set('theme', 'dark');
  jar.set('prefs', JSON.stringify({ lang: 'zh' }));
}

async function main() {
  console.log('Cookie 读取与大小：');
  seedJar();
  let cookies = await CMT.cookie.readAll();
  await test('document.cookie 解析出 3 条键值', () => {
    assert.strictEqual(cookies.length, 3);
    const sid = cookies.find(c => c.name === 'sid');
    assert.strictEqual(sid.value, 'abc123');
    assert.ok(sid.size >= 7);
  });

  console.log('迁移：');
  events.length = 0;
  let m = migrator();
  let summary = await m.start(caps, cookies);
  await test('3 条全部迁移成功，落点 IndexedDB', () => {
    assert.strictEqual(summary.migrated, 3);
    assert.strictEqual(summary.failed, 0);
    assert.strictEqual(summary.byTarget.indexedDB, 3);
  });
  await test('进度事件 percent 最终为 100', () => {
    const done = events.filter(e => e.type === 'item-done');
    assert.strictEqual(done[done.length - 1].percent, 100);
  });
  await test('写后读回 + FNV 校验和一致（库内已验证，无 failed）', () => {
    assert.ok(summary.entries.every(e => e.status === 'migrated'));
  });

  console.log('降级：IndexedDB 不可用 -> localStorage -> memory');
  idbData.kv.clear();
  idbDisabled = true;
  seedJar();
  let m2 = migrator();
  let s2 = await m2.start(caps, await CMT.cookie.readAll());
  await test('IDB 被禁时全部落到 localStorage', () => {
    assert.strictEqual(s2.byTarget.localStorage, 3);
  });
  idbData.kv.clear();
  store.clear();
  idbDisabled = false;
  idbRuntimeFail = true; // 检测通过、真正打开/写入时失败
  seedJar();
  let m2b = migrator();
  let s2b = await m2b.start(caps, await CMT.cookie.readAll());
  await test('运行时打开 IDB 失败 -> 降级 localStorage 且记录原因', () => {
    assert.strictEqual(s2b.byTarget.localStorage, 3);
    assert.ok(s2b.entries.every(e => e.attempts.some(a => a.target === 'indexedDB')));
    assert.ok(events.some(e => e.type === 'item-degrade' && /SecurityError|安全策略/.test(e.reason)));
  });
  idbRuntimeFail = false;

  idbRuntimeFail = false;
  idbDisabled = true;
  lsThrowQuota = true;
  store.clear();
  idbData.kv.clear();
  seedJar();
  let m3 = migrator();
  let s3 = await m3.start(caps, await CMT.cookie.readAll());
  await test('IDB 禁用 + LS 配额错误时降级到内存兜底', () => {
    assert.strictEqual(s3.byTarget.memory, 3);
    assert.strictEqual(s3.failed, 0);
  });
  await test('警告/降级原因可追踪（每个条目 2 次尝试）', () => {
    assert.ok(s3.entries.every(e => e.attempts.length === 2));
  });
  lsThrowQuota = false;
  idbDisabled = false;

  console.log('中断 / 继续：');
  idbData.kv.clear();
  seedJar();
  let m4 = migrator({ simulateCrashAt: 2 });
  let crashed = null;
  try { await m4.start(caps, await CMT.cookie.readAll()); } catch (e) { crashed = e; }
  await test('第 2 条后模拟中断，run 状态为 interrupted', () => {
    assert.ok(crashed && crashed.crashed);
  });
  let m5 = migrator();
  let resumed = await m5.resume(await lastRunId(m4), caps);
  await test('resume 后剩余条目补迁完成，共 3 条成功', () => {
    assert.strictEqual(resumed.state, 'completed');
    assert.strictEqual(resumed.migrated, 3);
  });

  console.log('回滚：');
  idbData.kv.clear();
  store.clear();
  seedJar(); // 源 Cookie 存在，迁移后保留
  let m6 = migrator();
  let s6 = await m6.start(caps, await CMT.cookie.readAll());
  let runId = s6.runId;
  jar.clear(); // 模拟迁移后源 Cookie 被清理，回滚需要写回
  let rb = await m6.rollback(runId, caps);
  await test('回滚后源 Cookie 全部还原且值一致', () => {
    assert.strictEqual(rb.rollback.failures.length, 0);
    assert.strictEqual(jar.get('sid'), 'abc123');
    assert.strictEqual(jar.get('theme'), 'dark');
  });
  await test('回滚后目标存储副本被删除', async () => {
    const keys = await idbKeys();
    assert.ok(!keys.includes('sid') && !keys.includes('theme') && !keys.includes('prefs'));
  });

  console.log('一致性校验：');
  let m7 = migrator();
  seedJar();
  let s7 = await m7.start(caps, await CMT.cookie.readAll());
  let v = await m7.verifyConsistency(s7.runId);
  await test('源/目标全量校验一致', () => assert.strictEqual(v.consistent, true));
  idbData.kv.get('sid').v = 'tampered';
  let v2 = await m7.verifyConsistency(s7.runId);
  await test('篡改目标值后能检出不一致', () => {
    assert.strictEqual(v2.consistent, false);
    assert.ok(v2.mismatches.some(x => x.name === 'sid'));
  });

  console.log('超限检测：');
  await test('超过 cookieMaxBytes 的键被标记 oversize', () => {
    const big = [{ name: 'big', value: 'x'.repeat(5000), size: CMT.util.byteLength('x'.repeat(5000)) + 4 }];
    const over = CMT.Migrator.checkOversize(big, caps);
    assert.strictEqual(over.length, 1);
  });

  console.log('\n通过 ' + passed + ' 个断言用例。');
}

async function lastRunId(m) {
  const docs = await m.listRuns();
  return docs[0].id;
}
function idbKeys() { return Promise.resolve(Array.from(idbData.kv.keys())); }
function cookiesFor() {
  return Array.from(jar.entries()).map(([name, value]) => ({
    name, value, size: CMT.util.byteLength(name) + 1 + CMT.util.byteLength(value) + 2,
    attrs: { path: '/', sameSite: null, secure: false, partitioned: false, httpOnly: false, domain: null, expires: null },
    attrsSource: 'document'
  }));
}

main().catch(e => { console.error(e); process.exit(1); });
