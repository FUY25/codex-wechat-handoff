# Codex WeChat iLink Demo

这个 demo 把文章里的 Claude Code 链路改成 Codex CLI 链路：

```text
微信 iOS -> ClawBot / iLink -> 本地 bun 脚本 -> codex exec -> iLink sendmessage -> 微信
```

这里没有使用 Claude Code 的 development channel。Codex CLI 当前可稳定调用的是 `codex exec`，所以这个实现是一个轮询桥接器：每条微信消息进来后，脚本调用一次 `codex exec`，取最后一条回复，再用 iLink 发回微信。

## 我已验证的部分

- 本机有 `codex` CLI：`codex-cli 0.129.0`
- 本机有 `bun`：`1.3.11`
- `codex exec --help` 支持 `--output-last-message`、`--ephemeral`、`--skip-git-repo-check`；`codex --help` 支持顶层 `--sandbox`、`--ask-for-approval never`
- iLink 二维码接口可访问：`GET https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` 返回 HTTP 200 和二维码链接
- 原包 `claude-code-wechat-channel@0.2.0` 的 iLink 字段已对照过：`getupdates`、`sendmessage`、`context_token`、`AuthorizationType: ilink_bot_token`

## 文件

- `codex-wechat-ilink.ts`：主脚本
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

## 启动 Codex 微信桥

安全默认值是只读沙箱，适合先做聊天测试：

```bash
bun codex-wechat-ilink.ts start --state-dir ./.codex-wechat --workspace "$PWD"
```

收到微信消息后，脚本会执行类似：

```bash
codex --ask-for-approval never exec --ephemeral --skip-git-repo-check --sandbox read-only --output-last-message <tmp-file> -C <workspace> "<prompt>"
```

如果你想让微信里的 Codex 能在某个代码仓库里读上下文，把 `--workspace` 指到那个仓库：

```bash
bun codex-wechat-ilink.ts start \
  --state-dir ./.codex-wechat \
  --workspace /Users/fuyuming/Desktop/project/your-repo
```

## 本地测试 Codex 调用

不碰微信，只测 prompt -> Codex 回复：

```bash
bun codex-wechat-ilink.ts ask --state-dir ./.codex-wechat --message "只回复 pong"
```

如果只测脚本，不真的调用 Codex：

```bash
bun codex-wechat-ilink.ts ask --message "hello" --mock-reply "mock: {message}"
```

## 常用参数

```text
--state-dir PATH             默认 ~/.codex/channels/wechat
--workspace PATH             Codex 工作目录，默认当前目录
--codex-bin PATH             Codex CLI 路径，默认 codex
--model MODEL                可选，传给 codex exec -m
--codex-sandbox MODE         默认 read-only，可改 workspace-write 或 danger-full-access
--codex-timeout-ms N         默认 120000
--history-limit N            每个 sender 保留最近 N 轮用户/助手消息
--dry-run                    start 时生成回复但不调用 sendmessage
--persist-codex-sessions     不传 --ephemeral，让 Codex 保留每次会话记录
```

## 远程代码工作

默认 `--codex-sandbox read-only`，适合问问题、读代码、让 Codex 做分析，但不会允许它改文件。要让微信里的指令能改某个项目，把 `--workspace` 指向那个项目，并把 sandbox 改成 `workspace-write`：

```bash
bun codex-wechat-ilink.ts start \
  --state-dir ./.codex-wechat \
  --workspace /Users/fuyuming/Desktop/project/your-repo \
  --codex-sandbox workspace-write
```

不建议直接长期使用 `danger-full-access`。如果要做真正远程开发，最好再加一层白名单或确认机制，比如只允许某个项目路径、只允许特定微信 sender、把“执行测试/提交/推送”等高影响动作拆成确认命令。

## 和 Claude Code 版的差别

Claude Code 版依赖它自己的 Channel 扩展：

```bash
claude --dangerously-load-development-channels server:wechat
```

这个 Codex 版不需要 Channel。它把 iLink 消息当作普通输入，直接交给 `codex exec`。优点是简单、今天能跑；缺点是它不是接入当前 Codex Desktop 这个正在开的会话，而是每条微信消息启动一个独立的 Codex 非交互任务。脚本用本地 `history/*.json` 给每个微信 sender 保留短上下文，弥补会话连续性。

## 注意

- 仍然需要 iOS 微信和 ClawBot / iLink 可用。
- `context_token` 是发送回复必需字段，脚本只会回复带 `context_token` 的用户消息。
- token 文件不要提交或发给别人。
- 默认 `read-only` 是有意的。确认稳定后，再按需要把 `--codex-sandbox` 放宽到 `workspace-write`。
