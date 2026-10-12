# Pi 适配器与只读任务授权

入口为 `src/adapters/pi.ts`，安装见 [README](../README.md)。类型检查使用 Pi `1.1.0`；类型导入在运行时擦除。Pi 入口不得导入 DSH 的运行时依赖。

## 命令、模式与统计

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


相关源码：`src/adapters/pi.ts`、`src/l1.ts`；测试：`test/extension.test.ts`、`test/l1.test.ts`。默认执行流程见 [沙箱](SANDBOX.md)，参数见 [配置参考](CONFIGURATION.md)。
