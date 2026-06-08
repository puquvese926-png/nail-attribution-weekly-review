# Netlify 数仓同步说明

## 目标

让 3.0 看板部署到 Netlify 后，从本地 SQLite 协作层生成看板缓存包，再上传到 Netlify Blobs 供前端读取。

当前正式上传路径不再在上传阶段重新直连数仓或飞书。数仓和飞书只在本地同步阶段进入 SQLite；线上上传阶段只读取本地 SQLite。

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

### 本地 SQLite 上传缓存

使用本地电脑作为同步器：

1. 本地计划任务先同步数仓帖子到 SQLite。
2. 本地计划任务再同步站外 / PR 到 SQLite。
3. `validate-local-review-upload.js` 执行上传前校验。
4. 校验通过后，`upload-warehouse-cache.js` 从 SQLite 生成上传包。
5. 上传包分片上传到 `/api/posts/warehouse-upload-chunk`。
6. 上传完成后调用 `/api/posts/warehouse-upload-commit?full=1`。
7. Netlify Functions 把分片合并写入 Blobs。
8. 前端继续读取 `/api/posts/warehouse-cache?full=1`。

手动执行上传前校验：

```powershell
npm run localdb:validate-upload
```

手动执行 SQLite 上传：

```powershell
npm run warehouse:upload:full
```

安装 Windows 周五上传前校验任务：

```powershell
npm run localdb:install-task:upload-precheck
```

安装 Windows 周五 Netlify 上传任务：

```powershell
npm run localdb:install-task:netlify-upload
```

本地上传不触发 Netlify production deploy，主要消耗少量 Functions 请求和 Blob/带宽额度。上传脚本内置同一套校验闸门，校验失败会直接停止上传。

默认周五链路：

```text
19:00  WeeklyReviewDashboard_LocalOffsiteSync
19:30  WeeklyReviewDashboard_LocalWarehouseSync
19:45  WeeklyReviewDashboard_LocalUploadPrecheck
20:00  WeeklyReviewDashboard_LocalNetlifyUpload
```

其中 `19:30` 的周五帖子数仓补跑可以通过以下安装入口加入同一个数仓任务：

```powershell
npm run localdb:install-task:warehouse-with-friday-upload-chain
```

## Netlify 环境变量

在 Netlify 站点环境变量中配置：

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `WAREHOUSE_UPLOAD_TOKEN`

这些变量只在 Netlify Functions 中读取，不会进入前端 JS。

本地同步脚本需要 `.env.local` 中的数仓 / 飞书配置。SQLite 上传脚本只要求本地具备：

- `NETLIFY_SITE_URL`
- `WAREHOUSE_UPLOAD_TOKEN`

`NETLIFY_SITE_URL` 默认使用 `https://nail-attribution-console-demo.netlify.app`，后续更换正式生产域名时再覆盖。上传 token 必须配置，也可以放在本地 `.warehouse-upload-token.local`。

本地 SQLite 默认路径：

```text
C:\Users\HP\DataGripProjects\数仓\local_cache\weekly_review_cache.sqlite
```

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
- `offsite-lark-sync-server.js`：本地同步服务，同时导出数仓 / 飞书读取函数供本地 SQLite 同步使用。
- `scripts/sync-local-review-db.js`：同步数仓 / 飞书到本地 SQLite。
- `scripts/local-review-cache-package.js`：从本地 SQLite 生成 Netlify 兼容上传包。
- `scripts/validate-local-review-upload.js`：上传前确定性校验闸门。
- `scripts/upload-warehouse-cache.js`：读取本地 SQLite，校验通过后分片上传到 Netlify。

## 验收

1. 本地 SQLite 已完成帖子数仓同步和站外 / PR 同步。
2. `npm run localdb:validate-upload` 通过，并生成 `pre-upload-validation-latest.json`。
3. `npm run warehouse:upload:full` 使用本地 SQLite 上传成功。
4. 访问 `/api/posts/warehouse-cache?full=1&meta=1`，确认缓存存在且行数/帖子数合理。
5. 页面读取云端缓存后，帖子明细、站外、PR 卡片口径与本地 SQLite 校验报告一致。
