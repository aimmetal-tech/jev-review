# jev-review 开发约定

本文件适用于整个仓库。开发者和 Coding Agent 修改代码、配置或文档时，均应遵循这些约定。

## 项目名称与概要

- 项目名称、npm 包名和 GitHub 仓库名统一为 `jev-review`。
- 仓库地址：<https://github.com/aimmetal-tech/jev-review>。
- 采用 **MIT** 协议，许可证正文以根目录 `LICENSE` 为准。
- 使用 TypeSafe 的 **Jev 决策模型**，在 Coding Agent 执行工具前评估用户授权与操作风险，目标是降低自动审查的模型成本并提高效率。
- 现阶段适配 **Pi Harness** 和 **DeepSeek Harness（DSH）**。新增其他 Harness 前，应有明确的任务需求。

两个适配器共用审查核心，但保留各自宿主的审批机制：Pi 拦截工具事件；DSH 接管原生 Auto review 的模型请求，由原生插件继续管理工具审批与人工确认。主 Agent 的模型配置不由本项目替换。

最终审查 LLM 通过 `LLM_API_KEY` 与 `LLM_BASE_URL` 读取凭据和 OpenAI Chat Completions 端点；未设置端点时使用 MiMo Token Plan 默认地址。DSH 的 `llmApiKeyEnv` 默认指向 `LLM_API_KEY`，显式 `llmBaseUrl` 优先于 `LLM_BASE_URL`；未指定时沿用共用核心默认地址。旧 `MIMO_TP_KEY` 与 `JEV_LLM_BASE_URL` 不再自动读取；Jev 仍使用 `TYPESAFE_API_KEY`。

Jev 接口使用结构化 Choice 决策，同一次请求评估授权和风险。受管操作在真实 Docker 沙箱站立权限内自动执行；越界先 Jev，再独立 LLM，未解决先拒绝并提示替代路径，连续达到恢复预算后才人工。不能可靠判断、取消、执行绑定或后端失败时不得静默放行。执行隔离只覆盖插件拥有的工具体，不把整个宿主服务或未受管工具称为沙箱。成本、延迟与分类质量必须区分文档估算、模拟测试和真实 API 测量。

## 技术栈

| 层次 | 技术与约定 |
| --- | --- |
| 运行环境 | Node.js ≥ 22.19，npm，原生 ESM（`type: module`） |
| 语言 | TypeScript，`strict`，`NodeNext` 模块解析；源码使用显式 `.ts` 导入 |
| 共用审查器 | Node.js 内置 API、Docker CLI、文件元数据检查、`fetch`、`AbortController`；站立沙箱权限、Jev 与 OpenAI 兼容 LLM |
| Pi 适配 | Pi Extension API；`src/adapters/pi.ts` 为入口，宿主类型导入在运行时擦除 |
| DSH 适配 | Cordis 插件与 `llm/stream` middleware、Schemastery 配置 schema、DSH 原生 Auto review |
| Lint | **Oxlint**，配置为 `.oxlintrc.json`；警告和错误均使检查失败 |
| 类型检查 | TypeScript `tsc --noEmit`，与 Lint 分开执行 |
| 测试 | `node:test` 与 `node:assert/strict`，Node.js 类型擦除；Jev 请求使用模拟响应 |
| 构建 | esbuild，仅将 DSH 入口打包为 ESM；第三方包保持 external |
| 包分发 | `package.json` 的 `pi.extensions`、`exports`、`files` 与 `dsh.bundle.patch` |
| 发布 | GitHub Actions CI/Release、npm 公开包与 provenance；仅使用 Trusted Publishing（OIDC），不读取发布 token |

依赖版本和兼容范围以 `package.json`、`package-lock.json` 为准。Pi 入口应保持无运行时第三方依赖，不得间接导入 DSH 的运行时依赖。

## 项目结构

```text
jev-review/
|-- AGENTS.md                   # 开发约定与结构同步规则
|-- README.md                   # 项目概要、Pi 使用、共用配置与边界
|-- LICENSE                     # MIT 许可证
|-- CHANGELOG.md                # 按版本维护的发布说明
|-- package.json                # 包身份、脚本、依赖与宿主入口
|-- package-lock.json           # npm 依赖锁文件
|-- tsconfig.json               # TypeScript 严格类型检查
|-- .oxlintrc.json              # Oxlint 规则
|-- .gitignore                  # 依赖、构建和打包产物的忽略规则
|-- .github/
|   `-- workflows/
|       |-- ci.yml              # Node.js 版本矩阵、云端真实模型与发布包安装验证
|       `-- release.yml         # tag 校验、GitHub Release 与 npm 发布
|-- docs/
|   |-- RELEASING.md            # 发布身份、版本流程和预构建安装
|   `-- LIVE_TESTING.md         # 云端真实模型场景、凭据、限额和证据边界
|-- scripts/
|   |-- release-info.ts         # tag/更新日志校验与 npm 重试检查
|   |-- check-package.ts        # 构建、打包、校验文件和隔离安装
|   |-- package-smoke.ts        # 已安装包的 Pi 加载与 DSH 导出验证
|   `-- live/                  # 测试专用，不随 npm 包分发
|       |-- core.ts            # 云端入口检查、限额、脱敏和证据判定
|       |-- prepare.ts         # 无凭据安装实际 tarball 和固定宿主、构建控制模块
|       |-- run.ts             # Pi RPC / DSH SDK 子进程、真实 API 预检查和场景报告
|       |-- observer.ts        # 可恢复的实际宿主 fetch 观测、故障注入与请求限额
|       |-- preload.ts         # 受测宿主的 Node fetch 观测入口
|       |-- pi-control.ts      # Pi 标准 API transport 的显式观测、工具白名单与结果证据
|       `-- dsh-control.ts     # DSH Auto preset、工具限制与 guard，不重复声明 native 呈现
|-- src/
|   |-- reviewer.ts             # Jev 客户端、授权/风险规则、配置与判定
|   |-- l1.ts                   # 可信工具、只读范围与规范路径的本地分类
|   |-- llm.ts                  # 独立最终审查的 JSON 协议、配置与故障回退
|   |-- recovery.ts             # 拒绝后恢复与延迟人工预算
|   |-- sandbox.ts              # Docker 执行、权限范围、精确一次性绑定与清理
|   |-- sandbox-worker.ts       # 容器内受管文件、命令与 Node 代码执行
|   `-- adapters/
|       |-- pi.ts               # Pi 工具拦截、人工审批与 /jev 命令
|       |-- dsh.ts              # DSH 原生审查协议转换与 Cordis 生命周期
|       `-- dsh-sandbox.ts      # DSH 受管工具、每 Agent 外层执行绑定、恢复预算与清理
|-- dsh/
|   |-- README.md               # DSH 安装、配置、兼容版本与审批边界
|   |-- cordis.patch.yml        # 原生 Auto review 与 Jev 适配器的插件行
|   |-- icon.svg                # DSH 插件图标
|   `-- locale/
|       |-- en.json             # 英文插件元数据
|       `-- zh.json             # 中文插件元数据
|-- test/
|   |-- reviewer.test.ts        # 配置、判定、上下文、路径与 API 故障回退
|   |-- l1.test.ts              # L1 分类、范围、链接、观察与执行档边界
|   |-- llm.test.ts             # 最终模型协议、顺序、隐私、故障与严格校验
|   |-- sandbox.test.ts         # 配置与真实文件/网络/代码/取消隔离
|   |-- execution.test.ts       # 模拟晚加载 Auto 回归；真实 Pi/DSH 零模型与越界双模型
|   |-- extension.test.ts       # Pi 事件、任务授权生命周期、交互、取消与参数变化
|   |-- dsh.test.ts             # DSH 协议转换与 Cordis middleware
|   |-- dsh-native.test.ts      # 真实 DSH 服务的原生审批链路
|   |-- release.test.ts         # 发布身份、版本、说明与重复发布保护
|   `-- live-model.test.ts      # 云端守卫、请求预算、脱敏、未覆盖与清理判定的模拟验证
`-- dist/                      # 构建生成，不纳入 Git
    `-- dsh.js                  # jev-review/dsh 导出，随 npm 包分发
```

`node_modules/`、`*.tgz`、`.release/` 和其他被忽略的本地产物不属于受版本管理的项目结构。`dist/dsh.js` 虽不提交 Git，但必须在打包前构建，并由 `package.json.files` 纳入分发包。`prepack` 自动构建 DSH，发布工作流发布经过验证的同一份 tarball。

云端真实模型测试由现有 CI 的 `workflow_dispatch.live_models` 显式开启，默认关闭；只在 GitHub 托管 Linux VM 中运行。`npm run live:prepare` 在无模型凭据步骤安装实际包与固定宿主；`npm run test:live -- pi|dsh` 使用测试 Secrets，报告写入 `.release/live-model/<host>/` 并保留 artifact 7 天。SDK client 仅为固定版本开发依赖，不改变 Pi 或插件运行时依赖。真实模型/宿主/Docker 测试不得在个人电脑执行；本地只做静态检查和模拟验证。

DSH 执行门在 Agent 创建后绑定到该 Agent 的作用域，并保留全局兼容回退，保证晚激活的原生 Auto 仍在真实执行证明的内层。测试专用 SDK 用户来源绑定仅接受 driver 提供的单一会话、任务 ID 和精确任务文本，在入队前补充 UI 等价来源并保留原消息 ID；不将任意 SDK 输入、工具内容或模型文本当作授权，也不改变生产原生角色规则。

执行准备依赖显式注入 tools、workingDirectory、permissionPresets；失败只返回目录、Docker 或路径规划的固定代码，不暴露原始参数、路径或后端错误正文。

## 结构性同步规则

每轮修改都应检查下表。更新受影响的内容，不为无关文件制造格式改动；代码、测试、配置与文档的同步修改应进入同一个功能提交。

| 变化类型 | 必须检查并同步的文件或内容 |
| --- | --- |
| 新增、删除、移动文件或目录 | 更新本文件的结构树及职责说明；修正所有受影响的源码/测试导入和文档链接。若影响源码或测试发现，检查 `tsconfig.json.include`、Lint 路径和 `package.json.scripts.test`；若影响分发，检查 `files`、`exports` 和宿主入口。 |
| 项目名、包名、仓库地址或许可证变化 | 同步 `package.json`、npm 生成的锁文件、`README.md`、本文件和 `LICENSE` 中对应的信息；包名变化还需更新 `dsh/cordis.patch.yml`、`dsh/README.md` 的模块名及安装路径。检查插件目录的路径保护规则和测试。 |
| 共用判定策略、Jev 问题/API 格式、阈值、上下文或路径保护变化 | 同步 `src/reviewer.ts`、`src/l1.ts` 与对应测试；检查两个适配器的集成测试。更新 `README.md` 的规则、配置和数据边界；DSH 行为受影响时同步 `dsh/README.md`。 |
| Pi 事件、命令、模式、交互或入口变化 | 同步 `src/adapters/pi.ts`、`test/extension.test.ts`、`README.md`；入口或宿主依赖变化时同步 `package.json.pi`、依赖声明与锁文件。 |
| DSH 配置、原生协议、审批映射或生命周期变化 | 同步 `src/adapters/dsh.ts`、`test/dsh.test.ts`、`test/dsh-native.test.ts`、`dsh/README.md`；插件默认配置变化时检查 `dsh/cordis.patch.yml`。确认 Pi 行为是否受共用核心影响。 |
| DSH 兼容版本变化 | 同步 `package.json` 的开发依赖、peer 范围及锁文件，核对 `REVIEW_POLICY_SHA256` 和请求形状，运行原生审批链路测试，更新 `dsh/README.md` 的已验证版本。不得为通过测试而关闭协议校验。 |
| 配置字段或默认值变化 | 检查 `src/reviewer.ts` 的环境变量、`src/adapters/dsh.ts` 的 Config schema、对应测试、两个 README 的配置表/示例及 patch 默认值。明确 Pi 环境变量与 DSH 行配置的区别，不假定它们自动互相覆盖。 |
| DSH 标题、描述、图标或导出变化 | 对齐 `dsh/locale/en.json` 与 `zh.json` 的语义；检查 `icon.svg`、`package.json.icon`、资源 `exports`、`files` 与 bundle patch。 |
| 依赖、运行版本、Lint/类型检查/构建脚本变化 | 使用 npm 更新并提交 `package-lock.json`；同步 `package.json`、相应工具配置、两个 README 中相关命令及本文件的技术栈/检查点。保持 `engines` 与实际使用的 API 相容。 |
| 新增、删除或重命名测试文件 | 同步 `package.json.scripts.test`，避免测试未被执行；更新本文件的结构树与覆盖说明，以及文档中引用的测试数量或覆盖范围。 |
| 版本号、发布身份、CI 或发布流程变化 | 使用 npm 同步 `package.json` 和锁文件，维护 `CHANGELOG.md` 对应版本的说明；同步 `.github/workflows/`、`scripts/`、`test/release.test.ts`、`docs/RELEASING.md` 及两个 README 的安装说明。本文件的结构树、技术栈和检查点一并检查。tag 必须等于 `v<package.json.version>`；不得移动已发布 tag。 |

补充约定：

- 改变公共行为时，同轮更新说明和有意义的行为测试。测试应验证结果与边界，不应仅复述实现。
- L1 快速放行必须同时满足可信工具来源、UI 确认的当前任务授权及路径规则；不得从名称、描述或工具参数推导权限。默认 observe，DSH 因缺少身份与会话绑定不启用 L1；凭据/上下文/key 等前置回退优先于 L1。
- 新沙箱站立权限与旧 L1 兼容模式分开：前者必须有真实受管执行体、固定工作区、明确挂载/网络范围和不可复用的许可绑定；模型或人工不能把后端失败解释为未隔离回退。默认连续未解决 3 次才人工，明确拒绝先让 Agent 寻找更安全替代。
- Docker/真实执行测试不计作模型分类质量测量；新增依赖图需纳入实际 tarball 安装检查，确保 Pi 无运行时第三方依赖。
- 修改共用核心或 DSH 入口后，重新构建 `dist/dsh.js`；直接编辑构建产物不会修复源码。
- 修改包名、入口、导出或分发资源后，执行打包检查，确认包内包含 Pi 源码、DSH 构建产物、patch、locale、图标及许可证。
- 不手工改写锁文件来伪装依赖变更，也不把 API key、真实凭据或私密操作样本放入源码、测试、文档或提交。

## 开发与提交检查点

安装依赖：

```bash
npm ci --ignore-scripts
```

**完成一轮功能闭环，并通过测试和 Lint 后，及时提交。** 一轮闭环包括：实现或修复完成、相关失败路径得到处理、有意义的验证完成、配置与文档同步、变更范围已检查。不要等待所有后续功能都完成才提交，也不要把互不相关的功能堆进一个提交。

每个提交前的最低检查：

```bash
npm run lint && npm run check && npm test
git diff --check
```

修改构建相关源码、共用核心或 DSH 入口/协议/依赖时，还须执行：

```bash
npm run build
```

修改包身份、入口或分发配置/资源时，还须在构建后执行：

```bash
npm pack --ignore-scripts --dry-run
npm run check:package
```

提交前检查 `git status --short`、`git diff` 和 `git diff --cached`：仅暂存本轮文件，不混入他人的改动、凭据、依赖目录或构建/打包产物。验证失败时先修复，再提交；若环境使必要检查无法执行，明确记录阻塞和未验证项，不得声称闭环已通过。

`check:package` 需要 npm 网络访问，并生成被忽略的 `.release/` 产物。发布相关修改还应校验工作流语法与 `release:info`。具体发布配置和操作以 `docs/RELEASING.md` 为准。

检查通过且暂存内容符合本轮目标后，立即创建提交。提交后的修改如果影响已验证行为，应补做受影响的检查并形成下一轮提交。推送到 GitHub 按用户已授权的任务范围执行；本地提交或推送不等同于 npm 发布、Release 或部署授权。

## Git 提交规范

新提交采用 Conventional Commits：

```text
<type>(<scope>): <description>
```

`scope` 可省略。标题说明本提交的具体结果；中文或英文均可，避免 `update`、`misc`、`修改代码` 等无法表达用途的标题。复杂变更在正文解释原因、公共行为变化、兼容影响和验证方式。

| type | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 行为或缺陷修复 |
| `refactor` | 不改变对外行为的结构调整 |
| `test` | 测试与测试基础设施 |
| `docs` | 文档与开发约定 |
| `build` | 构建、依赖或分发配置 |
| `ci` | 持续集成配置 |
| `chore` | 其他维护工作 |
| `perf` | 有依据的性能改进 |

建议 scope：`reviewer`、`pi`、`dsh`、`tooling`、`packaging`。跨模块但属于同一个闭环时可省略 scope。

示例：

```text
feat(pi): support approval for user shell commands
fix(dsh): cancel pending reviews when the adapter unloads
build(tooling): configure Oxlint checks
docs: define project structure and commit checkpoints
```

破坏兼容性的修改用 `!` 标记，并在正文写明 `BREAKING CHANGE:` 和迁移方法。一个提交应能解释为一个完整目的，相关测试与文档随实现一起提交。保留已有提交历史，不为调整格式重写历史，不覆盖或丢弃用户已有改动。
