import { execSync } from "node:child_process";
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
/** OpenCode 1.x lists TUI plugins here under `plugin`. */
const TUI_CONFIG = path.join(CONFIG_DIR, "tui.json");
/**
 * OpenCode 2.x replaced tui.json with cli.json. Upgrading carries our tui.json entry
 * over, but 2.x can't load the 1.x plugin it points to, so we only remove it there.
 */
const CLI_CONFIG = path.join(CONFIG_DIR, "cli.json");
const TUI_SPEC = pathToFileURL(TUI_PLUGIN_FILE).href;
/** OpenCode 2.x discovers plugin directories in plugins/ and loads their tui.js in the TUI. */
const V2_PLUGIN_DIR = path.join(CONFIG_DIR, "plugins", "agent-reels");

/**
 * OpenCode 2 loads only `Plugin.define({ id, setup })` plugins and migrates tui.json
 * to cli.json on first run, so either sign means the 2.x formats.
 */
let v2: boolean | undefined;
function isV2(): boolean {
  return (v2 ??= detectV2());
}

function detectV2(): boolean {
  try {
    // Through a shell so Windows finds npm's opencode.cmd shim.
    const out = execSync("opencode --version", {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const major = Number(/(\d+)\.\d+/.exec(out)?.[1]);
    if (major) return major >= 2;
  } catch {}
  return fs.existsSync(CLI_CONFIG);
}

/**
 * OpenCode 2: the TUI plugin also opens reels on its own, so no server plugin is
 * needed. `/reels` takes arguments here, like in Claude Code. OpenCode resolves
 * `@opencode/plugin/tui` itself and skips plain objects that don't come from Plugin.define.
 */
function tuiPluginSourceV2(config: Config): string {
  const auto =
    config.openOn === "launch"
      ? `    fire();\n`
      : config.openOn === "prompt"
        ? `    const stop = context.data.on("session.execution.started", fire);\n`
        : "";
  return `// ${MARKER}: installed by \`reels setup\`, remove with \`reels uninstall\`.
import { execFile, spawn } from "node:child_process";
import { Plugin } from "@opencode/plugin/tui";

const REELS = ${JSON.stringify(cliArgv())};
const TRIGGER = ${JSON.stringify(triggerArgv("opencode"))};
let last = 0;

function fire() {
  const now = Date.now();
  if (now - last < 3000) return;
  last = now;
  try {
    spawn(TRIGGER[0], TRIGGER.slice(1), { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {}
}

export default Plugin.define({
  id: "agent-reels",
  setup(context) {
    const run = (...args) =>
      execFile(REELS[0], [...REELS.slice(1), "cmd", ...args], { windowsHide: true }, (err, stdout, stderr) => {
        const message = (stdout || stderr || String(err || "")).trim();
        context.ui.toast.show({ variant: err ? "error" : "success", message, duration: 2500 });
      });
    const words = (input) => String(input ?? "").trim().split(/\\s+/).filter(Boolean);
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "reels.play", title: "Reels: play", palette: true, slash: { name: "reels", arguments: true }, run: (input) => run(...words(input)) },
        { id: "reels.stop", title: "Reels: pause", palette: true, slash: { name: "reels-stop" }, run: () => run("stop") },
        { id: "reels.autoscroll", title: "Reels: toggle auto-scroll", palette: true, slash: { name: "reels-autoscroll" }, run: () => run("autoscroll") },
      ],
    }));
${auto}${config.openOn === "prompt" ? "    return () => stop?.();\n" : ""}  },
});
`;
}

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

const PLUGIN_LISTS = {
  v1: { file: TUI_CONFIG, key: "plugin", schema: "https://opencode.ai/tui.json" },
  v2: { file: CLI_CONFIG, key: "plugins", schema: "https://opencode.ai/v2/cli.json" },
} as const;

/** Adds or removes our entry in tui.json's or cli.json's `plugin(s)` list; true if the file changed. */
function setTuiPlugin(version: keyof typeof PLUGIN_LISTS, present: boolean): boolean {
  const { file, key, schema } = PLUGIN_LISTS[version];
  if (!present && !fs.existsSync(file)) return false;
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { $schema: schema };
  const list: unknown[] = Array.isArray(config[key]) ? config[key] : [];
  const spec = (p: any) => (Array.isArray(p) ? p[0] : typeof p === "object" && p ? p.package : p);
  const ours = (p: unknown) => spec(p) === TUI_SPEC || spec(p) === TUI_PLUGIN_FILE;
  const kept = list.filter((p) => !ours(p));
  if (present) kept.push(TUI_SPEC);
  if (kept.length === list.length && list.some(ours) === present) return false;
  if (kept.length) config[key] = kept;
  else delete config[key];
  backup(file);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
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
    if (isV2()) {
      const auto = config.openOn === "manual" ? "" : `, opening reels ${config.openOn === "launch" ? "when opencode starts" : "on every prompt"}`;
      return `Adds /reels, /reels-stop and /reels-autoscroll (a plugin in ${V2_PLUGIN_DIR})${auto}`;
    }
    const auto =
      config.openOn === "manual"
        ? ""
        : `a plugin in ${PLUGIN_FILE} (opens reels ${config.openOn === "launch" ? "when opencode starts" : "on every prompt"}), `;
    return `Adds ${auto}/reels, /reels-stop and /reels-autoscroll (${TUI_PLUGIN_FILE}, listed in ${TUI_CONFIG})`;
  },

  install(config) {
    removeServerPlugin();
    if (isV2()) {
      setTuiPlugin("v2", false);
      fs.rmSync(TUI_PLUGIN_FILE, { force: true });
      fs.mkdirSync(V2_PLUGIN_DIR, { recursive: true });
      fs.writeFileSync(path.join(V2_PLUGIN_DIR, "tui.js"), tuiPluginSourceV2(config));
      fs.writeFileSync(
        path.join(V2_PLUGIN_DIR, "package.json"),
        JSON.stringify({ name: "agent-reels-opencode", private: true, type: "module", exports: { "./tui": "./tui.js" } }, null, 2) + "\n",
      );
      return;
    }
    fs.rmSync(V2_PLUGIN_DIR, { recursive: true, force: true });
    fs.mkdirSync(HOME_DIR, { recursive: true });
    if (config.openOn !== "manual") {
      fs.mkdirSync(path.dirname(PLUGIN_FILE), { recursive: true });
      fs.writeFileSync(PLUGIN_FILE, pluginSource(config));
    }
    fs.writeFileSync(TUI_PLUGIN_FILE, tuiPluginSource());
    setTuiPlugin("v1", true);
  },

  uninstall() {
    let removed = removeServerPlugin();
    if (fs.existsSync(TUI_PLUGIN_FILE)) {
      fs.rmSync(TUI_PLUGIN_FILE);
      removed = true;
    }
    if (fs.existsSync(V2_PLUGIN_DIR)) {
      fs.rmSync(V2_PLUGIN_DIR, { recursive: true, force: true });
      removed = true;
    }
    if (setTuiPlugin("v1", false)) removed = true;
    if (setTuiPlugin("v2", false)) removed = true;
    return removed;
  },
};
