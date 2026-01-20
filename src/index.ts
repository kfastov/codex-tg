import "dotenv/config";

import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

import {
  Codex,
  type ApprovalMode,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type ThreadOptions
} from "@openai/codex-sdk";
import { Telegraf, type Context } from "telegraf";

import { StateStore } from "./store.js";

const execFileAsync = promisify(execFile);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

const allowedUsersEnv = process.env.TELEGRAM_ALLOWED_USER_IDS ?? "";
const allowedUserIds = allowedUsersEnv
  .split(/[\s,]+/)
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => Number.parseInt(value, 10))
  .filter((value) => Number.isFinite(value));
const allowedUserSet = allowedUserIds.length ? new Set(allowedUserIds) : null;

const statePath =
  process.env.CODEX_TG_STATE_PATH ?? path.join(process.cwd(), "data", "state.json");
const parsedInterval = Number.parseInt(
  process.env.STATUS_UPDATE_INTERVAL_MS ?? "1000",
  10
);
const statusUpdateIntervalMs = Number.isFinite(parsedInterval) ? parsedInterval : 1000;

const defaultThreadOptions: ThreadOptions = {
  workingDirectory: process.env.CODEX_WORKDIR ?? process.cwd(),
  model: process.env.CODEX_MODEL ?? undefined,
  sandboxMode: (process.env.CODEX_SANDBOX_MODE as SandboxMode | undefined) ?? undefined,
  approvalPolicy:
    (process.env.CODEX_APPROVAL_POLICY as ApprovalMode | undefined) ?? undefined
};

const store = new StateStore(statePath);
await store.load();

const codex = new Codex();
const bot = new Telegraf(BOT_TOKEN);

const MAX_MESSAGE_CHARS = 3500;
const MAX_MENTION_BYTES = 20000;

type RuntimeChatState = {
  busy: boolean;
  thread: Thread | null;
  pendingMentions: string[];
  statusMessageId: number | null;
  statusChatId: number | null;
  lastStatusText: string | null;
  lastStatusAt: number;
};

const runtimeState = new Map<string, RuntimeChatState>();

function getRuntime(chatId: string): RuntimeChatState {
  const existing = runtimeState.get(chatId);
  if (existing) return existing;
  const created: RuntimeChatState = {
    busy: false,
    thread: null,
    pendingMentions: [],
    statusMessageId: null,
    statusChatId: null,
    lastStatusText: null,
    lastStatusAt: 0
  };
  runtimeState.set(chatId, created);
  return created;
}

function resetThread(chatId: string): void {
  const runtime = getRuntime(chatId);
  runtime.thread = null;
}

function isUserAllowed(ctx: Context): boolean {
  if (!allowedUserSet) return true;
  const userId = ctx.from?.id;
  if (!userId) return false;
  return allowedUserSet.has(userId);
}

function getThread(chatId: string, options: ThreadOptions, threadId: string | null): Thread {
  const runtime = getRuntime(chatId);
  if (runtime.thread) return runtime.thread;
  const thread = threadId ? codex.resumeThread(threadId, options) : codex.startThread(options);
  runtime.thread = thread;
  return thread;
}

function chunkText(text: string, maxSize = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= maxSize) return [text];
  const chunks: string[] = [];
  let buffer = "";
  for (const line of text.split("\n")) {
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length > maxSize) {
      if (buffer) chunks.push(buffer);
      if (line.length > maxSize) {
        chunks.push(line.slice(0, maxSize));
        buffer = line.slice(maxSize);
      } else {
        buffer = line;
      }
    } else {
      buffer = candidate;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

async function sendText(ctx: Context, text: string): Promise<void> {
  const chunks = chunkText(text);
  let isFirst = true;
  for (const chunk of chunks) {
    await ctx.reply(chunk, { disable_notification: !isFirst });
    isFirst = false;
  }
}

async function sendFile(ctx: Context, filename: string, content: string) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-tg-"));
  const filePath = path.join(tmpDir, filename);
  await fs.writeFile(filePath, content, "utf8");
  await ctx.replyWithDocument({ source: filePath, filename });
  await fs.rm(tmpDir, { recursive: true, force: true });
}

function truncate(text: string, max = 80): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function statusFromEvent(event: ThreadEvent): string | null {
  switch (event.type) {
    case "turn.started":
      return "Thinking...";
    case "item.started":
    case "item.updated":
    case "item.completed":
      switch (event.item.type) {
        case "reasoning":
          return "Thinking...";
        case "command_execution":
          return `Running command: ${truncate(event.item.command)}`;
        case "file_change":
          return "Applying file changes...";
        case "mcp_tool_call":
          return `Calling MCP tool: ${event.item.server}/${event.item.tool}`;
        case "web_search":
          return `Web search: ${truncate(event.item.query, 60)}`;
        case "todo_list":
          return "Updating plan...";
        case "agent_message":
          return "Finalizing response...";
        case "error":
          return `Error: ${truncate(event.item.message, 80)}`;
        default:
          return null;
      }
    case "turn.completed":
      return "Finalizing response...";
    case "turn.failed":
      return "Failed to complete the turn.";
    default:
      return null;
  }
}

async function updateStatus(
  ctx: Context,
  runtime: RuntimeChatState,
  text: string
): Promise<void> {
  if (!runtime.statusMessageId || !runtime.statusChatId) return;
  const now = Date.now();
  if (runtime.lastStatusText === text && now - runtime.lastStatusAt < statusUpdateIntervalMs) {
    return;
  }
  if (now - runtime.lastStatusAt < statusUpdateIntervalMs) {
    return;
  }
  runtime.lastStatusAt = now;
  runtime.lastStatusText = text;
  try {
    await ctx.telegram.editMessageText(runtime.statusChatId, runtime.statusMessageId, undefined, text);
  } catch {
    // Ignore edit failures (message could be deleted or rate limited).
  }
}

async function clearStatus(ctx: Context, runtime: RuntimeChatState): Promise<void> {
  if (!runtime.statusMessageId || !runtime.statusChatId) return;
  try {
    await ctx.telegram.deleteMessage(runtime.statusChatId, runtime.statusMessageId);
  } catch {
    // Ignore delete failures.
  } finally {
    runtime.statusMessageId = null;
    runtime.statusChatId = null;
    runtime.lastStatusText = null;
  }
}

async function readMention(pathInput: string, workingDirectory: string): Promise<string> {
  const resolved = path.isAbsolute(pathInput)
    ? pathInput
    : path.resolve(workingDirectory, pathInput);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error(`${pathInput} is not a file`);
  }
  const contents = await fs.readFile(resolved);
  const truncated = contents.length > MAX_MENTION_BYTES;
  const slice = truncated ? contents.slice(0, MAX_MENTION_BYTES) : contents;
  const header = `File: ${resolved}`;
  const body = slice.toString("utf8");
  const suffix = truncated ? "\n...(truncated)" : "";
  return `${header}\n${body}${suffix}`;
}

async function buildPrompt(
  rawPrompt: string,
  mentions: string[],
  workingDirectory: string
): Promise<string> {
  if (!mentions.length) return rawPrompt;
  const blocks: string[] = [];
  for (const mention of mentions) {
    const block = await readMention(mention, workingDirectory);
    blocks.push(block);
  }
  return `Use the following files as context:\n\n${blocks.join("\n\n")}\n\nUser request:\n${rawPrompt}`;
}

async function runCodexTurn(
  ctx: Context,
  chatId: string,
  prompt: string
): Promise<void> {
  const runtime = getRuntime(chatId);
  const chatConfig = store.getOrCreateChat(chatId, defaultThreadOptions);

  if (runtime.busy) {
    await ctx.reply("Still working on the previous request. Please wait.");
    return;
  }

  runtime.busy = true;
  try {
    const workingDirectory =
      chatConfig.threadOptions.workingDirectory ?? process.cwd();
    const expandedPrompt = await buildPrompt(
      prompt,
      runtime.pendingMentions,
      workingDirectory
    );
    runtime.pendingMentions = [];

    const thread = getThread(chatId, chatConfig.threadOptions, chatConfig.threadId);

    const statusMessage = await ctx.reply("Thinking...", { disable_notification: true });
    runtime.statusMessageId = statusMessage.message_id;
    runtime.statusChatId = statusMessage.chat.id;
    runtime.lastStatusText = "Thinking...";
    runtime.lastStatusAt = Date.now();

    let finalResponse = "";
    const streamed = await thread.runStreamed(expandedPrompt);

    for await (const event of streamed.events) {
      if (event.type === "thread.started") {
        chatConfig.threadId = event.thread_id;
        if (!chatConfig.threadHistory.includes(event.thread_id)) {
          chatConfig.threadHistory.unshift(event.thread_id);
        }
        await store.save();
      }

      const status = statusFromEvent(event);
      if (status) {
        await updateStatus(ctx, runtime, status);
      }

      if (event.type === "item.completed" && event.item.type === "agent_message") {
        finalResponse = event.item.text;
      }

      if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      }

      if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    await clearStatus(ctx, runtime);

    if (!finalResponse) {
      finalResponse = "Done.";
    }

    await sendText(ctx, finalResponse);
  } catch (error) {
    await clearStatus(ctx, runtime);
    const message = error instanceof Error ? error.message : "Unknown error";
    await ctx.reply(`Codex failed: ${message}`);
  } finally {
    runtime.busy = false;
  }
}

async function handleDiff(ctx: Context, chatId: string): Promise<void> {
  const chatConfig = store.getOrCreateChat(chatId, defaultThreadOptions);
  const cwd = chatConfig.threadOptions.workingDirectory ?? process.cwd();
  try {
    const { stdout, stderr } = await execFileAsync("git", ["diff"], { cwd, maxBuffer: 20 * 1024 * 1024 });
    const output = stdout || stderr || "No diff.";
    if (output.length > MAX_MESSAGE_CHARS) {
      await sendFile(ctx, "diff.txt", output);
    } else {
      await ctx.reply(output);
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const details = err.stderr || err.stdout || err.message || "Failed to run git diff.";
    await ctx.reply(details);
  }
}

async function handleStatus(ctx: Context, chatId: string): Promise<void> {
  const chatConfig = store.getOrCreateChat(chatId, defaultThreadOptions);
  const runtime = getRuntime(chatId);
  const lines = [
    `thread: ${chatConfig.threadId ?? "(new)"}`,
    `model: ${chatConfig.threadOptions.model ?? "default"}`,
    `sandbox: ${chatConfig.threadOptions.sandboxMode ?? "default"}`,
    `approvals: ${chatConfig.threadOptions.approvalPolicy ?? "default"}`,
    `workdir: ${chatConfig.threadOptions.workingDirectory ?? process.cwd()}`,
    `pending mentions: ${runtime.pendingMentions.length}`,
    `busy: ${runtime.busy ? "yes" : "no"}`
  ];
  await ctx.reply(lines.join("\n"));
}

async function handleModel(ctx: Context, chatId: string, args: string): Promise<void> {
  const chatConfig = store.getOrCreateChat(chatId, defaultThreadOptions);
  if (!args) {
    await ctx.reply(`Current model: ${chatConfig.threadOptions.model ?? "default"}`);
    return;
  }
  chatConfig.threadOptions.model = args.trim();
  resetThread(chatId);
  await store.save();
  await ctx.reply(`Model set to ${chatConfig.threadOptions.model}`);
}

async function handleApprovals(ctx: Context, chatId: string, args: string): Promise<void> {
  const chatConfig = store.getOrCreateChat(chatId, defaultThreadOptions);
  if (!args) {
    await ctx.reply(`Current approval policy: ${chatConfig.threadOptions.approvalPolicy ?? "default"}`);
    return;
  }
  const value = args.trim() as ApprovalMode;
  const allowed: ApprovalMode[] = ["never", "on-request", "on-failure", "untrusted"];
  if (!allowed.includes(value)) {
    await ctx.reply(`Invalid approval policy. Use: ${allowed.join(", ")}`);
    return;
  }
  chatConfig.threadOptions.approvalPolicy = value;
  resetThread(chatId);
  await store.save();
  await ctx.reply(`Approval policy set to ${value}`);
}

async function handleNew(ctx: Context, chatId: string): Promise<void> {
  const chatConfig = store.getOrCreateChat(chatId, defaultThreadOptions);
  if (chatConfig.threadId && !chatConfig.threadHistory.includes(chatConfig.threadId)) {
    chatConfig.threadHistory.unshift(chatConfig.threadId);
  }
  chatConfig.threadId = null;
  resetThread(chatId);
  await store.save();
  await ctx.reply("Started a new session.");
}

async function handleResume(ctx: Context, chatId: string, args: string): Promise<void> {
  const chatConfig = store.getOrCreateChat(chatId, defaultThreadOptions);
  const threadId = args.trim();
  if (!threadId) {
    const list = chatConfig.threadHistory.slice(0, 5);
    if (!list.length) {
      await ctx.reply("No previous threads available.");
      return;
    }
    await ctx.reply(`Recent threads:\n${list.join("\n")}\n\nUse /resume <thread-id> to switch.`);
    return;
  }
  chatConfig.threadId = threadId;
  if (!chatConfig.threadHistory.includes(threadId)) {
    chatConfig.threadHistory.unshift(threadId);
  }
  resetThread(chatId);
  await store.save();
  await ctx.reply(`Resumed thread ${threadId}`);
}

async function handleMention(ctx: Context, chatId: string, args: string): Promise<void> {
  const runtime = getRuntime(chatId);
  const chatConfig = store.getOrCreateChat(chatId, defaultThreadOptions);
  const filePath = args.trim();
  if (!filePath) {
    await ctx.reply("Usage: /mention <file-path>");
    return;
  }
  const workingDirectory =
    chatConfig.threadOptions.workingDirectory ?? process.cwd();
  try {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workingDirectory, filePath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new Error("Path is not a file");
    }
    runtime.pendingMentions.push(resolved);
    await ctx.reply(`Queued mention: ${resolved}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read file";
    await ctx.reply(`Mention failed: ${message}`);
  }
}

function parseCommand(text: string): { command: string; args: string } | null {
  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]+))?$/);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

bot.start(async (ctx) => {
  if (!isUserAllowed(ctx)) {
    return;
  }
  await ctx.reply("Codex bot is ready. Send a message to start a session, or /new to reset.");
});

bot.on("text", async (ctx) => {
  if (!isUserAllowed(ctx)) {
    if (ctx.chat?.type === "private") {
      await ctx.reply("Access denied.");
    }
    return;
  }
  if (!ctx.message || !ctx.chat) return;
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text.trim();

  if (text.startsWith("/prompts:")) {
    await runCodexTurn(ctx, chatId, text);
    return;
  }

  const parsed = parseCommand(text);
  if (parsed) {
    const { command, args } = parsed;
    switch (command) {
      case "new":
        await handleNew(ctx, chatId);
        return;
      case "status":
        await handleStatus(ctx, chatId);
        return;
      case "model":
        await handleModel(ctx, chatId, args);
        return;
      case "approvals":
        await handleApprovals(ctx, chatId, args);
        return;
      case "compact":
        await runCodexTurn(ctx, chatId, "Compact the conversation into a brief summary and continue.");
        return;
      case "diff":
        await handleDiff(ctx, chatId);
        return;
      case "review":
        await runCodexTurn(
          ctx,
          chatId,
          "Review the working tree for issues. Focus on behavior changes, risks, and missing tests. Provide actionable findings with file references."
        );
        return;
      case "resume":
        await handleResume(ctx, chatId, args);
        return;
      case "mcp":
        await runCodexTurn(ctx, chatId, "List MCP tools available in this session.");
        return;
      case "mention":
        await handleMention(ctx, chatId, args);
        return;
      case "init":
        await runCodexTurn(ctx, chatId, "Generate an AGENTS.md file for this repository.");
        return;
      case "fork":
      case "logout":
      case "feedback":
        await ctx.reply("This command is not supported yet in the Telegram frontend.");
        return;
      case "quit":
      case "exit":
        await handleNew(ctx, chatId);
        return;
      default:
        await ctx.reply("Unknown command. Send a normal message to talk to Codex.");
        return;
    }
  }

  await runCodexTurn(ctx, chatId, text);
});

bot.launch();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
