# 配置参考

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


Pi 命令见 [Pi 适配器](PI.md)，DSH 行配置见 [DSH 适配器](DSH.md)。默认值以 `src/reviewer.ts`、`src/llm.ts`、`src/sandbox.ts` 和 `src/adapters/dsh.ts` 的 schema 为准。
