# Codex WeChat iLink Demo

这个项目把文章里的 Claude Code 微信通道改成 Codex 版，并默认使用更原生的 Codex app-server 控制面：

```text
微信 iOS -> ClawBot / iLink -> 本地 bun bridge -> codex app-server -> Codex thread/turn -> iLink sendmessage -> 微信
```

这里没有使用 Claude Code 的 development channel。bridge 会长轮询 iLink；每个微信 sender + project 对应一个持久 Codex thread，后续消息在同一个 thread 上继续 `turn/start`。`codex exec` 仍保留为 fallback backend。

## 我已验证的部分

- 本机有 `codex` CLI：`codex-cli 0.130.0`
- 本机有 `bun`：`1.3.11`
- `codex app-server --listen stdio://` 支持 JSONL-RPC；已验证 `initialize`、`thread/start`、`turn/start`、`item/agentMessage/delta`、`turn/completed`
- `codex remote-control` 当前会尝试连接 ChatGPT remote-control enrollment，但本机测试返回 HTTP 404，所以不作为主路径
- iLink 二维码接口可访问：`GET https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` 返回 HTTP 200 和二维码链接
- 原包 `claude-code-wechat-channel@0.2.0` 的 iLink 字段已对照过：`getupdates`、`sendmessage`、`context_token`、`AuthorizationType: ilink_bot_token`

## 文件

- `codex-wechat-ilink.ts`：主脚本
- `codex-wechat-ilink.test.ts`：命令解析、状态管理、sandbox 映射测试
- `projects.example.json`：项目路由配置示例
- `projects.local.json`：本机实际项目配置，已被 `.gitignore` 忽略
- `package.json`：bun 脚本别名
- `.gitignore`：忽略本地 token、临时状态和 npm 包检查产物

## 先做无登录检查

```bash
bun codex-wechat-ilink.ts qr --state-dir ./.codex-wechat
```

成功时会打印：

```text
qrcode: ...
link: https://liteapp.weixin.qq.com/q/...
```

## 扫码登录

默认凭据会保存到 `~/.codex/channels/wechat/account.json`，权限会尽量设为 `0600`。

如果只想把凭据留在这个 demo 目录，用 `--state-dir ./.codex-wechat`。

```bash
bun codex-wechat-ilink.ts setup --state-dir ./.codex-wechat
```

终端会显示二维码，同时生成一张 PNG：

```text
./.codex-wechat/login-qrcode.png
```

优先用 iOS 微信扫描二维码。如果直接打开 `https://liteapp.weixin.qq.com/q/...` 链接显示“网络错误”，不要点链接，改扫二维码图片。确认后会保存：

```text
./.codex-wechat/account.json
```

## 项目配置

复制示例配置，填入你的项目和 sender 白名单：

```bash
cp projects.example.json projects.local.json
```

当前本机的 `projects.local.json` 已包含：

```text
wechat-to-codex -> /Users/fuyuming/Desktop/wechat-to-codex
vibelight       -> /Users/fuyuming/Desktop/project/vibelight
marklab         -> /Users/fuyuming/Desktop/markdown_ai_collab_milkdown_spec
```

如果 `allowedSenderIds` 非空，只有列出的微信 sender 可以触发 Codex。

## 启动 Codex 微信桥

默认 backend 是 `app-server`：

```bash
bun codex-wechat-ilink.ts start \
  --state-dir ./.codex-wechat \
  --projects ./projects.local.json \
  --backend app-server
```

收到微信消息后，bridge 会：

```text
1. 解析 /project、/mode、/model、/status 等命令
2. 找到 sender + project 对应的 threadId
3. 没有 threadId 就 thread/start
4. 有 threadId 就在同一个 thread 上 turn/start
5. 收集 item/agentMessage/delta
6. sendmessage 回微信
```

## 微信命令

```text
/projects              列出项目
/project vibelight     切换当前 sender 的活动项目
/mode read             只读模式
/mode write            workspace-write 模式
/mode bypass           danger-full-access 模式
/model                 查看当前模型
/model gpt-5.2         当前项目后续消息使用指定模型
/model default         清掉当前项目模型 override，回到项目或 Codex 默认模型
/status                查看当前 sender 的项目、模式、thread
/new                   当前项目开新 Codex thread
```

普通消息会发给当前项目的 Codex thread。`/model` 的 override 按“微信 sender + project”保存：你可以在 `vibelight` 用一个模型，在 `marklab` 用另一个模型。

## 本地测试 Codex 调用

不碰微信，直接测试 app-server backend：

```bash
bun codex-wechat-ilink.ts ask --backend app-server --message "只回复 ok"
```

只测脚本，不真的调用 Codex：

```bash
bun codex-wechat-ilink.ts ask --message "hello" --mock-reply "mock: {message}"
```

fallback `exec` backend：

```bash
bun codex-wechat-ilink.ts ask --backend exec --message "只回复 pong"
```

## 常用参数

```text
--state-dir PATH             默认 ~/.codex/channels/wechat
--workspace PATH             Codex 工作目录，默认当前目录
--projects PATH              项目路由 JSON
--backend app-server|exec    默认 app-server
--codex-bin PATH             Codex CLI 路径，默认 codex
--model MODEL                可选，启动级 Codex 模型默认值
--codex-timeout-ms N         默认 120000
--dry-run                    start 时生成回复但不调用 sendmessage
```

## 后台常驻

安装用户级 LaunchAgent，让 bridge 在当前 macOS 用户登录时常驻，并在退出后自动拉起：

```bash
scripts/install-launch-agent.sh
```

停止并移除：

```bash
scripts/uninstall-launch-agent.sh
```

## 远程代码工作

默认 `/mode read`，适合问问题、读代码、让 Codex 做分析，但不会允许它改文件。要允许当前项目写入：

```text
/mode write
```

最高权限：

```text
/mode bypass
```

`bypass` 映射到 app-server 的 `dangerFullAccess` sandbox policy。只建议在 `allowedSenderIds` 白名单打开时临时使用。

## 和 Claude Code 版的差别

Claude Code 版依赖它自己的 Channel 扩展：

```bash
claude --dangerously-load-development-channels server:wechat
```

这个 Codex 版不需要 Claude Channel。它通过 Codex app-server 创建和推进 Codex threads。它不会注入你当前 Codex Desktop 窗口里的这条对话，但它使用的是 Codex 原生 thread/turn 控制面，而不是手写 history 拼 prompt。

## 注意

- 仍然需要 iOS 微信和 ClawBot / iLink 可用。
- `context_token` 是发送回复必需字段，脚本只会回复带 `context_token` 的用户消息。
- token 文件不要提交或发给别人。
- 默认 `read` 是有意的。确认稳定后，再按需要用 `/mode write` 或临时 `/mode bypass`。
- 可以用 `/model <model>` 从微信里切当前项目后续消息的 Codex 模型；用 `/model default` 回到默认。
