import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  acquireBridgeLock,
  applyBridgeCommand,
  applyBridgeCommandToFreshState,
  appendBridgeEvent,
  buildInboundUserMessageText,
  buildBridgeHealthReport,
  buildBlockedOrdinaryWechatReply,
  buildCarryBackDelta,
  buildFileMessageItem,
  buildIntroMessage,
  buildLaunchAgentPlist,
  buildNativeHandoffContextBlockedMessage,
  describeLaunchAgentDaemonStatus,
  buildOnboardingMessage,
  buildFinishRunNotification,
  buildRawTranscriptFromCodexSession,
  buildThreadForkParams,
  chooseHtmlRenderer,
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
  isFinishNotificationEnabled,
  isIlinkSessionTimeout,
  findCodexSessionCursorByThread,
  formatCodexContextPressureLine,
  loadProjectRegistry,
  loadContextTokenCache,
  parseReplyMediaDirectives,
  parseBridgeCommand,
  pauseWechatRoutesForDesktopActivity,
  pullCurrentToDesktop,
  readBridgeEvents,
  readCodexContextPressure,
  readCurrentCodexThreadId,
  recoverFinalReplyFromCodexJsonl,
  recoverFinalReplyFromCodexSessionLogs,
  recordFinishRunOffer,
  resolveProactiveContextToken,
  resolveCachedContextToken,
  resolveFinishNotificationStatus,
  resolveProjectName,
  resolveTargetSender,
  resolveWechatTurnThreadId,
  resumeRouteToWeChat,
  refreshPendingMobileTranscriptForRoute,
  sandboxForMode,
  setFinishNotificationDefault,
  setFinishNotificationEnabled,
  continueFinishRunOfferToWeChat,
  consumePendingDesktopTranscript,
  shouldBlockNativeHandoffForContext,
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
        cwd: "/workspace/vibelight",
        defaultMode: "read",
        model: "gpt-5.4-mini",
      },
      marklab: {
        cwd: "/workspace/marklab",
        defaultMode: "write",
      },
    },
  },
});

describe("bridge command parser", () => {
  test("parses slash commands and treats regular text as a user message", () => {
    expect(parseBridgeCommand("/project vibelight")).toEqual({ type: "project", project: "vibelight" });
    expect(parseBridgeCommand("/mode fullaccess")).toEqual({ type: "mode", mode: "fullaccess" });
    expect(parseBridgeCommand("/mode bypass")).toEqual({ type: "mode", mode: "fullaccess" });
    expect(parseBridgeCommand("/model bypass")).toEqual({
      type: "error",
      message: "bypass is a permission mode. Use /mode fullaccess, not /model bypass.",
    });
    expect(parseBridgeCommand("/model fullaccess")).toEqual({
      type: "error",
      message: "fullaccess is a permission mode. Use /mode fullaccess, not /model fullaccess.",
    });
    expect(parseBridgeCommand("/model gpt-5.2")).toEqual({ type: "model", model: "gpt-5.2" });
    expect(parseBridgeCommand("/model default")).toEqual({ type: "model", model: null });
    expect(parseBridgeCommand("/model")).toEqual({ type: "modelStatus" });
    expect(parseBridgeCommand("/new")).toEqual({ type: "new" });
    expect(parseBridgeCommand("/status")).toEqual({ type: "status" });
    expect(parseBridgeCommand("/onboarding")).toEqual({ type: "onboarding" });
    expect(parseBridgeCommand("/intro")).toEqual({ type: "intro" });
    expect(parseBridgeCommand("/notify on")).toEqual({ type: "notify", action: "on" });
    expect(parseBridgeCommand("/notify off")).toEqual({ type: "notify", action: "off" });
    expect(parseBridgeCommand("/notify")).toEqual({ type: "notify", action: "status" });
    expect(parseBridgeCommand("/continue")).toEqual({ type: "continue" });
    expect(parseBridgeCommand("回电脑继续")).toEqual({ type: "back" });
    expect(parseBridgeCommand("继续手机 remote")).toEqual({ type: "resume" });
    expect(parseBridgeCommand("从手机继续")).toEqual({ type: "continue" });
    expect(parseBridgeCommand("退出 carry-over")).toEqual({ type: "detach" });
    expect(parseBridgeCommand("帮我看一下 README")).toEqual({ type: "message", text: "帮我看一下 README" });
  });

  test("rejects unknown commands and unsupported modes", () => {
    expect(parseBridgeCommand("/mode god")).toEqual({
      type: "error",
      message: "Unknown mode: god. Use read, write, or fullaccess.",
    });
    expect(parseBridgeCommand("/deploy")).toEqual({
      type: "error",
      message: "Unknown command: /deploy",
    });
    expect(parseBridgeCommand("/onboardinv")).toEqual({
      type: "error",
      message: "Unknown command: /onboardinv. Did you mean /onboarding?",
    });
    expect(parseBridgeCommand("/model gpt 5")).toEqual({
      type: "error",
      message: "Model names cannot contain spaces. Use /model default to clear the override.",
    });
    expect(parseBridgeCommand("/notify maybe")).toEqual({
      type: "error",
      message: "Usage: /notify on|off|status",
    });
  });
});

describe("bridge state commands", () => {
  test("stores active project and mode per sender", () => {
    const state = createBridgeState();
    const projectResult = applyBridgeCommand(state, projects, "sender-a", { type: "project", project: "marklab" });
    const modeResult = applyBridgeCommand(state, projects, "sender-a", { type: "mode", mode: "fullaccess" });

    expect(projectResult.reply).toContain("project: marklab");
    expect(projectResult.reply).toContain("project/session binding");
    expect(projectResult.reply).toContain("switching projects switches to that project's own mobile session and Codex thread");
    expect(projectResult.reply).toContain("does not change the cwd of the current thread");
    expect(modeResult.reply).toContain("mode: fullaccess");
    expect(state.senders["sender-a"].activeProject).toBe("marklab");
    expect(state.senders["sender-a"].activeMode).toBe("fullaccess");
  });

  test("project switching resets mode to that project's session or default", () => {
    const state = createBridgeState();
    state.senders["sender-a"] = {
      activeProject: "vibelight",
      activeMode: "bypass",
      sessions: {
        marklab: {
          threadId: "thread-marklab",
          cwd: "/workspace/marklab",
          mode: "write",
        },
      },
    };

    const existingSession = applyBridgeCommand(state, projects, "sender-a", { type: "project", project: "marklab" });
    expect(existingSession.reply).toContain("mode: write");
    expect(state.senders["sender-a"].activeMode).toBe("write");

    const defaultProject = applyBridgeCommand(state, projects, "sender-a", { type: "project", project: "vibelight" });
    expect(defaultProject.reply).toContain("mode: read");
    expect(state.senders["sender-a"].activeMode).toBe("read");
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

  test("WeChat notify command is read-only and Desktop controls toggles", () => {
    const state = createBridgeState();
    carryCurrentToWeChat(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      mobileThreadId: "mobile-thread",
    });
    setFinishNotificationEnabled(state, "sender-a", true, "desktop-thread");

    const on = applyBridgeCommand(state, projects, "sender-a", { type: "notify", action: "on" });
    expect(on.reply).toContain("只能在 Desktop thread 里开关");
    expect(state.senders["sender-a"].threadFinishNotifications?.["desktop-thread"]?.enabled).toBe(true);

    const status = applyBridgeCommand(state, projects, "sender-a", { type: "notify", action: "status" });
    expect(status.reply).toContain("finish-run 微信提醒：on");
    expect(status.reply).toContain("thread: desktop-thread");
    expect(status.reply).toContain("source: thread");
    expect(status.reply).toContain("pending_continue: no");

    const off = applyBridgeCommand(state, projects, "sender-a", { type: "notify", action: "off" });
    expect(off.reply).toContain("只能在 Desktop thread 里开关");
    expect(state.senders["sender-a"].threadFinishNotifications?.["desktop-thread"]?.enabled).toBe(true);
  });

  test("finish-run notification toggles use thread override before global default", () => {
    const state = createBridgeState();

    setFinishNotificationDefault(state, "sender-a", true);
    setFinishNotificationEnabled(state, "sender-a", true, "thread-a");
    setFinishNotificationEnabled(state, "sender-a", false, "thread-b");

    expect(isFinishNotificationEnabled(state, "sender-a", "thread-a")).toBe(true);
    expect(isFinishNotificationEnabled(state, "sender-a", "thread-b")).toBe(false);
    expect(isFinishNotificationEnabled(state, "sender-a", "thread-c")).toBe(true);
    expect(resolveFinishNotificationStatus(state, "sender-a", "thread-c")).toMatchObject({
      enabled: true,
      source: "default",
      globalDefault: true,
    });
    setFinishNotificationEnabled(state, "sender-a", null, "thread-b");
    expect(resolveFinishNotificationStatus(state, "sender-a", "thread-b")).toMatchObject({
      enabled: true,
      source: "default",
      threadOverride: undefined,
    });
  });

  test("status uses default project before sender has chosen one", () => {
    const state = createBridgeState();
    const result = applyBridgeCommand(state, projects, "sender-a", { type: "status" });

    expect(result.reply).toContain("project: vibelight");
    expect(result.reply).toContain("mode: read");
    expect(result.reply).toContain("model: gpt-5.4-mini");
    expect(result.reply).toContain("thread: none");
    expect(result.reply).toContain("/workspace/vibelight");
  });

  test("status includes Codex context pressure when available", () => {
    const state = createBridgeState();
    state.senders["sender-a"] = {
      sessions: {
        vibelight: {
          threadId: "thread-vibelight",
          cwd: "/workspace/vibelight",
          mode: "read",
        },
      },
    };

    const result = applyBridgeCommand(
      state,
      projects,
      "sender-a",
      { type: "status" },
      {
        contextPressure: {
          threadId: "thread-vibelight",
          status: "high",
          reason: "context_usage",
          usedTokens: 90_000,
          contextWindow: 100_000,
          percent: 90,
        },
      },
    );

    expect(result.reply).toContain("context: high (90%, 90k/100k)");
    expect(result.reply).toContain("thread: thread-vibelight");
  });

  test("new clears only the current project thread", () => {
    const state = createBridgeState();
    state.senders["sender-a"] = {
      activeProject: "vibelight",
      activeMode: "write",
      sessions: {
        vibelight: {
          threadId: "thread-vibelight",
          cwd: "/workspace/vibelight",
          mode: "write",
        },
        marklab: {
          threadId: "thread-marklab",
          cwd: "/workspace/marklab",
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
  test("maps bridge modes to app-server sandbox policies with network enabled for read and write", () => {
    expect(sandboxForMode("read", "/repo")).toEqual({ type: "readOnly", networkAccess: true });
    expect(sandboxForMode("write", "/repo")).toEqual({
      type: "workspaceWrite",
      networkAccess: true,
      writableRoots: ["/repo"],
    });
    expect(sandboxForMode("fullaccess", "/repo")).toEqual({ type: "dangerFullAccess" });
  });

  test("builds app-server thread/fork params for B-only mobile continuation", () => {
    expect(
      buildThreadForkParams({
        threadId: "desktop-thread",
        cwd: "/repo",
        mode: "write",
        model: "gpt-5.4",
        projectName: "repo",
      }),
    ).toMatchObject({
      threadId: "desktop-thread",
      cwd: "/repo",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      model: "gpt-5.4",
      ephemeral: false,
      developerInstructions: expect.stringContaining("Active project: repo"),
    });
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

describe("Codex context pressure", () => {
  test("detects saturated context from Codex rollout token_count and blocks native handoff", () =>
    withTempDir((dir) => {
      const file = path.join(dir, "desktop.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "session_meta", payload: { id: "desktop-thread", cwd: "/repo" } }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "token_count",
              info: {
                model_context_window: 258_400,
                total_token_usage: { total_tokens: 258_400 },
                last_token_usage: { total_tokens: 0 },
              },
            },
          }),
          JSON.stringify({
            type: "response_item",
            payload: {
              type: "task_complete",
              last_agent_message: null,
            },
          }),
        ].join("\n") + "\n",
      );

      const pressure = readCodexContextPressure("desktop-thread", [dir]);

      expect(pressure.status).toBe("saturated");
      expect(pressure.usedTokens).toBe(258_400);
      expect(pressure.contextWindow).toBe(258_400);
      expect(shouldBlockNativeHandoffForContext(pressure)).toBe(true);
      expect(formatCodexContextPressureLine(pressure)).toContain("context: saturated (100%, 258k/258k)");
      expect(buildNativeHandoffContextBlockedMessage(pressure)).toContain("/compact");
      expect(buildNativeHandoffContextBlockedMessage(pressure)).toContain("carry");
    }));

  test("reports unknown context when no token_count is present", () =>
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, "desktop.jsonl"),
        JSON.stringify({ type: "session_meta", payload: { id: "desktop-thread", cwd: "/repo" } }) + "\n",
      );

      const pressure = readCodexContextPressure("desktop-thread", [dir]);

      expect(pressure.status).toBe("unknown");
      expect(pressure.reason).toBe("no_token_usage");
      expect(shouldBlockNativeHandoffForContext(pressure)).toBe(false);
      expect(formatCodexContextPressureLine(pressure)).toContain("context: unknown");
    }));

  test("carry notification includes context pressure", () => {
    const state = createBridgeState();
    const result = carryCurrentToWeChat(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      mobileThreadId: "mobile-thread",
      contextPressure: {
        threadId: "desktop-thread",
        status: "ok",
        reason: "context_usage",
        usedTokens: 22_000,
        contextWindow: 200_000,
        percent: 11,
      },
    });

    expect(result.notification).toContain("context: ok (11%, 22k/200k)");
    expect(result.notification).toContain("project: vibelight | mode: read | model: gpt-5.4-mini");
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
        "WECHAT_FILE: /tmp/out/report.pdf",
      ].join("\n"),
    );

    expect(result.text).toBe("可以，图在下面。");
    expect(result.media).toEqual([
      { kind: "image", path: "/tmp/out/result.png" },
      { kind: "voice", path: "/tmp/out/reply.silk", playtimeMs: 2300 },
      { kind: "file", path: "/tmp/out/report.pdf" },
    ]);
  });

  test("builds iLink file message items for uploaded PDFs", () => {
    const item = buildFileMessageItem({
      uploaded: {
        filekey: "file-key",
        downloadEncryptedQueryParam: "download-param",
        aeskey: "00112233445566778899aabbccddeeff",
        fileSize: 12345,
        fileSizeCiphertext: 12352,
        fileMd5: "9d2a7b9c3e2f1d41c7d5b3a1a7e1c6f0",
      },
      filePath: "/tmp/out/设计 diff report.pdf",
    });

    expect(item).toEqual({
      type: 4,
      file_item: {
        media: {
          encrypt_query_param: "download-param",
          aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
          encrypt_type: 1,
        },
        file_name: "设计 diff report.pdf",
        md5: "9d2a7b9c3e2f1d41c7d5b3a1a7e1c6f0",
        len: "12345",
      },
    });
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
    expect(buildBlockedOrdinaryWechatReply("desktop_active")).toContain("/detach");
    expect(buildBlockedOrdinaryWechatReply("desktop_active", { needsReconcile: true })).toContain("pull WeChat back");
    expect(buildBlockedOrdinaryWechatReply("desktop_active", { needsReconcile: true })).toContain("/detach");
    expect(buildBlockedOrdinaryWechatReply("pending_desktop_pull")).toContain("/detach");
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

  test("WeChat ordinary turns use the forked mobile thread instead of the Desktop thread", () => {
    expect(
      resolveWechatTurnThreadId(
        {
          attachedThreadId: "desktop-thread",
          mobileThreadId: "mobile-thread",
          leaseState: "wechat_active",
        },
        { threadId: "normal-session", cwd: "/repo", mode: "write" },
      ),
    ).toBe("mobile-thread");

    expect(resolveWechatTurnThreadId(undefined, { threadId: "normal-session", cwd: "/repo", mode: "write" })).toBe("normal-session");
    expect(resolveWechatTurnThreadId({ attachedThreadId: "legacy-desktop", leaseState: "wechat_active" }, undefined)).toBeUndefined();
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

  test("builds a raw handoff transcript from Codex response_item deltas", () =>
    withTempDir((dir) => {
      const jsonl = path.join(dir, "mobile.jsonl");
      const baseline = [
        JSON.stringify({ type: "session_meta", payload: { id: "mobile-thread", cwd: "/repo" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "baseline before carry" }] } }),
      ].join("\n") + "\n";
      writeFileSync(jsonl, baseline, "utf-8");
      const cursor = { threadId: "mobile-thread", file: jsonl, size: Buffer.byteLength(baseline), mtimeMs: 1 };
      writeFileSync(
        jsonl,
        baseline +
          [
            JSON.stringify({
              timestamp: "2026-05-12T12:01:00.000Z",
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "source: WeChat\nsender_id: sender-a\nproject: vibelight\nmode: write\n\nUser message:\n修 installer onboarding",
                  },
                ],
              },
            }),
            JSON.stringify({
              timestamp: "2026-05-12T12:01:10.000Z",
              type: "event_msg",
              payload: { type: "user_message", message: "duplicate event should not appear" },
            }),
            JSON.stringify({
              timestamp: "2026-05-12T12:01:20.000Z",
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "我来改 install.sh" }],
              },
            }),
            JSON.stringify({
              timestamp: "2026-05-12T12:01:30.000Z",
              type: "response_item",
              payload: {
                type: "function_call",
                name: "exec_command",
                arguments: "{\"cmd\":\"bun test\"}",
                call_id: "call_1",
              },
            }),
            JSON.stringify({
              timestamp: "2026-05-12T12:01:40.000Z",
              type: "response_item",
              payload: {
                type: "function_call_output",
                call_id: "call_1",
                output: "63 pass\n0 fail",
              },
            }),
          ].join("\n") +
          "\n",
        "utf-8",
      );

      const transcript = buildRawTranscriptFromCodexSession({
        threadId: "mobile-thread",
        cursor,
        roots: [dir],
        title: "WeChat raw handoff",
        direction: "mobile_to_desktop",
        projectName: "vibelight",
        cwd: "/workspace/vibelight",
        mode: "write",
        model: "gpt-5.4-mini",
        desktopThreadId: "desktop-thread",
        mobileThreadId: "mobile-thread",
      });

      expect(transcript).toContain("WeChat raw handoff");
      expect(transcript).toContain("desktop thread: desktop-thread");
      expect(transcript).toContain("mobile thread: mobile-thread");
      expect(transcript).toContain("project: vibelight");
      expect(transcript).toContain("mode: write");
      expect(transcript).toContain("model: gpt-5.4-mini");
      expect(transcript).toContain("WeChat user");
      expect(transcript).toContain("修 installer onboarding");
      expect(transcript).toContain("Codex mobile");
      expect(transcript).toContain("我来改 install.sh");
      expect(transcript).toContain("Tool call");
      expect(transcript).toContain("exec_command");
      expect(transcript).toContain("\"cmd\":\"bun test\"");
      expect(transcript).toContain("Tool output");
      expect(transcript).toContain("63 pass");
      expect(transcript).not.toContain("duplicate event should not appear");
      expect(transcript).not.toContain("baseline before carry");
    }));

  test("pull transcript strips bridge-injected desktop context from resumed WeChat turns", () =>
    withTempDir((dir) => {
      const sessionFile = path.join(dir, "mobile.jsonl");
      const baseline = [
        JSON.stringify({ type: "session_meta", payload: { id: "mobile-thread", cwd: "/workspace/vibelight" } }),
      ].join("\n") + "\n";
      const cursor = {
        threadId: "mobile-thread",
        file: sessionFile,
        size: Buffer.byteLength(baseline),
        mtimeMs: 1,
      };
      writeFileSync(
        sessionFile,
        baseline +
          [
            JSON.stringify({
              timestamp: "2026-05-12T12:01:00.000Z",
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: [
                      "Desktop handoff context since phone paused:",
                      "Desktop raw handoff",
                      "desktop-only implementation detail",
                      "",
                      "New WeChat message:",
                      "你好啊 你是哪个thread",
                    ].join("\n"),
                  },
                ],
              },
            }),
            JSON.stringify({
              timestamp: "2026-05-12T12:01:20.000Z",
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "我是 mobile thread" }],
              },
            }),
          ].join("\n") +
          "\n",
        "utf-8",
      );

      const transcript = buildRawTranscriptFromCodexSession({
        threadId: "mobile-thread",
        cursor,
        roots: [dir],
        title: "WeChat raw handoff",
        direction: "mobile_to_desktop",
        projectName: "vibelight",
        cwd: "/workspace/vibelight",
        mode: "write",
        model: "gpt-5.4-mini",
        desktopThreadId: "desktop-thread",
        mobileThreadId: "mobile-thread",
      });

      expect(transcript).toContain("WeChat user");
      expect(transcript).toContain("你好啊 你是哪个thread");
      expect(transcript).toContain("我是 mobile thread");
      expect(transcript).not.toContain("Desktop handoff context since phone paused");
      expect(transcript).not.toContain("desktop-only implementation detail");
      expect(transcript).not.toContain("New WeChat message:");
    }));
});

describe("stage 1-6 carry-over plan", () => {
  test("reads the current Desktop Codex thread id from the environment", () => {
    expect(readCurrentCodexThreadId({ CODEX_THREAD_ID: "019e-thread" })).toBe("019e-thread");
    expect(() => readCurrentCodexThreadId({})).toThrow("CODEX_THREAD_ID");
  });

  test("resolves project by explicit name or matching cwd", () => {
    expect(resolveProjectName(projects, { requestedProject: "marklab", cwd: "/tmp/elsewhere" })).toBe("marklab");
    expect(resolveProjectName(projects, { requestedProject: "current", cwd: "/workspace/vibelight/subdir" })).toBe("vibelight");
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

  test("uses the first session_meta as the owner for forked Codex session logs", () =>
    withTempDir((dir) => {
      const desktopFile = path.join(dir, "desktop.jsonl");
      const mobileFile = path.join(dir, "mobile.jsonl");
      writeFileSync(
        desktopFile,
        [
          JSON.stringify({ type: "session_meta", payload: { id: "desktop-thread", cwd: "/desktop" } }),
          JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "desktop task" }] } }),
        ].join("\n") + "\n",
      );
      writeFileSync(
        mobileFile,
        [
          JSON.stringify({ type: "session_meta", payload: { id: "mobile-thread", forked_from_id: "desktop-thread", cwd: "/mobile" } }),
          JSON.stringify({ type: "session_meta", payload: { id: "desktop-thread", cwd: "/desktop" } }),
          JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "mobile task" }] } }),
        ].join("\n") + "\n",
      );

      const desktopCursor = findCodexSessionCursorByThread("desktop-thread", [dir]);
      const mobileCursor = findCodexSessionCursorByThread("mobile-thread", [dir]);
      const mobileSessions = discoverCodexSessionsByCwd("/mobile", [dir]);

      expect(desktopCursor?.file).toBe(desktopFile);
      expect(mobileCursor?.file).toBe(mobileFile);
      expect(mobileSessions.map((session) => session.threadId)).toEqual(["mobile-thread"]);
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

  test("carry-current parks the previous WeChat session and binds a forked mobile thread", () => {
    const state = createBridgeState();
    state.senders["sender-a"] = {
      activeProject: "vibelight",
      activeMode: "write",
      sessions: {
        vibelight: {
          threadId: "old-mobile-thread",
          cwd: "/workspace/vibelight",
          mode: "write",
        },
      },
    };

    const result = carryCurrentToWeChat(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      mobileThreadId: "mobile-thread",
      now: "2026-05-12T12:00:00.000Z",
      sessionCursor: {
        threadId: "desktop-thread",
        file: "/tmp/desktop-thread.jsonl",
        size: 100,
        mtimeMs: 1_000,
      },
      mobileStartCursor: {
        threadId: "mobile-thread",
        file: "/tmp/mobile-thread.jsonl",
        size: 80,
        mtimeMs: 900,
      },
    });

    expect(result.notification).toContain("continue from here");
    expect(result.notification).toContain("手机已接管这个 Codex thread");
    expect(result.notification).toContain("project: vibelight | mode: write | model: gpt-5.4-mini");
    expect(result.notification).toContain("mode: write");
    expect(result.notification).toContain("model: gpt-5.4-mini");
    expect(result.notification).toContain("直接回复继续");
    expect(result.notification).toContain("pull WeChat back");
    expect(result.notification).toContain("/resume");
    expect(result.notification).toContain("/detach");
    expect(result.notification.length).toBeLessThan(260);
    expect(state.senders["sender-a"].routes?.vibelight).toMatchObject({
      attachedThreadId: "desktop-thread",
      mobileThreadId: "mobile-thread",
      leaseState: "wechat_active",
      parkedThreadId: "old-mobile-thread",
      sessionCursor: {
        threadId: "desktop-thread",
        file: "/tmp/desktop-thread.jsonl",
        size: 100,
        mtimeMs: 1_000,
      },
      mobileStartCursor: {
        threadId: "mobile-thread",
        file: "/tmp/mobile-thread.jsonl",
        size: 80,
        mtimeMs: 900,
      },
    });
    expect(state.senders["sender-a"].sessions.vibelight.threadId).toBe("mobile-thread");
  });

  test("mobile turns cache pending raw transcript without writing the Desktop thread", () =>
    withTempDir((dir) => {
      const mobileFile = path.join(dir, "mobile.jsonl");
      const baseline = [
        JSON.stringify({ type: "session_meta", payload: { id: "mobile-thread", cwd: "/workspace/vibelight" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "before phone" }] } }),
      ].join("\n") + "\n";
      writeFileSync(mobileFile, baseline, "utf-8");
      const mobileStartCursor = {
        threadId: "mobile-thread",
        file: mobileFile,
        size: Buffer.byteLength(baseline),
        mtimeMs: 1,
      };
      writeFileSync(
        mobileFile,
        baseline +
          [
            JSON.stringify({
              timestamp: "2026-05-12T12:01:00.000Z",
              type: "response_item",
              payload: { type: "message", role: "user", content: [{ type: "input_text", text: "User message:\n手机检查 release" }] },
            }),
            JSON.stringify({
              timestamp: "2026-05-12T12:02:00.000Z",
              type: "response_item",
              payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "手机检查完成" }] },
            }),
          ].join("\n") +
          "\n",
        "utf-8",
      );

      const state = createBridgeState();
      carryCurrentToWeChat(state, projects, {
        senderId: "sender-a",
        projectName: "vibelight",
        threadId: "desktop-thread",
        mobileThreadId: "mobile-thread",
        mobileStartCursor,
        now: "2026-05-12T12:00:00.000Z",
      });

      const transcript = refreshPendingMobileTranscriptForRoute(state, projects, "sender-a", "vibelight", { roots: [dir] });
      const route = state.senders["sender-a"].routes!.vibelight;
      expect(transcript).toContain("Pending WeChat raw transcript");
      expect(transcript).toContain("手机检查 release");
      expect(transcript).toContain("手机检查完成");
      expect(route.pendingMobileTranscript).toContain("手机检查 release");
      expect(route.pendingMobileTranscriptCursor?.threadId).toBe("mobile-thread");
      expect(route.attachedThreadId).toBe("desktop-thread");
    }));

  test("desktop session activity auto-pauses an active WeChat carry route", () =>
    withTempDir((dir) => {
      const sessionFile = path.join(dir, "session.jsonl");
      writeFileSync(
        sessionFile,
        [
          JSON.stringify({ type: "session_meta", payload: { id: "desktop-thread", cwd: "/workspace/vibelight" } }),
          JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "carry baseline" }] } }),
        ].join("\n") + "\n",
        "utf-8",
      );
      const cursor = findCodexSessionCursorByThread("desktop-thread", [dir]);
      expect(cursor?.threadId).toBe("desktop-thread");

      const state = createBridgeState();
      carryCurrentToWeChat(state, projects, {
        senderId: "sender-a",
        projectName: "vibelight",
        threadId: "desktop-thread",
        now: "2026-05-12T12:00:00.000Z",
        sessionCursor: cursor ?? undefined,
      });

      writeFileSync(
        sessionFile,
        readFileSync(sessionFile, "utf-8") +
          JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "desktop continued" }] } }) +
          "\n",
        "utf-8",
      );

      const pauses = pauseWechatRoutesForDesktopActivity(state, {
        roots: [dir],
        now: "2026-05-12T12:05:00.000Z",
      });

      expect(pauses).toHaveLength(1);
      expect(pauses[0].notification).toContain("检测到电脑端已经继续");
      expect(pauses[0].notification).toContain("/resume");
      expect(pauses[0].notification).toContain("/detach");
      expect(state.senders["sender-a"].routes?.vibelight).toMatchObject({
        leaseState: "desktop_active",
        activeSurface: "desktop",
        desktopActivityDetectedAt: "2026-05-12T12:05:00.000Z",
        desktopBaselineCursor: cursor,
      });
      expect(getOrdinaryWechatMessageDisposition(state.senders["sender-a"].routes!.vibelight).action).toBe("block");
    }));

  test("desktop activity with pending mobile transcript marks reconcile warning", () =>
    withTempDir((dir) => {
      const sessionFile = path.join(dir, "desktop.jsonl");
      writeFileSync(
        sessionFile,
        [
          JSON.stringify({ type: "session_meta", payload: { id: "desktop-thread", cwd: "/workspace/vibelight" } }),
          JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "carry baseline" }] } }),
        ].join("\n") + "\n",
        "utf-8",
      );
      const cursor = findCodexSessionCursorByThread("desktop-thread", [dir]);
      const state = createBridgeState();
      carryCurrentToWeChat(state, projects, {
        senderId: "sender-a",
        projectName: "vibelight",
        threadId: "desktop-thread",
        now: "2026-05-12T12:00:00.000Z",
        sessionCursor: cursor ?? undefined,
      });
      state.senders["sender-a"].routes!.vibelight.pendingMobileTranscript = "Pending WeChat raw transcript\n\n[time] WeChat user:\n手机改了 README";

      writeFileSync(
        sessionFile,
        readFileSync(sessionFile, "utf-8") +
          JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "desktop continued without pull" }] } }) +
          "\n",
        "utf-8",
      );

      const pauses = pauseWechatRoutesForDesktopActivity(state, {
        roots: [dir],
        now: "2026-05-12T12:06:00.000Z",
      });

      expect(pauses[0].notification).toContain("这轮 Desktop 可能没有手机上下文");
      expect(pauses[0].notification).toContain("pull WeChat back 做 reconcile");
      expect(state.senders["sender-a"].routes!.vibelight.needsReconcile).toBe(true);
    }));

  test("assistant-only desktop session activity refreshes cursor without pausing WeChat", () =>
    withTempDir((dir) => {
      const sessionFile = path.join(dir, "session.jsonl");
      writeFileSync(
        sessionFile,
        [
          JSON.stringify({ type: "session_meta", payload: { id: "desktop-thread", cwd: "/workspace/vibelight" } }),
          JSON.stringify({ payload: { type: "message", role: "user", content: [{ type: "input_text", text: "carry baseline" }] } }),
        ].join("\n") + "\n",
        "utf-8",
      );
      const cursor = findCodexSessionCursorByThread("desktop-thread", [dir]);
      const state = createBridgeState();
      carryCurrentToWeChat(state, projects, {
        senderId: "sender-a",
        projectName: "vibelight",
        threadId: "desktop-thread",
        now: "2026-05-12T12:00:00.000Z",
        sessionCursor: cursor ?? undefined,
      });

      writeFileSync(
        sessionFile,
        readFileSync(sessionFile, "utf-8") +
          JSON.stringify({ payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "carry complete" }] } }) +
          "\n",
        "utf-8",
      );

      const updatedCursor = findCodexSessionCursorByThread("desktop-thread", [dir]);
      const pauses = pauseWechatRoutesForDesktopActivity(state, {
        roots: [dir],
        now: "2026-05-12T12:05:00.000Z",
      });

      expect(pauses).toHaveLength(0);
      expect(state.senders["sender-a"].routes?.vibelight.leaseState).toBe("wechat_active");
      expect(state.senders["sender-a"].routes?.vibelight.sessionCursor?.size).toBe(updatedCursor?.size);
    }));

  test("carry and pull normalize legacy bypass state to fullaccess", () => {
    const state = createBridgeState();
    state.senders["sender-a"] = {
      activeProject: "vibelight",
      activeMode: "bypass",
      sessions: {},
    };

    const carry = carryCurrentToWeChat(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      now: "2026-05-12T12:00:00.000Z",
    });

    expect(carry.notification).toContain("mode: fullaccess");

    const pull = pullCurrentToDesktop(state, {
      threadId: "desktop-thread",
      projectName: "vibelight",
      events: [],
      projects,
      now: "2026-05-12T12:01:00.000Z",
    });

    expect(pull.notification).toContain("mode: fullaccess");
  });

  test("pull-current moves the lease back to desktop and returns raw mobile transcript", () =>
    withTempDir((dir) => {
      const mobileFile = path.join(dir, "mobile.jsonl");
      const baseline = [
        JSON.stringify({ type: "session_meta", payload: { id: "mobile-thread", cwd: "/workspace/vibelight" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "pre carry" }] } }),
      ].join("\n") + "\n";
      writeFileSync(mobileFile, baseline, "utf-8");
      const mobileStartCursor = {
        threadId: "mobile-thread",
        file: mobileFile,
        size: Buffer.byteLength(baseline),
        mtimeMs: 1,
      };
      writeFileSync(
        mobileFile,
        baseline +
          [
            JSON.stringify({
              timestamp: "2026-05-12T12:01:00.000Z",
              type: "response_item",
              payload: { type: "message", role: "user", content: [{ type: "input_text", text: "User message:\n检查 release" }] },
            }),
            JSON.stringify({
              timestamp: "2026-05-12T12:02:00.000Z",
              type: "response_item",
              payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "release 检查完成" }] },
            }),
          ].join("\n") +
          "\n",
        "utf-8",
      );

      const state = createBridgeState();
      carryCurrentToWeChat(state, projects, {
        senderId: "sender-a",
        projectName: "vibelight",
        threadId: "desktop-thread",
        mobileThreadId: "mobile-thread",
        mobileStartCursor,
        now: "2026-05-12T12:00:00.000Z",
      });

      const result = pullCurrentToDesktop(state, {
        threadId: "desktop-thread",
        projectName: "vibelight",
        events: [],
        projects,
        roots: [dir],
        now: "2026-05-12T12:03:00.000Z",
      });

      expect(result.delta).toContain("WeChat raw handoff");
      expect(result.delta).toContain("desktop thread: desktop-thread");
      expect(result.delta).toContain("mobile thread: mobile-thread");
      expect(result.delta).toContain("检查 release");
      expect(result.delta).toContain("release 检查完成");
      expect(result.delta).not.toContain("pre carry");
      expect(result.notification).toContain("已切回电脑继续");
      expect(result.notification).toContain("project: vibelight");
      expect(result.notification).toContain("mode: read");
      expect(result.notification).toContain("model: gpt-5.4-mini");
      expect(state.senders["sender-a"].routes?.vibelight.leaseState).toBe("desktop_active");
      expect(state.senders["sender-a"].routes?.vibelight.desktopBaselineCursor?.threadId).toBe("desktop-thread");
      expect(state.senders["sender-a"].routes?.vibelight.lastMobilePullCursor?.threadId).toBe("mobile-thread");
    }));

  test("pull-current CLI dry-run does not persist lease or event mutations", () =>
    withTempDir((dir) => {
      const stateDir = path.join(dir, "state");
      mkdirSync(stateDir, { recursive: true });
      const projectsFile = path.join(stateDir, "projects.json");
      writeFileSync(
        projectsFile,
        JSON.stringify({
          defaultProject: "vibelight",
          projects: {
            vibelight: {
              cwd: "/workspace/vibelight",
              defaultMode: "read",
            },
          },
        }),
        "utf-8",
      );

      const state = createBridgeState();
      carryCurrentToWeChat(state, projects, {
        senderId: "sender-a",
        projectName: "vibelight",
        threadId: "desktop-thread",
        mobileThreadId: "mobile-thread",
        now: "2026-05-12T12:00:00.000Z",
      });
      const stateFile = path.join(stateDir, "sessions.json");
      writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
      const beforeState = readFileSync(stateFile, "utf-8");
      const eventsFile = path.join(stateDir, "events.jsonl");

      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "pull-current",
          "--state-dir",
          stateDir,
          "--projects",
          projectsFile,
          "--project",
          "vibelight",
          "--thread-id",
          "desktop-thread",
          "--dry-run",
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("dry-run: would pull current route");
      expect(result.stdout.toString()).toContain("WeChat raw handoff");
      expect(readFileSync(stateFile, "utf-8")).toBe(beforeState);
      expect(existsSync(eventsFile)).toBe(false);
    }));

  test("pull-current refuses to pull while a WeChat turn is still active", () => {
    const state = createBridgeState();
    carryCurrentToWeChat(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      now: "2026-05-12T12:00:00.000Z",
    });
    const route = state.senders["sender-a"].routes!.vibelight;
    route.activeTurn = { turnId: "active", origin: "wechat", startedAt: "2026-05-12T12:01:00.000Z" };

    expect(() =>
      pullCurrentToDesktop(state, {
        threadId: "desktop-thread",
        projectName: "vibelight",
        events: [],
        projects,
        now: "2026-05-12T12:02:00.000Z",
      }),
    ).toThrow("WeChat turn is still running");
    expect(state.senders["sender-a"].routes?.vibelight.leaseState).toBe("wechat_active");
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

  test("resume to WeChat stores raw Desktop delta for the next mobile turn", () =>
    withTempDir((dir) => {
      const desktopFile = path.join(dir, "desktop.jsonl");
      const baseline = [
        JSON.stringify({ type: "session_meta", payload: { id: "desktop-thread", cwd: "/workspace/vibelight" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "before carry" }] } }),
      ].join("\n") + "\n";
      writeFileSync(desktopFile, baseline, "utf-8");
      const desktopBaselineCursor = {
        threadId: "desktop-thread",
        file: desktopFile,
        size: Buffer.byteLength(baseline),
        mtimeMs: 1,
      };
      writeFileSync(
        desktopFile,
        baseline +
          [
            JSON.stringify({
              timestamp: "2026-05-12T12:10:00.000Z",
              type: "response_item",
              payload: { type: "message", role: "user", content: [{ type: "input_text", text: "电脑继续改 README" }] },
            }),
            JSON.stringify({
              timestamp: "2026-05-12T12:11:00.000Z",
              type: "response_item",
              payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "README 已改" }] },
            }),
          ].join("\n") +
          "\n",
        "utf-8",
      );

      const state = createBridgeState();
      carryCurrentToWeChat(state, projects, {
        senderId: "sender-a",
        projectName: "vibelight",
        threadId: "desktop-thread",
        mobileThreadId: "mobile-thread",
        sessionCursor: desktopBaselineCursor,
        now: "2026-05-12T12:00:00.000Z",
      });
      const route = state.senders["sender-a"].routes!.vibelight;
      route.leaseState = "desktop_active";
      route.activeSurface = "desktop";
      route.desktopBaselineCursor = desktopBaselineCursor;

      const result = resumeRouteToWeChat(state, projects, "sender-a", {
        roots: [dir],
        now: "2026-05-12T12:12:00.000Z",
      });

      expect(result.reply).toContain("已回到手机 remote mode");
      expect(route.leaseState).toBe("wechat_active");
      expect(route.pendingDesktopTranscript).toContain("Desktop raw handoff");
      expect(route.pendingDesktopTranscript).toContain("电脑继续改 README");
      expect(route.pendingDesktopTranscript).toContain("README 已改");

      const input = consumePendingDesktopTranscript(route, "手机继续这个任务");
      expect(input).toContain("Desktop raw handoff");
      expect(input).toContain("手机继续这个任务");
      expect(route.pendingDesktopTranscript).toBeNull();
    }));

  test("pending Desktop raw transcript is bounded when injected into a mobile turn", () => {
    const route: any = {
      pendingDesktopTranscript: [
        "Desktop raw handoff",
        "old desktop context",
        "x".repeat(80_000),
        "latest desktop decision",
      ].join("\n"),
    };

    const input = consumePendingDesktopTranscript(route, "手机继续这个任务");

    expect(input.length).toBeLessThan(40_000);
    expect(input).toContain("raw desktop transcript truncated");
    expect(input).toContain("latest desktop decision");
    expect(input).toContain("New WeChat message:");
    expect(input).toContain("手机继续这个任务");
    expect(route.pendingDesktopTranscript).toBeNull();
  });

  test("finish-run offer warns when mobile transcript is pending", () => {
    const state = createBridgeState();
    setFinishNotificationEnabled(state, "sender-a", true, "desktop-thread");
    carryCurrentToWeChat(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      mobileThreadId: "mobile-thread",
      now: "2026-05-12T12:00:00.000Z",
    });
    state.senders["sender-a"].routes!.vibelight.pendingMobileTranscript = "Pending WeChat raw transcript\n\n[time] WeChat user:\n手机继续过";

    const result = recordFinishRunOffer(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      mode: "write",
      model: "gpt-5.4",
      summary: "测试完成 release 检查",
      nextAction: "决定是否发版",
      now: "2026-05-12T12:10:00.000Z",
    });

    expect(result.offer.needsMobilePull).toBe(true);
    expect(result.notification).toContain("Codex run 完成");
    expect(result.notification).toContain("完成：测试完成 release 检查");
    expect(result.notification).toContain("需要你：决定是否发版");
    expect(result.notification).toContain("/continue");
    expect(result.notification).toContain("不回复保持原状态");
    expect(result.notification).toContain("有未 pull 手机上下文");
    expect(result.notification.length).toBeLessThan(260);
    expect(state.senders["sender-a"].threadFinishNotifications?.["desktop-thread"]?.pendingOffer?.threadId).toBe("desktop-thread");
    expect(buildFinishRunNotification(result.offer)).toContain("电脑先运行 pull WeChat back");
  });

  test("continue from finish notification forks into a mobile route and clears the offer", () => {
    const state = createBridgeState();
    setFinishNotificationEnabled(state, "sender-a", true, "desktop-thread");
    recordFinishRunOffer(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      mode: "read",
      model: "gpt-5.4-mini",
      now: "2026-05-12T12:10:00.000Z",
      sessionCursor: {
        threadId: "desktop-thread",
        file: "/tmp/desktop.jsonl",
        size: 100,
        mtimeMs: 1,
      },
    });

    const result = continueFinishRunOfferToWeChat(state, projects, "sender-a", {
      mobileThreadId: "mobile-thread",
      mobileStartCursor: {
        threadId: "mobile-thread",
        file: "/tmp/mobile.jsonl",
        size: 80,
        mtimeMs: 1,
      },
      now: "2026-05-12T12:11:00.000Z",
    });

    expect(result.reply).toContain("已从 finish notification 切到手机继续");
    expect(state.senders["sender-a"].routes?.vibelight).toMatchObject({
      attachedThreadId: "desktop-thread",
      mobileThreadId: "mobile-thread",
      leaseState: "wechat_active",
    });
    expect(state.senders["sender-a"].threadFinishNotifications?.["desktop-thread"]?.pendingOffer).toBeNull();
  });

  test("new is blocked while a Desktop carry-over route is active", () => {
    const state = createBridgeState();
    carryCurrentToWeChat(state, projects, {
      senderId: "sender-a",
      projectName: "vibelight",
      threadId: "desktop-thread",
      now: "2026-05-12T12:00:00.000Z",
    });

    const result = applyBridgeCommand(state, projects, "sender-a", { type: "new" });

    expect(result.reply).toContain("当前正在 Desktop carry-over");
    expect(state.senders["sender-a"].routes?.vibelight.attachedThreadId).toBe("desktop-thread");
  });

  test("listener command saves reload fresh disk state and preserve external carry routes", () =>
    withTempDir((dir) => {
      const diskState = createBridgeState();
      diskState.senders["sender-a"] = {
        activeProject: "vibelight",
        activeMode: "write",
        sessions: {
          vibelight: {
            threadId: "wechat-thread",
            cwd: "/workspace/vibelight",
            mode: "write",
          },
        },
      };
      carryCurrentToWeChat(diskState, projects, {
        senderId: "sender-a",
        projectName: "vibelight",
        threadId: "desktop-thread",
        now: "2026-05-12T12:00:00.000Z",
        mode: "read",
      });
      writeFileSync(path.join(dir, "sessions.json"), JSON.stringify(diskState, null, 2));

      const result = applyBridgeCommandToFreshState(dir, projects, "sender-a", { type: "mode", mode: "read" });
      const saved = JSON.parse(readFileSync(path.join(dir, "sessions.json"), "utf-8"));

      expect(result.reply).toBe("mode: read");
      expect(saved.senders["sender-a"].routes.vibelight.attachedThreadId).toBe("desktop-thread");
      expect(saved.senders["sender-a"].routes.vibelight.leaseState).toBe("wechat_active");
      expect(saved.senders["sender-a"].activeMode).toBe("read");
    }));

  test("builds a carry-back delta from event logs", () => {
    const delta = buildCarryBackDelta(
      [
        { type: "reply_sent", at: "2026-05-12T12:00:30.000Z", data: { senderId: "sender-a", projectName: "vibelight", threadId: "desktop-thread", context: "carry_notice" } },
        { type: "wechat_message_received", at: "2026-05-12T12:01:00.000Z", data: { senderId: "sender-a", projectName: "vibelight", threadId: "desktop-thread", textPreview: "先查 release" } },
        { type: "turn_completed", at: "2026-05-12T12:02:00.000Z", data: { senderId: "sender-a", projectName: "vibelight", threadId: "desktop-thread" } },
        { type: "reply_sent", at: "2026-05-12T12:03:00.000Z", data: { senderId: "sender-a", projectName: "vibelight", threadId: "desktop-thread", context: "final_reply" } },
        { type: "wechat_message_received", at: "2026-05-12T12:04:00.000Z", data: { senderId: "sender-a", projectName: "inbox", threadId: "other-thread", textPreview: "不该混进来" } },
      ],
      { senderId: "sender-a", projectName: "vibelight", threadId: "desktop-thread", since: "2026-05-12T12:00:00.000Z" },
    );

    expect(delta).toContain("Mobile continuation");
    expect(delta).toContain("先查 release");
    expect(delta).toContain("Reply sent (final_reply)");
    expect(delta).not.toContain("carry_notice");
    expect(delta).not.toContain("不该混进来");
    expect(delta).not.toContain("turn_completed");
  });
});

describe("cli and skill packaging", () => {
  test("package exposes a codex-wechat bin wrapper", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dir, "package.json"), "utf-8"));

    expect(pkg.bin?.["codex-wechat"]).toBe("./bin/codex-wechat");
  });

  test("package uses public product metadata", () => {
    const pkg = JSON.parse(readFileSync(path.join(import.meta.dir, "package.json"), "utf-8"));

    expect(pkg.name).toBe("codex-wechat-handoff");
    expect(pkg.private).toBe(false);
    expect(pkg.bin?.["codex-wechat"]).toBe("./bin/codex-wechat");
  });

  test("repo ships a Codex skill for carry-over commands", () => {
    const skill = readFileSync(path.join(import.meta.dir, "skills", "codex-wechat", "SKILL.md"), "utf-8");

    expect(skill).toContain("name: codex-wechat");
    expect(skill).toContain("codex-wechat carry-current");
    expect(skill).toContain("codex-wechat pull --project current");
    expect(skill).toContain("codex-wechat project add");
    expect(skill).toContain("handoff lease");
    expect(skill).toContain("forked mobile session");
    expect(skill).toContain("raw transcript");
    expect(skill).toContain("notify-finish");
    expect(skill).toContain("default off");
    expect(skill).toContain("Desktop/CLI-only");
    expect(skill).toContain("/continue");
    expect(skill).not.toContain("Continue the same thread from the phone");
  });

  test("install script exposes a one-line onboarding flow", () => {
    const install = readFileSync(path.join(import.meta.dir, "install.sh"), "utf-8");
    const readme = readFileSync(path.join(import.meta.dir, "README.md"), "utf-8");

    expect(install).toContain('ONBOARD="${CODEX_WECHAT_HANDOFF_ONBOARD:-1}"');
    expect(install).toContain("--onboard");
    expect(install).toContain("--install-only");
    expect(install).toContain("codex-wechat init");
    expect(install).toContain("codex-wechat setup");
    expect(install).toContain("codex-wechat doctor");
    expect(install).toContain("codex-wechat daemon install");
    expect(install).toContain("codex-wechat daemon status");
    expect(readme).toContain("install.sh | bash");
    expect(readme).toContain("bash -s -- --install-only");
  });

  test("send-file CLI supports dry-run without account credentials", () => {
    withTempDir((dir) => {
      const filePath = path.join(dir, "report.pdf");
      writeFileSync(filePath, "%PDF-1.4\n% test\n");

      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "send-file",
          "--state-dir",
          dir,
          "--file",
          filePath,
          "--to",
          "user@im.wechat",
          "--dry-run",
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("dry-run: would send file");
      expect(result.stdout.toString()).toContain(filePath);
    });
  });

  test("send-text CLI supports dry-run without account credentials", () => {
    withTempDir((dir) => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "send-text",
          "--state-dir",
          dir,
          "--to",
          "last",
          "--message",
          "progress update",
          "--dry-run",
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("dry-run: would send text");
      expect(result.stdout.toString()).toContain("message: progress update");
    });
  });

  test("notify-finish CLI supports dry-run without account credentials", () => {
    withTempDir((dir) => {
      writeFileSync(
        path.join(dir, "projects.json"),
        JSON.stringify({
          defaultProject: "vibelight",
          projects: {
            vibelight: {
              cwd: "/workspace/vibelight",
              defaultMode: "read",
              model: "gpt-5.4-mini",
            },
          },
        }),
        "utf-8",
      );
      writeFileSync(
        path.join(dir, "sessions.json"),
        JSON.stringify({
          senders: {
            "sender-a": {
              lastSeenAt: "2026-05-12T12:00:00.000Z",
              sessions: {},
              threadFinishNotifications: {
                "desktop-thread": { enabled: true },
              },
            },
          },
        }),
        "utf-8",
      );

      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "notify-finish",
          "send",
          "--state-dir",
          dir,
          "--thread-id",
          "desktop-thread",
          "--summary",
          "smoke done",
          "--next-action",
          "decide next step",
          "--dry-run",
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("dry-run: would send finish notification");
      expect(result.stdout.toString()).toContain("完成：smoke done");
      expect(result.stdout.toString()).toContain("需要你：decide next step");
      expect(result.stdout.toString()).toContain("/continue");
    });
  });

  test("notify-finish CLI supports default and inherit states", () => {
    withTempDir((dir) => {
      const defaultOn = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "notify-finish",
          "default",
          "on",
          "--state-dir",
          dir,
          "--to",
          "sender-a",
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(defaultOn.exitCode).toBe(0);
      expect(defaultOn.stdout.toString()).toContain("finish_notify_default: on");

      const overrideOff = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "notify-finish",
          "off",
          "--state-dir",
          dir,
          "--to",
          "sender-a",
          "--thread-id",
          "desktop-thread",
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(overrideOff.exitCode).toBe(0);
      expect(overrideOff.stdout.toString()).toContain("source: thread");
      expect(overrideOff.stdout.toString()).toContain("thread_override: off");
      expect(overrideOff.stdout.toString()).toContain("global_default: on");

      const inherit = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "notify-finish",
          "inherit",
          "--state-dir",
          dir,
          "--to",
          "sender-a",
          "--thread-id",
          "desktop-thread",
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(inherit.exitCode).toBe(0);
      expect(inherit.stdout.toString()).toContain("source: default");
      expect(inherit.stdout.toString()).toContain("thread_override: inherit");
      expect(inherit.stdout.toString()).toContain("finish_notify: on");
    });
  });

  test("send-image CLI supports dry-run without account credentials", () => {
    withTempDir((dir) => {
      const imagePath = path.join(dir, "preview.png");
      writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "send-image",
          "--state-dir",
          dir,
          "--file",
          imagePath,
          "--to",
          "user@im.wechat",
          "--dry-run",
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("dry-run: would send image");
      expect(result.stdout.toString()).toContain(imagePath);
    });
  });

  test("HTML renderer auto mode prefers Chrome when available", () => {
    expect(
      chooseHtmlRenderer({
        requested: "auto",
        needPdf: true,
        needPng: true,
        chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        quickLookAvailable: true,
        sipsAvailable: true,
      }),
    ).toEqual({ kind: "chrome", executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", pdfMode: "vector" });
  });

  test("HTML renderer auto mode falls back to macOS Quick Look", () => {
    expect(
      chooseHtmlRenderer({
        requested: "auto",
        needPdf: true,
        needPng: true,
        chromeExecutable: null,
        quickLookAvailable: true,
        sipsAvailable: true,
      }),
    ).toEqual({ kind: "quicklook", pdfMode: "image" });
  });

  test("HTML renderer refuses PDF fallback when sips is unavailable", () => {
    expect(() =>
      chooseHtmlRenderer({
        requested: "auto",
        needPdf: true,
        needPng: false,
        chromeExecutable: null,
        quickLookAvailable: true,
        sipsAvailable: false,
      }),
    ).toThrow("No HTML renderer available");
  });

  test("render-html CLI supports dry-run renderer selection", () => {
    withTempDir((dir) => {
      const htmlPath = path.join(dir, "report.html");
      const pdfPath = path.join(dir, "report.pdf");
      const pngPath = path.join(dir, "report.png");
      writeFileSync(htmlPath, "<!doctype html><title>Smoke</title><h1>Smoke</h1>");

      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "render-html",
          "--html",
          htmlPath,
          "--pdf",
          pdfPath,
          "--png",
          pngPath,
          "--renderer",
          "quicklook",
          "--dry-run",
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("dry-run: would render HTML");
      expect(result.stdout.toString()).toContain("renderer: quicklook");
      expect(result.stdout.toString()).toContain(pdfPath);
      expect(result.stdout.toString()).toContain(pngPath);
    });
  });

  test("init creates a safe local projects config", () => {
    withTempDir((dir) => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "init",
          "--state-dir",
          dir,
          "--project",
          "demo",
          "--cwd",
          dir,
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      const config = JSON.parse(readFileSync(path.join(dir, "projects.json"), "utf-8"));
      expect(config.defaultProject).toBe("demo");
      expect(config.allowedSenderIds).toEqual([]);
      expect(config.projects.demo.defaultMode).toBe("read");
      expect(config.projects.demo.cwd).toBe(dir);
      expect(result.stdout.toString()).toContain("Next: codex-wechat setup");
    });
  });

  test("init without explicit project creates a writable inbox workspace", () => {
    withTempDir((dir) => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "init",
          "--state-dir",
          dir,
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      const config = JSON.parse(readFileSync(path.join(dir, "projects.json"), "utf-8"));
      const inbox = path.join(dir, "workspaces", "inbox");
      expect(config.defaultProject).toBe("inbox");
      expect(config.projects.inbox.cwd).toBe(inbox);
      expect(config.projects.inbox.defaultMode).toBe("write");
      expect(result.stdout.toString()).toContain("default WeChat inbox");
      expect(result.stdout.toString()).toContain("codex-wechat project add");
      expect(loadProjectRegistry({ workspace: "/tmp/unused", projectsConfig: config }).projects.inbox.cwd).toBe(inbox);
    });
  });

  test("doctor reports missing account and project config", () => {
    withTempDir((dir) => {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "doctor",
          "--state-dir",
          dir,
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain("account: missing");
      expect(output).toContain("projects: missing");
      expect(output).toContain("codex:");
      expect(output).toContain("bun:");
    });
  });

  test("LaunchAgent plist uses caller-provided paths", () => {
    const plist = buildLaunchAgentPlist({
      label: "com.codex-wechat-handoff.daemon",
      bunBin: "/opt/homebrew/bin/bun",
      scriptPath: "/repo/codex-wechat-ilink.ts",
      stateDir: "/home/alice/.codex-wechat-handoff",
      projectsFile: "/home/alice/.codex-wechat-handoff/projects.json",
      codexBin: "/opt/homebrew/bin/codex",
      workingDirectory: "/repo",
      logDir: "/home/alice/.codex-wechat-handoff/logs",
      homeDir: "/home/alice",
    });

    expect(plist).toContain("com.codex-wechat-handoff.daemon");
    expect(plist).toContain("/home/alice/.codex-wechat-handoff");
    expect(plist).toContain("/opt/homebrew/bin/bun");
    expect(plist).not.toContain("local-user");
  });

  test("doctor daemon status calls out a LaunchAgent for a different state dir", () => {
    const plist = buildLaunchAgentPlist({
      label: "com.codex-wechat-handoff.daemon",
      bunBin: "/opt/homebrew/bin/bun",
      scriptPath: "/repo/codex-wechat-ilink.ts",
      stateDir: "/tmp/global-codex-wechat",
      projectsFile: "/tmp/global-codex-wechat/projects.json",
      codexBin: "/opt/homebrew/bin/codex",
      workingDirectory: "/repo",
      logDir: "/tmp/global-codex-wechat/logs",
      homeDir: "/home/alice",
    });

    const status = describeLaunchAgentDaemonStatus({
      requestedStateDir: "/tmp/scoped-codex-wechat",
      launchctlExitCode: 0,
      launchctlStdout: "state = running\npid = 12345\n",
      plistText: plist,
      platform: "darwin",
    });

    expect(status).toContain("running");
    expect(status).toContain("pid 12345");
    expect(status).toContain("different state-dir: /tmp/global-codex-wechat");
    expect(status).toContain("requested: /tmp/scoped-codex-wechat");
  });

  test("onboarding starts with carry-over before generic commands", () => {
    const text = buildOnboardingMessage();
    expect(text.indexOf("核心用法")).toBeLessThan(text.indexOf("其他常用命令"));
    expect(text).toContain("codex-wechat carry-current");
    expect(text).toContain("pull WeChat back");
    expect(text).toContain("forked mobile session");
    expect(text).toContain("raw transcript");
    expect(text).toContain("自动暂停");
    expect(text).toContain("codex-wechat pull");
    expect(text).toContain("/new");
    expect(text).toContain("/stop");
    expect(text).toContain("/notify");
    expect(text).toContain("/continue");
    expect(text).toContain("回电脑后第一句话");
    expect(text).toContain("compact");
    expect(text).not.toContain("继续同一个 Codex thread");
  });

  test("intro is shorter than full onboarding and points to onboarding for details", () => {
    const intro = buildIntroMessage();
    const onboarding = buildOnboardingMessage();

    expect(intro.length).toBeLessThan(onboarding.length);
    expect(intro).toContain("pull WeChat back");
    expect(intro).toContain("/onboarding");
  });

  test("project add CLI creates a safe project config entry", () => {
    withTempDir((dir) => {
      const projectDir = path.join(dir, "demo-project");
      mkdirSync(projectDir, { recursive: true });
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "codex-wechat-ilink.ts"),
          "project",
          "add",
          "demo",
          "--state-dir",
          dir,
          "--cwd",
          projectDir,
        ],
        cwd: import.meta.dir,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      const config = JSON.parse(readFileSync(path.join(dir, "projects.json"), "utf-8"));
      expect(config.defaultProject).toBe("demo");
      expect(config.projects.demo.cwd).toBe(projectDir);
      expect(config.projects.demo.defaultMode).toBe("read");
      expect(result.stdout.toString()).toContain("/project demo");
    });
  });

  test("onboarding explains project switching as per-project sessions in both languages", () => {
    const text = buildOnboardingMessage();

    expect(text).toContain("Project/session binding");
    expect(text).toContain("默认 inbox");
    expect(text).toContain("每个 project 有自己的手机 session / Codex thread");
    expect(text).toContain("Each project has its own mobile session and Codex thread");
    expect(text).toContain("不是换同一个 thread 的 cwd");
    expect(text).toContain("mode follows the target project session or default");
    expect(text).toContain("/project <name>");
  });

  test("onboarding explains permission mode semantics", () => {
    const text = buildOnboardingMessage();

    expect(text).toContain("read: read/search any readable local files, network enabled, no writes");
    expect(text).toContain("write: read/search any readable local files, network enabled, writes only inside the project cwd");
    expect(text).toContain("fullaccess: unrestricted local access");
    expect(text).toContain("/mode fullaccess");
  });
});
