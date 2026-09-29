// Cookie 读取 / 写入 / 删除工具。
// 注意：document.cookie 只能拿到 name=value，读不到 Expires/Path/Domain/HttpOnly 等属性。

export function readCookies() {
  const raw = document.cookie || '';
  if (!raw) return [];
  return raw.split('; ').filter(Boolean).map(pair => {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* 保留原值 */ }
    return {
      name,
      value: decoded,
      rawValue: value,
      // 与浏览器实际存储口径一致：name=value 的 UTF-8 字节数
      size: new Blob([`${name}=${value}`]).size,
    };
  });
}

export function setCookie(name, value, attrs = {}) {
  let str = `${name}=${encodeURIComponent(value)}`;
  if (attrs.path !== undefined) str += `; Path=${attrs.path}`;
  else str += '; Path=/';
  if (attrs.domain) str += `; Domain=${attrs.domain}`;
  if (attrs.maxAge !== undefined) str += `; Max-Age=${attrs.maxAge}`;
  if (attrs.expires) str += `; Expires=${attrs.expires}`;
  if (attrs.sameSite) str += `; SameSite=${attrs.sameSite}`;
  if (attrs.secure) str += '; Secure';
  if (attrs.partitioned) str += '; Partitioned';
  document.cookie = str;
}

export function deleteCookie(name) {
  document.cookie = `${name}=; Path=/; Max-Age=0`;
}

// 某条 Cookie 是否真实存在（用于探测写是否生效）
export function hasCookie(name) {
  return document.cookie.split('; ').some(p => p.split('=')[0] === name);
}
