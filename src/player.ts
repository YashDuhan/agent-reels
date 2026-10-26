import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { log, type Config } from "./config.js";

export type PlayerAction = "play" | "pause" | "show" | "toggle" | "mute" | "set" | "quit";

const EXE = process.platform === "win32" ? "agent-reels-player.exe" : "agent-reels-player";
const BINARY_PACKAGE = `@yash9729/agent-reels-${process.platform}-${process.arch}`;

/**
 * The player binary (see /player): from the `@yash9729/agent-reels-<platform>-<arch>` package
 * when installed from npm, or the local cargo build in a checkout.
 */
export function playerPath(): string | null {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidates = [path.join(root, "player", "target", "release", EXE)];
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`${BINARY_PACKAGE}/package.json`);
    candidates.unshift(path.join(path.dirname(pkg), "bin", EXE));
  } catch {
    // no prebuilt binary for this platform
  }
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * Sends an action to the player. Only one player runs; launching it again hands
 * the arguments to the open window.
 */
export function runPlayer(action: PlayerAction, config: Config): boolean {
  const bin = playerPath();
  if (!bin) {
    log(`no player binary for ${process.platform}-${process.arch}`);
    return false;
  }
  const flags = [
    `--sound=${config.sound ? 1 : 0}`,
    `--advance=${config.autoAdvance ? 1 : 0}`,
    `--hotkey=${config.hotkey}`,
    `--mute-hotkey=${config.muteHotkey}`,
    `--width=${config.windowSize.width}`,
    `--height=${config.windowSize.height}`,
  ];
  spawn(bin, [action, ...flags], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
  log(`player ${action}`);
  return true;
}

/**
 * On Linux the player uses WebKitGTK, which plays video through GStreamer, and many
 * distros don't ship the H.264 decoder Instagram needs. Returns the command to
 * install what's missing, or null.
 */
export function missingCodecsHint(): string | null {
  if (process.platform !== "linux") return null;
  const has = (element: string) => spawnSync("gst-inspect-1.0", [element], { stdio: "ignore" }).status === 0;
  if (has("avdec_h264") && has("autoaudiosink")) return null;

  const on = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
  if (on("pacman")) return "sudo pacman -S --needed gst-plugins-good gst-plugins-bad gst-libav";
  if (on("apt")) return "sudo apt install gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav";
  if (on("dnf")) return "sudo dnf install gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-libav";
  if (on("zypper")) return "sudo zypper install gstreamer-plugins-good gstreamer-plugins-bad gstreamer-plugins-libav";
  return "Install the GStreamer 'good', 'bad' and 'libav' plugin packages for your distro";
}
