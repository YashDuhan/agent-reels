/**
 * Browser mode: reels play in the user's own Chrome, Brave, Edge or Chromium, in a
 * small app window controlled over the Chrome DevTools Protocol.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { HOME_DIR, log, type Config } from "./config.js";

/** Separate from the user's normal browser profile. */
const PROFILE_DIR = path.join(HOME_DIR, "profile");
const REELS_URL = "https://www.instagram.com/reels/";
const LOGIN_URL = "https://www.instagram.com/accounts/login/";
export const DEFAULT_PORT = 9339;

const CONTROLLER = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "shared", "controller.js"),
  "utf8",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface InstalledBrowser {
  name: string;
  path: string;
}

type Candidates = Array<[name: string, paths: string[]]>;

function candidates(): Candidates {
  if (process.platform === "darwin") {
    const apps = ["/Applications", path.join(os.homedir(), "Applications")];
    const app = (bundle: string, bin: string) => apps.map((d) => path.join(d, `${bundle}.app/Contents/MacOS/${bin}`));
    return [
      ["Google Chrome", app("Google Chrome", "Google Chrome")],
      ["Brave", app("Brave Browser", "Brave Browser")],
      ["Microsoft Edge", app("Microsoft Edge", "Microsoft Edge")],
      ["Chromium", app("Chromium", "Chromium")],
      ["Arc", app("Arc", "Arc")],
    ];
  }
  if (process.platform === "win32") {
    const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]].filter(
      Boolean,
    ) as string[];
    const exe = (rel: string) => roots.map((r) => path.join(r, rel));
    return [
      ["Google Chrome", exe("Google\\Chrome\\Application\\chrome.exe")],
      ["Brave", exe("BraveSoftware\\Brave-Browser\\Application\\brave.exe")],
      ["Microsoft Edge", exe("Microsoft\\Edge\\Application\\msedge.exe")],
      ["Chromium", exe("Chromium\\Application\\chrome.exe")],
    ];
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  const onPath = (...bins: string[]) => bins.flatMap((b) => dirs.map((d) => path.join(d, b)));
  return [
    ["Google Chrome", onPath("google-chrome-stable", "google-chrome")],
    ["Chromium", onPath("chromium", "chromium-browser")],
    ["Brave", onPath("brave", "brave-browser")],
    ["Microsoft Edge", onPath("microsoft-edge-stable", "microsoft-edge")],
  ];
}

export function detectBrowsers(): InstalledBrowser[] {
  const found: InstalledBrowser[] = [];
  for (const [name, paths] of candidates()) {
    const hit = paths.find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    if (hit) found.push({ name, path: hit });
  }
  return found;
}

function port(config: Config): number {
  return config.port ?? DEFAULT_PORT;
}

async function isUp(config: Config): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port(config)}/json/version`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Hyprland tiles new windows; float this one at reels size. Left unpinned so it can be dragged. */
function floatOnHyprland(pid: number, { width, height }: Config["windowSize"]): void {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return;
  for (let i = 0; i < 20; i++) {
    const out = spawnSync("hyprctl", ["clients", "-j"], { encoding: "utf8" });
    let client: { address: string } | undefined;
    try {
      client = (JSON.parse(out.stdout) as Array<{ pid: number; address: string }>).find((c) => c.pid === pid);
    } catch {
      return;
    }
    if (client) {
      const a = client.address;
      const lua = [
        `hl.dsp.window.float({ action = 'enable', window = 'address:${a}' })`,
        `hl.dsp.window.resize({ x = ${width}, y = ${height}, relative = false, window = 'address:${a}' })`,
      ];
      const ok = lua.every((d) => spawnSync("hyprctl", ["dispatch", d], { encoding: "utf8" }).stdout.trim() === "ok");
      if (!ok) {
        spawnSync("hyprctl", ["--batch", `dispatch setfloating address:${a} ; dispatch resizewindowpixel exact ${width} ${height},address:${a}`]);
      }
      return;
    }
    spawnSync("sleep", ["0.25"]);
  }
}

/** Connects to the reels browser, launching it first (detached) if it isn't running. */
async function connect(config: Config, url = REELS_URL): Promise<{ browser: Browser; launched: boolean }> {
  let launched = false;
  if (!(await isUp(config))) {
    if (!config.browserPath) throw new Error("No browser configured. Run: reels setup");
    const child = spawn(
      config.browserPath,
      [
        `--user-data-dir=${PROFILE_DIR}`,
        `--remote-debugging-port=${port(config)}`,
        "--autoplay-policy=no-user-gesture-required",
        // Keep reels (and auto-advance) running while the window is covered.
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--no-first-run",
        "--no-default-browser-check",
        `--window-size=${config.windowSize.width},${config.windowSize.height}`,
        `--app=${url}`,
      ],
      // No windowsHide: Chrome applies it to its first window, so the reels window would start hidden.
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    launched = true;
    const deadline = Date.now() + 20_000;
    while (!(await isUp(config))) {
      if (Date.now() > deadline) throw new Error(`Browser did not start (${config.browserPath})`);
      await sleep(250);
    }
    if (child.pid) floatOnHyprland(child.pid, config.windowSize);
  }
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port(config)}`, defaultViewport: null });
  return { browser, launched };
}

function isInstagram(url: string, pathPrefix = "/"): boolean {
  try {
    const u = new URL(url);
    return (u.hostname === "instagram.com" || u.hostname.endsWith(".instagram.com")) && u.pathname.startsWith(pathPrefix);
  } catch {
    return false;
  }
}

async function instagramPage(browser: Browser): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pages = await browser.pages();
    const page = pages.find((p) => isInstagram(p.url())) ?? pages[0];
    if (page) return page;
    await sleep(250);
  }
  throw new Error("No browser window found");
}

/** Injects the controller (a no-op if already there) and applies options. */
async function control(page: Page, config: Config, then: "play" | "pause" | "none"): Promise<void> {
  const opts = { autoAdvance: config.autoAdvance, sound: config.sound, autoplay: then === "play" };
  // Passed as source: Instagram's CSP blocks eval() inside the page.
  await page.evaluate(`window.__REELS_OPTS = ${JSON.stringify(opts)};\n${CONTROLLER}`);
  await page.evaluate(
    (o: typeof opts, action: string) => {
      const w = globalThis as unknown as { __reels?: { setOpts(o: unknown): void; play(): void; pause(): void } };
      w.__reels?.setOpts(o);
      if (action === "play") w.__reels?.play();
      if (action === "pause") w.__reels?.pause();
    },
    opts,
    then,
  );
}

export async function chromePlay(config: Config): Promise<void> {
  const { browser, launched } = await connect(config);
  try {
    let page = await instagramPage(browser);
    try {
      if (!isInstagram(page.url(), "/reel")) await page.goto(REELS_URL, { waitUntil: "domcontentloaded" });
    } catch {
      // The window was closed but the browser kept running.
      page = await browser.newPage();
      await page.goto(REELS_URL, { waitUntil: "domcontentloaded" });
    }
    if (isInstagram(page.url(), "/accounts/login")) {
      throw new Error("Instagram wants you to log in: do it in the browser window, or run `reels login`");
    }
    await page.waitForSelector("video", { timeout: 20_000 });
    await control(page, config, "play");
    log(`browser playing (${launched ? "launched" : "reused"})`);
  } finally {
    await browser.disconnect();
  }
}

/** Pauses or updates options in a running browser; never launches one. */
export async function chromeApply(config: Config, action: "pause" | "none"): Promise<void> {
  if (!(await isUp(config))) return;
  const { browser } = await connect(config);
  try {
    const page = await instagramPage(browser);
    if (isInstagram(page.url())) await control(page, config, action);
  } finally {
    await browser.disconnect();
  }
}

/** Opens Instagram's login in the browser and waits for the session cookie. */
export async function chromeLogin(config: Config, timeoutMs = 5 * 60_000): Promise<"already" | "ok" | "timeout"> {
  const { browser } = await connect(config, LOGIN_URL);
  try {
    const page = await instagramPage(browser);
    const loggedIn = async () => {
      const cdp = await page.createCDPSession();
      try {
        const { cookies } = await cdp.send("Network.getCookies", { urls: ["https://www.instagram.com"] });
        return cookies.some((c) => c.name === "sessionid" && c.value.length > 0);
      } finally {
        await cdp.detach().catch(() => {});
      }
    };
    if (await loggedIn()) return "already";
    if (!isInstagram(page.url(), "/accounts/login")) await page.goto(LOGIN_URL);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await loggedIn().catch(() => false)) {
        await page.goto(REELS_URL).catch(() => {});
        return "ok";
      }
      await sleep(1500);
    }
    return "timeout";
  } finally {
    await browser.disconnect();
  }
}
