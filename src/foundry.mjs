/* The hidden Foundry client. One Chromium page stays joined to the world as the bridge's GM user,
   and every tool runs as a function inside that page. Reconnects by itself when the world restarts.
   The join flow and the in-page helpers are shared with the test sessions in sessions.mjs. */
import { chromium } from "playwright";

/** Chromium launch options shared by the bridge's browser and the session browser. */
export function launchOptions(cfg) {
  /* Foundry's canvas needs WebGL; these flags let headless Chromium use the GPU, or software rendering where there is none.
     "chromium" = full Chromium in its new headless mode, which can use the GPU; the default headless shell draws in software and
     made a 6 MB map redraw take 2 minutes instead of 12 s. Set browserChannel to "" in config.json to go back to the shell. */
  const channel = cfg.browserChannel === undefined ? "chromium" : cfg.browserChannel;
  return { headless: cfg.headless, ...(channel ? { channel } : {}),
    args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-accelerated-2d-canvas", "--enable-unsafe-swiftshader", "--mute-audio", ...(cfg.chromiumArgs ?? [])] };
}

export const VIEWPORT = { width: 1600, height: 1000 };

/** Keep the last console messages and page errors of a page in `buf` (a plain array, newest last). */
export function watchConsole(page, buf, log, label) {
  const push = rec => { buf.push(rec); if (buf.length > 200) buf.splice(0, buf.length - 200); };
  page.on("console", m => {
    const rec = { time: new Date().toISOString(), type: m.type(), text: m.text().slice(0, 500) };
    push(rec);
    if (m.type() === "error" && log) log(label, `console: ${rec.text.slice(0, 300)}`);
  });
  page.on("pageerror", e => push({ time: new Date().toISOString(), type: "pageerror", text: String(e?.message ?? e).slice(0, 500) }));
}

/** Join the running world on `page` as `user`. Throws with a plain reason when it can't. Returns {world, user, role}. */
export async function joinWorld(page, { foundryUrl, user, pass }) {
  await page.goto(foundryUrl + "/join", { waitUntil: "domcontentloaded", timeout: 30000 });
  /* Foundry 14 draws the join form with JavaScript a moment after the page loads, so wait for it */
  const sel = await page.waitForSelector("select[name=userId]", { timeout: 20000 }).catch(() => null);
  if (!sel) {
    const text = (await page.textContent("body").catch(() => "")) ?? "";
    if (/no active game/i.test(text)) throw new Error("No world is running in Foundry.");
    if (/administrator/i.test(text) || /\/auth/.test(page.url())) throw new Error("Foundry is on its setup screen (no world running).");
    throw new Error(`Foundry's join page isn't available (${page.url()}: "${text.replace(/\s+/g, " ").trim().slice(0, 80)}").`);
  }
  const ok = await page.evaluate(({ user, pass }) => {
    const s = document.querySelector("select[name=userId]");
    const o = [...s.options].find(o => o.text.trim() === user);
    if (!o) return false;
    s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true }));
    const pw = document.querySelector("input[name=password]"); if (pw && pass) pw.value = pass;
    document.querySelector("button[name=join]").click();
    return true;
  }, { user, pass: pass ?? "" });
  if (!ok) throw new Error(`Foundry has no user named "${user}".`);
  await page.waitForURL(/\/game/, { timeout: 30000 });
  await waitReady(page);
  await installHelpers(page);
  return page.evaluate(() => ({ world: game.world.title, user: game.user.name, role: game.user.role }));
}

/** Wait until the game and the canvas are ready on `page`. */
export function waitReady(page, timeout = 120000) {
  return page.waitForFunction(() => window.game?.ready && window.canvas?.ready, null, { timeout });
}

/** Small helpers installed in the page once per join (and again after a reload, which clears them). */
export async function installHelpers(page) {
  await page.evaluate(() => {
    const jobs = window.__bridge?.jobs ?? {};
    window.__bridge = {
      jobs,
      /* plain text from Foundry HTML */
      text(html) { const d = document.createElement("div"); d.innerHTML = String(html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr|section|blockquote)>/gi, "$&\n"); return d.textContent.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(); },
      /* long work runs here and is polled with job_status */
      startJob(name, promise) {
        const id = Math.random().toString(36).slice(2, 10);
        const job = { id, name, started: Date.now(), done: false };
        jobs[id] = job;
        promise.then(r => { job.done = true; job.result = r; }, e => { job.done = true; job.error = String(e?.message ?? e); });
        return id;
      }
    };
  });
}

/** Run a self-contained function in a page with a time limit. */
export async function evalOn(page, fn, arg, ms) {
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Foundry didn't answer within ${Math.round(ms / 1000)} s.`)), ms); });
  try { return await Promise.race([page.evaluate(fn, arg), guard]); }
  finally { clearTimeout(timer); }
}

/** Reload a joined page, optionally clearing the browser cache first (module files are cached for hours). Reinstalls the helpers. */
export async function reloadPage(page, { clearCache = false } = {}) {
  if (clearCache) { const cdp = await page.context().newCDPSession(page); try { await cdp.send("Network.clearBrowserCache"); } finally { await cdp.detach().catch(() => {}); } }
  const t0 = Date.now();
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  if (!/\/game/.test(page.url())) return { ready: false, url: page.url(), seconds: Math.round((Date.now() - t0) / 1000) };
  await waitReady(page);
  await installHelpers(page);
  return { ready: true, url: page.url(), seconds: Math.round((Date.now() - t0) / 1000) };
}

export class FoundryClient {
  constructor(cfg, log) {
    this.cfg = cfg; this.log = log;
    this.browser = null; this.page = null;
    this.state = "stopped";      /* stopped | starting | joining | ready | down */
    this.lastError = null; this.since = null;
    this.watch = null;
    this.console = [];           /* last console messages of the page */
  }

  get name() { return this.cfg.foundryUser; }

  async start() {
    if (this.browser) return;
    this.state = "starting";
    this.browser = await chromium.launch(launchOptions(this.cfg));
    const ctx = await this.browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
    this.page = await ctx.newPage();
    watchConsole(this.page, this.console, this.log, "foundry");
    this.page.on("crash", () => { this.state = "down"; this.lastError = "page crashed"; });
    await this.join().catch(e => this.fail(e));
    this.watch = setInterval(() => this.check().catch(() => {}), 15000);
  }

  async stop() {
    clearInterval(this.watch); this.watch = null;
    await this.browser?.close().catch(() => {}); this.browser = null; this.page = null; this.state = "stopped";
  }

  /** Join the running world as the configured user. */
  async join() {
    this.state = "joining";
    const info = await joinWorld(this.page, { foundryUrl: this.cfg.foundryUrl, user: this.cfg.foundryUser, pass: this.cfg.foundryPassword });
    this.state = "ready"; this.lastError = null; this.since = new Date().toISOString();
    this.log("foundry", `joined "${info.world}" as ${info.user} (role ${info.role})`);
    if (info.role < 3) this.log("foundry", "warning: the bridge user is not a GM, most tools will be refused by Foundry");
  }

  /** Reload the page (the watchdog stands back while it happens). Rejoins if the reload lands on the join screen. */
  async reload(opts) {
    if (!this.page) throw new Error("The bridge's browser isn't running.");
    this.state = "joining";
    try {
      const r = await reloadPage(this.page, opts);
      if (!r.ready) { await this.join(); return { ...r, ready: true, rejoined: true }; }
      this.state = "ready";
      return r;
    } catch (e) { this.fail(e); throw e; }
  }

  /** Watchdog: notice a restart or a dropped connection and rejoin. */
  async check() {
    if (!this.page || this.state === "joining" || this.state === "starting") return;
    let alive = false;
    try {
      alive = await this.page.evaluate(() => !!(window.game?.ready && game.socket?.connected && location.pathname.endsWith("/game"))).catch(() => false);
    } catch { alive = false; }
    if (alive) { if (this.state !== "ready") { this.state = "ready"; this.log("foundry", "connection is back"); } return; }
    if (this.state === "ready") this.log("foundry", "connection lost, will rejoin");
    this.state = "down";
    try { await this.join(); } catch (e) { this.fail(e); }
  }

  /** Remember why joining failed; log it once per distinct reason, since the watchdog retries every 15 s. */
  fail(e) {
    const msg = String(e?.message ?? e);
    this.state = "down";
    if (msg !== this.lastError) this.log("foundry", `can't join: ${msg} (will keep trying)`);
    this.lastError = msg;
  }

  /** Run a function inside the Foundry page. `fn` must be self-contained; `arg` is JSON. */
  async eval(fn, arg, { timeout } = {}) {
    if (this.state !== "ready") throw new Error(`Foundry isn't connected (${this.state}${this.lastError ? ": " + this.lastError : ""}).`);
    return evalOn(this.page, fn, arg, timeout ?? this.cfg.evalTimeoutMs);
  }

  status() { return { state: this.state, since: this.since, error: this.lastError, user: this.cfg.foundryUser, foundryUrl: this.cfg.foundryUrl}; }
}
