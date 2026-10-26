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
  /** Reels window only: global shortcut that hides and shows it. Empty turns it off. */
  hotkey: string;
  /** Reels window only: global shortcut that mutes and unmutes it. Empty turns it off. */
  muteHotkey: string;
  /** Size reels open at, in logical pixels. Edited in config.json only; setup doesn't ask. */
  windowSize: { width: number; height: number };
}

export const DEFAULT_WINDOW_SIZE = { width: 348, height: 411 };

export const DEFAULT_HOTKEY = "Ctrl+Shift+H";
export const DEFAULT_MUTE_HOTKEY = "Ctrl+Shift+M";

export const HOME_DIR = path.join(os.homedir(), ".reels");
export const CONFIG_FILE = path.join(HOME_DIR, "config.json");
export const LOG_FILE = path.join(HOME_DIR, "reels.log");
export const LAST_TRIGGER_FILE = path.join(HOME_DIR, "last-trigger");

/** Smaller than this, Instagram's layout breaks. */
const MIN_SIDE = 200;

export function loadConfig(): Config | null {
  let config: Config;
  try {
    config = {
      openOn: "launch",
      player: "app",
      hotkey: DEFAULT_HOTKEY,
      muteHotkey: DEFAULT_MUTE_HOTKEY,
      ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")),
    } as Config;
  } catch {
    return null;
  }
  // Hand-edited, so fall back to the default when it isn't a usable size.
  const { width, height } = config.windowSize ?? {};
  const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= MIN_SIDE;
  config.windowSize = ok(width) && ok(height) ? { width: Math.round(width!), height: Math.round(height!) } : DEFAULT_WINDOW_SIZE;
  return config;
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
