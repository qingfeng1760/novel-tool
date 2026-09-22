'use strict';
/**
 * routes/settings.js —— 模块 9「设置与本地数据管理」的接口。
 *
 * 接口清单（PRD 模块 9）：
 *   GET  / PUT /api/settings        全局设置读写（含抓取参数的合规夹取与风险提示）
 *   GET  /api/storage/usage         data/ 与单本占用，可按大小排序
 *   GET  /api/storage/targets       可清理的目标（含影响范围说明，供二次确认展示）
 *   POST /api/storage/cleanup       清理指定目标（二次确认在前端完成）
 *   POST /api/backup/export         整库导出 zip
 *   GET  /api/backup/list           已有备份列表
 *   POST /api/backup/import         导入并处理冲突（skip / overwrite / coexist）
 *   GET  /api/about                 版本号、数据目录绝对路径、schema 版本
 *
 * 关于"二次确认在前端完成"：
 * 这是 PRD 的原话。所以后端不搞"必须传 confirm=true"那一套，
 * 而是把"影响范围"（impact）明确回给前端，让界面把话说清楚再去确认。
 */

const fs = require('fs');
const { ApiError } = require('../lib/errors');
const { sendFile } = require('../lib/http-utils');

/** 导入备份时允许的请求体上限（整库备份可能很大） */
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;

module.exports = {
  mount(router, ctx) {
    const { settings, storageManager: storage, backup } = ctx;

    // ------------------------------------------------------------ 设置

    router.get('/api/settings', () => {
      const current = settings.get();
      const sanitized = settings.sanitizeFetchSettings(current.fetch, null);
      return {
        settings: current,
        /** 读的时候也要过一遍合规，手改过 settings.json 的人会在这里看到提示 */
        warnings: sanitized.warnings,
        limits: settings.COMPLIANCE_LIMITS,
        defaults: settings.DEFAULTS,
      };
    });

    router.put('/api/settings', async (c) => {
      const body = await c.json();
      if (!body || typeof body !== 'object') {
        throw new ApiError('BAD_SETTINGS', '设置数据格式不对。', '请刷新页面后重新设置一次。', 400);
      }
      const result = settings.patch(body);
      return { settings: result.settings, warnings: result.warnings };
    });

    router.get('/api/settings/limits', () => ({
      limits: settings.COMPLIANCE_LIMITS,
      defaults: settings.DEFAULTS,
      labels: {
        concurrency: '同一站点同时抓几个页面',
        domainIntervalMs: '同一个站点两次请求之间至少隔多久',
        retryMax: '一章失败后最多重试几次',
        autoCheckUpdates: '到点自动检查有没有更新',
        saveSourceSnapshot: '抓取时是否保存原始网页快照（只用于排查问题）',
      },
    }));

    // ------------------------------------------------------------ 存储

    router.get('/api/storage/usage', (c) => {
      const data = storage.usage();
      const sort = c.q('sort');
      if (sort === 'title') {
        data.books = [...data.books].sort((a, b) => String(a.title).localeCompare(String(b.title)));
      } else if (sort === 'chapters') {
        data.books = [...data.books].sort((a, b) => b.total_chapters - a.total_chapters);
      }
      return data;
    });

    router.get('/api/storage/targets', () => ({
      targets: storage.CLEANUP_TARGETS,
      usage: storage.usage(),
    }));

    router.post('/api/storage/cleanup', async (c) => {
      const body = await c.json();
      return storage.cleanup(body.target, { book_id: body.book_id });
    });

    // ------------------------------------------------------------ 备份

    router.post('/api/backup/export', async (c) => {
      // 允许前端指定输出目录；不传就用默认的 backups/
      const body = await c.json().catch(() => ({}));
      const result = await backup.exportZip({ outFile: body && body.out_file });
      sendFile(c.res, {
        filename: `小说工具备份-${new Date().toISOString().slice(0, 10)}.zip`,
        contentType: 'application/zip',
        buffer: fs.readFileSync(result.file),
        extraHeaders: {
          'X-Backup-File': encodeURIComponent(result.file),
          'X-Backup-File-Count': String(result.fileCount),
          'X-Backup-Size': String(result.size),
        },
      });
      return undefined;
    });

    router.get('/api/backup/list', () => ({ backups: backup.listBackups() }));

    router.post('/api/backup/import', async (c) => {
      const contentType = c.headers['content-type'] || '';
      let buffer = null;
      let options = {};

      if (contentType.includes('multipart/form-data')) {
        const { fields, files } = await c.multipart();
        const file = files.find((f) => f.name === 'file') || files[0];
        if (!file) {
          throw new ApiError('NO_BACKUP_FILE', '没有收到备份文件。', '请选择那个 .zip 备份文件再导入。', 400);
        }
        buffer = file.data;
        options = {
          conflict: fields.conflict || 'skip',
          import_settings: fields.import_settings === 'true',
        };
      } else {
        const body = await c.json();
        options = {
          conflict: body.conflict || 'skip',
          import_settings: body.import_settings === true,
        };
        if (body.file_path) {
          if (!fs.existsSync(body.file_path)) {
            throw new ApiError(
              'BACKUP_FILE_NOT_FOUND',
              '这个路径上没有找到备份文件。',
              '请确认路径写对了，或者直接把 zip 文件选进来。',
              400
            );
          }
          buffer = fs.readFileSync(body.file_path);
        } else if (body.data_base64) {
          buffer = Buffer.from(String(body.data_base64), 'base64');
        }
      }

      if (!buffer || !buffer.length) {
        throw new ApiError(
          'NO_BACKUP_FILE',
          '没有收到备份文件。',
          '请选择用「备份.bat」或设置页「导出整库」生成的那个 zip 文件。',
          400
        );
      }
      if (buffer.length > MAX_IMPORT_BYTES) {
        throw new ApiError(
          'BACKUP_TOO_LARGE',
          '这个备份文件太大了（超过 1 GB）。',
          '请先把它解压，把 books 目录直接拷进 data 里。',
          413
        );
      }

      return backup.importZip(buffer, options);
    });

    // ------------------------------------------------------------ 关于

    router.get('/api/about', () => storage.about());
  },
};
