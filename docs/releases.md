# 发布流程规范

本文是 Mianxu 的发布操作规范。其他 agent 接手提交、发版、续跑或排查发布失败时，按本文逐项核实；以实际仓库和 GitHub 状态为准，不凭聊天中的“已完成”推断结果。

## 1. 发布入口与前提

- 仓库：`alvinluo-tech/interview-assistant`；正式代码分支：`main`。
- 发布定义：`.github/workflows/release.yml`；版本与产物工具：`scripts/release.mjs`；签名构建配置：`src-tauri/tauri.release.conf.json`。
- `main` 推送触发 **Check Desktop**，仅检查，不公开发布。推送 `v*` 标签或手动运行 **Release Desktop** 才会进入发布流程。
- 准备工具：Git、GitHub CLI、项目要求的 Node/pnpm、Rust 和当前平台构建工具。先确认 GitHub 登录账户有仓库发布权限。
- 修改文档、编译本地 EXE、提交代码与公开发布是不同操作；只有用户明确要求发版后才进入外部发布步骤。
- 命令逐条执行并检查退出码。失败后先处理原因，不让后续成功命令掩盖错误。

下面带变量的示例使用 PowerShell 7；macOS 可使用 `pwsh` 或转换为等价 shell 命令。`vX.Y.Z` 是占位符，必须替换成核实后的版本号；不直接照搬示例版本。

## 2. 同步代码并确定发布范围

1. 检查当前分支、远程地址和所有工作区改动，区分其他 agent 的工作和本机资料。
2. 拉取远程分支和标签。远程有新提交时先合并，冲突同时保留两边意图，尤其注意国际化与平台修复修改同一段逻辑的情况。
3. 在 GitHub 核实上一个**已经公开**的版本。正式版以上一个公开正式版为基线，不使用草稿、未发布标签或单纯按标签名排序的结果。预发布需明确并记录比较基线。
4. 核对完整提交区间及工作区待提交差异。上个版本以后，其他 agent 已提交的国际化、跨平台修复和功能改动也属于本次范围。

```powershell
git status --short --branch
git remote -v
git fetch origin --tags
gh release list --repo alvinluo-tech/interview-assistant --limit 100 --json tagName,isDraft,isPrerelease,publishedAt

$repo = "alvinluo-tech/interview-assistant"
$base = "v上一公开正式版"
$tag = "vX.Y.Z"
git log --oneline "$base..HEAD"
git diff --stat $base HEAD
git diff
```

版本采用 `v主版本.次版本.补丁版本`，或 `v主版本.次版本.补丁版本-beta.1` / `-rc.1` 等预发布形式。遵循仓库既有版本顺序，先查本地标签、远程标签和同名 Release，避免重用。版本数值不得超过 Windows 允许的 65535，不使用 build metadata。

## 3. 完成改动与验证

- 明确本次提交包含哪些文件；逐项审查差异。其他人的改动保留并适配，不通过整文件回退消除冲突。
- 其他产品对比、差距分析及本地研究资料留在本地；公开 README 和更新说明也不添加这些资料的链接。检查暂存区，不只依赖 `.gitignore`。
- 确认没有密钥、个人资料、机器专用路径、缓存或本地安装包进入提交。
- 前端、原生接口、锁文件、权限或工作流发生变化时执行对应检查；合并远程修复后，重跑受影响检查。
- 现有通过结果只在代码版本和检查范围仍匹配时复用。与本次变更相关的实机验证情况要明确记录；单元测试通过不等于所有设备已验收。

本地基线检查：

```powershell
pnpm install --frozen-lockfile
node --test tests/*.test.mjs
pnpm test:release
pnpm test:core-coverage
pnpm test:ai
pnpm build
cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace --lib
pnpm audit --registry=https://registry.npmjs.org
```

前端须先构建，再执行依赖嵌入资源的原生测试。具体 CI 检查以工作流为准，包括协议/音频、桌面行为、更新器、安装器与覆盖率门槛。Windows 本地验证不能替代 macOS runner 的编译和 Mac 实机验证。

## 4. 编写中文更新说明

唯一范围规则：**汇总上一公开版本至本次目标提交之间的全部最终改动，不能只总结最近一次提交或当前对话。**

- 默认简体中文，面向用户描述最终行为；建议按“新增与优化 / 修复与稳定性 / 使用说明”组织。
- 纳入国际化、平台功能和用户能感知的修复；将重复修复合并为同一条。
- 不把已撤回的方案、上版已公开的内容或尚未验证的能力写成新增或已完成。
- 写明影响使用的配置、系统要求或已知限制。没有真实测试证据时，不声称所有平台、设备、全屏或网络场景均已验证。
- 保存为 `docs/release-notes/<标签>.md`，正文注明上一版本，并附上该标签区间的 GitHub compare 链接。
- Release 草稿正文与本地说明一致；`latest.json` 将使用草稿正文作为应用内更新说明。不要用自动生成的英文提交列表替代已审核中文说明。

参考模板：

```markdown
# Mianxu vX.Y.Z

本次更新汇总 v上一版本 之后的改动，主要改善……

## 新增与优化

- 用户可感知的最终功能。

## 修复与稳定性

- 问题触发条件与修复后的表现。

## 使用说明

- 配置要求、平台限制及实际验证范围。

完整变更范围：[上一版本…本版本](https://github.com/alvinluo-tech/interview-assistant/compare/上一标签...本次标签)。
```

## 5. 提交代码并固定目标提交

1. 选择性暂存代码、测试、公开文档和更新说明；检查 `git diff --cached` 与 `git diff --cached --check`。
2. 提交并推送 `main`。遇到远程更新先合并、验证，不强制覆盖远程。
3. 取得并记录**完整 40 位提交 SHA**，核实远程 main 已包含该提交。本次标签、Release 目标和后续构建必须指向同一个提交。
4. 检查该提交的 **Check Desktop** 结果。检查失败先修复并重新固定目标提交，不能用另一个提交的绿色结果代替。

```powershell
git diff --cached
git diff --cached --check
git commit -m "按项目约定填写提交说明"
git push origin main
$releaseSha = (git rev-parse HEAD).Trim()
git ls-remote origin refs/heads/main
gh run list --repo $repo --workflow desktop-check.yml --commit $releaseSha --limit 5
```

本地仍有有意排除的改动时，记录排除项，确认不会进入发布。不要为了“工作区干净”而删除或提交私人资料。

## 6. 先创建草稿，再推送标签

**此步骤是公开发布的触发边界。** 在代码、检查、中文说明和目标 SHA 确认后执行。

先查看同名版本状态：

```powershell
git show-ref --verify "refs/tags/$tag"
git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}"
gh release view $tag --repo $repo --json tagName,isDraft,isPrerelease,targetCommitish,url
```

首次发布时“标签/Release 不存在”是正常结果，但认证失败、连接失败不能当作“不存在”。已有公开版本不重用；已有草稿或标签时，先核对目标，再进入失败恢复流程。

准备草稿：

```powershell
gh release create $tag --repo $repo --draft --target $releaseSha --title "Mianxu $tag" --notes-file "docs/release-notes/$tag.md"
gh release view $tag --repo $repo --json isDraft,tagName,targetCommitish,body,url
```

预发布草稿在 `release create` 中增加 `--prerelease`。必须确认草稿存在、目标正确、正文为审核后的中文，才继续推标签。`--target` 使用已推送的完整 SHA，避免短 SHA 导致 `Release.target_commitish is invalid`；不要在这里使用 `--verify-tag`，首次草稿创建时远程标签尚未推送。

正常情况下远程还没有同名标签，创建并推送带注释标签：

```powershell
git tag -a $tag $releaseSha -m "Release $tag"
git rev-parse "$tag^{}"
git push origin "refs/tags/$tag"
```

如果创建草稿后发现远程标签已存在，先核实其最终提交与 `$releaseSha` 相同，并检查是否已触发工作流；不要继续重复建标签或强推。同名标签指向不同提交时停止该版本流程，保留证据并明确选择新版本，不静默移动标签。

CI 根据标签在临时检出目录同步 `package.json`、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock` 的版本。源分支保留开发版本号；不要为发版在本地执行 `node scripts/release.mjs prepare` 修改版本清单。

## 7. 观察三个平台构建与发布

```powershell
gh run list --repo $repo --workflow release.yml --limit 10
gh run view 实际运行ID --repo $repo
gh run watch 实际运行ID --repo $repo --exit-status
```

选择运行时核对标签、完整目标 SHA 和触发时间，避免观察同名旧运行。长任务可分次检查，不向用户把“已启动 CI”报告成“已发版”。

发布流程构建 Windows x64、macOS Apple Silicon、macOS Intel；所有构建成功后，发布 job 才校验签名与校验和、读取中文草稿、生成更新清单、上传附件并公开 Release。不要手动提前公开草稿或绕过签名/覆盖率检查。

CI 使用仓库 Secret `TAURI_SIGNING_PRIVATE_KEY` 和可选密码签名；公开密钥来自 `src-tauri/updater-public-key.txt`。只核实配置与结果，不导出密钥、不写入仓库、不为绕过失败更换密钥。更新包签名与 Windows Authenticode、Apple Developer ID/公证是不同机制。

## 8. 发布完成判定

以下全部满足才报告“发版完成”：

- 指定标签最终提交与本次目标 SHA 相同。
- 对应 **Release Desktop** 运行成功，三个平台及 publish job 全部完成。
- 同名 Release 已公开，正式/预发布类型正确，正文与审核后的中文说明一致。
- 附件存在且大小合理，签名/校验和验证已在发布 job 通过。
- 下载该版本 `latest.json`，核实版本、中文说明、三个平台键和下载地址均对应本次标签；不只检查“文件存在”。

预期附件（把 `<版本>` 替换为不带 `v` 的版本号）：

| 用途 | 文件 |
| --- | --- |
| Windows 安装包与直接运行版 | `Mianxu_<版本>_x64-setup.exe`、`Mianxu_<版本>_x64-portable.exe` |
| Mac 安装镜像 | `Mianxu_<版本>_arm64.dmg`、`Mianxu_<版本>_x64.dmg` |
| Windows 自动更新签名 | `Mianxu_<版本>_x64-setup.exe.sig` |
| Mac 自动更新包与签名 | `Mianxu_<版本>_arm64.app.tar.gz`、同名 `.sig`；`Mianxu_<版本>_x64.app.tar.gz`、同名 `.sig` |
| 更新清单与校验和 | `latest.json`、`SHA256SUMS.txt` |

```powershell
gh release view $tag --repo $repo --json url,isDraft,isPrerelease,tagName,body,assets
gh release download $tag --repo $repo --pattern latest.json --pattern SHA256SUMS.txt --dir "artifacts/release-check/$tag"
```

同目录已有文件时先确认归属，避免把旧下载当作本次结果。`latest.json` 的平台键应为 `windows-x86_64`、`darwin-aarch64`、`darwin-x86_64`，对应安装包及签名均属于当前版本。不要为了看下载次数而反复下载安装包；完整校验以 CI 结果及必要的产物复验为准。

向用户报告：标签、目标提交、Release 链接、验证结果、明确的使用限制；同时说明有意保留的未提交内容。

## 9. 失败恢复与后续交接

| 失败位置 | 处理 |
| --- | --- |
| 草稿创建返回 422 | 检查完整 SHA 是否已推送、仓库是否正确；确认错误请求未留下草稿，修正参数后重试，不先推标签 |
| 认证/网络失败 | 区分权限与连接问题，沿用已有安全凭据和网络配置；不打印凭据、不关闭证书验证、不把失败当作资源不存在 |
| 构建/测试失败 | 查看具体 job 和失败日志；短暂基础设施故障可重跑失败 job；源码缺陷修复后采用新目标和新版本，不改已推送标签 |
| 构建成功，发布 job 找不到草稿或中文说明 | 为同一标签、同一目标补齐正确草稿或正文，再重跑失败发布 job，不手动提前公开 |
| 上传中断，Release 仍是草稿 | 核实构建属于相同标签/目标后重跑失败 job；工作流可覆盖草稿同名附件并重新校验 |
| 版本已经公开 | 发布脚本拒绝重写公开安装包。二进制或更新包需要修正时发新版本；不替换已公开签名资产或移动标签 |

手动重跑已有标签的整个发布流程时，应先确认该版本尚未公开且目标未变：

```powershell
gh run rerun 实际运行ID --repo $repo --failed
# 仅在确需整条重跑且确认上述状态后使用：
gh workflow run release.yml --repo $repo --ref main -f "tag=$tag"
```

交接只记录事实，不自动执行下一阶段。最少包含：用户授权范围、版本和上一发布基线、完整目标 SHA、提交/推送情况、标签本地/远程状态、草稿/公开状态、运行 ID 与 job 状态、已通过的检查及适用提交、失败原因、下一步和有意排除的文件。后续 agent 必须重新读取 GitHub 状态后再行动。

## 平台与工具参考

- 缓存及性能口径见 [CI 与缓存](ci.md)；多语言维护见 [国际化](i18n.md)。
- Windows 本地可使用 `node node_modules/@tauri-apps/cli/tauri.js build --ci --bundles nsis -- --locked`，保留默认前端构建 hook。包管理器可能吞掉 Cargo 参数分隔符，正式 CI 因此直接调用 Node。
- `tauri.release.conf.json` 会跳过重复前端构建并启用更新签名产物，只在前端已构建且签名凭据齐备时使用。Windows 不能代替 macOS runner 生成与验证 DMG。
- macOS 最低支持 13，现有包使用 ad-hoc 签名，尚未完成 Developer ID 签名/Apple 公证。正常覆盖安装默认保留本机资料；用户手动选择卸载时删除应用数据会清除资料。
- 本地协议检查入口：`pnpm test:release`。它使用独立临时目录验证版本同步、产物筛选、签名和校验和，不修改源分支版本号。
