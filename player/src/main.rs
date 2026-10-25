//! agent-reels-player: a small always-on-top window playing Instagram Reels.
//!
//! Usage: agent-reels-player <play|pause|show|set|quit> [--sound=0|1] [--advance=0|1]
//!
//! Only one instance runs. Launching it again forwards the arguments to the
//! running window (tauri-plugin-single-instance) and exits.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Manager, Theme, WebviewUrl, WebviewWindowBuilder};

const REELS_URL: &str = "https://www.instagram.com/reels/";
const CONTROLLER: &str = include_str!("../../shared/controller.js");
const WINDOW: &str = "main";
const TITLE: &str = "agent-reels";

struct Command {
    action: String,
    sound: Option<bool>,
    advance: Option<bool>,
}

fn parse(args: &[String]) -> Command {
    let mut cmd = Command { action: "play".into(), sound: None, advance: None };
    for arg in args.iter().skip(1) {
        let flag = |name: &str| arg.strip_prefix(name).map(|v| v != "0" && v != "false");
        if let Some(v) = flag("--sound=") {
            cmd.sound = Some(v);
        } else if let Some(v) = flag("--advance=") {
            cmd.advance = Some(v);
        } else if !arg.starts_with('-') {
            cmd.action = arg.clone();
        }
    }
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

/// Applies a command to the already-open window.
fn handle(app: &AppHandle, cmd: Command) {
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
fn pin_on_wayland() {
    use std::process::Command as Proc;
    let pid = std::process::id();
    std::thread::spawn(move || {
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some() {
                if let Some(a) = hypr_address() {
                    hypr_dispatch(
                        &[
                            format!("hl.dsp.window.float({{ action = 'enable', window = 'address:{a}' }})"),
                            format!("hl.dsp.window.resize({{ x = 460, y = 640, relative = false, window = 'address:{a}' }})"),
                            format!("hl.dsp.window.pin({{ action = 'enable', window = 'address:{a}' }})"),
                        ],
                        &format!(
                            "dispatch setfloating address:{a} ; dispatch resizewindowpixel exact 460 640,address:{a} ; dispatch pin address:{a}"
                        ),
                    );
                    return;
                }
            } else if std::env::var_os("SWAYSOCK").is_some() {
                let criteria = format!("[pid={pid}] floating enable, sticky enable, resize set 460 640");
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
    // pause/set/quit only make sense for an open window. If another instance is running,
    // the single-instance plugin hands it these arguments and exits during build();
    // getting past build() means there is no window, so there is nothing to do.
    if matches!(first.action.as_str(), "pause" | "quit" | "set") {
        let _ = tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
            .build(context);
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| handle(app, parse(&argv))))
        .invoke_handler(tauri::generate_handler![set_pinned])
        .setup(move |app| {
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
            let win = builder
                .title(TITLE)
                // In light mode Instagram leaves a white band under the reel.
                .theme(Some(Theme::Dark))
                // Instagram fits a 9:16 reel to the window. At this ratio the height limits it,
                // so one reel fills the window; a taller window shows part of the next.
                .inner_size(460.0, 640.0)
                .min_inner_size(300.0, 420.0)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .initialization_script(&init)
                .build()?;
            #[cfg(target_os = "linux")]
            {
                tune_webkit(&win);
                pin_on_wayland();
            }
            #[cfg(not(target_os = "linux"))]
            let _ = win;
            Ok(())
        })
        .run(context)
        .expect("failed to start agent-reels-player");
}
