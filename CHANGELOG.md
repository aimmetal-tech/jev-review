# 更新日志

版本号遵循 SemVer，Git tag 使用 `v<version>`。

## [Unreleased]

- DSH 执行准备显式声明工作目录和权限服务依赖，准备失败以固定脱敏代码区分目录、Docker 和路径规划问题。
- 修复完整 DSH 应用的晚激活原生 Auto 顺序：每 Agent 外层执行门保证受管沙箱证明先绑定；增加模拟回归及严格限定的云端 SDK fixture 用户来源绑定。
- 云端观测保留独立 fetch 引用并在审查边界恢复；live 宿主串行执行，记录前置超时而不将其计为已覆盖场景。
- 云端首轮接入修复：在实际宿主控制模块幂等安装请求观测，DSH 避免重复 native 呈现声明；支持选择失败宿主复验，保留首轮失败证据。
- 新增手动开启的云端 Pi/DSH 真实模型冒烟测试：安装实际 tarball、固定真实宿主与 Docker，6 类场景各宿主运行一次，使用仓库测试 Secrets。
- 增加真实 API 协议预检查、请求/工具/时间预算、失败与未覆盖判定及脱敏 artifact；Jev 故障注入与真实模型测量分别记录，不新增插件运行时依赖。
- **配置迁移**：最终审查改为读取 `LLM_API_KEY` 与 `LLM_BASE_URL`，旧 `MIMO_TP_KEY` 与 `JEV_LLM_BASE_URL` 不再自动读取。DSH 默认继承新环境配置，显式行配置仍优先；未设置端点时保留 MiMo Token Plan 默认地址。
- Pi 与 DSH 的最终审查 LLM 默认改为 `mimo-v2.6-flash`；仍可通过 `JEV_LLM_MODEL` 或 DSH 的 `llmModel` 显式覆盖。
- 新增真实 Docker 沙箱：站立权限内的受管操作直接执行；越界按 Jev 快速判断、独立 OpenAI 兼容 LLM 兜底逐层审查。
- 默认最终模型使用 `LLM_API_KEY` 与 MiMo Token Plan 端点，主 Agent 的模型不替换；模型批准仅绑定一次操作，失败不会回退到宿主未隔离执行。
- 默认先返回拒绝与替代路径，连续未解决 3 次才人工审批；明确拒绝不自动弹窗，保留 `manual` / `never` 与取消约束。
- Pi 标准工具使用沙箱执行体，DSH 新增 `jev_*` 执行工具与容器内 `jev_code`；开启沙箱时不执行旧宿主 PTC，使用 native 工具呈现。
- Docker 成为默认沙箱的运行前提；旧流程可显式 `JEV_SANDBOX_MODE=off`，本轮尚未发布 npm 包。

- 新增共用 L1 本地只读分类与 L2 Jev 分层审查；Pi 默认观察候选，显式 enforce 后仅为 UI 确认的任务范围内置 read 快速放行。
- 新增 `/jev read-task`、L1 档位与来源/请求/有效结果对照统计；授权绑定任务消息，输入、任务结束、会话/分支变化、压缩和重载均撤销。
- 保留凭据与目录名保护、缺 key/上下文回退及既有模式；DSH 明确关闭 L1 快速放行，仍由 Jev 与原生审批执行。
- 增加授权生命周期、工具身份、文件元数据、路径/链接和 Pi/DSH 故障边界测试；模拟测试不作为真实成本或分类质量测量。

- 将 Pi 和 DSH 源码入口整理到 `src/adapters/pi.ts` 与 `src/adapters/dsh.ts`，同步包入口、构建、测试和说明；审查策略及 `jev-review/dsh` 导出不变。直接加载旧 Pi 源码路径的用户需改用新路径。
- 打包检查通过 Node 启动 npm CLI，修复 Windows 上直接启动 `npm.cmd` 导致的 `EINVAL` 错误。

## [0.0.101] - 2026-10-10

- npm 发布仅使用 GitHub Actions Trusted Publishing（OIDC），移除发布 token 的读取与回退。
- 同步 Trusted Publisher 配置说明、发布检查步骤及 Pi/DSH 安装版本。
- 使用本版本验证 OIDC 发布、provenance 和 GitHub Release 产物的一致性。

## [0.0.1] - 2026-10-10

首个公开版本，项目名称为 `jev-review`，采用 MIT 协议。

- 提供 Pi Harness 与 DeepSeek Harness（DSH）的 Jev 自动审查适配器。
- 使用 TypeSafe Jev 的两个 Choice 问题，一次请求评估授权范围和操作风险。
- 明确授权且风险为 routine、达到阈值时允许执行；其他情况由宿主阻止或进入人工审批。
- 支持 auto、manual、shadow 模式，处理 API 故障、取消、上下文预算与受保护路径。
- 配置 Oxlint、TypeScript 严格检查，以及共用核心、Pi 和 DSH 原生审批链路测试。
- 提供 npm 发布与 GitHub Release 工作流，自动构建和验证发布包，并附带 SHA-256 校验文件。

测试中的 Jev 响应为模拟数据；尚未测量真实模型分类质量、成本或延迟。DSH 已验证版本为 `0.2.0-rc.2` 与 `0.2.1-alpha.2`。
