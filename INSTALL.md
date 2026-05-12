# Codex WeChat Handoff Installation Guide for AI Agents

You are helping a user install Codex WeChat Handoff.

Core product experience:

1. Carry the current Codex Desktop session to WeChat.
2. Continue the same thread from the phone.
3. Pull the mobile continuation back into Codex Desktop.
4. Then teach project, mode, model, status, and rich artifact commands.

Never ask the user to paste tokens. Never print `account.json`, bot tokens, sender ids, or context tokens.

Ask the user for:

- Project paths to expose.
- Default project name.
- Default mode: `read`, `write`, or `bypass`.
- Whether to install the background daemon.
- Whether to install the Codex skill.

Run:

1. `codex-wechat init --project <name> --cwd <absolute-project-path>`
2. Add any additional allowed projects with `codex-wechat project add <name> --cwd <absolute-project-path> --mode read`
3. `codex-wechat setup`
4. `codex-wechat doctor`
5. `codex-wechat daemon install`
6. `codex-wechat carry-current --project current --to last` only from an active Codex thread
7. Ask the user to send `/projects`, `/project <name>`, and `/status` in WeChat

First WeChat onboarding message should start with carry-over:

```text
To continue this Desktop Codex session on your phone, tell Codex: carry this to WeChat. When you return, tell Codex: pull WeChat back. CLI fallback: `codex-wechat carry` and `codex-wechat pull`.
```

## Safety Rules

- Keep the default project mode as `read` unless the user explicitly chooses write access.
- Treat `/mode bypass` as dangerous. Explain that it grants local full access before enabling it.
- Keep sender access explicit. Do not configure a public install to respond to every WeChat sender.
- Do not start a second daemon if `codex-wechat daemon status` shows one already running for the same state directory.
- Use `codex-wechat doctor` after setup and after daemon install.
- Explain that `/project <name>` switches to that project's own mobile session and Codex thread; it does not mutate one thread's cwd.
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
