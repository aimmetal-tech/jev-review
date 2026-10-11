# jev-review

使用 TypeSafe 的 Jev 决策模型，自动审查 Coding Agent 工具调用的授权范围和操作风险。项目与包名均为 `jev-review`，现阶段支持 **Pi Harness** 和 **DeepSeek Harness（DSH）**，采用 MIT 协议。

Pi 入口可由 Pi 直接加载，无运行时第三方依赖。需要 Node.js ≥ 22.19；默认沙箱还需要本地 Docker daemon 与预先准备的 Node 镜像。

> Sandbox 和 LLM 兜底属于当前 Unreleased 源码，尚未发布到 npm。已发布的 0.0.101 包保留旧审批流程；试用本轮功能请安装本地源码包。

宿主适配器分别位于 `src/adapters/pi.ts` 和 `src/adapters/dsh.ts`，共用 `src/reviewer.ts` 中的 Jev 请求与判定逻辑。

也提供 **DeepSeek Harness（dsh）适配器**，接管原生 Auto review 的模型请求；安装和配置见 [dsh 使用说明](dsh/README.md)。Pi 入口不导入 dsh 运行时。

## npm 安装与启用

需要先安装对应的宿主。插件通过 Pi 或 DSH 的插件管理命令从 npm 安装，发布包无需克隆源码或手动构建。可用版本见 [npm 包页面](https://www.npmjs.com/package/jev-review)。

在 [TypeSafe 控制台](https://console.typesafe.ai/keys) 创建 API key，在启动宿主的同一个终端中设置：

```bash
export TYPESAFE_API_KEY='your-key'
export LLM_API_KEY='your-final-review-key'
export LLM_BASE_URL='https://token-plan-cn.xiaomimimo.com/v1'
docker pull node:22-bookworm-slim
```

Windows PowerShell 使用：

```powershell
$env:TYPESAFE_API_KEY = 'your-key'
$env:LLM_API_KEY = 'your-final-review-key'
$env:LLM_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'
docker pull node:22-bookworm-slim
```

### Pi

安装 npm 的最新发布版本：

```bash
pi install npm:jev-review
```

如需固定版本，使用 `pi install npm:jev-review@0.0.101`。默认安装到个人配置；仅当前项目使用时，执行 `pi install --local npm:jev-review@0.0.101`。

安装后重新启动 Pi，或在现有会话执行 `/reload`，然后用 `/jev status` 查看插件状态。默认 `auto` 模式先使用沙箱站立权限；越界请求才审查。缺少审查 key 不影响已验证的沙箱内操作，但会使越界请求无法自动批准。

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

## Sandbox 与分层 Auto-review

实现参照 [OpenAI Auto-review 文章](https://alignment.openai.com/auto-review/)：大多数操作先在权限边界内执行，只对越界请求调用独立审查器。拒绝结果返回给 Agent 选择更安全的路径，不把每次拒绝变成人工审批。

```text
受管工具 -> 真实 Docker 沙箱（权限内直接执行，不调用模型）
越界请求 -> Jev 快速审查 -> 独立 LLM 兜底 -> 批准一次性权限或拒绝并反馈替代路径
仍无法判断 -> 先拒绝并让 Agent 恢复 -> 连续 3 次未解决才询问人工
```

默认 `workspace-write`，宿主初始项目目录是站立权限的根，后续 `cwd` 变化不会扩大它。`read-only` 不提供站立写入权限。Docker 执行使用只读容器根文件系统、默认 `--network none`、明确目录挂载、移除 capabilities、禁止新增权限、PID/内存/CPU 限制和受限临时目录；不挂载 Docker socket，不传入模型 API key，不自动拉取镜像。Docker CLI 使用固定的本地端点和已解析的镜像 ID。

Pi 在启动事件中把标准内置文件/检索/命令工具换成插件拥有的沙箱执行器；相同名称的其他扩展工具不作为隔离证明。DSH 注册 `jev_read / jev_write / jev_edit / jev_ls / jev_find / jev_grep / jev_bash / jev_code`，真实工具体直接执行容器操作。DSH 为新 Agent 选择 native 工具呈现，以便直接调用这些工具；原来的宿主 `run_code` 在沙箱开启时被阻止，容器内 Node 批处理改用 `jev_code`。主 Agent 的 provider 和 model 保持原样。

镜像提供执行环境，默认是 Linux Node.js + POSIX shell。特定程序、PowerShell 或项目原生依赖需要合适的自定义镜像；缺少程序返回错误，不会改在宿主执行。`jev_code` 提供容器内 `tools.read/write/edit/ls/find/grep/bash` 及对应 `jev_*` 别名；自定义远程工具应在 native 工具层调用并经过审查。

明显超出根目录的文件请求、只读模式下的写入、额外挂载或网络访问进入 Auto-review。命令不会被正则认定安全；不透明命令先在真实沙箱内执行，若需要更宽权限则显式请求 `sandbox_permissions: "require_escalated"`、`justification`，以及具体 `read_roots / writable_roots / network_access`。额外目录挂载在 `/extra/<index>`。不自动以更高权限重放失败命令，以免重复已发生的副作用。

Jev 调用官方 `POST https://api.typesafe.ai/v1/systemone`，一次请求同时判断：

| 问题 | 候选值 |
| --- | --- |
| 用户授权 | authorized / unapproved / unclear |
| 操作风险 | routine / sensitive / destructive / unknown |

`authorized + routine` 且各自 probability ≥ 0.98、confidence ≥ 0.95 时快速批准；其他结果或 Jev 故障交给独立 LLM 复核。最终 LLM 使用 OpenAI 兼容 Chat Completions JSON 模式，默认 `mimo-v2.6-flash`，key 来自 `LLM_API_KEY`，base URL 从 `LLM_BASE_URL` 读取，未设置时使用 `https://token-plan-cn.xiaomimimo.com/v1`。它独立判断授权、实际影响和边界变化；批准必须为明确授权且影响已知，敏感或破坏性操作只有在明确、有限的用户请求中才可批准。模型不替代执行器的固定约束。

明确拒绝直接返回固定原因和更安全路径提示。无法可靠判断、未配置审查器或模型故障先返回拒绝以便恢复，连续 3 次未解决才进入人工一次性批准；`never` 和无审批渠道继续阻止。`manual` 是用户显式选择的逐次人工模式，不适用自动恢复策略。一次性许可绑定工具调用、载荷、会话、目录和取消生命周期，不能改变参数、沿用到后续操作或缓存为长期豁免。

保护路径和已知审查器凭据不发送给远端模型。沙箱遮蔽工作区顶层的常见凭据/配置文件与目录；运行中插件源码、构建目录、依赖及 `.git` 的写入默认受只读限制。保护不是所有秘密的检测器，共享工作目录、宿主扩展和未受管工具仍是信任边界。未受管工具没有自动沙箱证明，进入模型审查。沙箱不可用、控制面文件挂载、协议或执行绑定错误不会自动退化成未隔离执行。

授权只使用用户文本与从属父任务，项目约束只能缩小范围。助手、工具输出与模型理由不授予权限；不完整或超预算的边界审查不会通过截断自动批准。Jev 的 confidence 是分布推导值，不是正确率保证；LLM 不伪造 Jev 的概率或置信度。模型判断不是确定性的安全保证，文章中的内部通过率、人工打断降幅也不是本项目的测量结果。

## L1 只读任务授权（Pi 兼容模式）

该旧式优化仅用于显式设置 `JEV_SANDBOX_MODE=off` 的兼容流程；默认沙箱流程不需要 `/jev read-task` 的逐任务确认。L1 只支持标准 Pi CLI 标记为内置的 `read`，不能仅凭工具名、描述、schema 或 `readOnlyHint` 放行。`write`、`edit`、shell、目录枚举及自定义工具继续进入 Jev。DSH 的原生快照没有可靠执行器身份与会话授权绑定，首版不启用 L1 快速放行。

默认 L1 档位为 `observe`：记录候选命中，实际仍由 Jev 审批。`enforce` 只有在审查模式为 `auto` 且任务授权有效时才跳过 Jev；`off` 关闭分类。L1 观察档与 `/jev mode shadow` 不同：观察档保留 Jev 审批，Pi shadow 不依据判断阻止操作。

在**普通项目**中，先建立观察任务，例如有现存 `docs` 子目录时：

```text
/jev l1 observe
/jev read-task docs -- 请用 read 读取 docs/usage.md 的前 20 行，不修改文件。
```

命令在 UI 展示完整任务、目录、保护例外和随机任务编号；只有用户确认后才提交任务。它要求宿主空闲、没有待发送消息、有交互 UI、上下文为完整文本，目录必须是工作区内现存的非链接子目录。目录和任务由第一个 ` -- ` 分隔，任务里后续的 ` -- ` 会保留；目录路径不需要额外引号。

这是一条新的、明确的目录只读授权，覆盖该范围内更早的读取限制，但不绕过凭据与插件目录保护，也不授予其他操作权限。任务文本包含确认后的授权范围和编号，编号只用于绑定。任务被扩展改写、派发失败或消息身份不匹配时，不建立快速授权。

观察结果符合预期后，在宿主空闲时切换档位，并为新任务重新确认：

```text
/jev l1 enforce
/jev read-task docs -- 请用 read 读取 docs/usage.md 的前 20 行，不修改文件。
/jev status
```

L1 仅接受 `path` 与可选的正整数 `offset`、`limit`。普通相对/绝对路径会检查实际目标、工作区与授权范围、普通文件类型和每级目录；符号链接、Windows junction、目录、缺失文件、未知参数、`~`、`@`、file URL、Windows shell 路径等特殊语法升级 Jev。文件元数据检查失败也升级，不猜测目标。

授权仅存于内存。除命令生成的那一次预期任务输入外，任何新输入、任务结束、会话切换、分支导航、压缩、重载，以及模式切换均撤销授权；确认或审批期间状态变化不能获得快速放行。兼容流程中的缺 key、不完整或超预算请求不会由旧 L1 放行；边界审查可用最终 LLM 兜底，仍未解决先返回恢复提示，达到预算后才人工。manual 是显式逐次人工模式。

**当前目录名保护保持原样**：路径含 `jev-review` 或 `pi-jev-review` 目录段会转人工，因此在本仓库直接试验普通文件读取也可能命中保护。验证 L1 请使用普通测试项目；目录名保护的收窄留作独立修改。

快速放行信任标准 Pi CLI 的内置 `read` 契约，不支持用定制 SDK 替换底层执行器后开启 enforce。没有可用来源字段的宿主、同名扩展工具均升级 Jev。检查不锁定文件系统，也不能阻止后置扩展改变参数；仍应将插件放在参数修改扩展之后，并使用宿主权限与沙箱。

## 模式与配置

```text
/jev status
/jev mode auto
/jev mode manual
/jev mode shadow
/jev l1 off
/jev l1 observe
/jev l1 enforce
```

`auto` 默认执行审查策略。`manual` 不调用模型，每次要求人工批准。`shadow` 只提示判断，**不依据审查结果阻止执行**，用于评估；通过命令启用时须确认。取消审查、参数变化或配置无效仍会阻止执行。

状态显示模式、模型、阈值、判定计数、已返回的 token 用量、平均审查耗时及最近判断，不显示 API key、原始操作或任务。统计和模式切换仅存于内存，重新加载后重置。已开始的审查沿用开始时的配置；撤销授权或参数变化仍会阻止该操作。

`layers` 分开记录 `l1Candidates`（满足规则的候选）、`l1Allows`（通过 Pi gate 的 L1 放行）、`jevRequests / llmRequests`（两层实际 fetch 请求尝试）、`sandboxAllows`（站立沙箱许可）、`humanRequests`（最后人工弹窗）、`localFallbacks`（本地回退），以及有效 Jev 结果中的 `comparedAllow / comparedDeny / comparedReview`。HTTP/超时/无效响应不计入有效结果对照。`stats.calls` 是审查总数，不能当作 API 调用数；L1 放行也不保证下游一定执行。L1 结果不伪造 probability、confidence 或 token 用量。

配置只读取启动进程的环境变量，不加载项目策略文件。修改后重新启动 Pi。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | 未设置 | 快速 Jev 层；缺少时可使用已配置的最终 LLM |
| `JEV_MODEL` | `jev-1.13.0` | 固定版本；也支持 jev-latest、jev-preview |
| `JEV_MODE` | auto | auto / manual / shadow |
| `JEV_SANDBOX_MODE` | workspace-write | off / read-only / workspace-write |
| `JEV_SANDBOX_IMAGE` | node:22-bookworm-slim | 已存在的可信 Linux Node 镜像，不自动下载 |
| `JEV_SANDBOX_TIMEOUT_MS` | 60000 | 100–600000 ms，取消会停止并清理容器 |
| `JEV_SANDBOX_DOCKER` | 可信安装目录 | 可指定绝对 CLI 路径，不接受命令字符串 |
| `LLM_API_KEY` | 未设置 | 独立 LLM 兜底 key |
| `LLM_BASE_URL` | https://token-plan-cn.xiaomimimo.com/v1 | HTTPS OpenAI Chat Completions 端点 |
| `JEV_LLM_MODEL` | mimo-v2.6-flash | 独立最终审查模型 |
| `JEV_LLM_TIMEOUT_MS` | 20000 | 100–120000 ms |
| `JEV_HUMAN_AFTER` | 3 | 连续未解决审查达到此数才人工，1–10 |
| `JEV_L1_MODE` | observe | Pi 的 off / observe / enforce；DSH 不读取此字段 |
| `JEV_PROBABILITY_THRESHOLD` | 0.98 | 范围 0.5–1 |
| `JEV_CONFIDENCE_THRESHOLD` | 0.95 | 范围 0.5–1 |
| `JEV_TIMEOUT_MS` | 5000 | 请求及读取响应的总超时，100–60000 ms |
| `JEV_MAX_STATE_BYTES` | 32768 | 完整 state 的 UTF-8 字节预算，1024–131072 |
| `JEV_REVIEW_USER_BASH` | false | true 时也审查用户 ! / !! 命令 |

无效配置会保留拦截器并阻止操作，不会退化成自动放行。不自动重试失败请求，避免在执行路径上长时间等待。API 重定向被拒绝，Jev 响应限制为 64 KiB，最终 LLM 为 128 KiB，取消请求不会继续询问用户。并发人工确认弹窗串行显示。

最终审查的旧 `MIMO_TP_KEY` 与 `JEV_LLM_BASE_URL` 不再自动读取，请改用 `LLM_API_KEY` 与 `LLM_BASE_URL`。DSH 默认读取同一组变量，但显式 `llmApiKeyEnv` / `llmBaseUrl` 行配置优先；`JEV_LLM_MODEL` 等 Pi 专用配置仍不自动覆盖 DSH。

## 开发验证与成本

### 云端真实模型测试

使用 GitHub 托管临时 Ubuntu VM，实际安装本轮 tarball，分别启动 Pi `1.1.0` 标准 CLI 和 DSH `0.2.1-alpha.2` SDK 宿主。主模型与最终审查均为 `mimo-v2.6-flash`，Jev 独立调用。配置仓库 Secrets `LLM_API_KEY`、`LLM_BASE_URL`、`TYPESAFE_API_KEY` 后，手动触发 CI 的 `live_models=true`；普通 push/PR 不使用凭据。不要在个人电脑运行真实入口。

六类场景分别在两个宿主各一次：权限内读写、授权越界写、金丝雀隔离、文档注入、Jev 故障后的真实最终审查。报告区分真实请求与故障注入，缺少实际目标操作记为未覆盖，文件副作用和清理也必须通过。模拟测试不替代真实报告，少量实跑不代表总体模型分类质量。完整配置、限额与 artifact 说明见 [云端测试](docs/LIVE_TESTING.md)。

### 常规检查

```bash
npm ci --ignore-scripts
npm run verify
npm run check:package
```

以上命令在源码仓库运行。`verify` 依次执行 Oxlint、TypeScript 严格类型检查和测试。Lint 规则在仓库 [.oxlintrc.json](https://github.com/aimmetal-tech/jev-review/blob/main/.oxlintrc.json) 中配置；`npm run lint` 检查源码、测试与发布脚本，警告也会使检查失败。可用 `npm run lint:fix` 自动修复支持的规则。

`check:package` 通过 `prepack` 自动构建，生成 `.release/` 下的 tarball 和 SHA-256 校验文件，并在干净目录安装发布包，验证 Pi 加载器与 DSH 原生审批链路。它需要 npm registry 网络访问。项目结构、结构性同步规则、Git 提交规范和提交检查点见 [AGENTS.md](https://github.com/aimmetal-tech/jev-review/blob/main/AGENTS.md)。

测试覆盖 L1 的授权/身份/路径边界、观察与执行档、Pi 授权生命周期、dsh 请求转换及原生审批流程，以及决策阈值、故障回退、取消和参数变化。Jev API 响应使用模拟数据；这些测试不能证明模型的实际分类质量，也不是实际成本或延迟测量。

根据 [TypeSafe 模型文档](https://docs.typesafe.ai/models)（2026-10-09），Jev 1.13 输入价格为 **$0.042 / 百万 token**，输出免费。每次若消耗 2000 输入 token，约 $0.000084；10 万次约 $8.40。这是按文档价格计算的估算，未实测成本、延迟或相对其他模型的降幅。

两个问题共享 state，只发出一次请求。不发送完整工具输出或 Agent 思考过程；最终 LLM 有独立费用与耗时，Jev 单价估算不代表整个链路成本。不缓存批准结果，因为相同命令在文件、权限和环境变化后可能产生不同影响。投入使用前，应在自己的真实操作样本上评估误放行率、误拦截率、人工确认比例和 P95 延迟，特别是中文请求和对抗性输入。

## 数据与覆盖边界

边界审查会向 TypeSafe 以及配置的最终 LLM 发送本次工具参数、工具描述、工作目录、技术边界与用户文本请求，这些字段可能包含源代码或私密文本，包括已确认任务中的目录与任务编号。L1 执行档命中时不发送该次操作；L1 的工具来源与授权记录不作为远端请求字段。路径保护只覆盖直接 path 参数，不能识别所有秘密或 shell 中的隐藏路径；L1 检查链接不等于 L2 路径保护全面解析链接。人工确认会显示本次完整参数；通知不打印 API key 或服务端错误正文。

审批模型本身不是隔离机制；新增 Docker 执行器提供受管操作的进程隔离，不能把整个宿主服务或未受管工具称为沙箱。[Jev 官方已知局限](https://docs.typesafe.ai/model-jaggedness/jev-1.13)包括对抗性内容、间接推理和大上下文。需要强隔离时应同时使用文件系统、网络权限限制及沙箱。

插件无法限制其他扩展直接使用 `pi.exec`、直接访问文件系统、工具内部绕过 Pi 执行的动作或外部进程。后续 `tool_call` 处理器修改参数不会自动触发二次审查，应把本插件放在修改参数的扩展之后。其他扩展提前处理 `user_bash` 时，也可能使本插件收不到事件。

接口参考：[TypeSafe API](https://docs.typesafe.ai/api)、[置信度](https://docs.typesafe.ai/confidence)、[Pi 扩展](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[Pi 包安装](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。

## 协议

[MIT](LICENSE)
