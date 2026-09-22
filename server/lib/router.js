'use strict';
/**
 * router.js —— 极简路由（原生 http，不引 Express）。
 *
 * 为什么自己写：
 * PRD 技术栈允许"Express 或原生 http"。选原生 http 是为了完全掌控两件事：
 *   1. 端口顺延与"只监听 127.0.0.1"的绑定行为；
 *   2. 统一响应体的收口位置。
 * 需求里只有约 50 个接口，模式匹配本身很简单，不值得为此背一整套框架。
 *
 * 支持的写法：
 *   '/api/books/:book_id'        → params.book_id
 *   '/api/fetch/tasks/:id'       → params.id
 *   '/api/static/*'              → params['*']  （尾部通配）
 */

/** 把路径模板编译成正则 + 参数名列表 */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (!seg) return '';
      if (seg === '*') {
        names.push('*');
        return '(.*)';
      }
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp('^' + source + '/?$'), names };
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const { regex, names } = compile(pattern);
    this.routes.push({ method: method.toUpperCase(), pattern, regex, names, handler });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }
  post(p, h) {
    return this.add('POST', p, h);
  }
  put(p, h) {
    return this.add('PUT', p, h);
  }
  patch(p, h) {
    return this.add('PATCH', p, h);
  }
  delete(p, h) {
    return this.add('DELETE', p, h);
  }

  /**
   * 匹配请求。
   * @returns {{handler:Function, params:Object}|null} 命中返回路由与参数
   * @returns {{allowed:string[]}} 路径存在但方法不对时返回允许的方法
   */
  match(method, pathname) {
    const m = method.toUpperCase();
    const allowed = [];
    for (const route of this.routes) {
      const hit = route.regex.exec(pathname);
      if (!hit) continue;
      if (route.method !== m) {
        allowed.push(route.method);
        continue;
      }
      const params = {};
      route.names.forEach((name, i) => {
        const raw = hit[i + 1];
        // 通配段保留原始字符（里面通常还有斜杠），普通段做一次解码
        try {
          params[name] = name === '*' ? raw : decodeURIComponent(raw);
        } catch (err) {
          params[name] = raw;
        }
      });
      return { handler: route.handler, params, pattern: route.pattern };
    }
    if (allowed.length) return { allowed: Array.from(new Set(allowed)) };
    return null;
  }
}

module.exports = { Router, compile };
