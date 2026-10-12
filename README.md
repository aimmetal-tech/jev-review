# jev-review

使用 TypeSafe Jev 审查 Coding Agent 的工具授权与操作风险，支持 **Pi** 和 **DeepSeek Harness（DSH）**。受管工具在 Docker 权限内直接执行，越界请求依次交给 Jev 和独立 LLM 审查。

## 准备

需要 Node.js ≥ 22.19、对应宿主和本地 Docker。启动宿主前设置凭据并准备镜像：

```bash
export TYPESAFE_API_KEY='your-jev-key'
export LLM_API_KEY='your-final-review-key'
export LLM_BASE_URL='https://token-plan-cn.xiaomimimo.com/v1'
docker pull node:22-bookworm-slim
```

PowerShell 使用 `$env:变量名 = '值'`。最终审查默认模型为 `mimo-v2.6-flash`；插件不会替换主 Agent 的模型配置。

## Pi

```bash
pi install npm:jev-review@0.0.103
```

重启 Pi 或执行 `/reload`，使用 `/jev status` 查看状态。仅当前项目安装可加 `--local`。已验证 Pi `1.1.0`。

## DSH

```bash
npx @deepseek-ai/dsh@0.2.1-alpha.2 plugin --profile web add jev-review@0.0.103
npx @deepseek-ai/dsh@0.2.1-alpha.2 web
```

在会话选择 **Auto review** 或执行 `/permission auto`。安装不会自动改变会话权限；详见 [DSH 安装说明](dsh/README.md)。

## 使用与文档

默认采用 `workspace-write` 沙箱。越界批准只对本次操作有效；未解决的审查先反馈恢复提示，连续 3 次后才询问人工。Docker 不可用时不会回退到宿主执行。隔离只覆盖受管工具，边界审查可能向模型发送工具参数与授权文本。

- [配置参考](docs/CONFIGURATION.md) · [Pi 命令与 L1](docs/PI.md) · [DSH 配置与协议](docs/DSH.md)
- [审查流程](docs/REVIEW.md) · [沙箱权限与边界](docs/SANDBOX.md) · [架构](docs/ARCHITECTURE.md)
- [开发验证](docs/DEVELOPMENT.md) · [云端真实测试](docs/LIVE_TESTING.md) · [发布流程](docs/RELEASING.md)
- [更新日志](CHANGELOG.md) · [GitHub Release](https://github.com/aimmetal-tech/jev-review/releases) · [npm](https://www.npmjs.com/package/jev-review)

## 许可证

[MIT](LICENSE)
