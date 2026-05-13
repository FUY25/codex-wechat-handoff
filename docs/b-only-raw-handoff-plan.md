# B-Only Raw Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace same-thread Desktop carry with forked mobile continuation plus raw transcript handoff in both directions.

**Architecture:** Desktop and WeChat must not write the same live Codex thread through separate app-server processes. `carry-current` forks the Desktop thread into a mobile thread, WeChat writes only the mobile thread, and `pull` returns raw mobile turns to the current Desktop chat through normal command output. `/resume` switches the lease back to WeChat and carries raw Desktop delta into the next mobile turn.

**Tech Stack:** Bun, TypeScript, Codex app-server JSON-RPC, Codex rollout JSONL parsing, iLink WeChat bridge state.

---

## Files

- Modify: `codex-wechat-ilink.ts`
  - Extend route state with `desktopThreadId`, `mobileThreadId`, cursor fields, and pending raw transcript fields.
  - Add app-server `thread/fork` support.
  - Add rollout raw transcript extraction.
  - Change carry/pull/resume routing to B-only semantics.
- Modify: `codex-wechat-ilink.test.ts`
  - Replace same-thread carry tests with forked mobile tests.
  - Add raw transcript tests for user/assistant/tool turns.
  - Add Desktop auto-pause and `/resume` raw-delta tests.
- Create: `docs/b-only-raw-handoff-plan.md`
  - This plan.
- Do not touch in this pass unless a test requires it: `README.md`, `README.en.md`
  - They are already dirty in the working tree and should not be mixed into this implementation.

## Task 1: Lock The B-Only State Model

**Files:**
- Modify: `codex-wechat-ilink.test.ts`
- Modify: `codex-wechat-ilink.ts`

- [ ] **Step 1: Write failing tests for forked carry state**

Add tests asserting that `carryCurrentToWeChat` stores:

```ts
attachedThreadId: "desktop-thread"
mobileThreadId: "mobile-thread"
leaseState: "wechat_active"
parkedThreadId: "old-mobile-thread"
sessionCursor: desktop cursor
mobileStartCursor: mobile cursor
```

Also assert the notification says the phone is continuing from a forked mobile thread and shows project, cwd, mode, permission, and model.

- [ ] **Step 2: Verify red**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "forked"
```

Expected: fail because `mobileThreadId` and `mobileStartCursor` are not implemented.

- [ ] **Step 3: Implement route fields**

Extend `SenderProjectRoute` with:

```ts
mobileThreadId?: string;
mobileStartCursor?: CodexSessionCursor;
lastMobilePullCursor?: CodexSessionCursor;
desktopBaselineCursor?: CodexSessionCursor;
pendingDesktopTranscript?: string | null;
```

Update `carryCurrentToWeChat` to require or accept `mobileThreadId` and `mobileStartCursor`. Keep `attachedThreadId` as the Desktop thread id so Desktop pull can still resolve by current `CODEX_THREAD_ID`.

- [ ] **Step 4: Verify green**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "forked"
```

Expected: pass.

## Task 2: Fork Desktop Thread During Carry

**Files:**
- Modify: `codex-wechat-ilink.test.ts`
- Modify: `codex-wechat-ilink.ts`

- [ ] **Step 1: Write failing tests for app-server fork request shape**

Add a focused unit test for a pure helper that builds `thread/fork` params:

```ts
expect(buildThreadForkParams({
  threadId: "desktop-thread",
  cwd: "/repo",
  mode: "write",
  model: "gpt-5.4",
  projectName: "repo",
})).toMatchObject({
  threadId: "desktop-thread",
  cwd: "/repo",
  approvalPolicy: "never",
  sandbox: "workspace-write",
  model: "gpt-5.4",
  ephemeral: false,
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "fork params"
```

Expected: fail because helper does not exist.

- [ ] **Step 3: Implement fork helper and app-server method**

Add `buildThreadForkParams` and `CodexAppServerClient.forkThread`. `commandCarryCurrent` must:

1. Read Desktop thread id.
2. Start app-server client.
3. Call `thread/fork`.
4. Resolve the new mobile thread cursor.
5. Save B-only route.

If `--backend exec` is selected, fail with a clear error because B-only carry requires app-server fork.

- [ ] **Step 4: Verify green**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "fork params"
```

Expected: pass.

## Task 3: Raw Transcript Extraction

**Files:**
- Modify: `codex-wechat-ilink.test.ts`
- Modify: `codex-wechat-ilink.ts`

- [ ] **Step 1: Write failing tests for raw transcript from JSONL delta**

Create temp rollout JSONL with:

```json
{"type":"session_meta","payload":{"id":"mobile-thread","cwd":"/repo"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"source: WeChat\n...\nUser message:\n修 installer"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"我来改 install.sh"}]}}
{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"bun test\"}","call_id":"call_1"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"pass"}}
```

Assert `buildRawTranscriptFromCodexSession(...)` returns a transcript containing the exact user message, assistant reply, command name/arguments, and output.

- [ ] **Step 2: Verify red**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "raw transcript"
```

Expected: fail because raw transcript helper does not exist.

- [ ] **Step 3: Implement JSONL delta parser**

Parse only `response_item` entries to avoid duplicate `event_msg` user messages. Format:

```text
WeChat raw handoff

desktop thread: D
mobile thread: M
project: P
cwd: C
mode: write
model: gpt-5.4

--- raw mobile turns ---

[timestamp] WeChat user:
...

[timestamp] Codex mobile:
...

[timestamp] Tool call:
exec_command {...}

[timestamp] Tool output:
...
```

Tool output may be truncated in chat, but raw file path support should remain available for a later expansion.

- [ ] **Step 4: Verify green**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "raw transcript"
```

Expected: pass.

## Task 4: Pull Back Raw Mobile Turns

**Files:**
- Modify: `codex-wechat-ilink.test.ts`
- Modify: `codex-wechat-ilink.ts`

- [ ] **Step 1: Write failing tests for `pullCurrentToDesktop` raw output**

Assert pull:

- Refuses active mobile turns.
- Looks up route by Desktop thread id.
- Reads mobile thread delta from `mobileStartCursor` or `lastMobilePullCursor`.
- Returns raw transcript, not event summary.
- Moves lease to `desktop_active`.
- Sets `desktopBaselineCursor` for later `/resume`.
- Updates `lastMobilePullCursor`.

- [ ] **Step 2: Verify red**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "pull-current.*raw|active mobile"
```

Expected: fail.

- [ ] **Step 3: Implement raw pull**

Change `pullCurrentToDesktop` to accept `roots`, build raw transcript from the mobile thread, update cursors, and stop using `buildCarryBackDelta` for the product path.

- [ ] **Step 4: Verify green**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "pull-current.*raw|active mobile"
```

Expected: pass.

## Task 5: WeChat Messages Write Only Mobile Thread

**Files:**
- Modify: `codex-wechat-ilink.test.ts`
- Modify: `codex-wechat-ilink.ts`

- [ ] **Step 1: Write failing tests for active thread selection**

Add a pure helper test:

```ts
expect(resolveWechatTurnThreadId(route, session)).toBe("mobile-thread");
```

When a route exists, WeChat must use `route.mobileThreadId`; when no route exists, it uses the normal sender/project session thread.

- [ ] **Step 2: Verify red**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "WeChat.*mobile thread"
```

Expected: fail.

- [ ] **Step 3: Implement active thread helper**

Replace ordinary WeChat message routing from `route.attachedThreadId` to `route.mobileThreadId`. Store app-server results back into `route.mobileThreadId` and `sender.sessions[projectName]`.

- [ ] **Step 4: Verify green**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "WeChat.*mobile thread"
```

Expected: pass.

## Task 6: Desktop Activity Auto-Pause And Raw `/resume`

**Files:**
- Modify: `codex-wechat-ilink.test.ts`
- Modify: `codex-wechat-ilink.ts`

- [ ] **Step 1: Write failing tests**

Tests:

- Desktop user message after `sessionCursor` pauses route and sets `desktopBaselineCursor`.
- Assistant-only Desktop updates refresh cursor without pausing.
- `/resume` builds pending Desktop raw transcript from `desktopBaselineCursor` to current Desktop cursor.
- The next WeChat turn prepends and clears `pendingDesktopTranscript`.

- [ ] **Step 2: Verify red**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "auto-pauses|resume.*raw|pending Desktop"
```

Expected: fail.

- [ ] **Step 3: Implement raw resume**

Add `resumeRouteToWeChat` and `consumePendingDesktopTranscript`. Special-case `/resume` in the daemon loop so it uses the raw-delta helper instead of the generic command handler. Keep `applyBridgeCommand` as a safe fallback for tests and non-daemon paths.

- [ ] **Step 4: Verify green**

Run:

```bash
bun test codex-wechat-ilink.test.ts --test-name-pattern "auto-pauses|resume.*raw|pending Desktop"
```

Expected: pass.

## Task 7: Full Regression

**Files:**
- Modify: `codex-wechat-ilink.test.ts`
- Modify: `codex-wechat-ilink.ts`
- Optional docs follow-up only if tests require wording fixes.

- [ ] **Step 1: Run all tests**

Run:

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 2: Type/syntax smoke**

Run:

```bash
bun codex-wechat-ilink.ts --help
```

Expected: prints CLI help without syntax errors.

- [ ] **Step 3: CLI dry-run smoke**

Run:

```bash
bun codex-wechat-ilink.ts send-text --state-dir /tmp/codex-wechat-smoke --to last --message "smoke" --dry-run
```

Expected: command exits 0 and prints `dry-run: would send text`.

## Edge Cases Covered

- Existing parked mobile session survives carry and `/detach`.
- Pull refuses while mobile turn is active.
- Desktop user activity auto-pauses mobile lease.
- Assistant-only Desktop activity does not pause mobile.
- WeChat writes to mobile thread, not Desktop thread.
- Pull returns raw transcript, not event-summary.
- `/resume` carries Desktop raw delta back into the next mobile turn.
- Legacy `bypass` mode normalizes to `fullaccess`.
- Missing mobile thread/cursor produces explicit degraded transcript text rather than writing the Desktop thread.

