// 浏览器兼容性特性检测。
// 所有检测均为异步、分片执行，避免大 Cookie 探测阻塞 UI。

import { setCookie, deleteCookie, hasCookie } from './cookieStore.js';
import { LocalStorageAdapter, IndexedDBAdapter } from './storage.js';

const PROBE = '__cm_probe__';
const yieldToUI = () => new Promise(r => setTimeout(r, 0));

function cleanupProbe() {
  for (let i = 0; i < 40; i++) deleteCookie(`${PROBE}${i}`);
  deleteCookie(PROBE);
}

// 尝试写入一条指定总大小的 Cookie，返回是否生效
function tryCookieSize(size) {
  const name = PROBE;
  const overhead = name.length + 1; // "name="
  const valueLen = size - overhead;
  if (valueLen <= 0) return false;
  setCookie(name, 'x'.repeat(valueLen));
  const ok = hasCookie(name);
  deleteCookie(name);
  return ok;
}

// 二分 + 分片探测单条 Cookie 大小上限
async function detectMaxCookieSize() {
  let lo = 0, hi = 16384; // 常见上限 4096，Chrome 实测约 4096，给足余量
  if (!tryCookieSize(512)) return 0; // 连 512B 都写不进，Cookie 基本不可用
  lo = 512;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tryCookieSize(mid)) lo = mid;
    else hi = mid - 1;
    await yieldToUI();
  }
  return lo;
}

function detectSameSite() {
  // 现代浏览器（Chrome 80+ 等）拒绝不带 Secure 的 SameSite=None；
  // 老浏览器不认识 SameSite 属性，会静默接受并按普通 Cookie 处理。
  setCookie(PROBE, '1', { sameSite: 'None' }); // 故意不加 Secure
  const noneWithoutSecureAccepted = hasCookie(PROBE);
  deleteCookie(PROBE);

  setCookie(PROBE, '1', { sameSite: 'Lax' });
  const laxAccepted = hasCookie(PROBE);
  deleteCookie(PROBE);

  if (!laxAccepted) {
    return { level: 'none', text: '不支持', detail: 'SameSite Cookie 写入失败，需降级' };
  }
  if (noneWithoutSecureAccepted) {
    return {
      level: 'partial',
      text: '部分支持',
      detail: '浏览器接受了无 Secure 的 SameSite=None，说明 SameSite 规则未被严格执行（老内核），依赖 SameSite 的逻辑需降级',
    };
  }
  return { level: 'full', text: '支持', detail: '强制执行 SameSite=None 必须带 Secure 的现代规则' };
}

function detectPartitioned() {
  // CHIPS（Partitioned Cookie）：无法通过 JS 写读直接证实属性被采纳
  // （老浏览器会静默忽略未知属性），因此结合 UA 版本 + 安全上下文做启发式判断。
  const ua = navigator.userAgent;
  const m = ua.match(/(?:Chrome|Chromium|Edg)\/(\d+)/);
  const chromeVer = m ? parseInt(m[1], 10) : 0;
  const uaSaysSupport = chromeVer >= 118; // Chrome/Edge 118+ 稳定支持 CHIPS
  const secure = window.isSecureContext;

  if (uaSaysSupport && secure) {
    return { level: 'full', text: '支持', detail: `Chrome 系 ${chromeVer}，安全上下文，可用 Partitioned（CHIPS）` };
  }
  if (uaSaysSupport && !secure) {
    return { level: 'partial', text: '受限', detail: '内核支持 CHIPS，但 Partitioned 要求 Secure(HTTPS)，当前非安全上下文，需降级' };
  }
  return { level: 'none', text: '不支持', detail: '未检测到 CHIPS 支持（Chrome/Edge < 118 或其他内核），分区 Cookie 需降级' };
}

async function detectThirdParty() {
  // 真正的第三方 Cookie 测试需要跨站 iframe，这里给出本上下文可得的可靠信号：
  // 1) Storage Access API 的存在说明浏览器默认对第三方 Cookie 做了分区/阻止；
  // 2) hasStorageAccess() 给出当前上下文的存储访问状态。
  const hasAPI = typeof document.hasStorageAccess === 'function';
  if (!hasAPI) {
    return {
      level: 'full',
      text: '未限制（第一方）',
      detail: '浏览器未提供 Storage Access API，第三方 Cookie 大概率未被默认阻止；跨站场景仍建议实测',
    };
  }
  try {
    const hasAccess = await document.hasStorageAccess();
    return {
      level: hasAccess ? 'full' : 'partial',
      text: hasAccess ? '当前可访问' : '受限',
      detail: hasAccess
        ? 'Storage Access API 报告当前上下文可访问 Cookie；在第三方 iframe 中状态可能不同'
        : '浏览器默认阻止第三方 Cookie（ITP/ETP），跨站写入需 requestStorageAccess() 或降级到其他存储',
    };
  } catch {
    return { level: 'partial', text: '未知', detail: 'hasStorageAccess() 调用失败，按受限处理并准备降级' };
  }
}

async function detectStorageQuota() {
  if (!navigator.storage || !navigator.storage.estimate) {
    return { level: 'partial', text: '未知', detail: '浏览器不支持 Storage Estimate API' };
  }
  const { quota, usage } = await navigator.storage.estimate();
  const mb = n => (n / 1024 / 1024).toFixed(1);
  return {
    level: 'full',
    text: `约 ${mb(quota || 0)} MB`,
    detail: `已用 ${mb(usage || 0)} MB（localStorage 与 IndexedDB 通常共享该配额）`,
  };
}

// 汇总执行全部检测，逐项回调结果
export async function runAllDetections(onItem) {
  const emit = (name, result) => onItem({ name, ...result });

  const cookieEnabled = navigator.cookieEnabled && (() => {
    setCookie(PROBE, '1');
    const ok = hasCookie(PROBE);
    deleteCookie(PROBE);
    return ok;
  })();
  emit('Cookie 可用性', cookieEnabled
    ? { level: 'full', text: '可用', detail: 'navigator.cookieEnabled=true 且写读探测通过' }
    : { level: 'none', text: '被禁用', detail: 'Cookie 被禁用，所有数据必须降级到 localStorage / IndexedDB' });

  if (cookieEnabled) {
    const maxSize = await detectMaxCookieSize();
    emit('单条 Cookie 大小上限', {
      level: maxSize >= 4096 ? 'full' : 'partial',
      text: `${maxSize} 字节`,
      detail: maxSize < 4096 ? '低于常见的 4096 字节，超限 Cookie 需拆分或降级' : '达到主流浏览器标准（≥4096 字节）',
    });
    emit('SameSite 属性', detectSameSite());
    emit('分区 Cookie (CHIPS)', detectPartitioned());
  } else {
    emit('单条 Cookie 大小上限', { level: 'none', text: 'N/A', detail: 'Cookie 不可用，跳过' });
    emit('SameSite 属性', { level: 'none', text: 'N/A', detail: 'Cookie 不可用，跳过' });
    emit('分区 Cookie (CHIPS)', { level: 'none', text: 'N/A', detail: 'Cookie 不可用，跳过' });
  }

  emit('第三方 Cookie', await detectThirdParty());

  emit('localStorage', LocalStorageAdapter.isAvailable()
    ? { level: 'full', text: '可用', detail: '写读探测通过' }
    : { level: 'none', text: '不可用', detail: '被禁用或处于隐私模式，需降级到 IndexedDB' });

  emit('IndexedDB', IndexedDBAdapter.isAvailable()
    ? { level: 'full', text: '可用', detail: 'indexedDB 接口存在' }
    : { level: 'none', text: '不可用', detail: '浏览器不支持，localStorage 是唯一降级目标' });

  emit('存储配额', await detectStorageQuota());

  emit('Web Worker', typeof Worker !== 'undefined'
    ? { level: 'full', text: '支持', detail: '一致性校验哈希在 Worker 中计算' }
    : { level: 'none', text: '不支持', detail: '一致性校验将回退到主线程' });

  cleanupProbe();
}
