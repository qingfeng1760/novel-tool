/**
 * router.js —— 前端哈希路由。
 *
 * 为什么用哈希路由：
 * PRD §2.1 明确"前端为哈希路由"，且要求"不引入任何在线 CDN"。
 * 哈希路由不需要服务端配合 rewrite，也不会因为刷新就 404，是最省事的选择。
 *
 * 路由表（与 PRD §2.1 一一对应）：
 *   #/shelf                       书架首页
 *   #/book/:book_id               书籍详情与目录
 *   #/fetch                       抓取控制台（可带 ?task= 深链）
 *   #/import                      导入与编码修复（可带 ?mode=file|paste）
 *   #/search                      全文检索与筛选
 *   #/settings(/:section)         设置与数据管理
 */

/** 把 '#/book/abc?x=1' 拆成 { path:'/book/abc', query:{x:'1'} } */
export function parseHash(hash) {
  let raw = String(hash || '').replace(/^#/, '');
  if (!raw) raw = '/shelf';
  const qIndex = raw.indexOf('?');
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const search = qIndex === -1 ? '' : raw.slice(qIndex + 1);
  const query = {};
  for (const [key, value] of new URLSearchParams(search).entries()) query[key] = value;
  return { path: path || '/shelf', query };
}

/** 编译 '/book/:book_id' → 正则 + 参数名 */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (!seg) return '';
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp('^' + source + '/?$'), names };
}

export class HashRouter {
  constructor() {
    this.routes = [];
    this.current = null;
  }

  /** @param {string} pattern 例如 '/book/:book_id' */
  add(pattern, handler) {
    const { regex, names } = compile(pattern);
    this.routes.push({ pattern, regex, names, handler });
    return this;
  }

  match(path) {
    for (const route of this.routes) {
      const hit = route.regex.exec(path);
      if (!hit) continue;
      const params = {};
      route.names.forEach((name, i) => {
        try {
          params[name] = decodeURIComponent(hit[i + 1]);
        } catch (err) {
          params[name] = hit[i + 1];
        }
      });
      return { handler: route.handler, params, pattern: route.pattern };
    }
    return null;
  }

  /** 跳转（会写进浏览器历史，用户可以用后退键） */
  go(path) {
    const next = path.startsWith('#') ? path : '#' + path;
    if (location.hash === next) {
      this.resolve();
    } else {
      location.hash = next;
    }
  }

  /** 替换当前历史项（比如把 #/ 换成 #/shelf，不该多一条历史） */
  replace(path) {
    const next = path.startsWith('#') ? path : '#' + path;
    history.replaceState(null, '', next);
    this.resolve();
  }

  resolve() {
    const { path, query } = parseHash(location.hash);
    const hit = this.match(path);
    this.current = { path, query, pattern: hit ? hit.pattern : null };
    if (hit) {
      hit.handler(hit.params, query);
    } else {
      this.go('/shelf');
    }
  }

  start() {
    window.addEventListener('hashchange', () => this.resolve());
    if (!location.hash) {
      this.replace('/shelf');
    } else {
      this.resolve();
    }
  }
}

export const router = new HashRouter();
