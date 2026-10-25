import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME_DIR } from "../config.js";
import { backup, cliArgv, MARKER, triggerArgv, type Integration } from "./common.js";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const COMMAND_FILE = path.join(CLAUDE_DIR, "commands", "reels.md");
/** Our Claude Code mod, loaded through CLAUDE_CODE_PLUGIN_DIRS in settings.json's env. */
const MOD_DIR = path.join(HOME_DIR, "claude-mod");
const PLUGIN_DIRS = "CLAUDE_CODE_PLUGIN_DIRS";

/** Every hook event install() may write to. */
const EVENTS = ["SessionStart", "UserPromptSubmit", "UserPromptExpansion"] as const;

interface HookGroup {
  matcher?: string;
  hooks: Array<{ type: string; command?: string; args?: string[]; [k: string]: unknown }>;
}

function readSettings(): Record<string, any> {
  if (!fs.existsSync(SETTINGS)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
}

function writeSettings(settings: Record<string, any>): void {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
}

function isOurs(group: HookGroup): boolean {
  // Earlier versions installed a shell command ending in `# reels-cli-hook`.
  return (
    group.hooks?.some(
      (h) => (typeof h.command === "string" && h.command.includes(MARKER)) || h.args?.includes(`--tag=${MARKER}`),
    ) ?? false
  );
}

/**
 * Exec form: Claude Code runs `command` with `args` directly instead of through a
 * shell (Git Bash or PowerShell on Windows), so paths need no quoting.
 */
function hook(argv: string[]) {
  const [command, ...args] = argv;
  return { type: "command", command: command!, args: [...args, `--tag=${MARKER}`], timeout: 10 };
}

/** Removes our hook groups; true if there were any. */
function stripOurs(settings: Record<string, any>): boolean {
  let removed = false;
  for (const event of EVENTS) {
    const groups: HookGroup[] | undefined = settings.hooks?.[event];
    if (!groups?.some(isOurs)) continue;
    removed = true;
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

/**
 * The mod registers `/reels` as an immediate command, so it runs mid-turn. Where
 * mods aren't available, the UserPromptExpansion hook handles `/reels` instead,
 * once the current turn ends.
 */
function modFiles(): Record<string, string> {
  const argv = JSON.stringify(cliArgv());
  return {
    ".claude-plugin/plugin.json":
      JSON.stringify(
        {
          name: "reels",
          version: "0.1.0",
          description: "/reels opens Instagram Reels instantly, even while Claude is working",
          author: { name: "agent-reels" },
          license: "MIT",
        },
        null,
        2,
      ) + "\n",
    "hooks/hooks.json": JSON.stringify({ modules: ["./register.ts"] }) + "\n",
    "hooks/register.ts": `// ${MARKER}: written by \`reels setup\`, removed by \`reels uninstall\`.
import type { Register } from 'claude-code'

const REELS = ${argv}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'reels',
      description: 'Open Instagram Reels (/reels stop, /reels autoscroll on|off)',
      argumentHint: '[stop | autoscroll on|off]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'reels' }, async ($, e) => {
    const args = e.args.trim().split(/\\s+/).filter(Boolean)
    const { exitCode, stdout, stderr } = await $.process.run([...REELS, 'cmd', ...args], { timeoutMs: 5000 })
    if (exitCode !== 0) return { text: \`reels failed: \${stderr.trim() || 'exit ' + exitCode}\` }
    return { text: stdout.trim() }
  })
}
`,
  };
}

/** Adds or removes MOD_DIR in the env var's path list; true if it was there. */
function setPluginDir(settings: Record<string, any>, present: boolean): boolean {
  const current = String(settings.env?.[PLUGIN_DIRS] ?? "").split(path.delimiter);
  const dirs = current.filter((d) => d && d !== MOD_DIR);
  if (present) dirs.push(MOD_DIR);
  if (dirs.length) (settings.env ??= {})[PLUGIN_DIRS] = dirs.join(path.delimiter);
  else if (settings.env) {
    delete settings.env[PLUGIN_DIRS];
    if (Object.keys(settings.env).length === 0) delete settings.env;
  }
  return current.includes(MOD_DIR);
}

const COMMAND_BODY = `---
description: Open Instagram Reels (/reels stop, /reels autoscroll on|off)
argument-hint: "[stop | autoscroll on|off]"
---
<!-- ${MARKER}: installed by \`reels setup\`. Its hook handles /reels before this text is used. -->
The agent-reels hook for /reels is missing. Reply only: "Run \`reels setup\` again to restore /reels."
`;

export const claude: Integration = {
  id: "claude",
  label: "Claude Code",

  detect() {
    return fs.existsSync(CLAUDE_DIR);
  },

  describe(config) {
    const auto =
      config.openOn === "launch"
        ? "a SessionStart hook (opens reels when `claude` starts), "
        : config.openOn === "prompt"
          ? "a UserPromptSubmit hook (opens reels on every prompt), "
          : "";
    return `Adds ${auto}/reels (${COMMAND_FILE} and a mod in ${MOD_DIR}), with hooks in ${SETTINGS}`;
  },

  install(config) {
    const settings = readSettings();
    backup(SETTINGS);
    stripOurs(settings);
    settings.hooks ??= {};
    const add = (event: string, group: HookGroup) => (settings.hooks[event] ??= []).push(group);

    if (config.openOn === "launch") {
      add("SessionStart", {
        matcher: "startup|resume",
        hooks: [hook(triggerArgv("claude"))],
      });
    } else if (config.openOn === "prompt") {
      add("UserPromptSubmit", { hooks: [hook(triggerArgv("claude"))] });
    }

    add("UserPromptExpansion", {
      matcher: "reels",
      hooks: [hook(cliArgv("slash"))],
    });

    setPluginDir(settings, true);
    writeSettings(settings);
    for (const [rel, body] of Object.entries(modFiles())) {
      fs.mkdirSync(path.dirname(path.join(MOD_DIR, rel)), { recursive: true });
      fs.writeFileSync(path.join(MOD_DIR, rel), body);
    }
    fs.mkdirSync(path.dirname(COMMAND_FILE), { recursive: true });
    fs.writeFileSync(COMMAND_FILE, COMMAND_BODY);
  },

  uninstall() {
    let removed = false;
    if (fs.existsSync(COMMAND_FILE) && fs.readFileSync(COMMAND_FILE, "utf8").includes(MARKER)) {
      fs.rmSync(COMMAND_FILE);
      removed = true;
    }
    if (fs.existsSync(MOD_DIR)) {
      fs.rmSync(MOD_DIR, { recursive: true, force: true });
      removed = true;
    }
    if (fs.existsSync(SETTINGS)) {
      const settings = readSettings();
      const hadDir = setPluginDir(settings, false);
      if (stripOurs(settings) || hadDir) {
        backup(SETTINGS);
        writeSettings(settings);
        removed = true;
      }
    }
    return removed;
  },
};
