# npm 与 GitHub Release 发布

项目和 npm 包名为 `jev-review`，首版为 **0.0.1**，本文的发布与安装示例使用 **0.0.101**，对应 Git tag **v0.0.101**。npm 和 GitHub Release 的实际发布状态分别以 [npm](https://www.npmjs.com/package/jev-review) 和 [GitHub Releases](https://github.com/aimmetal-tech/jev-review/releases) 为准；提交发布工作流不代表包已发布。

## 一次性配置

1. 在 npm 注册或登录发布账号，并启用账号所需的双因素认证。
2. 包必须已在 npm 上存在；全新包先由维护者使用 `npm login` 和交互式双因素认证完成首次发布，再配置 Trusted Publisher。
3. 确认 GitHub Actions 已启用，并创建名为 `npm` 的 environment。若设置了该环境的审核规则，发布 job 会等待指定审核。
4. 在 npm 的包设置中创建 **Trusted Publisher**，选择 GitHub Actions，并填写下面的身份字段。

GitHub Release 使用工作流的 `GITHUB_TOKEN`，不需要额外 GitHub 发布 token。工作流中第三方 Actions 固定为 commit SHA。

**Trusted Publishing（OIDC）** 绑定字段：

- GitHub owner：`aimmetal-tech`
- repository：`jev-review`
- workflow filename：`release.yml`
- environment：`npm`

在 **Allowed actions** 中勾选 **Allow npm publish**。仅允许默认的 `npm stage publish` 不足以运行当前工作流。当前流程通过 `npm publish --tag` 设置发布标签，不执行独立的 `npm dist-tag` 命令，因此无需额外允许后者。

工作流在 GitHub 托管的 Ubuntu runner 上运行，使用 Node.js 24（npm ≥ 11.5.1）、`id-token: write`、`environment: npm` 和 `--provenance`。发布仅使用 OIDC，不读取 `NPM_TOKEN`，也不回退到 token 认证；无需配置 npm 发布 secret。旧的发布 secret 可在确认 OIDC 发布成功后删除。

新连接创建后应在两天内完成首次成功发布。上述身份字段创建后不可修改，需要变更时删除连接再重新配置。验证成功后，建议在 npm 的 Publishing access 中选择要求双因素认证并禁止 token 发布的选项。

## 发布前检查

在仓库根目录执行：

```bash
npm ci --ignore-scripts
npm run verify
npm run check:package
npm run release:info -- v0.0.101
```

`verify` 执行 Oxlint、类型检查和全部测试。`check:package` 会触发 `prepack` 自动构建 DSH，生成 `.release/jev-review-<version>.tgz` 与 `.release/SHA256SUMS`，检查包内容，并在临时目录安装实际 tarball 和固定版本的宿主依赖，验证 Pi 扩展加载、DSH 模块/资源以及原生审批链路。该检查需要 npm registry 网络访问；不调用真实 Jev API。

`release:info` 验证 tag 与 `package.json.version` 一致，提取 `CHANGELOG.md` 中对应版本的说明。缺少说明、tag 不匹配或包身份/许可证错误时失败。

`prepack` 只负责构建，不能代替测试。发布任务将准备阶段验证过的同一个 tarball 发布到 npm 并上传 GitHub，不在发布阶段重新构建。用户安装发布包时无需执行构建或安装本项目的开发依赖。

Pi 包入口为 `src/adapters/pi.ts`，DSH 源码入口为 `src/adapters/dsh.ts`；两者共用 `src/reviewer.ts`，本地分类模块为 `src/l1.ts`。打包检查验证这些源码与 `dist/dsh.js` 均在包内，并从包元数据加载 Pi 入口、从 `jev-review/dsh` 加载 DSH 构建产物。Pi 加载检查也确认任务授权与撤销所需事件已注册。

打包检查须通过 `npm run check:package` 启动，以读取 npm 提供的 CLI 路径；脚本用 Node 执行该 CLI，兼容 Windows 和 Linux，无需通过 shell 拼接 npm 命令。

## 触发发布

先使用 `npm version <version> --no-git-tag-version` 更新版本，并同步更新日志与相关文档。完成本轮功能和检查后提交，再为通过检查的提交创建对应 tag 并推送。例如 `package.json.version` 为 `0.0.101` 时：

```bash
git tag -a v0.0.101 -m 'jev-review 0.0.101'
git push origin main
git push origin v0.0.101
```

后续版本可使用 `npm version patch --no-git-tag-version`（或按兼容影响选择 minor/major）。禁止移动已发布 tag 或覆盖 npm 的既有版本。

Release 工作流执行以下流程：

1. 检出 tag，校验版本和更新日志，运行 Lint、类型检查、测试及发布包安装验证。
2. 创建 GitHub Release，上传 tarball 与 `SHA256SUMS`。
3. 发布同一个 tarball 到 npm，并生成 provenance。稳定版本使用 `latest`，预发布版本使用 `next`，GitHub 同时标记 prerelease。

若 Trusted Publisher 的身份字段不匹配、未允许 `npm publish` 或发布权限不足，npm job 会失败，已生成的 GitHub Release 仍可使用。修正配置后可以重跑失败 job。重复发布只跳过字节完全相同的 npm 版本；同版本不同内容会失败。已有 GitHub Release 的 checksum 必须与本轮产物一致，不自动覆盖附件。

也可以在 **Actions → Release → Run workflow** 中填写已有 tag。取消 `publish_npm` 可仅创建 GitHub Release。手动触发仍执行完整验证，不能绕过检查。推送 tag 默认同时尝试两个发布目标。

## 安装发布包

发布成功后，Pi 可以直接通过 npm 安装：

```bash
export TYPESAFE_API_KEY='your-key'
pi install npm:jev-review@0.0.101
```

DSH 可以通过其插件管理命令安装 npm 包：

```bash
export TYPESAFE_API_KEY='your-key'
npx @deepseek-ai/dsh@0.2.1-alpha.2 plugin --profile web add jev-review@0.0.101
npx @deepseek-ai/dsh@0.2.1-alpha.2 web
```

DSH 仍需在会话选择 Auto review 或执行 `/permission auto`。安装不会自动改变会话权限。

仅使用 GitHub Release 时，下载同一版本的 `.tgz` 和 `SHA256SUMS`，校验后解压到本地目录：

```bash
sha256sum --check SHA256SUMS
mkdir -p jev-review
tar -xzf jev-review-0.0.101.tgz -C jev-review --strip-components=1
```

Pi 使用 `pi install /absolute/path/to/jev-review`。DSH 本地包还需在解压目录运行 `npm install --omit=dev --ignore-scripts` 来安装运行时依赖，再执行 `dsh plugin --profile web add /absolute/path/to/jev-review`。发布包已经包含 DSH 构建产物，无需 `npm run build`。

GitHub 自动提供的 Source code 压缩包是源码快照；预构建安装应下载名为 `jev-review-<version>.tgz` 的附件。
