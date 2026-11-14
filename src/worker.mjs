/* The API worker (0.4.0): thinks for Encounter Builder's monsters through the Claude API, so a fight needs no chat. It runs beside the MCP server,
   only when the owner has put "anthropicApiKey" in config.json, and uses the module's own brain interface on the bridge's page, exactly as a chat
   does through fight_wait and fight_plan: it waits for an event (with route "api", so it never retires a chat), sends the event to the API with the
   module's own prompt as the system prompt, and hands the answer in through submitPlan, which checks it like any plan.

   When it listens: whenever a started fight in the world is on the API route (the module's "Thinks by" list), looked at every apiPollS seconds with
   a read that writes nothing; or when someone presses Wake Angel on the GM's card. It stops listening when no fight wants it.
   When a turn fails: a turn the API can't plan is handed on (the module gives it to a listening chat, then to the GM). A refused key, no credit or a
   missing model stops the worker until Wake Angel, with the reason on the GM's card; so does reaching apiMaxCallsPerHour.
   The key stays in this process: never logged, audited, sent to Foundry or written anywhere. */
import { look } from "./ui.mjs";

const ID = "lythara-encounter-builder";
/* the event kinds the API answers; a "stall" asks the thinker to look into something, which only a chat with tools can do. "look" (0.4.1):
   Encounter Builder 0.33.0's fight-start look, one a fight, answered with the look's JSON */
const KINDS = ["turn", "retry", "replan", "choice", "look"];
const ASK = 'A monster needs you. Below is the event, with its packet. Answer with the JSON alone: for a "choice" event the choice, for a "look" event the look, otherwise the plan.';
const GROUND = "#lythara-encounter-builder-ground";

/* ---------- in-page functions (self-contained: they are serialised into the bridge's page) ---------- */
function apiWantedIn() {
  const m = game.modules.get("lythara-encounter-builder");
  if (!m?.active || typeof m.api?.fight?.route?.wanted !== "function") return { module: false };
  return { module: true, ...m.api.fight.route.wanted() };
}
async function apiWaitIn({ cursor, seconds, generation }) {
  const m = game.modules.get("lythara-encounter-builder");
  if (!m?.active || typeof m.api?.fight?.waitForEvent !== "function") throw new Error("Encounter Builder isn't active in this world.");
  return m.api.fight.waitForEvent(cursor, seconds, generation == null ? { route: "api" } : { generation, route: "api" });
}
async function apiSubmitIn({ combatId, requestId, plan, meta, handOff }) {
  const f = game.modules.get("lythara-encounter-builder")?.api?.fight, combat = game.combats.get(combatId);
  if (!f || !combat) throw new Error("That fight is gone.");
  if (handOff != null) return f.handOff(combat, requestId, handOff, meta);
  return f.submitPlan(combat, requestId, plan, meta);
}
async function apiNoteIn({ note }) {
  const f = game.modules.get("lythara-encounter-builder")?.api?.fight;
  if (typeof f?.route?.note !== "function") return null;
  return f.route.note(note);
}
/* while an answer takes long: the module's light kept on for this generation, so the turn isn't given to a chat meanwhile */
async function apiAliveIn({ generation }) { const f = game.modules.get("lythara-encounter-builder")?.api?.fight; return typeof f?.route?.alive === "function" ? f.route.alive(generation) : null; }
/* what one answer cost, kept on the fight for the History's total, whether its plan lands or not */
async function apiSpendIn({ combatId, use }) { const f = game.modules.get("lythara-encounter-builder")?.api?.fight, c = game.combats.get(combatId); if (!c || typeof f?.route?.spend !== "function") return null; return f.route.spend(c, use); }

/* ---------- pure helpers, exported for the tests ---------- */
/** The JSON object in an answer: the whole text, or the first {...} in it (a model may wrap it in a code fence). Null when there is none. */
export function planOf(text) {
  const t = String(text ?? "").trim(); try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
/** Dollars for one call, from the usage the API reports and the prices per million tokens [fresh input, cache write, cache read, output]. */
export function costOf(u = {}, p = [0, 0, 0, 0]) {
  return ((u.input_tokens ?? 0) * p[0] + (u.cache_creation_input_tokens ?? 0) * p[1] + (u.cache_read_input_tokens ?? 0) * p[2] + (u.output_tokens ?? 0) * p[3]) / 1e6;
}
/** Is an API error one that every later call would hit too (so the worker stops rather than failing turn after turn)? */
export function hardFailure(status, message = "") {
  if (status === 401 || status === 403 || status === 404) return true;
  return status === 400 && /credit balance|billing|usage limit|spend limit/i.test(message);
}
/** Plain words for the GM's card about an API error. */
export function failureWords(status, message = "") {
  const m = String(message ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  if (status === 401) return "the API refused the key: check \"anthropicApiKey\" in the bridge's config.json";
  if (status === 403) return "the API says the key may not do this";
  if (status === 404) return `the API doesn't know that model${m ? ` (${m})` : ""}: check "apiModels" in the bridge's config.json`;
  if (status === 400 && /credit balance|billing/i.test(m)) return "the API account is out of credit";
  if (status === 400 && /usage limit|spend limit/i.test(m)) return "the workspace's spend limit has been reached";
  if (status === 429) return "the API kept saying it was too busy";
  if (status >= 500) return "the API didn't answer properly after three tries";
  return status ? `the API answered ${status}${m ? ` (${m})` : ""}` : `the API couldn't be reached${m ? ` (${m})` : ""}`;
}

export class ApiWorker {
  constructor(cfg, foundry, log, audit) {
    this.cfg = cfg; this.foundry = foundry; this.log = log; this.audit = audit;
    this.key = typeof cfg.anthropicApiKey === "string" && cfg.anthropicApiKey.trim() ? cfg.anthropicApiKey.trim() : null;
    this.timer = null; this.running = false; this.stopped = null; this.lastWake = null; this.generation = null; this.system = null; this.cursor = 0;
    this.calls = []; this.seen = new Set(); this.spent = 0; this.joined = null; this.wakeJoin = null;
    this.retryMs = Math.max(0, Number(cfg.apiRetryMs ?? 5000));
  }
  get on() { return !!this.key; }
  status() { return { key: !!this.key, listening: this.running, stopped: this.stopped, callsLastHour: this.recent(), spent: Math.round(this.spent * 1000) / 1000 }; }
  start() { if (this.timer) return; this.timer = setInterval(() => { this.tick().catch(e => this.log("api", `look failed: ${e.message}`)); }, Math.max(1, Number(this.cfg.apiPollS) || 5) * 1000); }
  stop() { clearInterval(this.timer); this.timer = null; }
  recent() { const hour = Date.now() - 3600000; this.calls = this.calls.filter(t => t > hour); return this.calls.length; }

  /** Every few seconds: is a fight on the API route, or has Wake Angel been pressed? Reads only. */
  async tick() {
    if (this.running || this.foundry.state !== "ready") return;
    const w = await this.foundry.eval(apiWantedIn);
    if (!w?.module || !w.ok) return;
    const n = Number(w.wake?.n) || 0, fresh = (w.wake?.launch ?? "") === (w.launch ?? "");
    /* the first look only notes where the presses stand, so a press from before this bridge started doesn't count as a new one */
    /* after the page joins again (a relaunch, another world) the presses are counted afresh: the setting is per world (review 3) */
    if (this.wakeJoin !== this.foundry.since) { this.wakeJoin = this.foundry.since; this.lastWake = null; }
    if (this.lastWake === null) { this.lastWake = n; return this.tick2(w, false); }
    const woke = n > this.lastWake && fresh; if (n > this.lastWake) this.lastWake = n;
    return this.tick2(w, woke);
  }
  async tick2(w, woke) {
    if (!this.key) { if (woke) await this.note({ state: "no-key" }); return; }
    if (this.stopped && !woke) return;
    /* woken after a stop: a fresh hello, which also clears the card's note (review 4) */
    if (woke && this.stopped) { this.log("api", "woken: listening again"); this.stopped = null; this.calls = []; this.generation = null; }
    if (w.want || woke) this.run().catch(e => this.log("api", `stopped listening: ${e.message}`));
  }
  async note(note) { try { await this.foundry.eval(apiNoteIn, { note }); } catch (e) { this.log("api", `couldn't write the card's note: ${e.message}`); } }

  /** Listen: a hello, then waits back to back until no fight wants the API, something stops it, or the bridge loses Foundry. */
  async run() {
    if (this.running) return; this.running = true;
    const chunk = Math.max(1, Math.min(100, Math.floor(Number(this.cfg.fightWaitChunkS)) || 60));
    try {
      for (;;) {
        if (this.foundry.state !== "ready" || this.stopped) break;
        /* the bridge's page joined again (a world relaunch, a module update): the prompt may have changed, so ask for the hello again */
        if (this.joined !== this.foundry.since) this.generation = null;
        if (this.generation == null) {
          const h = await this.foundry.eval(apiWaitIn, { cursor: 0, seconds: 0, generation: null });
          if (!h?.hello?.prompt) throw new Error("the module gave no hello");
          this.generation = h.hello.generation; this.system = h.hello.prompt; this.cursor = 0; this.joined = this.foundry.since;
          this.log("api", `listening for Encounter Builder (generation ${this.generation}, prompt version ${h.hello.promptVersion ?? "?"})`);
        }
        const r = await this.foundry.eval(apiWaitIn, { cursor: this.cursor, seconds: chunk, generation: this.generation }, { timeout: (chunk + 30) * 1000 });
        /* another API thinker said hello (a second bridge, a test): step back until Wake Angel, rather than take turns retiring each other */
        if (r?.superseded) { this.generation = null; this.stopped = "another API thinker took over"; this.log("api", `stopped: ${this.stopped}`); break; }
        if (r?.idle) { const w = await this.foundry.eval(apiWantedIn); if (!w?.want) break; continue; }
        if (!r?.event) continue;
        this.cursor = r.cursor;
        await this.handle(r.event);
      }
    } finally { this.running = false; }
  }

  /** One event: the API's plan for it, handed in; or handed on when the API can't. */
  async handle(ev) {
    if (!KINDS.includes(ev.kind) || this.seen.has(ev.seq)) return;
    this.seen.add(ev.seq); if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200));
    const cap = Math.max(1, Number(this.cfg.apiMaxCallsPerHour) || 120);   /* counts every request sent, retries included (review 7) */
    if (this.recent() >= cap) {
      const why = `${cap} calls in the last hour, the most allowed; press Wake Angel to go on`;
      this.stopped = why; this.log("api", `stopped: ${why}`); await this.note({ state: "capped", reason: why });
      return this.handOff(ev, `the API route stopped: ${why}`);
    }
    const models = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", ...(this.cfg.apiModels ?? {}) }, model = models[ev.model] ?? models.sonnet;
    const t0 = Date.now(); let out;
    try {
      const content = [{ type: "text", text: `${ASK}\n\n${JSON.stringify(ev)}` }];
      const b = ev.packet?.you?.burrow;
      if (b?.judgeGround || b?.judgeWalls) { try { const img = await look(this.foundry, { region: "element", selector: GROUND, maxWidth: 1400, quality: 70 }); content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } }); } catch (e) { this.log("api", `no map picture for the ground: ${e.message}`); } }
      out = await this.whileThinking(() => this.call(model, content));
    } catch (e) {
      const why = failureWords(e.status, e.apiMessage ?? e.message);
      this.audit({ tool: "api-worker", args: { requestId: ev.requestId, kind: ev.kind, model }, ok: false, error: why, ms: Date.now() - t0 });
      if (hardFailure(e.status, e.apiMessage ?? "")) { this.stopped = why; this.log("api", `stopped: ${why}`); await this.note({ state: "stopped", reason: why }); }
      else this.log("api", `${ev.monster ?? "a monster"} (${ev.kind}): ${why}`);
      return this.handOff(ev, why);
    }
    const u = out.json.usage ?? {}, prices = { "claude-sonnet-5-5": [2, 2.5, 0.2, 10], "claude-opus-5-5": [4, 5, 0.2, 20], ...(this.cfg.apiPrices ?? {}) }, price = prices[model];
    const cost = price ? costOf(u, price) : null, text = (out.json.content ?? []).filter(x => x.type === "text").map(x => x.text).join("");
    if (cost != null) this.spent += cost;
    /* the answer goes in as it came when it holds no JSON: the module refuses it in words, and its own count of tries decides what comes next */
    const plan = planOf(text) ?? text;
    const meta = { by: "api", generation: this.generation, model, usage: { in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), out: u.output_tokens ?? 0, seconds: out.seconds, cost } };
    try { await this.foundry.eval(apiSpendIn, { combatId: ev.combatId, use: { model, cost, in: meta.usage.in, out: meta.usage.out, seconds: out.seconds, requestId: ev.requestId } }); } catch (e) { this.log("api", `couldn't keep the cost on the fight: ${e.message}`); }
    let res;
    try { res = await this.foundry.eval(apiSubmitIn, { combatId: ev.combatId, requestId: ev.requestId, plan, meta, handOff: null }, { timeout: 120000 }); }
    catch (e) { const m = String(e?.message ?? e).replace(/^page\.evaluate:\s*/, "").replace(/^Error:\s*/, "").split("\n")[0]; this.log("api", `couldn't hand the plan in: ${m}`); res = { error: m }; }   /* the page's own words, not the browser's stack */
    /* the plan landed, or was refused with a try left (a retry event follows), or the module ignored it on purpose (another thinker has the turn,
       or the route changed): nothing more. Anything else leaves the turn waiting with nobody on it, so it is handed on (review 2). */
    const landed = ["ready", "running", "done", "manual", "chosen", "looked", "submitted", "held", "stopped", "saves"].includes(res?.state) || (res?.state === "requested" && Number.isFinite(res?.triesLeft)) || res?.ignored;
    if (!landed) await this.handOff(ev, `the API's answer couldn't be handed in (${String(res?.error ?? res?.reason ?? "no answer").slice(0, 120)})`);
    this.audit({ tool: "api-worker", args: { requestId: ev.requestId, kind: ev.kind, model }, ok: !res?.error, ms: Date.now() - t0, seconds: out.seconds, cost, state: res?.state ?? null, ...(res?.error ? { error: res.error } : {}) });
    this.log("api", `${ev.monster ?? "a monster"} (${ev.kind}, ${model}): ${res?.state ?? "?"}${res?.reason ? ` (${String(res.reason).slice(0, 120)})` : ""}, ${out.seconds.toFixed(1)} s${cost != null ? `, $${cost.toFixed(4)}` : ""}`);
  }
  async handOff(ev, why) {
    try { await this.foundry.eval(apiSubmitIn, { combatId: ev.combatId, requestId: ev.requestId, plan: null, meta: { by: "api", generation: this.generation }, handOff: why }); }
    catch (e) { this.log("api", `couldn't hand the turn on: ${e.message}`); }
  }

  /** Run `fn` with the module's API light renewed every 30 s meanwhile (review 1): a long answer must not look like a thinker gone away. */
  async whileThinking(fn) {
    const t = setInterval(() => { this.foundry.eval(apiAliveIn, { generation: this.generation }).catch(() => {}); }, 30000);
    try { return await fn(); } finally { clearInterval(t); }
  }
  /** One call to the Messages API, the module's prompt as a cached system prompt. Three tries in all for a busy or failing API, each counted
      against the hourly cap and given apiTimeoutS seconds. Redirects are refused, so the key never goes to another address (review 11). */
  async call(model, content) {
    const url = this.cfg.apiUrl || "https://api.anthropic.com/v1/messages", maxTokens = Math.max(500, Number(this.cfg.apiMaxTokens) || 4000);
    const body = JSON.stringify({ model, max_tokens: maxTokens, system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content }] });
    for (let attempt = 0; ; attempt++) {
      const limit = Math.max(10, Number(this.cfg.apiTimeoutS) || 60), t0 = Date.now(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), limit * 1000);
      let res, json; this.calls.push(Date.now());
      try { res = await fetch(url, { method: "POST", redirect: "error", signal: ctl.signal, headers: { "x-api-key": this.key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body }); json = await res.json().catch(() => ({})); }
      catch (e) { clearTimeout(timer); if (attempt < 2) { await sleep(this.retryMs * (attempt + 1)); continue; } const err = new Error(ctl.signal.aborted ? `no answer within ${limit} seconds` : String(e?.cause?.code ?? e?.message ?? e)); err.status = 0; throw err; }
      clearTimeout(timer);
      if (res.ok) return { seconds: (Date.now() - t0) / 1000, json };
      const msg = json?.error?.message ?? res.statusText ?? "";
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(this.retryMs * (attempt + 1)); continue; }
      const err = new Error(`The API answered ${res.status}`); err.status = res.status; err.apiMessage = msg; throw err;
    }
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
