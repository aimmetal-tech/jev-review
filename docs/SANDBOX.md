# Docker 沙箱与执行权限

默认 `workspace-write`，宿主初始项目目录是站立权限的根，后续 `cwd` 变化不会扩大它。`read-only` 不提供站立写入权限。Docker 执行使用只读容器根文件系统、默认 `--network none`、明确目录挂载、移除 capabilities、禁止新增权限、PID/内存/CPU 限制和受限临时目录；不挂载 Docker socket，不传入模型 API key，不自动拉取镜像。Docker CLI 使用固定的本地端点和已解析的镜像 ID。

Pi 在启动事件中把标准内置文件/检索/命令工具换成插件拥有的沙箱执行器；相同名称的其他扩展工具不作为隔离证明。DSH 注册 `jev_read / jev_write / jev_edit / jev_ls / jev_find / jev_grep / jev_bash / jev_code`，真实工具体直接执行容器操作。DSH 为新 Agent 选择 native 工具呈现，以便直接调用这些工具；原来的宿主 `run_code` 在沙箱开启时被阻止，容器内 Node 批处理改用 `jev_code`。主 Agent 的 provider 和 model 保持原样。

镜像提供执行环境，默认是 Linux Node.js + POSIX shell。特定程序、PowerShell 或项目原生依赖需要合适的自定义镜像；缺少程序返回错误，不会改在宿主执行。`jev_code` 提供容器内 `tools.read/write/edit/ls/find/grep/bash` 及对应 `jev_*` 别名；自定义远程工具应在 native 工具层调用并经过审查。

明显超出根目录的文件请求、只读模式下的写入、额外挂载或网络访问进入 Auto-review。命令不会被正则认定安全；不透明命令先在真实沙箱内执行，若需要更宽权限则显式请求 `sandbox_permissions: "require_escalated"`、`justification`，以及具体 `read_roots / writable_roots / network_access`。额外目录挂载在 `/extra/<index>`。不自动以更高权限重放失败命令，以免重复已发生的副作用。


## 执行证明与边界

审批模型本身不是隔离机制；新增 Docker 执行器提供受管操作的进程隔离，不能把整个宿主服务或未受管工具称为沙箱。[Jev 官方已知局限](https://docs.typesafe.ai/model-jaggedness/jev-1.13)包括对抗性内容、间接推理和大上下文。需要强隔离时应同时使用文件系统、网络权限限制及沙箱。

插件无法限制其他扩展直接使用 `pi.exec`、直接访问文件系统、工具内部绕过 Pi 执行的动作或外部进程。后续 `tool_call` 处理器修改参数不会自动触发二次审查，应把本插件放在修改参数的扩展之后。其他扩展提前处理 `user_bash` 时，也可能使本插件收不到事件。

审查发送的数据与路径保护范围见 [审查流程](REVIEW.md#数据与覆盖边界)。


相关源码：`src/sandbox.ts`、`src/sandbox-worker.ts`、`src/adapters/dsh-sandbox.ts`。验证见 `test/sandbox.test.ts` 与 `test/execution.test.ts`。配置见 [配置参考](CONFIGURATION.md)，审查决策见 [审查流程](REVIEW.md)。
