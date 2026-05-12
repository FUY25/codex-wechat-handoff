# Codex Desktop <-> WeChat Carry-Over Plan

## Core Goal

The core product experience is for someone doing coding work in Codex on a laptop to leave the desk and keep driving the same coding thread from WeChat, then come back to the laptop and continue from Desktop without losing context.

The intended user story is:

```text
I am coding in Codex Desktop.
I need to leave.
I tell Codex: carry this to WeChat.
My phone receives: continue from here.
I keep working from WeChat while away.
When I return, I tell Desktop: pull WeChat back.
Desktop continues from the same work, and WeChat is told that Desktop is active again.
```

This is the main differentiator. cc-connect has strong session listing/switching and external session support, WeClaw has a very simple WeChat command surface, and Nexu has a broader desktop/control-plane direction. The target here is narrower and more native: a deliberate handoff of the current Codex coding thread between Desktop and WeChat.

## Product Model

Carry-over is a transfer of the active entry point for a Codex thread. It is not a new chat by default.

Default behavior:

```text
Desktop thread 019e...
        |
        | carry to WeChat
        v
Same thread 019e..., now controlled from WeChat
        |
        | pull back to Desktop
        v
Same work continues on Desktop
```

The bridge should not fork the session unless the user explicitly asks for a fork later. A fork mode can be added as a separate command, but the first version should preserve a single canonical thread.

When a thread is carried to WeChat, the previous WeChat session for that sender and project is parked, not deleted. `/detach` can return to the previous WeChat-owned session.

## Terms

- `thread_id`: Codex thread UUID, for example `019e...`.
- `surface`: the current user entry point, either `desktop` or `wechat`.
- `lease`: the bridge's record of which surface is allowed to drive a thread.
- `attached thread`: a Codex thread that was created elsewhere, usually Codex Desktop or CLI, and is now bound to a WeChat sender/project route.
- `parked session`: the sender/project's previous WeChat-owned thread, preserved while an attached Desktop thread is active.
- `delta`: the message/turn summary that happened on one surface while the other surface was inactive.

## Current Technical Assumption

Codex Desktop exposes the current thread id to child commands as:

```text
CODEX_THREAD_ID
```

This is the key reason Desktop -> WeChat can be reliable. We should not infer the current chat by "latest session" except as an explicit fallback command.

## Target User Flows

### Flow 1: Desktop To WeChat

User is in Codex Desktop and says:

```text
carry this to WeChat
```

Codex runs:

```bash
bun codex-wechat-ilink.ts carry-current --to last --project current
```

The command:

1. Reads `CODEX_THREAD_ID`.
2. Resolves the current project from cwd or project config.
3. Resolves the target WeChat sender, using the most recent authorized sender unless specified.
4. Parks the sender/project's current WeChat-owned session.
5. Binds sender + project to the current Desktop thread.
6. Marks the lease as `surface=wechat`.
7. Sends a proactive WeChat message:

```text
continue from here

已接到电脑上的 Codex 会话。
project: vibelight
thread: 019e...

直接回复就从这里继续。
回电脑时可以在电脑上说 /wechat pull，或在手机发 /back。
```

### Flow 2: WeChat Continues The Same Thread

User sends ordinary WeChat messages.

If an attached thread is active:

```text
wechat sender + project -> attached thread_id -> Codex resume/turn
```

The bridge appends those turns to the same Codex thread where possible.

The WeChat prompt should include metadata:

```text
Surface: WeChat remote
Project: vibelight
Thread: 019e...
Mode: read/write/fullaccess
```

### Flow 3: Desktop Pulls Back Without Phone First

This should be allowed and should be the main carry-back path.

User returns to laptop and says in Codex Desktop:

```text
/wechat pull
```

or natural language:

```text
把微信上的继续接回来
```

Codex runs:

```bash
bun codex-wechat-ilink.ts pull-current --project current --from last
```

The command:

1. Reads `CODEX_THREAD_ID`.
2. Finds any WeChat route attached to that thread, or the most recent route for the project.
3. Builds a concise delta of what happened on WeChat since the Desktop handoff.
4. Marks the lease as `surface=desktop`.
5. Sends a proactive WeChat message:

```text
已切回电脑继续。
手机这边已暂停 remote mode。

如果还想从手机继续，发 /resume。
如果想回到手机原来的会话，发 /detach。
```

6. Prints the delta into the Desktop command output so the current Codex chat can absorb it:

```text
WeChat continuation since 13:42:
- User asked to inspect release notarization.
- Codex checked scripts/release.sh and found notarization after DMG packaging.
- Current pending task: update release docs.
```

This avoids depending on Codex Desktop UI automatically reloading JSONL changes from outside the app.

### Flow 4: Phone Requests Back First

User can also initiate carry-back from WeChat:

```text
/back
```

The bridge:

1. Marks the lease as `pending_desktop_pull`.
2. Stops sending ordinary WeChat text into the attached thread by default.
3. Replies:

```text
已准备切回电脑。
手机期间有 4 条消息。
最后任务：检查 release notarization。

回到 Codex Desktop 后说：/wechat pull
如果还想继续手机上聊，发 /resume。
```

Then Desktop `/wechat pull` completes the transfer.

### Flow 5: Resume Phone After Pull Or Back

If WeChat is paused because Desktop pulled back or the phone sent `/back`, user can send:

```text
/resume
```

Behavior:

1. If there is a parked attached thread, switch lease back to `surface=wechat`.
2. Send:

```text
已回到手机 remote mode。
直接发消息就继续刚才的 Codex thread。
```

### Flow 6: Return To The Previous WeChat Session

If the user wants to stop using the carried Desktop thread from WeChat:

```text
/detach
```

Behavior:

1. Remove the attached Desktop thread from the active WeChat route.
2. Restore the parked WeChat-owned thread for that sender/project if present.
3. Send:

```text
已退出 Desktop carry-over。
已回到之前的微信会话。
```

If no parked session exists, `/detach` creates or returns to the sender/project default WeChat session.

## State Machine

```text
Desktop active
  | carry-current
  v
WeChat remote active
  | /back
  v
Pending desktop pull
  | Desktop pull-current
  v
Desktop active

WeChat remote active
  | Desktop pull-current
  v
Desktop active

Desktop active or Pending desktop pull
  | /resume
  v
WeChat remote active

WeChat remote active or Pending desktop pull
  | /detach
  v
Previous WeChat session active
```

## Command Surface

### Desktop-Side Commands

These are CLI subcommands callable by Codex Desktop. They can later be wrapped by a native slash command if Codex exposes custom slash registration.

```text
carry-current
  Read CODEX_THREAD_ID and move the current Desktop thread to WeChat.

pull-current
  Pull the latest WeChat continuation for the current thread/project back into Desktop.

carry-status
  Show active leases, attached thread, project, target sender, and pending delta.
```

Example:

```bash
bun codex-wechat-ilink.ts carry-current --project vibelight --to last
bun codex-wechat-ilink.ts pull-current --project vibelight --from last
```

### WeChat-Side Commands

Core carry-over commands:

```text
/current
/sessions
/attach latest
/attach <index>
/attach <thread_id>
/back
/resume
/detach
```

Existing operational commands should stay:

```text
/projects
/project <name>
/mode read|write|fullaccess
/model <name|default>
/status
/new
```

Aliases to borrow from cc-connect and WeClaw:

```text
/list      -> /sessions
/switch    -> /attach
/cwd       -> project path switch or admin-only cwd switch
/info      -> /current
/clear     -> /new
```

## State Schema

Extend `.codex-wechat/sessions.json` from simple sender/project state to route-aware state.

Proposed shape:

```json
{
  "senders": {
    "wechat-user-id": {
      "activeProject": "vibelight",
      "activeMode": "write",
      "sessions": {
        "vibelight": {
          "threadId": "019e-local-wechat-thread",
          "cwd": "/absolute/path/to/project",
          "mode": "write"
        }
      },
      "routes": {
        "vibelight": {
          "activeSurface": "wechat",
          "attachedThreadId": "019e-desktop-thread",
          "attachedFrom": "desktop",
          "attachedAt": "2026-05-12T13:00:00Z",
          "leaseState": "wechat_active",
          "parkedThreadId": "019e-local-wechat-thread",
          "lastDesktopPullAt": null,
          "lastWeChatTurnAt": "2026-05-12T13:12:00Z",
          "pendingDeltaId": null
        }
      }
    }
  },
  "handoffs": {
    "handoff-id": {
      "project": "vibelight",
      "senderId": "wechat-user-id",
      "threadId": "019e-desktop-thread",
      "fromSurface": "wechat",
      "toSurface": "desktop",
      "status": "pending_desktop_pull",
      "createdAt": "2026-05-12T13:20:00Z",
      "summary": "User asked to inspect release notarization.",
      "turnRefs": []
    }
  }
}
```

Implementation can start smaller, but the shape should keep room for parked sessions and pending desktop pulls.

## Thread Ownership Rules

Default: one canonical thread.

Rules:

1. `carry-current` attaches the current `CODEX_THREAD_ID`; it does not fork.
2. While `leaseState=wechat_active`, ordinary WeChat messages go to the attached thread.
3. While `leaseState=desktop_active`, ordinary WeChat messages should not silently write to the same thread. They should reply with a clear status and offer `/resume`.
4. While `leaseState=pending_desktop_pull`, ordinary WeChat messages should ask whether to `/resume` or wait for Desktop.
5. `/detach` restores the parked WeChat thread, if any.
6. A future `/fork` can explicitly create a new WeChat-owned thread from a summary, but it is not part of v1.

This prevents accidental concurrent writes from Desktop and WeChat.

## Carry-Back Delta

`pull-current` should not rely only on Codex session files magically appearing in the Desktop UI.

It should build an explicit compact delta:

```text
Mobile continuation:
- messages since carry-current or last pull
- commands run or files touched, if known
- current TODO / requested next action
- active project/mode/model
```

Sources for the delta:

1. Bridge's own message log for WeChat turns.
2. Codex JSONL transcript for the thread, if available.
3. Last assistant reply sent to WeChat.

For v1, a plain text delta is enough. Later, store structured turn refs.

## Proactive Notifications

Proactive notifications must be built on a cached `context_token`, not on the current inbound message alone.

The bridge should cache the latest valid WeChat `context_token` per sender:

```text
<state-dir>/context_tokens.json
sender_id -> latest_context_token
```

Every inbound message with a `context_token` refreshes this cache. Desktop-side commands such as `carry-current` and `pull-current` use the cached token to proactively notify WeChat. If no cached token exists, try iLink's empty `context_token` fallback for proactive notices. If the service rejects that fallback, the command should not silently fail. It should mark the handoff as created, print the intended notification locally, and tell the user that the target sender must first send any WeChat message to establish a reply context.

Use proactive messages for these events:

```text
Desktop carry-current -> WeChat: continue from here
Desktop pull-current  -> WeChat: continue from desktop
WeChat /back          -> WeChat: ready to pull from Desktop
WeChat /resume        -> WeChat: phone remote mode active again
WeChat /detach        -> WeChat: restored previous WeChat session
```

If proactive send fails, the CLI should print the message locally and mark the handoff as created but notification_failed.

## Borrowed Reliability Mechanisms From CLI-WeChat-Bridge

CLI-WeChat-Bridge should be treated as an engineering reliability reference, not as the product architecture. Keep this project's multi-project daemon and Desktop/WeChat carry-over model, but adopt the following operational mechanisms.

### P0: Context Token Cache

Problem:

```text
Current replies can use the inbound message's context_token, but Desktop-initiated carry-current and pull-current need proactive WeChat sends when there may be no current inbound message.
```

Required behavior:

1. Persist the latest `context_token` for each sender in `<state-dir>/context_tokens.json`.
2. Refresh the cache whenever `getupdates` returns a user message with `context_token`.
3. Use the cached token for all proactive notifications.
4. If no token exists, keep the state transition but mark notification as `missing_context_token` and print the intended message locally.
5. `setup --force` should clear stale context tokens together with stale sync state.

### P0: Inbound Message Claiming

Problem:

```text
sync_buf protects normal long polling, but duplicate daemon instances, LaunchAgent restarts, or repeated iLink deliveries can still cause the same WeChat message to be processed twice.
```

Required behavior:

1. Derive a stable message key from account id, sender id, message/session id when available, timestamp, context token, and text/media fingerprints.
2. Claim each inbound message with an atomic file create:

```text
<state-dir>/message_claims/<sha1(message_key)>.json
```

3. Skip messages whose claim already exists.
4. Give claims a TTL so stale partial claims can be retried after daemon crashes.
5. Cover this with tests because duplicate processing can duplicate code edits.

### P0: Per Route Busy Queue

Problem:

```text
The same Codex thread may be reachable from Desktop and WeChat. Ordinary phone messages must not silently write into a thread that Desktop is actively driving.
```

Required behavior:

1. Track active work per `sender + project + thread_id`.
2. Add route fields for `activeTurn`, `activeTurnOrigin`, `startedAt`, and `deferredQueue`.
3. While `leaseState=desktop_active` or `pending_desktop_pull`, ordinary WeChat messages should not write to the attached thread. Reply with status and offer `/resume`.
4. While a WeChat-driven turn is already active for the same route, queue later ordinary messages or reply with queue position.
5. System commands such as `/status`, `/current`, `/back`, `/resume`, and `/detach` should remain available while a turn is active.
6. Queue draining must be explicit and logged, not hidden.

### P0: iLink Session Timeout Recovery

Problem:

```text
iLink can return errcode=-14 / session timeout. Treating it as a generic polling failure can leave the daemon alive but useless.
```

Required behavior:

1. Detect `errcode=-14` or `session timeout`.
2. If a local sync cursor exists, clear `sync_buf.txt` and retry once.
3. If it still fails, mark bridge health as auth/session failed and require `setup`.
4. On successful setup, clear stale `sync_buf.txt` and stale `context_tokens.json`.
5. Surface this clearly in `/health`.

### P1: Final Reply Recovery

Problem:

```text
The app-server can complete a turn or write to Codex session logs even when the bridge misses the final reply event. From WeChat this looks like silence.
```

Required behavior:

1. Collect final assistant message items in addition to `item/agentMessage/delta`.
2. Treat `turn/completed` with collected final text as a valid final reply.
3. If the turn completes with no collected text, inspect the matching Codex session JSONL when available.
4. If a final reply is recovered, send it to WeChat and log `final_reply_recovered`.
5. If no final reply exists, send a clear error instead of leaving the user waiting.

### P1: Health And Diagnostics

Problem:

```text
When a WeChat message gets no response, the user needs to know whether the failure is iLink polling, auth, sender authorization, Codex app-server, active turn, missing context token, or project config.
```

Required behavior:

Add `/health` and expand `/status` or `/current` with:

```text
daemon: alive
uptime: ...
last_poll: ...
last_message: ...
last_error: ...
app_server: running/stopped/error
active_turn: yes/no
active_thread: ...
project: ...
mode/model: ...
context_token_cached: yes/no
sync_buf_present: yes/no
message_claims_dir: ...
events_log: ...
```

Desktop-side `carry-status` should show the same information where relevant.

### P1: Bridge Lock

Problem:

```text
LaunchAgent plus manual terminal starts can create multiple bridge daemons. Multiple daemons polling the same WeChat bot can race, duplicate work, and corrupt state.
```

Required behavior:

1. Create `<state-dir>/bridge.lock.json` on startup.
2. Store pid, command, state dir, projects file, startedAt, and heartbeat timestamp.
3. If a live bridge already owns the lock, refuse to start unless an explicit `--takeover-stale-lock` style option is provided.
4. If the pid is dead or heartbeat is stale, recover the lock safely.
5. Include lock owner details in `/health`.

### P1: Structured Event Log

Problem:

```text
Carry-back needs a reliable source of what happened on WeChat while Desktop was inactive. Console logs are not enough.
```

Required behavior:

Write append-only JSONL events:

```text
<state-dir>/events.jsonl
```

Minimum event types:

```text
daemon_started
poll_success
poll_error
message_claimed
wechat_message_received
command_received
turn_started
turn_completed
reply_sent
reply_send_failed
carry_attached
lease_changed
desktop_pull_started
desktop_pull_completed
context_token_updated
auth_session_failed
```

`pull-current` should build its v1 delta primarily from this log, with Codex session JSONL as a fallback/enrichment source.

### P1: Output Chunking And Send Context

Problem:

```text
Long Codex replies and mixed text/media replies can fail partially. Without send context, it is hard to tell whether Codex failed, WeChat send failed, or only a media attachment failed.
```

Required behavior:

1. Split long text replies into bounded chunks before sending.
2. Send chunks sequentially and log each chunk's result.
3. Tag every send attempt with context such as `final_reply`, `error_reply`, `carry_notice`, `health_reply`, or `media_warning`.
4. If a media file referenced by `WECHAT_IMAGE` or `WECHAT_VOICE` does not exist, send a text warning and continue with the rest of the reply.
5. Record partial-send failures in `events.jsonl` and `/health`.

## Permission And Mode Integration

Do not mix remote/carry state with permissions.

Separate concepts:

```text
project: cwd / repo
thread: Codex conversation id
surface lease: desktop or wechat
mode: read, write, fullaccess
model: Codex model override
```

`/mode` applies to the next WeChat-driven turn for the active project, whether the active route is a WeChat-owned session or an attached Desktop thread.

Recommended defaults:

1. Desktop carry-current inherits sender/project mode unless the Desktop command provides `--mode`.
2. If no mode exists, default to `read`.
3. `fullaccess` should remain explicit and visible in `/current`.
4. On carry-current, the proactive WeChat message should include current mode.

Example:

```text
已接到电脑上的 Codex 会话。
mode: read
要允许改代码，发 /mode write。
```

## Borrowed Mechanisms To Implement After The Core

### From cc-connect

Most relevant:

```text
/list and /switch session management
external Codex session discovery from ~/.codex/sessions by cwd
session_key style route identity
Bridge/management API shape for external clients
idle rotation / stale context protection
agent session id inspection
```

Adopt first:

```text
/sessions
/attach as /switch alias
cwd-filtered Codex session discovery
session summaries and numeric indices
```

Adopt later:

```text
HTTP management API
cron/heartbeat routing
rich permission cards where platform supports them
idle rotation policies
```

### From WeClaw

Most relevant:

```text
simple WeChat command UX
/agent and /agent message routing
/cwd /path
/new or /clear
/info
proactive send command
media handling conventions
LaunchAgent-style always-on daemon
```

Adopt first:

```text
/info alias
/clear alias
simple help text
proactive send reliability improvements
```

### From Nexu

Most relevant:

```text
desktop app/control-plane thinking
local-first daemon model
remote gateway as a managed runtime concept
session/runtime diagnostics
```

Adopt later:

```text
small local status UI
diagnostic export
runtime health page
remote gateway only if local bridge becomes multi-machine
```

## Implementation Stages

### Stage 0: Reliability Foundation

This stage should land before carry-over changes. It reduces the chance that Desktop/WeChat handoff bugs are actually duplicate daemon, stale iLink state, missing context token, or lost final-reply bugs.

Tasks:

1. Add `<state-dir>/context_tokens.json` and refresh it from every inbound message with `context_token`.
2. Route proactive notifications through the cached context token and mark `missing_context_token` when unavailable.
3. Add atomic inbound message claims under `<state-dir>/message_claims/`.
4. Detect iLink `errcode=-14` / `session timeout`, clear sync cursor once, retry, then surface auth/session failure.
5. Clear stale `sync_buf.txt` and `context_tokens.json` after successful setup.
6. Add `<state-dir>/bridge.lock.json` with pid/heartbeat and refuse duplicate live daemons.
7. Add `<state-dir>/events.jsonl` with the minimum event types listed above.
8. Add `/health` and include daemon, iLink, app-server, context-token, lock, active-turn, and last-error state.
9. Add final reply collection from final assistant message items, not only deltas.
10. Add long-output chunking and per-send context tags.
11. Add tests for token cache, message claims, timeout recovery, lock behavior, event logging, and output chunking.

Deliverable:

```text
/health shows the real failure layer.
Duplicate bridge instances are refused.
Repeated iLink messages are claimed once.
Desktop-initiated proactive notices can use cached context tokens.
```

### Stage 1: State And Discovery

Tasks:

1. Add Codex session discovery by cwd from `~/.codex/sessions`.
2. Add `CODEX_THREAD_ID` reader for Desktop-side commands.
3. Extend session state with route/lease fields.
4. Add tests for state transitions.

Deliverable:

```text
bun codex-wechat-ilink.ts carry-status
bun codex-wechat-ilink.ts discover-sessions --project vibelight
```

### Stage 2: Desktop -> WeChat

Tasks:

1. Implement `carry-current`.
2. Resolve project by cwd or `--project`.
3. Resolve sender by `--to`, `last`, or configured default.
4. Park previous WeChat session.
5. Attach `CODEX_THREAD_ID`.
6. Proactively send `continue from here`.
7. Add tests for missing `CODEX_THREAD_ID`, missing sender, and notification failure.

Deliverable:

```text
bun codex-wechat-ilink.ts carry-current --project vibelight --to last
```

### Stage 3: WeChat Attached Thread Runtime

Tasks:

1. Route ordinary WeChat messages to attached thread when lease is `wechat_active`.
2. Show attached state in `/current` and `/status`.
3. Add `/detach` and `/resume`.
4. Prevent silent writes when lease is `desktop_active` or `pending_desktop_pull`.
5. Track `activeTurn`, `activeTurnOrigin`, and a per-route deferred queue.
6. Keep system commands available while a route has an active turn.
7. Drain queued ordinary messages only when the route is idle and log the drain.
8. Add tests for command behavior, lease blocking, active-turn blocking, and queue draining.

Deliverable:

```text
Desktop carry-current -> WeChat reply -> same thread resumes.
```

### Stage 4: Carry Back To Desktop

Tasks:

1. Track WeChat turns while an attached thread is active.
2. Implement `/back`.
3. Implement `pull-current`.
4. Build a compact delta from `events.jsonl`, bridge state, and Codex JSONL fallback when available.
5. On desktop pull, set lease to `desktop_active`.
6. Proactively notify WeChat: continue from desktop.
7. Add tests for pull with and without phone `/back`.

Deliverable:

```text
bun codex-wechat-ilink.ts pull-current --project vibelight --from last
```

### Stage 5: Session UX Polish

Tasks:

1. Implement `/sessions`.
2. Implement `/attach latest|<index>|<thread_id>`.
3. Add `/list` and `/switch` aliases.
4. Add summary, cwd, mtime, and active marker.
5. Add `/help` update.

Deliverable:

```text
/sessions
/attach 1
/switch 019e
```

### Stage 6: Borrowed Operational Commands

Tasks:

1. Add `/info` alias for `/current`.
2. Add `/clear` alias for `/new`.
3. Add `/history [n]`.
4. Add `/stop` if app-server turn cancellation can be handled cleanly.
5. Add better `/mode`, `/model`, `/reasoning` status display.
6. Include `/health` in help output and document how to diagnose no-response failures.

Deliverable:

```text
WeChat feels like a compact coding-agent control surface, but carry-over remains the main feature.
```

## Open Questions

1. Should ordinary WeChat messages during `desktop_active` always be blocked, or should there be a timeout after which WeChat can auto-resume?
2. Should `carry-current` default to the last sender, or require an explicit configured default sender?
3. Should `/detach` restore the exact previous WeChat thread or create a fresh one if the previous one is old?
4. Should `pull-current` print only a delta, or also run a Codex turn that summarizes the phone work?
5. Should a future `/fork` exist for cases where the user wants phone work to branch away from Desktop?

## V1 Definition Of Done

V1 is done when this works end to end:

```text
1. User works in Codex Desktop.
2. User says carry this to WeChat.
3. WeChat proactively receives continue from here.
4. User sends a WeChat message.
5. Bridge continues the current CODEX_THREAD_ID, not a new guessed latest session.
6. User returns to Desktop and says /wechat pull.
7. Desktop receives a useful delta of the phone work.
8. WeChat is proactively told that Desktop is active again.
9. /resume can move control back to phone.
10. /detach restores the previous WeChat session.
```
