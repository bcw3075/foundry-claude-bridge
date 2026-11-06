/* Hidden test sessions: a second Chromium process, started only while a session is open and closed when the last one
   ends, so a hung or heavy session can't touch the bridge's own page. Each session is one browser context (its own
   cookie) joined as one fixed account: "gm" and "player" in config.json's uiAccounts. Sessions never rejoin by
   themselves: a dropped session reports "down" and is started again on request, so it can't take a login someone
   else has since used. */
import { chromium } from "playwright";
import { launchOptions, VIEWPORT, watchConsole, joinWorld, evalOn, reloadPage } from "./foundry.mjs";

export const SESSION_KEYS = ["gm", "player"];

class Session {
  constructor(key, name, cfg, log) {
    this.key = key; this.name = name; this.cfg = cfg; this.log = log;
    this.ctx = null; this.page = null;
    this.state = "stopped";      /* stopped | joining | ready | down */
    this.since = null; this.lastError = null;
    this.console = [];
  }

  async join(browser) {
    this.state = "joining"; this.lastError = null;
    try {
      if (!this.ctx) {
        this.ctx = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
        this.page = await this.ctx.newPage();
        watchConsole(this.page, this.console, this.log, `session ${this.key}`);
        this.page.on("crash", () => { this.state = "down"; this.lastError = "page crashed"; });
        this.page.on("close", () => { if (this.state !== "stopped") { this.state = "down"; this.lastError = "page closed"; } });
      }
      const info = await joinWorld(this.page, { foundryUrl: this.cfg.foundryUrl, user: this.name, pass: "" });
      this.state = "ready"; this.since = new Date().toISOString();
      this.log(`session ${this.key}`, `joined "${info.world}" as ${info.user} (role ${info.role})`);
      return info;
    } catch (e) { this.state = "down"; this.lastError = String(e?.message ?? e); throw e; }
  }

  async reload(opts) {
    if (!this.page) throw new Error(`Session "${this.key}" isn't started.`);
    this.state = "joining";
    try {
      const r = await reloadPage(this.page, opts);
      if (!r.ready) throw new Error(`The reload left the page on ${r.url}; start the session again.`);
      this.state = "ready";
      return r;
    } catch (e) { this.state = "down"; this.lastError = String(e?.message ?? e); throw e; }
  }

  async close() {
    this.state = "stopped";
    await this.ctx?.close().catch(() => {});
    this.ctx = null; this.page = null; this.since = null;
  }

  async eval(fn, arg, { timeout } = {}) {
    if (this.state !== "ready") throw new Error(`Session "${this.key}" (${this.name}) isn't connected (${this.state}${this.lastError ? ": " + this.lastError : ""}).`);
    return evalOn(this.page, fn, arg, timeout ?? this.cfg.evalTimeoutMs);
  }

  status() { return { key: this.key, user: this.name, state: this.state, since: this.since, error: this.lastError }; }
}

export class SessionManager {
  constructor(cfg, log) {
    this.cfg = cfg; this.log = log;
    this.browser = null; this.browserSince = null;
    this.sessions = Object.fromEntries(SESSION_KEYS.map(k => [k, new Session(k, cfg.uiAccounts[k], cfg, log)]));
    this.watch = setInterval(() => this.check().catch(() => {}), 15000);
  }

  accountOf(key) { return this.cfg.uiAccounts[key]; }

  /** The session for a key; throws when it isn't started. */
  get(key) {
    const s = this.sessions[key];
    if (!s) throw new Error(`Unknown session "${key}".`);
    if (s.state === "stopped") throw new Error(`Session "${key}" (${s.name}) isn't started. Start it with the session tool.`);
    return s;
  }

  async launch() {
    if (this.browser) return;
    this.browser = await chromium.launch(launchOptions(this.cfg));
    this.browser.on("disconnected", () => {
      this.browser = null; this.browserSince = null;
      for (const s of Object.values(this.sessions)) if (s.state !== "stopped") { s.state = "down"; s.lastError = "the session browser closed"; s.ctx = null; s.page = null; }
    });
    this.browserSince = new Date().toISOString();
    this.log("sessions", "session browser started (a second Chromium process)");
  }

  /** Start (or re-join) a session. `isOnline(name)` is asked first so the bridge never takes a login someone else holds. */
  async start(key, isOnline) {
    const s = this.sessions[key];
    if (!s) throw new Error(`Unknown session "${key}".`);
    if (!s.name) throw new Error(`No account is set for session "${key}" (uiAccounts in config.json).`);
    if (s.name === this.cfg.foundryUser) throw new Error(`Session "${key}" is set to the bridge's own account "${s.name}"; two clients can't share one Foundry user.`);
    if (s.state === "ready") return { ...s.status(), started: false, note: "already running" };
    if (await isOnline(s.name)) throw new Error(`"${s.name}" is already logged in somewhere else (a browser tab, perhaps). Starting a session would log that client out, so it was refused.`);
    await this.launch();
    const info = await s.join(this.browser);
    return { ...s.status(), started: true, role: info.role, world: info.world };
  }

  async stop(key) {
    const s = this.sessions[key];
    if (!s) throw new Error(`Unknown session "${key}".`);
    const was = s.state;
    await s.close();
    if (Object.values(this.sessions).every(x => x.state === "stopped") && this.browser) {
      const b = this.browser; this.browser = null; this.browserSince = null;
      await b.close().catch(() => {});
      this.log("sessions", "session browser closed");
    }
    return { ...s.status(), stopped: was !== "stopped" };
  }

  async stopAll() { clearInterval(this.watch); for (const k of SESSION_KEYS) await this.stop(k).catch(() => {}); }

  /** Mark a session down when its page has left the game (a world restart, a kick); it is not rejoined by itself. */
  async check() {
    for (const s of Object.values(this.sessions)) {
      if (s.state !== "ready" || !s.page) continue;
      const alive = await s.page.evaluate(() => !!(window.game?.ready && game.socket?.connected && location.pathname.endsWith("/game"))).catch(() => false);
      if (!alive) { s.state = "down"; s.lastError = "left the game (world restart or kicked); start the session again"; this.log(`session ${s.key}`, s.lastError); }
    }
  }

  status() { return { browser: !!this.browser, browserSince: this.browserSince, sessions: Object.values(this.sessions).map(s => s.status()) }; }
}
