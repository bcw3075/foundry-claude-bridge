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
  evalTimeoutMs: 60000
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
