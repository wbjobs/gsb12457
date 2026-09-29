// UI 主逻辑：串起检测、Cookie 展示、迁移、中断、回滚。

import { readCookies, setCookie } from './cookieStore.js';
import { runAllDetections } from './featureDetect.js';
import { Migrator, loadJournal } from './migrator.js';

const $ = (id) => document.getElementById(id);

const els = {
  btnDetect: $('btn-detect'),
  detectBody: document.querySelector('#detect-table tbody'),
  btnRefresh: $('btn-refresh'),
  btnAddDemo: $('btn-add-demo'),
  cookieBody: document.querySelector('#cookie-table tbody'),
  targetSelect: $('target-select'),
  chkDelete: $('chk-delete-cookie'),
  chkFallback: $('chk-auto-fallback'),
  btnMigrate: $('btn-migrate'),
  btnAbort: $('btn-abort'),
  btnRollback: $('btn-rollback'),
  progressFill: $('progress-fill'),
  statTotal: $('stat-total'),
  statSuccess: $('stat-success'),
  statFail: $('stat-fail'),
  statFallback: $('stat-fallback'),
  statStatus: $('stat-status'),
  log: $('log'),
};

function log(level, msg) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  li.innerHTML = `<span class="t">${time}</span><span class="l-${level}">${msg}</span>`;
  els.log.appendChild(li);
  els.log.scrollTop = els.log.scrollHeight;
}

const migrator = new Migrator({
  onLog: log,
  onProgress(stats) {
    els.statTotal.textContent = stats.total;
    els.statSuccess.textContent = stats.success;
    els.statFail.textContent = stats.failed;
    els.statFallback.textContent = stats.fallback;
    els.statStatus.textContent = stats.status;
    const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
    els.progressFill.style.width = pct + '%';
  },
});

// ---------- Cookie 列表 ----------

function renderCookies() {
  const cookies = readCookies();
  els.cookieBody.innerHTML = '';
  if (!cookies.length) {
    els.cookieBody.innerHTML = '<tr><td colspan="4" class="empty">暂无 Cookie</td></tr>';
    return;
  }
  for (const c of cookies) {
    const tr = document.createElement('tr');
    const sizeTag = c.size > 4096
      ? `<span class="tag bad">${c.size} B（超限）</span>`
      : `<span class="tag">${c.size} B</span>`;
    tr.innerHTML = `
      <td></td>
      <td></td>
      <td>${sizeTag}</td>
      <td class="hint" style="margin:0">HttpOnly/Expires/Path/Domain 不可读</td>`;
    tr.children[0].textContent = c.name;
    tr.children[1].textContent = c.value.length > 120 ? c.value.slice(0, 120) + '…' : c.value;
    els.cookieBody.appendChild(tr);
  }
}

// ---------- 兼容性检测 ----------

const LEVEL_TAG = { full: 'tag', partial: 'tag warn', none: 'tag bad' };

async function runDetection() {
  els.btnDetect.disabled = true;
  els.detectBody.innerHTML = '';
  await runAllDetections((item) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td><span class="${LEVEL_TAG[item.level]}"></span></td><td></td>`;
    tr.children[0].textContent = item.name;
    tr.querySelector('span').textContent = item.text;
    tr.children[2].textContent = item.detail;
    els.detectBody.appendChild(tr);
  });
  els.btnDetect.disabled = false;
  log('ok', '兼容性检测完成');
}

// ---------- 迁移 ----------

function setMigratingUI(running) {
  els.btnMigrate.disabled = running;
  els.btnAbort.disabled = !running;
  els.btnDetect.disabled = running;
}

async function startMigration() {
  const cookies = readCookies();
  if (!cookies.length) {
    log('warn', '没有可迁移的 Cookie');
    return;
  }
  setMigratingUI(true);
  log('ok', `开始迁移 ${cookies.length} 条 Cookie → ${els.targetSelect.value}`);
  const stats = await migrator.migrate(cookies, {
    preferred: els.targetSelect.value,
    deleteAfter: els.chkDelete.checked,
    autoFallback: els.chkFallback.checked,
  });
  setMigratingUI(false);
  els.btnRollback.disabled = !migrator.journal && !loadJournal();
  renderCookies();
  log(stats.failed ? 'warn' : 'ok',
    `迁移结束：成功 ${stats.success}，失败 ${stats.failed}，降级 ${stats.fallback}`);
}

async function doRollback() {
  const journal = migrator.journal || loadJournal();
  if (!journal) {
    log('warn', '没有可回滚的记录');
    return;
  }
  els.btnRollback.disabled = true;
  await migrator.rollback(journal);
  renderCookies();
}

// ---------- 测试数据 ----------

function addDemoCookies() {
  const n = Math.floor(Math.random() * 1000);
  setCookie(`demo_user_${n}`, `user_${n}_token`);
  setCookie(`demo_pref_${n}`, JSON.stringify({ theme: 'dark', lang: 'zh' }));
  setCookie(`demo_big_${n}`, 'x'.repeat(3000)); // 接近上限的大 Cookie
  log('ok', '已生成 3 条测试 Cookie（含一条 ~3KB 大 Cookie）');
  renderCookies();
}

// ---------- 启动 ----------

els.btnDetect.addEventListener('click', runDetection);
els.btnRefresh.addEventListener('click', renderCookies);
els.btnAddDemo.addEventListener('click', addDemoCookies);
els.btnMigrate.addEventListener('click', startMigration);
els.btnAbort.addEventListener('click', () => {
  migrator.abort();
  els.btnAbort.disabled = true;
  log('warn', '已请求中断，将在当前条目完成后停止并回滚…');
});
els.btnRollback.addEventListener('click', doRollback);

// 页面加载时检查是否有未完成的迁移日志（上次被关闭/崩溃中断）
const leftover = loadJournal();
if (leftover && leftover.entries && leftover.entries.length) {
  migrator.journal = leftover;
  els.btnRollback.disabled = false;
  log('warn', `检测到上次迁移未完成（${leftover.entries.length} 条已写入），可点击「回滚」恢复`);
}

renderCookies();
runDetection();
