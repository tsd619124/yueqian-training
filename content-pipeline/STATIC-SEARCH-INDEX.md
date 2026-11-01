# 静态外部检索索引（schema v1）

确定日期：2026-10-30。替代 Workers 联网检索作为两端默认的「官方来源 · 未审核」搜索。原因：中国大陆直连网络下，iPhone 访问 `*.workers.dev` 报 TLS 失败，而 `github.io` 已验证可达。

## 流程

1. CI（`publish.yml`）在 `discover-ci.mjs` 后运行索引构建：按发现目录逐篇读取候选原文（raw.githubusercontent.com，固定 revision），校验 git blob SHA，提取纯文本，生成索引。
2. 索引随 Pages 发布到 `content-library/search/`。上一版索引中 blobSHA 未变的文档直接复用，不再下载；单篇失败保留上一版条目；整体失败保留上一版索引。
3. 客户端（Web、iOS）在检查资料更新时读取指针，内容哈希变化才下载完整索引；校验 SHA-256 与字节数后原子替换本机缓存，离线可搜。
4. 客户端本地排序，算法与 `content-pipeline/search-common.mjs` 的 `queryTerms` / `rankDocuments` 完全一致，匹配模式见下节。
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
- `sourceID` 只能是 `microsoft-genai`、`microsoft-agents`、`openai-cookbook`、`didilili-agents`、`eosphoros-text2sql`，并与 `repository` 对应；`revision` 为 40 位 hex；`url` 必须等于 `https://github.com/<repository>/blob/<revision>/<path>`，path 按段 encodeURIComponent。路径允许中文等非 ASCII 文件名（拒绝控制字符、空白与 `%?#`）。
- 已作为正式资料发布的课程按“来源 + 归一后的完整文件路径”排除：`translations/zh-CN/15-rag-and-vector-databases/README.md` 与 `15-rag-and-vector-databases/README.md` 视为同一篇；同一目录下的多篇独立文章不会互相排除（如 `实战项目-电商问数/` 的 18 章）。
- 来源白名单的 5 个同步位置见 `content-pipeline/registry.test.mjs`；漏同步会让 `release.mjs check` 失败。

## 匹配模式（mode）

查询单元（query unit）的切分与 `queryTerms` 的 `direct` 完全一致：英文/数字串按 `tokens` 取词并去掉停用词；U+3400–U+9FFF 的中文连续段按相邻二字切分（单字段落取整段）。匹配时英文按整词边界（`(^|[^a-z0-9])词($|[^a-z0-9])`），中文按子串。

| mode | 收录条件 | 同义扩展的作用 |
| --- | --- | --- |
| `fuzzy`（默认） | 命中任一「查询单元」或「主题同义扩展」即收录 | 可以单独把文档带进结果（这就是「搜『问数』出现只讲语义层的文章」的原因） |
| `precise` | **每个查询单元都必须命中**（多单元 = AND）；没有查询单元时一条也不收录 | 只影响 score、摘要切片与命中说明，不参与收录 |

`mode` 缺省或取未知值时一律按 `fuzzy` 处理；三端（管线、Web、iOS）默认值相同。

两种模式的**评分公式、排序与 excerpt 切片完全相同**，因此可验证的不变量是：`precise` 的结果恒等于 `fuzzy` 结果中 `matchKind === "exact"` 的子集（ID、顺序、score、excerpt 一致）。结果条数在过滤后才应用 `limit`。

已收录原文的本机检索（Web `local()`、iOS `LocalMaterialIndex`）使用同一套模式语义：`fuzzy` 沿用原有子串匹配（`rag` 会命中 `storage`），`precise` 要求每个查询单元按整词边界/中文子串命中。

## 结果项

与原 Workers `external.results` 相同：`id, title, excerpt(≤280), url, repository, revision, sourceID, kind:"external", reviewStatus:"unreviewed", sha256, score, checkedAt(取所属 source 的 checkedAt)`。界面标注「外部来源 · 未审核」，不自动进入课程。

追加的可解释字段（additive，旧客户端与旧 `search-cache.json` 忽略即可，缺失时解码为 nil）：

| 字段 | 含义 |
| --- | --- |
| `matchedTerms` | 命中词全集，恒等于 `matchedDirect + matchedExpanded` |
| `matchedDirect` | 命中的查询单元（顺序与 `queryTerms.direct` 一致） |
| `matchedExpanded` | 命中的主题同义扩展 |
| `matchKind` | `"exact"`：全部查询单元都命中；`"expanded"`：只有同义扩展命中（仅 `fuzzy` 会出现） |

界面据此显示「命中：…」；仅在 `matchKind === "expanded"` 时补「同义扩展：…」。Workers 检索服务的响应同时带 `mode` 与这些字段，`/api/search` 接受 `mode=fuzzy|precise`（非法值 400）。

## 一致性测试

`content-pipeline/fixtures/search-index-sample.json` 与 `search-index-expectations.json` 由 `rankDocuments` 生成；每条期望带 `mode`，同时覆盖 `fuzzy` 与 `precise`。三端测试必须复现每个查询的结果 ID、顺序、score、excerpt、`matchKind`、`matchedDirect` 与 `matchedExpanded`。注意：excerpt 按 JavaScript 的 UTF-16 下标切片，Swift 实现需按 UTF-16 偏移计算。

样本里有两篇「问数」场景文档（`didilili-agents:…0005` 正文含「问数」；`…0006` 只讲 ChatBI 语义层，路径也不含「问数」），用来锁定两条不变量：模糊模式下 `…0006` 以 `expanded` 收录、精准模式下不出现；`ChatBI 问数` 两个单元分别命中两篇，精准模式结果为空。

## 构建记录

- 2026-10-30：首次真实构建 111 篇 / 3 来源（Microsoft 生成式 AI 12、Agents 19、Cookbook 80，排除已发布 10 篇）。
- 2026-11-01（随 Web 1.18.0 发布）：5 来源 / 119 篇 / 1,033,714 字节。Microsoft GenAI 12、Microsoft Agents 14、Cookbook 80、didilili 电商问数 13、Awesome Text2SQL 0（唯一候选即已发布的中文 README）。`didilili-agents` 的 13 篇为中文路径，验证了客户端 `encodeURIComponent` 编码与 Swift `sourceURL` 一致；线上索引 sha `e84e13b1…`。
