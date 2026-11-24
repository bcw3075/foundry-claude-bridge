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
/* Encounter Builder 0.42.0's room pick (0.4.3): a Preview on a map with rooms asks which room the creatures start in; answered with {"room", "why"} */
const ROOM_ASK = 'A game master is previewing an encounter. Below is the ask: the brief and the rooms. The picture shows the map with each room numbered. Answer with the JSON alone.';
/* Encounter Builder 0.43.0's Ask Angel (0.4.4): the Build window's chat box. The module gives the prompt, the text and its tools (reads on the runner's
   page); the worker adds two Notion tools when the owner has put a read-only "notionApiKey" in config.json, and answers each tool call until the model
   gives its JSON (at most apiAskRounds calls) */
export const NOTION_TOOLS = [
  { name: "notion_search", description: "Search the campaign's Notion pages (only the pages the GM shared with this read-only key) by words in their titles. Returns up to 10: id, title, url, when it was last edited.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "notion_page", description: "Read one Notion page by its id from notion_search, as text (its blocks, and one level of blocks inside them; cut at 12000 characters).", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }
];
const NOTION_VERSION = "2022-06-28";

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
function roomPendingIn({ skip }) { const r = game.modules.get("lythara-encounter-builder")?.api?.room; return typeof r?.pending === "function" ? r.pending(skip) : null; }
async function roomShowIn({ sceneId }) { const r = game.modules.get("lythara-encounter-builder")?.api?.room; return typeof r?.show === "function" ? r.show(sceneId) : false; }
async function roomAnswerIn({ sceneId, seq, answer, meta }) { const r = game.modules.get("lythara-encounter-builder")?.api?.room; if (typeof r?.answer !== "function") throw new Error("Encounter Builder can't take a room pick."); return r.answer(sceneId, seq, answer, meta); }
async function askPendingIn({ skip }) { const a = game.modules.get("lythara-encounter-builder")?.api?.ask; return typeof a?.pending === "function" ? a.pending(skip) : null; }
async function askToolIn({ sceneId, name, input }) { const a = game.modules.get("lythara-encounter-builder")?.api?.ask; if (typeof a?.tool !== "function") return { error: "Encounter Builder has no Ask Angel tools." }; return a.tool(sceneId, name, input); }
async function askAnswerIn({ sceneId, seq, answer, meta }) { const a = game.modules.get("lythara-encounter-builder")?.api?.ask; if (typeof a?.answer !== "function") throw new Error("Encounter Builder can't take an Ask Angel answer."); return a.answer(sceneId, seq, answer, meta); }
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
/** The tools sent with an ask: the module's (each a name, a description and an object schema), then Notion's when there is a key. */
export function askTools(moduleTools, notion) {
  const own = (Array.isArray(moduleTools) ? moduleTools : []).filter(t => t && /^[a-z_]{1,40}$/.test(t.name ?? "") && !/^notion_/.test(t.name) && typeof t.description === "string" && t.input_schema?.type === "object").slice(0, 12)
    .map(t => ({ name: t.name, description: t.description.slice(0, 1000), input_schema: t.input_schema }));
  return notion ? [...own, ...NOTION_TOOLS] : own;
}
/** A Notion rich-text list as plain text. */
const richText = list => (Array.isArray(list) ? list : []).map(r => r?.plain_text ?? "").join("");
/** A Notion page's title from a search result. */
export function notionTitle(o) { const props = o?.properties ?? {}; for (const v of Object.values(props)) if (v?.type === "title") return richText(v.title); return richText(o?.title) || "(untitled)"; }
/** One Notion block as a line of text ("" for blocks with no text). */
export function notionLine(b) {
  const t = b?.type, v = b?.[t] ?? {}, text = richText(v.rich_text);
  if (t === "child_page" || t === "child_database") return `[page: ${v.title ?? ""}] (id ${b.id})`;
  if (/^heading_/.test(t)) return `${"#".repeat(Number(t.slice(-1)) || 1)} ${text}`;
  if (t === "bulleted_list_item" || t === "numbered_list_item") return `- ${text}`;
  if (t === "to_do") return `[${v.checked ? "x" : " "}] ${text}`;
  if (t === "table_row") return (v.cells ?? []).map(richText).join(" | ");
  return text;
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
    this.calls = []; this.seen = new Set(); this.spent = 0; this.joined = null; this.wakeJoin = null; this.roomSeen = new Set(); this.roomBusy = false; this.askSeen = new Set(); this.askBusy = false;
    this.notion = typeof cfg.notionApiKey === "string" && cfg.notionApiKey.trim() ? cfg.notionApiKey.trim() : null;   /* read-only, the owner's; never logged, audited or sent anywhere but Notion */
    this.retryMs = Math.max(0, Number(cfg.apiRetryMs ?? 5000));
  }
  get on() { return !!this.key; }
  status() { return { key: !!this.key, notion: !!this.notion, listening: this.running, stopped: this.stopped, callsLastHour: this.recent(), spent: Math.round(this.spent * 1000) / 1000 }; }
  start() { if (this.timer) return; this.timer = setInterval(() => { this.tick().catch(e => this.log("api", `look failed: ${e.message}`)); }, Math.max(1, Number(this.cfg.apiPollS) || 5) * 1000); }
  stop() { clearInterval(this.timer); this.timer = null; }
  recent() { const hour = Date.now() - 3600000; this.calls = this.calls.filter(t => t > hour); return this.calls.length; }

  /** Every few seconds: is a fight on the API route, or has Wake Angel been pressed? Reads only. */
  async tick() {
    if (this.running || this.foundry.state !== "ready") return;
    const w = await this.foundry.eval(apiWantedIn);
    if (!w?.module || !w.ok) return;
    this.roomTick().catch(e => this.log("api", `room pick failed: ${e.message}`));
    this.askTick().catch(e => this.log("api", `Ask Angel failed: ${e.message}`));
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
          this.generation = h.hello.generation; this.system = h.hello.prompt; this.cursor = 0; this.joined = this.foundry.since; this.seen = new Set();   /* a new generation answers what is still live afresh: the module offers the fight-start look again to a new generation under its old number (0.4.1) */
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
    const models = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-2", ...(this.cfg.apiModels ?? {}) }, model = models[ev.model] ?? models.sonnet;
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
    const u = out.json.usage ?? {}, prices = { "claude-sonnet-5-5": [2, 2.5, 0.1, 10], "claude-opus-5-5": [4, 5, 0.2, 20], "claude-fable-5-2": [8, 10, 0.2, 40], ...(this.cfg.apiPrices ?? {}) }, price = prices[model];
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

  /** A Preview's room ask (0.4.3, Encounter Builder 0.42.0): looked at on every poll, answered once, beside any fight. Not while stopped. */
  async roomTick() {
    if (this.roomBusy || !this.key || this.stopped) return;
    const ev = await this.foundry.eval(roomPendingIn, { skip: [...this.roomSeen] }); if (!ev?.sceneId || ev.seq == null) return;
    const k = `${ev.sceneId}|${ev.seq}`; if (this.roomSeen.has(k)) return;
    this.roomSeen.add(k); if (this.roomSeen.size > 200) this.roomSeen = new Set([...this.roomSeen].slice(-100));
    this.roomBusy = true; try { await this.handleRoom(ev); } finally { this.roomBusy = false; }
  }
  async handleRoom(ev) {
    const t0 = Date.now(), cap = Math.max(1, Number(this.cfg.apiMaxCallsPerHour) || 120), answer = (a, meta) => this.foundry.eval(roomAnswerIn, { sceneId: ev.sceneId, seq: ev.seq, answer: a, meta }, { timeout: 60000 });
    if (this.recent() >= cap) {
      const why = `${cap} calls in the last hour, the most allowed; press Wake Angel to go on`;
      this.stopped = why; this.log("api", `stopped: ${why}`); await this.note({ state: "capped", reason: why });
      return answer(null, { by: "api", failed: `the API route stopped: ${why}` }).catch(() => {});
    }
    const models = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-2", ...(this.cfg.apiModels ?? {}) }, model = models[ev.model] ?? models.sonnet;
    const content = [{ type: "text", text: `${ROOM_ASK}\n\n${JSON.stringify(ev.ask ?? {})}` }];
    /* the picture: the module draws it on this page; only an id selector is taken from the page */
    const sel = /^#[\w-]{1,80}$/.test(String(ev.picture ?? "")) ? ev.picture : null;
    if (sel) { try { if (await this.foundry.eval(roomShowIn, { sceneId: ev.sceneId }, { timeout: 60000 })) { const img = await look(this.foundry, { region: "element", selector: sel, maxWidth: 1400, quality: 70 }); content.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } }); } } catch (e) { this.log("api", `no map picture for the room pick: ${e.message}`); } }
    let out;
    try { out = await this.call(model, content, typeof ev.system === "string" && ev.system ? ev.system : null); }
    catch (e) {
      const why = failureWords(e.status, e.apiMessage ?? e.message);
      this.audit({ tool: "api-worker", args: { kind: "room", scene: ev.sceneId, model }, ok: false, error: why, ms: Date.now() - t0 });
      if (hardFailure(e.status, e.apiMessage ?? "")) { this.stopped = why; this.log("api", `stopped: ${why}`); await this.note({ state: "stopped", reason: why }); }
      return answer(null, { by: "api", model, failed: why }).catch(x => this.log("api", `couldn't tell the Preview: ${x.message}`));
    }
    const u = out.json.usage ?? {}, prices = { "claude-sonnet-5-5": [2, 2.5, 0.1, 10], "claude-opus-5-5": [4, 5, 0.2, 20], "claude-fable-5-2": [8, 10, 0.2, 40], ...(this.cfg.apiPrices ?? {}) }, price = prices[model];
    const cost = price ? costOf(u, price) : null, text = (out.json.content ?? []).filter(x => x.type === "text").map(x => x.text).join("");
    if (cost != null) this.spent += cost;
    let res; try { res = await answer(planOf(text) ?? text, { by: "api", model, cost, seconds: out.seconds }); } catch (e) { res = { error: String(e?.message ?? e).split("\n")[0] }; }
    this.audit({ tool: "api-worker", args: { kind: "room", scene: ev.sceneId, model }, ok: !res?.error, ms: Date.now() - t0, seconds: out.seconds, cost, state: res?.state ?? null, ...(res?.error ? { error: res.error } : {}) });
    this.log("api", `room pick (${model}): ${res?.state ?? "?"}${res?.room ? ` room ${res.room}` : ""}${res?.error ? ` (${String(res.error).slice(0, 120)})` : ""}, ${out.seconds.toFixed(1)} s${cost != null ? `, $${cost.toFixed(4)}` : ""}`);
  }

  /** An Ask Angel message from the Build window (0.4.4, Encounter Builder 0.43.0): looked at on every poll, answered once, beside any fight. */
  async askTick() {
    if (this.askBusy || !this.key) return;
    const ev = await this.foundry.eval(askPendingIn, { skip: [...this.askSeen] }, { timeout: 60000 }); if (!ev?.sceneId || ev.seq == null || typeof ev.text !== "string") return;
    const k = `${ev.sceneId}|${ev.seq}`; if (this.askSeen.has(k)) return;
    this.askSeen.add(k); if (this.askSeen.size > 200) this.askSeen = new Set([...this.askSeen].slice(-100));
    /* stopped (a refused key, the cap): the box is told why at once, rather than waiting out its time (review 8) */
    if (this.stopped) { await this.foundry.eval(askAnswerIn, { sceneId: ev.sceneId, seq: ev.seq, answer: null, meta: { by: "api", failed: `the API route is stopped: ${this.stopped}` } }, { timeout: 60000 }).catch(e => this.log("api", `couldn't tell the box: ${e.message}`)); return; }
    this.askBusy = true; try { await this.handleAsk(ev); } finally { this.askBusy = false; }
  }
  async handleAsk(ev) {
    const t0 = Date.now(), cap = Math.max(1, Number(this.cfg.apiMaxCallsPerHour) || 120), rounds = Math.max(1, Math.min(20, Number(this.cfg.apiAskRounds) || 8));
    const answer = (a, meta) => this.foundry.eval(askAnswerIn, { sceneId: ev.sceneId, seq: ev.seq, answer: a, meta }, { timeout: 60000 });
    const models = { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5", fable: "claude-fable-5-2", ...(this.cfg.apiModels ?? {}) }, model = models[ev.model] ?? models.sonnet;
    const prices = { "claude-sonnet-5-5": [2, 2.5, 0.1, 10], "claude-opus-5-5": [4, 5, 0.2, 20], "claude-fable-5-2": [8, 10, 0.2, 40], ...(this.cfg.apiPrices ?? {}) }, price = prices[model];
    const tools = askTools(ev.tools, !!this.notion), own = new Set(tools.filter(t => !/^notion_/.test(t.name)).map(t => t.name)), system = typeof ev.system === "string" && ev.system ? ev.system : null;
    const messages = [{ role: "user", content: [{ type: "text", text: ev.text }] }];
    let cost = price ? 0 : null, seconds = 0, used = 0, text = null, failed = null, toolCalls = 0;
    const done = async (a, meta) => { let res; try { res = await answer(a, meta); } catch (e) { res = { error: String(e?.message ?? e).split("\n")[0] }; }
      this.audit({ tool: "api-worker", args: { kind: "build", scene: ev.sceneId, model }, ok: !res?.error && !meta.failed, ms: Date.now() - t0, seconds, cost, calls: used, toolCalls, state: res?.state ?? null, ...(meta.failed ? { error: meta.failed } : res?.error ? { error: res.error } : {}) });
      this.log("api", `Ask Angel (${model}): ${res?.state ?? "?"}${meta.failed ? ` (${String(meta.failed).slice(0, 120)})` : ""}, ${used} call(s), ${toolCalls} tool call(s), ${seconds.toFixed(1)} s${cost != null ? `, $${cost.toFixed(4)}` : ""}`); };
    try { for (;;) {
      if (this.recent() >= cap) {
        const why = `${cap} calls in the last hour, the most allowed; press Wake Angel to go on`;
        this.stopped = why; this.log("api", `stopped: ${why}`); await this.note({ state: "capped", reason: why }).catch(() => {});
        failed = `the API route stopped: ${why}`; break;
      }
      let out;
      try { out = await this.call(model, null, system, { messages, tools, maxTokens: Math.max(8000, Number(this.cfg.apiMaxTokens) || 0), timeoutS: Math.max(120, Number(this.cfg.apiTimeoutS) || 0) }); }
      catch (e) { failed = failureWords(e.status, e.apiMessage ?? e.message); if (hardFailure(e.status, e.apiMessage ?? "")) { this.stopped = failed; this.log("api", `stopped: ${failed}`); await this.note({ state: "stopped", reason: failed }).catch(() => {}); } break; }
      used++; seconds += out.seconds; const u = out.json.usage ?? {}; if (price) { const c = costOf(u, price); cost += c; this.spent += c; }
      const content = Array.isArray(out.json.content) ? out.json.content : [], uses = content.filter(x => x.type === "tool_use");
      if (out.json.stop_reason !== "tool_use" || !uses.length) { text = content.filter(x => x.type === "text").map(x => x.text).join(""); break; }
      if (used >= rounds) { failed = `Angel used ${rounds} calls looking things up without answering; ask again more narrowly`; break; }
      messages.push({ role: "assistant", content });
      const results = [];
      for (const x of uses) { toolCalls++; let r;
        try { r = /^notion_/.test(x.name) && this.notion ? await this.notionTool(x.name, x.input ?? {}) : own.has(x.name) ? await this.foundry.eval(askToolIn, { sceneId: ev.sceneId, name: x.name, input: x.input ?? {} }, { timeout: 60000 }) : { error: `There is no tool called ${x.name}.` }; }
        catch (e) { r = { error: String(e?.message ?? e).replace(/^page\.evaluate:\s*/, "").split("\n")[0].slice(0, 200) }; }
        results.push({ type: "tool_result", tool_use_id: x.id, content: JSON.stringify(r ?? null).slice(0, 20000), ...(r?.error ? { is_error: true } : {}) }); }
      /* one cache mark at the newest turn, so each round reads the ones before it from the cache (the system prompt and tools have their own) */
      for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) delete b.cache_control;
      results[results.length - 1].cache_control = { type: "ephemeral" };
      messages.push({ role: "user", content: results });
    } } catch (e) { failed = `the worker failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 160)}`; }   /* the box always hears back (review 7) */
    const meta = { by: "api", model, cost: cost == null ? null : Math.round(cost * 10000) / 10000, seconds: Math.round(seconds * 10) / 10, calls: used, toolCalls };
    return failed ? done(null, { ...meta, failed }) : done(planOf(text) ?? text, meta);
  }
  /** A Notion tool (read only: search and reading blocks). Errors come back as { error } for the model to read. */
  async notionTool(name, input) {
    const base = String(this.cfg.notionUrl || "https://api.notion.com/v1").replace(/\/$/, ""), id = String(input?.id ?? "").replace(/[^0-9a-fA-F-]/g, "");
    const get = async (path, body = null) => {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
      try { const res = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", redirect: "error", signal: ctl.signal, headers: { authorization: `Bearer ${this.notion}`, "notion-version": NOTION_VERSION, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const json = await res.json().catch(() => ({})); if (!res.ok) { const e = new Error(res.status === 401 ? "Notion refused the key: check \"notionApiKey\" in the bridge's config.json" : res.status === 404 ? "Notion has no page by that id that this key may read (share the page with the integration)" : `Notion answered ${res.status}${json?.message ? ` (${String(json.message).slice(0, 120)})` : ""}`); throw e; }
        return json; } finally { clearTimeout(timer); }
    };
    try {
      if (name === "notion_search") {
        const q = String(input?.query ?? "").trim().slice(0, 200); if (!q) return { error: "Search with some words." };
        const j = await get("/search", { query: q, page_size: 10, filter: { property: "object", value: "page" } });   /* pages only: a database's blocks can't be read (review 10) */
        return { pages: (j.results ?? []).slice(0, 10).map(o => ({ id: o.id, title: notionTitle(o).slice(0, 200), url: o.url, edited: o.last_edited_time, kind: o.object })) };
      }
      if (name === "notion_page") {
        if (id.replace(/-/g, "").length !== 32) return { error: "That isn't a Notion page id: take one from notion_search." };
        const lines = [], until = Date.now() + 45000; let size = 0, fetches = 0;   /* 45 s for one page in all (review 10) */
        const walk = async (bid, depth) => { let cursor = null;
          do { if (++fetches > 40 || size > 12000 || Date.now() > until) return; const j = await get(`/blocks/${bid}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`);
            for (const b of j.results ?? []) { const l = notionLine(b); if (l) { const t = `${"  ".repeat(depth)}${l}`; lines.push(t); size += t.length + 1; } if (b.has_children && depth < 1 && !/^child_/.test(b.type) && size <= 12000) await walk(b.id, depth + 1); }
            cursor = j.has_more ? j.next_cursor : null; } while (cursor); };
        await walk(id, 0);
        const text = lines.join("\n"); return { id, text: text.length > 12000 ? `${text.slice(0, 12000)}… (cut)` : text || "(no text on this page)" };
      }
      return { error: `There is no tool called ${name}.` };
    } catch (e) { return { error: String(e?.name === "AbortError" ? "Notion didn't answer within 20 seconds" : e?.message ?? e).slice(0, 200) }; }
  }

  /** Run `fn` with the module's API light renewed every 30 s meanwhile (review 1): a long answer must not look like a thinker gone away. */
  async whileThinking(fn) {
    const t = setInterval(() => { this.foundry.eval(apiAliveIn, { generation: this.generation }).catch(() => {}); }, 30000);
    try { return await fn(); } finally { clearInterval(t); }
  }
  /** One call to the Messages API, the module's prompt as a cached system prompt. Three tries in all for a busy or failing API, each counted
      against the hourly cap and given apiTimeoutS seconds. Redirects are refused, so the key never goes to another address (review 11). */
  async call(model, content, system = null, { messages = null, tools = null, maxTokens: most = null, timeoutS = null } = {}) {
    const url = this.cfg.apiUrl || "https://api.anthropic.com/v1/messages", maxTokens = Math.max(500, most ?? (Number(this.cfg.apiMaxTokens) || 4000));
    const body = JSON.stringify({ model, max_tokens: maxTokens, system: [{ type: "text", text: system ?? this.system, cache_control: { type: "ephemeral" } }], messages: messages ?? [{ role: "user", content }], ...(tools?.length ? { tools } : {}) });
    for (let attempt = 0; ; attempt++) {
      const limit = Math.max(10, timeoutS ?? (Number(this.cfg.apiTimeoutS) || 60)), t0 = Date.now(), ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), limit * 1000);
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
