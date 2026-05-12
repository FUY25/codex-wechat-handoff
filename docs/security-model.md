# Security Model

Codex WeChat Handoff is a local bridge between personal WeChat iLink and Codex. It is designed for a single user controlling local coding agents from trusted devices.

## iLink Transport

The bridge uses official iLink HTTP APIs and long polling. It does not reverse engineer WeChat client protocols, and it does not require a public callback server.

The local daemon:

1. Polls iLink for new messages.
2. Routes allowed messages to Codex.
3. Sends replies back through iLink.

## Token Storage

`codex-wechat setup` stores local credentials in the selected state directory. By default:

```text
~/.codex-wechat-handoff/account.json
```

The CLI makes a best-effort `0600` permission change. Never paste, publish, commit, or screenshot credential files.

## Sender Allowlist

Project config supports `allowedSenderIds`.

When non-empty, only those WeChat senders can trigger Codex. Public and shared installs should keep this explicit.

## Project Allowlist

Configured projects are the routing targets and write roots:

```json
{
  "projects": {
    "my-project": {
      "cwd": "/absolute/path/to/my-project",
      "defaultMode": "read"
    }
  }
}
```

Do not point a project at a broad home directory unless you intend to make that directory writable in `write` mode. The project allowlist is not a hard read boundary: `read` and `write` modes can read/search any readable local files.

## Permission Modes

`/mode read` can read/search any readable local files and use network access, but cannot write files.

`/mode write` can read/search any readable local files and use network access, but can write only inside the active project cwd.

`/mode fullaccess` maps to unrestricted local access. Treat this like letting the WeChat sender operate your local terminal through Codex.

`/mode bypass` remains a legacy alias for `/mode fullaccess`.

## Fullaccess Mode Warning

Use `/mode fullaccess` only when:

- The sender is trusted.
- The project is trusted.
- You understand the task may run local commands with broad access.

Return to read mode after the task:

```text
/mode read
```

## Local Daemon Logs

Daemon logs live under:

```text
<state-dir>/logs/
```

Logs may include project paths, sender identifiers, error messages, and short message previews. Treat them as private.

## No Token Sharing

Do not open public issues containing:

- iLink credentials
- `account.json`
- context token cache files
- sender ids
- daemon logs with private paths or message text

Redact sensitive values before sharing diagnostics.
