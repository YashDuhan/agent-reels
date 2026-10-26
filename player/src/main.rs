//! agent-reels-player: a small always-on-top window playing Instagram Reels.
//!
//! Usage: agent-reels-player <play|pause|show|toggle|mute|set|quit> [--sound=0|1] [--advance=0|1]
//!          [--hotkey=Ctrl+Shift+H] [--mute-hotkey=Ctrl+Shift+M]
//!
//! Only one instance runs. Launching it again forwards the arguments to the
//! running window (tauri-plugin-single-instance) and exits.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{AppHandle, Manager, Theme, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const REELS_URL: &str = "https://www.instagram.com/reels/";
const CONTROLLER: &str = include_str!("../../shared/controller.js");
const WINDOW: &str = "main";
const TITLE: &str = "agent-reels";
/// Logical size the window opens at, unless `--width`/`--height` (config.json's
/// `windowSize`) say otherwise.
const DEFAULT_SIZE: (f64, f64) = (348.0, 411.0);
const MIN_SIDE: f64 = 200.0;

struct Command {
    action: String,
    sound: Option<bool>,
    advance: Option<bool>,
    /// Global hide/show shortcut; empty turns it off.
    hotkey: Option<String>,
    /// Global mute/unmute shortcut; empty turns it off.
    mute_hotkey: Option<String>,
    /// Size to open at; ignored once the window is open.
    size: (f64, f64),
}

fn parse(args: &[String]) -> Command {
    let mut cmd = Command {
        action: "play".into(),
        sound: None,
        advance: None,
        hotkey: None,
        mute_hotkey: None,
        size: DEFAULT_SIZE,
    };
    let (mut width, mut height) = DEFAULT_SIZE;
    for arg in args.iter().skip(1) {
        let flag = |name: &str| arg.strip_prefix(name).map(|v| v != "0" && v != "false");
        if let Some(v) = flag("--sound=") {
            cmd.sound = Some(v);
        } else if let Some(v) = flag("--advance=") {
            cmd.advance = Some(v);
        } else if let Some(v) = arg.strip_prefix("--hotkey=") {
            cmd.hotkey = Some(v.trim().to_string());
        } else if let Some(v) = arg.strip_prefix("--mute-hotkey=") {
            cmd.mute_hotkey = Some(v.trim().to_string());
        } else if let Some(v) = arg.strip_prefix("--width=") {
            width = v.parse().unwrap_or(width);
        } else if let Some(v) = arg.strip_prefix("--height=") {
            height = v.parse().unwrap_or(height);
        } else if !arg.starts_with('-') {
            cmd.action = arg.clone();
        }
    }
    cmd.size = (width.max(MIN_SIDE), height.max(MIN_SIDE));
    cmd
}

fn opts_json(cmd: &Command) -> String {
    let mut opts = serde_json::Map::new();
    if let Some(v) = cmd.sound {
        opts.insert("sound".into(), v.into());
    }
    if let Some(v) = cmd.advance {
        opts.insert("autoAdvance".into(), v.into());
    }
    serde_json::Value::Object(opts).to_string()
}

/// Hides the window, which also takes it off the taskbar and Alt+Tab, pausing the reel
/// so it isn't heard; or brings it back and plays.
fn toggle(app: &AppHandle) {
    let Some(win) = app.get_webview_window(WINDOW) else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.eval("window.__reels && window.__reels.pause()");
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.eval("window.__reels && window.__reels.play()");
    }
}

/// Mutes or unmutes reels for as long as the window is open.
fn toggle_sound(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW) {
        let _ = win.eval("window.__reels && window.__reels.toggleSound()");
    }
}

/// The registered global shortcuts: hide/show, then mute.
static HOTKEYS: Mutex<[Option<Shortcut>; 2]> = Mutex::new([None, None]);

fn on_hotkey(app: &AppHandle, pressed: &Shortcut) {
    let [hide, mute] = HOTKEYS.lock().unwrap().clone();
    if hide.as_ref() == Some(pressed) {
        toggle(app);
    } else if mute.as_ref() == Some(pressed) {
        toggle_sound(app);
    }
}

/// Replaces whichever global shortcuts are given; an empty one is turned off. Not
/// available on Wayland, where compositor bindings to `reels toggle` and `reels mute` do
/// the same.
fn set_hotkeys(app: &AppHandle, hide: Option<&str>, mute: Option<&str>) {
    let shortcuts = app.global_shortcut();
    let mut current = HOTKEYS.lock().unwrap();
    for (slot, text) in current.iter_mut().zip([hide, mute]) {
        let Some(text) = text else { continue };
        if let Some(old) = slot.take() {
            let _ = shortcuts.unregister(old);
        }
        if text.is_empty() {
            continue;
        }
        match text.parse::<Shortcut>() {
            Ok(shortcut) => match shortcuts.register(shortcut) {
                Ok(()) => *slot = Some(shortcut),
                Err(err) => eprintln!("agent-reels-player: couldn't register hotkey {text}: {err}"),
            },
            Err(err) => eprintln!("agent-reels-player: bad hotkey {text}: {err}"),
        }
    }
}

/// The page's close button.
#[tauri::command]
fn quit_player(app: AppHandle) {
    app.exit(0);
}

/// The page's right-click menu: keep the window above others, or not. Hyprland ignores
/// "always on top", so there it pins or unpins the window instead.
#[tauri::command]
fn set_on_top(app: AppHandle, on: bool) {
    if let Some(win) = app.get_webview_window(WINDOW) {
        let _ = win.set_always_on_top(on);
    }
    set_pinned(on);
}

/// Applies a command to the already-open window.
fn handle(app: &AppHandle, cmd: Command) {
    set_hotkeys(app, cmd.hotkey.as_deref(), cmd.mute_hotkey.as_deref());
    let Some(win) = app.get_webview_window(WINDOW) else { return };
    let opts = opts_json(&cmd);
    let _ = win.eval(&format!("window.__reels && window.__reels.setOpts({opts})"));
    match cmd.action.as_str() {
        "play" => {
            let _ = win.show();
            let _ = win.eval("window.__reels && window.__reels.play()");
        }
        "pause" => {
            let _ = win.eval("window.__reels && window.__reels.pause()");
        }
        "show" => {
            let _ = win.show();
            let _ = win.set_focus();
        }
        "toggle" => toggle(app),
        "mute" => toggle_sound(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// WebKitGTK: allow autoplay with sound, and reload if the page's renderer process
/// dies rather than leaving a blank window.
#[cfg(target_os = "linux")]
fn tune_webkit(win: &tauri::WebviewWindow) {
    let _ = win.with_webview(|wv| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        let view = wv.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_media_playback_requires_user_gesture(false);
        }
        view.connect_web_process_terminated(|view, reason| {
            eprintln!("agent-reels-player: web process terminated ({reason:?}), reloading");
            view.reload();
        });
    });
}

/// Our window in `hyprctl clients`, found by our pid.
#[cfg(target_os = "linux")]
fn hypr_client() -> Option<serde_json::Value> {
    std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
    let out = std::process::Command::new("hyprctl").args(["clients", "-j"]).output().ok()?;
    let clients: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let pid = std::process::id() as u64;
    clients.as_array()?.iter().find(|c| c["pid"].as_u64() == Some(pid)).cloned()
}

#[cfg(target_os = "linux")]
fn hypr_address() -> Option<String> {
    hypr_client()?["address"].as_str().map(String::from)
}

/// Runs Hyprland dispatchers: the Lua form (0.55+) first, else the classic syntax.
#[cfg(target_os = "linux")]
fn hypr_dispatch(lua: &[String], classic: &str) {
    use std::process::Command as Proc;
    let lua_ok = lua.iter().all(|d| {
        Proc::new("hyprctl")
            .args(["dispatch", d])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "ok")
            .unwrap_or(false)
    });
    if !lua_ok {
        let _ = Proc::new("hyprctl").args(["--batch", classic]).output();
    }
}

/// Hyprland won't move a pinned window, so the page unpins it while it is dragged.
/// Does nothing outside Hyprland.
#[tauri::command]
fn set_pinned(pinned: bool) {
    #[cfg(target_os = "linux")]
    if let Some(client) = hypr_client() {
        let Some(a) = client["address"].as_str() else { return };
        if client["pinned"].as_bool() == Some(pinned) {
            return;
        }
        let action = if pinned { "enable" } else { "disable" };
        // The classic `pin` dispatcher toggles; the state is known to differ here.
        hypr_dispatch(
            &[format!("hl.dsp.window.pin({{ action = '{action}', window = 'address:{a}' }})")],
            &format!("dispatch pin address:{a}"),
        );
    }
    #[cfg(not(target_os = "linux"))]
    let _ = pinned;
}

/// Wayland compositors ignore an app's "always on top", so on Hyprland and Sway the
/// window floats and pins itself through their IPC.
#[cfg(target_os = "linux")]
fn pin_on_wayland(size: (f64, f64)) {
    use std::process::Command as Proc;
    let pid = std::process::id();
    let (w, h) = (size.0.round(), size.1.round());
    std::thread::spawn(move || {
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
                if let Some(a) = hypr_address() {
                    hypr_dispatch(
                        &[
                            format!("hl.dsp.window.float({{ action = 'enable', window = 'address:{a}' }})"),
                            format!("hl.dsp.window.resize({{ x = {w}, y = {h}, relative = false, window = 'address:{a}' }})"),
                            format!("hl.dsp.window.pin({{ action = 'enable', window = 'address:{a}' }})"),
                        ],
                        &format!(
                            "dispatch setfloating address:{a} ; dispatch resizewindowpixel exact {w} {h},address:{a} ; dispatch pin address:{a}"
                        ),
                    );
                    return;
                }
            } else if std::env::var_os("SWAYSOCK").is_some() {
                let criteria = format!("[pid={pid}] floating enable, sticky enable, resize set {w} {h}");
                if Proc::new("swaymsg").arg(&criteria).output().map(|o| o.status.success()).unwrap_or(false) {
                    return;
                }
            } else {
                return;
            }
        }
    });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let first = parse(&args);
    let context = tauri::generate_context!();
    // These only make sense for an open window. If another instance is running, the
    // single-instance plugin hands it these arguments and exits during build();
    // getting past build() means there is no window, so there is nothing to do.
    if matches!(first.action.as_str(), "pause" | "quit" | "set" | "mute") {
        let _ = tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
            .build(context);
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| handle(app, parse(&argv))))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        on_hotkey(app, shortcut);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![set_pinned, quit_player, set_on_top])
        .setup(move |app| {
            set_hotkeys(app.handle(), first.hotkey.as_deref(), first.mute_hotkey.as_deref());
            let mut opts: serde_json::Value = serde_json::from_str(&opts_json(&first)).unwrap();
            opts["windowControls"] = true.into();
            let init = format!("window.__REELS_OPTS = {opts};\n{CONTROLLER}");
            let builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::External(REELS_URL.parse().unwrap()));
            // WebView2 needs this flag to autoplay with sound. Setting browser args replaces
            // wry's defaults, so those are repeated.
            #[cfg(windows)]
            let builder = builder.additional_browser_args(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required",
            );
            // The page has its own drag bar and resize grip, as on Hyprland, where no title bar
            // is drawn; Windows would add one on top of them.
            #[cfg(windows)]
            let builder = builder.decorations(false);
            let win = builder
                .title(TITLE)
                // In light mode Instagram leaves a white band under the reel.
                .theme(Some(Theme::Dark))
                // Instagram fits a 9:16 reel to the window. At the default ratio the height
                // limits it, so one reel fills the window; a taller window shows part of the next.
                .inner_size(first.size.0, first.size.1)
                .min_inner_size(MIN_SIDE, MIN_SIDE)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .initialization_script(&init)
                .build()?;
            #[cfg(target_os = "linux")]
            {
                tune_webkit(&win);
                pin_on_wayland(first.size);
            }
            #[cfg(not(target_os = "linux"))]
            let _ = win;
            Ok(())
        })
        .run(context)
        .expect("failed to start agent-reels-player");
}
