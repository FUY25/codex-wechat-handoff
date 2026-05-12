import { describe, expect, test } from "bun:test";
import {
  applyBridgeCommand,
  buildInboundUserMessageText,
  parseAesKey,
  buildWechatTurnInput,
  createBridgeState,
  formatBridgeError,
  loadProjectRegistry,
  parseReplyMediaDirectives,
  parseBridgeCommand,
  sandboxForMode,
} from "./codex-wechat-ilink";

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
