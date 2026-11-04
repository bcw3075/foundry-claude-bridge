/* The hidden Foundry client. One Chromium page stays joined to the world as the bridge's GM user,
   and every tool runs as a function inside that page. Reconnects by itself when the world restarts. */
import { chromium } from "playwright";

export class FoundryClient {
  constructor(cfg, log) {
    this.cfg = cfg; this.log = log;
    this.browser = null; this.page = null;
    this.state = "stopped";      /* stopped | starting | joining | ready | down */
    this.lastError = null; this.since = null;
    this.watch = null;
  }

  async start() {
    if (this.browser) return;
    this.state = "starting";
    /* Foundry's canvas needs WebGL; these flags let headless Chromium use the GPU, or software rendering where there is none */
    this.browser = await chromium.launch({ headless: this.cfg.headless, args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--mute-audio", ...(this.cfg.chromiumArgs ?? [])] });
    const ctx = await this.browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
    this.page = await ctx.newPage();
    this.page.on("console", m => { if (m.type() === "error") this.log("foundry", `console: ${m.text().slice(0, 300)}`); });
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
    const p = this.page, cfg = this.cfg;
    this.state = "joining";
    await p.goto(cfg.foundryUrl + "/join", { waitUntil: "domcontentloaded", timeout: 30000 });
    const sel = await p.$("select[name=userId]");
    if (!sel) {
      const text = (await p.textContent("body").catch(() => "")) ?? "";
      throw new Error(/no active game/i.test(text) ? "No world is running in Foundry." : `Foundry's join page isn't available (${p.url()}).`);
    }
    const ok = await p.evaluate(({ user, pass }) => {
      const s = document.querySelector("select[name=userId]");
      const o = [...s.options].find(o => o.text.trim() === user);
      if (!o) return false;
      s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true }));
      const pw = document.querySelector("input[name=password]"); if (pw && pass) pw.value = pass;
      document.querySelector("button[name=join]").click();
      return true;
    }, { user: cfg.foundryUser, pass: cfg.foundryPassword });
    if (!ok) throw new Error(`Foundry has no user named "${cfg.foundryUser}".`);
    await p.waitForURL(/\/game/, { timeout: 30000 });
    await p.waitForFunction(() => window.game?.ready && window.canvas?.ready, null, { timeout: 120000 });
    await this.prepare();
    this.state = "ready"; this.lastError = null; this.since = new Date().toISOString();
    const info = await this.eval(() => ({ world: game.world.title, user: game.user.name, role: game.user.role }));
    this.log("foundry", `joined "${info.world}" as ${info.user} (role ${info.role})`);
    if (info.role < 3) this.log("foundry", "warning: the bridge user is not a GM, most tools will be refused by Foundry");
  }

  /** Small helpers installed in the page once per join. */
  async prepare() {
    await this.page.evaluate(() => {
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
    const ms = timeout ?? this.cfg.evalTimeoutMs;
    let timer;
    const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Foundry didn't answer within ${Math.round(ms / 1000)} s.`)), ms); });
    try { return await Promise.race([this.page.evaluate(fn, arg), guard]); }
    finally { clearTimeout(timer); }
  }

  status() { return { state: this.state, since: this.since, error: this.lastError, user: this.cfg.foundryUser, foundryUrl: this.cfg.foundryUrl }; }
}
