/* One-time setup: asks for the bridge's public address, the Foundry user and the approval passphrase, and writes config.json.
   Run with `npm run setup`. The passphrase is stored only as an scrypt hash. */
import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { hashPassphrase } from "./auth.mjs";
import { loadConfig, saveConfig, CONFIG_PATH } from "./config.mjs";

const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
let muted = false;
/* the legacy readline lets us silence its echo for secret answers */
rl._writeToOutput = str => { if (!muted) stdout.write(str); };
const question = q => new Promise(resolve => rl.question(q, resolve));
const ask = async (q, def) => { const a = (await question(def ? `${q} [${def}]: ` : `${q}: `)).trim(); return a || def || ""; };
/* a question whose answer must not show on screen */
const askHidden = async q => { stdout.write(q + ": "); muted = true; try { return (await question("")).trim(); } finally { muted = false; stdout.write("\n"); } };

const cfg = loadConfig();
console.log("Foundry Claude Bridge setup. Press Enter to keep a value shown in brackets.\n");
cfg.publicUrl = (await ask("Public address Claude will use (the tunnel route)", cfg.publicUrl)).replace(/\/+$/, "");
cfg.port = Number(await ask("Local port to listen on", String(cfg.port)));
cfg.foundryUrl = (await ask("Foundry address on this machine", cfg.foundryUrl)).replace(/\/+$/, "");
cfg.foundryUser = await ask("Foundry user the bridge joins as (a GM account)", cfg.foundryUser);
cfg.foundryPassword = await askHidden("That user's Foundry password (blank if none; not shown as you type)") || cfg.foundryPassword;
let pass = "";
while (!pass) {
  pass = await askHidden("Passphrase that approves a new Claude connection (typed once in the browser when adding the connector; not shown as you type)");
  if (pass.length < 8) { console.log("Use at least 8 characters."); pass = ""; continue; }
  const again = await askHidden("Type it again");
  if (again !== pass) { console.log("They don't match, try again."); pass = ""; }
}
cfg.passphrase = hashPassphrase(pass);
rl.close();
saveConfig(cfg);
console.log(`\nSaved ${CONFIG_PATH}.`);
console.log(`Scripts from Claude are ${cfg.allowScripts ? "ALLOWED" : "off"} (allowScripts in config.json).`);
console.log("Start the bridge with: npm start");
