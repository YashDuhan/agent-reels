#!/usr/bin/env node
import { parseArgs } from "node:util";
import { browserAction, login, reelsCommand, setup, slash, start, stop, trigger, uninstall } from "./commands.js";

const HELP = `reels: Instagram Reels while your coding agent works

Usage:
  reels setup                 Choose agents and where reels play, then log in to Instagram
  reels start                 Open reels (if needed) and play
  reels stop                  Pause
  reels autoscroll [on|off]   Move to the next reel when one ends (no value toggles)
  reels login                 Log in to Instagram
  reels uninstall             Remove the agent hooks and commands

Claude Code: /reels, /reels stop, /reels autoscroll on|off
OpenCode:    /reels, /reels-stop, /reels-autoscroll
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    quiet: { type: "boolean", default: false },
    from: { type: "string", default: "manual" },
    // Marks the hooks `reels setup` installs.
    tag: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

switch (values.help ? "help" : positionals[0]) {
  case "setup":
    await setup();
    break;
  case "start":
    await start(values.quiet);
    break;
  case "stop":
    await stop(values.quiet);
    break;
  case "browser": {
    // Internal: browser mode work handed off by hooks and /reels.
    const action = positionals[1];
    if (action === "play" || action === "pause" || action === "set") await browserAction(action);
    break;
  }
  case "login":
    await login();
    break;
  case "trigger":
    trigger(values.from!);
    break;
  case "cmd":
    // Internal: `/reels <args>` from the Claude Code mod and OpenCode.
    process.stdout.write(reelsCommand(positionals.slice(1).join(" ")) + "\n");
    break;
  case "autoscroll":
    console.log(reelsCommand(`autoscroll ${positionals[1] ?? ""}`));
    break;
  case "slash":
    slash();
    break;
  case "uninstall":
    await uninstall();
    break;
  default:
    console.log(HELP);
}
