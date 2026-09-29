// Web Worker：在后台线程计算 SHA-256，用于迁移前后数据一致性校验，
// 避免大 value 的哈希计算阻塞 UI 线程。

self.onmessage = async (e) => {
  const { id, text } = e.data;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    self.postMessage({ id, hash: hex });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
