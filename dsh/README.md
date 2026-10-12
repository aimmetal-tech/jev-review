# jev-review：DSH 安装与启用

已验证 DSH `0.2.1-alpha.2` 和 `0.2.0-rc.2`。需要 Node.js ≥ 22.19 和本地 Docker。

## 安装

在启动 DSH 的终端设置凭据并准备镜像：

```bash
export TYPESAFE_API_KEY='your-jev-key'
export LLM_API_KEY='your-final-review-key'
export LLM_BASE_URL='https://token-plan-cn.xiaomimimo.com/v1'
docker pull node:22-bookworm-slim
npx @deepseek-ai/dsh@0.2.1-alpha.2 plugin --profile web add jev-review@0.0.103
npx @deepseek-ai/dsh@0.2.1-alpha.2 web
```

PowerShell 使用 `$env:变量名 = '值'`。已有 DSH 可直接使用 `dsh plugin --profile web add ...` 和 `dsh web`。省略插件版本可安装 npm 最新版。

## 启用

在当前会话选择 **Auto review**，或执行 `/permission auto`。安装不会自动切换权限，也不会替换主 Agent 的模型。

默认使用 Docker 中的 `jev_*` 受管工具与 native 呈现；权限内零审查模型调用，越界依次由 Jev 与最终 LLM 审查。沙箱开启时阻止旧宿主 `run_code`。插件更新后重启 DSH。

配置位于 `jev-auto-review` 插件行，默认从 `TYPESAFE_API_KEY`、`LLM_API_KEY` 和 `LLM_BASE_URL` 读取凭据与端点。Pi 的 `/jev` 命令和 `JEV_*` 环境配置不适用于 DSH。

详细内容见 [DSH 配置与协议](../docs/DSH.md)、[沙箱边界](../docs/SANDBOX.md)、[云端测试](../docs/LIVE_TESTING.md) 和 [源码/Release 安装](../docs/RELEASING.md)。
