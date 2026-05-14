#!/usr/bin/env bun
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_PRODUCT_STATE_DIR = path.join(os.homedir(), ".codex-wechat-handoff");
const DAEMON_LABEL = "com.codex-wechat-handoff.daemon";
const BOT_TYPE = "3";
const CHANNEL_VERSION = "0.1.0";
const LONG_POLL_TIMEOUT_MS = 40_000;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const MESSAGE_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const BRIDGE_LOCK_STALE_MS = 120_000;
const BRIDGE_LOCK_HEARTBEAT_MS = 30_000;
const MAX_WECHAT_TEXT_CHARS = 3500;
const MAX_PENDING_DESKTOP_TRANSCRIPT_CHARS = 24_000;
const CODEX_CONTEXT_HIGH_PERCENT = 80;
const CODEX_CONTEXT_BLOCK_PERCENT = 95;
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

export type BridgeMode = "read" | "write" | "fullaccess";
export type StoredBridgeMode = BridgeMode | "bypass";

export type ProjectConfig = {
  cwd: string;
  defaultMode?: StoredBridgeMode;
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
  mode: StoredBridgeMode;
};

export type CodexSessionCursor = {
  threadId: string;
  file: string;
  size: number;
  mtimeMs: number;
};

export type CodexContextPressureStatus = "unknown" | "ok" | "high" | "critical" | "saturated";

export type CodexContextPressure = {
  threadId: string;
  status: CodexContextPressureStatus;
  reason: "no_session_file" | "no_token_usage" | "context_usage" | "context_limit_empty_reply";
  file?: string;
  usedTokens?: number;
  contextWindow?: number;
  percent?: number;
  lastUsageTokens?: number;
  totalUsageTokens?: number;
  emptyTaskComplete?: boolean;
};

export type SenderProjectRoute = RouteRuntimeState & {
  activeSurface?: "desktop" | "wechat";
  attachedThreadId?: string;
  mobileThreadId?: string;
  attachedFrom?: "desktop" | "wechat";
  attachedAt?: string;
  parkedThreadId?: string;
  lastDesktopPullAt?: string | null;
  lastWeChatTurnAt?: string | null;
  pendingDeltaId?: string | null;
  sessionCursor?: CodexSessionCursor;
  mobileStartCursor?: CodexSessionCursor;
  lastMobilePullCursor?: CodexSessionCursor;
  desktopBaselineCursor?: CodexSessionCursor;
  pendingDesktopTranscript?: string | null;
  pendingMobileTranscript?: string | null;
  pendingMobileTranscriptCursor?: CodexSessionCursor | null;
  needsReconcile?: boolean;
  desktopActivityDetectedAt?: string | null;
};

export type FinishRunOffer = {
  threadId: string;
  projectName: string;
  cwd: string;
  mode: BridgeMode;
  model?: string;
  message?: string;
  summary?: string;
  nextAction?: string;
  createdAt: string;
  sessionCursor?: CodexSessionCursor;
  needsMobilePull?: boolean;
};

export type FinishNotificationState = {
  enabled?: boolean;
  pendingOffer?: FinishRunOffer | null;
};

export type SenderState = {
  activeProject?: string;
  activeMode?: StoredBridgeMode;
  projectModels?: Record<string, string>;
  routes?: Record<string, SenderProjectRoute>;
  threadFinishNotifications?: Record<string, FinishNotificationState>;
  lastFinishNotificationThreadId?: string;
  finishNotifications?: FinishNotificationState;
  lastSeenAt?: string;
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
  | { type: "health" }
  | { type: "current" }
  | { type: "sessions" }
  | { type: "attach"; target: string }
  | { type: "back" }
  | { type: "resume" }
  | { type: "continue" }
  | { type: "detach" }
  | { type: "history"; count: number }
  | { type: "notify"; action: "on" | "off" | "status" }
  | { type: "onboarding" }
  | { type: "intro" }
  | { type: "help" }
  | { type: "stop" }
  | { type: "status" }
  | { type: "new" }
  | { type: "error"; message: string };

type AppServerSandboxPolicy =
  | { type: "readOnly"; networkAccess: true }
  | { type: "workspaceWrite"; networkAccess: true; writableRoots: string[] }
  | { type: "dangerFullAccess" };

type AppServerRunResult = {
  threadId: string;
  reply: string;
};

type AppServerForkResult = {
  threadId: string;
  cursor?: CodexSessionCursor;
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
  fileMd5: string;
};

type ReplyMediaDirective = {
  kind: "image" | "voice" | "file";
  path: string;
  playtimeMs?: number;
};

type HtmlRendererSelection =
  | { kind: "chrome"; executable: string; pdfMode: "vector" }
  | { kind: "quicklook"; pdfMode: "image" };

type HtmlRendererRequest = "auto" | "chrome" | "quicklook";

type AppServerRequest = {
  id: number;
  method: string;
  params?: unknown;
};

type BridgeEvent = {
  type: string;
  at: string;
  data?: Record<string, unknown>;
};

type BridgeLockOwner = {
  pid: number;
  command: string;
  stateDir: string;
  projectsFile?: string;
  startedAt: string;
  heartbeatAt: string;
};

export type RouteLeaseState = "wechat_active" | "desktop_active" | "pending_desktop_pull";

export type DeferredRouteMessage = {
  senderId: string;
  text: string;
  receivedAt: string;
};

export type RouteRuntimeState = {
  leaseState?: RouteLeaseState;
  activeTurn?: {
    turnId: string;
    origin: "wechat" | "desktop";
    startedAt: string;
  } | null;
  deferredQueue?: DeferredRouteMessage[];
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

function defaultProjectsFile(stateDir: string): string {
  return path.join(stateDir, "projects.json");
}

function resolveDefaultStateDir(args: Args): string {
  return path.resolve(expandHome(optionString(args, "state-dir", DEFAULT_PRODUCT_STATE_DIR)));
}

function runtimeOptions(args: Args): RuntimeOptions {
  const stateDir = resolveDefaultStateDir(args);
  return {
    stateDir,
    baseUrl: optionString(args, "base-url", DEFAULT_BASE_URL),
    cdnBaseUrl: optionString(args, "cdn-base-url", DEFAULT_CDN_BASE_URL),
    workspace: path.resolve(expandHome(optionString(args, "workspace", process.cwd()))),
    projectsFile: typeof args.projects === "string" ? path.resolve(expandHome(args.projects)) : defaultProjectsFile(stateDir),
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

function isExecutablePath(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function findCommandOnPath(command: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (isExecutablePath(candidate)) return candidate;
  }
  return null;
}

function findChromeExecutable(): string | null {
  const envPath = process.env.CODEX_WECHAT_CHROME ? expandHome(process.env.CODEX_WECHAT_CHROME) : "";
  const candidates = [
    envPath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    findCommandOnPath("google-chrome"),
    findCommandOnPath("chromium"),
    findCommandOnPath("chromium-browser"),
    findCommandOnPath("msedge"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(isExecutablePath) ?? null;
}

function findMacTool(name: string): string | null {
  return findCommandOnPath(name) ?? (isExecutablePath(`/usr/bin/${name}`) ? `/usr/bin/${name}` : null);
}

export function chooseHtmlRenderer(params: {
  requested: HtmlRendererRequest;
  needPdf: boolean;
  needPng: boolean;
  chromeExecutable: string | null;
  quickLookAvailable: boolean;
  sipsAvailable: boolean;
}): HtmlRendererSelection {
  const quicklookCanRender = params.quickLookAvailable && (!params.needPdf || params.sipsAvailable);
  if (params.requested === "chrome") {
    if (!params.chromeExecutable) throw new Error("Chrome renderer requested, but no Chrome/Chromium/Edge executable was found.");
    return { kind: "chrome", executable: params.chromeExecutable, pdfMode: "vector" };
  }
  if (params.requested === "quicklook") {
    if (!quicklookCanRender) throw new Error("Quick Look renderer requested, but qlmanage/sips is unavailable for the requested outputs.");
    return { kind: "quicklook", pdfMode: "image" };
  }
  if (params.chromeExecutable) return { kind: "chrome", executable: params.chromeExecutable, pdfMode: "vector" };
  if (quicklookCanRender) return { kind: "quicklook", pdfMode: "image" };
  throw new Error("No HTML renderer available. Install Chrome/Chromium/Edge, or use macOS qlmanage + sips fallback.");
}

function fileHasContent(filePath: string): boolean {
  try {
    return statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function ensureParentDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function resolveWorkspacePath(workspace: string, rawPath: string): string {
  const expanded = expandHome(rawPath);
  return path.isAbsolute(expanded) ? expanded : path.resolve(workspace, expanded);
}

function defaultRenderOutputPath(htmlPath: string, ext: ".pdf" | ".png"): string {
  const parsed = path.parse(htmlPath);
  const base = [".html", ".htm"].includes(parsed.ext.toLowerCase()) ? path.join(parsed.dir, parsed.name) : htmlPath;
  return `${base}${ext}`;
}

function parseViewport(raw: string): { width: number; height: number } {
  const match = raw.match(/^(\d+)x(\d+)$/i);
  if (!match) return { width: 1400, height: 1000 };
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 320 || height < 320) {
    return { width: 1400, height: 1000 };
  }
  return { width, height };
}

function spawnSyncChecked(command: string, args: string[]): void {
  const result = Bun.spawnSync({
    cmd: [command, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    const stdout = result.stdout.toString().trim();
    throw new Error(`${path.basename(command)} failed with exit ${result.exitCode}: ${(stderr || stdout).slice(0, 800)}`);
  }
}

function spawnSyncResult(command: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [command, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function runCommandUntilOutputs(command: string, args: string[], outputs: string[], timeoutMs: number): Promise<void> {
  const proc = Bun.spawn([command, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  let exited = false;
  let exitCode: number | null = null;
  proc.exited
    .then((code) => {
      exited = true;
      exitCode = code;
    })
    .catch(() => {
      exited = true;
      exitCode = -1;
    });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (outputs.every(fileHasContent)) {
      if (!exited) {
        proc.kill("SIGTERM");
        await proc.exited.catch(() => {});
      }
      return;
    }
    if (exited) break;
    await sleep(200);
  }

  if (!exited) {
    proc.kill("SIGTERM");
    await proc.exited.catch(() => {});
  }
  if (outputs.every(fileHasContent)) return;
  const missing = outputs.filter((output) => !fileHasContent(output)).join(", ");
  throw new Error(`${path.basename(command)} did not create expected output before timeout. exit=${exitCode ?? "timeout"} missing=${missing}`);
}

async function renderHtmlWithChrome(params: {
  chromeExecutable: string;
  htmlPath: string;
  pdfPath: string | null;
  pngPath: string | null;
  viewport: { width: number; height: number };
  timeoutMs: number;
}): Promise<void> {
  const htmlUrl = pathToFileURL(params.htmlPath).href;
  const baseFlags = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
  ];

  if (params.pdfPath) {
    ensureParentDir(params.pdfPath);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), "codex-wechat-chrome-pdf-"));
    try {
      await runCommandUntilOutputs(
        params.chromeExecutable,
        [...baseFlags, `--user-data-dir=${userDataDir}`, `--print-to-pdf=${params.pdfPath}`, htmlUrl],
        [params.pdfPath],
        params.timeoutMs,
      );
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }

  if (params.pngPath) {
    ensureParentDir(params.pngPath);
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), "codex-wechat-chrome-png-"));
    try {
      await runCommandUntilOutputs(
        params.chromeExecutable,
        [
          ...baseFlags,
          `--user-data-dir=${userDataDir}`,
          `--window-size=${params.viewport.width},${params.viewport.height}`,
          `--screenshot=${params.pngPath}`,
          htmlUrl,
        ],
        [params.pngPath],
        params.timeoutMs,
      );
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }
}

function renderHtmlWithQuickLook(params: {
  qlmanage: string;
  sips: string | null;
  htmlPath: string;
  pdfPath: string | null;
  pngPath: string | null;
  viewport: { width: number; height: number };
}): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "codex-wechat-quicklook-"));
  try {
    spawnSyncChecked(params.qlmanage, ["-t", "-s", String(params.viewport.width), "-o", tempDir, params.htmlPath]);
    const expected = path.join(tempDir, `${path.basename(params.htmlPath)}.png`);
    const generated =
      fileHasContent(expected)
        ? expected
        : readdirSync(tempDir)
            .map((name) => path.join(tempDir, name))
            .find((candidate) => candidate.toLowerCase().endsWith(".png") && fileHasContent(candidate));
    if (!generated) throw new Error("Quick Look did not generate a PNG thumbnail.");

    if (params.pngPath) {
      ensureParentDir(params.pngPath);
      copyFileSync(generated, params.pngPath);
    }
    if (params.pdfPath) {
      if (!params.sips) throw new Error("sips is required to wrap Quick Look PNG output as PDF.");
      ensureParentDir(params.pdfPath);
      spawnSyncChecked(params.sips, ["-s", "format", "pdf", generated, "--out", params.pdfPath]);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export function buildLaunchAgentPlist(params: {
  label: string;
  bunBin: string;
  scriptPath: string;
  stateDir: string;
  projectsFile: string;
  codexBin: string;
  workingDirectory: string;
  logDir: string;
  homeDir: string;
}): string {
  const pathValue = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(params.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(params.bunBin)}</string>
    <string>${xmlEscape(params.scriptPath)}</string>
    <string>start</string>
    <string>--state-dir</string>
    <string>${xmlEscape(params.stateDir)}</string>
    <string>--projects</string>
    <string>${xmlEscape(params.projectsFile)}</string>
    <string>--backend</string>
    <string>app-server</string>
    <string>--codex-bin</string>
    <string>${xmlEscape(params.codexBin)}</string>
    <string>--codex-timeout-ms</string>
    <string>600000</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(params.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(params.homeDir)}</string>
    <key>PATH</key>
    <string>${xmlEscape(pathValue)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(params.logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(params.logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

function accountFile(stateDir: string): string {
  return path.join(stateDir, "account.json");
}

function syncBufFile(stateDir: string): string {
  return path.join(stateDir, "sync_buf.txt");
}

function contextTokenFile(stateDir: string): string {
  return path.join(stateDir, "context_tokens.json");
}

function messageClaimsDir(stateDir: string): string {
  return path.join(stateDir, "message_claims");
}

function bridgeLockFile(stateDir: string): string {
  return path.join(stateDir, "bridge.lock.json");
}

function bridgeEventsFile(stateDir: string): string {
  return path.join(stateDir, "events.jsonl");
}

function bridgeStateFile(stateDir: string): string {
  return path.join(stateDir, "sessions.json");
}

export function createBridgeState(): BridgeState {
  return { senders: {} };
}

export function loadContextTokenCache(stateDir: string): Record<string, string> {
  const file = contextTokenFile(stateDir);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const [senderId, token] of Object.entries(parsed ?? {})) {
      if (typeof token === "string" && token.trim()) result[senderId] = token;
    }
    return result;
  } catch {
    return {};
  }
}

function saveContextTokenCache(stateDir: string, cache: Record<string, string>): void {
  mkdirSync(stateDir, { recursive: true });
  const file = contextTokenFile(stateDir);
  writeFileSync(file, JSON.stringify(cache, null, 2), "utf-8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort only.
  }
}

export function cacheContextToken(stateDir: string, senderId: string, contextToken: string): void {
  if (!senderId.trim() || !contextToken.trim()) return;
  const cache = loadContextTokenCache(stateDir);
  cache[senderId] = contextToken;
  saveContextTokenCache(stateDir, cache);
}

export function resolveCachedContextToken(stateDir: string, senderId: string): string | null {
  return loadContextTokenCache(stateDir)[senderId] ?? null;
}

export function resolveProactiveContextToken(
  stateDir: string,
  senderId: string,
  options: { allowEmptyFallback?: boolean } = {},
): { contextToken: string | null; source: "cache" | "empty_fallback" | "missing" } {
  const cached = resolveCachedContextToken(stateDir, senderId);
  if (cached !== null) return { contextToken: cached, source: "cache" };
  if (options.allowEmptyFallback) return { contextToken: "", source: "empty_fallback" };
  return { contextToken: null, source: "missing" };
}

export function clearContextTokenCache(stateDir: string): void {
  rmSync(contextTokenFile(stateDir), { force: true });
}

function clearSyncBuffer(stateDir: string): void {
  rmSync(syncBufFile(stateDir), { force: true });
}

function clearSetupState(stateDir: string): void {
  clearSyncBuffer(stateDir);
  clearContextTokenCache(stateDir);
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function messageClaimFile(stateDir: string, messageKey: string): string {
  return path.join(messageClaimsDir(stateDir), `${sha1(messageKey)}.json`);
}

export function tryClaimInboundMessage(
  stateDir: string,
  messageKey: string,
  options: { nowMs?: number; ttlMs?: number } = {},
): boolean {
  if (!messageKey.trim()) return false;
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? MESSAGE_CLAIM_TTL_MS;
  const claimPath = messageClaimFile(stateDir, messageKey);

  const attempt = (): boolean => {
    mkdirSync(path.dirname(claimPath), { recursive: true });
    const handle = openSync(claimPath, "wx");
    try {
      writeFileSync(
        handle,
        JSON.stringify(
          {
            key: messageKey,
            claimedAt: new Date(nowMs).toISOString(),
            claimedAtMs: nowMs,
            pid: process.pid,
          },
          null,
          2,
        ),
        "utf-8",
      );
    } finally {
      closeSync(handle);
    }
    return true;
  };

  try {
    return attempt();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "EEXIST") return true;
  }

  try {
    const existing = JSON.parse(readFileSync(claimPath, "utf-8")) as { claimedAtMs?: number };
    const claimedAtMs = typeof existing.claimedAtMs === "number" ? existing.claimedAtMs : statSync(claimPath).mtimeMs;
    if (nowMs - claimedAtMs > ttlMs) {
      rmSync(claimPath, { force: true });
      return attempt();
    }
  } catch {
    rmSync(claimPath, { force: true });
    return attempt();
  }

  return false;
}

export function isIlinkSessionTimeout(response: Pick<IlinkUpdates, "errcode" | "errmsg">): boolean {
  return response.errcode === -14 || /session timeout/i.test(response.errmsg ?? "");
}

export function appendBridgeEvent(
  stateDir: string,
  event: { type: string; data?: Record<string, unknown> },
  options: { now?: string } = {},
): void {
  mkdirSync(stateDir, { recursive: true });
  const entry: BridgeEvent = {
    type: event.type,
    at: options.now ?? new Date().toISOString(),
    ...(event.data ? { data: event.data } : {}),
  };
  appendFileSync(bridgeEventsFile(stateDir), `${JSON.stringify(entry)}\n`, "utf-8");
}

export function readBridgeEvents(stateDir: string): BridgeEvent[] {
  const file = bridgeEventsFile(stateDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BridgeEvent);
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readBridgeLock(stateDir: string): BridgeLockOwner | null {
  const file = bridgeLockFile(stateDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as BridgeLockOwner;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function writeBridgeLock(stateDir: string, owner: BridgeLockOwner): void {
  mkdirSync(stateDir, { recursive: true });
  const file = bridgeLockFile(stateDir);
  writeFileSync(file, JSON.stringify(owner, null, 2), "utf-8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort only.
  }
}

export function acquireBridgeLock(
  stateDir: string,
  options: {
    pid?: number;
    command: string;
    projectsFile?: string;
    nowMs?: number;
    heartbeatStaleMs?: number;
    isPidAlive?: (pid: number) => boolean;
  },
): { acquired: boolean; owner?: BridgeLockOwner; reason?: string } {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const existing = readBridgeLock(stateDir);
  const isAlive = options.isPidAlive ?? pidAlive;
  const staleMs = options.heartbeatStaleMs ?? BRIDGE_LOCK_STALE_MS;
  if (existing) {
    const heartbeatMs = Date.parse(existing.heartbeatAt || existing.startedAt);
    const stale = Number.isFinite(heartbeatMs) ? nowMs - heartbeatMs > staleMs : true;
    if (isAlive(existing.pid) && !stale) {
      return { acquired: false, owner: existing, reason: "live_owner" };
    }
  }

  const owner: BridgeLockOwner = {
    pid: options.pid ?? process.pid,
    command: options.command,
    stateDir,
    projectsFile: options.projectsFile,
    startedAt: existing?.startedAt && existing.pid === (options.pid ?? process.pid) ? existing.startedAt : nowIso,
    heartbeatAt: nowIso,
  };
  writeBridgeLock(stateDir, owner);
  return { acquired: true, owner };
}

function heartbeatBridgeLock(stateDir: string, pid = process.pid, nowMs = Date.now()): void {
  const owner = readBridgeLock(stateDir);
  if (!owner || owner.pid !== pid) return;
  writeBridgeLock(stateDir, { ...owner, heartbeatAt: new Date(nowMs).toISOString() });
}

export function chunkTextForWechat(text: string, maxChars = MAX_WECHAT_TEXT_CHARS): string[] {
  if (!text) return [];
  if (maxChars <= 0 || text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n\n", maxChars);
    if (cut <= 0) cut = remaining.lastIndexOf("\n", maxChars);
    if (cut <= 0) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function extractAgentMessageTextFromAppServerItem(item: any): string | null {
  if (!item || typeof item !== "object") return null;
  const type = String(item.type ?? "");
  if (type !== "agentMessage" && type !== "agent_message") return null;
  if (typeof item.text === "string" && item.text.trim()) return item.text;
  if (Array.isArray(item.content)) {
    const text = item.content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
    return text.trim() ? text : null;
  }
  return null;
}

export function buildBridgeHealthReport(params: {
  daemonStartedAt: string;
  now?: string;
  stateDir: string;
  appServerStatus: "running" | "stopped" | "error";
  activeTurn: boolean;
  contextTokenCached: boolean;
  syncBufPresent: boolean;
  lockOwner?: Pick<BridgeLockOwner, "pid" | "startedAt" | "heartbeatAt"> | null;
  lastPollAt?: string | null;
  lastMessageAt?: string | null;
  lastError?: string | null;
  activeThread?: string | null;
  project?: string;
  mode?: BridgeMode;
  model?: string;
  contextPressure?: CodexContextPressure | null;
}): string {
  const nowMs = Date.parse(params.now ?? new Date().toISOString());
  const startedMs = Date.parse(params.daemonStartedAt);
  const uptimeSeconds = Number.isFinite(nowMs) && Number.isFinite(startedMs) ? Math.max(0, Math.round((nowMs - startedMs) / 1000)) : 0;
  return [
    "daemon: alive",
    `uptime_seconds: ${uptimeSeconds}`,
    `last_poll: ${params.lastPollAt ?? "none"}`,
    `last_message: ${params.lastMessageAt ?? "none"}`,
    `last_error: ${params.lastError ?? "none"}`,
    `app_server: ${params.appServerStatus}`,
    `active_turn: ${params.activeTurn ? "yes" : "no"}`,
    `active_thread: ${params.activeThread ?? "none"}`,
    ...(params.project ? [`project: ${params.project}`] : []),
    ...(params.mode ? [`mode: ${params.mode}`] : []),
    ...(params.model ? [`model: ${params.model}`] : []),
    ...(params.contextPressure ? [formatCodexContextPressureLine(params.contextPressure)] : []),
    `context_token_cached: ${params.contextTokenCached ? "yes" : "no"}`,
    `sync_buf_present: ${params.syncBufPresent ? "yes" : "no"}`,
    `message_claims_dir: ${messageClaimsDir(params.stateDir)}`,
    `events_log: ${bridgeEventsFile(params.stateDir)}`,
    `lock_owner_pid: ${params.lockOwner?.pid ?? "none"}`,
    `lock_heartbeat: ${params.lockOwner?.heartbeatAt ?? "none"}`,
  ].join("\n");
}

export function getOrdinaryWechatMessageDisposition(
  route: RouteRuntimeState,
): { action: "allow" } | { action: "block"; reason: "desktop_active" | "pending_desktop_pull" } | { action: "queue"; reason: "active_turn" } {
  if (route.leaseState === "desktop_active") return { action: "block", reason: "desktop_active" };
  if (route.leaseState === "pending_desktop_pull") return { action: "block", reason: "pending_desktop_pull" };
  if (route.activeTurn) return { action: "queue", reason: "active_turn" };
  return { action: "allow" };
}

export function buildBlockedOrdinaryWechatReply(
  reason: "desktop_active" | "pending_desktop_pull",
  route?: { needsReconcile?: boolean },
): string {
  if (reason === "desktop_active") {
    return route?.needsReconcile
      ? "这条 Codex thread 现在在 Desktop active，且存在未 pull 的手机上下文。请先回电脑运行 pull WeChat back；要从手机继续发 /resume，要退出发 /detach。"
      : "这条 Codex thread 现在在 Desktop active。要从手机继续发 /resume；要退出这次 handoff 发 /detach。";
  }
  return "这条 Codex thread 正在等待 Desktop pull。要从手机继续，发 /resume；要退出 carry-over，发 /detach。";
}

export function resolveWechatTurnThreadId(route: SenderProjectRoute | undefined, session: SenderProjectSession | undefined): string | undefined {
  if (route?.mobileThreadId) return route.mobileThreadId;
  if (route?.attachedThreadId) return undefined;
  return session?.threadId;
}

export function enqueueDeferredRouteMessage(route: RouteRuntimeState, message: DeferredRouteMessage): number {
  route.deferredQueue ??= [];
  route.deferredQueue.push(message);
  return route.deferredQueue.length;
}

export function drainDeferredRouteQueue(route: RouteRuntimeState): DeferredRouteMessage[] {
  const queued = [...(route.deferredQueue ?? [])];
  route.deferredQueue = [];
  return queued;
}

function findAgentMessageTextInJson(value: any): string | null {
  if (!value || typeof value !== "object") return null;
  const direct = extractAgentMessageTextFromAppServerItem(value);
  if (direct) return direct;
  for (const key of ["item", "payload", "params", "message", "event"]) {
    const nested = findAgentMessageTextInJson(value[key]);
    if (nested) return nested;
  }
  return null;
}

export function recoverFinalReplyFromCodexJsonl(filePath: string, threadId?: string): string | null {
  if (!existsSync(filePath)) return null;
  let latest: string | null = null;
  for (const line of readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (threadId && !line.includes(threadId)) continue;
    try {
      const parsed = JSON.parse(line);
      const text = findAgentMessageTextInJson(parsed);
      if (text?.trim()) latest = text.trim();
    } catch {
      // Ignore malformed session lines; Codex JSONL can be append-in-progress.
    }
  }
  return latest;
}

function collectJsonlFiles(root: string, files: string[] = []): string[] {
  if (!existsSync(root)) return files;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

export function recoverFinalReplyFromCodexSessionLogs(
  threadId: string,
  roots: string[] = [path.join(os.homedir(), ".codex", "sessions")],
): string | null {
  if (!threadId.trim()) return null;
  const files = roots
    .flatMap((root) => collectJsonlFiles(root))
    .map((file) => ({ file, mtimeMs: existsSync(file) ? statSync(file).mtimeMs : 0 }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 200);

  for (const { file } of files) {
    const recovered = recoverFinalReplyFromCodexJsonl(file, threadId);
    if (recovered) return recovered;
  }
  return null;
}

function textFromResponseMessagePayload(payload: any): string {
  if (!payload || typeof payload !== "object") return "";
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  if (typeof payload.text === "string") return payload.text.trim();
  return "";
}

function extractWechatPromptUserMessage(text: string): string {
  const resumedMarker = "\nNew WeChat message:\n";
  const resumedIndex = text.lastIndexOf(resumedMarker);
  if (resumedIndex !== -1) return text.slice(resumedIndex + resumedMarker.length).trim();
  const marker = "\nUser message:\n";
  const index = text.indexOf(marker);
  if (index === -1) return text.trim();
  return text.slice(index + marker.length).trim();
}

function truncateForTranscript(text: string, maxChars = 6000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function readCodexJsonlDelta(params: { threadId: string; cursor?: CodexSessionCursor; roots?: string[] }): {
  file?: string;
  cursor?: CodexSessionCursor;
  lines: string[];
} {
  const cursor = params.cursor?.threadId === params.threadId ? params.cursor : undefined;
  const current = cursor ?? findCodexSessionCursorByThread(params.threadId, params.roots);
  if (!current?.file || !existsSync(current.file)) return { lines: [] };
  const contents = readFileSync(current.file);
  const start = cursor && cursor.file === current.file ? Math.min(cursor.size, contents.length) : 0;
  return {
    file: current.file,
    cursor: {
      threadId: current.threadId,
      file: current.file,
      size: contents.length,
      mtimeMs: statSync(current.file).mtimeMs,
    },
    lines: contents.subarray(start).toString("utf-8").split(/\r?\n/).filter((line) => line.trim()),
  };
}

export function buildRawTranscriptFromCodexSession(params: {
  threadId: string;
  cursor?: CodexSessionCursor;
  roots?: string[];
  title: string;
  direction: "mobile_to_desktop" | "desktop_to_mobile";
  projectName: string;
  cwd: string;
  mode: BridgeMode;
  model?: string;
  desktopThreadId?: string;
  mobileThreadId?: string;
}): string {
  const delta = readCodexJsonlDelta({ threadId: params.threadId, cursor: params.cursor, roots: params.roots });
  const userLabel = params.direction === "mobile_to_desktop" ? "WeChat user" : "Desktop user";
  const assistantLabel = params.direction === "mobile_to_desktop" ? "Codex mobile" : "Codex desktop";
  const body: string[] = [];

  for (const line of delta.lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "response_item") continue;
    const payload = entry.payload;
    if (!payload || typeof payload !== "object") continue;
    const at = typeof entry.timestamp === "string" ? entry.timestamp : "unknown time";

    if (payload.type === "message") {
      const role = payload.role;
      const text = textFromResponseMessagePayload(payload);
      if (!text) continue;
      if (role === "user") {
        body.push(`[${at}] ${userLabel}:\n${truncateForTranscript(extractWechatPromptUserMessage(text))}`);
      } else if (role === "assistant") {
        body.push(`[${at}] ${assistantLabel}:\n${truncateForTranscript(text)}`);
      }
      continue;
    }

    if (payload.type === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const args = typeof payload.arguments === "string" ? payload.arguments : JSON.stringify(payload.arguments ?? {});
      body.push(`[${at}] Tool call:\n${name} ${truncateForTranscript(args, 2000)}`);
      continue;
    }

    if (payload.type === "function_call_output") {
      const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
      body.push(`[${at}] Tool output:\n${truncateForTranscript(output)}`);
    }
  }

  const header = [
    params.title,
    "",
    ...(params.desktopThreadId ? [`desktop thread: ${params.desktopThreadId}`] : []),
    ...(params.mobileThreadId ? [`mobile thread: ${params.mobileThreadId}`] : []),
    `project: ${params.projectName}`,
    `cwd: ${params.cwd}`,
    `mode: ${params.mode}`,
    `model: ${params.model ?? "default"}`,
    ...(delta.file ? [`rollout: ${delta.file}`] : []),
    "",
    params.direction === "mobile_to_desktop" ? "--- raw mobile turns ---" : "--- raw desktop turns ---",
    "",
  ];
  return [...header, ...(body.length ? body : ["No raw turns recorded in this delta."])].join("\n");
}

export type CodexSessionSummary = {
  threadId: string;
  cwd: string;
  file: string;
  mtimeMs: number;
  summary: string;
};

function textFromMessagePayload(payload: any): string {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.text === "string") return payload.text;
  if (Array.isArray(payload.content)) {
    return payload.content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function readCodexSessionSummary(filePath: string): CodexSessionSummary | null {
  let threadId = "";
  let cwd = "";
  let summary = "";
  for (const line of readFileSync(filePath, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session_meta" && entry.payload) {
        if (!threadId) threadId = String(entry.payload.id ?? "");
        if (!cwd) cwd = String(entry.payload.cwd ?? "");
      }
      const payload = entry.payload;
      if (payload?.type === "message") {
        const text = textFromMessagePayload(payload);
        if (text) summary = text.slice(0, 240);
      }
    } catch {
      // Ignore append-in-progress lines.
    }
  }
  if (!threadId || !cwd) return null;
  return { threadId, cwd, file: filePath, mtimeMs: statSync(filePath).mtimeMs, summary };
}

function cursorFromCodexSessionSummary(summary: CodexSessionSummary): CodexSessionCursor {
  const stats = statSync(summary.file);
  return {
    threadId: summary.threadId,
    file: summary.file,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function cursorFromRolloutPath(threadId: string, filePath: string | undefined): CodexSessionCursor | undefined {
  if (!filePath || !existsSync(filePath)) return undefined;
  const stats = statSync(filePath);
  return {
    threadId,
    file: filePath,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

export function discoverCodexSessionsByCwd(
  cwd: string,
  roots: string[] = [path.join(os.homedir(), ".codex", "sessions")],
): CodexSessionSummary[] {
  const resolvedCwd = path.resolve(expandHome(cwd));
  return roots
    .flatMap((root) => collectJsonlFiles(root))
    .map((file) => readCodexSessionSummary(file))
    .filter((session): session is CodexSessionSummary => Boolean(session))
    .filter((session) => path.resolve(session.cwd) === resolvedCwd)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
}

export function findCodexSessionCursorByThread(
  threadId: string,
  roots: string[] = [path.join(os.homedir(), ".codex", "sessions")],
): CodexSessionCursor | null {
  const sessions = roots
    .flatMap((root) => collectJsonlFiles(root))
    .map((file) => readCodexSessionSummary(file))
    .filter((session): session is CodexSessionSummary => Boolean(session))
    .filter((session) => session.threadId === threadId)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
  return sessions[0] ? cursorFromCodexSessionSummary(sessions[0]) : null;
}

type ParsedCodexTokenUsage = {
  usedTokens: number;
  contextWindow: number;
  lastUsageTokens?: number;
  totalUsageTokens?: number;
};

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function tokenTotalFromUnknown(value: any): number | undefined {
  if (!value || typeof value !== "object") return numberFromUnknown(value);
  return (
    numberFromUnknown(value.total_tokens) ??
    numberFromUnknown(value.totalTokens) ??
    numberFromUnknown(value.used_tokens) ??
    numberFromUnknown(value.usedTokens)
  );
}

function tokenInputOutputFromUnknown(value: any): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = numberFromUnknown(value.input_tokens ?? value.inputTokens) ?? 0;
  const output = numberFromUnknown(value.output_tokens ?? value.outputTokens) ?? 0;
  return input || output ? input + output : undefined;
}

function collectTokenUsageCandidates(value: any, out: any[] = [], depth = 0): any[] {
  if (!value || typeof value !== "object" || depth > 5) return out;
  const hasUsageShape =
    "model_context_window" in value ||
    "modelContextWindow" in value ||
    "context_window" in value ||
    "contextWindow" in value ||
    "tokenUsage" in value ||
    "token_usage" in value ||
    "last_token_usage" in value ||
    "lastTokenUsage" in value ||
    "total_token_usage" in value ||
    "totalTokenUsage" in value;
  if (hasUsageShape) out.push(value);
  for (const key of ["payload", "info", "params", "event", "data", "tokenUsage", "token_usage"]) {
    collectTokenUsageCandidates(value[key], out, depth + 1);
  }
  return out;
}

function parseCodexTokenUsageFromEntry(entry: any): ParsedCodexTokenUsage | null {
  const candidates = collectTokenUsageCandidates(entry);
  for (const candidate of candidates) {
    const tokenUsage = candidate.tokenUsage ?? candidate.token_usage ?? candidate;
    const contextWindow =
      numberFromUnknown(tokenUsage.modelContextWindow) ??
      numberFromUnknown(tokenUsage.model_context_window) ??
      numberFromUnknown(tokenUsage.contextWindow) ??
      numberFromUnknown(tokenUsage.context_window);
    if (!contextWindow || contextWindow <= 0) continue;

    const lastUsage = tokenUsage.last ?? tokenUsage.last_token_usage ?? tokenUsage.lastTokenUsage;
    const totalUsage = tokenUsage.total ?? tokenUsage.total_token_usage ?? tokenUsage.totalTokenUsage;
    const lastUsageTokens = tokenTotalFromUnknown(lastUsage) ?? tokenInputOutputFromUnknown(lastUsage);
    const totalUsageTokens = tokenTotalFromUnknown(totalUsage) ?? tokenInputOutputFromUnknown(totalUsage);
    const directUsageTokens = tokenTotalFromUnknown(tokenUsage) ?? tokenInputOutputFromUnknown(tokenUsage);
    const usedTokens = lastUsageTokens && lastUsageTokens > 0 ? lastUsageTokens : totalUsageTokens ?? directUsageTokens;
    if (!usedTokens || usedTokens < 0) continue;

    return {
      usedTokens,
      contextWindow,
      lastUsageTokens,
      totalUsageTokens,
    };
  }
  return null;
}

function isEmptyTaskCompleteEntry(entry: any): boolean {
  const payload = entry?.payload;
  if (!payload || typeof payload !== "object") return false;
  const type = String(payload.type ?? entry.type ?? "");
  if (type !== "task_complete" && type !== "taskComplete") return false;
  if ("last_agent_message" in payload) return payload.last_agent_message == null;
  if ("lastAgentMessage" in payload) return payload.lastAgentMessage == null;
  return false;
}

function classifyCodexContextPressure(params: {
  threadId: string;
  file: string;
  usage?: ParsedCodexTokenUsage | null;
  emptyTaskComplete?: boolean;
}): CodexContextPressure {
  if (!params.usage) {
    return {
      threadId: params.threadId,
      status: "unknown",
      reason: "no_token_usage",
      file: params.file,
    };
  }

  const percent = Math.min(100, Math.max(0, Math.round((params.usage.usedTokens / params.usage.contextWindow) * 100)));
  const saturatedByEmptyReply = Boolean(params.emptyTaskComplete && percent >= CODEX_CONTEXT_HIGH_PERCENT);
  const saturatedByZeroLastUsage =
    params.usage.lastUsageTokens === 0 &&
    typeof params.usage.totalUsageTokens === "number" &&
    params.usage.totalUsageTokens >= params.usage.contextWindow * 0.98;
  const status: CodexContextPressureStatus = saturatedByEmptyReply || saturatedByZeroLastUsage
    ? "saturated"
    : percent >= CODEX_CONTEXT_BLOCK_PERCENT
      ? "critical"
      : percent >= CODEX_CONTEXT_HIGH_PERCENT
        ? "high"
        : "ok";

  return {
    threadId: params.threadId,
    status,
    reason: status === "saturated" ? "context_limit_empty_reply" : "context_usage",
    file: params.file,
    usedTokens: Math.round(params.usage.usedTokens),
    contextWindow: Math.round(params.usage.contextWindow),
    percent,
    lastUsageTokens: params.usage.lastUsageTokens,
    totalUsageTokens: params.usage.totalUsageTokens,
    emptyTaskComplete: params.emptyTaskComplete,
  };
}

export function readCodexContextPressure(
  threadId: string,
  roots: string[] = [path.join(os.homedir(), ".codex", "sessions")],
): CodexContextPressure {
  const cursor = findCodexSessionCursorByThread(threadId, roots);
  if (!cursor?.file || !existsSync(cursor.file)) {
    return { threadId, status: "unknown", reason: "no_session_file" };
  }

  let latestUsage: ParsedCodexTokenUsage | null = null;
  let latestUsageIndex = -1;
  let emptyTaskCompleteIndex = -1;
  const lines = readFileSync(cursor.file, "utf-8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      const usage = parseCodexTokenUsageFromEntry(entry);
      if (usage) {
        latestUsage = usage;
        latestUsageIndex = index;
      }
      if (isEmptyTaskCompleteEntry(entry)) emptyTaskCompleteIndex = index;
    } catch {
      // Ignore append-in-progress lines.
    }
  }

  return classifyCodexContextPressure({
    threadId,
    file: cursor.file,
    usage: latestUsage,
    emptyTaskComplete: emptyTaskCompleteIndex >= latestUsageIndex && latestUsageIndex >= 0,
  });
}

function formatTokenCount(tokens: number | undefined): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens)) return "?";
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(Math.round(tokens));
}

export function formatCodexContextPressureLine(pressure?: CodexContextPressure | null): string {
  if (!pressure) return "context: unknown";
  if (pressure.status === "unknown" || !pressure.usedTokens || !pressure.contextWindow || typeof pressure.percent !== "number") {
    return `context: unknown (${pressure.reason})`;
  }
  return `context: ${pressure.status} (${pressure.percent}%, ${formatTokenCount(pressure.usedTokens)}/${formatTokenCount(pressure.contextWindow)})`;
}

export function shouldBlockNativeHandoffForContext(pressure?: CodexContextPressure | null): boolean {
  return pressure?.status === "critical" || pressure?.status === "saturated";
}

export function buildNativeHandoffContextBlockedMessage(pressure: CodexContextPressure): string {
  return [
    "这个 Codex thread 上下文已经接近或命中 context limit，原生 fork 到微信可能失败。",
    formatCodexContextPressureLine(pressure),
    "请先在当前 Desktop/CLI thread 运行 /compact，然后再 carry to WeChat。",
    "这里不会静默 fallback 到 summary/bounded handoff，避免你以为手机拿到了完整 native thread。",
  ].join("\n");
}

export function readCurrentCodexThreadId(env: Record<string, string | undefined> = process.env): string {
  const threadId = env.CODEX_THREAD_ID?.trim();
  if (!threadId) throw new Error("CODEX_THREAD_ID is not available in this Codex Desktop/CLI context.");
  return threadId;
}

export function resolveProjectName(
  projects: ProjectRegistry,
  params: { requestedProject?: string; cwd: string },
): string {
  const requested = params.requestedProject?.trim();
  if (requested && requested !== "current") {
    if (!projects.projects[requested]) throw new Error(`Unknown project: ${requested}`);
    return requested;
  }
  const cwd = path.resolve(expandHome(params.cwd));
  const candidates = Object.entries(projects.projects)
    .filter(([, project]) => cwd === project.cwd || cwd.startsWith(`${project.cwd}${path.sep}`))
    .sort((a, b) => b[1].cwd.length - a[1].cwd.length);
  return candidates[0]?.[0] ?? projects.defaultProject;
}

export function resolveTargetSender(state: BridgeState, stateDir: string, target = "last"): string {
  const trimmed = target.trim();
  if (trimmed && trimmed !== "last") return trimmed;
  const fromState = Object.entries(state.senders)
    .filter(([, sender]) => sender.lastSeenAt)
    .sort((a, b) => String(b[1].lastSeenAt).localeCompare(String(a[1].lastSeenAt)))[0]?.[0];
  if (fromState) return fromState;
  const cached = Object.keys(loadContextTokenCache(stateDir)).sort().at(-1);
  if (cached) return cached;
  throw new Error("No target WeChat sender is known yet. Send any message from WeChat first, or pass --to <sender_id>.");
}

function routeForProject(state: BridgeState, senderId: string, projectName: string): SenderProjectRoute | undefined {
  return senderState(state, senderId).routes?.[projectName];
}

function findRouteByThread(
  state: BridgeState,
  threadId: string,
  projectName?: string,
): { senderId: string; projectName: string; route: SenderProjectRoute } | null {
  for (const [senderId, sender] of Object.entries(state.senders)) {
    for (const [routeProject, route] of Object.entries(sender.routes ?? {})) {
      if (projectName && routeProject !== projectName) continue;
      if (route.attachedThreadId === threadId) return { senderId, projectName: routeProject, route };
    }
  }
  return null;
}

function finishNotificationsFor(sender: SenderState, threadId?: string): FinishNotificationState {
  if (threadId?.trim()) {
    sender.threadFinishNotifications ??= {};
    sender.threadFinishNotifications[threadId] ??= {};
    return sender.threadFinishNotifications[threadId];
  }
  sender.finishNotifications ??= {};
  return sender.finishNotifications;
}

function finishNotificationsForStatus(sender: SenderState, threadId?: string): FinishNotificationState | undefined {
  if (threadId?.trim()) return sender.threadFinishNotifications?.[threadId];
  return sender.finishNotifications;
}

function latestPendingFinishOffer(sender: SenderState, requestedThreadId?: string): { threadId?: string; offer: FinishRunOffer } | null {
  if (requestedThreadId?.trim()) {
    const offer = sender.threadFinishNotifications?.[requestedThreadId]?.pendingOffer;
    return offer ? { threadId: requestedThreadId, offer } : null;
  }
  const latestThreadId = sender.lastFinishNotificationThreadId;
  if (latestThreadId) {
    const latestOffer = sender.threadFinishNotifications?.[latestThreadId]?.pendingOffer;
    if (latestOffer) return { threadId: latestThreadId, offer: latestOffer };
  }
  for (const [threadId, notifications] of Object.entries(sender.threadFinishNotifications ?? {})) {
    if (notifications.pendingOffer) return { threadId, offer: notifications.pendingOffer };
  }
  return sender.finishNotifications?.pendingOffer ? { offer: sender.finishNotifications.pendingOffer } : null;
}

export function resolveFinishNotificationStatus(
  state: BridgeState,
  senderId: string,
  threadId?: string,
): { enabled: boolean; source: "thread" | "default"; globalDefault: boolean; threadOverride?: boolean } {
  const sender = senderState(state, senderId);
  const globalDefault = Boolean(sender.finishNotifications?.enabled);
  const threadOverride = threadId?.trim() ? sender.threadFinishNotifications?.[threadId]?.enabled : undefined;
  return {
    enabled: typeof threadOverride === "boolean" ? threadOverride : globalDefault,
    source: typeof threadOverride === "boolean" ? "thread" : "default",
    globalDefault,
    threadOverride,
  };
}

export function isFinishNotificationEnabled(state: BridgeState, senderId: string, threadId?: string): boolean {
  return resolveFinishNotificationStatus(state, senderId, threadId).enabled;
}

export function setFinishNotificationEnabled(state: BridgeState, senderId: string, enabled: boolean | null, threadId?: string): FinishNotificationState {
  const notifications = finishNotificationsFor(senderState(state, senderId), threadId);
  if (enabled === null) {
    delete notifications.enabled;
  } else {
    notifications.enabled = enabled;
  }
  return notifications;
}

export function setFinishNotificationDefault(state: BridgeState, senderId: string, enabled: boolean): FinishNotificationState {
  return setFinishNotificationEnabled(state, senderId, enabled);
}

function findActiveDesktopThreadForSender(state: BridgeState, projects: ProjectRegistry, senderId: string): string | null {
  const projectName = activeProjectName(state, projects, senderId);
  return routeForProject(state, senderId, projectName)?.attachedThreadId ?? null;
}

function transcriptHasRawTurns(transcript: string | null | undefined): boolean {
  return Boolean(transcript?.trim()) && !transcript.includes("No raw turns recorded in this delta.");
}

function hasPendingMobileTranscript(route: SenderProjectRoute | undefined): boolean {
  return transcriptHasRawTurns(route?.pendingMobileTranscript);
}

function compactNotificationText(text: string | undefined, maxChars = 140): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

export function refreshPendingMobileTranscriptForRoute(
  state: BridgeState,
  projects: ProjectRegistry,
  senderId: string,
  projectName: string,
  params: { roots?: string[] } = {},
): string | null {
  const sender = senderState(state, senderId);
  const route = sender.routes?.[projectName];
  const project = projects.projects[projectName];
  if (!route?.mobileThreadId || !route.attachedThreadId || !project) return null;

  const mode = normalizeStoredMode(sender.sessions[projectName]?.mode ?? sender.activeMode, project.defaultMode);
  const model = activeModel(state, projects, senderId, projectName) ?? "default";
  const baseline = route.lastMobilePullCursor ?? route.mobileStartCursor;
  const transcript = buildRawTranscriptFromCodexSession({
    threadId: route.mobileThreadId,
    cursor: baseline,
    roots: baseline || params.roots ? params.roots : [],
    title: "Pending WeChat raw transcript",
    direction: "mobile_to_desktop",
    projectName,
    cwd: project.cwd,
    mode,
    model,
    desktopThreadId: route.attachedThreadId,
    mobileThreadId: route.mobileThreadId,
  });
  if (!transcriptHasRawTurns(transcript)) return route.pendingMobileTranscript ?? null;

  const currentCursor = baseline?.file
    ? cursorFromRolloutPath(route.mobileThreadId, baseline.file)
    : params.roots
      ? findCodexSessionCursorByThread(route.mobileThreadId, params.roots)
      : findCodexSessionCursorByThread(route.mobileThreadId);
  route.pendingMobileTranscript = transcript;
  if (currentCursor) route.pendingMobileTranscriptCursor = currentCursor;
  return transcript;
}

export function buildFinishRunNotification(offer: FinishRunOffer): string {
  const summary = compactNotificationText(offer.summary ?? offer.message);
  const nextAction = compactNotificationText(offer.nextAction);
  return [
    "Codex run 完成。",
    ...(summary ? [`完成：${summary}`] : []),
    ...(nextAction ? [`需要你：${nextAction}`] : []),
    "",
    `project: ${offer.projectName} | mode: ${offer.mode} | model: ${offer.model ?? "default"}`,
    ...(offer.needsMobilePull
      ? [
          "有未 pull 手机上下文：电脑先运行 pull WeChat back。",
          "",
        ]
      : []),
    "回复 /continue 从手机继续；不回复保持原状态。",
  ].join("\n");
}

export function recordFinishRunOffer(
  state: BridgeState,
  projects: ProjectRegistry,
  params: {
    senderId: string;
    projectName: string;
    threadId: string;
    mode?: BridgeMode;
    model?: string;
    message?: string;
    summary?: string;
    nextAction?: string;
    now?: string;
    sessionCursor?: CodexSessionCursor;
  },
): { offer: FinishRunOffer; notification: string } {
  const sender = senderState(state, params.senderId);
  const project = projects.projects[params.projectName];
  if (!project) throw new Error(`Unknown project: ${params.projectName}`);
  const foundRoute = findRouteByThread(state, params.threadId, params.projectName);
  const mode = normalizeStoredMode(params.mode ?? sender.activeMode ?? sender.sessions[params.projectName]?.mode, project.defaultMode);
  const model = params.model ?? activeModel(state, projects, params.senderId, params.projectName);
  const offer: FinishRunOffer = {
    threadId: params.threadId,
    projectName: params.projectName,
    cwd: project.cwd,
    mode,
    model,
    message: params.message,
    summary: params.summary,
    nextAction: params.nextAction,
    createdAt: params.now ?? new Date().toISOString(),
    sessionCursor: params.sessionCursor,
    needsMobilePull: Boolean(foundRoute?.route.needsReconcile || hasPendingMobileTranscript(foundRoute?.route)),
  };
  finishNotificationsFor(sender, params.threadId).pendingOffer = offer;
  sender.lastFinishNotificationThreadId = params.threadId;
  return { offer, notification: buildFinishRunNotification(offer) };
}

export function continueFinishRunOfferToWeChat(
  state: BridgeState,
  projects: ProjectRegistry,
  senderId: string,
  params: {
    threadId?: string;
    mobileThreadId?: string;
    mobileStartCursor?: CodexSessionCursor;
    roots?: string[];
    now?: string;
    contextPressure?: CodexContextPressure | null;
  } = {},
): { handled: true; reply: string; projectName?: string; desktopThreadId?: string; mobileThreadId?: string } {
  const sender = senderState(state, senderId);
  const pending = latestPendingFinishOffer(sender, params.threadId);
  const offerThreadId = pending?.threadId;
  const notifications = finishNotificationsForStatus(sender, offerThreadId);
  const offer = pending?.offer;
  if (!offer) return { handled: true, reply: "当前没有可继续到手机的 finish notification。" };
  const project = projects.projects[offer.projectName];
  if (!project) {
    if (notifications) notifications.pendingOffer = null;
    if (sender.finishNotifications?.pendingOffer?.threadId === offer.threadId) sender.finishNotifications.pendingOffer = null;
    return { handled: true, reply: `finish notification 的 project 已不存在: ${offer.projectName}` };
  }

  const route = sender.routes?.[offer.projectName];
  if (route?.attachedThreadId === offer.threadId && route.leaseState !== "wechat_active") {
    const resumed = resumeRouteToWeChat(state, projects, senderId, { roots: params.roots, now: params.now });
    if (notifications) notifications.pendingOffer = null;
    if (sender.finishNotifications?.pendingOffer?.threadId === offer.threadId) sender.finishNotifications.pendingOffer = null;
    return {
      handled: true,
      reply: [
        "已从 finish notification 回到手机。",
        resumed.reply,
        ...(offer.needsMobilePull ? ["注意：Desktop 刚才那轮可能没有手机上下文；手机继续时会带入 Desktop raw delta 做 reconcile。"] : []),
      ].join("\n"),
      projectName: offer.projectName,
      desktopThreadId: offer.threadId,
      mobileThreadId: route.mobileThreadId,
    };
  }

  if (route?.attachedThreadId === offer.threadId && route.leaseState === "wechat_active") {
    if (notifications) notifications.pendingOffer = null;
    if (sender.finishNotifications?.pendingOffer?.threadId === offer.threadId) sender.finishNotifications.pendingOffer = null;
    return {
      handled: true,
      reply: "这条 thread 已经在手机 remote mode。\n直接发消息就继续。",
      projectName: offer.projectName,
      desktopThreadId: offer.threadId,
      mobileThreadId: route.mobileThreadId,
    };
  }

  if (!params.mobileThreadId) {
    return {
      handled: true,
      reply: "要从这个 finish notification 继续到手机，需要 daemon/app-server fork Desktop thread。请确认 bridge 用 app-server backend 运行。",
      projectName: offer.projectName,
      desktopThreadId: offer.threadId,
    };
  }

  const carry = carryCurrentToWeChat(state, projects, {
    senderId,
    projectName: offer.projectName,
    threadId: offer.threadId,
    mobileThreadId: params.mobileThreadId,
    mode: offer.mode,
    sessionCursor: offer.sessionCursor,
    mobileStartCursor: params.mobileStartCursor,
    contextPressure: params.contextPressure,
    now: params.now,
  });
  if (notifications) notifications.pendingOffer = null;
  if (sender.finishNotifications?.pendingOffer?.threadId === offer.threadId) sender.finishNotifications.pendingOffer = null;
  return {
    handled: true,
    reply: [
      "已从 finish notification 切到手机继续。",
      carry.notification,
      ...(offer.needsMobilePull ? ["注意：Desktop 刚才那轮可能没有手机上下文；手机继续时会带入 mobile context 做 reconcile。"] : []),
    ].join("\n"),
    projectName: offer.projectName,
    desktopThreadId: offer.threadId,
    mobileThreadId: params.mobileThreadId,
  };
}

export function carryCurrentToWeChat(
  state: BridgeState,
  projects: ProjectRegistry,
  params: {
    senderId: string;
    projectName: string;
    threadId: string;
    mobileThreadId?: string;
    now?: string;
    mode?: BridgeMode;
    sessionCursor?: CodexSessionCursor;
    mobileStartCursor?: CodexSessionCursor;
    contextPressure?: CodexContextPressure | null;
  },
): { notification: string; route: SenderProjectRoute } {
  const project = projects.projects[params.projectName];
  if (!project) throw new Error(`Unknown project: ${params.projectName}`);
  const sender = senderState(state, params.senderId);
  sender.activeProject = params.projectName;
  const existingSession = sender.sessions[params.projectName];
  const mode = normalizeStoredMode(params.mode ?? sender.activeMode ?? existingSession?.mode, project.defaultMode);
  sender.activeMode = mode;
  const now = params.now ?? new Date().toISOString();
  const mobileThreadId = params.mobileThreadId ?? params.threadId;
  const route: SenderProjectRoute = {
    activeSurface: "wechat",
    attachedThreadId: params.threadId,
    mobileThreadId,
    attachedFrom: "desktop",
    attachedAt: now,
    leaseState: "wechat_active",
    parkedThreadId: existingSession?.threadId,
    lastDesktopPullAt: null,
    pendingDeltaId: null,
    sessionCursor: params.sessionCursor,
    mobileStartCursor: params.mobileStartCursor,
    lastMobilePullCursor: null,
    pendingDesktopTranscript: null,
    pendingMobileTranscript: null,
    pendingMobileTranscriptCursor: null,
    needsReconcile: false,
    desktopActivityDetectedAt: null,
  };
  sender.routes ??= {};
  sender.routes[params.projectName] = route;
  sender.sessions[params.projectName] = {
    threadId: mobileThreadId,
    cwd: project.cwd,
    mode,
  };
  const model = activeModel(state, projects, params.senderId, params.projectName) ?? "default";
  const notification = [
    "continue from here",
    "",
    "手机已接管这个 Codex thread。",
    `project: ${params.projectName} | mode: ${mode} | model: ${model}`,
    ...(params.contextPressure ? [formatCodexContextPressureLine(params.contextPressure)] : []),
    ...(params.contextPressure?.status === "high" ? ["上下文偏高；回电脑后建议先 /compact 再继续长期任务。"] : []),
    "直接回复继续。",
    "回电脑先说：pull WeChat back。",
    "电脑继续会暂停手机；/resume 继续手机，/detach 退出。",
  ].join("\n");
  return { notification, route };
}

function buildDesktopActivityPauseNotification(params: { projectName: string; threadId: string; needsReconcile?: boolean }): string {
  return [
    "检测到电脑端已经继续这个 Codex thread。",
    "微信 remote mode 已自动暂停。",
    ...(params.needsReconcile
      ? [
          "",
          "注意：这轮 Desktop 可能没有手机上下文。",
          "请回电脑运行 pull WeChat back 做 reconcile，然后再继续任务。",
        ]
      : []),
    "",
    `project: ${params.projectName}`,
    `thread: ${params.threadId}`,
    "",
    "要从手机重新接管，发 /resume。",
    "要结束这次 handoff，发 /detach。",
    "如果想再次从电脑交给微信，在电脑说：carry this to WeChat。",
  ].join("\n");
}

function notifyDesktopRemotePaused(params: { projectName: string; threadId: string; needsReconcile?: boolean }): void {
  if (process.platform !== "darwin") return;
  const title = "WeChat remote paused";
  const body = params.needsReconcile
    ? `WeChat context pending. Run pull WeChat back before continuing. Project: ${params.projectName}`
    : `Desktop continued ${params.projectName}; WeChat remote paused.`;
  try {
    Bun.spawn(["osascript", "-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // Best-effort desktop hint only; WeChat and event-log notifications are authoritative.
  }
}

function hasCodexSessionAdvanced(previous: CodexSessionCursor, current: CodexSessionCursor): boolean {
  if (current.threadId !== previous.threadId) return false;
  if (current.file !== previous.file) return current.mtimeMs > previous.mtimeMs;
  return current.size > previous.size;
}

function containsUserMessageEntry(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  if (value.type === "message" && value.role === "user") return true;
  for (const key of ["payload", "item", "message", "event"]) {
    if (containsUserMessageEntry(value[key])) return true;
  }
  return false;
}

function hasUserMessageAfterCursor(previous: CodexSessionCursor, current: CodexSessionCursor): boolean {
  if (previous.file !== current.file) return true;
  const contents = readFileSync(current.file);
  const appended = contents.subarray(Math.max(0, previous.size)).toString("utf-8");
  for (const line of appended.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      if (containsUserMessageEntry(JSON.parse(line))) return true;
    } catch {
      // Ignore append-in-progress lines.
    }
  }
  return false;
}

export function pauseWechatRoutesForDesktopActivity(
  state: BridgeState,
  params: { roots?: string[]; now?: string } = {},
): Array<{ senderId: string; projectName: string; threadId: string; notification: string; needsReconcile: boolean }> {
  const pauses: Array<{ senderId: string; projectName: string; threadId: string; notification: string; needsReconcile: boolean }> = [];
  const now = params.now ?? new Date().toISOString();
  for (const [senderId, sender] of Object.entries(state.senders)) {
    for (const [projectName, route] of Object.entries(sender.routes ?? {})) {
      if (route.leaseState !== "wechat_active") continue;
      if (!route.attachedThreadId || !route.sessionCursor) continue;
      const current = findCodexSessionCursorByThread(route.attachedThreadId, params.roots);
      if (!current || !hasCodexSessionAdvanced(route.sessionCursor, current)) continue;
      if (!hasUserMessageAfterCursor(route.sessionCursor, current)) {
        route.sessionCursor = current;
        continue;
      }
      const needsReconcile = hasPendingMobileTranscript(route);
      route.desktopBaselineCursor = route.sessionCursor;
      route.needsReconcile = needsReconcile;
      route.leaseState = "desktop_active";
      route.activeSurface = "desktop";
      route.desktopActivityDetectedAt = now;
      route.sessionCursor = current;
      pauses.push({
        senderId,
        projectName,
        threadId: route.attachedThreadId,
        notification: buildDesktopActivityPauseNotification({ projectName, threadId: route.attachedThreadId, needsReconcile }),
        needsReconcile,
      });
    }
  }
  return pauses;
}

export function resumeRouteToWeChat(
  state: BridgeState,
  projects: ProjectRegistry,
  senderId: string,
  params: { roots?: string[]; now?: string } = {},
): { handled: true; reply: string } {
  const sender = senderState(state, senderId);
  const projectName = activeProjectName(state, projects, senderId);
  const project = projects.projects[projectName];
  const route = sender.routes?.[projectName];
  if (!route?.attachedThreadId) return { handled: true, reply: "当前没有可恢复的 attached thread。" };

  const mode = activeMode(state, projects, senderId);
  const model = activeModel(state, projects, senderId, projectName) ?? "default";
  const desktopCursor = route.desktopBaselineCursor ?? route.sessionCursor;
  if (desktopCursor) {
    route.pendingDesktopTranscript = buildRawTranscriptFromCodexSession({
      threadId: route.attachedThreadId,
      cursor: desktopCursor,
      roots: params.roots,
      title: "Desktop raw handoff",
      direction: "desktop_to_mobile",
      projectName,
      cwd: project.cwd,
      mode,
      model,
      desktopThreadId: route.attachedThreadId,
      mobileThreadId: route.mobileThreadId,
    });
    const currentDesktopCursor = cursorFromRolloutPath(route.attachedThreadId, desktopCursor.file)
      ?? (params.roots ? findCodexSessionCursorByThread(route.attachedThreadId, params.roots) : null);
    if (currentDesktopCursor) {
      route.sessionCursor = currentDesktopCursor;
      route.desktopBaselineCursor = currentDesktopCursor;
    }
  }

  route.leaseState = "wechat_active";
  route.activeSurface = "wechat";
  return {
    handled: true,
    reply: [
      "已回到手机 remote mode。",
      `project: ${projectName}`,
      `desktop thread: ${route.attachedThreadId}`,
      ...(route.mobileThreadId ? [`mobile thread: ${route.mobileThreadId}`] : []),
      "电脑期间的 raw transcript 会带进下一条手机消息。",
      "直接发消息就继续。",
    ].join("\n"),
  };
}

export function consumePendingDesktopTranscript(route: SenderProjectRoute | undefined, userMessage: string): string {
  const pending = route?.pendingDesktopTranscript?.trim();
  if (!pending) return userMessage;
  route.pendingDesktopTranscript = null;
  const transcript =
    pending.length <= MAX_PENDING_DESKTOP_TRANSCRIPT_CHARS
      ? pending
      : [
          `[raw desktop transcript truncated: omitted ${pending.length - MAX_PENDING_DESKTOP_TRANSCRIPT_CHARS} chars; showing latest ${MAX_PENDING_DESKTOP_TRANSCRIPT_CHARS} chars]`,
          pending.slice(-MAX_PENDING_DESKTOP_TRANSCRIPT_CHARS),
        ].join("\n");
  return [
    "Desktop handoff context since phone paused:",
    transcript,
    "",
    "New WeChat message:",
    userMessage,
  ].join("\n");
}

export function buildCarryBackDelta(
  events: BridgeEvent[],
  params: { senderId: string; projectName?: string; threadId?: string; since?: string | null },
): string {
  const sinceMs = params.since ? Date.parse(params.since) : 0;
  const deltaEventTypes = new Set(["wechat_message_received", "reply_sent"]);
  const replyContexts = new Set(["final_reply", "error_reply"]);
  const lines = events
    .filter((event) => {
      if (!deltaEventTypes.has(event.type)) return false;
      const atMs = Date.parse(event.at);
      if (Number.isFinite(sinceMs) && Number.isFinite(atMs) && atMs < sinceMs) return false;
      if (event.data?.senderId && event.data.senderId !== params.senderId) return false;
      if (params.projectName && event.data?.projectName !== params.projectName) return false;
      if (params.threadId && event.data?.threadId !== params.threadId) return false;
      if (event.type === "reply_sent" && !replyContexts.has(String(event.data?.context ?? ""))) return false;
      return true;
    })
    .map((event) => {
      if (event.type === "wechat_message_received") return `- User: ${String(event.data?.textPreview ?? "")}`;
      if (event.type === "reply_sent") return `- Reply sent (${String(event.data?.context ?? "reply")})`;
      return `- ${event.type}`;
    })
    .filter((line) => !line.endsWith(": "));
  return ["Mobile continuation:", ...(lines.length ? lines : ["- No mobile activity recorded."])].join("\n");
}

export function pullCurrentToDesktop(
  state: BridgeState,
  params: { threadId: string; projectName?: string; events: BridgeEvent[]; now?: string; projects?: ProjectRegistry; roots?: string[] },
): { senderId: string; projectName: string; delta: string; notification: string } {
  const found = findRouteByThread(state, params.threadId, params.projectName);
  if (!found) throw new Error(`No WeChat route is attached to thread ${params.threadId}`);
  if (found.route.activeTurn) {
    throw new Error(`WeChat turn is still running for thread ${params.threadId}. Wait for the WeChat reply to finish, then pull again.`);
  }
  const mobileThreadId = found.route.mobileThreadId ?? found.route.attachedThreadId;
  if (!mobileThreadId) throw new Error(`No mobile thread is attached to Desktop thread ${params.threadId}`);
  const projectsForRoute = state.senders[found.senderId];
  const projectDefault = params.projects?.projects[found.projectName]?.defaultMode ?? "read";
  const project = params.projects?.projects[found.projectName];
  const mode = normalizeStoredMode(projectsForRoute?.activeMode ?? projectsForRoute?.sessions?.[found.projectName]?.mode, projectDefault);
  const model = projectsForRoute?.projectModels?.[found.projectName] ?? params.projects?.projects[found.projectName]?.model ?? "default";
  const desktopBaselineCursor = found.route.sessionCursor ?? {
    threadId: params.threadId,
    file: "",
    size: 0,
    mtimeMs: 0,
  };
  const mobileBaselineCursor = found.route.lastMobilePullCursor ?? found.route.mobileStartCursor;
  const delta = buildRawTranscriptFromCodexSession({
    threadId: mobileThreadId,
    cursor: mobileBaselineCursor,
    roots: mobileBaselineCursor || params.roots ? params.roots : [],
    title: "WeChat raw handoff",
    direction: "mobile_to_desktop",
    projectName: found.projectName,
    cwd: project?.cwd ?? projectsForRoute?.sessions?.[found.projectName]?.cwd ?? "",
    mode,
    model,
    desktopThreadId: params.threadId,
    mobileThreadId,
  });
  const mobileCursor = mobileBaselineCursor?.file
    ? cursorFromRolloutPath(mobileThreadId, mobileBaselineCursor.file)
    : params.roots
      ? findCodexSessionCursorByThread(mobileThreadId, params.roots)
      : null;
  found.route.leaseState = "desktop_active";
  found.route.activeSurface = "desktop";
  found.route.lastDesktopPullAt = params.now ?? new Date().toISOString();
  found.route.desktopBaselineCursor = desktopBaselineCursor;
  if (mobileCursor) found.route.lastMobilePullCursor = mobileCursor;
  found.route.pendingMobileTranscript = null;
  found.route.pendingMobileTranscriptCursor = null;
  found.route.needsReconcile = false;
  const notification = [
    "已切回电脑继续。",
    `project: ${found.projectName}`,
    ...(project ? [`cwd: ${project.cwd}`] : []),
    `mode: ${mode}`,
    `permission: ${describeModePermission(mode)}`,
    `model: ${model}`,
    "手机这边已暂停 remote mode。",
    "",
    "如果还想从手机继续，发 /resume。",
    "如果想回到手机原来的会话，发 /detach。",
  ].join("\n");
  return { senderId: found.senderId, projectName: found.projectName, delta, notification };
}

export function buildOnboardingMessage(): string {
  return [
    "连接成功。",
    "",
    "核心用法：把电脑上的 Codex 会话带到微信继续。",
    "1. 在 Codex Desktop 里说：carry this to WeChat",
    "2. 或运行：codex-wechat carry-current --project current --to last",
    "3. bridge 会 fork 当前 Desktop thread，创建 forked mobile session；手机只写 mobile thread，不外部写 Desktop thread。",
    "4. 手机微信直接回复，就从这个 forked mobile session 继续。",
    "5. 如果电脑端继续发消息，微信 remote mode 会自动暂停。",
    "6. 回电脑后，对 Codex 说：pull WeChat back",
    "   CLI fallback：codex-wechat pull --project current",
    "7. pull 会把手机期间的 raw transcript 带回当前 Desktop chat，不做 summary。",
    "重要：回电脑后第一句话请先说 pull WeChat back，然后再继续任务；否则 Desktop 那一轮不会包含手机期间的上下文。",
    "手机期间每轮完成后，bridge 只缓存 pending raw transcript，不会后台写 Desktop thread。",
    "",
    "Project/session binding：",
    "默认 inbox 是微信专用的安全起点，一般放在 ~/.codex-wechat-handoff/workspaces/inbox。",
    "默认微信聊天是当前 sender + project 绑定出来的手机 session。",
    "每个 project 有自己的手机 session / Codex thread；/project <name> 是切到该 project 绑定的独立 session，不是换同一个 thread 的 cwd。",
    "Each project has its own mobile session and Codex thread; /project <name> switches sessions instead of changing one thread's cwd.",
    "When you switch projects, mode follows the target project session or default.",
    "carry-over 会把 Desktop thread fork 成手机 session，并用 raw transcript 在切换时交接上下文。",
    "退出 carry-over 后会回到之前的手机 session。",
    "",
    "权限模式：",
    "read: read/search any readable local files, network enabled, no writes.",
    "write: read/search any readable local files, network enabled, writes only inside the project cwd.",
    "fullaccess: unrestricted local access.",
    "legacy alias: /mode bypass = /mode fullaccess.",
    "",
    "其他常用命令：",
    "/projects 查看项目",
    "/project <name> 切项目",
    "/mode read|write|fullaccess 改权限",
    "/model 查看或设置模型",
    "/status 查看当前 thread",
    "/new 开一个新的手机侧 project session；Desktop carry-over 中会被拦截。",
    "/stop 查看当前停止能力；安全 interrupt 还在开发中。",
  "/notify status 查看 finish-run 微信提醒；开关只能在 Desktop/CLI 控制。",
    "/continue 从 finish-run 提醒接管到手机；忽略提醒不会改变当前微信 state。",
    "/help 查看全部命令",
    "",
    "长线程说明：Desktop thread 和 mobile thread 都可能按 Codex 自己的规则 compact；bridge 在切换方向时用 raw transcript delta 交接上下文。",
  ].join("\n");
}

export function buildIntroMessage(): string {
  return [
    "Codex WeChat Handoff：把电脑上的 Codex 会话带到微信继续。",
    "",
    "出门前对 Codex 说：carry this to WeChat",
    "回电脑后对 Codex 说：pull WeChat back",
    "",
    "手机里用 /projects 看项目，用 /project <name> 切项目。",
    "完整说明发 /onboarding。",
  ].join("\n");
}

function normalizeMode(mode: string): BridgeMode | null {
  const normalized = mode.toLowerCase();
  if (normalized === "read" || normalized === "write" || normalized === "fullaccess") return normalized;
  if (normalized === "bypass") return "fullaccess";
  return null;
}

function describeModePermission(mode: BridgeMode): string {
  if (mode === "read") return "read = read/search any readable local files + network; no writes";
  if (mode === "write") return "write = read/search any readable local files + network; writes only inside the project cwd";
  return "fullaccess = unrestricted local access";
}

function normalizeStoredMode(mode: StoredBridgeMode | undefined, fallback: BridgeMode): BridgeMode {
  if (!mode) return fallback;
  return normalizeMode(mode) ?? fallback;
}

const SLASH_COMMANDS = [
  "/project",
  "/projects",
  "/current",
  "/info",
  "/sessions",
  "/list",
  "/attach",
  "/switch",
  "/back",
  "/resume",
  "/continue",
  "/detach",
  "/history",
  "/notify",
  "/onboarding",
  "/intro",
  "/help",
  "/stop",
  "/mode",
  "/model",
  "/health",
  "/status",
  "/new",
  "/clear",
];

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let lastDiagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        lastDiagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      lastDiagonal = old;
    }
  }
  return previous[b.length];
}

function suggestSlashCommand(command: string): string | null {
  const ranked = SLASH_COMMANDS
    .map((candidate) => ({ candidate, distance: editDistance(command, candidate) }))
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate));
  const best = ranked[0];
  if (!best) return null;
  return best.distance <= 3 ? best.candidate : null;
}

function parseNaturalBridgeIntent(trimmed: string): BridgeCommand | null {
  const compact = trimmed.toLowerCase().replace(/\s+/g, "");
  if (["回电脑继续", "切回电脑", "回到电脑继续", "pullwechatback"].includes(compact)) {
    return { type: "back" };
  }
  if (["继续手机remote", "继续手机", "手机继续", "resumeremote"].includes(compact)) {
    return { type: "resume" };
  }
  if (["继续到手机", "从手机继续", "continuefromphone", "continue"].includes(compact)) {
    return { type: "continue" };
  }
  if (["退出carry-over", "退出carryover", "回默认会话", "结束handoff", "detach"].includes(compact)) {
    return { type: "detach" };
  }
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
      defaultMode: normalizeStoredMode(config.defaultMode, "read"),
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
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf-8")) as ProjectsConfig;
}

function saveProjectsConfig(file: string, config: ProjectsConfig): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), "utf-8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort only.
  }
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
  state.senders[senderId].routes ??= {};
  return state.senders[senderId];
}

function activeProjectName(state: BridgeState, projects: ProjectRegistry, senderId: string): string {
  const sender = senderState(state, senderId);
  return sender.activeProject && projects.projects[sender.activeProject] ? sender.activeProject : projects.defaultProject;
}

function activeMode(state: BridgeState, projects: ProjectRegistry, senderId: string): BridgeMode {
  const sender = senderState(state, senderId);
  if (sender.activeMode) return normalizeStoredMode(sender.activeMode, projects.projects[activeProjectName(state, projects, senderId)].defaultMode);
  return projects.projects[activeProjectName(state, projects, senderId)].defaultMode;
}

function activeModel(state: BridgeState, projects: ProjectRegistry, senderId: string, projectName?: string): string | undefined {
  const sender = senderState(state, senderId);
  const resolvedProjectName = projectName ?? activeProjectName(state, projects, senderId);
  return sender.projectModels?.[resolvedProjectName] ?? projects.projects[resolvedProjectName].model;
}

export function parseBridgeCommand(text: string): BridgeCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return parseNaturalBridgeIntent(trimmed) ?? { type: "message", text };

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const arg = rest.join(" ").trim();

  if (command === "/project") {
    if (!arg) return { type: "error", message: "Usage: /project <name>" };
    return { type: "project", project: arg };
  }
  if (command === "/projects") return { type: "projects" };
  if (command === "/current" || command === "/info") return { type: "current" };
  if (command === "/sessions" || command === "/list") return { type: "sessions" };
  if (command === "/attach" || command === "/switch") {
    if (!arg) return { type: "error", message: `Usage: ${rawCommand} latest|<index>|<thread_id>` };
    return { type: "attach", target: arg };
  }
  if (command === "/back") return { type: "back" };
  if (command === "/resume") return { type: "resume" };
  if (command === "/continue") return { type: "continue" };
  if (command === "/detach") return { type: "detach" };
  if (command === "/history") {
    const count = arg ? Number(arg) : 10;
    if (!Number.isInteger(count) || count <= 0) return { type: "error", message: "Usage: /history [positive_number]" };
    return { type: "history", count };
  }
  if (command === "/notify") {
    const normalized = arg.toLowerCase();
    if (!normalized || normalized === "status") return { type: "notify", action: "status" };
    if (normalized === "on" || normalized === "off") return { type: "notify", action: normalized };
    return { type: "error", message: "Usage: /notify on|off|status" };
  }
  if (command === "/onboarding") return { type: "onboarding" };
  if (command === "/intro") return { type: "intro" };
  if (command === "/help") return { type: "help" };
  if (command === "/stop") return { type: "stop" };
  if (command === "/mode") {
    const mode = normalizeMode(arg);
    if (!mode) return { type: "error", message: `Unknown mode: ${arg || "(empty)"}. Use read, write, or fullaccess.` };
    return { type: "mode", mode };
  }
  if (command === "/model") {
    if (!arg) return { type: "modelStatus" };
    const normalized = arg.toLowerCase();
    const permissionMode = normalizeMode(normalized);
    if (permissionMode) {
      return { type: "error", message: `${normalized} is a permission mode. Use /mode ${permissionMode}, not /model ${normalized}.` };
    }
    if (normalized === "default" || normalized === "reset" || normalized === "auto") {
      return { type: "model", model: null };
    }
    if (/\s/.test(arg)) {
      return { type: "error", message: "Model names cannot contain spaces. Use /model default to clear the override." };
    }
    return { type: "model", model: arg };
  }
  if (command === "/health") return { type: "health" };
  if (command === "/status") return { type: "status" };
  if (command === "/new" || command === "/clear") return { type: "new" };

  const suggestion = suggestSlashCommand(command);
  return { type: "error", message: suggestion ? `Unknown command: ${rawCommand}. Did you mean ${suggestion}?` : `Unknown command: ${rawCommand}` };
}

export function applyBridgeCommand(
  state: BridgeState,
  projects: ProjectRegistry,
  senderId: string,
  command: Exclude<BridgeCommand, { type: "message" }>,
  options: { contextPressure?: CodexContextPressure | null } = {},
): { handled: true; reply: string } {
  const sender = senderState(state, senderId);

  if (command.type === "error") return { handled: true, reply: command.message };

  if (command.type === "notify") {
    const notifyThreadId = findActiveDesktopThreadForSender(state, projects, senderId);
    const status = resolveFinishNotificationStatus(state, senderId, notifyThreadId ?? undefined);
    if (command.action !== "status") {
      return {
        handled: true,
        reply: [
          "finish-run 微信提醒只能在 Desktop thread 里开关，微信不控制这个状态。",
          `当前状态：${status.enabled ? "on" : "off"} (${status.source})`,
          `thread: ${notifyThreadId ?? "none"}`,
          "请回到对应的 Codex Desktop thread 运行：codex-wechat notify-finish on|off|inherit",
          "全局默认值只能在 Desktop/CLI 里运行：codex-wechat notify-finish default on|off",
        ].join("\n"),
      };
    }
    const notifications = finishNotificationsForStatus(sender, notifyThreadId ?? undefined);
    return {
      handled: true,
      reply: [
        `finish-run 微信提醒：${status.enabled ? "on" : "off"}`,
        `source: ${status.source}`,
        `global_default: ${status.globalDefault ? "on" : "off"}`,
        `thread_override: ${typeof status.threadOverride === "boolean" ? (status.threadOverride ? "on" : "off") : "inherit"}`,
        `thread: ${notifyThreadId ?? "none"}`,
        `pending_continue: ${notifications?.pendingOffer ? "yes" : "no"}`,
        notifyThreadId
          ? "微信这里只能查看；开关请在对应 Desktop thread 运行 codex-wechat notify-finish on|off|inherit。"
          : "微信这里只能查看；全局默认值请在 Desktop/CLI 运行 codex-wechat notify-finish default on|off。",
      ].join("\n"),
    };
  }

  if (command.type === "projects") {
    const names = Object.entries(projects.projects)
      .map(([name, project]) => `${name} -> ${project.cwd}`)
      .join("\n");
    return { handled: true, reply: `projects:\n${names}` };
  }

  if (command.type === "project") {
    const targetProject = projects.projects[command.project];
    if (!targetProject) {
      return { handled: true, reply: `Unknown project: ${command.project}. Use /projects to list available projects.` };
    }
    sender.activeProject = command.project;
    sender.activeMode = normalizeStoredMode(sender.sessions[command.project]?.mode, targetProject.defaultMode);
    const model = activeModel(state, projects, senderId, command.project) ?? "default";
    return {
      handled: true,
      reply: [
        `project: ${command.project}`,
        `mode: ${sender.activeMode}`,
        `model: ${model}`,
        `cwd: ${targetProject.cwd}`,
        "project/session binding: switching projects switches to that project's own mobile session and Codex thread.",
        "It does not change the cwd of the current thread.",
        "Mode follows this project's existing session or default.",
      ].join("\n"),
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
  const route = routeForProject(state, senderId, projectName);

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
        `thread: ${route?.attachedThreadId ?? session?.threadId ?? "none"}`,
        `lease: ${route?.leaseState ?? "wechat_owned"}`,
        ...(options.contextPressure ? [formatCodexContextPressureLine(options.contextPressure)] : []),
        `cwd: ${project.cwd}`,
      ].join("\n"),
    };
  }

  if (command.type === "current") {
    return {
      handled: true,
      reply: [
        `project: ${projectName}`,
        `mode: ${mode}`,
        `model: ${model ?? "default"}`,
        `surface: ${route?.activeSurface ?? "wechat"}`,
        `lease: ${route?.leaseState ?? "wechat_owned"}`,
        `thread: ${route?.attachedThreadId ?? session?.threadId ?? "none"}`,
        `parked_thread: ${route?.parkedThreadId ?? "none"}`,
        ...(options.contextPressure ? [formatCodexContextPressureLine(options.contextPressure)] : []),
        `cwd: ${project.cwd}`,
      ].join("\n"),
    };
  }

  if (command.type === "sessions") {
    const lines: string[] = [];
    const attached = route?.attachedThreadId;
    if (attached) lines.push(`* attached ${attached} (${route.leaseState ?? "unknown"})`);
    for (const [name, sess] of Object.entries(sender.sessions)) {
      lines.push(`${name === projectName ? "*" : "-"} ${name}: ${sess.threadId ?? "none"} ${sess.cwd}`);
    }
    if (!lines.length) lines.push("No sessions yet.");
    return { handled: true, reply: `sessions:\n${lines.join("\n")}` };
  }

  if (command.type === "attach") {
    const target = command.target.trim();
    const threadId = target === "latest" ? session?.threadId : /^\d+$/.test(target) ? Object.values(sender.sessions)[Number(target) - 1]?.threadId : target;
    if (!threadId) return { handled: true, reply: `No session found for: ${target}` };
    sender.routes ??= {};
    sender.routes[projectName] = {
      activeSurface: "wechat",
      attachedThreadId: threadId,
      attachedFrom: "wechat",
      attachedAt: new Date().toISOString(),
      leaseState: "wechat_active",
      parkedThreadId: session?.threadId === threadId ? undefined : session?.threadId,
    };
    return { handled: true, reply: `attached thread: ${threadId}\nproject: ${projectName}` };
  }

  if (command.type === "back") {
    if (!route?.attachedThreadId) return { handled: true, reply: "当前没有 attached Desktop thread。" };
    route.leaseState = "pending_desktop_pull";
    route.activeSurface = "desktop";
    return {
      handled: true,
      reply: [
        "已准备切回电脑。",
        "手机期间的消息会在 Desktop /wechat pull 时汇总。",
        "",
        "回到 Codex Desktop 后说：/wechat pull",
        "如果还想继续手机上聊，发 /resume。",
      ].join("\n"),
    };
  }

  if (command.type === "resume") {
    return resumeRouteToWeChat(state, projects, senderId);
  }

  if (command.type === "continue") {
    return continueFinishRunOfferToWeChat(state, projects, senderId);
  }

  if (command.type === "detach") {
    if (!route?.attachedThreadId) return { handled: true, reply: "当前没有 Desktop carry-over 可以退出。" };
    if (route.parkedThreadId) {
      sender.sessions[projectName] = {
        threadId: route.parkedThreadId,
        cwd: project.cwd,
        mode,
      };
    }
    delete sender.routes?.[projectName];
    return { handled: true, reply: "已退出 Desktop carry-over。\n已回到之前的微信会话。" };
  }

  if (command.type === "history") {
    return { handled: true, reply: `history: 最近 ${command.count} 条会在后续事件日志里展开。` };
  }

  if (command.type === "onboarding") {
    return { handled: true, reply: buildOnboardingMessage() };
  }

  if (command.type === "intro") {
    return { handled: true, reply: buildIntroMessage() };
  }

  if (command.type === "help") {
    return {
      handled: true,
      reply: [
        "/intro /onboarding",
        "/current /sessions /attach latest|<id>",
        "/back /resume /detach",
        "/notify status /continue",
        "/projects /project <name>",
        "/mode read|write|fullaccess",
        "/model <name|default>",
        "/status /health /history [n] /new",
      ].join("\n"),
    };
  }

  if (command.type === "stop") {
    return { handled: true, reply: "当前版本还没有安全接入 turn interrupt；请等待当前任务结束或重启 bridge。" };
  }

  if (command.type === "health") {
    return { handled: true, reply: "health is available while the bridge is running." };
  }

  if (command.type === "new") {
    if (route?.attachedThreadId && route.leaseState !== "desktop_active") {
      return {
        handled: true,
        reply: [
          "当前正在 Desktop carry-over，不能直接 /new。",
          "要回到之前的手机会话，发 /detach。",
          "要切回电脑，发 /back。",
        ].join("\n"),
      };
    }
    delete sender.sessions[projectName];
    return { handled: true, reply: `new session requested for project: ${projectName}` };
  }

  return { handled: true, reply: "Unhandled command." };
}

export function applyBridgeCommandToFreshState(
  stateDir: string,
  projects: ProjectRegistry,
  senderId: string,
  command: Exclude<BridgeCommand, { type: "message" }>,
): { handled: true; reply: string; state: BridgeState } {
  const state = loadBridgeState(stateDir);
  const result = applyBridgeCommand(state, projects, senderId, command);
  saveBridgeState(stateDir, state);
  return { ...result, state };
}

export function sandboxForMode(mode: BridgeMode, cwd: string): AppServerSandboxPolicy {
  if (mode === "read") return { type: "readOnly", networkAccess: true };
  if (mode === "write") return { type: "workspaceWrite", networkAccess: true, writableRoots: [cwd] };
  return { type: "dangerFullAccess" };
}

function legacySandboxForMode(mode: BridgeMode): string {
  if (mode === "read") return "read-only";
  if (mode === "write") return "workspace-write";
  return "danger-full-access";
}

function wechatDeveloperInstructions(projectName: string): string {
  return [
    "You are Codex connected to WeChat through a local bridge.",
    `Active project: ${projectName}`,
    "Send concise plain-text final answers suitable for WeChat.",
    "WeChat replies should feel natural and human, not stiff or robotic.",
    "Incoming WeChat images and voice files may appear as local paths in the user message; inspect image paths when visual details matter.",
    "When appropriate, use the imagegen skill to generate images for the user.",
    "To send an image through WeChat, put a line exactly like: WECHAT_IMAGE: /absolute/path/to/image.png",
    "To send a voice message through WeChat, put a line exactly like: WECHAT_VOICE: /absolute/path/to/audio.silk playtime_ms=2000",
  ].join("\n");
}

export function buildThreadForkParams(params: {
  threadId: string;
  cwd: string;
  mode: BridgeMode;
  model?: string;
  projectName: string;
}): Record<string, unknown> {
  return {
    threadId: params.threadId,
    cwd: params.cwd,
    approvalPolicy: "never",
    sandbox: legacySandboxForMode(params.mode),
    model: params.model ?? null,
    developerInstructions: wechatDeveloperInstructions(params.projectName),
    ephemeral: false,
  };
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

  async forkThread(params: {
    threadId: string;
    cwd: string;
    mode: BridgeMode;
    model?: string;
    projectName: string;
  }): Promise<AppServerForkResult> {
    try {
      await this.ensureStarted();
      const response = await this.request("thread/fork", buildThreadForkParams(params));
      const threadId = response?.thread?.id;
      if (!threadId) throw new Error("app-server thread/fork did not return a thread id");
      const rolloutPath = typeof response?.thread?.path === "string" ? response.thread.path : undefined;
      return {
        threadId,
        cursor: cursorFromRolloutPath(threadId, rolloutPath) ?? findCodexSessionCursorByThread(threadId) ?? undefined,
      };
    } catch (error) {
      this.stop();
      throw error;
    }
  }

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
      developerInstructions: wechatDeveloperInstructions(params.projectName),
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
      developerInstructions: wechatDeveloperInstructions(params.projectName),
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
      if (reply) return reply;
      const recovered = recoverFinalReplyFromCodexSessionLogs(threadId);
      if (recovered) {
        appendBridgeEvent(this.options.stateDir, { type: "final_reply_recovered", data: { threadId, turnId } });
        return recovered;
      }
      throw new Error(`app-server returned an empty reply for thread ${threadId}`);
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

    if (message.method === "item/completed" && turnId) {
      const collector = this.turnCollectors.get(turnId);
      const finalText = extractAgentMessageTextFromAppServerItem(message.params?.item);
      if (collector && finalText) collector.text = finalText;
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
    fileMd5: rawfilemd5,
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

function buildInboundMessageKey(account: Account, msg: IlinkMessage, text: string): string {
  const mediaFingerprint = (msg.item_list ?? [])
    .map((item) =>
      [
        item.type ?? "",
        item.image_item?.media?.encrypt_query_param ?? "",
        item.voice_item?.media?.encrypt_query_param ?? "",
        item.file_item?.media?.encrypt_query_param ?? "",
        item.video_item?.media?.encrypt_query_param ?? "",
        item.file_item?.file_name ?? "",
      ].join(":"),
    )
    .join("|");
  return JSON.stringify({
    accountId: account.accountId ?? account.userId ?? "",
    senderId: msg.from_user_id ?? "",
    contextToken: msg.context_token ?? "",
    text,
    mediaFingerprint,
  });
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

function parseReplyMediaPayload(raw: string): { path: string; playtimeMs?: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const playtimeMatch = trimmed.match(/\bplaytime_ms=(\d+)\b/i);
  const playtimeMs = playtimeMatch ? Number(playtimeMatch[1]) : undefined;
  const withoutOptions = trimmed.replace(/\s*\bplaytime_ms=\d+\b/i, "").trim();
  const unquoted = withoutOptions.replace(/^["']|["']$/g, "");
  if (!path.isAbsolute(unquoted)) return null;
  return { path: unquoted, playtimeMs };
}

function isLocalImagePath(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  return /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i.test(candidate);
}

export function parseReplyMediaDirectives(reply: string): { text: string; media: ReplyMediaDirective[] } {
  const media: ReplyMediaDirective[] = [];
  const lines: string[] = [];
  for (const line of reply.split(/\r?\n/)) {
    const imageMatch = line.match(/^\s*(?:WECHAT_IMAGE|微信图片|IMAGE)\s*:\s*(.+)$/i);
    if (imageMatch) {
      const parsed = parseReplyMediaPayload(imageMatch[1]);
      if (parsed) media.push({ kind: "image", path: parsed.path });
      continue;
    }

    const voiceMatch = line.match(/^\s*(?:WECHAT_VOICE|微信语音|VOICE)\s*:\s*(.+)$/i);
    if (voiceMatch) {
      const parsed = parseReplyMediaPayload(voiceMatch[1]);
      if (parsed) media.push({ kind: "voice", path: parsed.path, playtimeMs: parsed.playtimeMs });
      continue;
    }

    const fileMatch = line.match(/^\s*(?:WECHAT_FILE|微信文件|FILE)\s*:\s*(.+)$/i);
    if (fileMatch) {
      const parsed = parseReplyMediaPayload(fileMatch[1]);
      if (parsed) media.push({ kind: "file", path: parsed.path });
      continue;
    }

    const rewritten = line.replace(/!\[[^\]]*]\(([^)]+)\)/g, (_match, target: string) => {
      const parsedTarget = target.trim().replace(/^["']|["']$/g, "");
      if (isLocalImagePath(parsedTarget)) {
        media.push({ kind: "image", path: parsedTarget });
        return "";
      }
      return _match;
    });
    lines.push(rewritten.trimEnd());
  }
  return { text: lines.join("\n").trim(), media };
}

function voiceEncodeTypeForPath(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".silk" || ext === ".slk") return VOICE_ENCODE_SILK;
  if (ext === ".mp3") return VOICE_ENCODE_MP3;
  if (ext === ".amr") return VOICE_ENCODE_AMR;
  if (ext === ".ogg" || ext === ".spx") return VOICE_ENCODE_OGG_SPEEX;
  if (ext === ".pcm" || ext === ".wav") return VOICE_ENCODE_PCM;
  return VOICE_ENCODE_SILK;
}

async function sendImageMessage(account: Account, cdnBaseUrl: string, toUserId: string, imagePath: string, contextToken: string): Promise<string> {
  const uploaded = await uploadMediaFile({
    account,
    cdnBaseUrl,
    toUserId,
    filePath: imagePath,
    mediaType: UPLOAD_MEDIA_IMAGE,
  });
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
              hd_size: uploaded.fileSizeCiphertext,
            },
          },
        ],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    },
    15_000,
  );
  return clientId;
}

async function sendVoiceMessage(
  account: Account,
  cdnBaseUrl: string,
  toUserId: string,
  voicePath: string,
  contextToken: string,
  playtimeMs?: number,
): Promise<string> {
  const uploaded = await uploadMediaFile({
    account,
    cdnBaseUrl,
    toUserId,
    filePath: voicePath,
    mediaType: UPLOAD_MEDIA_VOICE,
  });
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
        item_list: [
          {
            type: MSG_ITEM_VOICE,
            voice_item: {
              media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: mediaAesKeyBase64(uploaded.aeskey),
                encrypt_type: 1,
              },
              encode_type: voiceEncodeTypeForPath(voicePath),
              playtime: playtimeMs ?? 0,
            },
          },
        ],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    },
    15_000,
  );
  return clientId;
}

export function buildFileMessageItem(params: { uploaded: UploadedFileInfo; filePath: string }): IlinkItem {
  return {
    type: MSG_ITEM_FILE,
    file_item: {
      media: {
        encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
        aes_key: mediaAesKeyBase64(params.uploaded.aeskey),
        encrypt_type: 1,
      },
      file_name: sanitizeFileName(path.basename(params.filePath)),
      md5: params.uploaded.fileMd5,
      len: String(params.uploaded.fileSize),
    },
  };
}

async function sendFileMessage(account: Account, cdnBaseUrl: string, toUserId: string, filePath: string, contextToken: string): Promise<string> {
  const uploaded = await uploadMediaFile({
    account,
    cdnBaseUrl,
    toUserId,
    filePath,
    mediaType: UPLOAD_MEDIA_FILE,
  });
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
        item_list: [buildFileMessageItem({ uploaded, filePath })],
        context_token: contextToken,
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
  const clientIds: string[] = [];
  if (parsed.text) {
    for (const chunk of chunkTextForWechat(parsed.text)) {
      clientIds.push(await sendTextMessage(params.account, params.toUserId, chunk, params.contextToken));
    }
  }
  for (const media of parsed.media) {
    if (!existsSync(media.path)) {
      const warning = `要发送的媒体文件不存在: ${media.path}`;
      console.error(warning);
      clientIds.push(await sendTextMessage(params.account, params.toUserId, warning, params.contextToken));
      continue;
    }
    if (media.kind === "image") {
      clientIds.push(await sendImageMessage(params.account, params.options.cdnBaseUrl, params.toUserId, media.path, params.contextToken));
    } else if (media.kind === "voice") {
      clientIds.push(
        await sendVoiceMessage(params.account, params.options.cdnBaseUrl, params.toUserId, media.path, params.contextToken, media.playtimeMs),
      );
    } else {
      clientIds.push(await sendFileMessage(params.account, params.options.cdnBaseUrl, params.toUserId, media.path, params.contextToken));
    }
  }
  if (!clientIds.length) {
    clientIds.push(await sendTextMessage(params.account, params.toUserId, params.reply, params.contextToken));
  }
  return clientIds;
}

async function sendProactiveText(params: {
  account: Account;
  stateDir: string;
  senderId: string;
  text: string;
  context: string;
  dryRun: boolean;
}): Promise<{ sent: boolean; reason?: string }> {
  const resolvedContext = resolveProactiveContextToken(params.stateDir, params.senderId, { allowEmptyFallback: true });
  if (resolvedContext.contextToken === null) {
    appendBridgeEvent(params.stateDir, {
      type: "reply_send_failed",
      data: { senderId: params.senderId, context: params.context, reason: "missing_context_token" },
    });
    return { sent: false, reason: "missing_context_token" };
  }
  if (params.dryRun) return { sent: true, reason: "dry_run" };
  const clientIds: string[] = [];
  for (const chunk of chunkTextForWechat(params.text)) {
    clientIds.push(await sendTextMessage(params.account, params.senderId, chunk, resolvedContext.contextToken));
  }
  appendBridgeEvent(params.stateDir, {
    type: "reply_sent",
    data: { senderId: params.senderId, clientIds, context: params.context, contextSource: resolvedContext.source },
  });
  return { sent: true };
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
      clearSetupState(options.stateDir);
      saveAccount(options.stateDir, account);
      console.log("登录成功。");
      console.log(`凭据保存至: ${accountFile(options.stateDir)}`);
      console.log("");
      console.log(buildOnboardingMessage());
      console.log("");
      console.log("提示：首次收到某个微信 sender 的消息后，bridge 才能缓存回复所需的 context_token。也可以在微信里发送 /onboarding 重新查看这段说明。");
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

async function commandInit(options: RuntimeOptions, args: Args): Promise<void> {
  const hasExplicitProject = typeof args.project === "string" && args.project.trim().length > 0;
  const hasExplicitCwd = typeof args.cwd === "string" && args.cwd.trim().length > 0;
  const createsDefaultInbox = !hasExplicitProject && !hasExplicitCwd;
  const projectName = createsDefaultInbox ? "inbox" : optionString(args, "project", "default");
  const cwd = createsDefaultInbox
    ? path.join(options.stateDir, "workspaces", "inbox")
    : path.resolve(expandHome(optionString(args, "cwd", process.cwd())));
  const requestedMode = optionString(args, "mode", createsDefaultInbox ? "write" : "read");
  const defaultMode = normalizeMode(requestedMode);
  if (!defaultMode) throw new Error("Unknown mode. Use read, write, or fullaccess.");
  const projectsPath = typeof args.projects === "string" ? path.resolve(expandHome(args.projects)) : defaultProjectsFile(options.stateDir);
  mkdirSync(path.dirname(projectsPath), { recursive: true });
  if (createsDefaultInbox) mkdirSync(cwd, { recursive: true });
  const config: ProjectsConfig = {
    defaultProject: projectName,
    allowedSenderIds: [],
    projects: {
      [projectName]: {
        cwd,
        defaultMode,
      },
    },
  };
  writeFileSync(projectsPath, JSON.stringify(config, null, 2), "utf-8");
  try {
    chmodSync(projectsPath, 0o600);
  } catch {
    // Best effort only.
  }
  console.log(`created: ${projectsPath}`);
  if (createsDefaultInbox) {
    console.log(`default WeChat inbox: ${projectName}`);
    console.log(`inbox workspace: ${cwd}`);
    console.log("Add real code projects with:");
    console.log("codex-wechat project add <name> --cwd /absolute/path/to/project --mode read");
  } else {
    console.log(`default project: ${projectName}`);
    console.log(`cwd: ${cwd}`);
    console.log(`mode: ${defaultMode}`);
  }
  console.log("Next: codex-wechat setup");
  console.log("Then: codex-wechat doctor");
  console.log("Then: codex-wechat daemon install");
}

async function commandProjectConfig(options: RuntimeOptions, args: Args): Promise<void> {
  const subcommand = args._[1] || "list";
  const projectsPath = options.projectsFile ?? defaultProjectsFile(options.stateDir);

  if (subcommand === "add") {
    const name = args._[2]?.trim();
    if (!name) throw new Error("Usage: codex-wechat project add <name> --cwd /absolute/path [--mode read|write|fullaccess]");
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Project names may contain only letters, numbers, hyphen, and underscore.");
    const cwd = path.resolve(expandHome(optionString(args, "cwd", process.cwd())));
    const mode = normalizeMode(optionString(args, "mode", "read"));
    if (!mode) throw new Error("Unknown mode. Use read, write, or fullaccess.");
    const config = loadProjectsConfig(projectsPath) ?? {
      defaultProject: name,
      allowedSenderIds: [],
      projects: {},
    };
    config.defaultProject ??= name;
    config.allowedSenderIds ??= [];
    config.projects ??= {};
    config.projects[name] = { cwd, defaultMode: mode };
    saveProjectsConfig(projectsPath, config);
    console.log(`project: ${name}`);
    console.log(`cwd: ${cwd}`);
    console.log(`mode: ${mode}`);
    console.log(`config: ${projectsPath}`);
    console.log("Mobile commands:");
    console.log("/projects");
    console.log(`/project ${name}`);
    console.log("/status");
    return;
  }

  if (subcommand === "list") {
    const projects = loadProjectRegistry({
      workspace: options.workspace,
      projectsConfig: loadProjectsConfig(projectsPath),
    });
    console.log(`default: ${projects.defaultProject}`);
    for (const [name, project] of Object.entries(projects.projects)) {
      console.log(`${name}: ${project.cwd} (${project.defaultMode})`);
    }
    return;
  }

  throw new Error(`Unknown project command: ${subcommand}. Use add or list.`);
}

function resolveExecutable(command: string): string | null {
  const expanded = expandHome(command);
  if (expanded.includes("/") && isExecutablePath(expanded)) return expanded;
  return findCommandOnPath(expanded);
}

function commandVersion(command: string, args: string[] = ["--version"]): string {
  const executable = resolveExecutable(command);
  if (!executable) return "missing";
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = (result.stdout.toString() || result.stderr.toString()).trim().split(/\r?\n/)[0] ?? "";
  return result.exitCode === 0 ? output || "ok" : `error (${result.exitCode})`;
}

function doctorProjectsStatus(options: RuntimeOptions): string {
  const projectsFile = options.projectsFile ?? defaultProjectsFile(options.stateDir);
  if (!existsSync(projectsFile)) return `missing (${projectsFile})`;
  try {
    const projects = loadProjectRegistry({
      workspace: options.workspace,
      projectsConfig: loadProjectsConfig(projectsFile),
    });
    const missingProjects = Object.entries(projects.projects)
      .filter(([, project]) => !existsSync(project.cwd))
      .map(([name]) => name);
    if (missingProjects.length) return `ok, missing cwd: ${missingProjects.join(", ")}`;
    return `ok (${Object.keys(projects.projects).length} project${Object.keys(projects.projects).length === 1 ? "" : "s"})`;
  } catch (error) {
    return `invalid (${error instanceof Error ? error.message : String(error)})`;
  }
}

function doctorAccountStatus(stateDir: string): string {
  const file = accountFile(stateDir);
  if (!existsSync(file)) return "missing";
  try {
    const mode = (statSync(file).mode & 0o777).toString(8);
    const account = JSON.parse(readFileSync(file, "utf-8")) as Account;
    return account.token && account.baseUrl ? `ok (${mode})` : `invalid (${mode})`;
  } catch (error) {
    return `invalid (${error instanceof Error ? error.message : String(error)})`;
  }
}

function launchAgentStateDirFromPlist(plistText: string): string | null {
  const args = Array.from(plistText.matchAll(/<string>([\s\S]*?)<\/string>/g), (match) => xmlUnescape(match[1] ?? ""));
  const stateDirFlag = args.indexOf("--state-dir");
  return stateDirFlag >= 0 ? args[stateDirFlag + 1] ?? null : null;
}

export function describeLaunchAgentDaemonStatus(params: {
  requestedStateDir: string;
  launchctlExitCode: number;
  launchctlStdout: string;
  plistText?: string;
  platform?: NodeJS.Platform;
}): string {
  if ((params.platform ?? process.platform) !== "darwin") return "unsupported on this platform";
  if (params.launchctlExitCode !== 0) return "not installed";
  const state = params.launchctlStdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim() ?? "unknown";
  const pid = params.launchctlStdout.match(/\bpid = ([^\n]+)/)?.[1]?.trim();
  const status = pid ? `${state} (pid ${pid})` : state;
  const configuredStateDir = params.plistText ? launchAgentStateDirFromPlist(params.plistText) : null;
  if (!configuredStateDir) return `${status} (state-dir unknown; requested: ${params.requestedStateDir})`;
  if (path.resolve(configuredStateDir) !== path.resolve(params.requestedStateDir)) {
    return `${status} (different state-dir: ${configuredStateDir}; requested: ${params.requestedStateDir})`;
  }
  return `${status} (state-dir: ${configuredStateDir})`;
}

function doctorDaemonStatusForState(stateDir: string): string {
  if (process.platform !== "darwin") return "unsupported on this platform";
  const result = launchctlPrint(DAEMON_LABEL);
  const plistPath = launchAgentPlistPath();
  const plistText = existsSync(plistPath) ? readFileSync(plistPath, "utf-8") : undefined;
  return describeLaunchAgentDaemonStatus({
    requestedStateDir: stateDir,
    launchctlExitCode: result.exitCode,
    launchctlStdout: result.stdout,
    plistText,
  });
}

function launchAgentDomain(): string {
  const uid = process.getuid?.();
  if (typeof uid !== "number") throw new Error("LaunchAgent daemon commands require a user id.");
  return `gui/${uid}`;
}

function launchAgentPlistPath(label = DAEMON_LABEL): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function launchctlPrint(label: string): { exitCode: number; stdout: string; stderr: string } {
  return spawnSyncResult("launchctl", ["print", `${launchAgentDomain()}/${label}`]);
}

function bootoutLaunchAgent(label: string, plistPath: string): boolean {
  const domain = launchAgentDomain();
  const byPlist = spawnSyncResult("launchctl", ["bootout", domain, plistPath]);
  if (byPlist.exitCode === 0) return true;
  const byLabel = spawnSyncResult("launchctl", ["bootout", `${domain}/${label}`]);
  return byLabel.exitCode === 0;
}

function parseLaunchAgentStatus(label: string): { loaded: boolean; state: string; pid?: string; raw?: string } {
  if (process.platform !== "darwin") return { loaded: false, state: "unsupported on this platform" };
  const result = launchctlPrint(label);
  if (result.exitCode !== 0) return { loaded: false, state: "not installed" };
  const state = result.stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim() ?? "unknown";
  const pid = result.stdout.match(/\bpid = ([^\n]+)/)?.[1]?.trim();
  return { loaded: true, state, pid, raw: result.stdout };
}

function tailTextFile(filePath: string, lines: number): string {
  if (!existsSync(filePath)) return "(missing)";
  const content = readFileSync(filePath, "utf-8");
  const parts = content.split(/\r?\n/);
  const trimmed = parts.at(-1) === "" ? parts.slice(0, -1) : parts;
  return trimmed.slice(-lines).join("\n") || "(empty)";
}

async function commandDaemon(options: RuntimeOptions, args: Args): Promise<void> {
  const subcommand = args._[1] || "status";
  const plistPath = launchAgentPlistPath();
  const logDir = path.join(options.stateDir, "logs");

  if (process.platform !== "darwin") {
    throw new Error("daemon commands currently support macOS LaunchAgent only.");
  }

  if (subcommand === "status") {
    const status = parseLaunchAgentStatus(DAEMON_LABEL);
    console.log("Codex WeChat Handoff daemon");
    console.log(`label: ${DAEMON_LABEL}`);
    console.log(`plist: ${plistPath}`);
    console.log(`state: ${status.state}`);
    if (status.pid) console.log(`pid: ${status.pid}`);
    console.log(`logs: ${logDir}`);
    return;
  }

  if (subcommand === "logs") {
    const lines = optionNumber(args, "lines", 80);
    const stdoutPath = path.join(logDir, "launchd.out.log");
    const stderrPath = path.join(logDir, "launchd.err.log");
    console.log(`==> ${stdoutPath}`);
    console.log(tailTextFile(stdoutPath, lines));
    console.log(`==> ${stderrPath}`);
    console.log(tailTextFile(stderrPath, lines));
    return;
  }

  if (subcommand === "install") {
    const bunBin = process.execPath;
    const scriptPath = path.resolve(Bun.argv[1] ?? path.join(import.meta.dir, "codex-wechat-ilink.ts"));
    const codexBin = resolveExecutable(options.codexBin) ?? options.codexBin;
    const projectsFile = options.projectsFile ?? defaultProjectsFile(options.stateDir);
    mkdirSync(path.dirname(plistPath), { recursive: true });
    mkdirSync(logDir, { recursive: true });
    const plist = buildLaunchAgentPlist({
      label: DAEMON_LABEL,
      bunBin,
      scriptPath,
      stateDir: options.stateDir,
      projectsFile,
      codexBin,
      workingDirectory: path.dirname(scriptPath),
      logDir,
      homeDir: os.homedir(),
    });
    writeFileSync(plistPath, plist, "utf-8");
    spawnSyncChecked("plutil", ["-lint", plistPath]);
    if (parseLaunchAgentStatus(DAEMON_LABEL).loaded) {
      bootoutLaunchAgent(DAEMON_LABEL, plistPath);
    }
    const domain = launchAgentDomain();
    spawnSyncChecked("launchctl", ["bootstrap", domain, plistPath]);
    spawnSyncChecked("launchctl", ["enable", `${domain}/${DAEMON_LABEL}`]);
    spawnSyncChecked("launchctl", ["kickstart", "-k", `${domain}/${DAEMON_LABEL}`]);
    const status = parseLaunchAgentStatus(DAEMON_LABEL);
    console.log(`installed: ${plistPath}`);
    console.log(`state: ${status.pid ? `${status.state} (pid ${status.pid})` : status.state}`);
    console.log(`logs: ${logDir}`);
    console.log("Next: codex-wechat daemon status");
    return;
  }

  if (subcommand === "stop") {
    const stopped = bootoutLaunchAgent(DAEMON_LABEL, plistPath);
    console.log(stopped ? `stopped: ${DAEMON_LABEL}` : `not running: ${DAEMON_LABEL}`);
    console.log(`plist left in place: ${plistPath}`);
    return;
  }

  if (subcommand === "uninstall") {
    bootoutLaunchAgent(DAEMON_LABEL, plistPath);
    rmSync(plistPath, { force: true });
    console.log(`uninstalled: ${DAEMON_LABEL}`);
    console.log(`removed: ${plistPath}`);
    return;
  }

  throw new Error(`Unknown daemon command: ${subcommand}. Use install, status, logs, stop, or uninstall.`);
}

async function commandDoctor(options: RuntimeOptions): Promise<void> {
  const stateDirWritable = (() => {
    try {
      mkdirSync(options.stateDir, { recursive: true });
      const probe = path.join(options.stateDir, `.doctor-${process.pid}.tmp`);
      writeFileSync(probe, "ok", "utf-8");
      rmSync(probe, { force: true });
      return "ok";
    } catch (error) {
      return `error (${error instanceof Error ? error.message : String(error)})`;
    }
  })();
  const chrome = findChromeExecutable();
  const qlmanage = findMacTool("qlmanage");
  const sips = findMacTool("sips");
  const lines = [
    "Codex WeChat Handoff doctor",
    `state_dir: ${options.stateDir}`,
    `state_dir_writable: ${stateDirWritable}`,
    `bun: ${Bun.version}`,
    `codex: ${commandVersion(options.codexBin)}`,
    `account: ${doctorAccountStatus(options.stateDir)}`,
    `projects: ${doctorProjectsStatus(options)}`,
    `daemon: ${doctorDaemonStatusForState(options.stateDir)}`,
    `renderer_chrome: ${chrome ? `ok (${chrome})` : "missing"}`,
    `renderer_quicklook: ${qlmanage ? `ok (${qlmanage})` : "missing"}`,
    `renderer_sips: ${sips ? `ok (${sips})` : "missing"}`,
  ];
  console.log(lines.join("\n"));
}

async function commandDiscoverSessions(options: RuntimeOptions, args: Args): Promise<void> {
  const projects = loadProjectRegistry({
    workspace: options.workspace,
    projectsConfig: loadProjectsConfig(options.projectsFile),
  });
  const projectName = resolveProjectName(projects, {
    requestedProject: typeof args.project === "string" ? args.project : "current",
    cwd: options.workspace,
  });
  const sessions = discoverCodexSessionsByCwd(projects.projects[projectName].cwd);
  if (!sessions.length) {
    console.log(`No Codex sessions found for project: ${projectName}`);
    return;
  }
  console.log(`Codex sessions for ${projectName}:`);
  sessions.slice(0, 20).forEach((session, index) => {
    console.log(`${index + 1}. ${session.threadId} ${new Date(session.mtimeMs).toISOString()} ${session.summary}`);
  });
}

async function commandCarryStatus(options: RuntimeOptions, args: Args): Promise<void> {
  const projects = loadProjectRegistry({
    workspace: options.workspace,
    projectsConfig: loadProjectsConfig(options.projectsFile),
  });
  const state = loadBridgeState(options.stateDir);
  const requestedProject = typeof args.project === "string" ? args.project : "current";
  const projectName = resolveProjectName(projects, { requestedProject, cwd: options.workspace });
  const lines = [`project: ${projectName}`, `state: ${options.stateDir}`];
  for (const [senderId, sender] of Object.entries(state.senders)) {
    const route = sender.routes?.[projectName];
    const session = sender.sessions?.[projectName];
    const contextThreadId = resolveWechatTurnThreadId(route, session) ?? route?.attachedThreadId ?? session?.threadId;
    const contextPressure = contextThreadId ? readCodexContextPressure(contextThreadId) : null;
    lines.push(
      [
        `sender: ${senderId}`,
        `thread: ${route?.attachedThreadId ?? session?.threadId ?? "none"}`,
        `lease: ${route?.leaseState ?? "wechat_owned"}`,
        `surface: ${route?.activeSurface ?? "wechat"}`,
        `parked: ${route?.parkedThreadId ?? "none"}`,
        ...(contextPressure ? [formatCodexContextPressureLine(contextPressure)] : []),
      ].join("\n"),
    );
  }
  if (lines.length === 2) lines.push("No sender routes yet.");
  console.log(lines.join("\n\n"));
}

async function commandCarryCurrent(options: RuntimeOptions, args: Args): Promise<void> {
  if (options.backend !== "app-server") {
    throw new Error("B-only handoff requires app-server backend so the Desktop thread can be forked into a mobile thread.");
  }
  const projects = loadProjectRegistry({
    workspace: options.workspace,
    projectsConfig: loadProjectsConfig(options.projectsFile),
  });
  const state = loadBridgeState(options.stateDir);
  const projectName = resolveProjectName(projects, {
    requestedProject: typeof args.project === "string" ? args.project : "current",
    cwd: options.workspace,
  });
  const threadId = typeof args["thread-id"] === "string" ? args["thread-id"] : readCurrentCodexThreadId();
  const senderId = resolveTargetSender(state, options.stateDir, typeof args.to === "string" ? args.to : "last");
  const project = projects.projects[projectName];
  const mode = normalizeMode(typeof args.mode === "string" ? args.mode : "") ?? activeMode(state, projects, senderId);
  const model = activeModel(state, projects, senderId, projectName) ?? options.codexModel;
  const contextPressure = readCodexContextPressure(threadId);
  if (shouldBlockNativeHandoffForContext(contextPressure)) {
    appendBridgeEvent(options.stateDir, {
      type: "context_pressure_blocked",
      data: { senderId, projectName, threadId, status: contextPressure.status, percent: contextPressure.percent },
    });
    throw new Error(buildNativeHandoffContextBlockedMessage(contextPressure));
  }
  const appServer = new CodexAppServerClient(options);
  let fork: AppServerForkResult;
  try {
    fork = await appServer.forkThread({
      threadId,
      cwd: project.cwd,
      mode,
      model,
      projectName,
    });
  } finally {
    appServer.stop();
  }
  const result = carryCurrentToWeChat(state, projects, {
    senderId,
    projectName,
    threadId,
    mobileThreadId: fork.threadId,
    mode,
    sessionCursor: findCodexSessionCursorByThread(threadId) ?? undefined,
    mobileStartCursor: fork.cursor ?? findCodexSessionCursorByThread(fork.threadId) ?? undefined,
    contextPressure,
  });
  saveBridgeState(options.stateDir, state);
  appendBridgeEvent(options.stateDir, { type: "carry_attached", data: { senderId, projectName, threadId, mobileThreadId: fork.threadId } });
  appendBridgeEvent(options.stateDir, { type: "lease_changed", data: { senderId, projectName, threadId, mobileThreadId: fork.threadId, leaseState: "wechat_active" } });

  let sendResult: { sent: boolean; reason?: string } = { sent: false, reason: "no_account" };
  try {
    const account = loadAccount(options.stateDir);
    sendResult = await sendProactiveText({
      account,
      stateDir: options.stateDir,
      senderId,
      text: result.notification,
      context: "carry_notice",
      dryRun: options.dryRun,
    });
  } catch (error) {
    appendBridgeEvent(options.stateDir, {
      type: "reply_send_failed",
      data: { senderId, context: "carry_notice", error: error instanceof Error ? error.message : String(error) },
    });
    sendResult = { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }

  console.log(result.notification);
  console.log("");
  console.log(`handoff: created`);
  console.log(`notification: ${sendResult.sent ? "sent" : `not_sent (${sendResult.reason})`}`);
}

async function commandPullCurrent(options: RuntimeOptions, args: Args): Promise<void> {
  const projects = loadProjectRegistry({
    workspace: options.workspace,
    projectsConfig: loadProjectsConfig(options.projectsFile),
  });
  const state = loadBridgeState(options.stateDir);
  const projectName = resolveProjectName(projects, {
    requestedProject: typeof args.project === "string" ? args.project : "current",
    cwd: options.workspace,
  });
  const threadId = typeof args["thread-id"] === "string" ? args["thread-id"] : readCurrentCodexThreadId();
  const eventsBeforePull = readBridgeEvents(options.stateDir);
  const workingState: BridgeState = options.dryRun ? JSON.parse(JSON.stringify(state)) : state;
  if (!options.dryRun) appendBridgeEvent(options.stateDir, { type: "desktop_pull_started", data: { projectName, threadId } });
  const result = pullCurrentToDesktop(workingState, {
    threadId,
    projectName,
    events: eventsBeforePull,
    projects,
  });
  if (options.dryRun) {
    console.log("dry-run: would pull current route back to Desktop");
    console.log(result.delta);
    return;
  }

  saveBridgeState(options.stateDir, state);
  appendBridgeEvent(options.stateDir, { type: "desktop_pull_completed", data: { senderId: result.senderId, projectName, threadId } });
  appendBridgeEvent(options.stateDir, { type: "lease_changed", data: { senderId: result.senderId, projectName, threadId, leaseState: "desktop_active" } });

  try {
    const account = loadAccount(options.stateDir);
    await sendProactiveText({
      account,
      stateDir: options.stateDir,
      senderId: result.senderId,
      text: result.notification,
      context: "pull_notice",
      dryRun: options.dryRun,
    });
  } catch (error) {
    appendBridgeEvent(options.stateDir, {
      type: "reply_send_failed",
      data: { senderId: result.senderId, context: "pull_notice", error: error instanceof Error ? error.message : String(error) },
    });
  }

  console.log(result.delta);
}

async function commandNotifyFinish(options: RuntimeOptions, args: Args): Promise<void> {
  const subcommand = String(args._[1] ?? "status").toLowerCase();
  const projects = loadProjectRegistry({
    workspace: options.workspace,
    projectsConfig: loadProjectsConfig(options.projectsFile),
  });
  const state = loadBridgeState(options.stateDir);
  const toArg = typeof args.to === "string" ? args.to : "last";
  const senderId = resolveTargetSender(state, options.stateDir, toArg);
  const resolveThreadId = (required: boolean): string | null => {
    if (typeof args["thread-id"] === "string" && args["thread-id"].trim()) return args["thread-id"].trim();
    try {
      return readCurrentCodexThreadId();
    } catch (error) {
      if (required) throw error;
      return null;
    }
  };

  if (subcommand === "default") {
    const action = String(args._[2] ?? "status").toLowerCase();
    if (action === "status") {
      const status = resolveFinishNotificationStatus(state, senderId);
      console.log(`finish_notify_default: ${status.globalDefault ? "on" : "off"}`);
      console.log(`sender: ${senderId}`);
      return;
    }
    if (action !== "on" && action !== "off") {
      throw new Error("Unknown notify-finish default command. Use default on, default off, or default status.");
    }
    const enabled = action === "on";
    setFinishNotificationDefault(state, senderId, enabled);
    saveBridgeState(options.stateDir, state);
    appendBridgeEvent(options.stateDir, { type: "finish_notify_default_changed", data: { senderId, enabled } });
    console.log(`finish_notify_default: ${enabled ? "on" : "off"}`);
    console.log(`sender: ${senderId}`);
    return;
  }

  if (subcommand === "on" || subcommand === "off" || subcommand === "inherit") {
    const threadId = resolveThreadId(true)!;
    const enabled = subcommand === "inherit" ? null : subcommand === "on";
    setFinishNotificationEnabled(state, senderId, enabled, threadId);
    saveBridgeState(options.stateDir, state);
    appendBridgeEvent(options.stateDir, { type: "finish_notify_toggled", data: { senderId, threadId, enabled } });
    const status = resolveFinishNotificationStatus(state, senderId, threadId);
    console.log(`finish_notify: ${status.enabled ? "on" : "off"}`);
    console.log(`source: ${status.source}`);
    console.log(`thread_override: ${typeof status.threadOverride === "boolean" ? (status.threadOverride ? "on" : "off") : "inherit"}`);
    console.log(`global_default: ${status.globalDefault ? "on" : "off"}`);
    console.log(`sender: ${senderId}`);
    console.log(`thread: ${threadId}`);
    return;
  }

  if (subcommand === "status") {
    const threadId = resolveThreadId(false);
    const notifications = finishNotificationsForStatus(senderState(state, senderId), threadId ?? undefined);
    const status = resolveFinishNotificationStatus(state, senderId, threadId ?? undefined);
    console.log(`finish_notify: ${status.enabled ? "on" : "off"}`);
    console.log(`source: ${status.source}`);
    console.log(`thread_override: ${typeof status.threadOverride === "boolean" ? (status.threadOverride ? "on" : "off") : "inherit"}`);
    console.log(`global_default: ${status.globalDefault ? "on" : "off"}`);
    console.log(`sender: ${senderId}`);
    console.log(`thread: ${threadId ?? "none"}`);
    console.log(`pending_continue: ${notifications?.pendingOffer ? "yes" : "no"}`);
    return;
  }

  if (subcommand !== "send") {
    throw new Error("Unknown notify-finish command. Use on, off, inherit, default, status, or send.");
  }

  const threadId = typeof args["thread-id"] === "string" ? args["thread-id"] : readCurrentCodexThreadId();
  if (!isFinishNotificationEnabled(state, senderId, threadId)) {
    console.log("finish_notify: off");
    console.log(`thread: ${threadId}`);
    console.log("not sent");
    return;
  }

  const projectName = resolveProjectName(projects, {
    requestedProject: typeof args.project === "string" ? args.project : "current",
    cwd: options.workspace,
  });
  const project = projects.projects[projectName];
  const mode = normalizeMode(typeof args.mode === "string" ? args.mode : "") ?? activeMode(state, projects, senderId);
  const model = typeof args.model === "string" ? args.model : activeModel(state, projects, senderId, projectName) ?? options.codexModel;
  const message = typeof args.message === "string" ? args.message : "";
  const summary = optionString(args, "summary", message);
  const nextAction = optionString(args, "next-action", optionString(args, "next", optionString(args, "decision", "")));
  const workingState: BridgeState = options.dryRun ? JSON.parse(JSON.stringify(state)) : state;
  const result = recordFinishRunOffer(workingState, projects, {
    senderId,
    projectName,
    threadId,
    mode,
    model,
    message,
    summary,
    nextAction,
    sessionCursor: options.dryRun ? undefined : findCodexSessionCursorByThread(threadId) ?? undefined,
  });

  if (options.dryRun) {
    console.log("dry-run: would send finish notification");
    console.log(`to: ${senderId}`);
    console.log(result.notification);
    return;
  }

  saveBridgeState(options.stateDir, state);
  appendBridgeEvent(options.stateDir, {
    type: "finish_notification_offered",
    data: { senderId, projectName, threadId, summary: result.offer.summary, nextAction: result.offer.nextAction, needsMobilePull: result.offer.needsMobilePull ?? false },
  });
  const account = loadAccount(options.stateDir);
  const sendResult = await sendProactiveText({
    account,
    stateDir: options.stateDir,
    senderId,
    text: result.notification,
    context: "finish_notice",
    dryRun: options.dryRun,
  });
  console.log(sendResult.sent ? "finish notification sent" : `finish notification not sent: ${sendResult.reason ?? "unknown"}`);
  console.log(`project: ${projectName}`);
  console.log(`cwd: ${project.cwd}`);
  console.log(`thread: ${threadId}`);
}

async function commandSendFile(options: RuntimeOptions, args: Args): Promise<void> {
  const rawFile = optionString(args, "file", args._[1] ?? "");
  if (!rawFile) throw new Error("send-file 需要 --file PATH。");
  const filePath = path.isAbsolute(expandHome(rawFile)) ? expandHome(rawFile) : path.resolve(options.workspace, rawFile);
  if (!existsSync(filePath)) throw new Error(`要发送的文件不存在: ${filePath}`);
  const toArg = typeof args.to === "string" ? args.to : "last";
  const message = typeof args.message === "string" ? args.message : "";

  if (options.dryRun) {
    console.log("dry-run: would send file");
    console.log(`to: ${toArg}`);
    console.log(`file: ${filePath}`);
    if (message) console.log(`message: ${message}`);
    return;
  }

  const state = loadBridgeState(options.stateDir);
  const senderId = resolveTargetSender(state, options.stateDir, toArg);
  const resolvedContext = resolveProactiveContextToken(options.stateDir, senderId, { allowEmptyFallback: true });
  if (resolvedContext.contextToken === null) throw new Error(`No context token available for ${senderId}`);
  const account = loadAccount(options.stateDir);
  const clientIds: string[] = [];
  if (message.trim()) {
    for (const chunk of chunkTextForWechat(message.trim())) {
      clientIds.push(await sendTextMessage(account, senderId, chunk, resolvedContext.contextToken));
    }
  }
  clientIds.push(await sendFileMessage(account, options.cdnBaseUrl, senderId, filePath, resolvedContext.contextToken));
  appendBridgeEvent(options.stateDir, {
    type: "reply_sent",
    data: { senderId, clientIds, context: "file_notice", contextSource: resolvedContext.source, fileName: path.basename(filePath) },
  });
  console.log(`sent: ${filePath}`);
  console.log(`client_ids: ${clientIds.join(",")}`);
}

async function commandSendText(options: RuntimeOptions, args: Args): Promise<void> {
  const message = optionString(args, "message", args._[1] ?? "");
  if (!message.trim()) throw new Error("send-text 需要 --message TEXT。");
  const toArg = typeof args.to === "string" ? args.to : "last";

  if (options.dryRun) {
    console.log("dry-run: would send text");
    console.log(`to: ${toArg}`);
    console.log(`message: ${message}`);
    return;
  }

  const state = loadBridgeState(options.stateDir);
  const senderId = resolveTargetSender(state, options.stateDir, toArg);
  const resolvedContext = resolveProactiveContextToken(options.stateDir, senderId, { allowEmptyFallback: true });
  if (resolvedContext.contextToken === null) throw new Error(`No context token available for ${senderId}`);
  const account = loadAccount(options.stateDir);
  const clientIds: string[] = [];
  for (const chunk of chunkTextForWechat(message.trim())) {
    clientIds.push(await sendTextMessage(account, senderId, chunk, resolvedContext.contextToken));
  }
  appendBridgeEvent(options.stateDir, {
    type: "reply_sent",
    data: { senderId, clientIds, context: "text_notice", contextSource: resolvedContext.source },
  });
  console.log("sent text");
  console.log(`client_ids: ${clientIds.join(",")}`);
}

async function commandSendImage(options: RuntimeOptions, args: Args): Promise<void> {
  const rawFile = optionString(args, "file", args._[1] ?? "");
  if (!rawFile) throw new Error("send-image 需要 --file PATH。");
  const imagePath = path.isAbsolute(expandHome(rawFile)) ? expandHome(rawFile) : path.resolve(options.workspace, rawFile);
  if (!existsSync(imagePath)) throw new Error(`要发送的图片不存在: ${imagePath}`);
  const toArg = typeof args.to === "string" ? args.to : "last";
  const message = typeof args.message === "string" ? args.message : "";

  if (options.dryRun) {
    console.log("dry-run: would send image");
    console.log(`to: ${toArg}`);
    console.log(`file: ${imagePath}`);
    if (message) console.log(`message: ${message}`);
    return;
  }

  const state = loadBridgeState(options.stateDir);
  const senderId = resolveTargetSender(state, options.stateDir, toArg);
  const resolvedContext = resolveProactiveContextToken(options.stateDir, senderId, { allowEmptyFallback: true });
  if (resolvedContext.contextToken === null) throw new Error(`No context token available for ${senderId}`);
  const account = loadAccount(options.stateDir);
  const clientIds: string[] = [];
  if (message.trim()) {
    for (const chunk of chunkTextForWechat(message.trim())) {
      clientIds.push(await sendTextMessage(account, senderId, chunk, resolvedContext.contextToken));
    }
  }
  clientIds.push(await sendImageMessage(account, options.cdnBaseUrl, senderId, imagePath, resolvedContext.contextToken));
  appendBridgeEvent(options.stateDir, {
    type: "reply_sent",
    data: { senderId, clientIds, context: "image_notice", contextSource: resolvedContext.source, fileName: path.basename(imagePath) },
  });
  console.log(`sent: ${imagePath}`);
  console.log(`client_ids: ${clientIds.join(",")}`);
}

async function commandRenderHtml(options: RuntimeOptions, args: Args): Promise<void> {
  const rawHtml = optionString(args, "html", args._[1] ?? "");
  if (!rawHtml) throw new Error("render-html 需要 --html PATH。");
  const htmlPath = resolveWorkspacePath(options.workspace, rawHtml);
  if (!existsSync(htmlPath)) throw new Error(`HTML 文件不存在: ${htmlPath}`);

  const hasExplicitPdf = args.pdf !== undefined;
  const hasExplicitPng = args.png !== undefined;
  const noExplicitOutputs = !hasExplicitPdf && !hasExplicitPng;
  const pdfPath =
    noExplicitOutputs || args.pdf === true
      ? defaultRenderOutputPath(htmlPath, ".pdf")
      : typeof args.pdf === "string"
        ? resolveWorkspacePath(options.workspace, args.pdf)
        : null;
  const pngPath =
    noExplicitOutputs || args.png === true
      ? defaultRenderOutputPath(htmlPath, ".png")
      : typeof args.png === "string"
        ? resolveWorkspacePath(options.workspace, args.png)
        : null;
  if (!pdfPath && !pngPath) throw new Error("render-html 至少需要一个输出：--pdf PATH 或 --png PATH。");

  const requested = optionString(args, "renderer", "auto") as HtmlRendererRequest;
  if (!["auto", "chrome", "quicklook"].includes(requested)) {
    throw new Error("--renderer 只能是 auto、chrome 或 quicklook。");
  }
  const chromeExecutable = findChromeExecutable();
  const qlmanage = findMacTool("qlmanage");
  const sips = findMacTool("sips");
  const selection = chooseHtmlRenderer({
    requested,
    needPdf: Boolean(pdfPath),
    needPng: Boolean(pngPath),
    chromeExecutable,
    quickLookAvailable: Boolean(qlmanage),
    sipsAvailable: Boolean(sips),
  });
  const viewport = parseViewport(optionString(args, "viewport", "1400x1000"));
  const timeoutMs = optionNumber(args, "render-timeout-ms", 30_000);

  if (options.dryRun) {
    console.log("dry-run: would render HTML");
    console.log(`renderer: ${selection.kind}`);
    console.log(`pdf_mode: ${selection.pdfMode}`);
    console.log(`html: ${htmlPath}`);
    if (pdfPath) console.log(`pdf: ${pdfPath}`);
    if (pngPath) console.log(`png: ${pngPath}`);
    return;
  }

  if (selection.kind === "chrome") {
    await renderHtmlWithChrome({
      chromeExecutable: selection.executable,
      htmlPath,
      pdfPath,
      pngPath,
      viewport,
      timeoutMs,
    });
  } else {
    renderHtmlWithQuickLook({
      qlmanage: qlmanage!,
      sips,
      htmlPath,
      pdfPath,
      pngPath,
      viewport,
    });
  }

  console.log(`renderer: ${selection.kind}`);
  console.log(`pdf_mode: ${selection.pdfMode}`);
  if (pdfPath) console.log(`pdf: ${pdfPath}`);
  if (pngPath) console.log(`png: ${pngPath}`);
}

async function commandStart(options: RuntimeOptions): Promise<void> {
  const account = loadAccount(options.stateDir);
  const projects = loadProjectRegistry({
    workspace: options.workspace,
    projectsConfig: loadProjectsConfig(options.projectsFile),
  });
  let bridgeState = loadBridgeState(options.stateDir);
  const appServer = options.backend === "app-server" ? new CodexAppServerClient(options) : null;
  mkdirSync(options.stateDir, { recursive: true });
  const lock = acquireBridgeLock(options.stateDir, {
    command: "start",
    projectsFile: options.projectsFile,
  });
  if (!lock.acquired) {
    throw new Error(
      `Another bridge is already running for ${options.stateDir} (pid=${lock.owner?.pid ?? "unknown"}). Stop it first or remove a stale lock.`,
    );
  }
  const daemonStartedAt = new Date().toISOString();
  appendBridgeEvent(options.stateDir, { type: "daemon_started", data: { pid: process.pid, backend: options.backend } });
  const heartbeatTimer = setInterval(() => heartbeatBridgeLock(options.stateDir), BRIDGE_LOCK_HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  let getUpdatesBuf = existsSync(syncBufFile(options.stateDir))
    ? readFileSync(syncBufFile(options.stateDir), "utf-8")
    : "";
  let consecutiveFailures = 0;
  let lastPollAt: string | null = null;
  let lastMessageAt: string | null = null;
  let lastError: string | null = null;
  let activeTurn = false;
  let activeThread: string | null = null;

  console.log("开始监听微信消息。");
  console.log(`state: ${options.stateDir}`);
  console.log(`backend: ${options.backend}`);
  console.log(`default project: ${projects.defaultProject}`);
  console.log(`projects: ${Object.keys(projects.projects).join(", ")}`);
  if (options.dryRun) console.log("dry-run 已开启：只生成回复，不调用 sendmessage。");

  while (true) {
    try {
      let updates = await getUpdates(account, getUpdatesBuf);
      if (isIlinkSessionTimeout(updates) && getUpdatesBuf) {
        appendBridgeEvent(options.stateDir, {
          type: "poll_error",
          data: { errcode: updates.errcode, errmsg: updates.errmsg, recovery: "clear_sync_buf_retry_once" },
        });
        clearSyncBuffer(options.stateDir);
        getUpdatesBuf = "";
        updates = await getUpdates(account, getUpdatesBuf);
      }
      const isError = (updates.ret !== undefined && updates.ret !== 0) || (updates.errcode !== undefined && updates.errcode !== 0);
      if (isError) {
        consecutiveFailures += 1;
        lastError = `getupdates failed: ret=${updates.ret} errcode=${updates.errcode} errmsg=${updates.errmsg ?? ""}`;
        appendBridgeEvent(options.stateDir, { type: "poll_error", data: { ret: updates.ret, errcode: updates.errcode, errmsg: updates.errmsg } });
        if (isIlinkSessionTimeout(updates)) {
          appendBridgeEvent(options.stateDir, { type: "auth_session_failed", data: { errcode: updates.errcode, errmsg: updates.errmsg } });
        }
        console.error(`getupdates 失败: ret=${updates.ret} errcode=${updates.errcode} errmsg=${updates.errmsg ?? ""}`);
        await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
        continue;
      }

      consecutiveFailures = 0;
      lastError = null;
      lastPollAt = new Date().toISOString();
      appendBridgeEvent(options.stateDir, { type: "poll_success", data: { messageCount: updates.msgs?.length ?? 0 } });
      if (updates.get_updates_buf) {
        getUpdatesBuf = updates.get_updates_buf;
        writeFileSync(syncBufFile(options.stateDir), getUpdatesBuf, "utf-8");
      }

      bridgeState = loadBridgeState(options.stateDir);
      const desktopPauses = pauseWechatRoutesForDesktopActivity(bridgeState);
      if (desktopPauses.length) {
        saveBridgeState(options.stateDir, bridgeState);
        for (const pause of desktopPauses) {
          appendBridgeEvent(options.stateDir, {
            type: "desktop_activity_detected",
            data: { senderId: pause.senderId, projectName: pause.projectName, threadId: pause.threadId },
          });
          appendBridgeEvent(options.stateDir, {
            type: "lease_changed",
            data: { senderId: pause.senderId, projectName: pause.projectName, threadId: pause.threadId, leaseState: "desktop_active" },
          });
          notifyDesktopRemotePaused({ projectName: pause.projectName, threadId: pause.threadId, needsReconcile: pause.needsReconcile });
          try {
            const sendResult = await sendProactiveText({
              account,
              stateDir: options.stateDir,
              senderId: pause.senderId,
              text: pause.notification,
              context: "desktop_activity_pause",
              dryRun: options.dryRun,
            });
            appendBridgeEvent(options.stateDir, {
              type: sendResult.sent ? "wechat_remote_paused" : "reply_send_failed",
              data: { senderId: pause.senderId, projectName: pause.projectName, threadId: pause.threadId, context: "desktop_activity_pause", reason: sendResult.reason },
            });
          } catch (error) {
            appendBridgeEvent(options.stateDir, {
              type: "reply_send_failed",
              data: {
                senderId: pause.senderId,
                projectName: pause.projectName,
                threadId: pause.threadId,
                context: "desktop_activity_pause",
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      }

      for (const msg of updates.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;
        bridgeState = loadBridgeState(options.stateDir);
        const senderId = msg.from_user_id ?? "";
        const contextToken = msg.context_token ?? "";
        const text = extractTextFromMessage(msg);
        const hasMedia = (msg.item_list ?? []).some((item) =>
          item.type === MSG_ITEM_IMAGE || item.type === MSG_ITEM_VOICE || item.type === MSG_ITEM_FILE || item.type === MSG_ITEM_VIDEO
        );
        if (!senderId || (!text && !hasMedia)) continue;
        if (projects.allowedSenderIds.length && !projects.allowedSenderIds.includes(senderId)) {
          console.error(`跳过未授权 sender: ${senderId}`);
          continue;
        }
        const senderForSeen = senderState(bridgeState, senderId);
        senderForSeen.lastSeenAt = new Date().toISOString();
        if (contextToken) {
          cacheContextToken(options.stateDir, senderId, contextToken);
          appendBridgeEvent(options.stateDir, { type: "context_token_updated", data: { senderId } });
        }
        const messageKey = buildInboundMessageKey(account, msg, text);
        if (!tryClaimInboundMessage(options.stateDir, messageKey)) {
          console.error(`跳过重复消息：sender=${senderId}`);
          continue;
        }
        appendBridgeEvent(options.stateDir, { type: "message_claimed", data: { senderId } });
        if (!contextToken) {
          console.error(`跳过消息：缺少 context_token，sender=${senderId}`);
          continue;
        }

        console.log(`收到消息: sender=${senderId} text=${text.slice(0, 120)}`);
        lastMessageAt = new Date().toISOString();
        const eventProjectName = activeProjectName(bridgeState, projects, senderId);
        const eventRoute = routeForProject(bridgeState, senderId, eventProjectName);
        const eventSession = senderState(bridgeState, senderId).sessions[eventProjectName];
        const eventThreadId = resolveWechatTurnThreadId(eventRoute, eventSession) ?? null;
        appendBridgeEvent(options.stateDir, {
          type: "wechat_message_received",
          data: { senderId, projectName: eventProjectName, threadId: eventThreadId ?? undefined, hasMedia, textPreview: text.slice(0, 120) },
        });
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
          let replyContext = "final_reply";
          let replyProjectName = eventProjectName;
          let replyThreadId: string | null = eventThreadId;

          if (parsed.type !== "message") {
            appendBridgeEvent(options.stateDir, { type: "command_received", data: { senderId, command: parsed.type } });
            replyContext = parsed.type === "health" ? "health_reply" : "command_reply";
            if (parsed.type === "health") {
              const projectName = activeProjectName(bridgeState, projects, senderId);
              const route = routeForProject(bridgeState, senderId, projectName);
              const session = senderState(bridgeState, senderId).sessions[projectName];
              const contextThreadId = resolveWechatTurnThreadId(route, session) ?? route?.attachedThreadId ?? session?.threadId;
              const contextPressure = contextThreadId ? readCodexContextPressure(contextThreadId) : null;
              reply = buildBridgeHealthReport({
                daemonStartedAt,
                stateDir: options.stateDir,
                appServerStatus: appServer ? "running" : "stopped",
                activeTurn,
                activeThread: activeThread ?? session?.threadId ?? null,
                project: projectName,
                mode: activeMode(bridgeState, projects, senderId),
                model: activeModel(bridgeState, projects, senderId, projectName) ?? options.codexModel,
                contextPressure,
                contextTokenCached: Boolean(resolveCachedContextToken(options.stateDir, senderId)),
                syncBufPresent: existsSync(syncBufFile(options.stateDir)),
                lockOwner: readBridgeLock(options.stateDir),
                lastPollAt,
                lastMessageAt,
                lastError,
              });
            } else if (parsed.type === "continue") {
              const pendingOffer = latestPendingFinishOffer(senderState(bridgeState, senderId))?.offer;
              let fork: AppServerForkResult | null = null;
              let continueContextPressure: CodexContextPressure | null = null;
              let blockedByContextPressure = false;
              if (pendingOffer) {
                const pendingRoute = senderState(bridgeState, senderId).routes?.[pendingOffer.projectName];
                const canUseExistingRoute = pendingRoute?.attachedThreadId === pendingOffer.threadId;
                if (!canUseExistingRoute && appServer) {
                  continueContextPressure = readCodexContextPressure(pendingOffer.threadId);
                  if (shouldBlockNativeHandoffForContext(continueContextPressure)) {
                    appendBridgeEvent(options.stateDir, {
                      type: "context_pressure_blocked",
                      data: {
                        senderId,
                        projectName: pendingOffer.projectName,
                        threadId: pendingOffer.threadId,
                        status: continueContextPressure.status,
                        percent: continueContextPressure.percent,
                      },
                    });
                    reply = buildNativeHandoffContextBlockedMessage(continueContextPressure);
                    replyProjectName = pendingOffer.projectName;
                    replyThreadId = pendingOffer.threadId;
                    saveBridgeState(options.stateDir, bridgeState);
                    blockedByContextPressure = true;
                  } else {
                    fork = await appServer.forkThread({
                      threadId: pendingOffer.threadId,
                      cwd: pendingOffer.cwd,
                      mode: pendingOffer.mode,
                      model: pendingOffer.model,
                      projectName: pendingOffer.projectName,
                    });
                  }
                }
              }
              if (!blockedByContextPressure) {
                const commandResult = continueFinishRunOfferToWeChat(bridgeState, projects, senderId, {
                  threadId: pendingOffer?.threadId,
                  mobileThreadId: fork?.threadId,
                  mobileStartCursor: fork?.cursor,
                  contextPressure: continueContextPressure,
                });
                saveBridgeState(options.stateDir, bridgeState);
                reply = commandResult.reply;
                replyProjectName = commandResult.projectName ?? eventProjectName;
                replyThreadId = commandResult.mobileThreadId ?? commandResult.desktopThreadId ?? eventThreadId;
                if (commandResult.projectName || commandResult.desktopThreadId || commandResult.mobileThreadId) {
                  appendBridgeEvent(options.stateDir, {
                    type: "finish_continue_requested",
                    data: {
                      senderId,
                      projectName: commandResult.projectName,
                      threadId: commandResult.desktopThreadId,
                      mobileThreadId: commandResult.mobileThreadId,
                    },
                  });
                }
              }
            } else {
              const commandProjectName = activeProjectName(bridgeState, projects, senderId);
              const commandRoute = routeForProject(bridgeState, senderId, commandProjectName);
              const commandSession = senderState(bridgeState, senderId).sessions[commandProjectName];
              const commandContextThreadId = resolveWechatTurnThreadId(commandRoute, commandSession) ?? commandRoute?.attachedThreadId ?? commandSession?.threadId;
              const commandContextPressure =
                parsed.type === "status" || parsed.type === "current"
                  ? commandContextThreadId
                    ? readCodexContextPressure(commandContextThreadId)
                    : null
                  : null;
              const commandResult = applyBridgeCommand(bridgeState, projects, senderId, parsed, { contextPressure: commandContextPressure });
              saveBridgeState(options.stateDir, bridgeState);
              reply = commandResult.reply;
            }
          } else {
            const sender = senderState(bridgeState, senderId);
            const projectName = activeProjectName(bridgeState, projects, senderId);
            const project = projects.projects[projectName];
            const mode = activeMode(bridgeState, projects, senderId);
            const model = activeModel(bridgeState, projects, senderId, projectName) ?? options.codexModel;
            const route = routeForProject(bridgeState, senderId, projectName);
            replyProjectName = projectName;
            const disposition = getOrdinaryWechatMessageDisposition(route ?? { leaseState: "wechat_active" });
            if (disposition.action === "block") {
              reply = buildBlockedOrdinaryWechatReply(disposition.reason, route);
              replyContext = "command_reply";
            } else if (disposition.action === "queue") {
              const position = enqueueDeferredRouteMessage(route!, {
                senderId,
                text: parsed.text,
                receivedAt: new Date().toISOString(),
              });
              reply = `已排队，等当前 Codex turn 完成后再处理。Queue position: ${position}`;
              replyContext = "command_reply";
              saveBridgeState(options.stateDir, bridgeState);
            } else {
            const input = buildWechatTurnInput({
              senderId,
              projectName,
              mode,
              model,
              text: consumePendingDesktopTranscript(route, parsed.text || "[WeChat media message]"),
              mediaFiles,
            });

            if (appServer) {
              const existingSession = sender.sessions[projectName];
              const activeThreadId = resolveWechatTurnThreadId(route, existingSession);
              replyThreadId = activeThreadId ?? null;
              activeTurn = true;
              activeThread = activeThreadId ?? null;
              if (route) {
                route.activeTurn = { turnId: "active", origin: "wechat", startedAt: new Date().toISOString() };
                saveBridgeState(options.stateDir, bridgeState);
              }
              appendBridgeEvent(options.stateDir, { type: "turn_started", data: { senderId, projectName, threadId: activeThread, backend: "app-server" } });
              try {
                const run = await appServer.runTurn({
                  threadId: activeThreadId,
                  cwd: project.cwd,
                  mode,
                  model,
                  input,
                  projectName,
                });
                if (route?.attachedThreadId) {
                  route.mobileThreadId = run.threadId;
                  route.lastWeChatTurnAt = new Date().toISOString();
                  route.mobileStartCursor ??= findCodexSessionCursorByThread(run.threadId) ?? undefined;
                  sender.sessions[projectName] = {
                    threadId: run.threadId,
                    cwd: project.cwd,
                    mode,
                  };
                  refreshPendingMobileTranscriptForRoute(bridgeState, projects, senderId, projectName);
                } else {
                  sender.sessions[projectName] = {
                    threadId: run.threadId,
                    cwd: project.cwd,
                    mode,
                  };
                }
                activeThread = run.threadId;
                replyThreadId = run.threadId;
                saveBridgeState(options.stateDir, bridgeState);
                appendBridgeEvent(options.stateDir, { type: "turn_completed", data: { senderId, projectName, threadId: run.threadId, backend: "app-server" } });
                reply = run.reply;
              } finally {
                if (route) {
                  route.activeTurn = null;
                  saveBridgeState(options.stateDir, bridgeState);
                }
                activeTurn = false;
              }
            } else {
              const execOptions: RuntimeOptions = {
                ...options,
                workspace: project.cwd,
                codexSandbox: legacySandboxForMode(mode),
                codexModel: model,
              };
              activeTurn = true;
              if (route) {
                route.activeTurn = { turnId: "active", origin: "wechat", startedAt: new Date().toISOString() };
                saveBridgeState(options.stateDir, bridgeState);
              }
              appendBridgeEvent(options.stateDir, { type: "turn_started", data: { senderId, projectName, backend: "exec" } });
              try {
                reply = await runCodexForReply(senderId, input, execOptions);
                appendHistory(options.stateDir, senderId, "user", buildInboundUserMessageText({ messageText: text, mediaFiles }), options.historyLimit);
                appendHistory(options.stateDir, senderId, "assistant", reply, options.historyLimit);
                if (route) {
                  route.lastWeChatTurnAt = new Date().toISOString();
                  if (route.mobileThreadId) route.mobileStartCursor ??= findCodexSessionCursorByThread(route.mobileThreadId) ?? undefined;
                  refreshPendingMobileTranscriptForRoute(bridgeState, projects, senderId, projectName);
                }
                appendBridgeEvent(options.stateDir, { type: "turn_completed", data: { senderId, projectName, backend: "exec" } });
              } finally {
                if (route) {
                  route.activeTurn = null;
                  saveBridgeState(options.stateDir, bridgeState);
                }
                activeTurn = false;
              }
            }
            }
          }
          console.log(`Codex 回复: ${reply.slice(0, 240)}`);

          if (!options.dryRun) {
            const clientIds = await sendReplyMessage({ account, options, toUserId: senderId, reply, contextToken });
            appendBridgeEvent(options.stateDir, {
              type: "reply_sent",
              data: { senderId, projectName: replyProjectName, threadId: replyThreadId ?? undefined, clientIds, context: replyContext },
            });
            console.log(`已发送: client_id=${clientIds.join(",")}`);
          }
        } catch (error) {
          const reply = formatBridgeError(error, options.codexTimeoutMs);
          console.error(`消息处理失败: sender=${senderId} error=${error instanceof Error ? error.message : String(error)}`);
          lastError = error instanceof Error ? error.message : String(error);
          if (!options.dryRun) {
            try {
              const clientId = await sendTextMessage(account, senderId, reply, contextToken);
              appendBridgeEvent(options.stateDir, {
                type: "reply_sent",
                data: { senderId, projectName: eventProjectName, threadId: eventThreadId ?? undefined, clientIds: [clientId], context: "error_reply" },
              });
              console.log(`已发送错误提示: client_id=${clientId}`);
            } catch (sendError) {
              appendBridgeEvent(options.stateDir, {
                type: "reply_send_failed",
                data: { senderId, context: "error_reply", error: sendError instanceof Error ? sendError.message : String(sendError) },
              });
              console.error(`错误提示发送失败: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
            }
          }
        }
      }
    } catch (error) {
      consecutiveFailures += 1;
      lastError = error instanceof Error ? error.message : String(error);
      appendBridgeEvent(options.stateDir, { type: "poll_error", data: { error: lastError } });
      console.error(`轮询异常: ${lastError}`);
      await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) consecutiveFailures = 0;
    }
  }
}

function printHelp(): void {
  console.log(`Codex WeChat Handoff

Usage:
  codex-wechat init [--project NAME] [--cwd PATH] [--mode read|write|fullaccess]
  codex-wechat project add <name> --cwd PATH [--mode read|write|fullaccess]
  codex-wechat project list
  codex-wechat doctor
  codex-wechat qr [--state-dir PATH]
  codex-wechat setup [--force] [--state-dir PATH]
  codex-wechat start [--workspace PATH] [--dry-run]
  codex-wechat daemon install|status|logs|stop|uninstall
  codex-wechat ask --message "..." [--mock-reply "..."]
  codex-wechat discover-sessions [--project current|NAME]
  codex-wechat carry-current [--project current|NAME] [--to last|SENDER] [--thread-id ID]
  codex-wechat pull-current [--project current|NAME] [--thread-id ID]
  codex-wechat carry-status [--project current|NAME]
  codex-wechat notify-finish on|off|inherit|status|default on|default off|send [--project current|NAME] [--to last|SENDER] [--summary "..."] [--next-action "..."]
  codex-wechat render-html --html PATH [--pdf PATH] [--png PATH] [--renderer auto|chrome|quicklook]
  codex-wechat send-text --message "..." [--to last|SENDER]
  codex-wechat send-file --file PATH [--to last|SENDER] [--message "..."]
  codex-wechat send-image --file PATH [--to last|SENDER] [--message "..."]

Aliases:
  codex-wechat sessions
  codex-wechat carry
  codex-wechat pull
  codex-wechat status

Common options:
  --state-dir PATH             Default: ~/.codex-wechat-handoff
  --base-url URL               Default: ${DEFAULT_BASE_URL}
  --cdn-base-url URL           Default: ${DEFAULT_CDN_BASE_URL}
  --workspace PATH             Codex working directory, default: current directory
  --projects PATH              Projects config JSON for /project routing
  --backend app-server|exec    Default: app-server
  --app-server-logs            Print codex app-server stderr logs
  --codex-bin PATH             Default: codex
  --model MODEL                Optional startup-level Codex model default
  --codex-timeout-ms N         Default: 600000
  --render-timeout-ms N        Default: 30000
  --lines N                    daemon logs line count, default: 80

WeChat commands:
  /projects
  /project <name>
  /mode read|write|fullaccess
  /model
  /model <model>
  /model default
  /status
  /health
  /current
  /sessions
  /attach latest|<index>|<thread_id>
  /back
  /resume
  /continue
  /detach
  /notify status
  /intro
  /onboarding
  /history [n]
  /help
  /new

Media reply markers:
  WECHAT_IMAGE: /absolute/path/to/image.png
  WECHAT_VOICE: /absolute/path/to/audio.silk playtime_ms=2000
  WECHAT_FILE: /absolute/path/to/report.pdf
`);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const command = args._[0] || "help";
  const options = runtimeOptions(args);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "init") {
    await commandInit(options, args);
  } else if (command === "project") {
    await commandProjectConfig(options, args);
  } else if (command === "doctor") {
    await commandDoctor(options);
  } else if (command === "daemon") {
    await commandDaemon(options, args);
  } else if (command === "qr") {
    await commandQR(options);
  } else if (command === "setup") {
    await commandSetup(options, args);
  } else if (command === "ask") {
    await commandAsk(options, args);
  } else if (command === "discover-sessions" || command === "sessions") {
    await commandDiscoverSessions(options, args);
  } else if (command === "carry-status" || command === "status") {
    await commandCarryStatus(options, args);
  } else if (command === "carry-current" || command === "carry") {
    await commandCarryCurrent(options, args);
  } else if (command === "pull-current" || command === "pull") {
    await commandPullCurrent(options, args);
  } else if (command === "notify-finish") {
    await commandNotifyFinish(options, args);
  } else if (command === "render-html") {
    await commandRenderHtml(options, args);
  } else if (command === "send-text") {
    await commandSendText(options, args);
  } else if (command === "send-file") {
    await commandSendFile(options, args);
  } else if (command === "send-image") {
    await commandSendImage(options, args);
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
