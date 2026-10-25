import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentId = "claude" | "opencode";
/** When reels open on their own. `/reels` works in every mode. */
export type OpenOn = "launch" | "prompt" | "manual";

/** Where reels play: the agent-reels window, or the user's own browser. */
export type PlayerKind = "app" | "browser";

export interface Config {
  agents: AgentId[];
  player: PlayerKind;
  /** Browser mode only. */
  browserPath?: string;
  browserName?: string;
  port?: number;
  openOn: OpenOn;
  autoAdvance: boolean;
  sound: boolean;
}

export const HOME_DIR = path.join(os.homedir(), ".reels");
export const CONFIG_FILE = path.join(HOME_DIR, "config.json");
export const LOG_FILE = path.join(HOME_DIR, "reels.log");
export const LAST_TRIGGER_FILE = path.join(HOME_DIR, "last-trigger");

export function loadConfig(): Config | null {
  try {
    return { openOn: "launch", player: "app", ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) } as Config;
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

export function log(message: string): void {
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // a hook must never fail because of logging
  }
}
