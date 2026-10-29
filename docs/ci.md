# CI 与构建缓存

## 运行范围

- **Check Desktop**：所有拉取请求、main 推送及手动运行。Windows x64、Mac ARM64、Mac Intel 并行执行前端回归与覆盖率门槛、原生单元测试、完整 Release 编译链接和安装包生成。Mac 同时校验权限 plist 与 DMG。产物保留 7 天，不公开发布。
- **Release Desktop**：推送 `v*` 标签或手动指定已有标签。同步版本、测试、打包并校验校验和后，才创建并公开 Release。构建附件保留 14 天。
- 所有检查步骤分别执行，避免 Windows 中前一个测试失败被后续成功命令覆盖。核心覆盖率套件已经包含文档、实时 ASR 和可靠性测试，不再重复运行这三个套件。
- 前端在原生测试前构建一次；后续打包显式使用 `src-tauri/tauri.ci.conf.json` 跳过重复 hook。普通本地 `pnpm tauri build` 仍自动构建前端。不要在未执行 `pnpm build` 时使用该 CI 配置。
- 拉取请求不设置路径过滤，便于将三个平台的稳定检查名用于 required checks。工作流配置本身不会启用分支保护；仓库保护规则需单独配置。

## 缓存复用

两条工作流使用相同的 Rust `shared-key: desktop-<target>`，覆盖默认包含 job ID 的缓存键。Rust 版本、runner OS/架构、Cargo 清单、锁文件与相关环境仍参与 action 自动生成的键；不同目标不混用。主分支同时构建测试和 Release 依赖，使未来标签能从默认分支恢复依赖编译结果。

主分支检查保存 Rust 缓存，PR 只恢复；发布在标签或 main 上运行时允许保存。保留 `cache-on-failure`，使失败构建已完成的依赖编译也能保存。GitHub 的缓存隔离仍生效：标签可读取默认分支缓存，但不能直接读取另一个标签的缓存。新共享键首次运行会冷启动，主分支完成保存后才可验证命中效果。

Rust 缓存主要保存 Cargo 下载和编译后的第三方依赖，默认不保存本项目工作区 crate，也不保存增量目录。应用本身仍需编译、链接与打包；测试和 Release 是不同 profile，不能把测试产物直接作为 Release 使用。工具链、锁文件或 runner 镜像变化也可能引发重新编译。

Node 缓存由 `setup-node` 管理 pnpm store，以锁文件参与生成缓存键；它不缓存 `node_modules`，每次仍执行 `pnpm install --frozen-lockfile`。Actions 上传的安装包是产物，和编译缓存用途不同。

## v0.1.1 基线

[实际发布运行](https://github.com/alvinluo-tech/interview-assistant/actions/runs/40811281321) 总耗时 18 分 28 秒。以下各平台任务并行运行，不能将时长相加作为等待时间。

| 阶段 | Windows x64 | Mac ARM64 | Mac Intel |
| --- | --- | --- | --- |
| 原生测试（包含编译） | 3:39 | 2:48 | 3:23 |
| 安装包构建 | 9:51 | 8:05 | 6:54 |
| 任务总耗时 | 16:04 | 12:32 | 12:10 |

当次三个 Rust 缓存均未命中；Mac pnpm 命中，Windows pnpm 未命中。发布任务 2:19，其中 runner 准备约 2:10，真正创建、上传、公开约 5 秒。Windows 是最长构建路径，原生 Release 编译链接占主要时间。

本次保留 `lto = true`、`codegen-units = 1` 等现有发布优化参数；先验证共享缓存收益。Thin LTO 或 sccache 应单独对照测量冷启动、命中构建、二进制大小与运行性能，再决定是否启用，不能用一次不同 runner 的快慢直接推断效果。

参考：[GitHub 缓存访问边界](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache)、[Rust cache 配置](https://github.com/Swatinem/rust-cache)、[pnpm store 缓存](https://github.com/actions/setup-node#caching-global-packages-data)、[Cargo LTO](https://doc.rust-lang.org/cargo/reference/profiles.html#lto)。
