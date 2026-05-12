# Troubleshooting

Run these first:

```bash
codex-wechat doctor
codex-wechat daemon status
codex-wechat daemon logs
```

## QR Link Says Network Error

Use iOS WeChat to scan the generated QR image instead of opening the `liteapp.weixin.qq.com` link directly. The setup command prints both the link and the local PNG path.

```bash
codex-wechat setup
```

If the QR expires, rerun setup.

## WeChat Message Received But No Reply

Check daemon health:

```bash
codex-wechat daemon status
codex-wechat daemon logs
```

Then send `/health` in WeChat. Common causes are an expired iLink login, missing `context_token`, a live turn already running, invalid project config, or Codex app-server timeout.

## app-server Turn Timed Out

The daemon defaults to a 10 minute Codex turn timeout. Long code work can still finish locally after the bridge times out, but WeChat will receive a timeout status.

Increase the timeout when installing the daemon:

```bash
codex-wechat daemon install --codex-timeout-ms 900000
```

For repeated timeouts, test the same task in Codex Desktop and reduce the WeChat request into smaller steps.

## Duplicate Daemon Running

The bridge writes `bridge.lock.json` in the state directory. If `/health` reports a live owner, do not start another daemon for the same state dir.

Use:

```bash
codex-wechat daemon status
codex-wechat daemon stop
codex-wechat daemon install
```

If a process crashed and the lock is stale, the bridge recovers it after the stale timeout.

## context_token Missing

iLink requires a reply context token for normal sends. The bridge caches the latest context token after inbound WeChat messages.

Fix:

1. Send any message from WeChat to the bot.
2. Run the intended `carry-current`, `send-file`, or `send-image` command again.

If you are testing without WeChat, use `--dry-run`.

## No Chrome Installed For HTML Rendering

`render-html --renderer auto` tries Chrome, Chromium, and Edge first. On macOS it falls back to Quick Look plus `sips`.

Check:

```bash
codex-wechat doctor
```

If Chrome is installed in a custom location:

```bash
CODEX_WECHAT_CHROME=/absolute/path/to/chrome codex-wechat render-html --html report.html --pdf report.pdf
```

## Image Or File Send Failed

Confirm the file exists and is readable:

```bash
ls -l /absolute/path/to/file
codex-wechat send-file --file /absolute/path/to/file --to last --dry-run
```

Then check daemon logs and iLink account status:

```bash
codex-wechat doctor
codex-wechat daemon logs
```

## /mode fullaccess Safety

`/mode fullaccess` maps remote WeChat requests to unrestricted local access. Use it only for trusted senders and trusted projects. `/mode bypass` remains a legacy alias.

Recommended flow:

```text
/mode read
/project my-project
```

Switch to `/mode write` only when you need edits inside the active project cwd. Switch to `/mode fullaccess` only when the remote task truly needs unrestricted local commands or unrestricted filesystem access.
