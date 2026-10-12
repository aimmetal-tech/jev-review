# 分层审查与数据边界

实现参照 [OpenAI Auto-review 文章](https://alignment.openai.com/auto-review/)：大多数操作先在权限边界内执行，只对越界请求调用独立审查器。拒绝结果返回给 Agent 选择更安全的路径，不把每次拒绝变成人工审批。

```text
受管工具 -> 真实 Docker 沙箱（权限内直接执行，不调用模型）
越界请求 -> Jev 快速审查 -> 独立 LLM 兜底 -> 批准一次性权限或拒绝并反馈替代路径
仍无法判断 -> 先拒绝并让 Agent 恢复 -> 连续 3 次未解决才询问人工
```

Jev 调用官方 `POST https://api.typesafe.ai/v1/systemone`，一次请求同时判断：

| 问题 | 候选值 |
| --- | --- |
| 用户授权 | authorized / unapproved / unclear |
| 操作风险 | routine / sensitive / destructive / unknown |

`authorized + routine` 且各自 probability ≥ 0.98、confidence ≥ 0.95 时快速批准；其他结果或 Jev 故障交给独立 LLM 复核。最终 LLM 使用 OpenAI 兼容 Chat Completions JSON 模式，默认 `mimo-v2.6-flash`，key 来自 `LLM_API_KEY`，base URL 从 `LLM_BASE_URL` 读取，未设置时使用 `https://token-plan-cn.xiaomimimo.com/v1`。它独立判断授权、实际影响和边界变化；批准必须为明确授权且影响已知，敏感或破坏性操作只有在明确、有限的用户请求中才可批准。模型不替代执行器的固定约束。

明确拒绝直接返回固定原因和更安全路径提示。无法可靠判断、未配置审查器或模型故障先返回拒绝以便恢复，连续 3 次未解决才进入人工一次性批准；`never` 和无审批渠道继续阻止。`manual` 是用户显式选择的逐次人工模式，不适用自动恢复策略。一次性许可绑定工具调用、载荷、会话、目录和取消生命周期，不能改变参数、沿用到后续操作或缓存为长期豁免。

保护路径和已知审查器凭据不发送给远端模型。沙箱遮蔽工作区顶层的常见凭据/配置文件与目录；运行中插件源码、构建目录、依赖及 `.git` 的写入默认受只读限制。保护不是所有秘密的检测器，共享工作目录、宿主扩展和未受管工具仍是信任边界。未受管工具没有自动沙箱证明，进入模型审查。沙箱不可用、控制面文件挂载、协议或执行绑定错误不会自动退化成未隔离执行。

授权只使用用户文本与从属父任务，项目约束只能缩小范围。助手、工具输出与模型理由不授予权限；不完整或超预算的边界审查不会通过截断自动批准。Jev 的 confidence 是分布推导值，不是正确率保证；LLM 不伪造 Jev 的概率或置信度。模型判断不是确定性的安全保证，文章中的内部通过率、人工打断降幅也不是本项目的测量结果。


## 数据与覆盖边界

边界审查会向 TypeSafe 以及配置的最终 LLM 发送本次工具参数、工具描述、工作目录、技术边界与用户文本请求，这些字段可能包含源代码或私密文本，包括已确认任务中的目录与任务编号。L1 执行档命中时不发送该次操作；L1 的工具来源与授权记录不作为远端请求字段。路径保护只覆盖直接 path 参数，不能识别所有秘密或 shell 中的隐藏路径；L1 检查链接不等于 L2 路径保护全面解析链接。人工确认会显示本次完整参数；通知不打印 API key 或服务端错误正文。

审批模型本身不是隔离机制；新增 Docker 执行器提供受管操作的进程隔离，不能把整个宿主服务或未受管工具称为沙箱。[Jev 官方已知局限](https://docs.typesafe.ai/model-jaggedness/jev-1.13)包括对抗性内容、间接推理和大上下文。需要强隔离时应同时使用文件系统、网络权限限制及沙箱。

插件无法限制其他扩展直接使用 `pi.exec`、直接访问文件系统、工具内部绕过 Pi 执行的动作或外部进程。后续 `tool_call` 处理器修改参数不会自动触发二次审查，应把本插件放在修改参数的扩展之后。其他扩展提前处理 `user_bash` 时，也可能使本插件收不到事件。

接口参考：[TypeSafe API](https://docs.typesafe.ai/api)、[置信度](https://docs.typesafe.ai/confidence)、[Pi 扩展](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[Pi 包安装](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。


## 成本与测量

根据 [TypeSafe 模型文档](https://docs.typesafe.ai/models)（2026-10-09），Jev 1.13 输入价格为 **$0.042 / 百万 token**，输出免费。每次若消耗 2000 输入 token，约 $0.000084；10 万次约 $8.40。这是按文档价格计算的估算，未实测成本、延迟或相对其他模型的降幅。

两个问题共享 state，只发出一次请求。不发送完整工具输出或 Agent 思考过程；最终 LLM 有独立费用与耗时，Jev 单价估算不代表整个链路成本。不缓存批准结果，因为相同命令在文件、权限和环境变化后可能产生不同影响。投入使用前，应在自己的真实操作样本上评估误放行率、误拦截率、人工确认比例和 P95 延迟，特别是中文请求和对抗性输入。


相关源码：`src/reviewer.ts`、`src/llm.ts`、`src/recovery.ts`。验证见 `test/reviewer.test.ts` 与 `test/llm.test.ts`。执行约束见 [沙箱](SANDBOX.md)，真实观测见 [云端测试](LIVE_TESTING.md)。
