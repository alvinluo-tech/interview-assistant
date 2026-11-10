# 深度核验问题修复与验收

日期：2026-11-05。对应 [深度核验报告](2026-11-04-deep-revalidation.md)。

本轮关闭 R01–R04 四项缺陷，并完成局域网连接资源限制与桌面 CSP 两项加固。之前 F01–F14 的修复也纳入本地提交。用户明确要求暂不推送或发版，并明确将手机副屏传输加密留到本轮之外。

## 修复结果

| 项目 | 调整 | 验收 |
| --- | --- | --- |
| R04 结束后迟到启动又收音 | 浮窗启动任务可取消；创建会话时检查取消信号；每个配置读取/写入等待点后检查会话归属；采集入口拒绝空会话、已结束会话和旧会话调用者 | 结束期间放行延迟写入后仍为 ended、sessionId=null、合成麦克风启动次数为 0；创建期间取消、StrictMode 重挂载、恢复会话及旧调用者回归通过 |
| R03 旧显示响应覆盖隐藏 | 等两个事件订阅就绪后才查初始快照，初始化期间不启动业务；查询与事件共享修订序号；卸载后忽略查询；原生显示序号单独去重 | 旧正值不能重新激活隐藏状态；旧快照不能覆盖新显示序号；重复显示事件不重复挂载；订阅延迟/卸载及初始化途中事件回归通过 |
| R01 普通 Dialog 焦点与嵌套 | 普通表单、语音通话和更新提示共用一个模态层级；表单挂到 body；最上层负责焦点、inert、Escape、滚动锁和恢复；补 dialog 标题语义 | 正反 Tab、背景焦点、嵌套 Escape、遮罩、锁定表单、输入法组合态、全部控件禁用、整体卸载、同时挂载、已有 inert 均有真实浏览器验收 |
| R02 延迟订阅清理缺口 | 取消待执行定时器，并用 disposed 阻止已经排队的回调在卸载后添加监听 | 即使强制执行已取消回调，仍是 0 个待处理定时器、0 个遗留监听 |
| 局域网连接边界 | 全局最多 32 个连接处理任务；配额跨副屏重启共享；RAII 释放；请求头限制 8KiB；从接入时刻起计算 5 秒总时限；轮询停止标志；响应/写入超时受限 | 并发争抢不能越界，退出后名额恢复；持续滴入字节不能续命；停止、超长头和截断头被拒绝；正常配对及 WS 仍可用 |
| CSP 为空 | 生产环境只允许本地脚本及必要 WASM；阻止 eval、动态内联脚本、对象、表单导航与任意网页外连；单独保留开发热更新配置；允许本地 PDF worker、图片、字体和 Blob 音频 | 浏览器真实策略下 PDF/worker/WASM/图片/静音媒体加载通过，攻击载荷被拦截；原生打包程序中可信启动脚本和 IPC 可用，动态内联脚本被拦截 |

PDF 读取在禁止 JavaScript 动态求值的实际 CSP 下验收通过，保留必要的 WASM 支持。手机服务仍使用 HTTP/WS；连接限制和桌面 CSP 不应被表述成“手机传输已加密”。

## 从失败到通过

- 新增生命周期/CSP 测试最初 12 项中 10 项失败；清理测试失败；普通 Dialog 在浏览器中缺少模态语义，验收失败。
- 连接配额/头部总时限先定义 Rust 测试合同；实现前因缺少 ConnectionSlots/read_request_head 编译失败，随后补齐实现并运行。
- 对抗性扩展还发现“保存时所有控件被禁用，第一次 Tab 可能落到 BODY”的边界；已改为没有可聚焦控件时始终拦截 Tab，聚焦弹窗根节点。
- 这些检查已转为可重复运行的测试，不把本来能复现故障的探针记作“正常通过”。

## 验收范围

| 检查 | 结果与记录 |
| --- | --- |
| 全量 Node 测试 | 310 通过，0 失败；artifacts/audit/remaining-tests.txt |
| Rust workspace lib | 63 + 10 = 73 通过，2 项显式忽略；artifacts/audit/remaining-native-tests.txt |
| 普通/嵌套模态浏览器验收 | 12 项通过；artifacts/audit/modal-boundaries.json |
| 原业务浏览器边界 | 13 项通过；artifacts/audit/fixed-browser-boundaries.json |
| 原五套 UI 流程 | experience、mock-room、overlay、updater、bug-review 全通过；artifacts/audit/browser-suites.json |
| 原生隔离应用验收 | 13 项中 12 项通过；Docker Linux 引擎未就绪的一项标记未验证；包括真实拒写回滚、加密往返、配对和 CSP/IPC；artifacts/audit/fixed-native-boundaries.json |
| 新增时序/清理探针 | R01–R04 均为 fixed；deep-review-revalidation 与 second-review-revalidation 的 --verify 通过 |
| CSP 实际浏览器验收 | PDF 文本/worker、WASM、图片和 Blob 媒体通过；eval、内联脚本、外连拦截通过；artifacts/audit/csp-boundaries.json |
| 协议与输入分片 | 2,016 组合通过；artifacts/audit/protocol-fuzz.json |
| 依赖检查 | pnpm audit 使用公共 registry，未报告已知漏洞；未修改用户 registry 配置 |
| 构建 | 前端及正常标识的 Windows 开发构建通过；隔离原生验收结束后恢复正常构建 |

模态管理的浏览器覆盖明细位于 artifacts/audit/modal-coverage.json，只代表这个模块和这些场景，不代表全应用覆盖率。源文件指纹及结构化验收摘要见 [本轮证据](2026-11-05-followup-evidence.json)。之前的基线证据保留为历史快照，不用修复后的代码冒充基线未变化。

## 复验命令

```text
node --test tests/*.test.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace --lib
node scripts/audit/browser-boundaries.mjs --verify
node scripts/audit/modal-boundaries.mjs
node scripts/audit/csp-boundaries.mjs
node scripts/audit/deep-review-revalidation.mjs --verify
node scripts/audit/second-review-revalidation.mjs --verify
node scripts/audit/run-browser-suites.mjs
pnpm exec tauri build --debug --no-bundle
```

原生隔离验收使用 native-boundaries.mjs --build --verify，会临时生成独立应用标识的测试程序；完成后需要重新执行正常 tauri 构建。它不会运行真实安装器或访问用户自己的应用资料。

## 仍保留的边界

- 按用户本轮明确选择，手机副屏 HTTP/WS 传输加密不实现。
- Windows 上的 Chromium/WebView2 验收不替代 Mac 真机的 TCC、Space、全屏、更新替换和 WKWebView 验收。
- 未进行真实麦克风/蓝牙/会议软件/睡眠长通话，也未执行真实安装、卸载或更新交接。
- Docker Linux 引擎未就绪；代码沙箱的实际容器执行不能计为通过。
- 现有两个原生忽略项仍需指定真实音频条件和显式下载的模型，不擅自启用硬件或下载。

提交策略：保留本地检查点和最终修复提交，不推送、不创建 tag、不触发发版。
