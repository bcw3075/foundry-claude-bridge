/* One-time setup: asks for the bridge's public address, the Foundry user and the approval passphrase, and writes config.json.
   Run with `npm run setup`. The passphrase is stored only as an scrypt hash. */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hashPassphrase } from "./auth.mjs";
import { loadConfig, saveConfig, CONFIG_PATH } from "./config.mjs";

const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = async (q, def) => { const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim(); return a || def || ""; };

const cfg = loadConfig();
console.log("Foundry Claude Bridge setup. Press Enter to keep a value shown in brackets.\n");
cfg.publicUrl = (await ask("Public address Claude will use (the tunnel route)", cfg.publicUrl)).replace(/\/+$/, "");
cfg.port = Number(await ask("Local port to listen on", String(cfg.port)));
cfg.foundryUrl = (await ask("Foundry address on this machine", cfg.foundryUrl)).replace(/\/+$/, "");
cfg.foundryUser = await ask("Foundry user the bridge joins as (a GM account)", cfg.foundryUser);
cfg.foundryPassword = await ask("That user's Foundry password (blank if none)", cfg.foundryPassword);
let pass = "";
while (!pass) {
  pass = await ask("Passphrase that approves a new Claude connection (you type this once in the browser when adding the connector)");
  if (pass.length < 8) { console.log("Use at least 8 characters."); pass = ""; }
}
cfg.passphrase = hashPassphrase(pass);
rl.close();
saveConfig(cfg);
console.log(`\nSaved ${CONFIG_PATH}.`);
console.log(`Scripts from Claude are ${cfg.allowScripts ? "ALLOWED" : "off"} (allowScripts in config.json).`);
console.log("Start the bridge with: npm start");
