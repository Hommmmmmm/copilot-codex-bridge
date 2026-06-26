# Copilot Codex Bridge

> 把 GitHub Copilot 订阅模型（Claude / Gemini / GPT 等）接到 [Codex 桌面端](https://chatgpt.com/codex) 用的本地代理 + GUI 控制面板。

[![Release](https://img.shields.io/github/v/release/Hommmmmmm/copilot-codex-bridge)](https://github.com/Hommmmmmm/copilot-codex-bridge/releases/latest)
[![License](https://img.shields.io/github/license/Hommmmmmm/copilot-codex-bridge)](LICENSE)

---

## 这是什么

GitHub Copilot 的订阅自带几十个上游模型（Claude Opus 4.7 / Sonnet 4.6 / Gemini 3.1 / GPT-5.4 等），但 **Copilot 自家客户端只允许在 VS Code / JetBrains 等编辑器里用**——它们不开放兼容的 HTTP API。

本项目做的事：

1. **本地起一个 HTTP server**（`http://127.0.0.1:8787`），暴露 OpenAI 兼容的 `/v1/models`、`/v1/responses` 端点
2. 收到请求后，**用你登录过的 Copilot token** 去调上游的 Copilot 后端
3. **改写 `~/.codex/config.toml`** 注册一个叫 `copilot_proxy` 的 provider 指向上面这个本地 server
4. **CDP 注入** Codex 桌面端的 webview，让它的模型菜单显示所有 Copilot 模型而不是只有 GPT-5
5. 一个 **Tauri GUI** 把上面这些全部点点点搞定

效果：你在 Codex 桌面端选 "Claude Opus 4.7"，每条对话实际走的是你的 Copilot 配额。

---

## 安装

### macOS / Apple Silicon

下载最新版 [Releases](https://github.com/Hommmmmmm/copilot-codex-bridge/releases/latest) 的 **`.dmg`**，拖到 Applications。

**首次打开**：右键 → 打开 → 仍然打开（未代码签名，macOS 默认拒绝）。

### Windows arm64

下载 **`.exe`**，运行安装。

**首次打开**：SmartScreen 弹"已保护你的电脑" → 更多信息 → 仍要运行。

### 其他平台

x86_64 平台暂未提供预编译产物。Linux / Intel Mac / Windows x64 用户走源码构建（见下方"开发"）。

---

## 使用

打开 **Copilot Codex Bridge.app**，按照界面顺序操作：

### 1. GitHub 授权

第一张卡片「GitHub 授权」→ 点 **登录** → 浏览器跳到 GitHub device flow → 输入显示的 user code → 授权 → 自动拿到 Copilot token 并持久化到 `~/.copilot-codex-bridge/auth.json`。

Token 过期前后台自动续期。

### 2. 启动代理

第二张卡片「本地代理」→ 调整端口（默认 8787）→ 点 **启动**。

代理跑起来后，本机访问 `http://127.0.0.1:8787/v1/models` 能看到所有可用模型（Claude / GPT / Gemini）。

### 3. 选模型并启动 Codex

「选择模型」面板列出所有可用模型，选一个 → 点 **应用并重启 Codex**。

后台会：
- 改写 `~/.codex/config.toml` 把顶层 `model` / `model_provider` 设为你选的
- `osascript quit Codex` 温柔关闭 Codex.app
- 用 `--remote-debugging-port=9229` 重启 Codex.app
- 通过 CDP 注入 renderer 脚本，让模型菜单显示全部 Copilot 模型

Codex 重启后即用新模型对话。

---

## 进阶：局域网开放

`v0.2.0+` 支持把代理 server 开放给同局域网内其他设备使用。

「本地代理」卡片底部勾选 **「开放到局域网」** → 启动 → 卡片下方会出现 `http://<你的-LAN-IP>:<port>/v1` 的 pill（点击即复制）。

同局域网的同事拿到这个 URL 后，可以：
- 在他们的 Codex / OpenAI 兼容客户端里把 `base_url` 指过来
- 用 `curl http://10.x.x.x:8787/ping` 验证连通性
- 用 `/v1/models` 拉模型列表

代理日志会显示来源 IP：
```
📋 [v1/models] ← 局域网客户端 10.61.56.42 请求模型列表
[LAN] [...] 10.61.56.42 → GET /v1/models 200 87ms ua=curl/8.7.1
```

**⚠️ 安全提醒**：开放模式没有鉴权，同局域网内任何设备都能用你的 Copilot 配额。共享 WiFi（咖啡店 / 酒店）下慎用。

---

## CLI 用法

GUI 是 CLI 的图形包装。所有功能都可以脱离 GUI 直接用命令行：

```bash
# 下载源码 / 拿到打包好的 sidecar 二进制后

# 1. 登录
copilot-bridge login

# 2. 改写 ~/.codex/config.toml 注入 copilot_proxy provider（先备份）
copilot-bridge install

# 3. 启动代理（前台，Ctrl+C 退出）
copilot-bridge start --port 8787
copilot-bridge start --port 8787 --host 0.0.0.0   # 开放到局域网

# 4. 列出当前可用模型 & 切换
copilot-bridge switch                # 不带参数 = 列模型
copilot-bridge switch claude-opus-4.7

# 5. 一步到位：切模型 + 重启 Codex + 注入菜单
copilot-bridge launch claude-opus-4.7

# 状态自检
copilot-bridge status

# 清理：移除 provider + 退出登录
copilot-bridge uninstall
copilot-bridge logout
```

完整命令列表：`copilot-bridge --help`。

---

## API 兼容性

| 端点 | 方法 | 用途 |
|---|---|---|
| `/v1/models` | GET | OpenAI 兼容模型列表 |
| `/v1/responses` | POST | OpenAI Responses API（Codex CLI 默认走这个） |
| `/v1/model-catalog` | GET | 给 renderer 注入脚本拉模型用（含 model_picker_category 等元数据） |
| `/health` | GET | 富信息健康检查（hostname / yourIp / time） |
| `/ping` | GET | 纯文本 `pong\n`，最简连通性测试 |
| `/` | GET | 同 `/health` |

`/health` 和 `/ping` 不需要 Copilot token —— 同事调试连通性时直接打它们。

---

## 项目结构

```
copilot-codex-bridge/
├── src/                          # TypeScript CLI / 代理 server
│   ├── index.ts                  # commander 入口
│   ├── auth/                     # GitHub device flow + Copilot token 持久化/续期
│   ├── copilot/                  # 调上游 Copilot API
│   ├── server/                   # Hono HTTP server（/v1/responses, /v1/models 等）
│   ├── transform/                # OpenAI ↔ Copilot 请求/响应/SSE 转换
│   ├── codex/                    # 改写 ~/.codex/config.toml
│   ├── cdp/                      # Chrome DevTools Protocol bridge（注入 Codex.app）
│   ├── inject/                   # 注入 Codex.app 的 renderer 脚本（解锁模型菜单）
│   └── commands/                 # CLI 子命令实现
├── gui/                          # Tauri 2 GUI
│   ├── src/                      # React + TypeScript 前端
│   └── src-tauri/                # Rust 主进程（spawn sidecar + 系统托盘 + 关窗钩子）
├── scripts/embed-inject.mjs      # 把 inject 脚本编译进 TS 模块给 bun --compile 内联
└── .github/workflows/release.yml # tag-driven release（macOS arm64 + Windows arm64）
```

---

## 开发

需要 [Node 20+](https://nodejs.org) / [pnpm 9+](https://pnpm.io) / [bun 1.x](https://bun.sh) / [Rust stable](https://rustup.rs)。

```bash
# 1. 装依赖
pnpm install
cd gui && pnpm install && cd ..

# 2. 跑 CLI 开发
pnpm dev                          # tsup --watch
node dist/index.js status

# 3. 跑 GUI 开发（Vite HMR + Cargo 增量编译）
cd gui && pnpm tauri dev

# 4. 打包 GUI（macOS arm64）
pnpm package:mac
# 产物：gui/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg
```

发布走 GitHub Actions：push `v*` tag 自动跑 [`release.yml`](.github/workflows/release.yml)，**双平台并行 build**（macOS arm64 + Windows arm64），产物自动塞进 GitHub Releases 草稿。验证 dmg/exe 可用后手动 publish 即可。

---

## FAQ

**Q：为什么不直接用 Copilot 自己的 chat？**
A：Copilot 自家 chat 不开放 OpenAI 兼容 API，且只在它自己的客户端里用得了。本项目让你在 Codex 这类专业开发工具里用 Copilot 的模型配额。

**Q：会消耗 Copilot 配额吗？**
A：每条对话相当于一次 Copilot chat 调用。Copilot 的 chat 模式按月有限额（个人版 / 商业版限额不同，详见 GitHub 文档），本项目代理不会偷偷加请求。

**Q：合规吗？**
A：本项目使用 [device flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) 走 GitHub 标准授权，token 存本地，没有第三方服务器。Copilot 服务条款最终解释权在 GitHub，请自行判断。

**Q：模型菜单为什么注入了还看不到全部模型？**
A：Codex 桌面端版本升级后内部 chunk 名/结构会变。本项目维护一组带特征码识别的 patch，5 个路径联合 hook（HTTP / RPC / event / Statsig / React Fiber），单条失效不影响其他。如全部失效请提 issue 附上 `~/.codex/.tmp/plugins/.agents/plugins/marketplace.json` 那个 chunk 名。

**Q：同局域网开放有鉴权吗？**
A：v0.2.x 暂无。开放后任何同 LAN 设备都能用你的 Copilot 配额。如需 Bearer token 鉴权请提 issue。

**Q：Windows / Intel Mac / Linux 怎么办？**
A：v0.2.1 只编译了 macOS arm64 + Windows arm64 的预编译包。其他平台克隆源码 + `pnpm package:mac`（或对应 target）自己 build。

---

## 致谢

- 灵感来自 [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) —— 它的 renderer 注入思路 + 一键修复 marketplace 思路给了本项目基础参考
- [Hono](https://hono.dev) —— 极轻的 web framework，hono on node 跑得很顺
- [Tauri 2](https://tauri.app) —— 终于不用 Electron 了

---

## License

[MIT](LICENSE)
