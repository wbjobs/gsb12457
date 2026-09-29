# Cookie → localStorage / IndexedDB 迁移工具（零框架）

面向“旧系统用 Cookie 存数据、要迁移到 Web Storage、又担心浏览器兼容性”的开发者。
纯原生 HTML / CSS / JavaScript（ES5 风格、无任何框架、无构建步骤、无第三方依赖），
覆盖 **读取展示 → 能力检测 → 迁移降级 → 中断回滚 → 一致性校验** 全链路。

## 快速开始

```bash
# Worker 与部分 API 在 file:// 下会被浏览器限制，务必用 HTTP 方式打开：
python3 -m http.server 8080
# 访问 http://localhost:8080/
```

页面操作顺序：① 刷新读取/写入示例 Cookie → ② 检测浏览器能力 → ③ 选择目标存储开始迁移
→ ④ 需要时中断/继续/回滚/校验。

## 目录结构

```
index.html                演示与控制台页面（DOM）
css/style.css             样式
js/util.js                字节大小、FNV-1a/SHA-256 校验、Promise 辅助
js/cookie.js              Cookie 读取/写入/删除，cookieStore 属性合并
js/feature-detect.js      能力检测（大小/SameSite/分区/第三方/存储/Worker）
js/idb-core.js            IndexedDB Promise 封装（主线程与 Worker 共用）
js/storage-local.js       localStorage 适配器
js/storage-idb.js         IndexedDB 适配器（Worker 优先，失败回退主线程）
js/storage-memory.js      内存兜底适配器（所有持久化存储不可用时）
js/migrator.js            迁移编排：journal、降级链、校验、resume、rollback
js/app.js                 DOM 事件与渲染
worker/idb-worker.js      Web Worker：IDB 读写移出主线程
probes/third-party.html   跨站第三方 Cookie/存储探测页（部署到另一个源）
tests/node-smoke.js       Node 无头冒烟测试（15 个断言用例，无依赖）
```

## 功能与验收对照

| 需求 | 实现 |
| --- | --- |
| 读取现有 Cookie，展示键值/大小/属性 | `CMT.cookie.readAll()`，大小按请求头口径（`name=value; ` 的 UTF-8 字节），有 `cookieStore` 时展示 path/domain/secure/sameSite/partitioned 等真实属性 |
| 迁移到 localStorage / IndexedDB | 统一适配器接口，IDB 默认经 Web Worker 执行 |
| Cookie 大小限制检测 | 指数扩容 + 二分**实际写探测 Cookie**（写完立即删除），失败回退 UA 已知限制（Chrome/Edge/Firefox≈4KB，Safari≈4093） |
| SameSite 支持检测 | 安全上下文 + `cookieStore` 时写入并回读 Strict/Lax/None 实测；否则 UA 矩阵推断（置信度 `runtime / heuristic / unknown`） |
| 分区（CHIPS）检测 | 运行时验证 `partitioned` 属性是否被接受；UA 矩阵（Chromium 113+、Firefox 129+；Safari 不支持） |
| 第三方 Cookie/存储检测 | 加载跨源 `probes/third-party.html`，iframe 内实测并 postMessage 回传；未配置/超时标记 **unknown**，按“可能受限”保守处理 |
| 不支持时降级 | 目标链默认 `IndexedDB → localStorage → memory`；配额错误（`QuotaExceededError`）、安全错误、Worker 加载失败都会自动降级并记录原因；回滚写回 Cookie 时 SameSite=None→Lax、移除不支持的 `partitioned` |
| 迁移进度 / 成功数 / 失败数 / 降级原因 | `onEvent` 回调：`item-start/item-degrade/item-done/run-finish` 等，页面进度条与事件日志实时展示 |
| 中断后继续 | journal-first：每条先落迁移日志（LS→IDB→内存），`resume(runId)` 重放 pending 条目，已完成的不重复写入 |
| 回滚 | `rollback(runId)` 删除目标副本 → 按能力检测修正属性还原源 Cookie → 全量读回校验；返回每条失败原因 |
| 降级后数据一致 | 每条迁移 **写后读回 + FNV-1a 校验和**（安全上下文可用 SHA-256）；`verifyConsistency(runId)` 可随时全量比对源/目标 |

## 作为库调用

```html
<script src="js/util.js"></script>
<script src="js/cookie.js"></script>
<script src="js/feature-detect.js"></script>
<script src="js/idb-core.js"></script>
<script src="js/storage-local.js"></script>
<script src="js/storage-idb.js"></script>
<script src="js/storage-memory.js"></script>
<script src="js/migrator.js"></script>
```

```js
// 1. 检测（thirdPartyProbeUrl 需把 probes/third-party.html 部署到另一个站点）
var caps = await CMT.detect.detectAll({
  thirdPartyProbeUrl: 'https://other-site.example/probes/third-party.html'
});

// 2. 迁移
var migrator = new CMT.Migrator({
  target: 'auto',            // auto | indexedDB | localStorage | memory
  useWorker: true,
  deleteSource: false,       // true = 成功后删除源 Cookie（回滚仍可还原）
  simulateCrashAt: 0,        // >0 = 迁到第 N 条模拟崩溃，用于演示恢复
  onEvent: function (e) { console.log(e.type, e); }
});
var cookies = await CMT.cookie.readAll();
var result = await migrator.start(caps, cookies);
// result: { state, total, migrated, failed, byTarget, degraded, warnings, entries }

// 3. 中断后继续 / 回滚 / 校验
await migrator.resume(result.runId, caps);
await migrator.verifyConsistency(result.runId);
await migrator.rollback(result.runId, caps);
```

## 检测方法与“未知”语义

- **能实测就实测**：Cookie 大小、SameSite、分区属性均通过真实写入→回读→删除探测，
  结果带 `confidence: 'runtime'`；不具备实测条件（无 `cookieStore`、非安全上下文）
  时使用 UA 矩阵，标记 `'heuristic'`，绝不假装确定。
- **第三方限制无法在顶层页面单测**：浏览器禁止页面感知“第三方 Cookie 是否被禁”。
  必须把 `probes/third-party.html` 部署到**另一个站点**，在 iframe 里实测；
  未配置时返回 `unknown`，迁移器按可能受限处理，并在警告中说明。
- **HttpOnly Cookie 对 JavaScript 不可见**：无法由本工具读取/迁移，需要服务端配合
  （例如随登录响应读取后下发给前端，或服务端直接完成迁移）。
- **分区语义的局限**：`partitioned` 属性被接受不等于在跨站上下文中隔离行为正确；
  完整验证仍需跨站环境（探测页）。

## 异常与边界处理清单

- 单条 Cookie 超限：迁移前按实测上限标记；回滚写回超限会给出明确失败原因而不是静默丢失。
- SameSite=None 在旧内核（Chrome <80、Safari 12 等）被丢弃：回滚写回自动降级为 Lax 并去掉强制 Secure。
- 分区 Cookie 不支持：移除 `partitioned` 并联动降级 SameSite。
- 第三方 Cookie/存储被禁：探测结果为 `false` 时给出告警；存储写入被运行时拒绝
  （SecurityError/配额）时沿链降级到内存兜底，并明确提示内存数据**非持久化**。
- 迁移中断（崩溃/手动 abort/标签关闭）：journal 保留全部条目状态，可继续或回滚。
- 数据不一致：写后读回校验、全量校验两道检查；不一致条目进入 failed/mismatch 并展示原因。
- Web Worker 不可用（file://、CSP、404）：3 秒超时/加载错误自动回退主线程 IDB，并记录原因。

## 测试

```bash
node tests/node-smoke.js
```

内置极简浏览器环境桩（document.cookie、localStorage、IndexedDB、定时器），
覆盖：读取解析、IDB 迁移、检测禁用降级、运行时 SecurityError 降级、配额降级到内存、
模拟崩溃与 resume、回滚还原+目标删除、一致性校验与篡改检出、超限标记，共 15 个断言。

## 数据格式

- localStorage：`cmt:<cookieName>` → `{"v": value, "meta": {source, migratedAt, originalSize, originalAttrs, checksum}}`
- IndexedDB：库 `cmt-migration`，store `kv`，记录 `{ key, value, meta }`
- 迁移日志：localStorage 键 `__cmt_journal__:<runId>`（IDB 库 `cmt-journal` 次之，内存兜底）
