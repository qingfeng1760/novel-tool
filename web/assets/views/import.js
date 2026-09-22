/**
 * views/import.js —— 导入与编码修复页（模块 7 / PRD 流程 B）。
 *
 * 界面顺序就是流程顺序，每一步都能停下来看一眼再往下：
 *   ① 选内容（拖文件 / 选文件 / 粘贴正文）
 *   ② 定编码（自动识别 + 候选列表 + 三段对照预览 + 乱码一键还原）
 *   ③ 看分章（内置规则 / 自定义正则，先预览再确认）
 *   ④ 开清洗（默认全关，开了显示改动字符数与被剔除的片段）
 *   ⑤ 导入（章节数与标题逐字校验通过才落库）
 *
 * 一条不可动摇的规矩（PRD 模块 7 硬规则）：
 * 预览不正确就绝不落库 —— 检测不自信时按钮会禁用并说明原因，而不是偷偷替你选一个。
 */

import { api } from '../api.js';
import { router } from '../router.js';
import { toast, toastError, esc, fmtSize } from '../ui.js';

/** 页面状态机 */
const state = {
  mode: 'file',
  uploadId: null,
  filename: '',
  size: 0,
  /** 文件导入时的编码；粘贴正文时固定 UTF-8 */
  encoding: '',
  detection: null,
  needsUserChoice: false,
  pasteText: '',
  rules: null,
  ruleId: 'default',
  customPattern: '',
  clean: { blankLines: false, indent: false, punctuation: false, adLines: false },
  chapterPreview: null,
  cleanPreview: null,
  title: '',
  author: '',
  busy: false,
};

const CLEAN_SWITCHES = [
  { id: 'blankLines', label: '去掉多余空行', desc: '连续三个以上空行压成一个' },
  { id: 'indent', label: '去掉行首多余空格', desc: '清掉段首的空白与全角空格' },
  { id: 'punctuation', label: '统一全角/半角标点', desc: '把夹在汉字之间的英文标点换成中文标点' },
  { id: 'adLines', label: '去掉疑似广告行', desc: '剔除网址、站点推广、求票求赏等整行内容' },
];

function reset(keepMode) {
  state.uploadId = null;
  state.filename = '';
  state.size = 0;
  state.encoding = '';
  state.detection = null;
  state.needsUserChoice = false;
  state.pasteText = '';
  state.chapterPreview = null;
  state.cleanPreview = null;
  state.title = '';
  state.author = '';
  if (!keepMode) state.mode = 'file';
}

export async function render(params, query) {
  const view = document.getElementById('view');
  const mode = query && query.mode === 'paste' ? 'paste' : 'file';
  reset(true);
  state.mode = mode;

  if (!state.rules) {
    try {
      state.rules = await api.get('/api/import/rules');
    } catch (err) {
      toastError(err);
      state.rules = { rules: [{ id: 'default', label: '通用规则（推荐）' }], default: 'default' };
    }
  }

  view.innerHTML = `
    <section class="import-page">
      <div class="page-head">
        <h1>${mode === 'paste' ? '粘贴正文' : '传文件导入'}</h1>
        <p class="page-sub">导入前你可以逐项确认：编码对不对、分章好不好、要不要清洗。全都没问题才写入书架。</p>
      </div>

      <div class="import-steps" id="importSteps">
        <button class="step-tab ${mode === 'file' ? 'is-active' : ''}" type="button" data-mode="file">传文件导入</button>
        <button class="step-tab ${mode === 'paste' ? 'is-active' : ''}" type="button" data-mode="paste">粘贴正文</button>
      </div>

      <div class="panel" id="panelSource">${
        mode === 'paste'
          ? `
        <h2 class="panel-title">① 把正文粘进来</h2>
        <textarea id="pasteBox" class="paste-box" placeholder="在这里粘贴正文（Ctrl+V）。粘贴后点下面的「识别内容」。" spellcheck="false"></textarea>
        <div class="panel-actions">
          <button class="btn btn-primary" id="btnAnalyzePaste" type="button">识别内容</button>
        </div>`
          : `
        <h2 class="panel-title">① 选择要导入的 TXT 文件</h2>
        <div class="dropzone" id="dropzone">
          <p class="dropzone-main">把 TXT 文件拖到这里</p>
          <p class="dropzone-sub">或者</p>
          <button class="btn" id="btnPickFile" type="button">选择文件</button>
          <input type="file" id="fileInput" accept=".txt,text/plain" hidden />
        </div>
        <p class="panel-note" id="fileNote"></p>`
      }</div>

      <div class="panel" id="panelEncoding" hidden>
        <h2 class="panel-title">② 确认编码</h2>
        <div id="encodingBody"></div>
      </div>

      <div class="panel" id="panelChapterize" hidden>
        <h2 class="panel-title">③ 确认分章</h2>
        <div id="chapterizeBody"></div>
      </div>

      <div class="panel" id="panelClean" hidden>
        <h2 class="panel-title">④ 正文清洗（默认关闭）</h2>
        <div id="cleanBody"></div>
      </div>

      <div class="panel" id="panelCommit" hidden>
        <h2 class="panel-title">⑤ 导入书架</h2>
        <div id="commitBody"></div>
      </div>
    </section>`;

  for (const tab of view.querySelectorAll('.step-tab')) {
    tab.onclick = () => router.go(`/import?mode=${tab.dataset.mode}`);
  }

  if (mode === 'paste') {
    wirePaste();
  } else {
    wireFile();
  }
}

// ------------------------------------------------------------------ 文件

function wireFile() {
  const dropzone = document.getElementById('dropzone');
  const input = document.getElementById('fileInput');
  const pick = document.getElementById('btnPickFile');

  if (pick && input) {
    pick.onclick = () => input.click();
    input.onchange = () => {
      if (input.files && input.files[0]) uploadFile(input.files[0]);
    };
  }

  if (dropzone) {
    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    for (const type of ['dragenter', 'dragover']) {
      dropzone.addEventListener(type, (event) => {
        stop(event);
        dropzone.classList.add('is-over');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      dropzone.addEventListener(type, (event) => {
        stop(event);
        dropzone.classList.remove('is-over');
      });
    }
    dropzone.addEventListener('drop', (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) uploadFile(file);
    });
    dropzone.onclick = (event) => {
      if (event.target.closest('button')) return;
      if (input) input.click();
    };
  }
}

async function uploadFile(file) {
  if (state.busy) return;
  state.busy = true;
  const note = document.getElementById('fileNote');
  if (note) note.textContent = `正在读取《${file.name}》…`;

  try {
    const form = new FormData();
    form.append('file', file, file.name);
    const result = await api.post('/api/import/upload', form);

    state.uploadId = result.upload_id;
    state.filename = result.filename;
    state.size = result.size;
    state.encoding = result.encoding;
    state.detection = result.candidates ? { candidates: result.candidates, note: '' } : null;
    state.needsUserChoice = Boolean(result.needs_user_choice);
    state.title = String(result.filename || '').replace(/\.[^.]*$/, '');

    if (note) {
      note.textContent = `已读取《${result.filename}》，大小 ${fmtSize(result.size)}。`;
    }
    await showEncodingPanel(result);
  } catch (err) {
    toastError(err);
    if (note) note.textContent = '';
  } finally {
    state.busy = false;
  }
}

// ------------------------------------------------------------------ 粘贴

function wirePaste() {
  const box = document.getElementById('pasteBox');
  const button = document.getElementById('btnAnalyzePaste');
  if (button && box) {
    button.onclick = async () => {
      const text = box.value;
      if (!text.trim()) {
        toast('粘贴框里还没有内容。', 'warn');
        return;
      }
      state.pasteText = text;
      state.encoding = 'UTF-8';
      state.title = '';
      try {
        const analyze = await api.post('/api/import/analyze', { text });
        const panel = document.getElementById('panelEncoding');
        panel.hidden = false;
        document.getElementById('encodingBody').innerHTML = `
          <p class="panel-note">粘贴进来的文字已经是一段正常的文本，不涉及编码猜测。
          ${analyze.mojibake && analyze.mojibake.mojibake ? '<strong class="text-warn">不过它看起来像是从别处复制坏的乱码。</strong>' : ''}</p>
          ${
            analyze.mojibake && analyze.mojibake.mojibake
              ? `<div class="panel-actions"><button class="btn" id="btnRecoverPaste" type="button">试着一键还原乱码</button></div>
                 <div id="recoverResult"></div>`
              : ''
          }`;
        const recoverBtn = document.getElementById('btnRecoverPaste');
        if (recoverBtn) {
          recoverBtn.onclick = async () => {
            try {
              const result = await api.post('/api/import/recover', { text: box.value });
              const box2 = document.getElementById('recoverResult');
              box2.innerHTML = `
                <div class="callout ${result.applied ? 'callout-ok' : 'callout-warn'}">
                  <p>${esc(result.note)}</p>
                  ${
                    result.applied
                      ? `<p class="mono">生效的解码链：${esc(result.chain.join(' → '))}</p>
                         <pre class="preview-block">${esc(result.text.slice(0, 400))}</pre>
                         <button class="btn btn-primary" id="btnApplyRecover" type="button">用还原后的内容</button>`
                      : ''
                  }
                  ${
                    result.original_guess && result.original_guess.length
                      ? `<p class="panel-note">它原本可能是：${esc(result.original_guess.join('、'))}</p>`
                      : ''
                  }
                </div>`;
              const applyBtn = document.getElementById('btnApplyRecover');
              if (applyBtn) {
                applyBtn.onclick = () => {
                  box.value = result.text;
                  state.pasteText = result.text;
                  toast('已经用还原后的内容替换了粘贴框。', 'ok');
                };
              }
            } catch (err) {
              toastError(err);
            }
          };
        }
        await showChapterizePanel();
      } catch (err) {
        toastError(err);
      }
    };
  }
}

// ------------------------------------------------------------------ ② 编码

async function showEncodingPanel(upload) {
  const panel = document.getElementById('panelEncoding');
  const body = document.getElementById('encodingBody');
  panel.hidden = false;

  const candidates = (upload.candidates || []).slice(0, 5);
  body.innerHTML = `
    <div class="callout ${upload.confident ? 'callout-ok' : 'callout-warn'}">
      <p>
        ${
          upload.confident
            ? `识别结果：<strong>${esc(upload.encoding)}</strong>（把握 ${Math.round(upload.confidence * 100)}%）`
            : `没把握确定编码。最像的是 <strong>${esc(upload.encoding)}</strong>，但不敢替你决定 —— 请对照下面的预览挑一个读起来正常的。`
        }
      </p>
      ${upload.bom ? '<p class="panel-note">文件开头带了编码标记，编码是确定的。</p>' : ''}
    </div>

    <div class="candidate-row" id="candidateRow">
      ${candidates
        .map(
          (c) => `<button class="candidate-chip ${c.encoding === upload.encoding ? 'is-active' : ''}"
                    type="button" data-encoding="${esc(c.encoding)}" title="${esc(c.note)}">
                    ${esc(c.encoding)}<span class="chip-conf">${Math.round(c.confidence * 100)}%</span>
                  </button>`
        )
        .join('')}
    </div>

    ${
      upload.mojibake && upload.mojibake.mojibake
        ? `<div class="panel-actions">
             <button class="btn" id="btnRecoverFile" type="button">试着一键还原乱码</button>
           </div>
           <div id="recoverResult"></div>`
        : ''
    }

    <h3 class="sub-title">三段对照预览</h3>
    <p class="panel-note">取文件的开头、中间、结尾三段。切换上面的编码，预览会立刻刷新。</p>
    <div class="preview-grid" id="previewGrid"><div class="loading">正在生成预览…</div></div>

    <div class="panel-actions">
      <button class="btn btn-primary" id="btnUseEncoding" type="button" ${
        upload.confident ? '' : 'disabled'
      }>就用这个编码，继续</button>
      ${upload.confident ? '' : '<span class="panel-note">请先在上面选一个编码。</span>'}
    </div>`;

  await refreshPreview(upload.encoding);

  for (const chip of body.querySelectorAll('.candidate-chip')) {
    chip.onclick = async () => {
      for (const other of body.querySelectorAll('.candidate-chip')) {
        other.classList.toggle('is-active', other === chip);
      }
      state.encoding = chip.dataset.encoding;
      state.needsUserChoice = false;
      const useBtn = document.getElementById('btnUseEncoding');
      if (useBtn) useBtn.disabled = false;
      await refreshPreview(state.encoding);
    };
  }

  const recoverBtn = document.getElementById('btnRecoverFile');
  if (recoverBtn) {
    recoverBtn.onclick = async () => {
      try {
        const result = await api.post('/api/import/recover', { upload_id: state.uploadId, encoding: state.encoding });
        document.getElementById('recoverResult').innerHTML = `
          <div class="callout ${result.applied ? 'callout-ok' : 'callout-warn'}">
            <p>${esc(result.note)}</p>
            ${
              result.original_guess && result.original_guess.length
                ? `<p class="panel-note">它原本可能是：${esc(result.original_guess.join('、'))}</p>`
                : ''
            }
            ${
              result.applied
                ? `<p class="mono">生效的解码链：${esc(result.chain.join(' → '))}</p>
                   <pre class="preview-block">${esc(result.text.slice(0, 400))}</pre>`
                : ''
            }
          </div>`;
      } catch (err) {
        toastError(err);
      }
    };
  }

  const useBtn = document.getElementById('btnUseEncoding');
  if (useBtn) {
    useBtn.onclick = async () => {
      if (!state.encoding) {
        toast('请先选一个编码。', 'warn');
        return;
      }
      await showChapterizePanel();
    };
  }
}

async function refreshPreview(encoding) {
  const grid = document.getElementById('previewGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="loading">正在生成预览…</div>';
  try {
    const data = await api.get(
      `/api/import/preview?upload_id=${encodeURIComponent(state.uploadId)}&encoding=${encodeURIComponent(encoding)}`
    );
    grid.innerHTML = data.segments
      .map(
        (seg) => `
        <div class="preview-cell">
          <div class="preview-label">${esc(seg.label)}</div>
          <pre class="preview-block">${esc(seg.text) || '<span class="text-faint">（这一段是空的）</span>'}</pre>
        </div>`
      )
      .join('');
  } catch (err) {
    grid.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
  }
}

// ------------------------------------------------------------------ ③ 分章

async function showChapterizePanel() {
  const panel = document.getElementById('panelChapterize');
  const body = document.getElementById('chapterizeBody');
  panel.hidden = false;

  const payload = buildPayload();
  const options = state.rules ? state.rules.rules : [];
  body.innerHTML = `
    <div class="field-row">
      <label class="field">
        <span>分章规则</span>
        <select id="ruleSelect">
          ${options
            .map(
              (r) => `<option value="${esc(r.id)}" ${r.id === state.ruleId ? 'selected' : ''}>${esc(r.label)}</option>`
            )
            .join('')}
        </select>
      </label>
      <label class="field field-grow">
        <span>自定义正则（可选，填了就按它分章）</span>
        <input type="text" id="customPattern" class="mono" placeholder="例如：^\\s*(第[0-9]+节)\\s*$"
               value="${esc(state.customPattern)}" />
      </label>
      <button class="btn" id="btnPreviewChapterize" type="button">预览分章</button>
    </div>
    <div id="chapterizeResult"><div class="loading">正在分章…</div></div>
    <div class="panel-actions">
      <button class="btn btn-primary" id="btnUseChapterize" type="button" disabled>分章没问题，继续</button>
    </div>`;

  const preview = async () => {
    const target = document.getElementById('chapterizeResult');
    target.innerHTML = '<div class="loading">正在分章…</div>';
    try {
      const result = await api.post('/api/import/preview-chapterize', {
        ...buildPayload(),
        rule_id: state.customPattern ? undefined : state.ruleId,
        pattern: state.customPattern || undefined,
        limit: 60,
      });
      state.chapterPreview = result;
      const btn = document.getElementById('btnUseChapterize');
      if (btn) btn.disabled = false;
      target.innerHTML = `
        <div class="callout ${result.matched ? 'callout-ok' : 'callout-warn'}">
          <p>共分得 <strong>${result.chapterCount}</strong> 章${
            result.chapterCount > result.chapters.length ? `（下面显示前 ${result.chapters.length} 章）` : ''
          }。</p>
          ${result.hint ? `<p class="panel-note">${esc(result.hint)}</p>` : ''}
        </div>
        <ol class="chapter-preview">
          ${result.chapters
            .map(
              (ch) => `<li><span class="ch-index">${ch.index}</span>
                <span class="ch-title">${esc(ch.title)}</span>
                <span class="ch-count">${ch.char_count} 字</span>
                <span class="ch-sample">${esc(ch.preview || '')}</span></li>`
            )
            .join('')}
        </ol>`;
    } catch (err) {
      target.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p>${
        err.hint ? `<p class="panel-note">${esc(err.hint)}</p>` : ''
      }</div>`;
    }
  };

  const ruleSelect = document.getElementById('ruleSelect');
  ruleSelect.onchange = () => {
    state.ruleId = ruleSelect.value;
    preview();
  };
  const customInput = document.getElementById('customPattern');
  customInput.oninput = () => {
    state.customPattern = customInput.value;
  };
  document.getElementById('btnPreviewChapterize').onclick = preview;

  document.getElementById('btnUseChapterize').onclick = () => {
    showCleanPanel();
  };

  await preview();
}

// ------------------------------------------------------------------ ④ 清洗

function showCleanPanel() {
  const panel = document.getElementById('panelClean');
  const body = document.getElementById('cleanBody');
  panel.hidden = false;

  body.innerHTML = `
    <div class="switch-list">
      ${CLEAN_SWITCHES.map(
        (s) => `
        <label class="switch-item">
          <input type="checkbox" data-clean="${s.id}" ${state.clean[s.id] ? 'checked' : ''} />
          <span class="switch-text"><strong>${esc(s.label)}</strong><span class="switch-desc">${esc(s.desc)}</span></span>
        </label>`
      ).join('')}
    </div>
    <p class="panel-note">清洗会改动正文，默认全部关闭。打开后下面会显示改了多少字符、剔除了哪些行，请核对一遍再导入。</p>
    <div id="cleanResult"></div>
    <div class="panel-actions">
      <button class="btn btn-primary" id="btnUseClean" type="button">继续</button>
    </div>`;

  const refresh = async () => {
    const target = document.getElementById('cleanResult');
    const anyOn = Object.values(state.clean).some(Boolean);
    if (!anyOn) {
      target.innerHTML = '<p class="panel-note">四项都没有打开，正文会原样导入。</p>';
      return;
    }
    target.innerHTML = '<div class="loading">正在试跑清洗…</div>';
    try {
      const result = await api.post('/api/import/clean-preview', { ...buildPayload(), clean: state.clean });
      state.cleanPreview = result;
      target.innerHTML = `
        <div class="callout callout-ok"><p>试跑结果：改动了 <strong>${result.changedChars}</strong> 个字符${
          result.removals.length ? `，剔除了 <strong>${result.removals.length}</strong> 行` : ''
        }。</p></div>
        ${
          result.removals.length
            ? `<h3 class="sub-title">被剔除的行（请抽查一遍）</h3>
               <ul class="removal-list">
                 ${result.removals
                   .map((r) => `<li><span class="removal-reason">${esc(r.reason)}</span>
                     <span class="removal-text mono">${esc(r.snippet)}</span></li>`)
                   .join('')}
               </ul>`
            : ''
        }
        <div class="preview-grid">
          <div class="preview-cell">
            <div class="preview-label">改动前</div>
            <pre class="preview-block">${esc(result.before[0] ? result.before[0].text : '')}</pre>
          </div>
          <div class="preview-cell">
            <div class="preview-label">改动后</div>
            <pre class="preview-block">${esc(result.after[0] ? result.after[0].text : '')}</pre>
          </div>
        </div>`;
    } catch (err) {
      target.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
    }
  };

  for (const box of body.querySelectorAll('input[data-clean]')) {
    box.onchange = () => {
      state.clean[box.dataset.clean] = box.checked;
      refresh();
    };
  }
  document.getElementById('btnUseClean').onclick = () => showCommitPanel();
  refresh();
}

// ------------------------------------------------------------------ ⑤ 导入

function showCommitPanel() {
  const panel = document.getElementById('panelCommit');
  const body = document.getElementById('commitBody');
  panel.hidden = false;

  const preview = state.chapterPreview;
  body.innerHTML = `
    <div class="field-row">
      <label class="field field-grow">
        <span>书名</span>
        <input type="text" id="bookTitle" value="${esc(state.title)}" placeholder="给这本书起个名字" />
      </label>
      <label class="field field-grow">
        <span>作者（可空）</span>
        <input type="text" id="bookAuthor" value="${esc(state.author)}" placeholder="作者" />
      </label>
    </div>
    <div class="callout">
      <p>将要写入：<strong>${preview ? preview.chapterCount : '?'}</strong> 章${
        preview ? `（${preview.totalChars} 字）` : ''
      }</p>
      <p class="panel-note">导入时会做一次校验：章节数与标题必须和刚才预览的逐字一致，对不上就不会写入，你的原文件也不会被改动。</p>
    </div>
    <div class="panel-actions">
      <button class="btn btn-primary" id="btnCommit" type="button">导入书架</button>
      <span class="panel-note" id="commitNote"></span>
    </div>`;

  document.getElementById('btnCommit').onclick = async () => {
    const button = document.getElementById('btnCommit');
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    const note = document.getElementById('commitNote');
    if (note) note.textContent = '正在写入，请稍候…';

    try {
      const payload = {
        ...buildPayload(),
        title: document.getElementById('bookTitle').value.trim() || state.title,
        author: document.getElementById('bookAuthor').value.trim(),
        clean: Object.values(state.clean).some(Boolean) ? state.clean : undefined,
        expected: state.chapterPreview
          ? {
              chapterCount: state.chapterPreview.chapterCount,
              titles: state.chapterPreview.chapters.map((c) => c.title),
            }
          : undefined,
      };
      const result = await api.post('/api/import/commit', payload);
      toast(`《${result.book.title}》导入完成，共 ${result.chapterCount} 章。`, 'ok', 5000);
      reset(true);
      router.go(`/book/${result.book.book_id}`);
    } catch (err) {
      toastError(err);
      if (note) note.textContent = '';
      button.disabled = false;
    } finally {
      state.busy = false;
    }
  };
}

/** 把当前状态整理成请求体 */
function buildPayload() {
  if (state.mode === 'paste') {
    return { text: state.pasteText, encoding: 'UTF-8' };
  }
  return { upload_id: state.uploadId, encoding: state.encoding };
}

export { state as importState };
