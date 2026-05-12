import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  acquireBridgeLock,
  applyBridgeCommand,
  appendBridgeEvent,
  buildInboundUserMessageText,
  buildBridgeHealthReport,
  buildCarryBackDelta,
  parseAesKey,
  buildWechatTurnInput,
  cacheContextToken,
  carryCurrentToWeChat,
  chunkTextForWechat,
  clearContextTokenCache,
  createBridgeState,
  discoverCodexSessionsByCwd,
  drainDeferredRouteQueue,
  enqueueDeferredRouteMessage,
  extractAgentMessageTextFromAppServerItem,
  formatBridgeError,
  getOrdinaryWechatMessageDisposition,
  isIlinkSessionTimeout,
  loadProjectRegistry,
  loadContextTokenCache,
  parseReplyMediaDirectives,
  parseBridgeCommand,
  pullCurrentToDesktop,
  readBridgeEvents,
  readCurrentCodexThreadId,
  recoverFinalReplyFromCodexJsonl,
  recoverFinalReplyFromCodexSessionLogs,
  resolveProactiveContextToken,
  resolveCachedContextToken,
  resolveProjectName,
  resolveTargetSender,
  sandboxForMode,
  tryClaimInboundMessage,
} from "./codex-wechat-ilink";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wechat-to-codex-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const projects = loadProjectRegistry({
  workspace: "/tmp/default-workspace",
  projectsConfig: {
    defaultProject: "vibelight",
    projects: {
      vibelight: {
        cwd: "/Users/fuyuming/Desktop/project/vibelight",
        defaultMode: "read",
        model: "gpt-5.4-mini",
      },
      marklab: {
        cwd: "/Users/fuyuming/Desktop/markdown_ai_collab_milkdown_spec",
        defaultMode: "write",
      },
    },
  },
});

describe("bridge command parser", () => {
  test("parses slash commands and treats regular text as a user message", () => {
    expect(parseBridgeCommand("/project vibelight")).toEqual({ type: "project", project: "vibelight" });
    expect(parseBridgeCommand("/mode bypass")).toEqual({ type: "mode", mode: "bypass" });
    expect(parseBridgeCommand("/model gpt-5.2")).toEqual({ type: "model", model: "gpt-5.2" });
    expect(parseBridgeCommand("/model default")).toEqual({ type: "model", model: null });
    expect(parseBridgeCommand("/model")).toEqual({ type: "modelStatus" });
    expect(parseBridgeCommand("/new")).toEqual({ type: "new" });
    expect(parseBridgeCommand("/status")).toEqual({ type: "status" });
    expect(parseBridgeCommand("帮我看一下 README")).toEqual({ type: "message", text: "帮我看一下 README" });
  });

  test("rejects unknown commands and unsupported modes", () => {
    expect(parseBridgeCommand("/mode god")).toEqual({
      type: "error",
      message: "Unknown mode: god. Use read, write, or bypass.",
    });
    expect(parseBridgeCommand("/deploy")).toEqual({
      type: "error",
      message: "Unknown command: /deploy",
    });
    expect(parseBridgeCommand("/model gpt 5")).toEqual({
      type: "error",
      message: "Model names cannot contain spaces. Use /model default to clear the override.",
    });
  });
});

describe("bridge state commands", () => {
  test("stores active project and mode per sender", () => {
    const state = createBridgeState();
    const projectResult = applyBridgeCommand(state, projects, "sender-a", { type: "project", project: "marklab" });
    const modeResult = applyBridgeCommand(state, projects, "sender-a", { type: "mode", mode: "bypass" });

    expect(projectResult.reply).toContain("project: marklab");
    expect(modeResult.reply).toContain("mode: bypass");
    expect(state.senders["sender-a"].activeProject).toBe("marklab");
    expect(state.senders["sender-a"].activeMode).toBe("bypass");
  });

  test("stores model overrides per sender and active project", () => {
    const state = createBridgeState();

    const defaultStatus = applyBridgeCommand(state, projects, "sender-a", { type: "modelStatus" });
    expect(defaultStatus.reply).toContain("model: gpt-5.4-mini");

    const modelResult = applyBridgeCommand(state, projects, "sender-a", { type: "model", model: "gpt-5.2" });
    expect(modelResult.reply).toContain("model: gpt-5.2");
    expect(state.senders["sender-a"].projectModels?.vibelight).toBe("gpt-5.2");

    applyBridgeCommand(state, projects, "sender-a", { type: "project", project: "marklab" });
    expect(state.senders["sender-a"].projectModels?.marklab).toBeUndefined();

    const resetResult = applyBridgeCommand(state, projects, "sender-a", { type: "model", model: null });
    expect(resetResult.reply).toContain("model: default");
    expect(state.senders["sender-a"].projectModels?.marklab).toBeUndefined();
    expect(state.senders["sender-a"].projectModels?.vibelight).toBe("gpt-5.2");
  });

  test("status uses default project before sender has chosen one", () => {
    const state = createBridgeState();
    const result = applyBridgeCommand(state, projects, "sender-a", { type: "status" });

    expect(result.reply).toContain("project: vibelight");
    expect(result.reply).toContain("mode: read");
    expect(result.reply).toContain("model: gpt-5.4-mini");
    expect(result.reply).toContain("thread: none");
    expect(result.reply).toContain("/Users/fuyuming/Desktop/project/vibelight");
  });

  test("new clears only the current project thread", () => {
    const state = createBridgeState();
    state.senders["sender-a"] = {
      activeProject: "vibelight",
      activeMode: "write",
      sessions: {
        vibelight: {
          threadId: "thread-vibelight",
          cwd: "/Users/fuyuming/Desktop/project/vibelight",
          mode: "write",
        },
        marklab: {
          threadId: "thread-marklab",
          cwd: "/Users/fuyuming/Desktop/markdown_ai_collab_milkdown_spec",
          mode: "read",
        },
      },
    };

    const result = applyBridgeCommand(state, projects, "sender-a", { type: "new" });

    expect(result.reply).toContain("new session requested");
    expect(state.senders["sender-a"].sessions.vibelight).toBeUndefined();
    expect(state.senders["sender-a"].sessions.marklab.threadId).toBe("thread-marklab");
  });
});

describe("app-server request helpers", () => {
  test("maps bridge modes to app-server sandbox policies", () => {
    expect(sandboxForMode("read", "/repo")).toEqual({ type: "readOnly", networkAccess: false });
    expect(sandboxForMode("write", "/repo")).toEqual({
      type: "workspaceWrite",
      networkAccess: false,
      writableRoots: ["/repo"],
    });
    expect(sandboxForMode("bypass", "/repo")).toEqual({ type: "dangerFullAccess" });
  });

  test("wraps WeChat text with project and sender context", () => {
    const input = buildWechatTurnInput({
      senderId: "sender-a",
      projectName: "vibelight",
      mode: "write",
      text: "修一下 README",
    });

    expect(input).toContain("source: WeChat");
    expect(input).toContain("sender_id: sender-a");
    expect(input).toContain("project: vibelight");
    expect(input).toContain("mode: write");
    expect(input).toContain("修一下 README");
  });

  test("adds saved inbound media paths to the turn input", () => {
    const input = buildWechatTurnInput({
      senderId: "sender-a",
      projectName: "vibelight",
      mode: "write",
      text: "看下这张图",
      mediaFiles: [
        {
          kind: "image",
          path: "/tmp/wechat-media/image-1.png",
          bytes: 123,
        },
        {
          kind: "voice",
          path: "/tmp/wechat-media/voice-1.silk",
          bytes: 456,
          transcript: "这是语音转文字",
          playtimeMs: 1800,
        },
      ],
    });

    expect(input).toContain("看下这张图");
    expect(input).toContain("Incoming WeChat media");
    expect(input).toContain("image: /tmp/wechat-media/image-1.png");
    expect(input).toContain("voice: /tmp/wechat-media/voice-1.silk");
    expect(input).toContain("transcript: 这是语音转文字");
  });
});

describe("media helpers", () => {
  test("builds a user message from text, images, and voice transcripts", () => {
    const text = buildInboundUserMessageText({
      messageText: "帮我看这个",
      mediaFiles: [
        {
          kind: "image",
          path: "/tmp/inbound/photo.jpg",
          bytes: 100,
        },
        {
          kind: "voice",
          path: "/tmp/inbound/audio.silk",
          bytes: 200,
          transcript: "语音内容",
        },
      ],
    });

    expect(text).toContain("帮我看这个");
    expect(text).toContain("image: /tmp/inbound/photo.jpg");
    expect(text).toContain("voice: /tmp/inbound/audio.silk");
    expect(text).toContain("transcript: 语音内容");
  });

  test("parses explicit WeChat media directives from replies", () => {
    const result = parseReplyMediaDirectives(
      [
        "可以，图在下面。",
        "WECHAT_IMAGE: /tmp/out/result.png",
        "WECHAT_VOICE: /tmp/out/reply.silk playtime_ms=2300",
      ].join("\n"),
    );

    expect(result.text).toBe("可以，图在下面。");
    expect(result.media).toEqual([
      { kind: "image", path: "/tmp/out/result.png" },
      { kind: "voice", path: "/tmp/out/reply.silk", playtimeMs: 2300 },
    ]);
  });

  test("parses local markdown image paths as image directives", () => {
    const result = parseReplyMediaDirectives("生成好了：![preview](/tmp/out/preview.webp)");

    expect(result.text).toBe("生成好了：");
    expect(result.media).toEqual([{ kind: "image", path: "/tmp/out/preview.webp" }]);
  });

  test("parses AES keys encoded as raw bytes or hex text", () => {
    const raw = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const hexText = Buffer.from("00112233445566778899aabbccddeeff", "utf-8");

    expect(parseAesKey(raw.toString("base64")).toString("hex")).toBe("00112233445566778899aabbccddeeff");
    expect(parseAesKey(hexText.toString("base64")).toString("hex")).toBe("00112233445566778899aabbccddeeff");
  });
});

describe("error formatting", () => {
  test("turn timeouts become a WeChat-visible status message", () => {
    expect(formatBridgeError(new Error("app-server turn timed out after 600000ms"), 600_000)).toContain("超过 600 秒");
  });
});

describe("stage 0 reliability foundation", () => {
  test("persists the latest context token per sender", () =>
    withTempDir((dir) => {
      cacheContextToken(dir, "sender-a", "ctx-1");
      cacheContextToken(dir, "sender-b", "ctx-2");
      cacheContextToken(dir, "sender-a", "ctx-3");

      expect(loadContextTokenCache(dir)).toEqual({
        "sender-a": "ctx-3",
        "sender-b": "ctx-2",
      });
      expect(resolveCachedContextToken(dir, "sender-a")).toBe("ctx-3");

      clearContextTokenCache(dir);
      expect(loadContextTokenCache(dir)).toEqual({});
    }));

  test("resolves proactive sends through cache or explicit empty-context fallback", () =>
    withTempDir((dir) => {
      expect(resolveProactiveContextToken(dir, "sender-a")).toEqual({ contextToken: null, source: "missing" });
      expect(resolveProactiveContextToken(dir, "sender-a", { allowEmptyFallback: true })).toEqual({
        contextToken: "",
        source: "empty_fallback",
      });

      cacheContextToken(dir, "sender-a", "ctx");
      expect(resolveProactiveContextToken(dir, "sender-a", { allowEmptyFallback: true })).toEqual({
        contextToken: "ctx",
        source: "cache",
      });
    }));

  test("claims inbound messages once and allows stale claims to be retried", () =>
    withTempDir((dir) => {
      expect(tryClaimInboundMessage(dir, "message-key", { nowMs: 1_000, ttlMs: 10_000 })).toBe(true);
      expect(tryClaimInboundMessage(dir, "message-key", { nowMs: 2_000, ttlMs: 10_000 })).toBe(false);
      expect(tryClaimInboundMessage(dir, "message-key", { nowMs: 12_001, ttlMs: 10_000 })).toBe(true);
    }));

  test("detects iLink session timeout responses", () => {
    expect(isIlinkSessionTimeout({ errcode: -14, errmsg: "session timeout" })).toBe(true);
    expect(isIlinkSessionTimeout({ ret: 0, errmsg: "ok" })).toBe(false);
  });

  test("writes structured bridge events as jsonl", () =>
    withTempDir((dir) => {
      appendBridgeEvent(dir, { type: "daemon_started", data: { pid: 123 } }, { now: "2026-05-12T12:00:00.000Z" });
      appendBridgeEvent(dir, { type: "poll_success", data: { count: 2 } }, { now: "2026-05-12T12:00:01.000Z" });

      expect(readBridgeEvents(dir)).toEqual([
        { type: "daemon_started", at: "2026-05-12T12:00:00.000Z", data: { pid: 123 } },
        { type: "poll_success", at: "2026-05-12T12:00:01.000Z", data: { count: 2 } },
      ]);
    }));

  test("bridge lock refuses a live owner and recovers a stale owner", () =>
    withTempDir((dir) => {
      const first = acquireBridgeLock(dir, {
        pid: 111,
        command: "start",
        nowMs: 1_000,
        isPidAlive: () => true,
      });
      expect(first.acquired).toBe(true);

      const second = acquireBridgeLock(dir, {
        pid: 222,
        command: "start",
        nowMs: 2_000,
        heartbeatStaleMs: 60_000,
        isPidAlive: () => true,
      });
      expect(second.acquired).toBe(false);
      expect(second.owner?.pid).toBe(111);

      const recovered = acquireBridgeLock(dir, {
        pid: 333,
        command: "start",
        nowMs: 70_001,
        heartbeatStaleMs: 60_000,
        isPidAlive: () => true,
      });
      expect(recovered.acquired).toBe(true);
      expect(recovered.owner?.pid).toBe(333);
    }));

  test("chunks long WeChat text without dropping content", () => {
    const chunks = chunkTextForWechat(["hello world", "second paragraph", "tail"].join("\n\n"), 18);

    expect(chunks.every((chunk) => chunk.length <= 18)).toBe(true);
    expect(chunks.join("")).toBe("hello world\n\nsecond paragraph\n\ntail");
  });

  test("parses health command and formats health report", () => {
    expect(parseBridgeCommand("/health")).toEqual({ type: "health" });

    const report = buildBridgeHealthReport({
      daemonStartedAt: "2026-05-12T12:00:00.000Z",
      now: "2026-05-12T12:01:30.000Z",
      stateDir: "/tmp/state",
      appServerStatus: "running",
      activeTurn: false,
      contextTokenCached: true,
      syncBufPresent: true,
      lockOwner: { pid: 123, startedAt: "2026-05-12T12:00:00.000Z", heartbeatAt: "2026-05-12T12:01:00.000Z" },
      lastPollAt: "2026-05-12T12:01:20.000Z",
      lastMessageAt: "2026-05-12T12:01:21.000Z",
      lastError: null,
    });

    expect(report).toContain("daemon: alive");
    expect(report).toContain("app_server: running");
    expect(report).toContain("context_token_cached: yes");
    expect(report).toContain("lock_owner_pid: 123");
  });

  test("extracts final assistant text from app-server completed items", () => {
    expect(extractAgentMessageTextFromAppServerItem({ type: "agentMessage", text: "final text" })).toBe("final text");
    expect(
      extractAgentMessageTextFromAppServerItem({
        type: "agentMessage",
        content: [{ type: "output_text", text: "hello" }, { type: "output_text", text: " world" }],
      }),
    ).toBe("hello world");
  });

  test("routes ordinary WeChat messages according to lease and active turn state", () => {
    expect(getOrdinaryWechatMessageDisposition({ leaseState: "wechat_active" })).toEqual({ action: "allow" });
    expect(getOrdinaryWechatMessageDisposition({ leaseState: "desktop_active" })).toEqual({
      action: "block",
      reason: "desktop_active",
    });
    expect(getOrdinaryWechatMessageDisposition({ leaseState: "pending_desktop_pull" })).toEqual({
      action: "block",
      reason: "pending_desktop_pull",
    });
    expect(
      getOrdinaryWechatMessageDisposition({
        leaseState: "wechat_active",
        activeTurn: { turnId: "turn-1", origin: "wechat", startedAt: "2026-05-12T12:00:00.000Z" },
      }),
    ).toEqual({ action: "queue", reason: "active_turn" });
  });

  test("queues and drains deferred route messages in order", () => {
    const route = { leaseState: "wechat_active" as const };

    expect(enqueueDeferredRouteMessage(route, { senderId: "sender-a", text: "first", receivedAt: "t1" })).toBe(1);
    expect(enqueueDeferredRouteMessage(route, { senderId: "sender-a", text: "second", receivedAt: "t2" })).toBe(2);

    expect(drainDeferredRouteQueue(route)).toEqual([
      { senderId: "sender-a", text: "first", receivedAt: "t1" },
      { senderId: "sender-a", text: "second", receivedAt: "t2" },
    ]);
    expect(drainDeferredRouteQueue(route)).toEqual([]);
  });

  test("recovers the latest final reply from Codex jsonl session entries", () =>
    withTempDir((dir) => {
      const jsonl = path.join(dir, "session.jsonl");
      writeFileSync(
        jsonl,
        [
          JSON.stringify({ item: { type: "agentMessage", text: "older reply" } }),
          JSON.stringify({ payload: { item: { type: "agentMessage", content: [{ type: "output_text", text: "latest " }, { text: "reply" }] } } }),
        ].join("\n"),
        "utf-8",
      );

      expect(recoverFinalReplyFromCodexJsonl(jsonl)).toBe("latest reply");
    }));

  test("recovers a final reply for a thread from nested Codex session logs", () =>
    withTempDir((dir) => {
      const nested = path.join(dir, "2026", "05", "12");
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        path.join(nested, "session.jsonl"),
        [
          JSON.stringify({ threadId: "other-thread", item: { type: "agentMessage", text: "wrong" } }),
          JSON.stringify({ threadId: "thread-1", item: { type: "agentMessage", text: "right" } }),
        ].join("\n"),
        "utf-8",
      );

      expect(recoverFinalReplyFromCodexSessionLogs("thread-1", [dir])).toBe("right");
    }));
});

describe("stage 1-6 carry-over plan", () => {
  test("reads the current Desktop Codex thread id from the environment", () => {
    expect(readCurrentCodexThreadId({ CODEX_THREAD_ID: "019e-thread" })).toBe("019e-thread");
    expect(() => readCurrentCodexThreadId({})).toThrow("CODEX_THREAD_ID");
  });

  test("resolves project by explicit name or matching cwd", () => {
    expect(resolveProjectName(projects, { requestedProject: "marklab", cwd: "/tmp/elsewhere" })).toBe("marklab");
    expect(resolveProjectName(projects, { requestedProject: "current", cwd: "/Users/fuyuming/Desktop/project/vibelight/subdir" })).toBe("vibelight");
    expect(() => resolveProjectName(projects, { requestedProject: "missing", cwd: "/tmp" })).toThrow("Unknown project");
  });

  test("discovers Codex sessions by cwd and returns newest first", () =>
    withTempDir((dir) => {
      const oldFile = path.join(dir, "old.jsonl");
      const newFile = path.join(dir, "nested", "new.jsonl");
      mkdirSync(path.dirname(newFile), { recursive: true });
      writeFileSync(
        oldFile,
        [
          JSON.stringify({ type: "session_meta", payload: { id: "thread-old", cwd: "/repo" } }),
          JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old task" }] } }),
        ].join("\n"),
      );
      writeFileSync(
        newFile,
        [
          JSON.stringify({ type: "session_meta", payload: { id: "thread-new", cwd: "/repo" } }),
          JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "new task" }] } }),
        ].join("\n"),
      );

      const sessions = discoverCodexSessionsByCwd("/repo", [dir]);
      expect(sessions.map((session) => session.threadId)).toEqual(["thread-new", "thread-old"]);
      expect(sessions[0].summary).toContain("new task");
    }));

  test("resolves the target sender from explicit id, last seen sender, or cached context token", () =>
    withTempDir((dir) => {
      const state = createBridgeState();
      state.senders["sender-a"] = { sessions: {}, lastSeenAt: "2026-05-12T12:00:00.000Z" };
      state.senders["sender-b"] = { sessions: {}, lastSeenAt: "2026-05-12T12:05:00.000Z" };
      cacheContextToken(dir, "sender-c", "ctx");

      expect(resolveTargetSender(state, dir, "sender-a")).toBe("sender-a");
      expect(resolveTargetSender(state, dir, "last")).toBe("sender-b");
      expect(resolveTargetSender(createBridgeState(), dir, "last")).toBe("sender-c");
    }));

  test("carry-current parks the previous WeChat session and attaches the Desktop thread", () => {
    const state = createBridgeState();
    state.senders["sender-a"] = {
      activeProject: "vibelight",
      activeMode: "write",
      sessions: {
        vibelight: {
          threadId: "wechat-thread",
          cwd: "/Users/fuyuming/Desktop/project/vibelight",
          mode: "write",
        },
      },
    };

    const result = carryCurrentToWeChat(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      now: "2026-05-12T12:00:00.000Z",
    });

    expect(result.notification).toContain("continue from here");
    expect(result.notification).toContain("desktop-thread");
    expect(state.senders["sender-a"].routes?.vibelight).toMatchObject({
      attachedThreadId: "desktop-thread",
      leaseState: "wechat_active",
      parkedThreadId: "wechat-thread",
    });
  });

  test("pull-current moves the lease back to desktop and builds a mobile delta", () => {
    const state = createBridgeState();
    carryCurrentToWeChat(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      now: "2026-05-12T12:00:00.000Z",
    });
    const events = [
      { type: "wechat_message_received", at: "2026-05-12T12:01:00.000Z", data: { senderId: "sender-a", textPreview: "检查 release" } },
      { type: "reply_sent", at: "2026-05-12T12:02:00.000Z", data: { senderId: "sender-a", context: "final_reply" } },
    ];

    const result = pullCurrentToDesktop(state, {
      threadId: "desktop-thread",
      projectName: "vibelight",
      events,
      now: "2026-05-12T12:03:00.000Z",
    });

    expect(result.delta).toContain("检查 release");
    expect(result.notification).toContain("已切回电脑继续");
    expect(state.senders["sender-a"].routes?.vibelight.leaseState).toBe("desktop_active");
  });

  test("parses carry-over and polish commands", () => {
    expect(parseBridgeCommand("/current")).toEqual({ type: "current" });
    expect(parseBridgeCommand("/info")).toEqual({ type: "current" });
    expect(parseBridgeCommand("/sessions")).toEqual({ type: "sessions" });
    expect(parseBridgeCommand("/list")).toEqual({ type: "sessions" });
    expect(parseBridgeCommand("/attach latest")).toEqual({ type: "attach", target: "latest" });
    expect(parseBridgeCommand("/switch 2")).toEqual({ type: "attach", target: "2" });
    expect(parseBridgeCommand("/back")).toEqual({ type: "back" });
    expect(parseBridgeCommand("/resume")).toEqual({ type: "resume" });
    expect(parseBridgeCommand("/detach")).toEqual({ type: "detach" });
    expect(parseBridgeCommand("/clear")).toEqual({ type: "new" });
    expect(parseBridgeCommand("/history 5")).toEqual({ type: "history", count: 5 });
    expect(parseBridgeCommand("/help")).toEqual({ type: "help" });
  });

  test("WeChat commands expose current route, back, resume, detach, and sessions", () => {
    const state = createBridgeState();
    carryCurrentToWeChat(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      now: "2026-05-12T12:00:00.000Z",
    });

    expect(applyBridgeCommand(state, projects, "sender-a", { type: "current" }).reply).toContain("desktop-thread");
    expect(applyBridgeCommand(state, projects, "sender-a", { type: "sessions" }).reply).toContain("desktop-thread");

    const back = applyBridgeCommand(state, projects, "sender-a", { type: "back" });
    expect(back.reply).toContain("已准备切回电脑");
    expect(state.senders["sender-a"].routes?.vibelight.leaseState).toBe("pending_desktop_pull");

    const resume = applyBridgeCommand(state, projects, "sender-a", { type: "resume" });
    expect(resume.reply).toContain("remote mode");
    expect(state.senders["sender-a"].routes?.vibelight.leaseState).toBe("wechat_active");

    const detach = applyBridgeCommand(state, projects, "sender-a", { type: "detach" });
    expect(detach.reply).toContain("已退出 Desktop carry-over");
    expect(state.senders["sender-a"].routes?.vibelight).toBeUndefined();
  });

  test("builds a carry-back delta from event logs", () => {
    const delta = buildCarryBackDelta(
      [
        { type: "wechat_message_received", at: "2026-05-12T12:01:00.000Z", data: { senderId: "sender-a", textPreview: "先查 release" } },
        { type: "turn_completed", at: "2026-05-12T12:02:00.000Z", data: { senderId: "sender-a", threadId: "desktop-thread" } },
        { type: "reply_sent", at: "2026-05-12T12:03:00.000Z", data: { senderId: "sender-a", context: "final_reply" } },
      ],
      { senderId: "sender-a", since: "2026-05-12T12:00:00.000Z" },
    );

    expect(delta).toContain("Mobile continuation");
    expect(delta).toContain("先查 release");
    expect(delta).toContain("turn_completed");
  });
});

describe("cli and skill packaging", () => {
  test("package exposes a codex-wechat bin wrapper", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dir, "package.json"), "utf-8"));

    expect(pkg.bin?.["codex-wechat"]).toBe("./bin/codex-wechat");
  });

  test("repo ships a Codex skill for carry-over commands", () => {
    const skill = readFileSync(path.join(import.meta.dir, "skills", "codex-wechat", "SKILL.md"), "utf-8");

    expect(skill).toContain("name: codex-wechat");
    expect(skill).toContain("codex-wechat carry-current");
    expect(skill).toContain("codex-wechat pull-current");
  });
});
