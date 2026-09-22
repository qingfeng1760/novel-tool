/**
 * views/settings.js —— 设置与本地数据管理（模块 9）。
 *
 * 界面分层纪律（PRD §2.2）：第一层永远只有书架 / 阅读器 / 加书，
 * 所以抓取日志、接口状态、技术参数、版本信息全部收在这里，分四个子页：
 *   阅读偏好 / 数据管理 / 抓取参数 / 关于
 *
 * 数据管理这一页的两个纪律：
 *   1. 每个清理动作都要**二次确认，并把影响范围讲清楚**（PRD 明确要求）；
 *   2. 整库导入必须让用户先选冲突怎么处理（跳过 / 覆盖 / 并存），不能替他决定。
 */

import { api, qs } from '../api.js';
import { router } from '../router.js';
import { confirmDialog, esc, fmtDate, fmtDuration, fmtRelative, fmtSize, openOverlay, toast, toastError } from '../ui.js';

const SECTIONS = [
  { id: 'reader', label: '阅读偏好' },
  { id: 'data', label: '数据管理' },
  { id: 'fetch', label: '抓取参数' },
  { id: 'about', label: '关于' },
];

let state = {
  section: 'reader',
  settings: null,
  limits: null,
  usage: null,
  targets: null,
  about: null,
  backups: [],
};

// ------------------------------------------------------------------ 阅读偏好

function renderReaderSection(container) {
  const reader = state.settings.reader;
  container.innerHTML = `
    <div class="panel">
      <h2 class="panel-title">阅读偏好</h2>
      <p class="panel-note">这里的设置是全局的，阅读器里改也是改这里，换书不用重设。</p>
      <div class="typo-grid">
        <label class="field">
          <span>字号 <output class="cfg-out">${reader.fontSize} px</output></span>
          <input type="range" id="cfgFontSize" min="12" max="40" step="1" value="${reader.fontSize}" />
        </label>
        <label class="field">
          <span>行距 <output class="cfg-out">${Number(reader.lineHeight).toFixed(2)}</output></span>
          <input type="range" id="cfgLineHeight" min="1.2" max="3" step="0.05" value="${reader.lineHeight}" />
        </label>
        <label class="field">
          <span>版心宽度 <output class="cfg-out">${reader.contentWidth} px</output></span>
          <input type="range" id="cfgWidth" min="420" max="1400" step="20" value="${reader.contentWidth}" />
        </label>
        <label class="field">
          <span>首行缩进 <output class="cfg-out">${reader.indent} 字</output></span>
          <input type="range" id="cfgIndent" min="0" max="4" step="0.5" value="${reader.indent}" />
        </label>
        <label class="field">
          <span>字体</span>
          <select id="cfgFontFamily">
            <option value="serif" ${reader.fontFamily === 'serif' ? 'selected' : ''}>衬线（像纸书）</option>
            <option value="sans" ${reader.fontFamily === 'sans' ? 'selected' : ''}>无衬线（更清楚）</option>
            <option value="mono" ${reader.fontFamily === 'mono' ? 'selected' : ''}>等宽</option>
            <option value="system" ${reader.fontFamily === 'system' ? 'selected' : ''}>系统默认</option>
          </select>
        </label>
        <label class="field">
          <span>主题</span>
          <select id="cfgTheme">
            <option value="day" ${reader.theme === 'day' ? 'selected' : ''}>日间</option>
            <option value="night" ${reader.theme === 'night' ? 'selected' : ''}>夜间</option>
            <option value="eye" ${reader.theme === 'eye' ? 'selected' : ''}>护眼</option>
          </select>
        </label>
        <label class="field">
          <span>阅读模式</span>
          <select id="cfgMode">
            <option value="scroll" ${reader.mode === 'scroll' ? 'selected' : ''}>竖向滚动</option>
            <option value="page" ${reader.mode === 'page' ? 'selected' : ''}>左右翻页</option>
          </select>
        </label>
      </div>
    </div>

    <div class="panel">
      <h2 class="panel-title">阅读进度单独导出 / 导入</h2>
      <p class="panel-note">换电脑时用这个：只带走"读到哪了"，不带正文。</p>
      <div class="panel-actions">
        <button class="btn" id="btnExportProgress" type="button">导出阅读进度</button>
        <button class="btn" id="btnImportProgress" type="button">导入阅读进度</button>
        <input type="file" id="progressFile" accept=".json,application/json" hidden />
      </div>
    </div>`;

  const bindRange = (id, key, format) => {
    const input = document.getElementById(id);
    const output = input.parentElement.querySelector('.cfg-out');
    input.oninput = () => {
      output.textContent = format(input.value);
    };
    input.onchange = () => saveReader({ [key]: Number(input.value) });
  };
  bindRange('cfgFontSize', 'fontSize', (v) => `${v} px`);
  bindRange('cfgLineHeight', 'lineHeight', (v) => Number(v).toFixed(2));
  bindRange('cfgWidth', 'contentWidth', (v) => `${v} px`);
  bindRange('cfgIndent', 'indent', (v) => `${v} 字`);

  document.getElementById('cfgFontFamily').onchange = (e) => saveReader({ fontFamily: e.target.value });
  document.getElementById('cfgTheme').onchange = (e) => saveReader({ theme: e.target.value });
  document.getElementById('cfgMode').onchange = (e) => saveReader({ mode: e.target.value });

  document.getElementById('btnExportProgress').onclick = () => {
    const link = document.createElement('a');
    link.href = '/api/reading/progress/export';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  const fileInput = document.getElementById('progressFile');
  document.getElementById('btnImportProgress').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const result = await api.post('/api/reading/progress/import', payload);
      toast(result.message, 'ok', 5000);
      void loadSettings();
    } catch (err) {
      toastError(err);
    } finally {
      fileInput.value = '';
    }
  };
}

async function saveReader(patch) {
  try {
    const saved = await api.put('/api/settings/reader', patch);
    state.settings.reader = saved;
    toast('阅读偏好已保存。', 'ok', 1600);
  } catch (err) {
    toastError(err);
  }
}

// ------------------------------------------------------------------ 数据管理

function renderDataSection(container) {
  const usage = state.usage;
  const breakdown = usage.breakdown;
  const rows = [
    ['书籍正文', breakdown.books, 'books/'],
    ['全文索引（可重建）', breakdown.index, 'index/'],
    ['进度 / 书签 / 笔记 / 时长', breakdown.reading, 'reading/'],
    ['回收站', breakdown.trash, '.trash/'],
    ['导入暂存', breakdown.staging, '.staging/'],
  ];

  container.innerHTML = `
    <div class="panel">
      <h2 class="panel-title">存储占用</h2>
      <p><strong>共占用 ${esc(fmtSize(usage.totalBytes))}</strong>，备份包另有 ${esc(fmtSize(usage.backupsBytes))}。</p>
      <ul class="usage-list">
        ${rows
          .map(
            ([label, bytes, path]) =>
              `<li><span class="usage-label">${esc(label)}</span>
                <span class="usage-bar"><i style="width:${percent(bytes, usage.totalBytes)}%"></i></span>
                <span class="usage-bytes">${esc(fmtSize(bytes))}</span>
                <span class="usage-path mono">${esc(path)}</span></li>`
          )
          .join('')}
      </ul>
      <h3 class="sub-title">每本书占多少（按大小排）</h3>
      <p class="panel-note">
        数据目录：<span class="mono">${esc(usage.dataDir)}</span>
        （整个文件夹可以直接拷到另一台电脑）
      </p>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>书名</th><th>作者</th><th>章节</th><th>占用</th></tr></thead>
          <tbody>
            ${
              usage.books.length
                ? usage.books
                    .map(
                      (book) => `<tr>
                        <td>${esc(book.title)}</td>
                        <td>${esc(book.author || '—')}</td>
                        <td>${book.total_chapters}</td>
                        <td>${esc(fmtSize(book.bytes))}</td>
                      </tr>`
                    )
                    .join('')
                : '<tr><td colspan="4" class="text-faint">书架还是空的。</td></tr>'
            }
          </tbody>
        </table>
      </div>
    </div>

    <div class="panel">
      <h2 class="panel-title">清理</h2>
      <p class="panel-note">每个动作都会先问一次，并告诉你影响范围。</p>
      <div class="cleanup-list">
        ${state.targets
          .map(
            (target) => `
          <div class="cleanup-item">
            <div class="cleanup-main">
              <strong>${esc(target.label)}</strong>
              <span class="panel-note">${esc(target.description)}</span>
            </div>
            <button class="btn btn-sm ${target.id === 'trash' ? 'btn-danger' : ''}"
                    type="button" data-target="${esc(target.id)}">执行</button>
          </div>`
          )
          .join('')}
      </div>
    </div>

    <div class="panel">
      <h2 class="panel-title">整库备份</h2>
      <p class="panel-note">
        导出的是一个 zip，里面包含全部书籍、章节、进度、书签、笔记和设置。
        导入时如果书架里已经有同一本书，你可以选择跳过、覆盖或者并存。
      </p>
      <div class="panel-actions">
        <button class="btn btn-primary" id="btnExportBackup" type="button">导出整库</button>
        <button class="btn" id="btnImportBackup" type="button">从备份导入</button>
        <input type="file" id="backupFile" accept=".zip,application/zip" hidden />
      </div>
      ${
        state.backups.length
          ? `<h3 class="sub-title">已有的备份（在 backups/ 里）</h3>
             <ul class="issue-list">
               ${state.backups
                 .slice(0, 10)
                 .map(
                   (item) => `<li class="issue-item"><span class="issue-tag">${esc(fmtSize(item.size))}</span>
                     <span class="issue-text mono">${esc(item.name)}</span>
                     <span class="issue-hint">${esc(fmtDate(item.createdAt))}</span></li>`
                 )
                 .join('')}
             </ul>`
          : ''
      }
    </div>`;

  for (const button of container.querySelectorAll('[data-target]')) {
    button.onclick = async () => {
      const target = state.targets.find((t) => t.id === button.dataset.target);
      const ok = await confirmDialog({
        title: `确定要${target.label}吗？`,
        message: target.description,
        detail: `影响范围：${target.impact}`,
        confirmText: '执行',
        danger: target.id === 'trash',
      });
      if (!ok) return;
      try {
        const result = await api.post('/api/storage/cleanup', { target: target.id });
        toast(result.message, 'ok', 5000);
        state.usage = result.usage;
        renderDataSection(container);
      } catch (err) {
        toastError(err);
      }
    };
  }

  document.getElementById('btnExportBackup').onclick = async () => {
    try {
      const link = document.createElement('a');
      link.href = '/api/backup/list';
      const res = await fetch('/api/backup/export', { method: 'POST' });
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = '小说工具备份.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast('整库备份已经导出到下载目录（同时也在 backups/ 里留了一份）。', 'ok', 5200);
      await loadSettings();
      renderDataSection(container);
    } catch (err) {
      toastError(err);
    }
  };

  const backupFile = document.getElementById('backupFile');
  document.getElementById('btnImportBackup').onclick = () => backupFile.click();
  backupFile.onchange = async () => {
    const file = backupFile.files && backupFile.files[0];
    if (!file) return;
    backupFile.value = '';
    await openImportDialog(file, container);
  };
}

function percent(bytes, total) {
  if (!total) return 0;
  return Math.min(100, Math.round((bytes / total) * 1000) / 10);
}

/** 导入备份：先让用户选冲突怎么处理 */
async function openImportDialog(file, container) {
  const { panel, close } = openOverlay();
  panel.classList.add('dialog');
  panel.innerHTML = `
    <h3 class="dialog-title">导入备份</h3>
    <p class="dialog-message">
      即将导入 <span class="mono">${esc(file.name)}</span>（${esc(fmtSize(file.size))}）。
    </p>
    <p class="dialog-label">如果书架上已经有同一本书，怎么办？</p>
    <div class="radio-list">
      <label><input type="radio" name="conflict" value="skip" checked />
        <span><strong>跳过已存在的书</strong><small>最安全：只把书架上没有的书导进来。</small></span></label>
      <label><input type="radio" name="conflict" value="overwrite" />
        <span><strong>覆盖</strong><small>用备份里的替换本地那一本；本地那份会先进回收站，不会直接删。</small></span></label>
      <label><input type="radio" name="conflict" value="coexist" />
        <span><strong>并存</strong><small>两份都留着，备份里那本会换一个新编号，书名加「（导入）」后缀。</small></span></label>
    </div>
    <div class="dialog-actions">
      <button class="btn" id="impCancel" type="button">取消</button>
      <button class="btn btn-primary" id="impOk" type="button">开始导入</button>
    </div>`;

  document.getElementById('impCancel').onclick = () => close();
  document.getElementById('impOk').onclick = async () => {
    const conflict = (panel.querySelector('input[name=conflict]:checked') || {}).value || 'skip';
    close();
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('conflict', conflict);
    const loading = toast('正在导入备份，书多的话会慢一点…', 'info', 60000);
    try {
      const result = await api.post('/api/backup/import', form);
      toast(result.message, 'ok', 8000);
      if (result.warnings && result.warnings.length) {
        toast(`注意：${result.warnings[0]}`, 'warn', 8000);
      }
      await loadSettings();
      renderDataSection(container);
    } catch (err) {
      toastError(err);
    } finally {
      void loading;
    }
  };
}

// ------------------------------------------------------------------ 抓取参数

function renderFetchSection(container) {
  const fetch = state.settings.fetch;
  const limits = state.limits;
  container.innerHTML = `
    <div class="panel">
      <h2 class="panel-title">抓取参数</h2>
      <p class="panel-note">
        默认值就是合规安全值。工具不会允许把参数改到违反"同域并发不超过
        ${limits.maxConcurrency}、两次请求间隔不小于 ${limits.minDomainIntervalMs / 1000} 秒"。
      </p>
      <div class="field-row">
        <label class="field">
          <span>同一站点并发数（上限 ${limits.maxConcurrency}）</span>
          <input type="number" id="cfgConcurrency" min="1" max="${limits.maxConcurrency}" value="${fetch.concurrency}" />
        </label>
        <label class="field">
          <span>同域请求间隔（毫秒，最小 ${limits.minDomainIntervalMs}）</span>
          <input type="number" id="cfgInterval" min="${limits.minDomainIntervalMs}" step="500" value="${fetch.domainIntervalMs}" />
        </label>
        <label class="field">
          <span>单章失败最多重试几次</span>
          <input type="number" id="cfgRetry" min="1" max="10" value="${fetch.retryMax}" />
        </label>
      </div>
      <div class="switch-list">
        <label class="switch-item">
          <input type="checkbox" id="cfgAutoCheck" ${fetch.autoCheckUpdates ? 'checked' : ''} />
          <span class="switch-text"><strong>到点自动检查有没有更新</strong>
            <span class="switch-desc">只检查目录页、只出角标和提示，不会自动下载正文。</span></span>
        </label>
        <label class="switch-item">
          <input type="checkbox" id="cfgSnapshot" ${fetch.saveSourceSnapshot ? 'checked' : ''} />
          <span class="switch-text"><strong>保存抓取来源页快照</strong>
            <span class="switch-desc">只用于排查抓取问题，会明显占磁盘；平时可以关着。</span></span>
        </label>
      </div>
      <div class="panel-actions">
        <button class="btn btn-primary" id="btnSaveFetch" type="button">保存抓取参数</button>
      </div>
      <div id="fetchWarnings"></div>
    </div>

    <div class="panel">
      <h2 class="panel-title">定时追更</h2>
      <p class="panel-note">在这里可以一次给多本书设置检查频率。发现新章节只出角标和提示，不会自动下载。</p>
      <div id="scheduleTable"></div>
    </div>`;

  document.getElementById('btnSaveFetch').onclick = async () => {
    const patch = {
      fetch: {
        concurrency: Number(document.getElementById('cfgConcurrency').value),
        domainIntervalMs: Number(document.getElementById('cfgInterval').value),
        retryMax: Number(document.getElementById('cfgRetry').value),
        autoCheckUpdates: document.getElementById('cfgAutoCheck').checked,
        saveSourceSnapshot: document.getElementById('cfgSnapshot').checked,
      },
    };
    try {
      const result = await api.put('/api/settings', patch);
      state.settings = result.settings;
      const box = document.getElementById('fetchWarnings');
      box.innerHTML = result.warnings.length
        ? `<div class="callout callout-warn">${result.warnings.map((w) => `<p>${esc(w)}</p>`).join('')}</div>`
        : '<div class="callout callout-ok"><p>抓取参数已保存。</p></div>';
      renderFetchSection(container);
      toast('抓取参数已保存。', 'ok');
    } catch (err) {
      toastError(err);
    }
  };

  loadScheduleTable();
}

async function loadScheduleTable() {
  const box = document.getElementById('scheduleTable');
  if (!box) return;
  box.innerHTML = '<div class="loading">正在读取追更状态…</div>';
  try {
    const status = await api.get('/api/fetch/schedule/status');
    const books = status.books.filter((b) => b.schedulable);
    if (!books.length) {
      box.innerHTML = '<p class="panel-note">还没有可以追更的书。从网址抓进来的书才有目录页，才能检查更新。</p>';
      return;
    }
    box.innerHTML = `
      <div class="field-row">
        <label class="field">
          <span>批量设置成</span>
          <select id="bulkMode">
            ${status.checkModes.map((m) => `<option value="${esc(m.mode)}">${esc(m.label)}</option>`).join('')}
          </select>
        </label>
        <button class="btn" id="btnBulkSchedule" type="button">应用到全部可追更的书</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>书名</th><th>频率</th><th>上次检查</th><th>下次检查</th><th>待更新</th></tr></thead>
          <tbody>
            ${books
              .map(
                (book) => `<tr>
                  <td>${esc(book.title)}</td>
                  <td>${esc(book.check_mode_label)}</td>
                  <td>${book.last_checked_at ? esc(fmtRelative(book.last_checked_at)) : '—'}</td>
                  <td>${book.next_check_at ? esc(fmtDate(book.next_check_at)) : '不自动检查'}</td>
                  <td>${book.new_chapters ? `<span class="state-tag state-tag-warn">+${book.new_chapters}</span>` : '—'}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>`;

    document.getElementById('btnBulkSchedule').onclick = async () => {
      const mode = document.getElementById('bulkMode').value;
      try {
        const result = await api.put('/api/fetch/schedule', { all: true, mode });
        toast(result.message, 'ok', 5000);
        loadScheduleTable();
      } catch (err) {
        toastError(err);
      }
    };
  } catch (err) {
    box.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
  }
}

// ------------------------------------------------------------------ 关于

function renderAboutSection(container) {
  const about = state.about;
  const health = about.health || {};
  container.innerHTML = `
    <div class="panel">
      <h2 class="panel-title">关于</h2>
      <dl class="about-list">
        <dt>版本号</dt><dd>${esc(about.version)}</dd>
        <dt>数据格式版本</dt><dd>${esc(String(about.schemaVersion))}</dd>
        <dt>数据目录</dt><dd class="mono">${esc(about.dataDir)}</dd>
        <dt>备份目录</dt><dd class="mono">${esc(about.backupDir)}</dd>
        <dt>运行环境</dt><dd>Node ${esc(about.nodeVersion)} · ${esc(about.platform)}</dd>
        <dt>存储方式</dt><dd>${esc(about.storageKind)}（本机文件系统，唯一真相源）</dd>
        <dt>抓取方式</dt><dd>${esc((about.providers || []).map((p) => p.label).join('、'))}</dd>
        <dt>启动时间</dt><dd>${esc(fmtDate(about.startedAt))}</dd>
      </dl>
      <div class="panel-actions">
        <button class="btn" id="btnCopyDataDir" type="button">复制数据目录路径</button>
        <a class="btn" href="${esc(about.userscriptUrl)}" download>下载油猴脚本</a>
        <a class="btn" href="#/shelf">回到书架</a>
      </div>
      <p class="panel-note">
        想备份或换电脑，直接把上面那个数据目录整个拷走就行；
        也可以在上面「数据管理」里导出成一个 zip。
      </p>
    </div>

    <div class="panel">
      <h2 class="panel-title">数据检查</h2>
      ${
        health.hasProblem
          ? `<div class="callout callout-warn">
               <p>发现下面这些文件有问题，工具已经尽量自动处理了：</p>
               <ul>${health.issues.map((i) => `<li>${esc(i.message)}</li>`).join('')}</ul>
             </div>`
          : '<div class="callout callout-ok"><p>数据文件都正常，没有发现损坏。</p></div>'
      }
    </div>

    <div class="panel">
      <h2 class="panel-title">这一版预留的能力</h2>
      <p class="panel-note">这些功能这一版没有做，但接口和字段都已经留好了，将来加上去不用推翻重来。</p>
      <dl class="about-list">
        ${Object.entries(about.reserved || {})
          .map(([key, value]) => `<dt>${esc(RESERVED_LABEL[key] || key)}</dt><dd>${esc(value)}</dd>`)
          .join('')}
      </dl>
    </div>

    <div class="panel">
      <h2 class="panel-title">使用油猴脚本</h2>
      <ol class="help-steps">
        <li>先给浏览器装一个脚本管理器（Tampermonkey / Violentmonkey 都行）。</li>
        <li>点上面的「下载油猴脚本」，脚本管理器会提示安装，确认即可。</li>
        <li>在小说网页的右下角会出现一个小浮窗，三个按钮：存这一章 / 抓整本 / 存到已有书。</li>
        <li>如果浮窗提示「请先双击启动.bat」，说明本机服务没开；开了之后它会自动把暂存的内容补交上去。</li>
      </ol>
    </div>`;

  document.getElementById('btnCopyDataDir').onclick = async () => {
    try {
      await navigator.clipboard.writeText(about.dataDir);
      toast('数据目录路径已经复制。', 'ok');
    } catch (err) {
      toast('浏览器不允许自动复制，请手动选中那行路径。', 'warn');
    }
  };
}

const RESERVED_LABEL = {
  auth: '登录与账号',
  schemaMigration: '数据格式迁移',
  syncState: '同步状态字段',
  cloudStorage: '云存储',
};

// ------------------------------------------------------------------ 页面

async function loadSettings() {
  const [settings, about, usage, targets] = await Promise.all([
    api.get('/api/settings'),
    api.get('/api/about'),
    api.get('/api/storage/usage'),
    api.get('/api/storage/targets'),
  ]);
  state.settings = settings.settings;
  state.limits = settings.limits;
  state.about = about;
  state.usage = usage;
  state.targets = targets.targets;
  state.backups = (await api.get('/api/backup/list').catch(() => ({ backups: [] }))).backups;
}

function renderSection(view) {
  const container = document.getElementById('settingsBody');
  if (state.section === 'reader') renderReaderSection(container);
  else if (state.section === 'data') renderDataSection(container);
  else if (state.section === 'fetch') renderFetchSection(container);
  else renderAboutSection(container);

  for (const tab of view.querySelectorAll('#settingsTabs button')) {
    tab.classList.toggle('is-active', tab.dataset.section === state.section);
  }
}

export async function render(params, query) {
  const view = document.getElementById('view');
  const section = (query && query.section) || (params && params.section) || 'reader';
  state.section = SECTIONS.some((s) => s.id === section) ? section : 'reader';

  view.innerHTML = '<div class="loading">正在读取设置…</div>';
  try {
    await loadSettings();
  } catch (err) {
    view.innerHTML = `
      <div class="empty-state">
        <h2>设置打不开</h2>
        <p>${esc(err.message)}</p>
        ${err.hint ? `<p class="hint">${esc(err.hint)}</p>` : ''}
        <p><a class="btn" href="#/shelf">回到书架</a></p>
      </div>`;
    return;
  }

  view.innerHTML = `
    <section class="settings-page">
      <div class="page-head">
        <h1>设置与数据管理</h1>
        <p class="page-sub">技术参数、存储、备份都收在这里 —— 第一层永远只有书架、阅读器和加书。</p>
      </div>
      <div class="seg seg-tabs" id="settingsTabs">
        ${SECTIONS.map(
          (s) =>
            `<button type="button" data-section="${esc(s.id)}" ${
              s.id === state.section ? 'class="is-active"' : ''
            }>${esc(s.label)}</button>`
        ).join('')}
      </div>
      <div id="settingsBody"></div>
      <p class="panel-note">
        当前设置文件：
        <span class="mono">${esc(state.about ? state.about.dataDir : '')}\\settings.json</span>
        · 数据格式版本 ${esc(state.about ? String(state.about.schemaVersion) : '')}
        · 共 ${esc(String((state.usage && state.usage.bookCount) || 0))} 本书，
        占用 ${esc(fmtSize((state.usage && state.usage.totalBytes) || 0))}
        · 本次已运行 ${esc(fmtDuration(Date.now() - new Date(state.about.startedAt).getTime()))}
      </p>
    </section>`;

  for (const tab of view.querySelectorAll('#settingsTabs button')) {
    tab.onclick = () => {
      const section = tab.dataset.section;
      state.section = section;
      router.go(`/settings?section=${section}`);
      renderSection(view);
    };
  }

  renderSection(view);
  void qs;
}

export { state as settingsState };
