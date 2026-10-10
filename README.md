# jev-review

使用 TypeSafe 的 Jev 决策模型，自动审查 Coding Agent 工具调用的授权范围和操作风险。项目与包名均为 `jev-review`，现阶段支持 **Pi Harness** 和 **DeepSeek Harness（DSH）**，采用 MIT 协议。

Pi 入口可由 Pi 直接加载，无运行时第三方依赖。需要 Node.js ≥ 22.19。

宿主适配器分别位于 `src/adapters/pi.ts` 和 `src/adapters/dsh.ts`，共用 `src/reviewer.ts` 中的 Jev 请求与判定逻辑。

也提供 **DeepSeek Harness（dsh）适配器**，接管原生 Auto review 的模型请求；安装和配置见 [dsh 使用说明](dsh/README.md)。Pi 入口不导入 dsh 运行时。

## npm 安装与启用

需要先安装对应的宿主。插件通过 Pi 或 DSH 的插件管理命令从 npm 安装，发布包无需克隆源码或手动构建。可用版本见 [npm 包页面](https://www.npmjs.com/package/jev-review)。

在 [TypeSafe 控制台](https://console.typesafe.ai/keys) 创建 API key，在启动宿主的同一个终端中设置：

```bash
export TYPESAFE_API_KEY='your-key'
```

Windows PowerShell 使用：

```powershell
$env:TYPESAFE_API_KEY = 'your-key'
```

### Pi

安装 npm 的最新发布版本：

```bash
pi install npm:jev-review
```

如需固定版本，使用 `pi install npm:jev-review@0.0.101`。默认安装到个人配置；仅当前项目使用时，执行 `pi install --local npm:jev-review@0.0.101`。

安装后重新启动 Pi，或在现有会话执行 `/reload`，然后用 `/jev status` 查看插件状态。默认 `auto` 模式会审查工具调用；缺少 API key 时转人工确认，无交互界面时阻止执行。

扩展类型检查使用 `@earendil-works/pi-coding-agent` 1.1.0；类型导入会被擦除。旧版 `@mariozechner/pi-coding-agent` 的相同核心接口可用，但需要在目标版本上验证。

### DeepSeek Harness（DSH）

以下命令将 npm 插件包安装到 Web profile，并启动已验证版本的 DSH：

```bash
npx @deepseek-ai/dsh@0.2.1-alpha.2 plugin --profile web add jev-review@0.0.101
npx @deepseek-ai/dsh@0.2.1-alpha.2 web
```

已安装该版本 DSH 时，也可使用 `dsh plugin --profile web add jev-review@0.0.101` 和 `dsh web`。省略插件包的 `@0.0.101` 可安装 npm 的最新发布版本。

在当前会话选择 **Auto review**，或执行 `/permission auto`，才会启用审查。安装插件不会自动切换会话权限。API key 从启动 DSH 的进程环境读取；安装不会替换主 Agent 的模型配置。更多配置和兼容边界见 [DSH 使用说明](dsh/README.md)。

### 其他安装方式

也可从 [GitHub Releases](https://github.com/aimmetal-tech/jev-review/releases) 下载预构建 `.tgz`，或克隆源码，使用本地包。Pi 示例：

```bash
pi install /absolute/path/to/jev-review
pi -e /absolute/path/to/jev-review/src/adapters/pi.ts
```

第一条命令持久安装，第二条只在本次 Pi 启动时加载。Release 附件已包含 DSH 构建产物；下载、校验、DSH 安装及维护者发布步骤见 [发布说明](docs/RELEASING.md)。版本变更见 [更新日志](CHANGELOG.md)。

## 决策规则

插件拦截所有 Agent 的 `tool_call`，包括 bash、read、edit、write 和自定义工具。向官方接口 `POST https://api.typesafe.ai/v1/systemone` 发出一次请求，在同一次请求中评估两个 Choice 问题：

| 问题 | 候选值 |
| --- | --- |
| 用户授权 | authorized / unapproved / unclear |
| 操作风险 | routine / sensitive / destructive / unknown |

- 用户授权为 authorized，风险为 routine，且两个结果各自的概率 ≥ 0.98、confidence ≥ 0.95：允许执行。
- 高概率、高置信度的 unapproved：阻止执行，并将拒绝原因返回给 Agent。
- 敏感、破坏性、未知、低置信度、缺少 key、超时或无效响应：交互模式询问用户，仅批准当前一次操作；无交互界面时阻止执行。
- 直接操作 `.env`、`.ssh`、`.aws`、`.gnupg`、`.codex`、`.pi` 或插件目录中的 path：人工确认，不向远端发送该操作。
- 上下文超过预算、用户消息含图片或无法识别的内容：人工确认，不截断后放行。

授权上下文来自当前会话分支上的用户文本消息，保留早先授权和较新限制。助手消息、工具返回和压缩摘要不作为用户授权证据。审查不读取磁盘文件内容；未知脚本、依赖和自定义工具的实际效果应归为 unknown。

Jev 的 confidence 由概率分布推导，不是独立的正确率保证。概率比较、批准规则和说明文字由本地代码处理，不要求 Jev 生成自由文本。

## 模式与配置

```text
/jev status
/jev mode auto
/jev mode manual
/jev mode shadow
```

`auto` 默认执行审查策略。`manual` 不调用模型，每次要求人工批准。`shadow` 只提示判断，**不依据审查结果阻止执行**，用于评估；通过命令启用时须确认。取消审查、参数变化或配置无效仍会阻止执行。

状态显示模式、模型、阈值、判定计数、已返回的 token 用量、平均审查耗时及最近判断，不显示 API key 或原始操作。统计和模式切换仅存于内存，重新加载后重置。已开始的审查沿用开始时的配置。

配置只读取启动进程的环境变量，不加载项目策略文件。修改后重新启动 Pi。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | 未设置 | 未设置时转人工确认 |
| `JEV_MODEL` | `jev-1.13.0` | 固定版本；也支持 jev-latest、jev-preview |
| `JEV_MODE` | auto | auto / manual / shadow |
| `JEV_PROBABILITY_THRESHOLD` | 0.98 | 范围 0.5–1 |
| `JEV_CONFIDENCE_THRESHOLD` | 0.95 | 范围 0.5–1 |
| `JEV_TIMEOUT_MS` | 5000 | 请求及读取响应的总超时，100–60000 ms |
| `JEV_MAX_STATE_BYTES` | 32768 | 完整 state 的 UTF-8 字节预算，1024–131072 |
| `JEV_REVIEW_USER_BASH` | false | true 时也审查用户 ! / !! 命令 |

无效配置会保留拦截器并阻止操作，不会退化成自动放行。不自动重试失败请求，避免在执行路径上长时间等待。API 重定向被拒绝，响应限制为 64 KiB，取消请求不会继续询问用户。并发人工确认弹窗串行显示。

## 开发验证与成本

```bash
npm ci --ignore-scripts
npm run verify
npm run check:package
```

以上命令在源码仓库运行。`verify` 依次执行 Oxlint、TypeScript 严格类型检查和测试。Lint 规则在仓库 [.oxlintrc.json](https://github.com/aimmetal-tech/jev-review/blob/main/.oxlintrc.json) 中配置；`npm run lint` 检查源码、测试与发布脚本，警告也会使检查失败。可用 `npm run lint:fix` 自动修复支持的规则。

`check:package` 通过 `prepack` 自动构建，生成 `.release/` 下的 tarball 和 SHA-256 校验文件，并在干净目录安装发布包，验证 Pi 加载器与 DSH 原生审批链路。它需要 npm registry 网络访问。项目结构、结构性同步规则、Git 提交规范和提交检查点见 [AGENTS.md](https://github.com/aimmetal-tech/jev-review/blob/main/AGENTS.md)。

测试覆盖 Pi 拦截、dsh 请求转换及原生审批流程，以及决策阈值、故障回退、取消和参数变化。Jev API 响应使用模拟数据；这些测试不能证明模型的实际分类质量。

根据 [TypeSafe 模型文档](https://docs.typesafe.ai/models)（2026-10-09），Jev 1.13 输入价格为 **$0.042 / 百万 token**，输出免费。每次若消耗 2000 输入 token，约 $0.000084；10 万次约 $8.40。这是按文档价格计算的估算，未实测成本、延迟或相对其他模型的降幅。

两个问题共享 state，只发出一次请求。不发送完整工具输出或 Agent 思考过程，不缓存批准结果，因为相同命令在文件、权限和环境变化后可能产生不同影响。投入使用前，应在自己的真实操作样本上评估误放行率、误拦截率、人工确认比例和 P95 延迟，特别是中文请求和对抗性输入。

## 数据与覆盖边界

自动审查会向 TypeSafe 发送本次工具参数、工具描述、工作目录和用户文本请求，这些字段可能包含源代码或私密文本。路径保护只覆盖直接 path 参数，不能识别所有秘密、符号链接或 shell 中的隐藏路径。人工确认会显示本次完整参数；通知不打印 API key 或服务端错误正文。

这是执行前审批扩展，不是操作系统沙箱。[Jev 官方已知局限](https://docs.typesafe.ai/model-jaggedness/jev-1.13)包括对抗性内容、间接推理和大上下文。需要强隔离时应同时使用文件系统、网络权限限制及沙箱。

插件无法限制其他扩展直接使用 `pi.exec`、直接访问文件系统、工具内部绕过 Pi 执行的动作或外部进程。后续 `tool_call` 处理器修改参数不会自动触发二次审查，应把本插件放在修改参数的扩展之后。其他扩展提前处理 `user_bash` 时，也可能使本插件收不到事件。

接口参考：[TypeSafe API](https://docs.typesafe.ai/api)、[置信度](https://docs.typesafe.ai/confidence)、[Pi 扩展](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[Pi 包安装](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。

## 协议

[MIT](LICENSE)
