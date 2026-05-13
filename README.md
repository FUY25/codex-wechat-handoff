# Codex WeChat Handoff

Continue your Codex Desktop coding session from WeChat, then pull it back.

Codex WeChat Handoff connects personal WeChat iLink to Codex app-server. It is built for remote coding handoff: start at your desk, carry the active Codex thread to your phone, continue from WeChat, then return to the same Desktop context.

## One-Line Install And Onboarding

Run this to install, initialize, scan QR, run checks, and start the background listener:

```bash
curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | bash
```

This installs the CLI and skill, creates the default `inbox`, starts QR setup, runs `doctor`, installs the background daemon, and prints daemon status.

After QR setup finishes, open WeChat and send:

```text
/onboarding
```

## Manual Install

Use this only if you want to run each step yourself:

```bash
curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | bash -s -- --install-only
codex-wechat init
codex-wechat project add my-project --cwd /absolute/path/to/my-project --mode read
codex-wechat setup
codex-wechat daemon install
codex-wechat doctor
```

`codex-wechat init` creates a default WeChat-only `inbox` project under `~/.codex-wechat-handoff/workspaces/inbox`. Add real code folders explicitly with `codex-wechat project add`. The setup flow saves credentials under `~/.codex-wechat-handoff` by default. Do not paste or publish those files.

## Install with One Prompt

In Codex Desktop or another local coding agent, say:

```text
Install Codex WeChat Handoff by following:
https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/INSTALL.md

Start by setting up carry-over from Codex Desktop to WeChat. Then install the daemon, skill, and run doctor. Do not ask me to paste tokens.
```

## Carry A Desktop Codex Session To WeChat

From an active Codex Desktop or CLI thread:

```bash
codex-wechat carry-current --project current --to last
```

The bridge sends a WeChat message that starts with:

```text
continue from here
```

After that, replies from WeChat continue the same Codex thread. The active project, mode, and thread id are tracked per WeChat sender.

When you return to the computer, tell Codex:

```text
pull WeChat back
```

CLI fallback:

```bash
codex-wechat pull --project current
```

The CLI prints a `Mobile continuation:` delta for the current Desktop chat and tells WeChat that the session moved back to Desktop.

Screenshots are planned for the first public release:

- `docs/assets/carry-over-flow.png`
- `docs/assets/wechat-command-surface.png`

## How It Works

```text
WeChat iOS
  -> iLink long polling
  -> local codex-wechat daemon
  -> Codex app-server thread/turn
  -> iLink sendmessage
  -> WeChat reply
```

There is no public callback URL and no WebSocket server to expose. The local daemon polls iLink, routes messages to Codex, and sends replies back through iLink.

## WeChat Commands

```text
/intro                 short carry-over intro
/onboarding            full carry-over, project, and command guide
/projects              list configured projects
/project <name>        switch to that project's own mobile session/thread
/mode read             read/search any readable local files, network enabled, no writes
/mode write            read/search any readable local files, network enabled, write only project cwd
/mode fullaccess       unrestricted local access
/model                 show current model
/model <name>          set model override for this sender + project
/model default         clear model override
/status                show project, mode, model, thread, lease, cwd
/health                show daemon and recent bridge health
/current               show current route and parked thread
/sessions              show sender project sessions
/attach latest         attach latest project session to WeChat
/attach <thread_id>    attach a specific Codex thread
/back                  request pull-back to Desktop
/resume                resume phone remote mode
/detach                exit Desktop carry-over and return to prior WeChat session
/history [n]           show recent history entry point
/new                   start a new phone-side Codex thread for current project
/stop                  show current stop/interrupt status
/help                  list commands
```

The default `inbox` project starts in `write` mode because it lives inside the bridge-owned workspace. Real code projects should usually start in `read` mode.

Permission modes:

- `read`: can read/search any readable local files and use network access, but cannot write files.
- `write`: can read/search any readable local files and use network access, but can write only inside the active project cwd.
- `fullaccess`: unrestricted local access. Use this only when you intentionally want full local control from WeChat.

`/mode bypass` is kept as a legacy alias for `/mode fullaccess`.

Project/session binding is strict: `/project <name>` does not move one existing Codex thread to a different folder. It changes the active project for that WeChat sender, and each project has its own mobile session and Codex thread. Mode follows that target project's existing session or default, so `fullaccess` from one project does not silently carry into another. Desktop carry-over is the only flow that temporarily attaches the current Desktop thread on top of that per-project mobile session.

If a long-running Codex thread exceeds the model context window, Codex may compact or summarize internally. The bridge continues routing to the same thread id; compaction behavior belongs to Codex itself.

## Project Config

Create a safe local config with a default WeChat-only inbox:

```bash
codex-wechat init
```

This creates:

```text
defaultProject: inbox
cwd: ~/.codex-wechat-handoff/workspaces/inbox
mode: write
```

Add allowed real code projects without hand-editing JSON:

```bash
codex-wechat project add vibelight --cwd /absolute/path/to/vibelight --mode read
codex-wechat doctor
```

Then from WeChat:

```text
/projects
/project vibelight
/status
```

Every `/project <name>` switch tells the user that they are switching to that project's own mobile session and Codex thread. It is not a cwd mutation on the previous thread, and the active mode is restored from that project's session or default.

Or start from the example:

```bash
cp projects.example.json ~/.codex-wechat-handoff/projects.json
```

Example:

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

Keep sender access explicit for public or shared installs. If `allowedSenderIds` is non-empty, only those WeChat senders can trigger Codex.

## Daemon

Install the macOS LaunchAgent:

```bash
codex-wechat daemon install
```

Inspect it:

```bash
codex-wechat daemon status
codex-wechat daemon logs
```

Stop or remove it:

```bash
codex-wechat daemon stop
codex-wechat daemon uninstall
```

The legacy scripts remain thin wrappers:

```bash
scripts/install-launch-agent.sh
scripts/uninstall-launch-agent.sh
```

## Rich Artifacts

Codex can send files and images back through WeChat. Replies can include these markers:

```text
WECHAT_IMAGE: /absolute/path/to/image.png
WECHAT_FILE: /absolute/path/to/report.pdf
WECHAT_VOICE: /absolute/path/to/audio.silk playtime_ms=2000
```

For visual design choices, code diffs, diagrams, or reports, generate HTML first, then render:

```bash
codex-wechat render-html \
  --html /absolute/path/to/report.html \
  --pdf /absolute/path/to/report.pdf \
  --png /absolute/path/to/report.png \
  --renderer auto
```

`--renderer auto` uses Chrome, Chromium, or Edge when available. On macOS without a browser, it falls back to Quick Look PNG output and `sips` image-based PDF output.

Send files directly:

```bash
codex-wechat send-text --to last --message "Progress update."
codex-wechat send-file --file /absolute/path/to/report.pdf --to last --message "Report attached."
codex-wechat send-image --file /absolute/path/to/preview.png --to last --message "Preview attached."
```

## CLI Reference

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
codex-wechat start [--workspace PATH] [--projects PATH]
codex-wechat render-html --html PATH [--pdf PATH] [--png PATH] [--renderer auto|chrome|quicklook]
codex-wechat send-text --message "..." [--to last|SENDER]
codex-wechat send-file --file PATH [--to last|SENDER] [--message "..."]
codex-wechat send-image --file PATH [--to last|SENDER] [--message "..."]
```

Common options:

```text
--state-dir PATH             default: ~/.codex-wechat-handoff
--projects PATH              project route config JSON
--backend app-server|exec    default: app-server
--codex-bin PATH             default: codex
--model MODEL                optional startup-level Codex model default
--codex-timeout-ms N         default: 600000
--dry-run                    generate replies without sending to WeChat
```

## Troubleshooting

Start with:

```bash
codex-wechat doctor
codex-wechat daemon status
codex-wechat daemon logs
```

See [docs/troubleshooting.md](docs/troubleshooting.md).

## Security

Codex WeChat Handoff uses official iLink long polling, not a reversed WeChat protocol. The sensitive parts are local credentials, sender allowlists, project allowlists, and permission mode choices.

See [docs/security-model.md](docs/security-model.md).

## Development

```bash
bun install
bun test codex-wechat-ilink.test.ts
git diff --check
```

The main implementation currently lives in `codex-wechat-ilink.ts` so the install path stays simple. It can be split into modules after the public workflow is stable.
