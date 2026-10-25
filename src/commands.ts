import fs from "node:fs";
import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import { chromeApply, chromeLogin, chromePlay, DEFAULT_PORT, detectBrowsers } from "./chrome.js";
import {
  HOME_DIR,
  LAST_TRIGGER_FILE,
  loadConfig,
  log,
  saveConfig,
  type AgentId,
  type OpenOn,
  type Config,
  type PlayerKind,
} from "./config.js";
import { missingCodecsHint, playerPath, runPlayer } from "./player.js";
import { claude } from "./integrations/claude.js";
import type { Integration } from "./integrations/common.js";
import { opencode } from "./integrations/opencode.js";

const INTEGRATIONS: Integration[] = [claude, opencode];

function bail(value: unknown): void {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled, nothing was changed.");
    process.exit(0);
  }
}

function requireConfig(): Config {
  const config = loadConfig();
  if (!config) {
    console.error("reels is not set up yet. Run: reels setup");
    process.exit(1);
  }
  return config;
}

export async function setup(): Promise<void> {
  p.intro(" reels setup ");
  const previous = loadConfig();

  const agents = await p.multiselect({
    message: "Which agents should reels work with?",
    options: [
      ...INTEGRATIONS.map((i) => ({
        value: i.id,
        label: i.label,
        hint: i.detect() ? "detected" : "not found",
      })),
      { value: "codex" as const, label: "Codex", hint: "coming soon", disabled: true },
    ],
    initialValues: previous?.agents ?? INTEGRATIONS.filter((i) => i.detect()).map((i) => i.id),
    required: true,
  });
  bail(agents);

  const hasApp = playerPath() !== null;
  const browsers = detectBrowsers();
  if (!hasApp && browsers.length === 0) {
    p.cancel("Nothing to play reels in: no agent-reels player for this platform and no Chrome, Brave, Edge or Chromium.");
    process.exit(1);
  }
  const player = await p.select({
    message: "Where should reels play?",
    options: [
      {
        value: "app" as const,
        label: "Reels window",
        hint: hasApp ? "small, always on top, stays out of your browser" : `not available for ${process.platform}-${process.arch}`,
        disabled: !hasApp,
      },
      {
        value: "browser" as const,
        label: "My browser",
        hint: browsers.length ? `${browsers.map((b) => b.name).join(", ")}; not kept on top` : "no Chromium-based browser found",
        disabled: browsers.length === 0,
      },
    ],
    initialValue: previous?.player && (previous.player === "app" ? hasApp : browsers.length > 0) ? previous.player : hasApp ? "app" : "browser",
  });
  bail(player);

  let browserPath: string | undefined;
  if (player === "browser") {
    const picked = await p.select({
      message: "Which browser?",
      options: browsers.map((b) => ({ value: b.path, label: b.name, hint: b.path })),
      initialValue: browsers.some((b) => b.path === previous?.browserPath) ? previous!.browserPath! : browsers[0]!.path,
    });
    bail(picked);
    browserPath = picked as string;
  }

  const openOn = await p.select({
    message: "When should reels open automatically?",
    options: [
      { value: "launch", label: "When I start the agent", hint: "e.g. typing `claude`" },
      { value: "prompt", label: "Every time I send a prompt" },
      { value: "manual", label: "Never, I'll type /reels" },
    ],
    initialValue: previous?.openOn ?? "launch",
  });
  bail(openOn);

  const autoAdvance = await p.confirm({
    message: "Auto-advance to the next reel when one finishes?",
    initialValue: previous?.autoAdvance ?? true,
  });
  bail(autoAdvance);

  const sound = await p.confirm({ message: "Play with sound?", initialValue: previous?.sound ?? true });
  bail(sound);

  const config: Config = {
    agents: agents as AgentId[],
    player: player as PlayerKind,
    ...(browserPath && {
      browserPath,
      browserName: browsers.find((b) => b.path === browserPath)!.name,
      port: previous?.port ?? DEFAULT_PORT,
    }),
    openOn: openOn as OpenOn,
    autoAdvance: autoAdvance as boolean,
    sound: sound as boolean,
  };

  const chosen = INTEGRATIONS.filter((i) => (agents as string[]).includes(i.id));
  const removed = INTEGRATIONS.filter((i) => !(agents as string[]).includes(i.id));
  p.note(
    [
      ...chosen.map((i) => `+ ${i.label}: ${i.describe(config)}`),
      ...removed.map((i) => `- ${i.label}: remove reels hook if present`),
      `+ Config in ${HOME_DIR}`,
      "",
      "Existing config files are backed up to *.reels-backup first.",
    ].join("\n"),
    "These changes will be made",
  );
  const ok = await p.confirm({ message: "Apply?" });
  bail(ok);
  if (!ok) {
    p.cancel("Nothing was changed.");
    return;
  }

  saveConfig(config);
  for (const i of chosen) {
    i.install(config);
    p.log.success(`${i.label} connected`);
  }
  for (const i of removed) if (i.uninstall()) p.log.info(`${i.label} disconnected`);

  const codecs = config.player === "app" ? missingCodecsHint() : null;
  if (codecs) {
    p.log.warn(`Your system is missing the video codecs Instagram needs. Install them with:\n${codecs}`);
  }

  await login(config, true);

  const when = { launch: "Start", prompt: "Send a prompt in", manual: "Type /reels in" }[config.openOn];
  const tips = [`${when} ${chosen.map((i) => i.label).join(" or ")} and reels will start.`];
  if (config.agents.includes("claude")) tips.push("Claude Code: /reels, /reels stop, /reels autoscroll on|off");
  if (config.agents.includes("opencode")) tips.push("OpenCode: /reels, /reels-stop, /reels-autoscroll");
  p.outro(tips.join("\n   "));
}

export async function login(config = requireConfig(), embedded = false): Promise<void> {
  if (!embedded) p.intro(" reels login ");
  if (config.player === "browser") {
    const s = p.spinner();
    s.start(`Opening Instagram in ${config.browserName}. Log in there; waiting...`);
    const result = await chromeLogin(config).catch((err: Error) => err);
    if (result === "already") s.stop("Already logged in to Instagram");
    else if (result === "ok") s.stop("Logged in to Instagram, session saved");
    else if (result === "timeout") s.error("Timed out waiting for login. Run `reels login` to try again.");
    else s.error(`Couldn't open the browser: ${result.message}`);
  } else {
    runPlayer("show", config);
    const done = await p.confirm({
      message: "The reels window is open. Log in to Instagram there (skip if you already are). Done?",
      initialValue: true,
    });
    if (p.isCancel(done) || !done) p.log.info("No problem: the window shows Instagram's login until you do.");
    else p.log.success("Instagram login is saved in the reels window");
  }
  if (!embedded) p.outro("Done");
}

type Action = "play" | "pause" | "set";

/** Browser mode talks to the browser over CDP, which takes a moment, so hooks and /reels hand it off. */
function inBackground(action: Action): void {
  spawn(process.execPath, [fs.realpathSync(process.argv[1]!), "browser", action], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  log(`browser ${action} (background)`);
}

/** `reels browser <action>`, run in the foreground. */
export async function browserAction(action: Action, quiet = true): Promise<void> {
  const config = requireConfig();
  try {
    if (action === "play") await chromePlay(config);
    else await chromeApply(config, action === "pause" ? "pause" : "none");
  } catch (err) {
    log(`browser ${action} failed: ${(err as Error).stack ?? err}`);
    if (!quiet) console.error(`reels: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

/** Sends an action to wherever reels play. With `wait`, browser mode runs in this process. */
function send(action: Action, config: Config, wait: boolean): Promise<void> | void {
  if (config.player === "browser") return wait ? browserAction(action, false) : inBackground(action);
  runPlayer(action, config);
}

export async function start(quiet = false): Promise<void> {
  const config = requireConfig();
  if (config.player === "app") {
    // WebKitGTK's renderer aborts on Instagram's video without these.
    const codecs = missingCodecsHint();
    if (codecs) {
      log(`missing video codecs, not starting: ${codecs}`);
      if (!quiet) console.error(`reels: your system is missing the video codecs Instagram needs. Install them with:\n  ${codecs}`);
      process.exitCode = 1;
      return;
    }
    if (!playerPath()) {
      if (!quiet) console.error(`reels: no player for ${process.platform}-${process.arch}; pick your browser in \`reels setup\``);
      process.exitCode = 1;
      return;
    }
  }
  await send("play", config, !quiet);
  if (!quiet && !process.exitCode) console.log("▶ Reels playing");
}

export async function stop(quiet = false): Promise<void> {
  await send("pause", requireConfig(), !quiet);
  if (!quiet) console.log("⏸ Reels paused");
}

/**
 * Run by agent hooks. Returns at once and prints nothing: Claude Code passes
 * SessionStart and UserPromptSubmit output to the model.
 */
export function trigger(from: string): void {
  try {
    const last = Number(fs.readFileSync(LAST_TRIGGER_FILE, "utf8"));
    if (Date.now() - last < 2000) return;
  } catch {
    // first trigger
  }
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(LAST_TRIGGER_FILE, String(Date.now()));
    log(`trigger from ${from}`);
    void start(true);
  } catch (err) {
    log(`trigger failed: ${err}`);
  }
}

/** Handles `/reels [stop | autoscroll [on|off]]` and returns the line to show. */
export function reelsCommand(args: string): string {
  const [verb = "", value = ""] = args.trim().toLowerCase().split(/\s+/);
  if (verb === "" || verb === "start" || verb === "play") {
    void start(true);
    return process.exitCode ? "reels: couldn't start, run `reels start` in a terminal to see why" : "▶ Reels playing";
  }
  if (verb === "stop" || verb === "pause") {
    void stop(true);
    return "⏸ Reels paused";
  }
  if (verb === "autoscroll" || verb === "auto-scroll" || verb === "advance") {
    const config = requireConfig();
    const on = ["on", "true", "1", "yes"].includes(value)
      ? true
      : ["off", "false", "0", "no"].includes(value)
        ? false
        : !config.autoAdvance;
    config.autoAdvance = on;
    saveConfig(config);
    void send("set", config, false);
    return on ? "Auto-scroll on: reels advance when one ends" : "Auto-scroll off: reels stay put until you scroll";
  }
  return `Unknown option "${args.trim()}". Try /reels, /reels stop, /reels autoscroll on|off`;
}

/**
 * `/reels` via Claude Code's UserPromptExpansion hook, used where mods aren't
 * available. `continue: false` stops the prompt before it reaches the model.
 */
export function slash(): void {
  let args = "";
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    args = String(input.command_args ?? "");
  } catch {
    // no input: plain /reels
  }
  const stopReason = reelsCommand(args);
  process.exitCode = 0;
  process.stdout.write(JSON.stringify({ continue: false, stopReason, suppressOutput: true }) + "\n");
}

export async function uninstall(): Promise<void> {
  p.intro(" reels uninstall ");
  for (const i of INTEGRATIONS) {
    if (i.uninstall()) p.log.success(`Removed ${i.label} hook`);
  }
  const config = loadConfig();
  if (config?.player === "app") runPlayer("quit", config);
  const wipe = await p.confirm({
    message: `Also delete ${HOME_DIR} (your settings)?`,
    initialValue: false,
  });
  if (!p.isCancel(wipe) && wipe) {
    fs.rmSync(HOME_DIR, { recursive: true, force: true });
    p.log.success(`Deleted ${HOME_DIR}`);
  }
  p.outro("reels is uninstalled. You can now `npm rm -g agent-reels`.");
}
