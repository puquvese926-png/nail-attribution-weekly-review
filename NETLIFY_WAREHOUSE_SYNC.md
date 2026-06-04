# Netlify 数仓同步说明

## 目标

让 3.0 看板部署到 Netlify 后，仍可通过后端 API 只读查询数仓帖子数据，并把结果缓存后供前端读取。

## API 流程

### 手动同步

1. 前端点击“同步数仓”。
2. Netlify 上触发 `/api/posts/warehouse-sync-background?full=1`，后台查询数仓并写入 Netlify Blobs。
3. 前端轮询 `/api/posts/warehouse-status?full=1`。
4. 状态为 `done` 后，前端读取 `/api/posts/warehouse-cache?full=1`。
5. 前端展示原有“数仓同步预检”弹窗，用户确认后才替换本机看板缓存。

### 定时同步

`netlify/functions/warehouse-refresh-scheduled.mts` 每天 UTC 20:00 触发一次 `/api/posts/warehouse-sync-background?full=1`。
定时函数只负责发起后台任务，真实全量查库仍在 background function 中执行，避免 30 秒 scheduled timeout 影响全量同步。

本机预览仍走 `http://127.0.0.1:8787/api/posts/warehouse-refresh?full=1`，不受 Netlify API 影响。

## Netlify 环境变量

在 Netlify 站点环境变量中配置：

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`

这些变量只在 Netlify Functions 中读取，不会进入前端 JS。

## 文件

- `netlify.toml`：Netlify 发布目录与 Functions 目录。
- `netlify/functions/warehouse-sync-background.mts`：后台同步入口。
- `netlify/functions/warehouse-status.mts`：同步状态查询。
- `netlify/functions/warehouse-cache.mts`：缓存读取，使用流式响应承载全量 JSON。
- `netlify/functions/warehouse-sync.mts`：同步调试入口，直接查询并写缓存。
- `netlify/functions/warehouse-refresh-scheduled.mts`：每日定时触发后台同步。Netlify scheduled function 不支持自定义 `/api` path，手动调试用 `/.netlify/functions/warehouse-refresh-scheduled`。
- `netlify/functions/_shared/warehouse-api.mjs`：Netlify API 共用逻辑。
- `offsite-lark-sync-server.js`：本地同步服务，同时导出数仓查询函数供 Netlify 复用。

## 验收

1. Netlify 环境变量已配置，远端数仓允许 Netlify 函数访问。
2. 部署后访问 `/api/posts/warehouse-status?full=1` 返回 `idle` 或最近状态。
3. 页面点击“同步数仓”后按钮进入后台同步状态。
4. 同步失败时，`/api/posts/warehouse-status?full=1` 返回 `error`，不会一直停在 `idle`。
5. 同步完成后出现“数仓同步预检”弹窗。
6. 确认同步后，帖子明细数据来源显示为数仓数据。
