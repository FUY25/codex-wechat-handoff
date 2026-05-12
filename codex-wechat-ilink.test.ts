import { describe, expect, test } from "bun:test";
import {
  applyBridgeCommand,
  buildWechatTurnInput,
  createBridgeState,
  loadProjectRegistry,
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
});
