import fs from "node:fs";
import type { AgentId, Config } from "../config.js";

/** Tags everything `reels setup` writes, so it can be found and removed later. */
export const MARKER = "reels-cli-hook";

export function triggerArgv(agent: string): string[] {
  return cliArgv("trigger", `--from=${agent}`);
}

/** `<node> <cli.js> ...args` with absolute paths, so hooks don't depend on PATH. */
export function cliArgv(...args: string[]): string[] {
  return [process.execPath, fs.realpathSync(process.argv[1]!), ...args];
}

export function backup(file: string): void {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.reels-backup`);
}

export interface Integration {
  id: AgentId;
  label: string;
  /** Whether the agent seems to be installed. */
  detect(): boolean;
  /** What install() changes, shown before asking. */
  describe(config: Config): string;
  install(config: Config): void;
  uninstall(): boolean;
}
