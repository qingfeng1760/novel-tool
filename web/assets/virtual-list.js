/**
 * virtual-list.js —— 固定行高的虚拟滚动列表。
 *
 * 为什么必须有：
 * PRD 模块 5 的性能硬指标写着"3000 章 / 10 MB 的书 3 秒内可读，禁止一次性渲染整本书"。
 * 3000 个 DOM 节点在低配机器上就能卡住半秒以上，所以目录一律走虚拟滚动：
 * 只渲染可视区上下各若干行，滚动时复用节点。
 *
 * 约定：每一行高度固定（由 itemHeight 指定），这是能"算出来"的前提；
 * 行高不固定的列表（比如正文）用不到这个组件。
 */

export class VirtualList {
  /**
   * @param {HTMLElement} container 滚动容器
   * @param {{itemHeight:number, buffer?:number, renderItem:Function, onPick?:Function}} options
   */
  constructor(container, options) {
    this.container = container;
    this.itemHeight = options.itemHeight || 44;
    this.buffer = options.buffer === undefined ? 6 : options.buffer;
    this.renderItem = options.renderItem;
    this.items = [];
    this.activeIndex = -1;

    container.classList.add('vlist');
    this.spacer = document.createElement('div');
    this.spacer.className = 'vlist-spacer';
    this.holder = document.createElement('div');
    this.holder.className = 'vlist-holder';
    container.append(this.spacer, this.holder);

    this._onScroll = () => this.renderWindow();
    container.addEventListener('scroll', this._onScroll, { passive: true });
    this._resizeObserver = new ResizeObserver(() => this.renderWindow());
    this._resizeObserver.observe(container);
  }

  /** 换一批数据 */
  setItems(items) {
    this.items = items || [];
    this.spacer.style.height = `${this.items.length * this.itemHeight}px`;
    this.container.scrollTop = 0;
    this.renderWindow();
  }

  /** 高亮某一行（当前章） */
  setActive(index, options = {}) {
    this.activeIndex = index;
    this.renderWindow();
    if (options.scrollIntoView) this.scrollToIndex(index);
  }

  scrollToIndex(index) {
    const target = Math.max(0, index * this.itemHeight - this.container.clientHeight / 2);
    this.container.scrollTop = target;
    this.renderWindow();
  }

  renderWindow() {
    const scrollTop = this.container.scrollTop;
    const height = this.container.clientHeight || 400;
    const first = Math.max(0, Math.floor(scrollTop / this.itemHeight) - this.buffer);
    const visibleCount = Math.ceil(height / this.itemHeight) + this.buffer * 2;
    const last = Math.min(this.items.length, first + visibleCount);

    this.holder.style.transform = `translateY(${first * this.itemHeight}px)`;
    const fragment = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const node = this.renderItem(this.items[i], i);
      if (!node) continue;
      node.classList.toggle('is-active', i === this.activeIndex);
      node.dataset.vindex = String(i);
      fragment.appendChild(node);
    }
    this.holder.replaceChildren(fragment);
  }

  destroy() {
    this.container.removeEventListener('scroll', this._onScroll);
    this._resizeObserver.disconnect();
    this.container.replaceChildren();
  }
}
