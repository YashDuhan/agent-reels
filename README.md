# agent-reels

Instagram Reels in a small floating window while your coding agent works. Reels open when you
start your agent (or on every prompt, or only when you ask), and `/reels` controls them from
inside the agent without using any tokens.

```bash
npm i -g agent-reels
reels setup
```

Works with **Claude Code** and **OpenCode**, on **Linux x64** and **Windows x64**.

## Where reels play

`reels setup` asks:

- **Reels window** (default): a small always-on-top window with the real Instagram page, so you
  can scroll, like and comment. It's a ~5MB native app built with Tauri. On Hyprland and Sway it
  floats and pins itself; move it by its top edge or by middle-click dragging, resize it from the
  bottom-right corner.
- **My browser**: Chrome, Brave, Edge or Chromium, in a small app window with its own profile
  (`~/.reels/profile`). The window isn't kept on top.

On Linux the Reels window uses WebKitGTK, which needs GStreamer codecs for Instagram's video.
`reels setup` checks and prints the install command for your distro, e.g. on Arch:

```bash
sudo pacman -S --needed gst-plugins-good gst-plugins-bad gst-libav
```

## Commands

| Terminal | Claude Code | OpenCode | |
|---|---|---|---|
| `reels start` | `/reels` | `/reels` | Open and play |
| `reels stop` | `/reels stop` | `/reels-stop` | Pause |
| `reels autoscroll [on\|off]` | `/reels autoscroll [on\|off]` | `/reels-autoscroll` | Move to the next reel when one ends (no value toggles) |
| `reels setup` | | | Change any setting |
| `reels login` | | | Log in to Instagram |
| `reels uninstall` | | | Remove the hooks and commands |

The slash commands never reach the model. In OpenCode they run immediately. In Claude Code,
`/reels` runs immediately where mods are available (2.1.287 and later, still rolling out);
otherwise it runs when the current turn ends.

## How it works

- **Claude Code:** a `SessionStart` or `UserPromptSubmit` hook opens reels automatically. `/reels`
  is a mod (`~/.reels/claude-mod`, loaded via `CLAUDE_CODE_PLUGIN_DIRS`), with
  `~/.claude/commands/reels.md` and a `UserPromptExpansion` hook as the fallback.
- **OpenCode:** a TUI plugin (`~/.reels/opencode-tui.js`, listed in `tui.json`) adds the commands,
  and a plugin in `~/.config/opencode/plugins/` opens reels automatically.
- **The player** (`player/`, Rust + Tauri) runs as a single instance: launching it again passes
  the command (`play`, `pause`, `set`, `show`, `quit`) to the open window. A small script in the page
  (`shared/controller.js`) plays, pauses and advances reels; browser mode injects the same script
  over the Chrome DevTools Protocol.

Every file `reels setup` changes is backed up to `*.reels-backup` first. Logs are in
`~/.reels/reels.log`, settings in `~/.reels/config.json`.

## Development

```bash
npm install
npm run build
(cd player && cargo build --release)   # needs Rust; on Linux also webkit2gtk-4.1
npm link                               # puts `reels` on your PATH
```

Hooks store absolute paths to `node` and `dist/cli.js`, so run `reels setup` again after
upgrading Node or moving the checkout.

## Releasing

`.github/workflows/release.yml` builds the player on Ubuntu and Windows (with a start/quit smoke
test on Windows) and checks the CLI on both. On a `v*` tag it publishes `@yash9729/agent-reels-linux-x64`
and `@yash9729/agent-reels-win32-x64`, which hold just the player binary, then `agent-reels` with those as
optional dependencies, so npm installs only the one for your platform. Publishing uses npm's
trusted publishing (configured per package on npmjs.com), so the workflow needs no npm token.

## License

MIT
