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

### 本地上传缓存

当 Netlify 云端无法直连数仓时，使用本地电脑作为同步器：

1. 本地脚本直连数仓。
2. 把结果分片上传到 `/api/posts/warehouse-upload-chunk`。
3. 上传完成后调用 `/api/posts/warehouse-upload-commit`。
4. Netlify Functions 把分片合并写入 Blobs。
5. 前端继续读取 `/api/posts/warehouse-cache?full=1`。

首次执行全量：

```powershell
npm run warehouse:upload:full
```

日常执行增量，默认上传最近 14 天并合并进全量缓存：

```powershell
npm run warehouse:upload:incremental
```

安装 Windows 每日计划任务：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-warehouse-upload-task.ps1 -At 08:30
```

本地上传不触发 Netlify production deploy，主要消耗少量 Functions 请求和 Blob/带宽额度。

## Netlify 环境变量

在 Netlify 站点环境变量中配置：

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `WAREHOUSE_UPLOAD_TOKEN`

这些变量只在 Netlify Functions 中读取，不会进入前端 JS。

本地脚本还需要 `.env.local`，可从 `.env.local.example` 复制后填写。

## 健康检查

访问 `/api/posts/warehouse-health?full=1` 可查看：

- `env.present`：四个 DB 环境变量是否已配置，只返回布尔值，不返回明文值。
- `cache.exists`：Netlify Blobs 中是否已有全量帖子缓存。
- `sync.status`：最近一次后台同步状态，可能为 `idle` / `running` / `done` / `error`。

当 `ok=true` 时，代表环境变量齐全、已有缓存、最近同步完成。

## 文件

- `netlify.toml`：Netlify 发布目录与 Functions 目录。
- `netlify/functions/warehouse-sync-background.mts`：后台同步入口。
- `netlify/functions/warehouse-status.mts`：同步状态查询。
- `netlify/functions/warehouse-health.mts`：环境变量、缓存和同步状态健康检查。
- `netlify/functions/warehouse-cache.mts`：缓存读取，使用流式响应承载全量 JSON。
- `netlify/functions/warehouse-upload-chunk.mts`：本地同步器分片上传入口。
- `netlify/functions/warehouse-upload-commit.mts`：合并分片并写入缓存，支持 `replace` 和 `merge-full`。
- `netlify/functions/warehouse-sync.mts`：同步调试入口，直接查询并写缓存。
- `netlify/functions/warehouse-refresh-scheduled.mts`：每日定时触发后台同步。Netlify scheduled function 不支持自定义 `/api` path，手动调试用 `/.netlify/functions/warehouse-refresh-scheduled`。
- `netlify/functions/_shared/warehouse-api.mjs`：Netlify API 共用逻辑。
- `offsite-lark-sync-server.js`：本地同步服务，同时导出数仓查询函数供 Netlify 复用。

## 验收

1. Netlify 环境变量已配置，远端数仓允许 Netlify 函数访问。
2. 部署后访问 `/api/posts/warehouse-health?full=1`，确认 `env.ok=true`。
3. 触发 `/api/posts/warehouse-sync-background?full=1`。
4. 轮询 `/api/posts/warehouse-status?full=1`，成功时返回 `done`，失败时返回 `error`。
5. 访问 `/api/posts/warehouse-cache?full=1&meta=1`，确认缓存存在且行数/帖子数合理。
6. 页面点击“同步数仓”后按钮进入后台同步状态。
7. 同步完成后出现“数仓同步预检”弹窗。
8. 确认同步后，帖子明细数据来源显示为数仓数据。
