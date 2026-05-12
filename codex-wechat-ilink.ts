#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const BOT_TYPE = "3";
const CHANNEL_VERSION = "0.1.0";
const LONG_POLL_TIMEOUT_MS = 40_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const MSG_TYPE_USER = 1;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const MSG_ITEM_TEXT = 1;
const MSG_ITEM_IMAGE = 2;
const MSG_ITEM_VOICE = 3;
const MSG_ITEM_FILE = 4;
const MSG_ITEM_VIDEO = 5;
const UPLOAD_MEDIA_IMAGE = 1;
const UPLOAD_MEDIA_VIDEO = 2;
const UPLOAD_MEDIA_FILE = 3;
const UPLOAD_MEDIA_VOICE = 4;
const VOICE_ENCODE_PCM = 1;
const VOICE_ENCODE_AMR = 5;
const VOICE_ENCODE_SILK = 6;
const VOICE_ENCODE_MP3 = 7;
const VOICE_ENCODE_OGG_SPEEX = 8;

type Args = {
  _: string[];
  [key: string]: string | boolean | string[];
};

type Account = {
  token: string;
  baseUrl: string;
  accountId?: string;
  userId?: string;
  savedAt: string;
};

type IlinkItem = {
  type?: number;
  text_item?: { text?: string };
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: { title?: string };
};

type CDNMedia = {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
};

type ImageItem = {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
};

type VoiceItem = {
  media?: CDNMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
};

type FileItem = {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
};

type VideoItem = {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
};

type IlinkMessage = {
  message_type?: number;
  from_user_id?: string;
  context_token?: string;
  item_list?: IlinkItem[];
};

type IlinkUpdates = {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  get_updates_buf?: string;
  msgs?: IlinkMessage[];
};

type HistoryItem = {
  role: "user" | "assistant";
  text: string;
  at: string;
};

type RuntimeOptions = {
  stateDir: string;
  baseUrl: string;
  cdnBaseUrl: string;
  workspace: string;
  projectsFile?: string;
  backend: "app-server" | "exec";
  appServerLogs: boolean;
  codexBin: string;
  codexModel?: string;
  codexSandbox: string;
  codexTimeoutMs: number;
  historyLimit: number;
  persistCodexSessions: boolean;
  dryRun: boolean;
  mockReply?: string;
};

export type BridgeMode = "read" | "write" | "bypass";

export type ProjectConfig = {
  cwd: string;
  defaultMode?: BridgeMode;
  model?: string;
};

export type ProjectsConfig = {
  defaultProject?: string;
  allowedSenderIds?: string[];
  projects: Record<string, ProjectConfig>;
};

export type ProjectRegistry = {
  defaultProject: string;
  allowedSenderIds: string[];
  projects: Record<string, Required<Pick<ProjectConfig, "cwd">> & Omit<ProjectConfig, "cwd"> & { defaultMode: BridgeMode }>;
};

export type SenderProjectSession = {
  threadId?: string;
  cwd: string;
  mode: BridgeMode;
};

export type SenderState = {
  activeProject?: string;
  activeMode?: BridgeMode;
  projectModels?: Record<string, string>;
  sessions: Record<string, SenderProjectSession>;
};

export type BridgeState = {
  senders: Record<string, SenderState>;
};

export type BridgeCommand =
  | { type: "message"; text: string }
  | { type: "project"; project: string }
  | { type: "projects" }
  | { type: "mode"; mode: BridgeMode }
  | { type: "model"; model: string | null }
  | { type: "modelStatus" }
  | { type: "status" }
  | { type: "new" }
  | { type: "error"; message: string };

type AppServerSandboxPolicy =
  | { type: "readOnly"; networkAccess: false }
  | { type: "workspaceWrite"; networkAccess: false; writableRoots: string[] }
  | { type: "dangerFullAccess" };

type AppServerRunResult = {
  threadId: string;
  reply: string;
};

export type SavedMediaFile = {
  kind: "image" | "voice" | "file" | "video";
  path: string;
  bytes: number;
  transcript?: string;
  fileName?: string;
  encodeType?: number;
  playtimeMs?: number;
};

type UploadedFileInfo = {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
};

type ReplyMediaDirective = {
  kind: "image" | "voice";
  path: string;
  playtimeMs?: number;
};

type AppServerRequest = {
  id: number;
  method: string;
  params?: unknown;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    if (eq !== -1) {
      args[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }

    const key = raw;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function optionString(args: Args, key: string, fallback: string): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

function optionNumber(args: Args, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function runtimeOptions(args: Args): RuntimeOptions {
  const defaultStateDir = path.join(os.homedir(), ".codex", "channels", "wechat");
  return {
    stateDir: path.resolve(expandHome(optionString(args, "state-dir", defaultStateDir))),
    baseUrl: optionString(args, "base-url", DEFAULT_BASE_URL),
    cdnBaseUrl: optionString(args, "cdn-base-url", DEFAULT_CDN_BASE_URL),
    workspace: path.resolve(expandHome(optionString(args, "workspace", process.cwd()))),
    projectsFile: typeof args.projects === "string" ? path.resolve(expandHome(args.projects)) : undefined,
    backend: optionString(args, "backend", "app-server") === "exec" ? "exec" : "app-server",
    appServerLogs: Boolean(args["app-server-logs"]),
    codexBin: optionString(args, "codex-bin", "codex"),
    codexModel: typeof args.model === "string" ? args.model : undefined,
    codexSandbox: optionString(args, "codex-sandbox", "read-only"),
    codexTimeoutMs: optionNumber(args, "codex-timeout-ms", 600_000),
    historyLimit: optionNumber(args, "history-limit", 12),
    persistCodexSessions: Boolean(args["persist-codex-sessions"]),
    dryRun: Boolean(args["dry-run"]),
    mockReply: typeof args["mock-reply"] === "string" ? args["mock-reply"] : undefined,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function accountFile(stateDir: string): string {
  return path.join(stateDir, "account.json");
}

function syncBufFile(stateDir: string): string {
  return path.join(stateDir, "sync_buf.txt");
}

function bridgeStateFile(stateDir: string): string {
  return path.join(stateDir, "sessions.json");
}

export function createBridgeState(): BridgeState {
  return { senders: {} };
}

function normalizeMode(mode: string): BridgeMode | null {
  if (mode === "read" || mode === "write" || mode === "bypass") return mode;
  return null;
}

export function loadProjectRegistry(params: { workspace: string; projectsConfig?: ProjectsConfig }): ProjectRegistry {
  const projectsConfig = params.projectsConfig;
  if (!projectsConfig) {
    return {
      defaultProject: "default",
      allowedSenderIds: [],
      projects: {
        default: {
          cwd: path.resolve(params.workspace),
          defaultMode: "read",
        },
      },
    };
  }

  const projectEntries = Object.entries(projectsConfig.projects ?? {});
  if (!projectEntries.length) {
    throw new Error("projects config must define at least one project");
  }

  const projects: ProjectRegistry["projects"] = {};
  for (const [name, config] of projectEntries) {
    if (!config.cwd?.trim()) throw new Error(`project ${name} is missing cwd`);
    projects[name] = {
      ...config,
      cwd: path.resolve(expandHome(config.cwd)),
      defaultMode: config.defaultMode ?? "read",
    };
  }

  const defaultProject = projectsConfig.defaultProject ?? projectEntries[0][0];
  if (!projects[defaultProject]) {
    throw new Error(`default project does not exist: ${defaultProject}`);
  }

  return {
    defaultProject,
    allowedSenderIds: projectsConfig.allowedSenderIds ?? [],
    projects,
  };
}

function loadProjectsConfig(file?: string): ProjectsConfig | undefined {
  if (!file) return undefined;
  return JSON.parse(readFileSync(file, "utf-8")) as ProjectsConfig;
}

function loadBridgeState(stateDir: string): BridgeState {
  const file = bridgeStateFile(stateDir);
  if (!existsSync(file)) return createBridgeState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as BridgeState;
    return parsed && typeof parsed === "object" && parsed.senders ? parsed : createBridgeState();
  } catch {
    return createBridgeState();
  }
}

function saveBridgeState(stateDir: string, state: BridgeState): void {
  mkdirSync(stateDir, { recursive: true });
  const file = bridgeStateFile(stateDir);
  writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort only.
  }
}

function senderState(state: BridgeState, senderId: string): SenderState {
  state.senders[senderId] ??= { sessions: {} };
  state.senders[senderId].sessions ??= {};
  return state.senders[senderId];
}

function activeProjectName(state: BridgeState, projects: ProjectRegistry, senderId: string): string {
  const sender = senderState(state, senderId);
  return sender.activeProject && projects.projects[sender.activeProject] ? sender.activeProject : projects.defaultProject;
}

function activeMode(state: BridgeState, projects: ProjectRegistry, senderId: string): BridgeMode {
  const sender = senderState(state, senderId);
  if (sender.activeMode) return sender.activeMode;
  return projects.projects[activeProjectName(state, projects, senderId)].defaultMode;
}

function activeModel(state: BridgeState, projects: ProjectRegistry, senderId: string, projectName?: string): string | undefined {
  const sender = senderState(state, senderId);
  const resolvedProjectName = projectName ?? activeProjectName(state, projects, senderId);
  return sender.projectModels?.[resolvedProjectName] ?? projects.projects[resolvedProjectName].model;
}

export function parseBridgeCommand(text: string): BridgeCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { type: "message", text };

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const arg = rest.join(" ").trim();

  if (command === "/project") {
    if (!arg) return { type: "error", message: "Usage: /project <name>" };
    return { type: "project", project: arg };
  }
  if (command === "/projects") return { type: "projects" };
  if (command === "/mode") {
    const mode = normalizeMode(arg);
    if (!mode) return { type: "error", message: `Unknown mode: ${arg || "(empty)"}. Use read, write, or bypass.` };
    return { type: "mode", mode };
  }
  if (command === "/model") {
    if (!arg) return { type: "modelStatus" };
    const normalized = arg.toLowerCase();
    if (normalized === "default" || normalized === "reset" || normalized === "auto") {
      return { type: "model", model: null };
    }
    if (/\s/.test(arg)) {
      return { type: "error", message: "Model names cannot contain spaces. Use /model default to clear the override." };
    }
    return { type: "model", model: arg };
  }
  if (command === "/status") return { type: "status" };
  if (command === "/new") return { type: "new" };

  return { type: "error", message: `Unknown command: ${rawCommand}` };
}

export function applyBridgeCommand(
  state: BridgeState,
  projects: ProjectRegistry,
  senderId: string,
  command: Exclude<BridgeCommand, { type: "message" }>,
): { handled: true; reply: string } {
  const sender = senderState(state, senderId);

  if (command.type === "error") return { handled: true, reply: command.message };

  if (command.type === "projects") {
    const names = Object.entries(projects.projects)
      .map(([name, project]) => `${name} -> ${project.cwd}`)
      .join("\n");
    return { handled: true, reply: `projects:\n${names}` };
  }

  if (command.type === "project") {
    if (!projects.projects[command.project]) {
      return { handled: true, reply: `Unknown project: ${command.project}. Use /projects to list available projects.` };
    }
    sender.activeProject = command.project;
    sender.activeMode ??= projects.projects[command.project].defaultMode;
    const model = activeModel(state, projects, senderId, command.project) ?? "default";
    return {
      handled: true,
      reply: `project: ${command.project}\nmode: ${sender.activeMode}\nmodel: ${model}\ncwd: ${projects.projects[command.project].cwd}`,
    };
  }

  if (command.type === "mode") {
    sender.activeMode = command.mode;
    return { handled: true, reply: `mode: ${command.mode}` };
  }

  const projectName = activeProjectName(state, projects, senderId);
  const project = projects.projects[projectName];
  const mode = activeMode(state, projects, senderId);
  const model = activeModel(state, projects, senderId, projectName);
  const session = sender.sessions[projectName];

  if (command.type === "modelStatus") {
    return { handled: true, reply: `model: ${model ?? "default"}` };
  }

  if (command.type === "model") {
    sender.projectModels ??= {};
    if (command.model) {
      sender.projectModels[projectName] = command.model;
      return { handled: true, reply: `model: ${command.model}\nproject: ${projectName}` };
    }
    delete sender.projectModels[projectName];
    return { handled: true, reply: `model: default\nproject: ${projectName}` };
  }

  if (command.type === "status") {
    return {
      handled: true,
      reply: [
        `project: ${projectName}`,
        `mode: ${mode}`,
        `model: ${model ?? "default"}`,
        `thread: ${session?.threadId ?? "none"}`,
        `cwd: ${project.cwd}`,
      ].join("\n"),
    };
  }

  if (command.type === "new") {
    delete sender.sessions[projectName];
    return { handled: true, reply: `new session requested for project: ${projectName}` };
  }

  return { handled: true, reply: "Unhandled command." };
}

export function sandboxForMode(mode: BridgeMode, cwd: string): AppServerSandboxPolicy {
  if (mode === "read") return { type: "readOnly", networkAccess: false };
  if (mode === "write") return { type: "workspaceWrite", networkAccess: false, writableRoots: [cwd] };
  return { type: "dangerFullAccess" };
}

function legacySandboxForMode(mode: BridgeMode): string {
  if (mode === "read") return "read-only";
  if (mode === "write") return "workspace-write";
  return "danger-full-access";
}

export function buildWechatTurnInput(params: {
  senderId: string;
  projectName: string;
  mode: BridgeMode;
  model?: string;
  text: string;
  mediaFiles?: SavedMediaFile[];
}): string {
  const media = params.mediaFiles?.length
    ? [
        "",
        "Incoming WeChat media:",
        ...params.mediaFiles.map((file, index) => {
          const parts = [`${index + 1}. ${file.kind}: ${file.path}`, `bytes: ${file.bytes}`];
          if (file.transcript) parts.push(`transcript: ${file.transcript}`);
          if (file.playtimeMs !== undefined) parts.push(`playtime_ms: ${file.playtimeMs}`);
          if (file.encodeType !== undefined) parts.push(`encode_type: ${file.encodeType}`);
          return parts.join(" | ");
        }),
        "",
        "If visual details matter, inspect the local image file before answering.",
        "To send an image back through WeChat, include a line exactly like: WECHAT_IMAGE: /absolute/path/to/image.png",
        "To send a voice message back through WeChat, include a line exactly like: WECHAT_VOICE: /absolute/path/to/audio.silk playtime_ms=2000",
      ]
    : [];
  return [
    "source: WeChat",
    `sender_id: ${params.senderId}`,
    `project: ${params.projectName}`,
    `mode: ${params.mode}`,
    ...(params.model ? [`model: ${params.model}`] : []),
    "",
    "Reply with the exact text that should be sent back to WeChat.",
    "Keep replies concise and plain text unless the user explicitly asks for detail.",
    "",
    "User message:",
    params.text,
    ...media,
  ].join("\n");
}

export function buildInboundUserMessageText(params: { messageText: string; mediaFiles: SavedMediaFile[] }): string {
  const messageText = params.messageText.trim();
  if (!params.mediaFiles.length) return messageText;

  const lines = [
    messageText || "[WeChat media message]",
    "",
    "Incoming WeChat media:",
    ...params.mediaFiles.map((file, index) => {
      const parts = [`${index + 1}. ${file.kind}: ${file.path}`, `bytes: ${file.bytes}`];
      if (file.transcript) parts.push(`transcript: ${file.transcript}`);
      if (file.playtimeMs !== undefined) parts.push(`playtime_ms: ${file.playtimeMs}`);
      if (file.encodeType !== undefined) parts.push(`encode_type: ${file.encodeType}`);
      return parts.join(" | ");
    }),
  ];
  return lines.join("\n");
}

export function parseReplyMediaDirectives(reply: string): { text: string; media: ReplyMediaDirective[] } {
  const media: ReplyMediaDirective[] = [];
  const textLines: string[] = [];

  for (const line of reply.split(/\r?\n/)) {
    const imageMatch = line.match(/^\s*WECHAT_IMAGE:\s+(.+?)\s*$/i);
    if (imageMatch) {
      media.push({ kind: "image", path: imageMatch[1].trim() });
      continue;
    }

    const voiceMatch = line.match(/^\s*WECHAT_VOICE:\s+(\S+)(?:\s+playtime_ms=(\d+))?\s*$/i);
    if (voiceMatch) {
      media.push({
        kind: "voice",
        path: voiceMatch[1],
        ...(voiceMatch[2] ? { playtimeMs: Number(voiceMatch[2]) } : {}),
      });
      continue;
    }

    const withoutMarkdownImages = line.replace(/!\[[^\]]*]\((\/[^)\s]+)\)/g, (_match, imagePath: string) => {
      media.push({ kind: "image", path: imagePath });
      return "";
    });
    if (withoutMarkdownImages.trim()) textLines.push(withoutMarkdownImages.trimEnd());
  }

  return { text: textLines.join("\n").trim(), media };
}

export function formatBridgeError(error: unknown, timeoutMs: number): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("timed out")) {
    return `这次 Codex 任务超过 ${Math.round(timeoutMs / 1000)} 秒还没完成，我先停掉了，避免一直卡住。请把任务拆小一点重发，或者让我先切到更长 timeout 后再跑。`;
  }
  return `这次处理失败了：${message.slice(0, 500)}`;
}

class CodexAppServerClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private buffer = "";
  private initialized = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private turnCollectors = new Map<string, { text: string; resolve: (value: string) => void; reject: (error: Error) => void }>();

  constructor(private readonly options: RuntimeOptions) {}

  async runTurn(params: {
    threadId?: string;
    cwd: string;
    mode: BridgeMode;
    model?: string;
    input: string;
    projectName: string;
  }): Promise<AppServerRunResult> {
    try {
      await this.ensureStarted();
      let threadId: string;
      if (params.threadId) {
        try {
          threadId = await this.resumeThread(params);
        } catch (error) {
          console.error(`Failed to resume Codex thread ${params.threadId}; starting a new thread: ${error instanceof Error ? error.message : String(error)}`);
          threadId = await this.startThread(params);
        }
      } else {
        threadId = await this.startThread(params);
      }
      const turn = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: params.input }],
        approvalPolicy: "never",
        cwd: params.cwd,
        model: params.model ?? this.options.codexModel ?? null,
        sandboxPolicy: sandboxForMode(params.mode, params.cwd),
      });
      const turnId = turn?.turn?.id;
      if (!turnId) throw new Error("app-server turn/start did not return a turn id");
      const reply = await this.waitForTurn(threadId, turnId);
      return { threadId, reply };
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    for (const pending of this.pending.values()) pending.reject(new Error("app-server stopped"));
    this.pending.clear();
    for (const collector of this.turnCollectors.values()) collector.reject(new Error("app-server stopped"));
    this.turnCollectors.clear();
    this.proc?.kill("SIGTERM");
    this.proc = null;
    this.initialized = false;
  }

  private async startThread(params: { cwd: string; mode: BridgeMode; model?: string; projectName: string }): Promise<string> {
    const response = await this.request("thread/start", {
      cwd: params.cwd,
      approvalPolicy: "never",
      sandbox: legacySandboxForMode(params.mode),
      ephemeral: false,
      model: params.model ?? this.options.codexModel ?? null,
      sessionStartSource: "startup",
      developerInstructions: [
        "You are Codex connected to WeChat through a local bridge.",
        `Active project: ${params.projectName}`,
        "Send concise plain-text final answers suitable for WeChat.",
      ].join("\n"),
    });
    const threadId = response?.thread?.id;
    if (!threadId) throw new Error("app-server thread/start did not return a thread id");
    return threadId;
  }

  private async resumeThread(params: { threadId?: string; cwd: string; mode: BridgeMode; model?: string; projectName: string }): Promise<string> {
    if (!params.threadId) throw new Error("cannot resume without a thread id");
    const response = await this.request("thread/resume", {
      threadId: params.threadId,
      cwd: params.cwd,
      approvalPolicy: "never",
      sandbox: legacySandboxForMode(params.mode),
      model: params.model ?? this.options.codexModel ?? null,
      developerInstructions: [
        "You are Codex connected to WeChat through a local bridge.",
        `Active project: ${params.projectName}`,
        "Send concise plain-text final answers suitable for WeChat.",
      ].join("\n"),
    });
    const threadId = response?.thread?.id ?? params.threadId;
    return threadId;
  }

  private waitForTurn(threadId: string, turnId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnCollectors.delete(turnId);
        reject(new Error(`app-server turn timed out after ${this.options.codexTimeoutMs}ms`));
      }, this.options.codexTimeoutMs);

      this.turnCollectors.set(turnId, {
        text: "",
        resolve: (value) => {
          clearTimeout(timeout);
          this.turnCollectors.delete(turnId);
          resolve(value.trim());
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.turnCollectors.delete(turnId);
          reject(error);
        },
      });
    }).then((reply) => {
      if (!reply) throw new Error(`app-server returned an empty reply for thread ${threadId}`);
      return reply;
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc && this.initialized) return;

    this.proc = Bun.spawn([this.options.codexBin, "app-server", "--listen", "stdio://"], {
      cwd: this.options.workspace,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    void this.readStdout(this.proc.stdout);
    void this.readStderr(this.proc.stderr);

    await this.request("initialize", {
      clientInfo: {
        name: "wechat-to-codex",
        title: "WeChat to Codex",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.sendNotification("initialized");
    this.initialized = true;
  }

  private request(method: string, params?: unknown): Promise<any> {
    if (!this.proc) throw new Error("app-server is not started");
    const id = this.nextId++;
    const message: AppServerRequest = { id, method, params };
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (!this.proc) throw new Error("app-server is not started");
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private async readStdout(stdout: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stdout) return;
    const textStream = stdout.pipeThrough(new TextDecoderStream());
    for await (const chunk of textStream) {
      this.buffer += chunk;
      while (this.buffer.includes("\n")) {
        const idx = this.buffer.indexOf("\n");
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        this.handleMessage(JSON.parse(line));
      }
    }
  }

  private async readStderr(stderr: ReadableStream<Uint8Array> | null): Promise<void> {
    if (!stderr) return;
    const textStream = stderr.pipeThrough(new TextDecoderStream());
    for await (const chunk of textStream) {
      if (!this.options.appServerLogs) continue;
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.error(`[codex-app-server] ${line}`);
      }
    }
  }

  private handleMessage(message: any): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    const turnId = message.params?.turnId ?? message.params?.turn?.id;
    if (message.method === "item/agentMessage/delta" && turnId) {
      const collector = this.turnCollectors.get(turnId);
      if (collector) collector.text += message.params?.delta ?? "";
      return;
    }

    if (message.method === "item/completed" && turnId && message.params?.item?.type === "agentMessage") {
      const collector = this.turnCollectors.get(turnId);
      if (collector && message.params.item.text) collector.text = message.params.item.text;
      return;
    }

    if (message.method === "turn/completed" && turnId) {
      const collector = this.turnCollectors.get(turnId);
      if (collector) collector.resolve(collector.text);
    }
  }
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body) headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response: ${text.slice(0, 300)}`);
  }
}

async function fetchQRCode(baseUrl: string): Promise<{ qrcode: string; qrcode_img_content: string; ret?: number }> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, base);
  const response = await fetch(url.toString());
  return readJsonResponse(response);
}

async function renderLoginQRCode(stateDir: string, qrcodeUrl: string): Promise<string> {
  mkdirSync(stateDir, { recursive: true });
  const qrFile = path.join(stateDir, "login-qrcode.png");
  const QRCode = await import("qrcode");
  await QRCode.toFile(qrFile, qrcodeUrl, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
  });
  try {
    const terminalQr = await QRCode.toString(qrcodeUrl, { type: "terminal", small: true });
    console.log(terminalQr);
  } catch {
    // The PNG is enough if terminal rendering is unavailable.
  }
  return qrFile;
}

async function pollQRStatus(baseUrl: string, qrcode: string): Promise<Record<string, string>> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const response = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    return await readJsonResponse(response);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { status: "wait" };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function apiPost<T>(baseUrl: string, endpoint: string, token: string, body: unknown, timeoutMs: number): Promise<T> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(endpoint, base);
  const encoded = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(token, encoded),
      body: encoded,
      signal: controller.signal,
    });
    return await readJsonResponse(response);
  } finally {
    clearTimeout(timer);
  }
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`);
}

function mediaAesKeyBase64(hexKey: string): string {
  return Buffer.from(hexKey, "utf-8").toString("base64");
}

function buildCdnDownloadUrl(cdnBaseUrl: string, encryptedQueryParam: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function fetchCdnBytes(cdnBaseUrl: string, media: CDNMedia): Promise<Buffer> {
  if (!media.full_url && !media.encrypt_query_param) throw new Error("media is missing full_url and encrypt_query_param");
  const response = await fetch(media.full_url ?? buildCdnDownloadUrl(cdnBaseUrl, media.encrypt_query_param ?? ""));
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`CDN download ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function downloadAndDecrypt(cdnBaseUrl: string, media: CDNMedia, fallbackHexKey?: string): Promise<Buffer> {
  const encrypted = await fetchCdnBytes(cdnBaseUrl, media);
  const key = fallbackHexKey ? Buffer.from(fallbackHexKey, "hex") : media.aes_key ? parseAesKey(media.aes_key) : null;
  return key ? decryptAesEcb(encrypted, key) : encrypted;
}

async function getUploadUrl(account: Account, body: unknown): Promise<{ upload_param?: string; thumb_upload_param?: string; upload_full_url?: string }> {
  return apiPost<{ upload_param?: string; thumb_upload_param?: string; upload_full_url?: string }>(
    account.baseUrl,
    "ilink/bot/getuploadurl",
    account.token,
    body,
    15_000,
  );
}

async function uploadBufferToCdn(params: {
  cdnBaseUrl: string;
  uploadParam?: string;
  uploadFullUrl?: string;
  filekey: string;
  aeskey: Buffer;
  plaintext: Buffer;
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.plaintext, params.aeskey);
  const uploadUrl = params.uploadFullUrl ?? (params.uploadParam ? buildCdnUploadUrl(params.cdnBaseUrl, params.uploadParam, params.filekey) : "");
  if (!uploadUrl) throw new Error("CDN upload URL missing");
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`CDN upload ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  }
  const encryptedParam = response.headers.get("x-encrypted-param");
  if (!encryptedParam) throw new Error("CDN upload response missing x-encrypted-param header");
  return encryptedParam;
}

async function uploadMediaFile(params: {
  account: Account;
  cdnBaseUrl: string;
  toUserId: string;
  filePath: string;
  mediaType: number;
}): Promise<UploadedFileInfo> {
  const plaintext = readFileSync(params.filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);
  const uploadUrl = await getUploadUrl(params.account, {
    filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
    base_info: { channel_version: CHANNEL_VERSION },
  });
  if (!uploadUrl.upload_param && !uploadUrl.upload_full_url) throw new Error(`getuploadurl returned no upload URL: ${JSON.stringify(uploadUrl)}`);
  const downloadEncryptedQueryParam = await uploadBufferToCdn({
    cdnBaseUrl: params.cdnBaseUrl,
    uploadParam: uploadUrl.upload_param,
    uploadFullUrl: uploadUrl.upload_full_url,
    filekey,
    aeskey,
    plaintext,
  });
  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

function loadAccount(stateDir: string): Account {
  const file = accountFile(stateDir);
  if (!existsSync(file)) {
    throw new Error(`No account credentials found at ${file}. Run setup first.`);
  }
  const account = JSON.parse(readFileSync(file, "utf-8")) as Account;
  if (!account.token || !account.baseUrl) {
    throw new Error(`Invalid account credentials at ${file}. Run setup again.`);
  }
  return account;
}

function saveAccount(stateDir: string, account: Account): void {
  mkdirSync(stateDir, { recursive: true });
  const file = accountFile(stateDir);
  writeFileSync(file, JSON.stringify(account, null, 2), "utf-8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // Some filesystems ignore chmod. The token still stays outside this repo by default.
  }
}

function extractTextFromMessage(msg: IlinkMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      const text = item.text_item.text;
      const refTitle = item.ref_msg?.title;
      parts.push(refTitle ? `[引用: ${refTitle}]\n${text}` : text);
    }
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      parts.push(item.voice_item.text);
    }
  }
  return parts.join("\n").trim();
}

function safeUserFileName(userId: string): string {
  return Buffer.from(userId, "utf-8").toString("base64url");
}

function detectImageExtension(buf: Buffer): string {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return ".jpg";
  if (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a") return ".gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  return ".img";
}

function extensionForVoice(voice?: VoiceItem): string {
  if (voice?.encode_type === VOICE_ENCODE_SILK) return ".silk";
  if (voice?.encode_type === VOICE_ENCODE_MP3) return ".mp3";
  if (voice?.encode_type === VOICE_ENCODE_AMR) return ".amr";
  if (voice?.encode_type === VOICE_ENCODE_OGG_SPEEX) return ".ogg";
  if (voice?.encode_type === VOICE_ENCODE_PCM) return ".pcm";
  return ".voice";
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\/\\:\0]/g, "_").trim() || "file.bin";
}

function saveInboundMediaFile(params: {
  stateDir: string;
  senderId: string;
  kind: SavedMediaFile["kind"];
  data: Buffer;
  ext: string;
  transcript?: string;
  fileName?: string;
  encodeType?: number;
  playtimeMs?: number;
}): SavedMediaFile {
  const dir = path.join(params.stateDir, "media", safeUserFileName(params.senderId));
  mkdirSync(dir, { recursive: true });
  const safeOriginal = params.fileName ? `-${sanitizeFileName(params.fileName)}` : "";
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}-${params.kind}${safeOriginal}${safeOriginal ? "" : params.ext}`;
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, params.data);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort only.
  }
  return {
    kind: params.kind,
    path: filePath,
    bytes: params.data.length,
    transcript: params.transcript,
    fileName: params.fileName,
    encodeType: params.encodeType,
    playtimeMs: params.playtimeMs,
  };
}

async function downloadMediaFromItem(params: {
  account: Account;
  cdnBaseUrl: string;
  stateDir: string;
  senderId: string;
  item: IlinkItem;
}): Promise<SavedMediaFile | null> {
  const item = params.item;
  if (item.type === MSG_ITEM_IMAGE && item.image_item?.media?.encrypt_query_param) {
    const data = await downloadAndDecrypt(params.cdnBaseUrl, item.image_item.media, item.image_item.aeskey);
    return saveInboundMediaFile({
      stateDir: params.stateDir,
      senderId: params.senderId,
      kind: "image",
      data,
      ext: detectImageExtension(data),
    });
  }

  if (item.type === MSG_ITEM_VOICE && item.voice_item?.media?.encrypt_query_param) {
    const data = await downloadAndDecrypt(params.cdnBaseUrl, item.voice_item.media);
    return saveInboundMediaFile({
      stateDir: params.stateDir,
      senderId: params.senderId,
      kind: "voice",
      data,
      ext: extensionForVoice(item.voice_item),
      transcript: item.voice_item.text,
      encodeType: item.voice_item.encode_type,
      playtimeMs: item.voice_item.playtime,
    });
  }

  if (item.type === MSG_ITEM_FILE && item.file_item?.media?.encrypt_query_param) {
    const data = await downloadAndDecrypt(params.cdnBaseUrl, item.file_item.media);
    const originalName = item.file_item.file_name ? sanitizeFileName(item.file_item.file_name) : undefined;
    return saveInboundMediaFile({
      stateDir: params.stateDir,
      senderId: params.senderId,
      kind: "file",
      data,
      ext: originalName ? "" : ".bin",
      fileName: originalName,
    });
  }

  if (item.type === MSG_ITEM_VIDEO && item.video_item?.media?.encrypt_query_param) {
    const data = await downloadAndDecrypt(params.cdnBaseUrl, item.video_item.media);
    return saveInboundMediaFile({
      stateDir: params.stateDir,
      senderId: params.senderId,
      kind: "video",
      data,
      ext: ".mp4",
    });
  }

  return null;
}

async function downloadInboundMediaFiles(params: {
  account: Account;
  options: RuntimeOptions;
  senderId: string;
  msg: IlinkMessage;
}): Promise<SavedMediaFile[]> {
  const files: SavedMediaFile[] = [];
  for (const item of params.msg.item_list ?? []) {
    if (item.type !== MSG_ITEM_IMAGE && item.type !== MSG_ITEM_VOICE && item.type !== MSG_ITEM_FILE && item.type !== MSG_ITEM_VIDEO) {
      continue;
    }
    try {
      const file = await downloadMediaFromItem({
        account: params.account,
        cdnBaseUrl: params.options.cdnBaseUrl,
        stateDir: params.options.stateDir,
        senderId: params.senderId,
        item,
      });
      if (file) files.push(file);
    } catch (error) {
      console.error(`媒体下载失败: sender=${params.senderId} type=${item.type} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return files;
}

function historyFile(stateDir: string, userId: string): string {
  return path.join(stateDir, "history", `${safeUserFileName(userId)}.json`);
}

function loadHistory(stateDir: string, userId: string): HistoryItem[] {
  const file = historyFile(stateDir, userId);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as HistoryItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(stateDir: string, userId: string, history: HistoryItem[]): void {
  const file = historyFile(stateDir, userId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(history, null, 2), "utf-8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort only.
  }
}

function appendHistory(stateDir: string, userId: string, role: HistoryItem["role"], text: string, historyLimit: number): void {
  const history = loadHistory(stateDir, userId);
  history.push({ role, text, at: new Date().toISOString() });
  saveHistory(stateDir, userId, history.slice(-historyLimit * 2));
}

function buildCodexPrompt(senderId: string, message: string, history: HistoryItem[]): string {
  const recent = history.length
    ? history.map((item) => `${item.role === "user" ? "用户" : "Codex"}: ${item.text}`).join("\n")
    : "无";

  return [
    "你是通过个人微信接入的 Codex 助手。你正在回复真实微信用户。",
    "",
    "回复要求：",
    "- 默认用中文回复；如果用户使用其他语言，就跟随用户语言。",
    "- 直接输出要发回微信的正文，不要输出解释性前缀。",
    "- 保持简洁，避免 Markdown 表格、代码块和复杂排版，除非用户明确要求。",
    "- 如果用户要求执行本机或代码仓库操作，而当前上下文不足，请说明需要的路径或确认信息。",
    "",
    `微信 sender_id: ${senderId}`,
    "",
    "最近对话：",
    recent,
    "",
    "当前用户消息：",
    message,
  ].join("\n");
}

async function runCodexForReply(senderId: string, message: string, options: RuntimeOptions): Promise<string> {
  if (options.mockReply) return options.mockReply.replaceAll("{message}", message);

  const history = loadHistory(options.stateDir, senderId);
  const prompt = buildCodexPrompt(senderId, message, history);
  const tmpDir = path.join(options.stateDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const outputFile = path.join(tmpDir, `codex-reply-${Date.now()}-${randomBytes(4).toString("hex")}.txt`);

  const cmd = [
    options.codexBin,
    "--ask-for-approval",
    "never",
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    options.codexSandbox,
    "--color",
    "never",
    "--output-last-message",
    outputFile,
    "-C",
    options.workspace,
  ];

  if (!options.persistCodexSessions) cmd.push("--ephemeral");
  if (options.codexModel) cmd.push("-m", options.codexModel);
  cmd.push(prompt);

  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
  }, options.codexTimeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timeout);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  if (timedOut) {
    throw new Error(`codex exec timed out after ${options.codexTimeoutMs}ms`);
  }
  if (exitCode !== 0) {
    throw new Error(`codex exec failed with code ${exitCode}: ${stderr || stdout}`.slice(0, 2000));
  }

  const finalMessage = existsSync(outputFile) ? readFileSync(outputFile, "utf-8").trim() : "";
  if (existsSync(outputFile)) {
    try {
      chmodSync(outputFile, 0o600);
    } catch {
      // Best effort only.
    }
  }
  const fallback = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const reply = (finalMessage || fallback).trim();
  if (!reply) throw new Error("codex exec returned an empty reply");
  return reply;
}

async function getUpdates(account: Account, getUpdatesBuf: string): Promise<IlinkUpdates> {
  try {
    return await apiPost<IlinkUpdates>(
      account.baseUrl,
      "ilink/bot/getupdates",
      account.token,
      {
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      LONG_POLL_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw error;
  }
}

async function sendTextMessage(account: Account, toUserId: string, text: string, contextToken: string): Promise<string> {
  const clientId = `codex-wechat:${Date.now()}-${randomBytes(4).toString("hex")}`;
  await apiPost(
    account.baseUrl,
    "ilink/bot/sendmessage",
    account.token,
    {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    },
    15_000,
  );
  return clientId;
}

async function sendImageMessage(params: {
  account: Account;
  cdnBaseUrl: string;
  toUserId: string;
  imagePath: string;
  contextToken: string;
}): Promise<string> {
  const uploaded = await uploadMediaFile({
    account: params.account,
    cdnBaseUrl: params.cdnBaseUrl,
    toUserId: params.toUserId,
    filePath: params.imagePath,
    mediaType: UPLOAD_MEDIA_IMAGE,
  });
  const clientId = `codex-wechat:${Date.now()}-${randomBytes(4).toString("hex")}`;
  await apiPost(
    params.account.baseUrl,
    "ilink/bot/sendmessage",
    params.account.token,
    {
      msg: {
        from_user_id: "",
        to_user_id: params.toUserId,
        client_id: clientId,
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [
          {
            type: MSG_ITEM_IMAGE,
            image_item: {
              media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: mediaAesKeyBase64(uploaded.aeskey),
                encrypt_type: 1,
              },
              mid_size: uploaded.fileSizeCiphertext,
            },
          },
        ],
        context_token: params.contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    },
    15_000,
  );
  return clientId;
}

async function sendReplyMessage(params: {
  account: Account;
  options: RuntimeOptions;
  toUserId: string;
  reply: string;
  contextToken: string;
}): Promise<string[]> {
  const parsed = parseReplyMediaDirectives(params.reply);
  const messageIds: string[] = [];
  if (parsed.text || !parsed.media.length) {
    messageIds.push(await sendTextMessage(params.account, params.toUserId, parsed.text || params.reply, params.contextToken));
  }

  for (const media of parsed.media) {
    if (media.kind === "image") {
      messageIds.push(
        await sendImageMessage({
          account: params.account,
          cdnBaseUrl: params.options.cdnBaseUrl,
          toUserId: params.toUserId,
          imagePath: media.path,
          contextToken: params.contextToken,
        }),
      );
      continue;
    }

    messageIds.push(
      await sendTextMessage(
        params.account,
        params.toUserId,
        `语音文件已生成，但当前 bridge 还没有实现语音发送：${media.path}`,
        params.contextToken,
      ),
    );
  }

  return messageIds;
}

async function commandQR(options: RuntimeOptions): Promise<void> {
  const qr = await fetchQRCode(options.baseUrl);
  const qrFile = await renderLoginQRCode(options.stateDir, qr.qrcode_img_content);
  console.log(`qrcode: ${qr.qrcode}`);
  console.log(`link: ${qr.qrcode_img_content}`);
  console.log(`png: ${qrFile}`);
}

async function commandSetup(options: RuntimeOptions, args: Args): Promise<void> {
  if (existsSync(accountFile(options.stateDir)) && !args.force) {
    const existing = JSON.parse(readFileSync(accountFile(options.stateDir), "utf-8")) as Account;
    console.log(`已有凭据: ${existing.accountId ?? "(unknown account)"}`);
    console.log(`路径: ${accountFile(options.stateDir)}`);
    console.log("如需重新扫码，追加 --force。");
    return;
  }

  console.log("正在获取微信登录二维码...");
  const qr = await fetchQRCode(options.baseUrl);
  const qrFile = await renderLoginQRCode(options.stateDir, qr.qrcode_img_content);
  console.log("请用 iOS 微信扫描上方二维码；如果扫码不行，再尝试打开这个链接：");
  console.log(qr.qrcode_img_content);
  console.log(`二维码图片: ${qrFile}`);
  console.log("等待扫码确认，最长 8 分钟。");

  const deadline = Date.now() + 480_000;
  let scanPrinted = false;
  while (Date.now() < deadline) {
    const status = await pollQRStatus(options.baseUrl, qr.qrcode);
    if (status.status === "confirmed") {
      if (!status.bot_token || !status.ilink_bot_id) {
        throw new Error("登录确认成功，但服务器没有返回 bot_token 或 ilink_bot_id。");
      }
      const account: Account = {
        token: status.bot_token,
        baseUrl: status.baseurl || options.baseUrl,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        savedAt: new Date().toISOString(),
      };
      saveAccount(options.stateDir, account);
      console.log("登录成功。");
      console.log(`凭据保存至: ${accountFile(options.stateDir)}`);
      return;
    }
    if (status.status === "expired") {
      throw new Error("二维码已过期，请重新运行 setup。");
    }
    if (status.status === "scaned" && !scanPrinted) {
      console.log("已扫码，请在微信里确认。");
      scanPrinted = true;
    }
    process.stdout.write(".");
    await sleep(1_000);
  }
  throw new Error("等待扫码超时。");
}

async function commandAsk(options: RuntimeOptions, args: Args): Promise<void> {
  const message = optionString(args, "message", args._.slice(1).join(" ").trim());
  if (!message) {
    throw new Error('ask 需要 --message "..." 或直接追加消息文本。');
  }
  const senderId = optionString(args, "sender-id", "local-test@im.wechat");
  let reply: string;
  if (options.backend === "app-server" && !options.mockReply) {
    const projects = loadProjectRegistry({
      workspace: options.workspace,
      projectsConfig: loadProjectsConfig(options.projectsFile),
    });
    const projectName = projects.defaultProject;
    const project = projects.projects[projectName];
    const mode = project.defaultMode;
    const model = project.model ?? options.codexModel;
    const appServer = new CodexAppServerClient(options);
    try {
      const run = await appServer.runTurn({
        cwd: project.cwd,
        mode,
        model,
        projectName,
        input: buildWechatTurnInput({
          senderId,
          projectName,
          mode,
          model,
          text: message,
        }),
      });
      reply = run.reply;
    } finally {
      appServer.stop();
    }
  } else {
    reply = await runCodexForReply(senderId, message, options);
  }
  console.log(reply);
}

async function commandStart(options: RuntimeOptions): Promise<void> {
  const account = loadAccount(options.stateDir);
  const projects = loadProjectRegistry({
    workspace: options.workspace,
    projectsConfig: loadProjectsConfig(options.projectsFile),
  });
  const bridgeState = loadBridgeState(options.stateDir);
  const appServer = options.backend === "app-server" ? new CodexAppServerClient(options) : null;
  mkdirSync(options.stateDir, { recursive: true });
  let getUpdatesBuf = existsSync(syncBufFile(options.stateDir))
    ? readFileSync(syncBufFile(options.stateDir), "utf-8")
    : "";
  let consecutiveFailures = 0;

  console.log("开始监听微信消息。");
  console.log(`state: ${options.stateDir}`);
  console.log(`backend: ${options.backend}`);
  console.log(`default project: ${projects.defaultProject}`);
  console.log(`projects: ${Object.keys(projects.projects).join(", ")}`);
  if (options.dryRun) console.log("dry-run 已开启：只生成回复，不调用 sendmessage。");

  while (true) {
    try {
      const updates = await getUpdates(account, getUpdatesBuf);
      const isError = (updates.ret !== undefined && updates.ret !== 0) || (updates.errcode !== undefined && updates.errcode !== 0);
      if (isError) {
        consecutiveFailures += 1;
        console.error(`getupdates 失败: ret=${updates.ret} errcode=${updates.errcode} errmsg=${updates.errmsg ?? ""}`);
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
        continue;
      }

      consecutiveFailures = 0;
      if (updates.get_updates_buf) {
        getUpdatesBuf = updates.get_updates_buf;
        writeFileSync(syncBufFile(options.stateDir), getUpdatesBuf, "utf-8");
      }

      for (const msg of updates.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;
        const senderId = msg.from_user_id ?? "";
        const contextToken = msg.context_token ?? "";
        const text = extractTextFromMessage(msg);
        const hasMedia = (msg.item_list ?? []).some((item) =>
          item.type === MSG_ITEM_IMAGE || item.type === MSG_ITEM_VOICE || item.type === MSG_ITEM_FILE || item.type === MSG_ITEM_VIDEO
        );
        if (!senderId || (!text && !hasMedia)) continue;
        if (!contextToken) {
          console.error(`跳过消息：缺少 context_token，sender=${senderId}`);
          continue;
        }
        if (projects.allowedSenderIds.length && !projects.allowedSenderIds.includes(senderId)) {
          console.error(`跳过未授权 sender: ${senderId}`);
          continue;
        }

        console.log(`收到消息: sender=${senderId} text=${text.slice(0, 120)}`);
        try {
          const mediaFiles = hasMedia
            ? await downloadInboundMediaFiles({
                account,
                options,
                senderId,
                msg,
              })
            : [];
          const parsed = mediaFiles.length ? ({ type: "message", text } as const) : parseBridgeCommand(text);
          let reply: string;

          if (parsed.type !== "message") {
            const commandResult = applyBridgeCommand(bridgeState, projects, senderId, parsed);
            saveBridgeState(options.stateDir, bridgeState);
            reply = commandResult.reply;
          } else {
            const sender = senderState(bridgeState, senderId);
            const projectName = activeProjectName(bridgeState, projects, senderId);
            const project = projects.projects[projectName];
            const mode = activeMode(bridgeState, projects, senderId);
            const model = activeModel(bridgeState, projects, senderId, projectName) ?? options.codexModel;
            const input = buildWechatTurnInput({
              senderId,
              projectName,
              mode,
              model,
              text: parsed.text || "[WeChat media message]",
              mediaFiles,
            });

            if (appServer) {
              const existingSession = sender.sessions[projectName];
              const run = await appServer.runTurn({
                threadId: existingSession?.threadId,
                cwd: project.cwd,
                mode,
                model,
                input,
                projectName,
              });
              sender.sessions[projectName] = {
                threadId: run.threadId,
                cwd: project.cwd,
                mode,
              };
              saveBridgeState(options.stateDir, bridgeState);
              reply = run.reply;
            } else {
              const execOptions: RuntimeOptions = {
                ...options,
                workspace: project.cwd,
                codexSandbox: legacySandboxForMode(mode),
                codexModel: model,
              };
              reply = await runCodexForReply(senderId, input, execOptions);
              appendHistory(options.stateDir, senderId, "user", buildInboundUserMessageText({ messageText: text, mediaFiles }), options.historyLimit);
              appendHistory(options.stateDir, senderId, "assistant", reply, options.historyLimit);
            }
          }
          console.log(`Codex 回复: ${reply.slice(0, 240)}`);

          if (!options.dryRun) {
            const clientIds = await sendReplyMessage({ account, options, toUserId: senderId, reply, contextToken });
            console.log(`已发送: client_id=${clientIds.join(",")}`);
          }
        } catch (error) {
          const reply = formatBridgeError(error, options.codexTimeoutMs);
          console.error(`消息处理失败: sender=${senderId} error=${error instanceof Error ? error.message : String(error)}`);
          if (!options.dryRun) {
            try {
              const clientId = await sendTextMessage(account, senderId, reply, contextToken);
              console.log(`已发送错误提示: client_id=${clientId}`);
            } catch (sendError) {
              console.error(`错误提示发送失败: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
            }
          }
        }
      }
    } catch (error) {
      consecutiveFailures += 1;
      console.error(`轮询异常: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
    }
  }
}

function printHelp(): void {
  console.log(`Codex WeChat iLink demo

Usage:
  bun codex-wechat-ilink.ts qr [--state-dir PATH]
  bun codex-wechat-ilink.ts setup [--force] [--state-dir PATH]
  bun codex-wechat-ilink.ts start [--workspace PATH] [--dry-run]
  bun codex-wechat-ilink.ts ask --message "..." [--mock-reply "..."]

Common options:
  --state-dir PATH             Default: ~/.codex/channels/wechat
  --base-url URL               Default: ${DEFAULT_BASE_URL}
  --workspace PATH             Codex working directory, default: current directory
  --projects PATH              Projects config JSON for /project routing
  --backend app-server|exec    Default: app-server
  --app-server-logs            Print codex app-server stderr logs
  --codex-bin PATH             Default: codex
  --model MODEL                Optional startup-level Codex model default
  --codex-timeout-ms N         Default: 120000

WeChat commands:
  /projects
  /project <name>
  /mode read|write|bypass
  /model
  /model <model>
  /model default
  /status
  /new
`);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const command = args._[0] || "help";
  const options = runtimeOptions(args);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "qr") {
    await commandQR(options);
  } else if (command === "setup") {
    await commandSetup(options, args);
  } else if (command === "ask") {
    await commandAsk(options, args);
  } else if (command === "start") {
    await commandStart(options);
  } else {
    printHelp();
    throw new Error(`Unknown command: ${command}`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
