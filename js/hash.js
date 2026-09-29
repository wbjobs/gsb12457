// 哈希封装：优先 Web Worker（SHA-256），Worker 不可用时回退主线程 FNV-1a。

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker('js/worker.js');
    worker.onmessage = (e) => {
      const { id, hash, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      error ? p.reject(new Error(error)) : p.resolve(hash);
    };
    worker.onerror = () => {
      worker = false;
      for (const p of pending.values()) p.reject(new Error('Worker 异常'));
      pending.clear();
    };
  } catch {
    worker = false;
  }
  return worker;
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'fnv1a:' + (h >>> 0).toString(16);
}

export function hashText(text) {
  const w = getWorker();
  if (!w) return Promise.resolve(fnv1a(text));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, text });
  }).catch(() => fnv1a(text)); // Worker 失败时回退主线程哈希，保证迁移不中断
}
