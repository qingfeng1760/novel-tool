'use strict';
/**
 * index.js —— 服务入口（双击 启动.bat 后跑的就是这里）。
 *
 * 干四件事：
 *   1. 装配上下文（含 store 初始化与数据体检）；
 *   2. 起 HTTP 服务，只监听 127.0.0.1，8618 被占用就顺延并在控制台打印真实地址；
 *   3. 打开默认浏览器；
 *   4. 注册定时追更（S9）。
 *
 * 注意：导出 startServer 是为了让测试能以完全相同的路径把服务拉起来
 * ——测试跑的就是用户双击时跑的那条路，而不是另写一套"测试专用服务"。
 */

const { createContext } = require('./context');
const { createApp } = require('./app');
const { findFreePort, DEFAULT_HOST, DEFAULT_START_PORT } = require('./lib/net');
const { openBrowser } = require('./lib/browser');

/**
 * 起服务。
 * @param {{dataDir?:string, port?:number, openBrowser?:boolean, quiet?:boolean, onListen?:Function}} options
 */
async function startServer(options = {}) {
  const ctx = createContext(options);

  const settings = ctx.settings.get();
  // 端口优先级：显式参数 > 设置里存的值 > 默认 8618
  const desiredPort = Number(options.port) || Number(settings.server.port) || DEFAULT_START_PORT;
  const port = await findFreePort(desiredPort, DEFAULT_HOST);

  const { server } = createApp(ctx);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, DEFAULT_HOST, resolve);
  });

  const actualPort = server.address().port;
  const url = `http://${DEFAULT_HOST}:${actualPort}`;

  // 顺延过端口就顺手记进设置，下次启动就固定用它
  if (actualPort !== Number(settings.server.port)) {
    try {
      ctx.settings.patch({ server: { port: actualPort } });
    } catch (err) {
      /* 记不住也不影响本次运行 */
    }
  }

  if (options.onListen) options.onListen({ ctx, server, port: actualPort, url });
  return { ctx, server, port: actualPort, url };
}

/** 控制台横幅：把地址放在最显眼的位置（PRD：端口顺延后必须明确打印实际地址） */
function printBanner(url, ctx) {
  const line = '='.repeat(56);
  console.log('');
  console.log(line);
  console.log('  小说工具 已启动（v' + ctx.version + '）');
  console.log('');
  console.log('  请在浏览器里打开：  ' + url);
  console.log('');
  console.log('  数据保存在：  ' + ctx.dataDir);
  console.log('  关闭这个窗口就等于退出程序。');
  console.log(line);
  console.log('');

  // 数据体检有问题的必须明确说出来是哪个文件（PRD §6.2：绝不静默丢弃）
  if (ctx.health && ctx.health.hasProblem) {
    console.log('【数据检查】发现下面这些文件有问题，已尽量自动处理：');
    for (const issue of ctx.health.issues) {
      console.log('  · ' + issue.message);
    }
    console.log('');
  }
}

async function main() {
  let started;
  try {
    started = await startServer({
      openBrowser: true,
      onListen: ({ ctx, url }) => {
        printBanner(url, ctx);
      },
    });
  } catch (err) {
    console.error('');
    console.error('启动失败：' + (err && err.message ? err.message : String(err)));
    if (err && err.code === 'NO_FREE_PORT') {
      console.error('提示：8618 到 8667 之间的端口都被占用了。请关掉多余的程序后重试。');
    } else if (err && err.code === 'EACCES') {
      console.error('提示：系统不允许监听这个端口，请检查是否有安全软件拦截。');
    }
    console.error('');
    process.exitCode = 1;
    return;
  }

  const { ctx, server, url } = started;

  // 定时追更（S9 才有 scheduler，这里做存在性判断，避免早期阶段启动报错）
  let schedulerTimer = null;
  if (ctx.scheduler && typeof ctx.scheduler.start === 'function') {
    schedulerTimer = ctx.scheduler.start();
  }

  if (process.env.NOVEL_TOOL_NO_BROWSER !== '1') {
    const result = openBrowser(url);
    if (!result.opened) {
      console.log('（没能自动打开浏览器，请手动复制上面的地址打开）');
    }
  }

  const shutdown = () => {
    console.log('\n正在退出……数据已全部落盘，可以放心关闭。');
    if (schedulerTimer && typeof ctx.scheduler.stop === 'function') ctx.scheduler.stop();
    server.close(() => process.exit(0));
    // 兜底：如果有保持连接，2 秒后强制退出
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { startServer, printBanner, main };
