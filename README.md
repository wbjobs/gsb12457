# Cookie → localStorage / IndexedDB 迁移工具

纯原生 Web 实现（Cookie / localStorage / IndexedDB / Feature Detection / DOM / Web Worker），无任何框架。

## 运行

需要通过 HTTP 访问（ES Module 与 Worker 不支持 `file://`）：

```bash
cd 本目录
python3 -m http.server 8080
# 打开 http://localhost:8080
```

## 功能

- **Cookie 读取展示**：键、值、大小（字节，超限标红）；HttpOnly/Expires 等属性浏览器不暴露给 JS，标注为不可读。
- **兼容性检测**：
  - Cookie 可用性与单条大小上限（分片二分探测，不阻塞 UI）；
  - SameSite 支持度（利用「SameSite=None 必须带 Secure」的现代规则做实测）；
  - 分区 Cookie / CHIPS（UA + 安全上下文启发式，老内核/非 HTTPS 判为需降级）；
  - 第三方 Cookie（Storage Access API 信号，跨站场景需 iframe 实测，页面中有说明）；
  - localStorage / IndexedDB 可用性、存储配额、Web Worker。
- **迁移**：逐条写入目标存储，写后读回做 SHA-256（Web Worker 中计算）一致性校验。
- **降级**：目标存储不可用或写失败（如 QuotaExceededError）时自动降级到另一存储，日志记录降级原因。
- **进度**：进度条 + 总数/成功/失败/降级计数 + 实时日志。
- **中断与回滚**：迁移中可中断，自动回滚已写入数据；回滚日志持久化在 localStorage，页面刷新/崩溃后重新打开仍可回滚；回滚会恢复目标存储旧值并还原被删除的 Cookie。

## 文件结构

```
index.html          页面结构
css/style.css       样式
js/main.js          UI 主逻辑
js/cookieStore.js   Cookie 读/写/删
js/storage.js       localStorage / IndexedDB 统一适配层
js/featureDetect.js 兼容性检测
js/migrator.js      迁移引擎（快照/校验/降级/回滚/日志持久化）
js/hash.js          哈希封装（Worker 优先，主线程 FNV-1a 兜底）
js/worker.js        Web Worker：SHA-256 计算
```

## 已知边界

- JS 无法读取 Cookie 的 Expires/Path/Domain/HttpOnly/Secure 属性（浏览器安全限制）。
- CHIPS 与第三方 Cookie 的精确判定依赖跨站 HTTPS 环境，本工具给出本上下文可得的可靠信号并明确标注启发式结论。
