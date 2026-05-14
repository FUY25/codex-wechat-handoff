# Codex WeChat Handoff

不用在手机上重新解释一遍 Codex 上下文。

电脑上的 Codex Desktop/CLI thread 已经聊过项目背景、约束、文件和下一步？把这段上下文接到微信里继续；回到电脑后，再把手机期间的对话记录 pull back，接着同一个工作流。

**本地 daemon · 个人 WeChat iLink QR · 无公网 callback · project allowlist · read/write/fullaccess modes**

平时，你也可以直接在微信里使用自己的 mobile session：默认 `inbox` 用来做轻量任务和文件产出；配置过的 project 则可以关联到真实代码目录，让 Codex 从微信里读代码、查问题、整理 diff、生成报告，或在允许的模式下写入项目文件。

[English version](README.en.md)

## 30 秒看懂

### 1. 把电脑上的 Codex 上下文接到微信

电脑里已经有一个 Codex thread，聊过项目背景、限制条件和下一步。离开电脑前，对 Codex 说：

```text
carry this to WeChat
```

微信收到 `continue from here` 后，直接回复就能接着已有上下文继续，不需要重新开空白聊天。

回到电脑后，对 Codex 说：

```text
pull WeChat back
```

微信期间的对话和结论会作为对话记录带回电脑，继续接在原来的工作流里。

```text
Codex Desktop / CLI
  -> carry this to WeChat
  -> 微信里继续这段上下文
  -> pull WeChat back
  -> 对话记录回到电脑
```

### 2. 跑完后微信提醒，再决定要不要接到手机

你也可以不立刻切到手机，只让 Codex 在 Desktop / CLI run 结束后发一条微信提醒：

```bash
codex-wechat notify-finish on --to last
```

之后 Codex run 完成时，微信会收到简短通知。你可以：

- 回复 `/continue`：从手机继续这次 Desktop 上下文
- 忽略通知：微信保持原来的 project / session，不会被打断
- 回电脑继续：如果手机期间已有内容，先说 `pull WeChat back`

### 3. 直接在微信里开 mobile session

安装后会有一个默认 `inbox` workspace。它是 WeChat-only 的安全工作区，适合：

- 让 Codex 整理想法
- 生成 Markdown / HTML / PDF
- 做轻量研究和总结
- 把图片、文件、报告发回微信

你也可以添加真实代码项目：

```bash
codex-wechat project add vibelight --cwd /absolute/path/to/vibelight --mode read
```

然后在微信里切换：

```text
/projects
/project vibelight
/status
```

每个 project 有自己的 mobile session，不会把不同项目的上下文混在一起。

## 它不是另一个微信 bot

它不是单纯把 Codex 放进微信聊天窗口。

Codex WeChat Handoff 的重点是：电脑上已经有上下文的 Codex 工作流，可以接到微信里继续，再把手机期间的对话记录拉回 Desktop/CLI。

## 它解决的不是“手机远程桌面”

很多手机控制工具解决的是：怎么看运行状态、怎么审批、怎么远程操作终端。

Codex WeChat Handoff 更关注另一个问题：

> 我已经在电脑上的 Codex thread 里铺好了上下文，能不能直接在微信里接着聊？

所以它的核心不是开一个新的 bot，而是在 Desktop/CLI、微信 continuation、mobile session 之间交接上下文。

## 适合谁

- 高频使用 Codex Desktop / CLI，不想丢掉 thread 上下文的人
- 经常离开电脑，但还想用微信推进轻量 coding-agent 工作的人
- 想把微信当作本地 Codex mobile surface 的个人开发者
- 喜欢 local-first、可审计、可自己控制权限边界的 agent workflow 玩家

## 不适合谁

- 想要团队级多人客服 bot
- 想要完整手机 IDE 或远程桌面
- 想要 Windows-first、开箱即用且已充分验证的方案
- 不愿意使用个人 WeChat iLink QR setup 的用户

## Demo

Demo 视频制作中。第一版会展示完整接力流程：

```text
电脑上的 Codex 上下文 -> 微信 continuation -> 回电脑 pull back
```

我们会用 HyperFrames 动画表现这个故事：

```text
电脑上的 Codex thread 已经聊到一半
  -> 不想在手机上重新解释上下文
  -> carry this to WeChat
  -> 微信继续这段上下文
  -> pull WeChat back
  -> 回到电脑继续
```

## 一行安装

运行下面的命令，安装 CLI、Codex skill，初始化默认 `inbox`，扫码完成 WeChat iLink setup，运行检查，并启动后台 daemon：

```bash
curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | bash
```

安装流程会：

- 安装 `codex-wechat` CLI 到 `~/.local/bin/codex-wechat`
- 安装 Codex skill 到 `~/.codex/skills/codex-wechat`
- 创建默认 WeChat-only `inbox`
- 通过 QR 完成个人 WeChat iLink setup
- 运行 `codex-wechat doctor`
- 安装后台 daemon
- 打印 daemon status

QR setup 完成后，打开微信发送：

```text
/onboarding
```

## Codex Desktop 也会懂

安装脚本会同时安装 `codex-wechat` skill。安装后，你可以直接在 Codex Desktop / CLI 里用自然语言让 Codex 操作这个桥：

```text
carry this to WeChat
```

```text
pull WeChat back
```

```text
帮我把 /Users/me/code/my-app 加到 WeChat project allowlist，mode 用 read，然后跑 doctor。
```

```text
把这个 HTML 报告渲染成 PDF，然后发到微信。
```

这个 skill 会让 Codex 选择正确的 `codex-wechat` 命令，例如 `carry-current`、`pull`、`project add`、`doctor`、`render-html`、`send-file`。安装和配置时不需要你手动粘贴 token，也不应该把 `account.json` 或 sender id 发到公开地方。

如果你想让当前 Desktop/CLI run 完成后微信提醒，也可以直接对 Codex 说：

```text
这个 run 结束后微信提醒我，下一步让我决定要不要从手机继续。
```

Codex 会在合适的时候使用 `notify-finish`，而不是自动切走当前手机 session。

## 手动安装

如果你想手动分步骤执行：

```bash
curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | bash -s -- --install-only
codex-wechat init
codex-wechat project add my-project --cwd /absolute/path/to/my-project --mode read
codex-wechat setup
codex-wechat daemon install
codex-wechat doctor
```

`codex-wechat init` 会创建默认 WeChat-only `inbox` project：

```text
~/.codex-wechat-handoff/workspaces/inbox
```

真实代码目录需要显式加入 project allowlist：

```bash
codex-wechat project add vibelight --cwd /absolute/path/to/vibelight --mode read
```

setup flow 默认把 credentials 存在：

```text
~/.codex-wechat-handoff
```

不要粘贴、发布、截图或提交这些凭证文件。

## 用一句话让 Codex 帮你安装

你也可以让 Codex Desktop 或其他本地 coding agent 帮你安装：

```text
Install Codex WeChat Handoff by following:
https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/INSTALL.md

Start by setting up carry-over from Codex Desktop to WeChat.
Then install the daemon, skill, and run doctor.
Do not ask me to paste tokens.
```

安装完成后，还可以继续让 Codex 帮你添加 project allowlist：

```text
把这个 repo 加到 codex-wechat projects，默认 mode 用 read，然后告诉我微信里应该发哪些命令。
```

## Project 和 Session

### `inbox`

默认 WeChat-only workspace，位于：

```text
~/.codex-wechat-handoff/workspaces/inbox
```

它是 bridge-owned 的安全起点，适合手机侧轻量任务、临时文件和报告产出，所以默认可以是 `write`。

### `project`

你允许微信路由到的本地工作目录，比如 `vibelight`、`marklab`、`handoff`。

添加 project：

```bash
codex-wechat project add vibelight --cwd /absolute/path/to/vibelight --mode read
codex-wechat doctor
```

然后在微信里：

```text
/projects
/project vibelight
/status
```

### `mobile session`

某个微信 sender + project 对应的手机侧 Codex thread。每个 project 可以有自己的手机会话。

`/project <name>` 不是把一个旧 thread 的 cwd 改掉，而是切换到该 project 自己的 mobile session/thread。mode 会从该 project 的 session 或默认配置恢复。

### `carry-over`

临时把当前 Desktop/CLI thread fork 成手机侧 continuation，让手机继续这个已有上下文。微信不会直接写 live Desktop thread。

### `pull-back`

把微信期间的 raw transcript 带回电脑，让 Desktop/CLI 接着原来的工作流继续。

### `detach`

退出当前 Desktop carry-over，回到微信原本的 project mobile session。

## 把 Desktop / CLI Thread 接到微信

从一个活跃的 Codex Desktop 或 CLI thread 里：

```bash
codex-wechat carry-current --project current --to last
```

或者直接对 Codex 说：

```text
carry this to WeChat
```

桥会发一条微信消息，开头是：

```text
continue from here
```

之后，微信里的普通回复会继续这个 forked mobile continuation。active project、mode、Desktop thread 和 mobile thread 会按微信 sender 记录。

carry-over 是一个 handoff lease，不是两个入口同时 live control 同一个 thread。收到 carry notification 后，建议从微信继续。如果你在 pull-back 前又回到同一个 Desktop/CLI thread 输入内容，桥会认为你已经回到电脑，并自动暂停 WeChat remote mode。之后需要 `/resume`、`/detach` 或重新 carry 才会恢复手机入口。

回到电脑后，对 Codex 说：

```text
pull WeChat back
```

CLI fallback：

```bash
codex-wechat pull --project current
```

CLI 会打印 `WeChat raw handoff`，并告诉微信 session 已切回 Desktop。

## 跑完通知

如果你还在电脑上工作，但希望 Codex run 结束时微信提醒你，可以开启 finish-run notification：

```bash
codex-wechat notify-finish on --to last
```

查看当前状态：

```bash
codex-wechat notify-finish status --to last
```

恢复继承默认值：

```bash
codex-wechat notify-finish inherit --to last
```

设置 sender 级默认值：

```bash
codex-wechat notify-finish default off --to last
```

通知只是一个邀请，不会自动抢走手机 session。收到通知后：

- 回复 `/continue`：从手机继续这次 Desktop 工作流
- 忽略通知：微信保持原来的 project / session
- 回电脑继续：如果手机期间已有内容，先运行 `pull WeChat back`

finish-run 开关只能在 Desktop/CLI 控制。微信里的 `/notify status` 只负责查看状态。

## 微信命令

```text
/intro                 简短 carry-over 介绍
/onboarding            完整 carry-over、project、command 指南
/projects              列出已配置 project
/project <name>        切到该 project 自己的 mobile session/thread
/mode read             可读/search 本机可读文件和联网，但不写文件
/mode write            可读/search/联网，只能写当前 project cwd
/mode fullaccess       不限制本地访问
/model                 查看当前 model
/model <name>          设置当前 sender + project 的 model override
/model default         清除 model override
/status                查看 project、mode、model、thread、lease、cwd
/health                查看 daemon 和最近 bridge health
/current               查看当前 route 和 parked thread
/sessions              查看 sender 的 project sessions
/attach latest         把最近的 project session attach 到微信
/attach <thread_id>    attach 指定 Codex thread
/back                  请求切回 Desktop
/resume                恢复手机 remote mode
/continue              从 finish-run 提醒接到手机继续
/detach                退出 Desktop carry-over，回到原微信 session
/notify status         查看 finish-run 微信提醒状态，只读
/history [n]           查看最近 history entry point
/new                   为当前 project 开一个新的手机侧 Codex thread
/stop                  查看当前 stop/interrupt 状态
/help                  列出命令
```

默认 `inbox` project 从 `write` mode 开始，因为它在 bridge-owned workspace 里。真实代码 project 通常应该先用 `read` mode。

Permission modes：

- `read`：可以读/search 本机可读文件并联网，但不能写文件。
- `write`：可以读/search 本机可读文件并联网，但只能写 active project cwd。
- `fullaccess`：不限制本地访问。只有你明确想从微信给 Codex 完整本地控制权时才使用。

`/mode bypass` 是 `/mode fullaccess` 的 legacy alias。

如果 Desktop thread 已经接近或命中模型 context window，bridge 会在 carry/fork 前读取本机 Codex rollout 里的 token usage。状态会显示在 `/status`、`carry-status` 和 carry 通知里，例如 `context: high (90%, 90k/100k)`。如果已经是 `critical` 或 `saturated`，bridge 会阻止 native fork，并提示你先在当前 Desktop/CLI thread 运行 `/compact`，然后再重新 carry。

bridge 不会静默 fallback 到 summary handoff，避免你以为手机拿到的是完整 native thread。手机期间和 pull-back 仍然用 raw transcript delta 交接上下文。

## 为什么不是普通微信 bot

普通 bot 往往是：

- 在微信里开一个新聊天
- 给 agent 发消息
- 按命令切模型或目录

Codex WeChat Handoff 多了一层 thread handoff：

- 从电脑上已有 Codex context 开始手机侧 continuation
- 手机期间不丢 continuation
- 回来后可以把 raw transcript pull back 到 Desktop/CLI
- project、session、mode 分开管理
- rich artifacts 可以通过微信发回

## 富媒体结果：图片、PDF、报告

Codex 可以把图片、PDF、报告等结果发回微信。回复里可以包含这些 marker：

```text
WECHAT_IMAGE: /absolute/path/to/image.png
WECHAT_FILE: /absolute/path/to/report.pdf
WECHAT_VOICE: /absolute/path/to/audio.silk playtime_ms=2000
```

适合：

- code diff review
- frontend design decision
- UI 方案对比
- 架构图
- 数据/调研报告
- 多页 Markdown/PDF 输出

对于视觉设计选择、代码 diff、图表或报告，可以先生成 HTML，再渲染：

```bash
codex-wechat render-html \
  --html /absolute/path/to/report.html \
  --pdf /absolute/path/to/report.pdf \
  --png /absolute/path/to/report.png \
  --renderer auto
```

`--renderer auto` 会优先使用 Chrome、Chromium 或 Edge。macOS 没有浏览器时，会 fallback 到 Quick Look PNG 和 `sips` image-based PDF。

直接发送文件或图片：

```bash
codex-wechat send-text --to last --message "进度更新。"
codex-wechat send-file --file /absolute/path/to/report.pdf --to last --message "报告见附件。"
codex-wechat send-image --file /absolute/path/to/preview.png --to last --message "预览图。"
```

## 安全模型

Codex WeChat Handoff 是本地 bridge，不是公网 webhook。

- 通过个人 WeChat iLink 扫码授权
- 本地 daemon 长轮询消息
- 不需要公开 callback URL
- 不需要暴露 WebSocket server 给公网
- credentials 存在本机 state dir
- sender allowlist 控制谁能触发 Codex
- project allowlist 控制可以切换到哪些项目和 write root
- `/mode read` 不写文件
- `/mode write` 只允许写当前 project cwd
- `/mode fullaccess` 才是不限制本地访问

注意：`read` 和 `write` mode 不是硬性的读取沙箱；它们仍可读取/search 本机可读文件。真正受限制的是写入能力：`read` 不写文件，`write` 只能写当前 project cwd。

默认建议：

- `inbox` 可以用 `write`
- 真实代码 project 先用 `read`
- 需要改代码时再显式切到 `write`
- 谨慎使用 `fullaccess`

敏感文件包括：

```text
~/.codex-wechat-handoff/account.json
~/.codex-wechat-handoff/projects.json
~/.codex-wechat-handoff/logs/
```

不要粘贴、发布、提交或截图这些文件。

详见 [docs/security-model.md](docs/security-model.md)。

## 平台状态

macOS 是目前测试最多、最稳定的路径。后台 daemon 使用 macOS LaunchAgent：

```bash
codex-wechat daemon install
codex-wechat daemon status
```

CLI 设计上不绑定单一平台，但 Windows 还没有完整验证。非 macOS 环境可以先用 foreground listener / manual flow 验证，再决定是否自己接入系统服务。

## 工作原理

```text
WeChat
  -> iLink long polling
  -> local codex-wechat daemon
  -> forked mobile continuation / project session
  -> iLink sendmessage
  -> WeChat reply
```

没有 public callback URL。local daemon 负责 poll iLink、把允许的消息 route 到 Codex，再把回复发回 WeChat。

carry-over 不会让微信直接写入 live Desktop thread。桥会从当前 Desktop thread fork 出一个 mobile continuation；微信写 mobile continuation；pull-back 时再把 `WeChat raw handoff` 带回当前 Desktop chat。

## Project 配置

创建默认配置：

```bash
codex-wechat init
```

结果：

```text
defaultProject: inbox
cwd: ~/.codex-wechat-handoff/workspaces/inbox
mode: write
```

添加真实代码 project：

```bash
codex-wechat project add vibelight --cwd /absolute/path/to/vibelight --mode read
codex-wechat doctor
```

也可以从 example 开始：

```bash
cp projects.example.json ~/.codex-wechat-handoff/projects.json
```

Example：

```json
{
  "defaultProject": "example",
  "allowedSenderIds": ["replace-with-your-wechat-sender-id-after-binding"],
  "projects": {
    "example": {
      "cwd": "/absolute/path/to/your/project",
      "defaultMode": "read"
    }
  }
}
```

public 或 shared install 应保持 sender access explicit。如果 `allowedSenderIds` 非空，只有这些 WeChat sender 能触发 Codex。

## Daemon

安装 macOS LaunchAgent：

```bash
codex-wechat daemon install
```

查看状态和日志：

```bash
codex-wechat daemon status
codex-wechat daemon logs
```

停止或卸载：

```bash
codex-wechat daemon stop
codex-wechat daemon uninstall
```

legacy scripts 仍然是 thin wrappers：

```bash
scripts/install-launch-agent.sh
scripts/uninstall-launch-agent.sh
```

## CLI 参考

```text
codex-wechat init [--project NAME] [--cwd PATH] [--mode read|write|fullaccess]
codex-wechat project add <name> --cwd PATH [--mode read|write|fullaccess]
codex-wechat project list
codex-wechat setup [--force]
codex-wechat doctor
codex-wechat daemon install|status|logs|stop|uninstall
codex-wechat carry-current [--project current|NAME] [--to last|SENDER] [--thread-id ID]
codex-wechat pull-current [--project current|NAME] [--thread-id ID]
codex-wechat carry-status [--project current|NAME]
codex-wechat discover-sessions [--project current|NAME]
codex-wechat notify-finish on|off|inherit|status|default on|default off|send [--project current|NAME] [--to last|SENDER] [--summary "..."] [--next-action "..."]
codex-wechat start [--workspace PATH] [--projects PATH]
codex-wechat render-html --html PATH [--pdf PATH] [--png PATH] [--renderer auto|chrome|quicklook]
codex-wechat send-text --message "..." [--to last|SENDER]
codex-wechat send-file --file PATH [--to last|SENDER] [--message "..."]
codex-wechat send-image --file PATH [--to last|SENDER] [--message "..."]
```

Short aliases：

```text
codex-wechat carry
codex-wechat pull
codex-wechat status
codex-wechat sessions
```

Common options：

```text
--state-dir PATH             default: ~/.codex-wechat-handoff
--projects PATH              project route config JSON
--backend app-server|exec    default: app-server
--codex-bin PATH             default: codex
--model MODEL                optional startup-level Codex model default
--codex-timeout-ms N         default: 600000
--dry-run                    generate replies without sending to WeChat
```

## 故障排查

先跑：

```bash
codex-wechat doctor
codex-wechat daemon status
codex-wechat daemon logs
```

如果 QR link 打开是网络错误，用 iOS WeChat 扫生成的 QR image，而不是直接打开链接。

如果微信消息到了但没有回复，检查：

```bash
codex-wechat doctor
codex-wechat daemon status
codex-wechat daemon logs
```

详见 [docs/troubleshooting.md](docs/troubleshooting.md)。

## 开发

```bash
bun install
bun test codex-wechat-ilink.test.ts
git diff --check
```

主实现目前在 `codex-wechat-ilink.ts`，这样安装路径保持简单。public workflow 稳定后可以再拆模块。
