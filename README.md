# Codex WeChat iLink Demo

这个项目把文章里的 Claude Code 微信通道改成 Codex 版，并默认使用更原生的 Codex app-server 控制面：

```text
微信 iOS -> ClawBot / iLink -> 本地 bun bridge -> codex app-server -> Codex thread/turn -> iLink sendmessage -> 微信
```

这里没有使用 Claude Code 的 development channel。bridge 会长轮询 iLink；每个微信 sender + project 对应一个持久 Codex thread，后续消息在同一个 thread 上继续 `turn/start`。`codex exec` 仍保留为 fallback backend。

## Install with one prompt

In Codex Desktop or another local coding agent, say:

```text
Install Codex WeChat Handoff by following:
https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/stage0-reliability-foundation/INSTALL.md

Start by setting up carry-over from Codex Desktop to WeChat. Then install the daemon, skill, and run doctor. Do not ask me to paste tokens.
```

Or install directly:

```bash
curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/stage0-reliability-foundation/install.sh | bash
```

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
- `bin/codex-wechat`：面向日常使用的 CLI wrapper
- `skills/codex-wechat/SKILL.md`：Codex Desktop 可加载的 carry-over skill
- `AGENTS.md`：Codex 通过微信回复时的风格和媒体发送约定
- `projects.example.json`：项目路由配置示例
- `projects.local.json`：本机实际项目配置，已被 `.gitignore` 忽略
- `package.json`：bun 脚本别名和 `codex-wechat` bin 声明
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

新用户可以先生成本地配置：

```bash
codex-wechat init --project my-project --cwd /absolute/path/to/my-project
codex-wechat doctor
```

复制示例配置，填入你的项目和 sender 白名单：

```bash
cp projects.example.json projects.local.json
```

默认只暴露明确配置的 sender id。不要在公开安装里把所有微信 sender 都放开；首次绑定后运行 `codex-wechat sender allow <sender_id>`，或使用 setup wizard 写入 allowlist。

如果 `allowedSenderIds` 非空，只有列出的微信 sender 可以触发 Codex。公开使用时建议保持非空，项目默认权限保持 `read`，需要写代码时再显式切换 `/mode write`。

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

## 图片、语音和文件

bridge 现在会尝试处理 iLink 媒体消息：

```text
收图/语音：getupdates -> CDN 下载 -> AES-128-ECB 解密 -> 保存到 state-dir/media -> 把本地路径传给 Codex
发图/语音/文件：Codex 回复媒体标记 -> getuploadurl -> AES-128-ECB 加密上传 CDN -> sendmessage
```

入站图片、语音、文件、视频会保存到：

```text
<state-dir>/media/<sender-id-base64url>/
```

出站回复支持这些标记：

```text
WECHAT_IMAGE: /absolute/path/to/image.png
WECHAT_VOICE: /absolute/path/to/audio.silk playtime_ms=2000
WECHAT_FILE: /absolute/path/to/report.pdf
```

也会自动识别本地 Markdown 图片路径，例如：

```text
![preview](/absolute/path/to/image.png)
```

语音发送目前只负责上传并按扩展名设置 encode_type，不做本地音频转码；最稳的是传 `.silk` 文件。

视觉类输出建议：

- 单屏设计方案、UI 对比、状态卡片：优先生成图片并用 `WECHAT_IMAGE` 发回。
- 多页 diff、review、表格报告：优先 HTML -> PDF，再用 `WECHAT_FILE` 发回。

HTML artifact 可以用内置 renderer 自动转成 PDF/PNG：

```bash
codex-wechat render-html \
  --html /absolute/path/to/report.html \
  --pdf /absolute/path/to/report.pdf \
  --png /absolute/path/to/report.png \
  --renderer auto
```

`--renderer auto` 会优先使用 Chrome / Chromium / Edge 生成高保真 vector PDF 和 PNG；如果没有浏览器，会在 macOS 上降级到 `qlmanage` 生成 PNG，并用 `sips` 把 PNG 包成 image-based PDF。也可以显式指定 `--renderer chrome` 或 `--renderer quicklook`。

也可以直接从 CLI 做真实文件发送 smoke：

```bash
codex-wechat send-file \
  --state-dir ./.codex-wechat \
  --file /absolute/path/to/report.pdf \
  --to last \
  --message "报告见附件。"
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
/health                查看 daemon、iLink、app-server、context token、lock 和最近错误
/current               查看当前项目、thread、lease 和 parked thread
/sessions              查看当前 sender 的项目 session 和 attached thread
/attach latest         把当前项目最新 session attach 到微信
/attach <thread_id>    手动 attach 一个 Codex thread
/back                  手机请求切回电脑，等待 Desktop pull-current
/resume                从手机恢复 remote mode
/detach                退出 Desktop carry-over，回到之前微信 session
/onboarding            重新查看 carry-over-first 上手说明
/intro                 /onboarding 的短别名
/history [n]           查看最近事件摘要入口
/help                  查看微信命令
/new                   当前项目开新 Codex thread
```

普通消息会发给当前项目的 Codex thread。`/model` 的 override 按“微信 sender + project”保存：你可以在 `vibelight` 用一个模型，在 `marklab` 用另一个模型。

如果当前 route 是 Desktop active 或 pending Desktop pull，普通微信消息不会静默写入同一个 thread；bridge 会提示发 `/resume` 后再继续手机 remote mode。

## 运行状态文件

bridge 会在 `--state-dir` 下保存运行状态，用来支持远程排障和后续 carry-over：

```text
account.json           iLink 登录凭据
sync_buf.txt           iLink 长轮询游标
sessions.json          sender/project/thread 状态
context_tokens.json    每个 sender 最新可用 context_token
bridge.lock.json       当前 daemon owner 和 heartbeat，避免重复实例
events.jsonl           结构化事件日志，后续 /wechat pull 会用它生成手机侧 delta
message_claims/        已处理微信消息 claim，避免重复执行同一条消息
```

如果微信发了消息但没有回复，优先在微信发 `/health`，它会区分最近一次失败更像是登录、轮询、context token、app-server、active turn 还是项目配置问题。

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

## Desktop / WeChat carry-over

这个版本支持把当前 Codex Desktop/CLI thread 绑定到微信 route，再从微信继续，之后从 Desktop 拉回 delta。

日常入口是 `codex-wechat` CLI；开发调试时也可以继续用 `bun codex-wechat-ilink.ts ...`。

从 Codex Desktop 当前会话发起 handoff：

```bash
codex-wechat carry-current \
  --project current \
  --to last
```

`carry-current` 默认读取当前进程环境里的 `CODEX_THREAD_ID`。如果是在普通终端测试，可以显式传：

```bash
codex-wechat carry-current \
  --project vibelight \
  --to last \
  --thread-id 019e...
```

回到电脑后拉回手机期间的继续内容：

```bash
codex-wechat pull-current --project current
```

辅助命令：

```bash
codex-wechat carry-status --project current
codex-wechat discover-sessions --project vibelight
```

短别名也可用：

```bash
codex-wechat carry --project current --to last
codex-wechat pull --project current
codex-wechat status --project current
codex-wechat sessions --project current
```

`carry-current` 和 `pull-current` 会优先用 `context_tokens.json` 里的最新 token 主动给微信发通知；如果还没有缓存 token，会尝试 iLink 空 context fallback。若服务端拒绝，状态仍会保存，终端会显示 `notification: not_sent (...)`；从微信先发任意一条消息即可建立 context。

## Codex skill

本仓库提供一个本地 skill，让 Codex Desktop 能把“carry this to WeChat”“/wechat pull”“status”等自然语言请求映射到 CLI：

```bash
ln -s /Users/fuyuming/Desktop/wechat-to-codex/skills/codex-wechat ~/.codex/skills/codex-wechat
```

当前本机已安装这个 symlink。安装后，新开的 Codex 会话可以直接使用 `codex-wechat` skill；真正执行仍走同一个 CLI。

## 常用参数

```text
--state-dir PATH             默认 ~/.codex-wechat-handoff
--cdn-base-url URL           默认 https://novac2c.cdn.weixin.qq.com/c2c
--workspace PATH             Codex 工作目录，默认当前目录
--projects PATH              项目路由 JSON
--backend app-server|exec    默认 app-server
--codex-bin PATH             Codex CLI 路径，默认 codex
--model MODEL                可选，启动级 Codex 模型默认值
--codex-timeout-ms N         默认 600000
--dry-run                    start 时生成回复但不调用 sendmessage
```

## 后台常驻

安装用户级 LaunchAgent，让 bridge 在当前 macOS 用户登录时常驻，并在退出后自动拉起：

```bash
codex-wechat daemon install
```

查看状态和最近日志：

```bash
codex-wechat daemon status
codex-wechat daemon logs
```

LaunchAgent 默认把 Codex 单轮处理超时设为 10 分钟。超时或异常时，bridge 会尽量把失败原因发回微信，而不是静默卡住。需要指定本地项目配置时，把同样的参数交给安装命令：

```bash
codex-wechat daemon install --projects ./projects.local.json
```

停止但保留 plist，或停止并移除：

```bash
codex-wechat daemon stop
codex-wechat daemon uninstall
```

旧脚本仍可用，但现在只是这些 CLI 命令的 wrapper：

```bash
scripts/install-launch-agent.sh
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
