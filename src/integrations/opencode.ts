import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HOME_DIR, type Config } from "../config.js";
import { backup, cliArgv, MARKER, triggerArgv, type Integration } from "./common.js";

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode");
const PLUGIN_FILE = path.join(CONFIG_DIR, "plugins", "reels.js");
/** TUI plugin: slash commands that run in OpenCode's UI, without a model call. */
const TUI_PLUGIN_FILE = path.join(HOME_DIR, "opencode-tui.js");
const TUI_CONFIG = path.join(CONFIG_DIR, "tui.json");
const TUI_SPEC = pathToFileURL(TUI_PLUGIN_FILE).href;

function tuiPluginSource(): string {
  return `// ${MARKER}: installed by \`reels setup\`, remove with \`reels uninstall\`.
// OpenCode TUI commands take no arguments, so each variant is its own command.
import { execFile } from "node:child_process";

const REELS = ${JSON.stringify(cliArgv())};

export default {
  id: "agent-reels",
  tui: async (api) => {
    const run = (...args) =>
      execFile(REELS[0], [...REELS.slice(1), "cmd", ...args], { windowsHide: true }, (err, stdout, stderr) => {
        const message = (stdout || stderr || String(err || "")).trim();
        api.ui.toast({ variant: err ? "error" : "success", message, duration: 2500 });
      });
    const commands = [
      { title: "Reels: play", value: "reels.play", category: "Reels", slash: { name: "reels" }, onSelect: () => run() },
      { title: "Reels: pause", value: "reels.stop", category: "Reels", slash: { name: "reels-stop" }, onSelect: () => run("stop") },
      {
        title: "Reels: toggle auto-scroll",
        value: "reels.autoscroll",
        category: "Reels",
        slash: { name: "reels-autoscroll" },
        onSelect: () => run("autoscroll"),
      },
    ];
    const dispose = api.command?.register(() => commands);
    if (dispose) api.lifecycle?.onDispose?.(dispose);
  },
};
`;
}

function readTuiConfig(): Record<string, any> {
  if (!fs.existsSync(TUI_CONFIG)) return { $schema: "https://opencode.ai/tui.json" };
  return JSON.parse(fs.readFileSync(TUI_CONFIG, "utf8"));
}

/** Adds or removes our entry in tui.json's `plugin` list; true if the file changed. */
function setTuiPlugin(present: boolean): boolean {
  const config = readTuiConfig();
  const list: unknown[] = Array.isArray(config.plugin) ? config.plugin : [];
  const ours = (p: unknown) => (Array.isArray(p) ? p[0] : p) === TUI_SPEC;
  const kept = list.filter((p) => !ours(p));
  if (present) kept.push(TUI_SPEC);
  if (kept.length === list.length && list.some(ours) === present) return false;
  if (kept.length) config.plugin = kept;
  else delete config.plugin;
  backup(TUI_CONFIG);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TUI_CONFIG, JSON.stringify(config, null, 2) + "\n");
  return true;
}

function pluginSource(config: Config): string {
  const hooks =
    config.openOn === "launch"
      ? `  // Plugins load when OpenCode starts.
  fire();
  return {};`
      : `  return {
    "chat.message": async () => fire(),
    event: async ({ event }) => {
      if (event.type === "message.updated" && event.properties?.info?.role === "user") fire();
    },
  };`;

  return `// ${MARKER}: installed by \`reels setup\`, remove with \`reels uninstall\`.
import { spawn } from "node:child_process";

const ARGV = ${JSON.stringify(triggerArgv("opencode"))};
let last = 0;

function fire() {
  const now = Date.now();
  if (now - last < 3000) return;
  last = now;
  try {
    spawn(ARGV[0], ARGV.slice(1), { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {}
}

export const ReelsPlugin = async () => {
${hooks}
};
`;
}

function removeServerPlugin(): boolean {
  if (!fs.existsSync(PLUGIN_FILE)) return false;
  if (!fs.readFileSync(PLUGIN_FILE, "utf8").includes(MARKER)) return false;
  fs.rmSync(PLUGIN_FILE);
  return true;
}

export const opencode: Integration = {
  id: "opencode",
  label: "OpenCode",

  detect() {
    return fs.existsSync(CONFIG_DIR);
  },

  describe(config) {
    const auto =
      config.openOn === "manual"
        ? ""
        : `a plugin in ${PLUGIN_FILE} (opens reels ${config.openOn === "launch" ? "when opencode starts" : "on every prompt"}), `;
    return `Adds ${auto}/reels, /reels-stop and /reels-autoscroll (${TUI_PLUGIN_FILE}, listed in ${TUI_CONFIG})`;
  },

  install(config) {
    removeServerPlugin();
    if (config.openOn !== "manual") {
      fs.mkdirSync(path.dirname(PLUGIN_FILE), { recursive: true });
      fs.writeFileSync(PLUGIN_FILE, pluginSource(config));
    }
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(TUI_PLUGIN_FILE, tuiPluginSource());
    setTuiPlugin(true);
  },

  uninstall() {
    let removed = removeServerPlugin();
    if (fs.existsSync(TUI_PLUGIN_FILE)) {
      fs.rmSync(TUI_PLUGIN_FILE);
      removed = true;
    }
    if (fs.existsSync(TUI_CONFIG) && setTuiPlugin(false)) removed = true;
    return removed;
  },
};
