# Codex WeChat Handoff v0.1.0 Draft Release Notes

## What This Release Ships

- Carry an active Codex Desktop/CLI thread to WeChat with `carry this to WeChat`.
- Continue from WeChat in a forked mobile continuation instead of writing into the live Desktop thread.
- Pull the phone-side raw transcript back to Desktop/CLI with `pull WeChat back`.
- Use normal mobile sessions per WeChat sender + project for inbox work, project reading, reports, and lightweight coding-agent tasks.
- Manage projects, sessions, modes, models, and status from WeChat slash commands.
- Send text, images, PDFs, and generated report files back through WeChat.
- Receive optional Desktop finish-run notifications in WeChat, then decide whether to `/continue` from the phone.
- Guard native carry-over when the source Desktop thread is near the context limit, asking the user to `/compact` instead of silently falling back to a summary.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | bash
```

Manual install:

```bash
curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | bash -s -- --install-only
codex-wechat init
codex-wechat setup
codex-wechat doctor
codex-wechat daemon install
```

## Release Checklist

Before creating the public release tag:

```bash
bun test codex-wechat-ilink.test.ts
git diff --check
curl -fsSL https://raw.githubusercontent.com/FUY25/codex-wechat-handoff/main/install.sh | bash -s -- --install-only
```

After the demo assets are final and the release smoke is current:

```bash
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 --title "Codex WeChat Handoff v0.1.0" --notes-file RELEASE_NOTES.md
```

## Known Limitations

- macOS LaunchAgent is the only fully validated daemon path today.
- WeChat iLink setup is currently tested against the iOS WeChat QR flow.
- This is a personal local bridge, not a team bot/control plane.
- `read` / `write` modes are not read sandboxes: they constrain writes, not all reads.
- `write` mode can still read/search locally readable files and use the network, but it writes only inside the active project cwd.
- If a Desktop thread is near the context limit, native carry-over asks you to run `/compact` in Desktop/CLI first. It does not silently summary-fallback.
- iLink is an external protocol surface; if WeChat behavior changes, the bridge may need an update.
