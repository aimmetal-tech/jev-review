# 架构与模块职责

两个适配器共用审查核心，但保留各自宿主的审批机制：Pi 拦截工具事件；DSH 接管原生 Auto review 的模型请求，由原生插件继续管理工具审批与人工确认。主 Agent 的模型配置不由本项目替换。

最终审查 LLM 通过 `LLM_API_KEY` 与 `LLM_BASE_URL` 读取凭据和 OpenAI Chat Completions 端点；未设置端点时使用 MiMo Token Plan 默认地址。DSH 的 `llmApiKeyEnv` 默认指向 `LLM_API_KEY`，显式 `llmBaseUrl` 优先于 `LLM_BASE_URL`；未指定时沿用共用核心默认地址。旧 `MIMO_TP_KEY` 与 `JEV_LLM_BASE_URL` 不再自动读取；Jev 仍使用 `TYPESAFE_API_KEY`。

Jev 接口使用结构化 Choice 决策，同一次请求评估授权和风险。受管操作在真实 Docker 沙箱站立权限内自动执行；越界先 Jev，再独立 LLM，未解决先拒绝并提示替代路径，连续达到恢复预算后才人工。不能可靠判断、取消、执行绑定或后端失败时不得静默放行。执行隔离只覆盖插件拥有的工具体，不把整个宿主服务或未受管工具称为沙箱。成本、延迟与分类质量必须区分文档估算、模拟测试和真实 API 测量。

## 技术栈

| 层次 | 技术与约定 |
| --- | --- |
| 运行环境 | Node.js ≥ 22.19，npm，原生 ESM（`type: module`） |
| 语言 | TypeScript，`strict`，`NodeNext` 模块解析；源码使用显式 `.ts` 导入 |
| 共用审查器 | Node.js 内置 API、Docker CLI、文件元数据检查、`fetch`、`AbortController`；站立沙箱权限、Jev 与 OpenAI 兼容 LLM |
| Pi 适配 | Pi Extension API；`src/adapters/pi.ts` 为入口，宿主类型导入在运行时擦除 |
| DSH 适配 | Cordis 插件与 `llm/stream` middleware、Schemastery 配置 schema、DSH 原生 Auto review |
| Lint | **Oxlint**，配置为 `.oxlintrc.json`；警告和错误均使检查失败 |
| 类型检查 | TypeScript `tsc --noEmit`，与 Lint 分开执行 |
| 测试 | `node:test` 与 `node:assert/strict`，Node.js 类型擦除；Jev 请求使用模拟响应 |
| 构建 | esbuild，仅将 DSH 入口打包为 ESM；第三方包保持 external |
| 包分发 | `package.json` 的 `pi.extensions`、`exports`、`files` 与 `dsh.bundle.patch` |
| 发布 | GitHub Actions CI/Release、npm 公开包与 provenance；仅使用 Trusted Publishing（OIDC），不读取发布 token |

依赖版本和兼容范围以 `package.json`、`package-lock.json` 为准。Pi 入口应保持无运行时第三方依赖，不得间接导入 DSH 的运行时依赖。


## 入口与数据流

- Pi：`src/adapters/pi.ts` 接收工具事件，并把授权上下文与执行证明交给共用核心。
- DSH：`src/adapters/dsh.ts` 转换原生审查协议；`src/adapters/dsh-sandbox.ts` 注册受管工具并绑定执行许可。
- 共用决策：`src/reviewer.ts` 调用 `src/l1.ts`、`src/llm.ts` 与 `src/recovery.ts`；沙箱权限由 `src/sandbox.ts` 验证。
- 执行：`src/sandbox-worker.ts` 在容器内操作文件、命令和 Node 代码；后端失败不得改为宿主执行。
- 打包：Pi 分发 TypeScript 源码，DSH 经 esbuild 生成 `dist/dsh.js`；`scripts/check-package.ts` 校验实际 tarball。

项目结构与变更同步要求见 [AGENTS.md](https://github.com/aimmetal-tech/jev-review/blob/main/AGENTS.md)。审查协议见 [REVIEW.md](REVIEW.md)，执行隔离见 [SANDBOX.md](SANDBOX.md)。
