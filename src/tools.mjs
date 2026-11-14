/* The tools Claude gets. Each one runs a self-contained function inside the Foundry page.
   Reads are free; writes are the few the GM asked for; nothing here deletes documents. */
import { z } from "zod";
import * as ui from "./ui.mjs";

const json = v => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }] });
/* an image plus a short JSON note; the image is returned to the caller and never written anywhere */
const picture = (img, note) => ({ content: [{ type: "image", data: img.data, mimeType: img.mimeType }, { type: "text", text: JSON.stringify(note) }] });
const fail = msg => ({ isError: true, content: [{ type: "text", text: msg }] });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/* ---------- in-page helpers, duplicated in each function that needs them (functions must be self-contained) ---------- */

/** Is Encounter Builder running a monster turn? Uses its busy() when the module offers one, else reads the turn requests. */
function fightBusy() {
  const m = game.modules.get("lythara-encounter-builder");
  if (!m?.active || !m.api?.fight) return { busy: false, module: false };
  if (typeof m.api.fight.busy === "function") { const b = m.api.fight.busy(); return { busy: !!b, via: "busy()", detail: b || null }; }
  const combats = (game.combats?.contents ?? []).filter(c => c.started);
  for (const c of combats) {
    const r = typeof m.api.fight.current === "function" ? m.api.fight.current(c) : null;
    if (r && (r.state === "running" || r.state === "submitted" || r.go)) return { busy: true, via: "current()", combat: c.id, state: r.state, go: !!r.go };
  }
  return { busy: false, via: "current()" };
}

/** The running world and the account Encounter Builder calls the runner (null when the module is off). */
function worldAndRunner() {
  let runner = null;
  const m = game.modules.get("lythara-encounter-builder");
  if (m?.active) { try { runner = game.settings.get("lythara-encounter-builder", "runner") || null; } catch { runner = null; } }
  return { world: game.world.id, runner };
}

/** One wait in Encounter Builder's brain interface: the first event after the cursor, the hello for a new thinker, or idle. */
async function fightWaitOnce({ cursor, seconds, generation }) {
  const m = game.modules.get("lythara-encounter-builder");
  if (!m?.active || typeof m.api?.fight?.waitForEvent !== "function") throw new Error("Encounter Builder isn't active in this world (or is older than 0.3.8), so there are no monster turns to wait for.");
  if (!game.user.isGM) throw new Error("The bridge's account isn't a GM here.");
  return m.api.fight.waitForEvent(cursor, seconds, generation == null ? {} : { generation });
}

/** Hand a plan to Encounter Builder for a waiting monster turn, check one without writing, or give up on the turn. */
async function fightPlanOnce({ combatId, requestId, plan, generation, model, check, giveUp }) {
  const ID = "lythara-encounter-builder", m = game.modules.get(ID), f = m?.api?.fight;
  if (!m?.active || ["submitPlan", "checkPlan", "reportFailure"].some(k => typeof f?.[k] !== "function")) throw new Error("Encounter Builder isn't active in this world (or is older than 0.3.8), so there's no monster turn to plan.");
  if (!game.user.isGM) throw new Error("The bridge's account isn't a GM here.");
  /* the fight-start look (Encounter Builder 0.33.0) has its own request id, "look": it is the fight's, not a turn's */
  const has = c => requestId === "look" ? !!c.getFlag(ID, "turns")?.look : !!c.getFlag(ID, "turns")?.requests?.[requestId];
  /* with no combatId, the look of a started fight that still waits for one comes first (an older fight's look is done) */
  const found = () => requestId === "look" ? game.combats.find(c => c.started && c.getFlag(ID, "turns")?.look?.state === "asked") ?? game.combats.find(has) : game.combats.find(has);
  const combat = combatId ? game.combats.get(combatId) : found();
  if (!combat) throw new Error(combatId ? "There's no fight with that combatId." : "No fight has a turn with that requestId.");
  if (!has(combat)) throw new Error("That fight has no turn with that requestId.");
  const meta = { by: "chat", generation, ...(model ? { model } : {}) };
  if (giveUp) return { combatId: combat.id, ...(await f.reportFailure(combat, requestId, giveUp, meta)) };
  if (check) return { combatId: combat.id, checkOnly: true, ...(await f.checkPlan(combat, requestId, plan)) };
  return { combatId: combat.id, ...(await f.submitPlan(combat, requestId, plan, meta)) };
}

export function registerTools(server, foundry, cfg, audit, sessions = null, worker = null) {
  const tool = (name, def, run) => server.registerTool(name, def, async (args, extra) => {
    const t0 = Date.now();
    try {
      const out = await run(args ?? {}, extra);
      audit({ tool: name, args, ok: true, ms: Date.now() - t0 });
      return out;
    } catch (e) {
      const msg = String(e?.message ?? e);
      audit({ tool: name, args, ok: false, error: msg, ms: Date.now() - t0 });
      return fail(msg);
    }
  });

  /* ---------- status ---------- */
  tool("foundry_status", {
    title: "Foundry status",
    description: "Whether the bridge is connected to Foundry, which world and scene are active, who is online, and the module list.",
    inputSchema: {}, annotations: READ
  }, async () => {
    const s = foundry.status(), api = worker ? worker.status() : null;   /* the API worker (0.4.0): whether it has a key, listens, stopped and why, calls this hour */
    if (s.state !== "ready") return json({ connected: false, ...s, ...(api ? { api } : {}) });
    const info = await foundry.eval(() => ({
      world: game.world.title, worldId: game.world.id, core: game.version, system: `${game.system.id} ${game.system.version}`,
      user: game.user.name, role: game.user.role, paused: game.paused,
      activeScene: game.scenes.active?.name ?? null, viewedScene: canvas.scene?.name ?? null,
      online: game.users.filter(u => u.active).map(u => `${u.name}${u.isGM ? " (GM)" : ""}`),
      activeGM: game.users.activeGM?.name ?? null,
      worldTime: game.time.worldTime,
      modules: [...game.modules].filter(m => m.active).map(m => `${m.id} ${m.version}`)
    }));
    return json({ connected: true, since: s.since, ...info, ui: cfg.allowUi ? { enabled: true, worlds: cfg.uiWorlds, ...(sessions?.status() ?? {}) } : { enabled: false }, ...(api ? { api } : {}) });
  });

  /* ---------- chat ---------- */
  tool("chat_read", {
    title: "Read chat",
    description: "The most recent chat messages (newest last): who spoke, the text, roll totals, whisper targets.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20).describe("How many messages"), since: z.string().optional().describe("Only messages after this message id") },
    annotations: READ
  }, async ({ limit, since }) => json(await foundry.eval(({ limit, since }) => {
    let list = game.messages.contents;
    if (since) { const i = list.findIndex(m => m.id === since); if (i >= 0) list = list.slice(i + 1); }
    return list.slice(-limit).map(m => ({
      id: m.id, time: new Date(m.timestamp).toISOString(), user: m.author?.name ?? m.user?.name ?? null, speaker: m.speaker?.alias ?? null,
      whisperTo: (m.whisper ?? []).map(id => game.users.get(id)?.name ?? id), blind: !!m.blind,
      flavor: __bridge.text(m.flavor ?? ""), text: __bridge.text(m.content).slice(0, 2000),
      rolls: (m.rolls ?? []).map(r => ({ formula: r.formula, total: r.total }))
    }));
  }, { limit, since })));

  tool("chat_send", {
    title: "Send chat",
    description: "Post a chat message as the bridge user. mode: public (everyone), gm (GMs only), or whisper (named users). Plain text; line breaks kept.",
    inputSchema: {
      text: z.string().min(1).max(4000), mode: z.enum(["public", "gm", "whisper"]).default("public"),
      to: z.array(z.string()).optional().describe("User names for whisper"), alias: z.string().max(60).optional().describe("Speaker name shown, default the bridge user")
    }, annotations: WRITE
  }, async ({ text, mode, to, alias }) => json(await foundry.eval(async ({ text, mode, to, alias }) => {
    const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/\n/g, "<br>");
    const data = { content: esc(text), speaker: { alias: alias || game.user.name } };
    if (mode === "gm") ChatMessage.applyMode(data, "gm");
    else if (mode === "whisper") {
      const ids = (to ?? []).map(n => game.users.find(u => u.name === n)?.id).filter(Boolean);
      if (!ids.length) throw new Error("whisper needs at least one known user name");
      data.whisper = ids;
    }
    const m = await ChatMessage.create(data);
    return { id: m.id, mode };
  }, { text, mode, to, alias })));

  tool("roll", {
    title: "Roll dice",
    description: "Roll a dice formula (Foundry syntax, e.g. 1d20+5, 4d6kh3) and post it to chat. mode: public, gm, blind or self.",
    inputSchema: { formula: z.string().min(1).max(200), flavor: z.string().max(200).optional(), mode: z.enum(["public", "gm", "blind", "self"]).default("public") },
    annotations: WRITE
  }, async ({ formula, flavor, mode }) => json(await foundry.eval(async ({ formula, flavor, mode }) => {
    const r = await new Roll(formula).evaluate();
    await r.toMessage({ flavor: flavor ?? "", speaker: { alias: game.user.name } }, { messageMode: mode });
    return { formula: r.formula, total: r.total, dice: r.dice.map(d => ({ faces: d.faces, results: d.results.map(x => x.result) })) };
  }, { formula, flavor, mode })));

  /* ---------- actors ---------- */
  tool("actors_list", {
    title: "List actors",
    description: "Actors in the world: id, name, type, level, HP. Filter by type (character, npc, hazard, loot, party, vehicle) or a name fragment.",
    inputSchema: { type: z.string().optional(), name: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
    annotations: READ
  }, async (a) => json(await foundry.eval(({ type, name, limit }) => {
    const q = name?.toLowerCase();
    return game.actors.contents.filter(x => (!type || x.type === type) && (!q || x.name.toLowerCase().includes(q))).slice(0, limit)
      .map(x => ({ id: x.id, name: x.name, type: x.type, level: x.system?.details?.level?.value ?? null,
        hp: x.system?.attributes?.hp ? `${x.system.attributes.hp.value}/${x.system.attributes.hp.max}` : null, folder: x.folder?.name ?? null }));
  }, a)));

  tool("actor_get", {
    title: "Actor details",
    description: "One actor by id or exact name: level, HP, AC, saves, perception, speed, conditions, effects, and a short inventory and spell summary.",
    inputSchema: { id: z.string().optional(), name: z.string().optional() }, annotations: READ
  }, async ({ id, name }) => json(await foundry.eval(({ id, name }) => {
    const a = id ? game.actors.get(id) : game.actors.getName(name);
    if (!a) throw new Error("No such actor.");
    const s = a.system ?? {}, at = s.attributes ?? {};
    const items = a.items.contents;
    const kinds = t => items.filter(i => i.type === t);
    return {
      id: a.id, name: a.name, type: a.type, level: s.details?.level?.value ?? null,
      hp: at.hp ? { value: at.hp.value, max: at.hp.max, temp: at.hp.temp } : null, ac: at.ac?.value ?? null,
      saves: s.saves ? Object.fromEntries(Object.entries(s.saves).map(([k, v]) => [k, v.value ?? v.totalModifier ?? null])) : null,
      perception: s.perception?.value ?? s.perception?.mod ?? null, speed: at.speed?.value ?? null,
      heroPoints: s.resources?.heroPoints?.value ?? null, xp: s.details?.xp?.value ?? null,
      conditions: kinds("condition").map(c => c.name + (c.value ? ` ${c.value}` : "")),
      effects: kinds("effect").map(e => e.name),
      classes: kinds("class").map(c => c.name), ancestry: kinds("ancestry").map(c => c.name)[0] ?? null,
      weapons: kinds("weapon").slice(0, 12).map(w => w.name), armor: kinds("armor").map(w => w.name),
      consumables: kinds("consumable").slice(0, 20).map(c => `${c.name}${c.quantity > 1 ? " ×" + c.quantity : ""}`),
      spells: kinds("spell").slice(0, 40).map(sp => `${sp.name} (${sp.system?.level?.value ?? sp.level ?? "?"})`),
      feats: kinds("feat").slice(0, 40).map(f => f.name),
      strikes: (s.actions ?? []).slice(0, 8).map(x => ({ name: x.label, bonus: x.totalModifier ?? null }))
    };
  }, { id, name })));

  /* ---------- scenes and tokens ---------- */
  tool("scenes_list", {
    title: "List scenes",
    description: "Scenes with id, name, whether active, and token count.", inputSchema: {}, annotations: READ
  }, async () => json(await foundry.eval(() => game.scenes.contents.map(s => ({ id: s.id, name: s.name, active: s.active, navigation: s.navigation, tokens: s.tokens.size, size: `${s.width}×${s.height}` })))));

  tool("scene_activate", {
    title: "Activate scene",
    description: "Make a scene the active one (players are moved to it).", inputSchema: { id: z.string() }, annotations: WRITE
  }, async ({ id }) => json(await foundry.eval(async ({ id }) => { const s = game.scenes.get(id); if (!s) throw new Error("No such scene."); await s.activate(); return { active: s.name }; }, { id })));

  tool("scene_view", {
    title: "View scene (bridge client)",
    description: "Point the bridge's own client at a scene without changing what players see. Needed before canvas-based tools (fog, map module) on that scene.",
    inputSchema: { id: z.string() }, annotations: WRITE
  }, async ({ id }) => json(await foundry.eval(async ({ id }) => { const s = game.scenes.get(id); if (!s) throw new Error("No such scene."); await s.view(); await new Promise(r => setTimeout(r, 1500)); return { viewing: canvas.scene?.name }; }, { id }, { timeout: 120000 })));

  tool("tokens_list", {
    title: "List tokens",
    description: "Tokens on a scene (default: the active scene): id, name, position, hidden, HP, actor id.",
    inputSchema: { sceneId: z.string().optional() }, annotations: READ
  }, async ({ sceneId }) => json(await foundry.eval(({ sceneId }) => {
    const s = sceneId ? game.scenes.get(sceneId) : game.scenes.active; if (!s) throw new Error("No such scene.");
    return { scene: s.name, grid: s.grid.size, tokens: s.tokens.contents.map(t => ({ id: t.id, name: t.name, x: t.x, y: t.y, hidden: t.hidden, actorId: t.actorId,
      hp: t.actor?.system?.attributes?.hp ? `${t.actor.system.attributes.hp.value}/${t.actor.system.attributes.hp.max}` : null, disposition: t.disposition })) };
  }, { sceneId })));

  tool("token_move", {
    title: "Move token",
    description: "Move a token to scene coordinates (top-left of the token, in pixels). Walls stop the move as they would for a player.",
    inputSchema: { sceneId: z.string().optional(), id: z.string(), x: z.number(), y: z.number(), animate: z.boolean().default(true) }, annotations: WRITE
  }, async (a) => json(await foundry.eval(async ({ sceneId, id, x, y, animate }) => {
    const s = sceneId ? game.scenes.get(sceneId) : game.scenes.active; const t = s?.tokens.get(id); if (!t) throw new Error("No such token.");
    await t.update({ x, y }, { animate }); await new Promise(r => setTimeout(r, animate ? 1500 : 200));
    const now = s.tokens.get(id); return { id, x: now.x, y: now.y, arrived: now.x === x && now.y === y };
  }, a, { timeout: 30000 })));

  /* ---------- combat ---------- */
  tool("combat_get", {
    title: "Combat state",
    description: "The active encounter: round, whose turn, and each combatant's initiative, HP and conditions.", inputSchema: {}, annotations: READ
  }, async () => json(await foundry.eval(() => {
    const c = game.combat; if (!c) return { active: false };
    return { active: true, started: c.started, round: c.round, turn: c.turn, current: c.combatant?.name ?? null,
      combatants: c.turns.map(x => ({ id: x.id, name: x.name, initiative: x.initiative, defeated: x.defeated, hidden: x.hidden,
        hp: x.actor?.system?.attributes?.hp ? `${x.actor.system.attributes.hp.value}/${x.actor.system.attributes.hp.max}` : null,
        conditions: (x.actor?.itemTypes?.condition ?? []).map(k => k.name + (k.value ? " " + k.value : "")) })) };
  })));

  /* ---------- journals ---------- */
  tool("journal_search", {
    title: "Search journals",
    description: "Journal entries whose name or page text contains the query. Returns ids and page names.",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(50).default(20) }, annotations: READ
  }, async ({ query, limit }) => json(await foundry.eval(({ query, limit }) => {
    const q = query.toLowerCase(), out = [];
    for (const j of game.journal.contents) {
      const pages = j.pages.contents.filter(p => p.name.toLowerCase().includes(q) || (p.type === "text" && __bridge.text(p.text?.content ?? "").toLowerCase().includes(q)));
      if (j.name.toLowerCase().includes(q) || pages.length) out.push({ id: j.id, name: j.name, folder: j.folder?.name ?? null, pages: (pages.length ? pages : j.pages.contents).map(p => ({ id: p.id, name: p.name, type: p.type })) });
      if (out.length >= limit) break;
    }
    return out;
  }, { query, limit })));

  tool("journal_get", {
    title: "Read a journal page",
    description: "Text of a journal entry (all text pages, or one page by id), as plain text. GM-only secret sections are included and marked.",
    inputSchema: { id: z.string(), pageId: z.string().optional(), maxChars: z.number().int().min(500).max(40000).default(12000) }, annotations: READ
  }, async ({ id, pageId, maxChars }) => json(await foundry.eval(({ id, pageId, maxChars }) => {
    const j = game.journal.get(id); if (!j) throw new Error("No such journal.");
    const pages = pageId ? [j.pages.get(pageId)].filter(Boolean) : j.pages.contents;
    let text = "";
    for (const p of pages) {
      if (p.type !== "text") { text += `\n## ${p.name} (${p.type})\n`; continue; }
      const html = (p.text?.content ?? "").replace(/<section class="secret"[^>]*>/g, "\n[GM secret]\n").replace(/<\/section>/g, "\n[end secret]\n");
      text += `\n## ${p.name}\n${__bridge.text(html)}\n`;
    }
    return { id: j.id, name: j.name, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }, { id, pageId, maxChars })));

  /* ---------- the map module (Lythara Survey Sheet) ---------- */
  const mapApi = `const api = game.modules.get("lythara-survey-sheet")?.api; if (!api) throw new Error("The Lythara Survey Sheet module isn't active in this world.");`;

  tool("map_sheet_create", {
    title: "Make a map sheet",
    description: "Lythara Survey Sheet: make a detailed scene from World Map hexes [{i,j}] (row, column). Runs as a job; poll job_status.",
    inputSchema: { hexes: z.array(z.object({ i: z.number().int(), j: z.number().int() })).min(1).max(12), name: z.string().max(80).optional(), margin: z.number().min(0).max(6).optional() }, annotations: WRITE
  }, async (a) => json(await foundry.eval(new Function("a", `${mapApi} return { job: __bridge.startJob("map_sheet_create", api.createSheet(a)) };`), a)));

  tool("map_sheet_render", {
    title: "Redraw a map sheet",
    description: "Lythara Survey Sheet: redraw a sheet scene's map (force to redraw even if unchanged). Runs as a job; poll job_status.",
    inputSchema: { sceneId: z.string(), force: z.boolean().default(false) }, annotations: WRITE
  }, async ({ sceneId, force }) => json(await foundry.eval(new Function("a", `${mapApi} const s = game.scenes.get(a.sceneId); if (!s) throw new Error("No such scene."); return { job: __bridge.startJob("map_sheet_render", api.renderSheet(s, { force: a.force })) };`), { sceneId, force })));

  tool("map_exploration_sync", {
    title: "Carry exploration",
    description: "Lythara Survey Sheet: read what the players have explored on every sheet and reveal it on all sheets and the World Map. Runs as a job.",
    inputSchema: {}, annotations: WRITE
  }, async () => json(await foundry.eval(new Function(`${mapApi} return { job: __bridge.startJob("map_exploration_sync", api.syncExploration()), exploredSqMi: api.exploredArea() };`))));

  tool("map_sheet_export", {
    title: "Export a map sheet",
    description: "Lythara Survey Sheet: the sheet's frame, hexes, survey slice, pins, lines, paint and fingerprint, for the Survey Sheet artifact.",
    inputSchema: { sceneId: z.string() }, annotations: READ
  }, async ({ sceneId }) => json(await foundry.eval(new Function("a", `${mapApi} const s = game.scenes.get(a.sceneId); if (!s) throw new Error("No such scene."); return api.exportSheet(s);`), { sceneId })));

  tool("map_sheet_apply", {
    title: "Apply map data",
    description: "Lythara Survey Sheet: apply {seed?, pins?, lines?, paint?} from the Survey Sheet artifact to the world and redraw affected sheets. Runs as a job.",
    inputSchema: { data: z.record(z.any()), sceneId: z.string().optional().describe("Only this sheet; default all sheets") }, annotations: WRITE
  }, async ({ data, sceneId }) => json(await foundry.eval(new Function("a", `${mapApi} const s = a.sceneId ? game.scenes.get(a.sceneId) : undefined; return { job: __bridge.startJob("map_sheet_apply", api.applySheet(a.data, s)) };`), { data, sceneId })));

  /* ---------- which hidden page a call acts on ---------- */
  const TARGET = z.enum(["bridge", "gm", "player", "runner"]);
  const targetDoc = "bridge = the bridge's own page (default); gm / player = a started test session; runner = whichever page Encounter Builder's runner setting names.";
  /** The client (bridge or session) for a target name. */
  const clientFor = async (target = "bridge") => {
    if (target === "bridge") { if (foundry.state !== "ready") throw new Error(`Foundry isn't connected (${foundry.state}${foundry.lastError ? ": " + foundry.lastError : ""}).`); return foundry; }
    if (!cfg.allowUi || !sessions) throw new Error("Test sessions are off: set \"allowUi\": true in config.json and restart the bridge.");
    if (target === "runner") {
      const { runner } = await foundry.eval(worldAndRunner);
      const name = runner ?? cfg.foundryUser;
      if (name === cfg.foundryUser) return foundry;
      const key = Object.keys(cfg.uiAccounts).find(k => cfg.uiAccounts[k] === name);
      if (!key) throw new Error(`The runner is "${name}", which is neither the bridge's account nor a session account.`);
      return sessions.get(key);
    }
    return sessions.get(target);
  };

  tool("job_status", {
    title: "Job status",
    description: "Result of a long-running job started by another tool (map sheets, exploration, a background script).",
    inputSchema: { job: z.string(), target: TARGET.default("bridge").describe("The page the job was started on") }, annotations: READ
  }, async ({ job, target }) => json(await (await clientFor(target)).eval(({ job }) => {
    const j = __bridge.jobs[job]; if (!j) throw new Error("Unknown job.");
    const out = { id: j.id, name: j.name, done: j.done, seconds: Math.round((Date.now() - j.started) / 1000) };
    if (j.done) { if (j.error) out.error = j.error; else out.result = JSON.parse(JSON.stringify(j.result ?? null, (k, v) => (typeof v === "string" && v.length > 4000) ? v.slice(0, 4000) + "…" : v)); }
    return out;
  }, { job })));

  /* ---------- monster turns: Encounter Builder's brain interface, so a chat can think for the monsters ---------- */
  tool("fight_wait", {
    title: "Wait for a monster turn",
    description: "Encounter Builder: wait until a monster ticked for Angel needs a plan (a new turn, a retry after a refused plan, or a re-plan), a choice, or the fight-start look, and return the event with its packet. First call: leave out generation and get the hello (your generation, the plan and packet schemas, and the instructions for thinking for a monster); pass that generation on every later call, and pass back the cursor each answer gives you, so a dropped call loses nothing. Answers { idle: true } if nothing came within maxSeconds, { superseded: true } if a newer chat took over. Each wait keeps the 'Angel is listening' light on.",
    inputSchema: {
      cursor: z.number().int().min(0).default(0).describe("The cursor from the last answer; 0 the first time"),
      generation: z.number().int().min(1).nullish().describe("From the hello; leave out only on the first call, which makes you the thinker and retires any older chat"),
      maxSeconds: z.number().int().min(0).max(200).default(180).describe("How long to hold if nothing is waiting; 0 just looks. At most 200: a client cuts a tool call off at about 230 s")
    }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ cursor, generation, maxSeconds }, extra) => {
    const t0 = Date.now(), end = t0 + maxSeconds * 1000, chunk = Math.max(1, Math.floor(Number(cfg.fightWaitChunkS)) || 60);
    for (let waits = 1; ; waits++) {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000)), seconds = generation == null ? 0 : Math.min(chunk, left);
      const r = await foundry.eval(fightWaitOnce, { cursor, seconds, generation: generation ?? null }, { timeout: (seconds + 30) * 1000 });
      /* chained waits stop at an answer that isn't idle, at the end of the time asked for, or when the caller has gone */
      if (!r?.idle || left <= seconds || extra?.signal?.aborted) return json({ ...r, waited: Math.round((Date.now() - t0) / 1000), waits });
    }
  });

  tool("fight_plan", {
    title: "Hand in a monster's plan",
    description: "Encounter Builder: hand in the plan for a waiting monster turn (the event's requestId), as the plan's JSON. The module checks it and answers ready (its steps, in words) or refused with a reason and the tries left; the GM's card shows it. check: true only asks whether it would be accepted and changes nothing. giveUp: a short reason instead of a plan puts \"Angel couldn't plan this turn\" on the GM's card. Plans from an older generation are ignored.",
    inputSchema: {
      requestId: z.string().regex(/^[A-Za-z0-9]{1,40}$/, "a requestId is letters and digits").describe("The event's requestId"),
      combatId: z.string().regex(/^[A-Za-z0-9]{1,40}$/, "a combatId is letters and digits").nullish().describe("The event's combatId; found from the requestId if left out"),
      generation: z.number().int().min(1).describe("Your generation, from the hello"),
      plan: z.union([z.object({}).passthrough(), z.string().max(7500)]).nullish().describe("The plan: { requestId, reason, steps: [...], suggestOpus }"),
      check: z.boolean().default(false).describe("Only check the plan; nothing is written"),
      giveUp: z.string().min(1).max(200).nullish().describe("Instead of a plan: why no plan can be made, for the GM"),
      model: z.string().max(60).nullish().describe("The model thinking, kept with the plan")
    }, annotations: { ...WRITE, destructiveHint: true }
  }, async ({ requestId, combatId, generation, plan, check, giveUp, model }) => {
    if ((plan == null) === (giveUp == null)) throw new Error("Send either a plan or giveUp, not both and not neither.");
    if (check && giveUp != null) throw new Error("check works only with a plan.");
    if (plan != null && JSON.stringify(plan).length > 7500) throw new Error("That plan is far too long to be a plan (over 7,500 characters).");
    /* with the bridge as the runner, the module checks the plan before answering, which can include opening the fight's map: allow for it */
    try { return json(await foundry.eval(fightPlanOnce, { combatId: combatId ?? null, requestId, plan: plan ?? null, generation, model: model ?? null, check, giveUp: giveUp ?? null }, { timeout: 120000 })); }
    catch (e) { if (/didn't answer within/.test(e?.message ?? "")) throw new Error(`${e.message} The plan may still have gone in: don't send it again; wait with fight_wait for the next event, and the GM's card shows where the turn stands.`); throw e; }
  });

  /* ---------- scripts: only when the owner allows it in config.json ---------- */
  if (cfg.allowScripts) tool("run_script", {
    title: "Run a script in Foundry",
    description: "Run JavaScript inside a Foundry client and return its JSON result. Enabled by the owner in config.json. Runs on the bridge's page unless target says otherwise; background: true returns a job id for job_status (same target) instead of waiting.",
    inputSchema: {
      code: z.string().min(1).max(20000).describe("An async function body; `game`, `canvas`, `ui` are available. Return a JSON-serialisable value."),
      target: TARGET.default("bridge").describe(targetDoc),
      background: z.boolean().default(false).describe("Start the script as a job and return at once; poll job_status with the same target")
    }, annotations: { ...WRITE, destructiveHint: true }
  }, async ({ code, target, background }) => {
    const c = await clientFor(target);
    if (background) return json(await c.eval(new Function("code", `return { job: __bridge.startJob("run_script", (new (Object.getPrototypeOf(async function(){}).constructor)(code))()) };`), code));
    return json(await c.eval(new Function("code", `return (new (Object.getPrototypeOf(async function(){}).constructor)(code))();`), code, { timeout: 120000 }));
  });

  /* ---------- hidden test sessions and real input: only when the owner allows it in config.json ---------- */
  if (cfg.allowUi && sessions) {
    /** Checks every UI call makes: the bridge is connected, the world is one the owner allowed, and, for input or a reload
        on the runner's page, that the caller forced it and no monster turn is busy. Returns the client to act on. */
    const guard = async ({ target = "gm", input = false, force = false, testingTurn = false }) => {
      if (foundry.state !== "ready") throw new Error(`Foundry isn't connected (${foundry.state}${foundry.lastError ? ": " + foundry.lastError : ""}), so the UI tools can't check the world or who is online.`);
      const { world, runner } = await foundry.eval(worldAndRunner);
      if (!cfg.uiWorlds.includes(world)) throw new Error(`The UI tools only work in ${cfg.uiWorlds.map(w => `"${w}"`).join(", ")} (uiWorlds in config.json); the running world is "${world}".`);
      const client = await clientFor(target);
      const runnerName = runner ?? cfg.foundryUser;
      const isRunner = client.name === runnerName;
      if (input && isRunner) {
        if (!force) throw new Error(`"${client.name}" is the runner's page (Encounter Builder runs monster turns there), so input and reloads there need force: true. That is only for clearing a stuck prompt or a stale page; test through the gm or player session instead.`);
        const busy = await foundry.eval(fightBusy);
        if (busy.busy && !testingTurn) throw new Error(`A monster turn is busy on the runner's page (${busy.via}${busy.state ? ", state " + busy.state : ""}${busy.go ? ", go" : ""}); input was refused. Pass testingTurn: true only when the call is testing that case.`);
      }
      return client;
    };
    const onlineName = name => foundry.eval(n => !!game.users.getName(n)?.active, name);

    tool("session", {
      title: "Test session",
      description: `Start or end a hidden sign-in as a test account, in its own browser (separate from the bridge's), with its own cookie. gm = "${cfg.uiAccounts.gm}", player = "${cfg.uiAccounts.player}". Refuses an account that is already logged in elsewhere. status lists both.`,
      inputSchema: {
        action: z.enum(["start", "stop", "status"]).default("status"), account: z.enum(["gm", "player"]).optional().describe("Which session; needed for start and stop"),
        force: z.boolean().default(false).describe("Needed to stop a session that is Encounter Builder's runner (that takes the runner offline)"), testingTurn: z.boolean().default(false)
      },
      annotations: WRITE
    }, async ({ action, account, force, testingTurn }) => {
      if (action === "status") return json(sessions.status());
      if (!account) throw new Error(`session ${action} needs account: gm or player`);
      if (action === "stop") {
        /* stopping the runner's own session is heavier than a reload there: same rule (force, and not while a turn is busy) */
        let warning;
        if (foundry.state === "ready" && sessions.sessions[account]?.state !== "stopped") {
          const { runner } = await foundry.eval(worldAndRunner);
          if (runner && runner === sessions.accountOf(account)) {
            await guard({ target: account, input: true, force, testingTurn });
            warning = `"${runner}" is Encounter Builder's runner: with this session stopped, monster turns have no page to run on until it is started again (or the runner setting is changed).`;
          }
        }
        const r = await sessions.stop(account);
        return json(warning ? { ...r, warning } : r);
      }
      await guard({ target: "bridge" });   /* connected, and the world is allowed */
      return json(await sessions.start(account, onlineName));
    });

    const LOC = {
      selector: z.string().max(300).optional().describe("CSS or Playwright selector"), button: z.string().max(120).optional().describe("A button by its visible name"),
      text: z.string().max(200).optional().describe("Visible text"), at: z.object({ x: z.number(), y: z.number() }).optional().describe("Page pixels"),
      scene: z.object({ x: z.number(), y: z.number() }).optional().describe("Scene coordinates on the canvas")
    };
    tool("ui_act", {
      title: "Real input",
      description: "A batch of real mouse and keyboard input on a hidden page: click, dblclick, rightclick, hover, drag (with `to`), type, fill, select, press, keydown, keyup (held keys), scroll, wait. Target a step by selector, button name, text, page pixels (at) or scene coordinates (scene). Stops at the first failing step and reports what opened or closed. On the runner's page it needs force: true and is refused while a monster turn is busy.",
      inputSchema: {
        target: TARGET.default("gm").describe(targetDoc),
        steps: z.array(z.object({
          do: z.enum(["click", "dblclick", "rightclick", "hover", "drag", "type", "fill", "select", "press", "keydown", "keyup", "scroll", "wait"]),
          ...LOC, to: z.object(LOC).optional().describe("Where a drag ends"),
          value: z.string().max(4000).optional().describe("Text for type/fill, option for select"), key: z.string().max(40).optional().describe("Key for press/keydown/keyup, e.g. Enter, Shift, Control+a"),
          modifiers: z.array(z.enum(["Shift", "Control", "Alt", "Meta"])).optional().describe("Keys held during a click or drag"),
          ms: z.number().int().min(0).max(10000).optional().describe("wait: how long"), dx: z.number().optional(), dy: z.number().optional().describe("scroll: wheel distance"),
          steps: z.number().int().min(2).max(60).optional().describe("drag: how many moves"), timeoutMs: z.number().int().min(100).max(30000).optional()
        })).min(1).max(20),
        force: z.boolean().default(false).describe("Required for input on the runner's page"), testingTurn: z.boolean().default(false).describe("With force: also act while a monster turn is busy. For testing that case, or for clearing a turn that has hung (which doesn't need a bridge restart)")
      }, annotations: WRITE
    }, async ({ target, steps, force, testingTurn }) => json(await ui.act(await guard({ target, input: true, force, testingTurn }), steps)));

    tool("ui_read", {
      title: "Read the screen",
      description: "What is on a hidden page as text: open windows and dialogs (framed ones; all: true adds the sidebar, hotbar and HUD) with their buttons, fields and text; notifications; selected and targeted tokens; scene, tool, combat, pause state.",
      inputSchema: { target: TARGET.default("gm").describe(targetDoc), maxChars: z.number().int().min(0).max(8000).default(1500).describe("Text per window"), windows: z.boolean().default(true), all: z.boolean().default(false).describe("Also list frameless UI parts (sidebar, hotbar, HUD), not only windows") },
      annotations: READ
    }, async ({ target, maxChars, windows, all }) => json(await ui.read(await guard({ target }), { maxChars, windows, all })));

    tool("ui_look", {
      title: "Screenshot",
      description: "A small JPEG of a hidden page: the whole screen, one window (by title), one element (by selector) or an area. Scaled to maxWidth. Returned to the caller, never stored.",
      inputSchema: {
        target: TARGET.default("gm").describe(targetDoc),
        region: z.union([z.enum(["screen", "window", "element"]), z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })]).default("screen"),
        title: z.string().max(120).optional().describe("region window: part of the window's title"), selector: z.string().max(300).optional().describe("region element"),
        maxWidth: z.number().int().min(100).max(1600).default(1000), quality: z.number().int().min(20).max(90).default(60)
      }, annotations: READ
    }, async ({ target, ...opts }) => { const img = await ui.look(await guard({ target }), opts); return picture(img, { target, width: img.width, height: img.height, bytes: img.bytes, clip: img.clip }); });

    tool("ui_wait", {
      title: "Wait for a change",
      description: "Wait on a hidden page for: a dialog, any window, a chat message, a scene change, a selector, a text, or any visible change on screen (for: screen; frames: true also returns the new frame). At most 90 s per call; returns what happened.",
      inputSchema: {
        target: TARGET.default("gm").describe(targetDoc), for: z.enum(["dialog", "window", "chat", "scene", "selector", "text", "screen"]),
        selector: z.string().max(300).optional(), text: z.string().max(200).optional(), since: z.string().optional().describe("chat: the last message id already seen"),
        maxSeconds: z.number().int().min(1).max(90).default(30), frames: z.boolean().default(false)
      }, annotations: READ
    }, async ({ target, ...opts }) => {
      const r = await ui.wait(await guard({ target }), opts);
      if (r.frame) { const { frame, ...rest } = r; return picture(frame, { ...rest, width: frame.width, height: frame.height }); }
      return json(r);
    });

    tool("client_tools", {
      title: "Client tools",
      description: "console: the page's last console messages and errors. reload: reload a hidden page (clearCache: true also clears the browser cache, for module files Foundry caches for hours). A reload of the runner's page needs force: true and is refused while a monster turn is busy.",
      inputSchema: {
        target: TARGET.default("gm").describe(targetDoc), action: z.enum(["console", "reload"]),
        errorsOnly: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50), clearCache: z.boolean().default(false),
        force: z.boolean().default(false), testingTurn: z.boolean().default(false)
      }, annotations: WRITE
    }, async ({ target, action, errorsOnly, limit, clearCache, force, testingTurn }) => {
      if (action === "console") {
        const c = await guard({ target });
        const list = errorsOnly ? c.console.filter(m => m.type === "error" || m.type === "pageerror") : c.console;
        return json({ target, user: c.name, messages: list.slice(-limit) });
      }
      const c = await guard({ target, input: true, force, testingTurn });
      return json({ target, user: c.name, ...(await c.reload({ clearCache })) });
    });
  }
}
