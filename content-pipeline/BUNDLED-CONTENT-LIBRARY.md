# 随包资料库（阶段 2 · 2.6 / 1.15 契约）

确定日期：2026-10-31。目标：原图不再以 base64 内嵌（`external-snapshot.js`、`external-materials.json`、`content-release-seed.js`、`content-release.json` 退役），三端共用同一份按哈希寻址的文件目录。

## 目录结构（与 Pages 上 `content-library/` 完全相同）

```
ContentLibrary/
  latest.json                      # { schemaVersion, releaseID, manifestPath, manifestSha256 }
  releases/<releaseID>/
    manifest.json                  # files[]: { path, sha256, bytes, ... }
    documents/<id>.json
    assets/<sha256>.<ext>          # 原图，文件名即内容哈希
    index.json  coverage.json  LICENSE.txt
```

- Web：`yueqian-training/content-library/`（随站点发布）。原文页按需读取 documents，原图用普通 `<img src>`（懒加载、带 `width`/`height`）；首次查看后由原文页写入 Cache API `yueqian-content-v1`，离线时从缓存取出。Service Worker 不拦截 `content-library/`，且清理旧缓存时必须保留 `yueqian-content-` 前缀。
- iOS：`native-app/Sources/YueqianCore/Resources/ContentLibrary/`，以文件夹整体打包（`Package.swift` 使用 `.copy("Resources/ContentLibrary")`，保持目录结构）。由 `native-app/scripts/export-content-release.mjs` 从 `yueqian-training/content-library/` 复制生成（排除 `.generated.json` 与 `search/`），`--check` 比对逐字节一致。
- 更新下载（两端已有）沿用同一布局，写入各自的缓存目录，按哈希复用文件。
- 资料库同时是构建来源：`run.mjs build` 由它还原原文与原图并重建同一 releaseID；更新或新增原文用 `native-app/scripts/update-external-materials.mjs`。
- 文档 `images[]` 含原图像素 `width`、`height`（构建期从文件头读取），供两端预留版面。

## 校验策略

- 随包文件在**构建期**校验（导出脚本 + CI），运行时不再对随包资料逐张做 SHA-256 与 ImageIO 解码。
- 运行时只校验**下载**得到的 manifest 与文件（字节数 + SHA-256），完整后原子切换。已校验并写入本机缓存（Web 的 IndexedDB / Cache API）的文件之后直接信任，打开时不再重算。
- 资料层任何失败只关闭「原文与配图」区域，不影响课程、训练与学习进度。
- 图片按显示尺寸解码，原图仅在放大查看时解码。
