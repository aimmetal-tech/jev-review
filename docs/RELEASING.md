# npm 与 GitHub Release 发布

项目和 npm 包名为 `jev-review`，首版为 **0.0.1**，对应 Git tag **v0.0.1**。npm 和 GitHub Release 的实际发布状态分别以 [npm](https://www.npmjs.com/package/jev-review) 和 [GitHub Releases](https://github.com/aimmetal-tech/jev-review/releases) 为准；提交发布工作流不代表包已发布。

## 一次性配置

1. 在 npm 注册或登录发布账号，并启用账号所需的双因素认证。
2. 创建 Granular Access Token，允许发布包，具有 Read and write 权限。首次创建新包需要相应的创建权限；已有包后应将权限缩小到 `jev-review`。CI token 需要允许自动发布，使用 Bypass two-factor authentication，并设置较短有效期。
3. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 创建 Repository secret **NPM_TOKEN**。只将 token 写入 secret，禁止提交到仓库、日志或聊天中。
4. 确认 GitHub Actions 已启用。Release 工作流使用 `npm` environment；若设置了该环境的审核规则，发布 job 会等待指定审核。

GitHub Release 使用工作流的 `GITHUB_TOKEN`，不需要额外 GitHub 发布 token。工作流中第三方 Actions 固定为 commit SHA。

首次 npm 发布后，可在 npm 的包设置中启用 **Trusted Publishing（OIDC）**，绑定：

- GitHub owner：`aimmetal-tech`
- repository：`jev-review`
- workflow filename：`release.yml`
- environment：`npm`

工作流已配置 `id-token: write`、Node.js 24 和 provenance，支持 npm 的 OIDC 发布。确认 Trusted Publishing 可用后，可删除 `NPM_TOKEN`。首个尚不存在的 npm 包仍需要完成初次身份配置。

## 发布前检查

在仓库根目录执行：

```bash
npm ci --ignore-scripts
npm run verify
npm run check:package
npm run release:info -- v0.0.1
```

`verify` 执行 Oxlint、类型检查和全部测试。`check:package` 会触发 `prepack` 自动构建 DSH，生成 `.release/jev-review-<version>.tgz` 与 `.release/SHA256SUMS`，检查包内容，并在临时目录安装实际 tarball 和固定版本的宿主依赖，验证 Pi 扩展加载、DSH 模块/资源以及原生审批链路。该检查需要 npm registry 网络访问；不调用真实 Jev API。

`release:info` 验证 tag 与 `package.json.version` 一致，提取 `CHANGELOG.md` 中对应版本的说明。缺少说明、tag 不匹配或包身份/许可证错误时失败。

`prepack` 只负责构建，不能代替测试。发布任务将准备阶段验证过的同一个 tarball 发布到 npm 并上传 GitHub，不在发布阶段重新构建。用户安装发布包时无需执行构建或安装本项目的开发依赖。

## 触发发布

完成本轮功能、文档和检查后先提交；首版已有 `0.0.1` 版本号和对应更新日志，不需要再次升版。为通过检查的提交创建 tag 并推送：

```bash
git tag -a v0.0.1 -m 'jev-review 0.0.1'
git push origin main
git push origin v0.0.1
```

后续版本先执行 `npm version patch --no-git-tag-version`（或按兼容影响选择 minor/major），同步更新日志和相关文档，检查通过后提交，再创建对应 tag。禁止移动已发布 tag 或覆盖 npm 的既有版本。

Release 工作流执行以下流程：

1. 检出 tag，校验版本和更新日志，运行 Lint、类型检查、测试及发布包安装验证。
2. 创建 GitHub Release，上传 tarball 与 `SHA256SUMS`。
3. 发布同一个 tarball 到 npm，并生成 provenance。稳定版本使用 `latest`，预发布版本使用 `next`，GitHub 同时标记 prerelease。

若 npm secret 尚未配置或权限不足，npm job 会失败，已生成的 GitHub Release 仍可使用。配置好身份后可以重跑失败 job。重复发布只跳过字节完全相同的 npm 版本；同版本不同内容会失败。已有 GitHub Release 的 checksum 必须与本轮产物一致，不自动覆盖附件。

也可以在 **Actions → Release → Run workflow** 中填写已有 tag。取消 `publish_npm` 可仅创建 GitHub Release。手动触发仍执行完整验证，不能绕过检查。推送 tag 默认同时尝试两个发布目标。

## 安装发布包

发布成功后，Pi 可以直接通过 npm 安装：

```bash
export TYPESAFE_API_KEY='your-key'
pi install npm:jev-review@0.0.1
```

DSH 可以通过其插件管理命令安装 npm 包：

```bash
export TYPESAFE_API_KEY='your-key'
npx @deepseek-ai/dsh@0.2.1-alpha.2 plugin --profile web add jev-review@0.0.1
npx @deepseek-ai/dsh@0.2.1-alpha.2 web
```

DSH 仍需在会话选择 Auto review 或执行 `/permission auto`。安装不会自动改变会话权限。

仅使用 GitHub Release 时，下载同一版本的 `.tgz` 和 `SHA256SUMS`，校验后解压到本地目录：

```bash
sha256sum --check SHA256SUMS
mkdir -p jev-review
tar -xzf jev-review-0.0.1.tgz -C jev-review --strip-components=1
```

Pi 使用 `pi install /absolute/path/to/jev-review`。DSH 本地包还需在解压目录运行 `npm install --omit=dev --ignore-scripts` 来安装运行时依赖，再执行 `dsh plugin --profile web add /absolute/path/to/jev-review`。发布包已经包含 DSH 构建产物，无需 `npm run build`。

GitHub 自动提供的 Source code 压缩包是源码快照；预构建安装应下载名为 `jev-review-<version>.tgz` 的附件。
