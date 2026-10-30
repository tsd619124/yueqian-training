# 静态外部检索索引（schema v1）

确定日期：2026-10-30。替代 Workers 联网检索作为两端默认的「官方来源 · 未审核」搜索。原因：中国大陆直连网络下，iPhone 访问 `*.workers.dev` 报 TLS 失败，而 `github.io` 已验证可达。

## 流程

1. CI（`publish.yml`）在 `discover-ci.mjs` 后运行索引构建：按发现目录逐篇读取候选原文（raw.githubusercontent.com，固定 revision），校验 git blob SHA，提取纯文本，生成索引。
2. 索引随 Pages 发布到 `content-library/search/`。上一版索引中 blobSHA 未变的文档直接复用，不再下载；单篇失败保留上一版条目；整体失败保留上一版索引。
3. 客户端（Web、iOS）在检查资料更新时读取指针，内容哈希变化才下载完整索引；校验 SHA-256 与字节数后原子替换本机缓存，离线可搜。
4. 客户端本地排序，算法与 `content-pipeline/search-common.mjs` 的 `queryTerms` / `rankDocuments` 完全一致。
5. Workers 检索服务降为可选：只有用户在「服务连接」里主动填写、且不是旧默认地址时才调用。

## 文件

`<contentBaseURL>search/latest.json`（指针，小文件，`cache: no-store` 读取）：

```json
{ "schemaVersion": 1, "indexPath": "search/index-<sha256>.json", "indexSha256": "<64 hex>", "bytes": 123456, "generatedAt": "ISO-8601", "documentCount": 100 }
```

`indexPath` 相对于 contentBaseURL；文件名中的哈希即 `indexSha256`。正式 contentBaseURL：`https://tsd619124.github.io/yueqian-training/content-library/`（Web 用相对路径 `./content-library/`）。

`<contentBaseURL>search/index-<sha256>.json`：

```json
{
  "schemaVersion": 1,
  "generatedAt": "ISO-8601",
  "kind": "external-candidates",
  "reviewStatus": "unreviewed",
  "sources": [{ "id": "microsoft-agents", "repository": "microsoft/ai-agents-for-beginners", "publisher": "Microsoft", "revision": "<40 hex>", "checkedAt": "ISO-8601", "status": "ready|retained|partial", "documentCount": 19, "totalMatchingFiles": 19, "selectionLimited": false }],
  "topics": [{ "id": "rag", "title": "RAG 与检索", "terms": ["retrieval augmented"] }],
  "documents": [{ "id": "<sourceID>:<16 hex>", "sourceID": "…", "repository": "owner/name", "revision": "<40 hex>", "path": "13-agent-memory/README.md", "url": "https://github.com/<repository>/blob/<revision>/<path>", "blobSHA": "<40 hex>", "sha256": "<64 hex，原始字节>", "title": "…", "text": "纯文本，≤ 12000 字符" }]
}
```

### 约束（客户端必须校验，不满足则整份拒收、保留旧缓存）

- 索引文件 ≤ 4 MiB；`documents` ≤ 400；`title` ≤ 400、`text` ≤ 12000、`id` ≤ 200 字符；`topics` ≤ 100。
- `sourceID` 只能是 `microsoft-genai`、`microsoft-agents`、`openai-cookbook`，并与 `repository` 对应；`revision` 为 40 位 hex；`url` 必须等于 `https://github.com/<repository>/blob/<revision>/<path>`，path 按段 encodeURIComponent。
- 已作为正式资料发布的课程（同来源、同课程目录，如 `translations/zh-CN/15-rag-and-vector-databases/` 与 `15-rag-and-vector-databases/`）由构建端排除，不进入索引。

## 结果项

与原 Workers `external.results` 相同：`id, title, excerpt(≤280), url, repository, revision, sourceID, kind:"external", reviewStatus:"unreviewed", sha256, score, checkedAt(取所属 source 的 checkedAt)`。界面继续标注「官方来源 · 未审核」，不自动进入课程。

## 一致性测试

`content-pipeline/fixtures/search-index-sample.json` 与 `search-index-expectations.json` 由 `rankDocuments` 生成。三端测试必须复现每个查询的结果 ID、顺序、score 和 excerpt。注意：excerpt 按 JavaScript 的 UTF-16 下标切片，Swift 实现需按 UTF-16 偏移计算。
