import { promises as fs } from "fs";
import path from "path";
import type { ThreadOptions } from "@openai/codex-sdk";

export type ChatConfig = {
  threadId: string | null;
  threadHistory: string[];
  threadOptions: ThreadOptions;
};

export type PersistedState = {
  chats: Record<string, ChatConfig>;
};

const EMPTY_STATE: PersistedState = { chats: {} };

export class StateStore {
  private state: PersistedState = EMPTY_STATE;
  private saveChain: Promise<void> = Promise.resolve();
  private statePath: string;

  constructor(statePath: string) {
    this.statePath = statePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      this.state = parsed?.chats ? parsed : EMPTY_STATE;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        throw err;
      }
      this.state = EMPTY_STATE;
    }
  }

  getState(): PersistedState {
    return this.state;
  }

  getOrCreateChat(chatId: string, defaultOptions: ThreadOptions): ChatConfig {
    const existing = this.state.chats[chatId];
    if (existing) {
      return existing;
    }
    const created: ChatConfig = {
      threadId: null,
      threadHistory: [],
      threadOptions: { ...defaultOptions }
    };
    this.state.chats[chatId] = created;
    return created;
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.statePath);
    await fs.mkdir(dir, { recursive: true });
    const payload = JSON.stringify(this.state, null, 2);
    this.saveChain = this.saveChain.then(() => fs.writeFile(this.statePath, payload, "utf8"));
    return this.saveChain;
  }
}
