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
fs.writeFileSync(cfgPath, JSON.stringify({ publicUrl: PUB, port: PORT, foundryUrl: "http://127.0.0.1:30999", foundryUser: "Claude Bridge", passphrase: hashPassphrase(PASS), allowScripts: true, headless: true, dataDir: "test/.data", evalTimeoutMs: 20000 }));

const results = []; const check = (name, ok, info = "") => { results.push([name, ok, info]); console.log(`${ok ? "PASS" : "FAIL"} ${name}${info ? " — " + info : ""}`); };
const stub = await startStub(30999);
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
  check("tools listed", tools.length >= 18, tools.join(","));
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

  /* ---- Foundry restart: the watchdog rejoins ---- */
  await fetch("http://127.0.0.1:30999/stub/restart", { method: "POST" });
  const rejoined = await until(() => (out.match(/joined "PF2 Test" as Claude Bridge/g) ?? []).length >= 2, 90000);
  check("watchdog rejoins after a world restart", rejoined, rejoined ? "rejoined" : out.split("\n").slice(-4).join(" | "));
  r = await call("foundry_status"); check("tools work again after the rejoin", r.ok && r.data.connected, r.text.slice(0, 80));

  const audit = fs.readFileSync(path.join(dataDir, "audit.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  check("audit log has every call", audit.length >= 24 && audit.every(a => a.tool && a.time), `${audit.length} entries`);
  await client.close();
} catch (e) { check("harness", false, String(e.stack ?? e)); }
finally {
  bridge.kill("SIGTERM"); stub.close();
  if (hadCfg) fs.writeFileSync(cfgPath, savedCfg); else fs.rmSync(cfgPath, { force: true });
  const failed = results.filter(r => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) { console.log("Bridge output:\n" + out.slice(-3000)); process.exit(1); }
  process.exit(0);
}
