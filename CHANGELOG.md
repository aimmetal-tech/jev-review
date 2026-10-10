# 更新日志

版本号遵循 SemVer，Git tag 使用 `v<version>`。

## [Unreleased]

## [0.0.1] - 2026-10-10

首个公开版本，项目名称为 `jev-review`，采用 MIT 协议。

- 提供 Pi Harness 与 DeepSeek Harness（DSH）的 Jev 自动审查适配器。
- 使用 TypeSafe Jev 的两个 Choice 问题，一次请求评估授权范围和操作风险。
- 明确授权且风险为 routine、达到阈值时允许执行；其他情况由宿主阻止或进入人工审批。
- 支持 auto、manual、shadow 模式，处理 API 故障、取消、上下文预算与受保护路径。
- 配置 Oxlint、TypeScript 严格检查，以及共用核心、Pi 和 DSH 原生审批链路测试。
- 提供 npm 发布与 GitHub Release 工作流，自动构建和验证发布包，并附带 SHA-256 校验文件。

测试中的 Jev 响应为模拟数据；尚未测量真实模型分类质量、成本或延迟。DSH 已验证版本为 `0.2.0-rc.2` 与 `0.2.1-alpha.2`。
