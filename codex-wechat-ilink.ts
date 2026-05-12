#!/usr/bin/env bun
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
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
const MSG_ITEM_VOICE = 3;

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
  voice_item?: { text?: string };
  ref_msg?: { title?: string };
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
  workspace: string;
  codexBin: string;
  codexModel?: string;
  codexSandbox: string;
  codexTimeoutMs: number;
  historyLimit: number;
  persistCodexSessions: boolean;
  dryRun: boolean;
  mockReply?: string;
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
    workspace: path.resolve(expandHome(optionString(args, "workspace", process.cwd()))),
    codexBin: optionString(args, "codex-bin", "codex"),
    codexModel: typeof args.model === "string" ? args.model : undefined,
    codexSandbox: optionString(args, "codex-sandbox", "read-only"),
    codexTimeoutMs: optionNumber(args, "codex-timeout-ms", 120_000),
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
  for (const item of msg.item_list ?? []) {
    if (item.type === MSG_ITEM_TEXT && item.text_item?.text) {
      const text = item.text_item.text;
      const refTitle = item.ref_msg?.title;
      return refTitle ? `[引用: ${refTitle}]\n${text}` : text;
    }
    if (item.type === MSG_ITEM_VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

function safeUserFileName(userId: string): string {
  return Buffer.from(userId, "utf-8").toString("base64url");
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
  const reply = await runCodexForReply(senderId, message, options);
  console.log(reply);
}

async function commandStart(options: RuntimeOptions): Promise<void> {
  const account = loadAccount(options.stateDir);
  mkdirSync(options.stateDir, { recursive: true });
  let getUpdatesBuf = existsSync(syncBufFile(options.stateDir))
    ? readFileSync(syncBufFile(options.stateDir), "utf-8")
    : "";
  let consecutiveFailures = 0;

  console.log("开始监听微信消息。");
  console.log(`state: ${options.stateDir}`);
  console.log(`workspace: ${options.workspace}`);
  console.log(`codex: ${options.codexBin} exec --sandbox ${options.codexSandbox}`);
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
        if (!senderId || !text) continue;
        if (!contextToken) {
          console.error(`跳过消息：缺少 context_token，sender=${senderId}`);
          continue;
        }

        console.log(`收到消息: sender=${senderId} text=${text.slice(0, 120)}`);
        const reply = await runCodexForReply(senderId, text, options);
        console.log(`Codex 回复: ${reply.slice(0, 240)}`);

        if (!options.dryRun) {
          const clientId = await sendTextMessage(account, senderId, reply, contextToken);
          console.log(`已发送: client_id=${clientId}`);
        }
        appendHistory(options.stateDir, senderId, "user", text, options.historyLimit);
        appendHistory(options.stateDir, senderId, "assistant", reply, options.historyLimit);
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
  --codex-bin PATH             Default: codex
  --model MODEL                Optional Codex model override
  --codex-sandbox MODE         Default: read-only
  --codex-timeout-ms N         Default: 120000
  --history-limit N            Default: 12
  --persist-codex-sessions     Do not pass --ephemeral to codex exec
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
