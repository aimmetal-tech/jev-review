# 开发与验证

## 检查与测试

### 云端真实模型测试

使用 GitHub 托管临时 Ubuntu VM，实际安装本轮 tarball，分别启动 Pi `1.1.0` 标准 CLI 和 DSH `0.2.1-alpha.2` SDK 宿主。主模型与最终审查均为 `mimo-v2.6-flash`，Jev 独立调用。配置仓库 Secrets `LLM_API_KEY`、`LLM_BASE_URL`、`TYPESAFE_API_KEY` 后，手动触发 CI 的 `live_models=true`；普通 push/PR 不使用凭据。不要在个人电脑运行真实入口。

六类场景分别在两个宿主各一次：权限内读写、授权越界写、金丝雀隔离、文档注入、Jev 故障后的真实最终审查。报告区分真实请求与故障注入，缺少实际目标操作记为未覆盖，文件副作用和清理也必须通过。模拟测试不替代真实报告，少量实跑不代表总体模型分类质量。完整配置、限额与 artifact 说明见 [云端测试](LIVE_TESTING.md)。

### 常规检查

```bash
npm ci --ignore-scripts
npm run verify
npm run check:package
```

以上命令在源码仓库运行。`verify` 依次执行 Oxlint、TypeScript 严格类型检查和测试。Lint 规则在仓库 [.oxlintrc.json](https://github.com/aimmetal-tech/jev-review/blob/main/.oxlintrc.json) 中配置；`npm run lint` 检查源码、测试与发布脚本，警告也会使检查失败。可用 `npm run lint:fix` 自动修复支持的规则。

`check:package` 通过 `prepack` 自动构建，生成 `.release/` 下的 tarball 和 SHA-256 校验文件，并在干净目录安装发布包，验证 Pi 加载器与 DSH 原生审批链路。它需要 npm registry 网络访问。项目结构、结构性同步规则、Git 提交规范和提交检查点见 [AGENTS.md](https://github.com/aimmetal-tech/jev-review/blob/main/AGENTS.md)。

测试覆盖 L1 的授权/身份/路径边界、观察与执行档、Pi 授权生命周期、dsh 请求转换及原生审批流程，以及决策阈值、故障回退、取消和参数变化。Jev API 响应使用模拟数据；这些测试不能证明模型的实际分类质量，也不是实际成本或延迟测量。


源码 DSH 安装先执行 `npm ci --ignore-scripts` 和 `npm run build`，再使用 `dsh plugin --profile web add /absolute/path/to/jev-review`。Pi 可使用 `pi -e /absolute/path/to/jev-review/src/adapters/pi.ts` 临时加载。

测试与报告路径见 [云端测试](LIVE_TESTING.md)，发布包验证见 [发布流程](RELEASING.md)。真实宿主、Docker 场景及真实模型调用只在云端运行；本地仅做静态检查、模拟验证和无副作用的安装检查。开发与提交规则以 [AGENTS.md](https://github.com/aimmetal-tech/jev-review/blob/main/AGENTS.md) 为准。
