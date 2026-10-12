# 更新日志

版本号遵循 SemVer，Git tag 使用 `v<version>`。

## [Unreleased]

## [0.0.103] - 2026-10-12

- 新增 Docker 沙箱：受管操作在站立权限内直接执行；越界依次通过 Jev 和独立 LLM，许可精确绑定单次操作，后端失败不回退到宿主执行。
- 默认连续 3 次未解决才人工审批；明确拒绝先反馈替代路径，保留 manual、never 与取消约束。
- Pi 标准工具使用沙箱执行体；DSH 提供 jev_* 和容器内 jev_code，绑定每 Agent 执行门并显式注入服务依赖，兼容原生 Auto 的晚激活。
- **配置迁移**：最终审查读取 LLM_API_KEY 和 LLM_BASE_URL，旧 MIMO_TP_KEY / JEV_LLM_BASE_URL 不再自动读取；默认最终模型为 mimo-v2.6-flash。主 Agent 模型保持原样。
- Docker 成为默认运行前提；显式设置 JEV_SANDBOX_MODE=off（DSH 为 sandboxMode: off）可使用兼容流程。
- 兼容流程增加 Pi L1 只读任务授权、observe/enforce/off 与分层统计；授权随新输入、任务结束、导航、压缩和重载撤销。DSH 不启用 L1 快速放行。
- 适配器入口整理为 src/adapters/pi.ts 与 src/adapters/dsh.ts；直接引用旧 Pi 源码入口的用户需迁移。修复 Windows npm CLI 打包检查。
- 增加手动触发的云端真实 Pi/DSH 测试、协议预检查、请求预算和脱敏报告；6 类场景在两个宿主各验证一次，不新增插件运行时依赖。
- 云端冒烟 Pi、DSH 各 6 项通过，人工请求为零；测量使用不同提交，故障注入单独标记，不代表总体分类质量。运行与证据见 docs/LIVE_TESTING.md。
- 精简两个 README，将配置、审查、沙箱、适配器与开发细节拆分为 docs/ 技术文档，在 AGENTS.md 标明具体路径；技术文档随 npm 包分发。

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
