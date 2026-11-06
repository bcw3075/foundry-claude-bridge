/* End-to-end test: stub Foundry → bridge → OAuth handshake the way Claude does it → every tool through an MCP client. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startStub } from "./stub-foundry.mjs";
import { hashPassphrase } from "../src/auth.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8790, PUB = `http://127.0.0.1:${PORT}`, PASS = "open sesame 2026";
const dataDir = path.join(ROOT, "test", ".data"); fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true });
const cfgPath = path.join(ROOT, "config.json"), hadCfg = fs.existsSync(cfgPath), savedCfg = hadCfg ? fs.readFileSync(cfgPath) : null;
fs.writeFileSync(cfgPath, JSON.stringify({ publicUrl: PUB, port: PORT, foundryUrl: "http://127.0.0.1:30999", foundryUser: "Claude Bridge", passphrase: hashPassphrase(PASS), allowScripts: true, allowUi: true, headless: true, dataDir: "test/.data", evalTimeoutMs: 20000 }));

const results = []; const check = (name, ok, info = "") => { results.push([name, ok, info]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${info ? " — " + info : ""}`); };
const stub = await startStub(30999);
let bridge2 = null;
const bridge = spawn(process.execPath, ["src/server.mjs"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
let out = ""; bridge.stdout.on("data", d => { out += d; }); bridge.stderr.on("data", d => { out += d; });
const until = async (f, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await new Promise(r => setTimeout(r, 300)); } return false; };

try {
  check("bridge joins Foundry", await until(() => /joined "PF2 Test" as Claude Bridge/.test(out)), out.split("\n").slice(-2).join(" | "));

  /* ---- OAuth the way Claude does it ---- */
  const r401 = await fetch(PUB + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("unauthenticated /mcp is 401 with resource_metadata", r401.status === 401 && /resource_metadata=/.test(r401.headers.get("www-authenticate") ?? ""), r401.headers.get("www-authenticate"));
  const prm = await (await fetch(PUB + "/.well-known/oauth-protected-resource/mcp")).json().catch(() => null) ?? await (await fetch(PUB + "/.well-known/oauth-protected-resource")).json();
  check("protected resource metadata names /mcp", prm.resource === PUB + "/mcp", JSON.stringify(prm));
  const asm = await (await fetch(prm.authorization_servers[0].replace(/\/$/, "") + "/.well-known/oauth-authorization-server")).json();
  check("authorization server metadata has DCR + PKCE S256", !!asm.registration_endpoint && asm.code_challenge_methods_supported?.includes("S256"), JSON.stringify(asm).slice(0, 200));
  const reg = await (await fetch(asm.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) })).json();
  check("dynamic client registration", !!reg.client_id, reg.client_id);
  const verifier = crypto.randomBytes(32).toString("base64url"), challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authUrl = `${asm.authorization_endpoint}?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&resource=${encodeURIComponent(PUB + "/mcp")}&scope=foundry`;
  const consent = await (await fetch(authUrl)).text();
  const reqId = consent.match(/name="request" value="([^"]+)"/)?.[1];
  check("consent page shown", !!reqId && /Approve/.test(consent));
  const bad = await fetch(PUB + "/approve", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: reqId, passphrase: "nope", decision: "approve" }) });
  check("wrong passphrase is refused", bad.status === 200 && /wrong/.test(await bad.text()));
  const good = await fetch(PUB + "/approve", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: reqId, passphrase: PASS, decision: "approve" }) });
  const loc = new URL(good.headers.get("location") ?? "http://x/");
  const code = loc.searchParams.get("code");
  check("right passphrase redirects with code + state", good.status === 302 && !!code && loc.searchParams.get("state") === "xyz", loc.origin + loc.pathname);
  const tok = await (await fetch(asm.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", resource: PUB + "/mcp" }) })).json();
  check("token exchange", !!tok.access_token && !!tok.refresh_token, JSON.stringify(tok).slice(0, 80));
  const reuse = await (await fetch(asm.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback" }) })).json();
  check("code can't be used twice", !reuse.access_token, reuse.error);
  const ref = await (await fetch(asm.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id }) })).json();
  check("refresh rotates tokens", !!ref.access_token && ref.access_token !== tok.access_token && ref.refresh_token !== tok.refresh_token);
  const old = await fetch(PUB + "/mcp", { method: "POST", headers: { authorization: "Bearer " + tok.access_token, "content-type": "application/json" }, body: "{}" });
  check("old access token no longer works", old.status === 401, `status ${old.status}: ${(await old.text()).slice(0, 120)}`);

  /* ---- MCP client ---- */
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(PUB + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + ref.access_token } } }));
  const tools = (await client.listTools()).tools.map(t => t.name);
  check("tools listed", tools.length >= 18 && ["session", "ui_act", "ui_read", "ui_look", "ui_wait", "client_tools"].every(t => tools.includes(t)), tools.join(","));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const text = r.content?.[0]?.text ?? ""; return { ok: !r.isError, text, data: (() => { try { return JSON.parse(text); } catch { return text; } })() }; };

  let r = await call("foundry_status"); check("foundry_status", r.ok && r.data.connected && r.data.world === "PF2 Test", r.text.slice(0, 100));
  r = await call("chat_send", { text: "Hello from the bridge\nline two", mode: "public" }); check("chat_send public", r.ok && !!r.data.id, r.text);
  r = await call("chat_send", { text: "secret", mode: "whisper", to: ["Gamemaster"] }); check("chat_send whisper", r.ok, r.text);
  r = await call("chat_send", { text: "x", mode: "whisper", to: ["Nobody"] }); check("whisper to unknown user fails cleanly", !r.ok, r.text);
  r = await call("roll", { formula: "2d6+1", mode: "gm" }); check("roll", r.ok && r.data.total >= 3 && r.data.total <= 13, r.text);
  r = await call("chat_read", { limit: 5 }); check("chat_read", r.ok && r.data.length === 3 && r.data[0].text === "Hello from the bridge\nline two" && r.data[1].whisperTo[0] === "Gamemaster", r.text.slice(0, 200));
  r = await call("actors_list", { type: "character" }); check("actors_list", r.ok && r.data.length === 1 && r.data[0].hp === "8/8", r.text);
  r = await call("actor_get", { name: "Test Hero" }); check("actor_get", r.ok && r.data.conditions[0] === "Frightened 2" && r.data.ac === 16, r.text.slice(0, 160));
  r = await call("actor_get", { name: "Nobody" }); check("actor_get missing", !r.ok, r.text);
  r = await call("scenes_list"); check("scenes_list", r.ok && r.data.length === 2);
  r = await call("tokens_list"); check("tokens_list", r.ok && r.data.tokens[0].name === "Test Hero", r.text.slice(0, 120));
  r = await call("token_move", { id: "t1", x: 250, y: 400, animate: false }); check("token_move", r.ok && r.data.arrived, r.text);
  r = await call("scene_activate", { id: "s2" }); check("scene_activate", r.ok && r.data.active === "World Map");
  r = await call("scene_view", { id: "s1" }); check("scene_view", r.ok && r.data.viewing === "Village sheet");
  r = await call("combat_get"); check("combat_get", r.ok && r.data.round === 2 && r.data.combatants[0].conditions[0] === "Frightened 2", r.text.slice(0, 120));
  r = await call("journal_search", { query: "goblins" }); check("journal_search (page text)", r.ok && r.data[0]?.name === "Millbrook", r.text);
  r = await call("journal_get", { id: "j1" }); check("journal_get marks secrets", r.ok && /\[GM secret\]/.test(r.data.text) && /Millbrook/.test(r.data.text), r.text.slice(0, 160));
  r = await call("map_sheet_create", { hexes: [{ i: 100, j: 150 }], name: "Bridge test" }); const job = r.data.job; check("map_sheet_create starts a job", r.ok && !!job, r.text);
  await new Promise(x => setTimeout(x, 600));
  r = await call("job_status", { job }); check("job_status returns the result", r.ok && r.data.done && r.data.result?.name === "Bridge test", r.text);
  r = await call("map_exploration_sync"); check("map_exploration_sync", r.ok && r.data.exploredSqMi === 66.29, r.text);
  r = await call("map_sheet_export", { sceneId: "s1" }); check("map_sheet_export", r.ok && r.data.fingerprint === -356423167);
  r = await call("map_sheet_apply", { data: { paint: "" } }); check("map_sheet_apply", r.ok && !!r.data.job);
  r = await call("run_script", { code: "return game.world.title + ' ' + (await Promise.resolve(42))" }); check("run_script (allowed in test config)", r.ok && r.data === "PF2 Test 42", r.text);
  r = await call("job_status", { job: "nope" }); check("unknown job fails cleanly", !r.ok);

  /* ---- 0.2.0: hidden test sessions and real input ---- */
  const script = (code, target = "bridge", extra = {}) => call("run_script", { code, target, ...extra });
  const image = r => { const t = r.raw?.content?.find(c => c.type === "image"); return t ? Buffer.from(t.data, "base64") : null; };
  const jpegSize = buf => { let i = 2; while (i < buf.length) { if (buf[i] !== 0xff) return null; const m = buf[i + 1], len = buf.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }; i += 2 + len; } return null; };
  const callRaw = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); const text = r.content?.find(c => c.type === "text")?.text ?? ""; return { ok: !r.isError, text, raw: r, data: (() => { try { return JSON.parse(text); } catch { return text; } })() }; };

  r = await call("session", { action: "status" }); check("session status (nothing started)", r.ok && r.data.browser === false && r.data.sessions.every(x => x.state === "stopped"), r.text.slice(0, 160));
  r = await call("ui_read", { target: "gm" }); check("ui tool on a session that isn't started fails cleanly", !r.ok && /isn't started/.test(r.text), r.text);
  /* AI logs in elsewhere (a browser tab): the session must refuse */
  await fetch("http://127.0.0.1:30999/join", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "userId=u4", redirect: "manual" });
  await new Promise(x => setTimeout(x, 1200));
  r = await call("session", { action: "start", account: "gm" }); check("session refuses an account that is online elsewhere", !r.ok && /already logged in/.test(r.text), r.text);
  await fetch("http://127.0.0.1:30999/stub/logout?user=u4", { method: "POST" });
  await new Promise(x => setTimeout(x, 1200));
  r = await call("session", { action: "start", account: "gm" }); check("session start gm (AI) in a second browser", r.ok && r.data.started && r.data.user === "AI" && r.data.state === "ready", r.text.slice(0, 160));
  r = await call("session", { action: "start", account: "gm" }); check("session start twice is harmless", r.ok && r.data.started === false, r.text.slice(0, 120));
  r = await script("return { user: game.user.name, bridge: typeof __bridge.text }", "gm"); check("run_script on the gm session", r.ok && r.data.user === "AI" && r.data.bridge === "function", r.text);
  r = await call("foundry_status"); check("foundry_status shows the session browser", r.ok && r.data.ui?.enabled && r.data.ui.browser === true && r.data.ui.sessions.find(x => x.key === "gm")?.state === "ready", JSON.stringify(r.data.ui).slice(0, 200));

  /* real input: buttons, modifiers, fields, canvas by scene coordinates, drag, keys */
  r = await call("ui_act", { target: "gm", steps: [
    { do: "click", button: "Count" }, { do: "click", selector: "#count", modifiers: ["Shift"] },
    { do: "fill", selector: "#name", value: "Hello" }, { do: "select", selector: "#pick", value: "b" },
    { do: "click", scene: { x: 400, y: 300 } }, { do: "dblclick", scene: { x: 400, y: 300 } },
    { do: "drag", scene: { x: 100, y: 100 }, to: { scene: { x: 300, y: 200 } } },
    { do: "press", key: "Escape" }, { do: "keydown", key: "Shift" }, { do: "click", at: { x: 200, y: 200 } }, { do: "keyup", key: "Shift" }, { do: "wait", ms: 100 }
  ] });
  check("ui_act runs a 12-step batch", r.ok && r.data.ok && r.data.steps.length === 12 && r.data.steps.every(x => x.ok), r.text.slice(0, 300));
  r = await script("return { s: window.__stub, name: document.getElementById('name').value, pick: document.getElementById('pick').value }", "gm");
  const st = r.data.s ?? {};
  check("buttons: two real clicks, the second with Shift", st.count === 2 && st.lastCountClick?.shift === true && st.lastCountClick?.trusted === true, JSON.stringify(st.lastCountClick) + " count " + st.count);
  check("fill and select", r.data.name === "Hello" && r.data.pick === "b", `${r.data.name} ${r.data.pick}`);
  const near = (p, x, y) => p && Math.abs(p.x - x) <= 3 && Math.abs(p.y - y) <= 3;
  check("canvas click lands at the scene coordinates, trusted", near(st.clicks?.[0], 400, 300) && st.clicks[0].trusted === true, JSON.stringify(st.clicks?.[0]));
  check("double-click registers", st.dbl >= 1, `dbl ${st.dbl}`);
  check("drag from scene (100,100) to (300,200) with several moves", near(st.drags?.[0]?.from, 100, 100) && near(st.drags?.[0]?.to, 300, 200) && st.drags[0].moves >= 6, JSON.stringify(st.drags?.[0]));
  check("press and held keys reach the page", st.keys?.includes("Escape") && st.keys?.includes("Shift") && st.clicks?.at(-1)?.shift === true, JSON.stringify(st.keys) + " " + JSON.stringify(st.clicks?.at(-1)));
  r = await call("ui_act", { target: "gm", steps: [{ do: "click", button: "Nope" , timeoutMs: 800 }, { do: "click", button: "Count" }] });
  check("a failing step stops the batch and is reported", r.ok && r.data.ok === false && r.data.failed === 0 && r.data.steps[1].skipped, r.text.slice(0, 200));

  /* dialogs: what opened, read it, answer it */
  r = await call("ui_act", { target: "gm", steps: [{ do: "click", button: "Open Dialog" }] });
  check("ui_act reports the window a click opened", r.ok && r.data.opened?.[0]?.title === "Confirm" && r.data.opened[0].dialog === true && r.data.notifications?.[0]?.text === "Dialog opened", r.text.slice(0, 300));
  r = await call("ui_read", { target: "gm" });
  const w = r.data.windows?.[0];
  check("ui_read: dialog with buttons, fields, text, state", r.ok && w?.title === "Confirm" && w.dialog && w.buttons.map(b => b.text).join() === "Yes,No" && w.fields[0]?.name === "note" && /Are you sure/.test(w.text) && r.data.user === "AI" && r.data.scene === "Village sheet" && r.data.tool === "select", r.text.slice(0, 300));
  r = await callRaw("ui_look", { target: "gm", region: "window", title: "confirm", maxWidth: 200 });
  let img = image(r), size = img && jpegSize(img);
  check("ui_look: a window as a JPEG scaled to maxWidth", r.ok && img?.[0] === 0xff && img[1] === 0xd8 && size?.width === 200 && r.data.width === 200, `${r.text.slice(0, 120)} jpeg ${JSON.stringify(size)}`);
  r = await callRaw("ui_look", { target: "gm", region: { x: 0, y: 0, width: 100, height: 50 } });
  img = image(r); size = img && jpegSize(img);
  check("ui_look: an area at full size", r.ok && size?.width === 100 && size.height === 50, JSON.stringify(size));
  r = await callRaw("ui_look", { target: "gm", region: "element", selector: "#board", maxWidth: 400 });
  img = image(r); size = img && jpegSize(img);
  check("ui_look: an element", r.ok && size?.width === 400 && size.height === 250, JSON.stringify(size));
  r = await call("ui_act", { target: "gm", steps: [{ do: "click", text: "Yes" }] });
  r = await script("return window.__stub.answered", "gm"); check("clicking the dialog's Yes by text answers it", r.data === "yes", r.text);

  /* waiting */
  let waiting = call("ui_wait", { target: "gm", for: "dialog", maxSeconds: 10 });
  await new Promise(x => setTimeout(x, 500)); await script("window.openDialog(); return 1", "gm");
  r = await waiting; check("ui_wait dialog returns the new dialog's text", r.ok && r.data.happened && r.data.windows?.[0]?.title === "Confirm" && r.data.afterSeconds < 5, r.text.slice(0, 200));
  await script("document.querySelector('[data-action=no]').click(); return 1", "gm");
  waiting = call("ui_wait", { target: "gm", for: "chat", maxSeconds: 10 });
  await new Promise(x => setTimeout(x, 500)); await script("await ChatMessage.create({ content: 'ping <b>pong</b>' }); return 1", "gm");
  r = await waiting; check("ui_wait chat returns the new message", r.ok && r.data.happened && r.data.messages?.[0]?.text === "ping pong", r.text.slice(0, 200));
  waiting = callRaw("ui_wait", { target: "gm", for: "screen", maxSeconds: 10, frames: true });
  await new Promise(x => setTimeout(x, 800)); await script("document.body.style.background = 'red'; return 1", "gm");
  r = await waiting; img = image(r); check("ui_wait screen notices a change and returns a frame", r.ok && r.data.happened && r.data.changed && img?.[0] === 0xff, r.text.slice(0, 200));
  waiting = call("ui_wait", { target: "gm", for: "text", text: "LATER", maxSeconds: 10 });
  await new Promise(x => setTimeout(x, 500)); await script("document.body.insertAdjacentHTML('beforeend', '<p>LATER</p>'); return 1", "gm");
  r = await waiting; check("ui_wait text", r.ok && r.data.happened && r.data.found === "LATER", r.text);
  r = await call("ui_wait", { target: "gm", for: "dialog", maxSeconds: 1 }); check("ui_wait times out cleanly", r.ok && r.data.happened === false && r.data.waitedSeconds >= 1, r.text);

  /* guards: world, runner's page, busy turn, runner setting */
  await script("game.world.id = 'pf2'; return 1");
  r = await call("ui_read", { target: "gm" }); check("UI tools refuse another world", !r.ok && /only work in "pf2-test"/.test(r.text), r.text);
  r = await call("session", { action: "start", account: "player" }); check("session start refuses another world", !r.ok && /only work in/.test(r.text), r.text);
  await script("game.world.id = 'pf2-test'; return 1");
  r = await call("ui_act", { target: "bridge", steps: [{ do: "click", button: "Count" }] }); check("input on the runner's page needs force", !r.ok && /runner's page/.test(r.text) && /force/.test(r.text), r.text.slice(0, 160));
  r = await call("ui_act", { target: "bridge", force: true, steps: [{ do: "click", button: "Count" }] }); check("forced input on the runner's page when no turn is busy", r.ok && r.data.ok, r.text.slice(0, 120));
  r = await script("return window.__stub.count"); check("…and the click really landed there", r.data === 1, r.text);
  await script("window.__stubFight = { state: 'running' }; return 1");
  r = await call("ui_act", { target: "bridge", force: true, steps: [{ do: "click", button: "Count" }] }); check("forced input is refused while a turn is busy", !r.ok && /turn is busy/.test(r.text) && /running/.test(r.text), r.text.slice(0, 160));
  r = await call("client_tools", { target: "bridge", action: "reload", force: true }); check("a forced reload is refused while a turn is busy", !r.ok && /turn is busy/.test(r.text), r.text.slice(0, 120));
  r = await call("ui_act", { target: "bridge", force: true, testingTurn: true, steps: [{ do: "click", button: "Count" }] }); check("testingTurn lets a forced call through", r.ok && r.data.ok, r.text.slice(0, 120));
  await script("window.__stubFight = { state: 'done' }; return 1");
  r = await call("ui_act", { target: "bridge", force: true, steps: [{ do: "click", button: "Count" }] }); check("a finished turn doesn't count as busy", r.ok && r.data.ok, r.text.slice(0, 120));
  await script("window.__stubFight = { state: 'ready', go: true }; return 1");
  r = await call("ui_act", { target: "bridge", force: true, steps: [{ do: "click", button: "Count" }] }); check("go: true counts as busy", !r.ok && /go/.test(r.text), r.text.slice(0, 120));
  await script("window.__stubFight = null; return 1");
  r = await call("ui_read", { target: "gm" }); check("reads on the runner's page need no force", (await call("ui_read", { target: "bridge" })).ok && r.ok);
  await script("window.__stubSettings = { runner: 'AI' }; return 1");
  r = await call("ui_act", { target: "gm", steps: [{ do: "click", button: "Count" }] }); check("the runner setting moves the guard to that session", !r.ok && /"AI" is the runner's page/.test(r.text), r.text.slice(0, 120));
  r = await call("ui_act", { target: "bridge", steps: [{ do: "click", button: "Count" }] }); check("…and frees the bridge's page", r.ok && r.data.ok, r.text.slice(0, 120));
  r = await call("ui_read", { target: "runner" }); check("target runner follows the setting", r.ok && r.data.user === "AI", r.text.slice(0, 80));
  r = await call("session", { action: "stop", account: "gm" }); check("stopping the runner's session needs force", !r.ok && /runner's page/.test(r.text), r.text.slice(0, 120));
  await script("window.__stubFight = { state: 'running' }; return 1");
  r = await call("session", { action: "stop", account: "gm", force: true }); check("…and is refused while a turn is busy", !r.ok && /turn is busy/.test(r.text), r.text.slice(0, 120));
  await script("window.__stubFight = null; return 1");
  r = await call("session", { action: "stop", account: "gm", force: true }); check("forced stop of the runner's session warns", r.ok && r.data.stopped && /runner/.test(r.data.warning ?? ""), r.text.slice(0, 200));
  await new Promise(x => setTimeout(x, 1500));   /* the world needs a moment to see the login drop */
  r = await call("session", { action: "start", account: "gm" }); check("runner session started again", r.ok && r.data.state === "ready", r.text.slice(0, 100));
  await script("window.__stubSettings = {}; return 1");
  r = await call("ui_read", { target: "runner" }); check("target runner is the bridge by default", r.ok && r.data.user === "Claude Bridge", r.text.slice(0, 80));

  /* client tools */
  r = await call("client_tools", { target: "gm", action: "console", errorsOnly: true }); check("client_tools console", r.ok && r.data.messages.some(m => m.text === "stub error line"), r.text.slice(0, 160));
  r = await call("client_tools", { target: "gm", action: "reload", clearCache: true }); check("client_tools reload (cache cleared)", r.ok && r.data.ready === true, r.text);
  r = await script("return { user: game.user.name, bridge: typeof __bridge.startJob, count: window.__stub.count }", "gm"); check("the session is back after the reload with helpers reinstalled", r.ok && r.data.user === "AI" && r.data.bridge === "function" && r.data.count === 0, r.text);
  r = await call("client_tools", { target: "bridge", action: "reload", force: true }); check("forced reload of the bridge's page", r.ok && r.data.ready === true, r.text);
  r = await call("foundry_status"); check("bridge connected after its reload", r.ok && r.data.connected && r.data.user === "Claude Bridge", r.text.slice(0, 80));
  r = await script("return typeof __bridge.text"); check("helpers reinstalled on the bridge's page", r.data === "function", r.text);

  /* player session, background scripts, stopping */
  r = await call("session", { action: "start", account: "player" }); check("session start player (Test Player)", r.ok && r.data.user === "Test Player" && r.data.role === 1, r.text.slice(0, 120));
  r = await script("return game.user.name", "player"); check("run_script on the player session", r.ok && r.data === "Test Player", r.text);
  r = await script("await new Promise(r => setTimeout(r, 400)); return 'slow done'", "player", { background: true }); const bg = r.data.job; check("background script returns a job", r.ok && !!bg, r.text);
  r = await call("job_status", { job: bg, target: "player" }); check("job_status (player) sees it running", r.ok && r.data.done === false, r.text);
  await new Promise(x => setTimeout(x, 700));
  r = await call("job_status", { job: bg, target: "player" }); check("job_status (player) returns its result", r.ok && r.data.done && r.data.result === "slow done", r.text);
  r = await call("job_status", { job: bg }); check("jobs are per page", !r.ok, r.text);
  r = await call("session", { action: "status" }); check("both sessions listed", r.ok && r.data.sessions.filter(x => x.state === "ready").length === 2, r.text.slice(0, 200));
  r = await call("session", { action: "stop", account: "player" }); check("session stop player", r.ok && r.data.stopped && r.data.state === "stopped", r.text);
  r = await call("session", { action: "status" }); check("browser stays while gm is open", r.ok && r.data.browser === true);
  r = await call("session", { action: "stop", account: "gm" }); check("session stop gm", r.ok && r.data.stopped, r.text);
  r = await call("session", { action: "status" }); check("session browser closed when the last session ends", r.ok && r.data.browser === false, r.text.slice(0, 120));
  await new Promise(x => setTimeout(x, 1200));
  r = await script("return game.users.getName('AI').active"); check("AI is offline again after the session closed", r.ok && r.data === false, r.text);

  /* ---- Foundry restart: the watchdog rejoins ---- */
  await fetch("http://127.0.0.1:30999/stub/restart", { method: "POST" });
  const rejoined = await until(() => (out.match(/joined "PF2 Test" as Claude Bridge/g) ?? []).length >= 2, 90000);
  check("watchdog rejoins after a world restart", rejoined, rejoined ? "rejoined" : out.split("\n").slice(-4).join(" | "));
  r = await call("foundry_status"); check("tools work again after the rejoin", r.ok && r.data.connected, r.text.slice(0, 80));

  const audit = fs.readFileSync(path.join(dataDir, "audit.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  check("audit log has every call", audit.length >= 24 && audit.every(a => a.tool && a.time), `${audit.length} entries`);
  check("audit records never hold an image", !audit.some(a => JSON.stringify(a).length > 5000), `longest ${Math.max(...audit.map(a => JSON.stringify(a).length))} chars`);
  await client.close();

  /* ---- allowUi off (the default): none of the UI tools exist ---- */
  bridge.kill("SIGTERM"); await new Promise(x => setTimeout(x, 800));
  fs.writeFileSync(cfgPath, JSON.stringify({ publicUrl: PUB, port: PORT, foundryUrl: "http://127.0.0.1:30999", foundryUser: "Claude Bridge", passphrase: hashPassphrase(PASS), allowScripts: true, headless: true, dataDir: "test/.data", evalTimeoutMs: 20000 }));
  bridge2 = spawn(process.execPath, ["src/server.mjs"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let out2 = ""; bridge2.stdout.on("data", d => { out2 += d; }); bridge2.stderr.on("data", d => { out2 += d; });
  check("bridge restarts with ui off", await until(() => /joined "PF2 Test" as Claude Bridge/.test(out2)) && /ui off/.test(out2), out2.split("\n").slice(-2).join(" | "));
  const client2 = new Client({ name: "test", version: "1" });
  await client2.connect(new StreamableHTTPClientTransport(new URL(PUB + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + ref.access_token } } }));
  const tools2 = (await client2.listTools()).tools.map(t => t.name);
  check("ui tools absent when allowUi is off", !tools2.some(t => /^ui_|^session$|^client_tools$/.test(t)) && tools2.includes("run_script"), tools2.join(","));
  const r2 = await client2.callTool({ name: "run_script", arguments: { code: "return 1", target: "gm" } });
  check("run_script on a session is refused when ui is off", r2.isError && /allowUi/.test(r2.content[0].text), r2.content[0].text);
  await client2.close();
} catch (e) { check("harness", false, String(e.stack ?? e)); }
finally {
  bridge.kill("SIGTERM"); bridge2?.kill("SIGTERM"); stub.close();
  if (hadCfg) fs.writeFileSync(cfgPath, savedCfg); else fs.rmSync(cfgPath, { force: true });
  const failed = results.filter(r => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log("Bridge output:\n" + out.slice(-3000)); process.exit(1); }
  process.exit(0);
}
