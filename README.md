# 跃迁计划 · AI 售前训练营

Web 1.14.0，原生配套内容 2.5.0（6）。学习进度保存在本机，公开仓库不包含个人学习数据或认证凭据。

- 正式 Web：https://tsd619124.github.io/yueqian-training/
- 资料主站：https://tsd619124.github.io/yueqian-training/content-library/
- 资料备用：https://yueqian-content-search.ricardofeng619.workers.dev/content-library/
- 检索服务：https://yueqian-content-search.ricardofeng619.workers.dev/api/search

`yueqian-training/` 为 Web 源码；`content-pipeline/` 为已审核图文构建、来源发现与检索服务；仓库内 `native-app/` 只含跨端一致性检查所需的三个资源与脚本，不是完整 iOS 工程。

GitHub Actions 使用公开仓库标准运行器，在 main 更新、手动运行及每日北京时间 06:17 进行测试、来源发现、校验与部署。定时调度可能延迟；任务失败时保留上一线上发布。来源发现只刷新候选目录，不自动审核材料或修改课程。Workers 至多每小时读取一次已校验的来源目录；超过 72 小时未核对的来源暂停外部读取。

当前内容为 10 篇已核准原文、49 张原图；外部检索仅覆盖配置仓库候选，明确标记未审核。进度、实操备份、原图缓存和服务连接独立保存。

## 本地检查

```sh
node --test content-pipeline/*.test.mjs
node content-pipeline/run.mjs build
node native-app/scripts/export-content-release.mjs --check
node native-app/scripts/test-content-release.mjs
node native-app/scripts/test-external-materials.mjs
node content-pipeline/discover-ci.mjs
```

最后一步通过已登录的 GitHub CLI 访问配置中的公开仓库；CI 使用只读短期凭据。无模型调用、付费搜索或学习记录上传。

## 回滚与运行

页面与静态资源作为一个 GitHub Pages artifact 发布；重新运行上一有效提交的发布工作流可回滚整站。内容发布包保留当前与上一不同版本，先完整校验，再切换指针；首次发布只有一个真实内容版本。Worker 使用 Cloudflare 的版本回滚功能；部署时不升级套餐。

Workers Free 的平台请求/CPU 上限与进程级限流分别生效；进程级限流不代表跨实例全账户配额。用量在 Cloudflare Workers Metrics 查看；可把 Worker 的 `EXTERNAL_SEARCH_ENABLED` 设置为 `false` 暂停外部正文读取，保留库内检索和静态资料。外部调用单次最多 3 篇、1.5 MB、8 秒；缓存最多 24 小时。监控工作流验证线上文件哈希与中文库内检索，失败记录在 Actions。

通过设置页面的服务连接可切换资料备用地址。内置与已缓存资料在主站或搜索服务不可用时仍可阅读。静态备用与主站为独立发布，新增审核内容时需一并部署；每日候选目录更新不会修改正式图文。
