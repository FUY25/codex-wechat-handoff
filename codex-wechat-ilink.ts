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

export type SenderProjectRoute = RouteRuntimeState & {
  activeSurface?: "desktop" | "wechat";
  attachedThreadId?: string;
  attachedFrom?: "desktop" | "wechat";
  attachedAt?: string;
  parkedThreadId?: string;
  lastDesktopPullAt?: string | null;
  lastWeChatTurnAt?: string | null;
  pendingDeltaId?: string | null;
};

export type SenderState = {
  activeProject?: string;
  activeMode?: BridgeMode;
  projectModels?: Record<string, string>;
  routes?: Record<string, SenderProjectRoute>;
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
  | { type: "detach" }
  | { type: "history"; count: number }
  | { type: "help" }
  | { type: "stop" }
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
        threadId = String(entry.payload.id ?? threadId);
        cwd = String(entry.payload.cwd ?? cwd);
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

export function carryCurrentToWeChat(
  state: BridgeState,
  projects: ProjectRegistry,
  params: { senderId: string; projectName: string; threadId: string; now?: string; mode?: BridgeMode },
): { notification: string; route: SenderProjectRoute } {
  const project = projects.projects[params.projectName];
  if (!project) throw new Error(`Unknown project: ${params.projectName}`);
  const sender = senderState(state, params.senderId);
  sender.activeProject = params.projectName;
  const existingSession = sender.sessions[params.projectName];
  const mode = params.mode ?? sender.activeMode ?? existingSession?.mode ?? project.defaultMode;
  sender.activeMode = mode;
  const now = params.now ?? new Date().toISOString();
  const route: SenderProjectRoute = {
    activeSurface: "wechat",
    attachedThreadId: params.threadId,
    attachedFrom: "desktop",
    attachedAt: now,
    leaseState: "wechat_active",
    parkedThreadId: existingSession?.threadId,
    lastDesktopPullAt: null,
    pendingDeltaId: null,
  };
  sender.routes ??= {};
  sender.routes[params.projectName] = route;
  const notification = [
    "continue from here",
    "",
    "已接到电脑上的 Codex 会话。",
    `project: ${params.projectName}`,
    `thread: ${params.threadId}`,
    `mode: ${mode}`,
    "",
    "直接回复就从这里继续。",
    "回电脑时可以在电脑上说 /wechat pull，或在手机发 /back。",
  ].join("\n");
  return { notification, route };
}

export function buildCarryBackDelta(
  events: BridgeEvent[],
  params: { senderId: string; since?: string | null },
): string {
  const sinceMs = params.since ? Date.parse(params.since) : 0;
  const deltaEventTypes = new Set(["wechat_message_received", "turn_completed", "reply_sent"]);
  const lines = events
    .filter((event) => {
      if (!deltaEventTypes.has(event.type)) return false;
      const atMs = Date.parse(event.at);
      if (Number.isFinite(sinceMs) && Number.isFinite(atMs) && atMs < sinceMs) return false;
      if (event.data?.senderId && event.data.senderId !== params.senderId) return false;
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
  params: { threadId: string; projectName?: string; events: BridgeEvent[]; now?: string },
): { senderId: string; projectName: string; delta: string; notification: string } {
  const found = findRouteByThread(state, params.threadId, params.projectName);
  if (!found) throw new Error(`No WeChat route is attached to thread ${params.threadId}`);
  found.route.leaseState = "desktop_active";
  found.route.activeSurface = "desktop";
  found.route.lastDesktopPullAt = params.now ?? new Date().toISOString();
  const delta = buildCarryBackDelta(found.route ? params.events : [], {
    senderId: found.senderId,
    since: found.route.attachedAt ?? null,
  });
  const notification = [
    "已切回电脑继续。",
    "手机这边已暂停 remote mode。",
    "",
    "如果还想从手机继续，发 /resume。",
    "如果想回到手机原来的会话，发 /detach。",
  ].join("\n");
  return { senderId: found.senderId, projectName: found.projectName, delta, notification };
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
  if (!existsSync(file)) return undefined;
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
  state.senders[senderId].routes ??= {};
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
  if (command === "/current" || command === "/info") return { type: "current" };
  if (command === "/sessions" || command === "/list") return { type: "sessions" };
  if (command === "/attach" || command === "/switch") {
    if (!arg) return { type: "error", message: `Usage: ${rawCommand} latest|<index>|<thread_id>` };
    return { type: "attach", target: arg };
  }
  if (command === "/back") return { type: "back" };
  if (command === "/resume") return { type: "resume" };
  if (command === "/detach") return { type: "detach" };
  if (command === "/history") {
    const count = arg ? Number(arg) : 10;
    if (!Number.isInteger(count) || count <= 0) return { type: "error", message: "Usage: /history [positive_number]" };
    return { type: "history", count };
  }
  if (command === "/help") return { type: "help" };
  if (command === "/stop") return { type: "stop" };
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
  if (command === "/health") return { type: "health" };
  if (command === "/status") return { type: "status" };
  if (command === "/new" || command === "/clear") return { type: "new" };

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
    if (!route?.attachedThreadId) return { handled: true, reply: "当前没有可恢复的 attached thread。" };
    route.leaseState = "wechat_active";
    route.activeSurface = "wechat";
    return { handled: true, reply: "已回到手机 remote mode。\n直接发消息就继续刚才的 Codex thread。" };
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

  if (command.type === "help") {
    return {
      handled: true,
      reply: [
        "/current /sessions /attach latest|<id>",
        "/back /resume /detach",
        "/projects /project <name>",
        "/mode read|write|bypass",
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
        "WeChat replies should feel natural and human, not stiff or robotic.",
        "Incoming WeChat images and voice files may appear as local paths in the user message; inspect image paths when visual details matter.",
        "When appropriate, use the imagegen skill to generate images for the user.",
        "To send an image through WeChat, put a line exactly like: WECHAT_IMAGE: /absolute/path/to/image.png",
        "To send a voice message through WeChat, put a line exactly like: WECHAT_VOICE: /absolute/path/to/audio.silk playtime_ms=2000",
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
        "WeChat replies should feel natural and human, not stiff or robotic.",
        "Incoming WeChat images and voice files may appear as local paths in the user message; inspect image paths when visual details matter.",
        "When appropriate, use the imagegen skill to generate images for the user.",
        "To send an image through WeChat, put a line exactly like: WECHAT_IMAGE: /absolute/path/to/image.png",
        "To send a voice message through WeChat, put a line exactly like: WECHAT_VOICE: /absolute/path/to/audio.silk playtime_ms=2000",
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
  const projectName = optionString(args, "project", "default");
  const cwd = path.resolve(expandHome(optionString(args, "cwd", process.cwd())));
  const projectsPath = typeof args.projects === "string" ? path.resolve(expandHome(args.projects)) : defaultProjectsFile(options.stateDir);
  mkdirSync(path.dirname(projectsPath), { recursive: true });
  const config: ProjectsConfig = {
    defaultProject: projectName,
    allowedSenderIds: [],
    projects: {
      [projectName]: {
        cwd,
        defaultMode: "read",
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
  console.log("Next: codex-wechat setup");
  console.log("Then: codex-wechat doctor");
  console.log("Then: codex-wechat daemon install");
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

function doctorDaemonStatus(): string {
  if (process.platform !== "darwin") return "unsupported on this platform";
  const label = "com.codex-wechat-handoff.daemon";
  const result = Bun.spawnSync({
    cmd: ["launchctl", "print", `gui/${process.getuid?.() ?? ""}/${label}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return "not installed";
  const output = result.stdout.toString();
  const state = output.match(/\bstate = ([^\n]+)/)?.[1]?.trim() ?? "unknown";
  const pid = output.match(/\bpid = ([^\n]+)/)?.[1]?.trim();
  return pid ? `${state} (pid ${pid})` : state;
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
    `daemon: ${doctorDaemonStatus()}`,
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
    lines.push(
      [
        `sender: ${senderId}`,
        `thread: ${route?.attachedThreadId ?? session?.threadId ?? "none"}`,
        `lease: ${route?.leaseState ?? "wechat_owned"}`,
        `surface: ${route?.activeSurface ?? "wechat"}`,
        `parked: ${route?.parkedThreadId ?? "none"}`,
      ].join("\n"),
    );
  }
  if (lines.length === 2) lines.push("No sender routes yet.");
  console.log(lines.join("\n\n"));
}

async function commandCarryCurrent(options: RuntimeOptions, args: Args): Promise<void> {
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
  const result = carryCurrentToWeChat(state, projects, {
    senderId,
    projectName,
    threadId,
    mode: normalizeMode(typeof args.mode === "string" ? args.mode : "") ?? undefined,
  });
  saveBridgeState(options.stateDir, state);
  appendBridgeEvent(options.stateDir, { type: "carry_attached", data: { senderId, projectName, threadId } });
  appendBridgeEvent(options.stateDir, { type: "lease_changed", data: { senderId, projectName, threadId, leaseState: "wechat_active" } });

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
  appendBridgeEvent(options.stateDir, { type: "desktop_pull_started", data: { projectName, threadId } });
  const result = pullCurrentToDesktop(state, {
    threadId,
    projectName,
    events: eventsBeforePull,
  });
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
  const bridgeState = loadBridgeState(options.stateDir);
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

      for (const msg of updates.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;
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
        appendBridgeEvent(options.stateDir, { type: "wechat_message_received", data: { senderId, hasMedia, textPreview: text.slice(0, 120) } });
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

          if (parsed.type !== "message") {
            appendBridgeEvent(options.stateDir, { type: "command_received", data: { senderId, command: parsed.type } });
            replyContext = parsed.type === "health" ? "health_reply" : "command_reply";
            if (parsed.type === "health") {
              const projectName = activeProjectName(bridgeState, projects, senderId);
              const session = senderState(bridgeState, senderId).sessions[projectName];
              reply = buildBridgeHealthReport({
                daemonStartedAt,
                stateDir: options.stateDir,
                appServerStatus: appServer ? "running" : "stopped",
                activeTurn,
                activeThread: activeThread ?? session?.threadId ?? null,
                project: projectName,
                mode: activeMode(bridgeState, projects, senderId),
                model: activeModel(bridgeState, projects, senderId, projectName) ?? options.codexModel,
                contextTokenCached: Boolean(resolveCachedContextToken(options.stateDir, senderId)),
                syncBufPresent: existsSync(syncBufFile(options.stateDir)),
                lockOwner: readBridgeLock(options.stateDir),
                lastPollAt,
                lastMessageAt,
                lastError,
              });
            } else {
              const commandResult = applyBridgeCommand(bridgeState, projects, senderId, parsed);
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
            const disposition = getOrdinaryWechatMessageDisposition(route ?? { leaseState: "wechat_active" });
            if (disposition.action === "block") {
              reply =
                disposition.reason === "desktop_active"
                  ? "这条 Codex thread 现在在 Desktop active。要从手机继续，发 /resume。"
                  : "这条 Codex thread 正在等待 Desktop pull。要从手机继续，发 /resume；要退出 carry-over，发 /detach。";
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
              text: parsed.text || "[WeChat media message]",
              mediaFiles,
            });

            if (appServer) {
              const existingSession = sender.sessions[projectName];
              const activeThreadId = route?.attachedThreadId ?? existingSession?.threadId;
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
                  route.attachedThreadId = run.threadId;
                  route.lastWeChatTurnAt = new Date().toISOString();
                } else {
                  sender.sessions[projectName] = {
                    threadId: run.threadId,
                    cwd: project.cwd,
                    mode,
                  };
                }
                activeThread = run.threadId;
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
                if (route) route.lastWeChatTurnAt = new Date().toISOString();
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
            appendBridgeEvent(options.stateDir, { type: "reply_sent", data: { senderId, clientIds, context: replyContext } });
            console.log(`已发送: client_id=${clientIds.join(",")}`);
          }
        } catch (error) {
          const reply = formatBridgeError(error, options.codexTimeoutMs);
          console.error(`消息处理失败: sender=${senderId} error=${error instanceof Error ? error.message : String(error)}`);
          lastError = error instanceof Error ? error.message : String(error);
          if (!options.dryRun) {
            try {
              const clientId = await sendTextMessage(account, senderId, reply, contextToken);
              appendBridgeEvent(options.stateDir, { type: "reply_sent", data: { senderId, clientIds: [clientId], context: "error_reply" } });
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
  codex-wechat init [--project NAME] [--cwd PATH]
  codex-wechat doctor
  codex-wechat qr [--state-dir PATH]
  codex-wechat setup [--force] [--state-dir PATH]
  codex-wechat start [--workspace PATH] [--dry-run]
  codex-wechat ask --message "..." [--mock-reply "..."]
  codex-wechat discover-sessions [--project current|NAME]
  codex-wechat carry-current [--project current|NAME] [--to last|SENDER] [--thread-id ID]
  codex-wechat pull-current [--project current|NAME] [--thread-id ID]
  codex-wechat carry-status [--project current|NAME]
  codex-wechat render-html --html PATH [--pdf PATH] [--png PATH] [--renderer auto|chrome|quicklook]
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

WeChat commands:
  /projects
  /project <name>
  /mode read|write|bypass
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
  /detach
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
  } else if (command === "doctor") {
    await commandDoctor(options);
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
  } else if (command === "render-html") {
    await commandRenderHtml(options, args);
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
