# Foundry Claude Bridge

A small program that runs on the same computer as Foundry VTT and gives Claude a set of tools inside your world: read and send chat, roll dice, look up actors, scenes, tokens, combat and journals, and drive the Lythara Survey Sheet map module. It keeps its own hidden browser logged into Foundry as a GM user, and exposes the tools to Claude as a custom connector (MCP over HTTPS, OAuth sign-in).

Nothing in it deletes documents, changes settings or installs modules. Running arbitrary scripts is off unless you turn it on in `config.json`, and so are the test sessions (hidden sign-ins as two test accounts, with real mouse and keyboard input and screenshots, for testing modules without a visible browser). Every call is written to `data/audit.log`.

## What you need

- Windows PC running Foundry VTT v13 or v14 (the one Foundry already runs on).
- Node.js 20 or newer: https://nodejs.org (LTS installer, defaults are fine).
- A public HTTPS address for the bridge, e.g. a Cloudflare Tunnel route `bridge.yourdomain.com → http://localhost:8787`. Claude's servers must be able to reach it.
- A GM user in Foundry for the bridge (e.g. **Claude Bridge**, role Gamemaster). Make it in Foundry's User Management. It should not be a user anyone else logs in with, because Foundry 14 allows one login per user.

## Install (once)

1. Unzip this folder somewhere permanent, e.g. `C:\FoundryBridge`.
2. Open **Command Prompt** in that folder (type `cmd` in the folder's address bar) and run:
   ```
   npm install
   npx playwright install chromium
   npm run setup
   ```
   `setup` asks for: the public address (e.g. `https://bridge.yourdomain.com`), the local port (8787), Foundry's local address (`http://localhost:30000`), the bridge's Foundry user, its Foundry password if it has one, and an **approval passphrase**. The passphrase is what you type in the browser when you add the connector in Claude; it is stored only as a hash.
3. Start it: `npm start` (or double-click `start-bridge.cmd`). The window shows `joined "<world>" as <user>` once it's in. Leave it running; a world restart is handled by itself.
4. In Cloudflare: Networking → Tunnels → your tunnel → Routes → Add route → Published application: subdomain `bridge`, your domain, service `http://localhost:8787`.
5. Check `https://bridge.yourdomain.com/health` in a browser: `{"ok":true,"foundry":"ready",...}`.

## Connect Claude

In claude.ai: Settings → Connectors → **Add custom connector** → name it (e.g. Foundry) and enter the URL `https://bridge.yourdomain.com/mcp`. Claude opens the bridge's approval page; type the passphrase and click **Approve**. That's the only time the passphrase is used. Then turn the connector on in a chat and ask Claude for the Foundry status.

To disconnect Claude later: remove the connector in claude.ai, or stop the bridge, or delete `data/tokens.json` (every connection must then be approved again).

## Start with Windows (optional)

Task Scheduler → Create Basic Task → "Foundry Bridge" → trigger **When I log on** → action **Start a program**: `C:\FoundryBridge\start-bridge.cmd`, start in `C:\FoundryBridge`. Tick "Run with highest privileges" only if Foundry itself needs it; normally not.

## Files

- `config.json` — your settings (made by `npm run setup`). `allowScripts: true` enables the `run_script` tool. `allowUi: true` enables the test sessions and the `session`, `ui_act`, `ui_read`, `ui_look`, `ui_wait` and `client_tools` tools; `uiWorlds` (default `["pf2-test"]`) names the only worlds they work in, and `uiAccounts` (default `{"gm": "AI", "player": "Test Player"}`) the two accounts they sign in as. Those accounts must exist in the world, have no password, and not be the bridge's own user.
- `data/audit.log` — one line per tool call: time, tool, arguments, result.
- `data/bridge.log` — connection events. `data/tokens.json`, `data/clients.json` — Claude's connections.

## Tools

`foundry_status`, `chat_read`, `chat_send`, `roll`, `actors_list`, `actor_get`, `scenes_list`, `scene_activate`, `scene_view`, `tokens_list`, `token_move`, `combat_get`, `journal_search`, `journal_get`, `map_sheet_create`, `map_sheet_render`, `map_exploration_sync`, `map_sheet_export`, `map_sheet_apply`, `job_status`, `run_script` when scripts are allowed, and with `allowUi`: `session`, `ui_act`, `ui_read`, `ui_look`, `ui_wait`, `client_tools`.

The test sessions run in a second hidden browser, separate from the bridge's own page, one sign-in per account with its own cookie. `session` refuses to start for an account that is already logged in somewhere, so it never logs you out of a tab. The bridge's own page (or whichever page the Lythara Encounter Builder names as its runner) only takes input or a reload with `force: true`, and never while that module is running a monster turn.

## Updating

Replace the files (keep `config.json` and `data/`), run `npm install`, restart the bridge. If the tool list changed, remove and re-add the connector in Claude.

## Testing without Foundry

`npm test` runs the bridge against a stub Foundry and checks the OAuth handshake and every tool. It needs Playwright's Chromium (`npx playwright install chromium`).

## Changing the code
See [docs/DEVELOPING.md](docs/DEVELOPING.md): how it works, what it relies on, testing and releasing.
