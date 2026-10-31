# 正式部署与恢复

目标为公开仓库 `tsd619124/yueqian-training`、GitHub Pages 和 Cloudflare Workers Free。GitHub CLI、Wrangler 和 Xcode 使用各自已有认证；不把凭据复制进工程。完整工作区含历史归档与设备记录，不能整体推送。

## 已启用的流程

`publish.yml` 对应远端 `.github/workflows/publish.yml`。main 推送、手动运行及每日北京时间 06:17 执行 `release.mjs check --ci`（测试、构建、两端资料库与原生教材一致性检查）、来源发现、静态检索索引、静态包发布和线上哈希检查。该流程不自动审核新课程。

- 来源发现失败或校验不通过时，`discover-ci.mjs --fallback` 沿用线上已发布的 `content-discovery.json` 并在 Actions 中告警，Web 发布继续；线上目录也不可用时才停止。
- `search-index.mjs --previous` 从线上读取上一版索引，复用未变化条目，生成 `content-library/search/latest.json` 与 `index-<sha256>.json`（格式见 [契约](../STATIC-SEARCH-INDEX.md)）。单篇失败保留上一版条目（来源标 `partial`），来源失败保留该来源上一版条目（`retained`），整体无结果或校验不过则保留上一版索引；本次没有可用索引时，`production.mjs` 保留线上上一版。站点同时保留上一版索引文件，供已读到旧指针的客户端完成下载。
- 外部检索默认由两端读取静态索引；Worker 在外部检索触发时每个实例至多每小时读取一次来源目录，目录超过 72 小时未核对则暂停外部正文读取。

公开仓库只保存明确选中的 Web 源码、管线及跨端校验资源。原生完整源码、签名包、个人学习数据、归档及本地日志不在公开仓库中。

## 准备 Workers 发布目录

以下命令从项目根目录执行；将 `output/next-worker`、`output/next-site` 换成尚不存在的本次目录。先确保生成内容和正式客户端资源一致。`prepare-search-worker` 拒绝覆盖含人工修改的目录；不要强制删除旧发布目录。

Pages 主站的日常发布用 `node content-pipeline/release.mjs web --push --watch`（不带 `--push` 为演练），详见 [管线说明](../README.md#一键发布-releasemjs)。Worker 仍按下列步骤手工准备：

```sh
node content-pipeline/release.mjs check
node content-pipeline/discover-ci.mjs --fallback https://tsd619124.github.io/yueqian-training/content-discovery.json
node content-pipeline/search-index.mjs --previous https://tsd619124.github.io/yueqian-training/content-library/
node content-pipeline/run.mjs prepare-search-worker
node content-pipeline/production.mjs output/next-site https://tsd619124.github.io/yueqian-training/
mkdir output/next-worker
cp output/content-pipeline/search-worker/*.mjs output/next-worker/
cp output/content-pipeline/search-worker/search-bundle.json output/next-worker/
cp content-pipeline/deployment/wrangler.production.jsonc output/next-worker/wrangler.jsonc
mkdir output/next-worker/public
cp -R output/next-site/content-library output/next-worker/public/
cp content-pipeline/deployment/worker-headers output/next-worker/public/_headers
WRANGLER_SEND_METRICS=false npx --no-install --package wrangler@4.154.0 wrangler deploy --config output/next-worker/wrangler.jsonc --dry-run
```

核对账户仍为 Workers Free、目标名称及预检结果后，使用同一命令去掉 `--dry-run` 发布。不配置 Free 不支持的自定义 CPU 限额，不启用 KV、D1、R2 或付费模型。静态备用包含公开审核图文和 `content-library/search/` 静态索引。`wrangler.production.jsonc` 已开启 Workers Logs，`head_sampling_rate` 为 0.1（约 10% 请求记录日志），用于排查错误；本仓库未执行部署，生效以下次 `wrangler deploy` 为准。

Workers 检索是可选服务。主站与 Worker 独立发布；只更新候选目录或静态索引无需重新部署 Worker。正式图文版本变化时建议同步部署 Worker，但读回检查不再要求双方 `releaseID` 一致，Worker 检查失败只告警、不阻断 Pages 发布。

## 验收与运行

`verify-production.mjs <站点 HTTPS 地址> <本次发布目录> [部署前 release-manifest.json]` 校验清单列出的全部线上文件，并用契约校验器检查 `search/latest.json` 与索引哈希。第三个参数由 `production.mjs` 写在发布目录旁（`output/previous-release-manifest.json`，不上传）。不一致的文件按 5、10、20、40、60… 秒退避重试，总时长约 4.5 分钟（可用 `VERIFY_BUDGET_MS` 调整）。仍不一致时分类报告：线上仍是部署前哈希或新文件尚未出现记为 `propagation-lag`（传播延迟，稍后重跑读回即可，无需回滚）；与新旧版本都不同记为 `corrupt`，需核对后重新发布；网络错误或 5xx 记为 `unreachable`。三类都会使任务失败。

`material-services.js` 配置了检索地址时，再对 Worker 做一次库内检索和 CORS 检查；结果只作为告警，不比较 `releaseID`。中文外部检索与 `/health` 中 `discoveryStatus=remote-verified` 仍可手工验证；后者是接收该请求实例的状态，不代表所有实例同时刷新。

Workers Free 当前平台上限为每日 100,000 次请求、每次 10 ms CPU；平台额度与应用每实例限流分开生效。应用外部读取单轮最多 3 篇、1.5 MB、8 秒。Cloudflare Dashboard 的 Workers Metrics 用于核对账户请求量、错误和 CPU；本轮未建立跨实例自定义计费计量。可在 Worker 设置中将 `EXTERNAL_SEARCH_ENABLED=false` 并部署，停止外部正文和发现目录读取，保留库内检索与静态资料。

定时任务已启用并完成首轮运行；后续调度可能延迟，公开仓库长期无活动可能被平台停用。Actions 失败记录应作为维护入口；免费计划不保证 SLA，也不自动升级套餐。

## 回滚边界

- 发布前测试、来源校验或打包失败时，不上传新站点，保留上一线上版本。
- 新站点上线后的读回检查失败会使任务报错，但不会自动回滚。`propagation-lag` 先重跑读回；`corrupt` 需核对失败文件，再重新运行上一有效发布提交的工作流。
- 来源发现与检索索引失败不阻断发布：分别沿用线上发现目录与上一版索引，并在 Actions 告警。
- 阶段 5 之前的 Web 1.12.0 提交 `27d96679c855726caa660b21f45f9a9f592f5246` 没有这套工作流；它的源码历史仍可恢复，需通过 Pages 发布步骤重新上传旧静态站点。
- 内容发布保留当前和上一不同有效版本，完整校验后切换指针；首次共享库发布只有一个真实版本。不要把重复构建称为两个版本。历史资源只有在新包包含需要保留的两版并通过检查后才随整包替换回收。
- Worker 可在控制台选定已验证版本回滚。首次有效版本为 `5bcb901e-2903-49be-804b-95d293938b46`；回滚后重新核对搜索和备用资料版本。本轮验证保留/损坏阻断逻辑，没有为演示回滚切换正式流量。
- 客户端下载失败保留本机完整缓存；备用资料地址可在「服务连接」手动设置为 `https://yueqian-content-search.ricardofeng619.workers.dev/content-library/`，并非自动切换备用。

规则来源：Cloudflare Workers 官方 limits 页面、GitHub Actions 官方 billing 与 schedule 文档。完整本地工作区的 `content-pipeline/VALIDATION-DEPLOYMENT.md` 记录本次部署及设备验收；设备日志不上传公开仓库。
