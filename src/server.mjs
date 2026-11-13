/* Entry point: HTTP server with the OAuth endpoints, the MCP endpoint and a health page.
   Run behind the Cloudflare Tunnel route that points at http://localhost:<port>. */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { loadConfig } from "./config.mjs";
import { BridgeAuthProvider } from "./auth.mjs";
import { FoundryClient } from "./foundry.mjs";
import { registerTools } from "./tools.mjs";
import { SessionManager } from "./sessions.mjs";
import { ApiWorker } from "./worker.mjs";

const cfg = loadConfig();
if (!cfg.passphrase) { console.error("No approval passphrase set. Run: npm run setup"); process.exit(1); }

/* ---- logging and audit ---- */
const logFile = path.join(cfg.dataDir, "bridge.log"), auditFile = path.join(cfg.dataDir, "audit.log");
const log = (area, msg) => { const line = `${new Date().toISOString()} [${area}] ${msg}`; console.log(line); fs.appendFile(logFile, line + "\n", () => {}); };
/* long argument values (a script, pasted sheet data) are shortened in the audit log; the record itself stays valid JSON */
const trim = v => typeof v === "string" ? (v.length > 600 ? v.slice(0, 600) + `… (${v.length} chars)` : v) : Array.isArray(v) ? v.map(trim) : (v && typeof v === "object") ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)])) : v;
const audit = rec => fs.appendFile(auditFile, JSON.stringify({ time: new Date().toISOString(), ...rec, args: rec.args === undefined ? undefined : trim(rec.args) }) + "\n", () => {});

/* ---- Foundry client ---- */
const foundry = new FoundryClient(cfg, log);
/* hidden test sessions in a second browser, only when the owner allows them */
const sessions = cfg.allowUi ? new SessionManager(cfg, log) : null;
/* the API worker (0.4.0): thinks for Encounter Builder's monsters through the Claude API when "anthropicApiKey" is in config.json */
const worker = new ApiWorker(cfg, foundry, log, audit);

/* ---- HTTP ---- */
const app = express();
app.set("trust proxy", 1);   /* exactly one proxy hop: cloudflared on this machine */
app.disable("x-powered-by");
app.use((req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

const issuer = new URL(cfg.publicUrl), mcpUrl = new URL("/mcp", cfg.publicUrl);
const provider = new BridgeAuthProvider(cfg, log);
app.use(mcpAuthRouter({
  provider, issuerUrl: issuer, resourceServerUrl: mcpUrl, resourceName: "Foundry Claude Bridge",
  scopesSupported: ["foundry"], serviceDocumentationUrl: new URL("/", cfg.publicUrl)
}));
app.post("/approve", express.urlencoded({ extended: false }), (req, res) => provider.handleApprove(req, res));

app.get("/", (req, res) => res.type("text").send(`Foundry Claude Bridge\nAdd ${mcpUrl.href} as a custom connector in Claude.\nFoundry: ${foundry.state}${foundry.lastError ? " (" + foundry.lastError + ")" : ""}\n`));
app.get("/health", (req, res) => res.json({ ok: true, foundry: foundry.state, since: foundry.since, error: foundry.lastError, api: !worker.on ? "off" : worker.stopped ? "stopped" : worker.running ? "listening" : "ready" }));

const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl), expectedResource: mcpUrl });
app.all("/mcp", bearer, express.json({ limit: "4mb" }), async (req, res) => {
  /* stateless: a fresh MCP server per request, so no session table and nothing to leak between calls */
  const server = new McpServer({ name: "foundry-claude-bridge", version: "0.4.0" }, { instructions:
    "Tools that act inside the owner's Foundry VTT world as the bridge's GM user. Reads are safe; writes change the live game. Long map jobs return a job id for job_status. fight_wait and fight_plan let a chat think for Encounter Builder's monsters: wait for a turn, hand in a plan, wait again. "
    + (cfg.allowUi ? "The session, ui_* and client_tools tools act on hidden test sessions (gm, player) with real input; the runner's page is left alone unless forced." : "") });
  registerTools(server, foundry, cfg, audit, sessions, worker);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch (e) { log("mcp", `request failed: ${e.message}`); if (!res.headersSent) res.status(500).json({ error: "internal error" }); }
});

app.use((err, req, res, next) => { log("http", `error: ${err.message}`); if (!res.headersSent) res.status(400).type("text").send("bad request"); });

/* Listen on both loopback addresses: cloudflared's "localhost" may resolve to ::1 on Windows, and nothing outside this machine should reach the port directly. */
const servers = [];
const listen = (host) => new Promise(res => { const s = app.listen(cfg.port, host, () => { log("http", `listening on http://${host.includes(":") ? "[" + host + "]" : host}:${cfg.port}`); res(s); }); s.on("error", e => { log("http", `can't listen on ${host}: ${e.message}`); res(null); }); });
for (const h of ["127.0.0.1", "::1"]) { const s = await listen(h); if (s) servers.push(s); }
if (!servers.length) { console.error("Could not open the port."); process.exit(1); }
log("http", `public ${cfg.publicUrl}, scripts ${cfg.allowScripts ? "ALLOWED" : "off"}, ui ${cfg.allowUi ? "ALLOWED (" + cfg.uiWorlds.join(", ") + ")" : "off"}, api ${worker.on ? "on (Encounter Builder's API route)" : "off (no anthropicApiKey)"}`);
foundry.start();
worker.start();   /* with no key it only answers a Wake Angel press with "no key" on the GM's card */
const shutdown = async () => { log("http", "stopping"); worker.stop(); for (const s of servers) s.close(); await sessions?.stopAll(); await foundry.stop(); process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
