# Codex WeChat Handoff Installation Guide for AI Agents

You are helping a user install Codex WeChat Handoff.

Core product experience:

1. Carry the current Codex Desktop session to WeChat.
2. Continue the same thread from the phone.
3. Pull the mobile continuation back into Codex Desktop.
4. Then teach project, mode, model, status, and rich artifact commands.

Never ask the user to paste tokens. Never print `account.json`, bot tokens, sender ids, or context tokens.

Ask the user for:

- Project paths to use as mobile routing targets and write roots.
- Whether to keep the default WeChat-only `inbox` project.
- Default mode for each real code project: usually `read`, optionally `write`, rarely `fullaccess`.
- Whether to install the background daemon.
- Whether to install the Codex skill.

Run:

For a fresh install, prefer the one-line onboarding flow:

```bash
curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | bash -s -- --onboard
```

That installs the CLI and skill, then runs `codex-wechat init`, `codex-wechat setup`, `codex-wechat doctor`, `codex-wechat daemon install`, and `codex-wechat daemon status`.

After the one-liner, optionally add allowed real code projects with:

```bash
codex-wechat project add <name> --cwd <absolute-project-path> --mode read
```

Then ask the user to send `/onboarding`, `/projects`, `/project <name>`, and `/status` in WeChat. Run `codex-wechat carry-current --project current --to last` only from an active Codex thread.

First WeChat onboarding message should start with carry-over:

```text
To continue this Desktop Codex session on your phone, tell Codex: carry this to WeChat. When you return, tell Codex: pull WeChat back. CLI fallback: `codex-wechat carry` and `codex-wechat pull`.
```

## Safety Rules

- `codex-wechat init` creates a default WeChat-only `inbox` under `~/.codex-wechat-handoff/workspaces/inbox` in `write` mode. This is safe because it is not a real code repo.
- Keep real code projects in `read` mode unless the user explicitly chooses write access.
- Treat `/mode fullaccess` as dangerous. Explain that it grants unrestricted local access before enabling it. `/mode bypass` remains a legacy alias.
- Keep sender access explicit. Do not configure a public install to respond to every WeChat sender.
- Do not start a second daemon if `codex-wechat daemon status` shows one already running for the same state directory.
- Use `codex-wechat doctor` after setup and after daemon install.
- Explain project/session binding every time it is relevant: `/project <name>` switches to that project's own mobile session and Codex thread; it does not mutate one thread's cwd. Mode is restored from that project's existing session or default. Only carry-over temporarily attaches the current Desktop thread to WeChat.
- Match the user's interaction language when explaining commands. Use Chinese for Chinese onboarding and English for English onboarding.

## Troubleshooting Flow

If the WeChat QR link opens with a network error, tell the user to scan the generated QR image with iOS WeChat instead of opening the link.

If WeChat messages arrive but no reply is sent, run:

```bash
codex-wechat doctor
codex-wechat daemon status
codex-wechat daemon logs
```

If a rich visual result is needed, generate HTML first, then render and send:

```bash
codex-wechat render-html --html /absolute/path/to/report.html --pdf /absolute/path/to/report.pdf --png /absolute/path/to/report.png --renderer auto
codex-wechat send-file --file /absolute/path/to/report.pdf --to last --message "Report attached."
```
