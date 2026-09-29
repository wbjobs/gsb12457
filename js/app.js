/* DOM 应用层：把能力检测与迁移器接到页面上（无框架）。 */
(function () {
  'use strict';
  var CMT = window.CMT;
  var u = CMT.util;
  var esc = u.escapeHtml;

  var el = {};
  ['btn-refresh', 'btn-seed', 'btn-detect', 'btn-migrate', 'btn-abort', 'btn-resume',
    'btn-rollback', 'btn-verify', 'check-all', 'cookie-body', 'cookie-meta',
    'cfg-target', 'cfg-worker', 'cfg-delete', 'cfg-failfast', 'cfg-crash', 'cfg-probe-url',
    'caps', 'progress', 'progress-text', 'summary', 'runs', 'logs'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var state = {
    cookies: [],
    caps: null,
    selected: new Set(),
    lastRunId: null,
    lastRunState: null,
    migrator: null,
    running: false
  };

  /* ---------------- 日志 ---------------- */
  function log(msg, level) {
    var line = document.createElement('div');
    line.className = 'log-item ' + (level || '');
    var t = new Date().toLocaleTimeString();
    line.innerHTML = '<span class="log-time">' + esc(t) + '</span>' + esc(msg);
    el.logs.appendChild(line);
    el.logs.scrollTop = el.logs.scrollHeight;
    while (el.logs.childNodes.length > 300) el.logs.removeChild(el.logs.firstChild);
  }

  /* ---------------- Cookie 表格 ---------------- */
  function refreshCookies() {
    return CMT.cookie.readAll().then(function (cookies) {
      state.cookies = cookies.filter(function (c) { return c.name.indexOf('__cmt_probe') !== 0; });
      state.selected = new Set(state.cookies.map(function (c) { return c.name; }));
      renderCookieTable();
      return state.cookies;
    });
  }

  function renderCookieTable() {
    var limit = state.caps && state.caps.cookieMaxBytes ? state.caps.cookieMaxBytes.value : 4096;
    var total = 0;
    var body = state.cookies.map(function (c) {
      total += c.size;
      var over = c.size > limit;
      var attrs = c.attrs;
      var chips = [];
      if (attrs.sameSite) chips.push('<span class="chip">SameSite=' + esc(attrs.sameSite) + '</span>');
      else chips.push('<span class="chip warn">SameSite=未声明</span>');
      if (attrs.secure) chips.push('<span class="chip">Secure</span>');
      if (attrs.partitioned) chips.push('<span class="chip">Partitioned</span>');
      if (attrs.httpOnly) chips.push('<span class="chip warn">HttpOnly</span>');
      if (attrs.domain) chips.push('<span class="chip">domain=' + esc(attrs.domain) + '</span>');
      if (attrs.path) chips.push('<span class="chip">path=' + esc(attrs.path) + '</span>');
      chips.push('<span class="chip ' + (c.attrsSource === 'cookieStore' ? 'ok' : '') + '">' +
        (c.attrsSource === 'cookieStore' ? '属性来源: cookieStore' : '属性来源: 仅键值') + '</span>');
      return '<tr>' +
        '<td><input type="checkbox" data-name="' + esc(c.name) + '" class="row-check" ' +
        (state.selected.has(c.name) ? 'checked' : '') + '></td>' +
        '<td title="' + esc(c.name) + '"><strong>' + esc(c.name) + '</strong></td>' +
        '<td class="val" title="' + esc(c.value) + '">' + esc(c.value) + '</td>' +
        '<td>' + u.formatBytes(c.size) + (over ? ' <span class="chip bad">超限!</span>' : '') + '</td>' +
        '<td><div class="attrs-cell">' + chips.join('') + '</div></td>' +
        '<td>' + (over ? '<span class="badge bad">超过 ' + limit + ' 字节限制</span>'
          : '<span class="badge ok">可迁移</span>') + '</td>' +
        '</tr>';
    }).join('');
    el['cookie-body'].innerHTML = body || '<tr><td colspan="6" class="muted">当前没有非 HttpOnly Cookie，可点“写入示例 Cookie”。</td></tr>';
    var overCount = state.cookies.filter(function (c) { return c.size > limit; }).length;
    el['cookie-meta'].textContent = '共 ' + state.cookies.length + ' 条，总体积约 ' +
      u.formatBytes(total) + '（请求头口径）；单条限制按 ' + limit + ' 字节判定' +
      (overCount ? '；其中 ' + overCount + ' 条超限' : '') + '。';
    bindRowChecks();
  }

  function bindRowChecks() {
    Array.prototype.forEach.call(document.querySelectorAll('.row-check'), function (box) {
      box.addEventListener('change', function () {
        var name = box.getAttribute('data-name');
        if (box.checked) state.selected.add(name); else state.selected.delete(name);
      });
    });
  }

  function selectedCookies() {
    return state.cookies.filter(function (c) { return state.selected.has(c.name); });
  }

  /* ---------------- 能力检测渲染 ---------------- */
  function detectCapabilities() {
    el['caps'].innerHTML = '<p class="muted small">检测中（会写入并立即清除若干探测 Cookie）…</p>';
    log('开始浏览器能力检测…');
    var probeUrl = el['cfg-probe-url'].value.trim();
    return CMT.detect.detectAll({ thirdPartyProbeUrl: probeUrl || null }).then(function (caps) {
      state.caps = caps;
      renderCaps(caps);
      renderCookieTable();
      log('能力检测完成', 'ok');
      return caps;
    }, function (err) {
      log('能力检测失败: ' + (err.message || err), 'bad');
    });
  }

  function badge(value) {
    if (value === true || value === 'supported') return '<span class="badge ok">支持</span>';
    if (value === false || value === 'unsupported') return '<span class="badge bad">不支持</span>';
    return '<span class="badge unknown">未知</span>';
  }
  function conf(c) {
    return c === 'runtime' ? '（实测）' : c === 'heuristic' ? '（UA 推断）' : c === 'unknown' ? '（无法判定）' : '';
  }
  function row(label, html, c) {
    return '<div class="cap-row"><span>' + label + '</span><span>' + html +
      (c ? ' <small class="muted">' + esc(c) + '</small>' : '') + '</span></div>';
  }

  function renderCaps(caps) {
    var html = '';
    html += '<div class="cap-group-title">Cookie</div>';
    var cb = caps.cookieMaxBytes || {};
    html += row('单条 Cookie 上限', '<strong>' + esc(u.formatBytes(cb.value)) + '</strong>' + badge(true), conf(cb.confidence));
    html += '<div class="cap-note">' + esc(cb.note || '') + '</div>';
    var ss = caps.sameSite || {};
    var unknownSS = ss.confidence === 'unknown' ? null : undefined;
    html += row('SameSite=Strict', unknownSS ? badge(null) : badge(ss.strict), conf(ss.confidence));
    html += row('SameSite=Lax', unknownSS ? badge(null) : badge(ss.lax), conf(ss.confidence));
    html += row('SameSite=None（跨站 Cookie）', unknownSS ? badge(null) : badge(ss.none),
      ss.none === false ? '不支持时自动降级为 Lax' : conf(ss.confidence));
    var pt = caps.partitioned || {};
    html += row('分区 Cookie（CHIPS Partitioned）', badge(pt.supported), conf(pt.confidence));
    if (pt.note) html += '<div class="cap-note">' + esc(pt.note) + '</div>';
    html += row('cookieStore API', badge(caps.cookieStore));
    html += row('安全上下文 (HTTPS)', badge(caps.secureContext));

    html += '<div class="cap-group-title">第三方上下文</div>';
    var tp = caps.thirdParty || {};
    html += row('当前页面角色', esc(tp.context === 'third-party' ? '被跨站 iframe 嵌入' : '顶层页面（第一方）'));
    html += row('第三方 Cookie', badge(tp.cookies), conf(tp.confidence));
    html += row('第三方 localStorage', badge(tp.localStorage), conf(tp.confidence));
    html += row('第三方 IndexedDB', badge(tp.indexedDB), conf(tp.confidence));
    if (tp.note) html += '<div class="cap-note">' + esc(tp.note) + '</div>';

    html += '<div class="cap-group-title">存储与运行时</div>';
    html += row('localStorage', badge(caps.localStorage && caps.localStorage.available),
      caps.localStorage && caps.localStorage.error ? caps.localStorage.error : '实测读写');
    html += row('IndexedDB', badge(caps.indexedDB && caps.indexedDB.available),
      caps.indexedDB && caps.indexedDB.error ? caps.indexedDB.error : '实测打开');
    html += row('Web Worker', badge(caps.webWorker));
    html += row('Module Worker', badge(caps.moduleWorker));
    html += '<div class="cap-note">UA: ' + esc(caps.ua.browser + ' ' + (caps.ua.version || '?') +
      ' / ' + caps.ua.os + ' ' + (caps.ua.osVersion || '')) + '</div>';
    el['caps'].innerHTML = html;
  }

  /* ---------------- 迁移控制 ---------------- */
  function buildMigrator() {
    return new CMT.Migrator({
      target: el['cfg-target'].value,
      useWorker: el['cfg-worker'].checked,
      deleteSource: el['cfg-delete'].checked,
      failFast: el['cfg-failfast'].checked,
      simulateCrashAt: parseInt(el['cfg-crash'].value, 10) || 0,
      onEvent: onMigrateEvent
    });
  }

  function setRunning(running) {
    state.running = running;
    el['btn-migrate'].disabled = running;
    el['btn-detect'].disabled = running;
    el['btn-abort'].disabled = !running;
    el['btn-resume'].disabled = running;
    el['btn-rollback'].disabled = running;
  }

  function startMigration() {
    var cookies = selectedCookies();
    if (!cookies.length) { log('请至少选择一条 Cookie', 'warn'); return; }
    if (!state.caps) {
      log('先执行能力检测，以便按兼容性选择降级策略…', 'warn');
      return detectCapabilities().then(doStart);
    }
    doStart();

    function doStart() {
      var over = CMT.Migrator.checkOversize(cookies, state.caps);
      if (over.length) {
        log('检测到 ' + over.length + ' 条超过 Cookie 大小上限的键（迁移不受影响，但回滚写回可能失败）：' +
          over.map(function (o) { return o.name + '(' + o.size + '>' + o.limit + ')'; }).join(', '), 'warn');
      }
      state.migrator = buildMigrator();
      setRunning(true);
      resetProgress(cookies.length);
      log('迁移开始，共 ' + cookies.length + ' 条；目标链：' +
        (el['cfg-target'].value === 'auto' ? 'IndexedDB → localStorage → 内存' : el['cfg-target'].value));
      state.migrator.start(state.caps, cookies).then(function (summary) {
        setRunning(false);
        renderSummary(summary);
        renderRuns();
        refreshCookies();
      }, function (err) {
        setRunning(false);
        if (err && err.crashed) {
          log('迁移中断（模拟崩溃）：可点“继续上次中断”或“回滚上次迁移”', 'warn');
        } else {
          log('迁移异常: ' + (err.message || err), 'bad');
        }
        renderRuns();
      });
    }
  }

  function resetProgress(total) {
    el.progress.value = 0;
    el.progress.max = 100;
    el['progress-text'].textContent = '0 / ' + total;
  }

  function onMigrateEvent(ev) {
    switch (ev.type) {
      case 'run-start':
        state.lastRunId = ev.runId;
        state.lastRunState = 'running';
        (ev.warnings || []).forEach(function (w) {
          log('[' + w.target + '] ' + w.reason, 'warn');
        });
        break;
      case 'item-start':
        break;
      case 'item-degrade':
        log('降级：' + ev.name + ' 无法写入 ' + ev.from + '（' + ev.reason + '）→ 尝试 ' + ev.next, 'warn');
        break;
      case 'item-done':
        el.progress.value = ev.percent;
        el['progress-text'].textContent = ev.progress + ' / ' + ev.total;
        if (ev.status === 'failed') {
          log('失败: ' + ev.name + ' - ' + ev.error, 'bad');
        } else if (ev.degraded) {
          log('已迁移: ' + ev.name + ' → ' + ev.target + '（经 ' +
            ev.attempts.length + ' 次降级）', 'warn');
        }
        break;
      case 'run-abort':
        log('迁移已被用户中断，已写入数据保留；可继续或回滚', 'warn');
        break;
      case 'run-crash':
        log(ev.reason, 'bad');
        break;
      case 'run-finish':
        log('迁移结束：成功 ' + ev.migrated + '，失败 ' + ev.failed +
          '，降级 ' + ev.degraded + '，状态 ' + ev.state, ev.failed ? 'warn' : 'ok');
        if (ev.workerInfo) {
          log('IndexedDB 执行通道: ' + (ev.workerInfo.via === 'worker' ? 'Web Worker' : '主线程') +
            (ev.workerInfo.reason ? '（原因: ' + ev.workerInfo.reason + '）' : ''),
            ev.workerInfo.via === 'worker' ? 'ok' : 'warn');
        }
        break;
      case 'run-resume':
        log('继续迁移 ' + ev.runId, 'ok');
        break;
      case 'rollback-start':
        resetProgress(ev.total);
        log('开始回滚 ' + ev.runId, 'warn');
        break;
      case 'rollback-progress':
        el.progress.value = ev.percent;
        el['progress-text'].textContent = ev.done + ' / ' + ev.total;
        break;
      case 'rollback-finish':
        log('回滚结束：还原 Cookie ' + ev.rollback.restored + '，删除目标 ' +
          ev.rollback.deleted + '，失败 ' + ev.rollback.failures.length,
          ev.rollback.failures.length ? 'warn' : 'ok');
        renderSummary(ev);
        break;
      case 'verify':
        if (ev.consistent) log('一致性校验通过：' + ev.checked + ' 条数据源/目标完全一致', 'ok');
        else {
          log('一致性校验发现 ' + ev.mismatches.length + ' 处不一致：' +
            ev.mismatches.map(function (m) { return m.name + '(' + m.reason + ')'; }).join('; '), 'bad');
        }
        break;
    }
  }

  /* ---------------- 结果 / 历史 ---------------- */
  function renderSummary(s) {
    state.lastRunId = s.runId || state.lastRunId;
    state.lastRunState = s.state;
    var targets = Object.keys(s.byTarget || {}).map(function (t) {
      return t + ': ' + s.byTarget[t];
    }).join('，');
    var lines = [
      '运行: ' + s.runId,
      '状态: ' + s.state,
      '成功: ' + s.migrated + ' / 失败: ' + s.failed + ' / 待处理: ' + (s.pending || 0),
      '最终落点: ' + (targets || '-'),
      '发生降级的条目: ' + (s.degraded || 0)
    ];
    (s.warnings || []).forEach(function (w) { lines.push('⚠ [' + w.target + '] ' + w.reason); });
    if (s.rollback) {
      lines.push('回滚: 还原 ' + s.rollback.restored + '，删除目标 ' + s.rollback.deleted +
        '，失败 ' + s.rollback.failures.length);
      s.rollback.failures.forEach(function (f) {
        lines.push('  ✖ ' + f.name + ' [' + f.phase + '] ' + f.reason);
      });
    }
    el.summary.classList.remove('muted');
    el.summary.innerHTML = lines.map(function (line, idx) {
      var cls = idx === 1 ? 'state-' + s.state : '';
      if (line.indexOf('⚠') === 0) cls = 'warn';
      if (line.indexOf('✖') !== -1) cls = 'bad';
      return '<div class="' + cls + '">' + esc(line) + '</div>';
    }).join('');
    var pct = s.total ? Math.round((s.migrated) / s.total * 100) : 0;
    if (s.state === 'rolled-back') pct = 100;
    el.progress.value = pct;
    el['progress-text'].textContent = s.migrated + ' / ' + s.total;
  }

  function renderRuns() {
    if (!state.migrator) state.migrator = buildMigrator();
    state.migrator.listRuns().then(function (docs) {
      el.runs.innerHTML = docs.slice(0, 10).map(function (d) {
        var m = d.entries.filter(function (e) { return e.status === 'migrated'; }).length;
        var label = esc(d.id) + ' <span class="state-' + esc(d.state) + '">[' + esc(d.state) + ']</span> ' +
          m + '/' + d.total + ' · ' + new Date(d.startedAt).toLocaleString();
        return '<li><span>' + label + '</span>' +
          '<span class="btn-row">' +
          (d.state === 'interrupted' || d.state === 'aborted' || d.state === 'partial'
            ? '<button class="btn" data-act="resume" data-id="' + esc(d.id) + '">继续</button>' : '') +
          ((d.state === 'completed' || d.state === 'partial' || d.state === 'interrupted' || d.state === 'aborted')
            ? '<button class="btn btn-danger" data-act="rollback" data-id="' + esc(d.id) + '">回滚</button>'
            : '') +
          '<button class="btn btn-ghost" data-act="verify" data-id="' + esc(d.id) + '">校验</button>' +
          '</span></li>';
      }).join('') || '<li class="muted">暂无历史迁移</li>';
      Array.prototype.forEach.call(el.runs.querySelectorAll('button'), function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          var act = btn.getAttribute('data-act');
          if (act === 'resume') resumeRun(id);
          if (act === 'rollback') rollbackRun(id);
          if (act === 'verify') verifyRun(id);
        });
      });
      if (docs.length && !state.lastRunId) state.lastRunId = docs[0].id;
    });
  }

  function withMigrator(fn) {
    if (!state.migrator) state.migrator = buildMigrator();
    if (!state.caps) {
      return detectCapabilities().then(function () { fn(state.migrator); });
    }
    fn(state.migrator);
  }

  function resumeRun(id) {
    withMigrator(function (m) {
      setRunning(true);
      m.resume(id, state.caps).then(function (s) {
        setRunning(false); renderSummary(s); renderRuns(); refreshCookies();
      }, function (err) {
        setRunning(false);
        log('继续失败: ' + (err.message || err), 'bad');
      });
    });
  }

  function rollbackRun(id) {
    if (!window.confirm('确定回滚 ' + id + '？将删除目标存储中的迁移副本并尽力还原源 Cookie。')) return;
    withMigrator(function (m) {
      setRunning(true);
      m.rollback(id, state.caps).then(function (s) {
        setRunning(false); renderRuns(); refreshCookies();
      }, function (err) {
        setRunning(false);
        log('回滚失败: ' + (err.message || err), 'bad');
      });
    });
  }

  function verifyRun(id) {
    withMigrator(function (m) {
      m.verifyConsistency(id).catch(function (err) {
        log('校验异常: ' + (err.message || err), 'bad');
      });
    });
  }

  /* ---------------- 示例 Cookie ---------------- */
  function seedCookies() {
    var samples = [
      { name: 'cmt_demo_user', value: 'alice%20chen', attrs: { path: '/', sameSite: 'lax' } },
      { name: 'cmt_demo_theme', value: 'dark', attrs: { path: '/', sameSite: 'strict' } },
      { name: 'cmt_demo_prefs', value: JSON.stringify({ lang: 'zh-CN', sidebar: true, hints: false }),
        attrs: { path: '/', sameSite: 'lax' } },
      { name: 'cmt_demo_big', value: new Array(900).join('x'),
        attrs: { path: '/', sameSite: 'lax' } } /* 约 900 字节，演示大小统计 */
    ];
    samples.forEach(function (s) { CMT.cookie.setCookie(s.name, s.value, s.attrs); });
    log('已写入 ' + samples.length + ' 条示例 Cookie（其中 cmt_demo_big 约 900 字节）', 'ok');
    refreshCookies();
  }

  /* ---------------- 事件绑定 ---------------- */
  el['btn-refresh'].addEventListener('click', refreshCookies);
  el['btn-seed'].addEventListener('click', seedCookies);
  el['btn-detect'].addEventListener('click', detectCapabilities);
  el['btn-migrate'].addEventListener('click', startMigration);
  el['btn-abort'].addEventListener('click', function () {
    if (state.migrator) state.migrator.abort();
  });
  el['btn-resume'].addEventListener('click', function () {
    if (state.lastRunId && (state.lastRunState === 'interrupted' || state.lastRunState === 'aborted')) {
      resumeRun(state.lastRunId);
    } else {
      state.migrator = buildMigrator();
      state.migrator.listRuns().then(function (docs) {
        var last = docs.find(function (d) {
          return d.state === 'interrupted' || d.state === 'aborted' || d.state === 'partial';
        });
        if (last) { state.lastRunId = last.id; resumeRun(last.id); }
        else log('没有可继续的中断迁移', 'warn');
      });
    }
  });
  el['btn-rollback'].addEventListener('click', function () {
    if (state.lastRunId) rollbackRun(state.lastRunId);
    else log('尚无迁移记录', 'warn');
  });
  el['btn-verify'].addEventListener('click', function () {
    if (state.lastRunId) verifyRun(state.lastRunId);
    else log('尚无迁移记录', 'warn');
  });
  el['check-all'].addEventListener('change', function () {
    var checked = el['check-all'].checked;
    Array.prototype.forEach.call(document.querySelectorAll('.row-check'), function (box) {
      box.checked = checked;
      var name = box.getAttribute('data-name');
      if (checked) state.selected.add(name); else state.selected.delete(name);
    });
  });

  /* ---------------- 启动 ---------------- */
  log('页面就绪，读取现有 Cookie…');
  refreshCookies().then(function (cookies) {
    log('读取到 ' + cookies.length + ' 条可迁移 Cookie（HttpOnly 对 JS 不可见）');
    renderRuns();
  });
})();
