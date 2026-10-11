# jev-review：DeepSeek Harness（DSH）适配器

已验证 `dsh@0.2.1-alpha.2` 与 `0.2.0-rc.2` 的原生工具与审批流程。开发依赖固定版本，避免开发预览期接口变动使测试悄悄换目标。

## 安装与启用

> 本轮 Sandbox/LLM 功能在 Unreleased 源码中，尚未发布 npm；已发布 0.0.101 仍是旧流程。源码试用先准备本地 Docker 和 `docker pull node:22-bookworm-slim`，设置 `TYPESAFE_API_KEY` 与 `LLM_API_KEY` 后安装本地包。

推荐通过 DSH 的插件管理命令，从 npm 按版本安装预构建包。先在启动 DSH 的同一个终端设置 API key；Windows PowerShell 使用 `$env:TYPESAFE_API_KEY = 'your-key'`，Bash 示例：

```bash
export TYPESAFE_API_KEY='your-key'
npx @deepseek-ai/dsh@0.2.1-alpha.2 plugin --profile web add jev-review@0.0.101
npx @deepseek-ai/dsh@0.2.1-alpha.2 web
```

省略插件包的 `@0.0.101` 可安装 npm 的最新发布版本。可用版本见 [npm 包页面](https://www.npmjs.com/package/jev-review)。也可以下载 [GitHub Release](https://github.com/aimmetal-tech/jev-review/releases) 的预构建 `.tgz`；校验、解压与依赖安装见 [发布说明](../docs/RELEASING.md)。这两种安装方式无需手动构建。

从源码安装时，在项目根目录生成可供 dsh 加载的 JavaScript：

```bash
npm ci --ignore-scripts
npm run build
```

设置 API key，然后将本地包加入 Web profile：

```bash
export TYPESAFE_API_KEY='your-key'
npx @deepseek-ai/dsh@0.2.1-alpha.2 plugin --profile web add /absolute/path/to/jev-review
npx @deepseek-ai/dsh@0.2.1-alpha.2 web
```

已安装 dsh 的环境可直接使用 `dsh plugin --profile web add ...` 和 `dsh web`。Bundle 同时声明原生 `auto-review` 行和 `jev-auto-review` 适配行，**安装不会替用户切换会话权限**。在当前会话选择 Auto review，或使用原生 `/permission auto`，才会开始审查工具调用。已有安装更新本地包后应重启 dsh，以加载新的 JavaScript 模块。

项目与包名均为 `jev-review`：Pi 加载 `src/adapters/pi.ts`；dsh 加载独立导出 `jev-review/dsh`（`dist/dsh.js`）。dsh 入口使用 Cordis 和 Schemastery，Jev HTTP 客户端和决策代码与 Pi 共用。

## 接入方式

适配器在公开的 `llm/stream` waterfall 中识别原生 Auto review 的一次性审查请求，转换为 Jev 的两个 Choice 问题，并把结果编码回原生严格 JSON 流协议。普通主 Agent 请求调用 `next()`，保留原来的 provider、model 和消息。

原生插件继续负责：

- Auto 权限预设的选择与风险提示。
- 对待执行调用和已记录会话、工具 schema 的一致性校验。
- 普通工具和每个已开始的 PTC 内部工具调用的执行前审批。
- 区分用户、直接父 Agent、项目约束、摘要和事实的来源角色。
- 原生人工确认、审批审计以及 `ask` / `never` 策略。
- Auto 子 Agent 的审查和原生插件卸载生命周期。

适配器只把 `human-instruction` 放入用户授权，把 `direct-parent-instruction` 放入单独的父任务字段，把 `constraint` 放入约束字段。父任务不能覆盖用户限制，约束不能授予权限；事实和工具返回不会变成授权。边界审查遇到压缩 checkpoint、非文本上下文或非对象参数时拒绝自动批准，先反馈恢复提示，避免丢掉信息后批准。

默认先使用插件拥有的 Docker 执行体。站立权限内返回原生 `low + allow`，不调用审查模型；越界时先 Jev，非批准结果再由独立 LLM 复核。有效的最终批准返回 `low + allow`，拒绝或未解决返回 `medium + deny`，不伪造 Jev 概率。

适配器在原生 pre-execute 链中先将明确拒绝和首次未解决结果转为拒绝与恢复提示，不立即请求用户。连续未解决达到 `humanAfter`（默认 3）后才保留原生 `ask`；批准仅对本次有效。`never` 策略直接拒绝，缺少审批渠道也阻止执行。这里的 `medium` 是进入原生审批流程的协议值，不代表所有拒绝都属于同一种实际风险。它与 Pi 中高置信度未授权操作直接阻止的行为不同。

## 配置

配置属于 `jev-auto-review` 插件行，使用导出的 Config schema 校验；可以通过 dsh 的插件配置界面或 profile 的配置层调整。API key 只从指定环境变量读取，不写入 YAML。

```yaml
- insert:
    - id: jev-auto-review
      name: jev-review/dsh
      config:
        apiKeyEnv: TYPESAFE_API_KEY
        model: jev-1.13.0
        mode: auto
        probabilityThreshold: 0.98
        confidenceThreshold: 0.95
        timeoutMs: 5000
        maxStateBytes: 32768
        sandboxMode: workspace-write
        sandboxImage: node:22-bookworm-slim
        sandboxTimeoutMs: 60000
        llmApiKeyEnv: LLM_API_KEY
        # 默认从 LLM_BASE_URL 读取；可用 llmBaseUrl 显式覆盖
        llmModel: mimo-v2.6-flash
        llmTimeoutMs: 20000
        humanAfter: 3
```

已有配置层请使用其原有覆盖机制；匹配覆盖会替换完整 config。配置字段与默认值如上，数值范围与 [共用审查器](../README.md) 相同。dsh 的行配置优先；Pi 的 `JEV_*` 环境配置不会自动改写 dsh 行。

最终审查默认读取 `LLM_API_KEY` 与 `LLM_BASE_URL`；端点未设置时使用 `https://token-plan-cn.xiaomimimo.com/v1`。`llmApiKeyEnv` 可指定其他 key 环境变量，`llmBaseUrl` 可覆盖端点。旧 `MIMO_TP_KEY` 与 `JEV_LLM_BASE_URL` 不再自动读取，请迁移到新名称。

- `auto`：先沙箱站立权限，再 Jev 与 LLM，未解决先恢复、最后才人工。
- `manual`：不调用 Jev，所有原生 Auto 审查都进入人工审批；`never` 会直接拒绝。
- `shadow`：调用 Jev，并记录固定的判断和原因，然后**继续调用原生审查模型，由它执行原来的审批策略**。这个模式会付出两种模型的调用成本。与 Pi 的观察模式不同，它保留原生审批。

主 Agent 没有新增 `/jev` 命令，继续使用 dsh 原生权限和插件配置入口。

旧 L1 名称分类仍不用于 DSH；新沙箱许可来自插件实际注册并执行的工具体，而非名称、描述或 schema 提示。`JEV_L1_MODE`、Pi 的 `/jev l1` 与 `/jev read-task` 不适用于 DSH。使用 `jev_read / jev_write / jev_edit / jev_ls / jev_find / jev_grep / jev_bash / jev_code`；新 Agent 使用 native 呈现，原宿主 `run_code` 在沙箱开启时阻止，避免未隔离代码。显式 PTC 组合若已有呈现声明，应切换 native 后使用受管工具。`sandboxMode: off` 是兼容旧流程的显式退出，不能声称提供执行隔离。

## 验证

```bash
npm run check
npm run lint
npm test
npm run build
npm pack --ignore-scripts
npm run check:package
```

测试除了请求/响应转换，也加载实际发布的 Cordis、原生 Auto review、Session、Tools 和 Approval 服务，用不会执行 shell 的 probe 工具验证：Jev 允许后才执行工具；拒绝时只在原生一次性批准后执行；`never`、无审批渠道和 API 故障不会执行工具；PTC 内部调用使用绑定的 schema 审查。

测试包含 6 项真实 dsh 原生审批链路测试，其中新增一项验证 Pi 的 L1 环境配置不会绕过 DSH 审查；原有 5 项曾使用打包插件在 `0.2.0-rc.2` 的独立依赖环境通过。`test/execution.test.ts` 在真实 Docker 下验证两个宿主：权限内零模型调用，越界 Jev→LLM 后一次性执行且无人工请求。`test/sandbox.test.ts` 验证写入、只读根、断网、金丝雀凭据、代码、一次性与取消清理。普通 `npm test` 跳过真实容器场景；设置 `JEV_TEST_DOCKER=1` 与 `JEV_TEST_IMAGE` 后执行，CI 有独立真实沙箱 job。`check:package` 会对本轮实际 tarball 再执行 Pi 加载与固定开发版本 DSH 的原生链路验证。测试使用模拟的 Jev API，未验证真实模型分类质量、实际延迟或成本。初始阈值需要用自己的操作样本评估，尤其是中文授权和对抗性内容。插件中文/英文元数据和 SVG 图标随包提供，实际 Web 页面呈现仍需在目标环境确认。

## 兼容与边界

原生审查策略文本的 SHA-256 和请求形状均被校验。已核对两个版本的策略相同；上游更改协议时返回错误并阻止该调用，不会自动猜测新格式或静默转用主模型。主 Agent 的普通模型流不会经过这项校验。

卸载 Jev 适配器会取消并等待其正在进行的 Jev 请求，随后恢复原生审查模型路径；它不会关闭原生 Auto review，也不会替用户提升权限。原生审查插件本身的卸载行为仍由 dsh 管理。

覆盖范围继承原生 Auto：外层 `run_code` 运输调用、PTC 程序直接执行的 Node 效果和外部进程不在内部工具审查范围内。旧宿主 PTC 不作为沙箱入口；新 `jev_code` 在容器中运行，提供本地文件/命令工具别名，不执行自定义宿主工具。模型分类不保证正确，沙箱也不隔离整个宿主服务、宿主扩展或共享工作目录的外部观察者。

自动审查会向 TypeSafe 发送工具参数、描述、schema、当前目录及保留的授权文本和项目约束。这些可能包含私密信息。直接的 `.env`、`.ssh`、`.aws`、`.dsh` 等受保护 path 操作会转人工，不发送到远端；不能据此识别所有秘密或符号链接。原始请求、key 和提供方错误正文不会写入插件日志。

参考：[dsh 原生 Auto review](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/experimental/auto-review)、[审批接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md)、[TypeSafe API](https://docs.typesafe.ai/api)。
