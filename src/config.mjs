/* Configuration: config.json next to package.json, created by `npm run setup`. Nothing secret is logged. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = path.join(ROOT, "config.json");

const DEFAULTS = {
  /* where Claude reaches this bridge (the Cloudflare Tunnel route). Used as the OAuth issuer and the MCP resource URL. */
  publicUrl: "https://bridge.example.com",
  /* local port the bridge listens on; the tunnel route points at http://localhost:<port> */
  port: 8787,
  /* Foundry as seen from this machine (not through the tunnel) */
  foundryUrl: "http://localhost:30000",
  /* the Foundry user the hidden client joins as; a GM account made for the bridge */
  foundryUser: "Claude Bridge",
  /* that user's Foundry password, if it has one; leave empty for none */
  foundryPassword: "",
  /* scrypt hash of the passphrase that approves a new Claude connection (set by `npm run setup`) */
  passphrase: null,
  /* let Claude run arbitrary JavaScript in the Foundry client. Off unless the owner turns it on here. */
  allowScripts: false,
  /* let Claude open hidden test sessions and use real input and screenshots (the session, ui_* and client_tools tools).
     Off unless the owner turns it on here. */
  allowUi: false,
  /* the UI tools only work while one of these worlds is running (world ids) */
  uiWorlds: ["pf2-test"],
  /* the Foundry accounts the two test sessions join as. Neither may be the bridge's own account, and the tools refuse
     to start a session for an account that is already logged in elsewhere. No passwords: these accounts have none. */
  uiAccounts: { gm: "AI", player: "Test Player" },
  /* run Chromium without a window */
  headless: true,
  /* which Chromium to run: "chromium" (full browser, new headless mode, can use the GPU) or "" (Playwright's headless shell, software drawing) */
  browserChannel: "chromium",
  /* extra Chromium flags, if a machine needs them (e.g. "--use-angle=swiftshader") */
  chromiumArgs: [],
  /* where tokens, clients and the audit log live */
  dataDir: "data",
  /* how long an access token lives, in seconds */
  accessTokenTtl: 24 * 3600,
  /* in-page tool calls give up after this many milliseconds */
  evalTimeoutMs: 60000,
  /* fight_wait holds one in-page wait at most this long, in seconds, and chains them up to the caller's maxSeconds: each one tells
     Encounter Builder the thinker is still listening. Tests set it low; leave it alone otherwise. */
  fightWaitChunkS: 60,
  /* ---- the API worker (0.4.0): Encounter Builder's API route. It is on only when the owner adds "anthropicApiKey" here by hand (a key from her
     Console workspace; setup never asks for it, and the bridge never logs, audits or sends it anywhere but the API). ---- */
  /* the Messages API; tests point it at a stand-in */
  apiUrl: "https://api.anthropic.com/v1/messages",
  /* the model each of Encounter Builder's picks means; change these when newer models come, no code change needed */
  apiModels: { sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" },
  /* dollars per million tokens [fresh input, 5-minute cache write, cache read, output], for the cost shown in the module's History (checked 2026-11-12) */
  apiPrices: { "claude-sonnet-5-5": [2, 2.5, 0.2, 10], "claude-opus-5-5": [4, 5, 0.2, 20] },
  /* a guard against a fault that loops: past this many calls in an hour the worker stops until Wake Angel (about $5 at worst at 120) */
  apiMaxCallsPerHour: 120,
  /* how often the worker looks whether a fight is on the API route, in seconds (a read that writes nothing) */
  apiPollS: 5,
  /* the most one answer may use, in tokens */
  apiMaxTokens: 4000,
  /* how long one request may take before it is tried again, in seconds (three tries in all) */
  apiTimeoutS: 60,
  /* how long it waits before trying a busy or failing API again (then twice as long), in milliseconds */
  apiRetryMs: 5000
};

export function loadConfig() {
  let saved = {};
  if (fs.existsSync(CONFIG_PATH)) saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const cfg = { ...DEFAULTS, ...saved };
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  cfg.publicUrl = cfg.publicUrl.replace(/\/+$/, "");
  return cfg;
}

export function saveConfig(cfg) {
  const out = { ...cfg };
  out.dataDir = path.relative(ROOT, cfg.dataDir) || "data";
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2) + "\n");
}
