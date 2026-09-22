/**
 * ui.js —— 通用界面零件与格式化。
 *
 * 关键约定（PRD §12）：
 *   - 所有文案是简体中文、说人话；
 *   - 出错时展示 message，并把 hint 变成一个"可点击的下一步"，
 *     所以这里所有报错入口都接收 {message, hint} 而不是一个字符串。
 */

const toastRoot = () => document.getElementById('toasts');

/** 轻提示。kind: info | ok | warn | error */
export function toast(message, kind = 'info', timeout = 3200) {
  const root = toastRoot();
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 260);
  }, timeout);
}

/**
 * 展示一个错误。
 * 有 hint 时把 hint 作为第二行小字显示——这就是"可点击的下一步"的文字版，
 * 因为它总是描述动作（"请双击启动.bat"），用户照着做就行。
 */
export function toastError(err) {
  const message = (err && err.message) || '这一步没能完成。';
  const hint = err && err.hint;
  if (!hint) {
    toast(message, 'error', 5200);
    return;
  }
  const root = toastRoot();
  if (!root) return;
  const el = document.createElement('div');
  el.className = 'toast toast-error';
  const strong = document.createElement('div');
  strong.textContent = message;
  const small = document.createElement('div');
  small.className = 'toast-hint';
  small.textContent = hint;
  el.append(strong, small);
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 260);
  }, 6500);
}

/** 覆盖层：返回一个可关闭的容器 */
export function openOverlay({ onClose } = {}) {
  const overlay = document.getElementById('overlay');
  overlay.hidden = false;
  overlay.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'overlay-panel';
  overlay.appendChild(panel);

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = '';
    overlay.onclick = null;
    if (onClose) onClose();
  };
  // 点空白处关闭
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  return { panel, close };
}

/** 确认对话框。danger 时按钮变红。 */
export function confirmDialog({ title, message, detail = '', confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const { panel, close } = openOverlay({ onClose: () => resolve(false) });
    panel.classList.add('dialog');
    panel.innerHTML = `
      <h3 class="dialog-title"></h3>
      <p class="dialog-message"></p>
      ${detail ? '<p class="dialog-detail"></p>' : ''}
      <div class="dialog-actions">
        <button class="btn" data-act="cancel" type="button">取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok" type="button"></button>
      </div>`;
    panel.querySelector('.dialog-title').textContent = title;
    panel.querySelector('.dialog-message').textContent = message;
    if (detail) panel.querySelector('.dialog-detail').textContent = detail;
    const okBtn = panel.querySelector('[data-act="ok"]');
    okBtn.textContent = confirmText;
    panel.querySelector('[data-act="cancel"]').onclick = () => close();
    okBtn.onclick = () => {
      const overlay = document.getElementById('overlay');
      overlay.hidden = true;
      overlay.innerHTML = '';
      resolve(true);
    };
  });
}

/** 单行输入对话框 */
export function promptDialog({ title, label = '', value = '', placeholder = '', confirmText = '保存' }) {
  return new Promise((resolve) => {
    const { panel, close } = openOverlay({ onClose: () => resolve(null) });
    panel.classList.add('dialog');
    panel.innerHTML = `
      <h3 class="dialog-title"></h3>
      ${label ? '<label class="dialog-label"></label>' : ''}
      <input class="input dialog-input" type="text" />
      <div class="dialog-actions">
        <button class="btn" data-act="cancel" type="button">取消</button>
        <button class="btn btn-primary" data-act="ok" type="button"></button>
      </div>`;
    panel.querySelector('.dialog-title').textContent = title;
    if (label) panel.querySelector('.dialog-label').textContent = label;
    const input = panel.querySelector('.dialog-input');
    input.value = value;
    input.placeholder = placeholder;
    panel.querySelector('[data-act="ok"]').textContent = confirmText;
    panel.querySelector('[data-act="cancel"]').onclick = () => close();
    panel.querySelector('[data-act="ok"]').onclick = () => {
      const result = input.value.trim();
      const overlay = document.getElementById('overlay');
      overlay.hidden = true;
      overlay.innerHTML = '';
      resolve(result);
    };
    setTimeout(() => input.focus(), 30);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') panel.querySelector('[data-act="ok"]').click();
    });
  });
}

// ------------------------------------------------------------------ 格式化

export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' 字节';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "刚刚 / 3 分钟前 / 昨天 / 2026-09-01" 这种口语化时间 */
export function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return '刚刚';
  if (diff < hour) return Math.floor(diff / min) + ' 分钟前';
  if (diff < day) return Math.floor(diff / hour) + ' 小时前';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return Math.floor(diff / day) + ' 天前';
  return fmtDate(iso).slice(0, 10);
}

/** 把毫秒时长说成"1 小时 12 分" */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分钟`;
  return `${total} 秒`;
}

/** HTML 转义：所有从数据里来的文本都要过一遍，避免书名里带尖括号把版面搞坏 */
export function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
