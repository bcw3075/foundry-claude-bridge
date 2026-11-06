# Developing the bridge

How the code works and why, for anyone changing it. Setting it up on a machine is in the README.

## What it is
One Node program on the machine that runs Foundry. It keeps a hidden Chromium page joined to the running world as a dedicated GM user, and offers MCP tools over Streamable HTTP so Claude can act inside the world. It talks to Foundry over localhost, ships nothing to players' browsers, and works when no human GM is online.

## Layout
| File | Role |
|---|---|
| `src/config.mjs` | Reads `config.json` (made by `npm run setup`) over defaults. `allowScripts` defaults to false and setup does not write it: the owner adds it by hand. |
| `src/setup.mjs` | Interactive setup. Hides the passphrase as it is typed; pressing Enter at the Foundry-password prompt clears the password. |
| `src/auth.mjs` | OAuth 2.0 provider for the MCP SDK's `mcpAuthRouter`: dynamic client registration, PKCE S256, 24 h access tokens, rotating refresh tokens. New connections are approved on a consent page with the owner's passphrase (scrypt hash; 8 tries per 15 minutes, lockout kept in memory). Tokens live in `data/tokens.json`. |
| `src/foundry.mjs` | `FoundryClient`: launches Chromium, joins the world, re-joins after restarts (watchdog every 15 s), runs functions inside the page, keeps a job queue in the page for long work, keeps the page's last console messages, and can reload the page. The join flow, the in-page helpers, the console buffer and the reload are exported and shared with the sessions. |
| `src/sessions.mjs` | `SessionManager` (only when `allowUi` is true): a second Chromium process, started when the first session opens and closed when the last one ends, with one browser context (own cookie) per fixed account: `gm` and `player` from `uiAccounts`. A session never rejoins by itself: when its page leaves the game it reports `down` until started again. |
| `src/ui.mjs` | Real input and sight on any client (the bridge's page or a session): `act` (a batch of mouse and keyboard steps through Playwright, so the page sees trusted events), `read` (open windows, dialogs, buttons, fields, notifications, selection, targets, scene, combat as text), `look` (a JPEG through CDP's `Page.captureScreenshot` with a scale in its clip, so it is scaled in the browser), `wait` (polls every 300 ms for a dialog, window, chat message, scene change, selector, text, or a change in a small screenshot). Adds no hooks to the page. |
| `src/tools.mjs` | Every MCP tool. Each call is timed and written to the audit log, success or failure. The `session`, `ui_*` and `client_tools` tools exist only when `allowUi` is true; `run_script` and `job_status` take a `target` (`bridge`, `gm`, `player`, `runner`). |
| `src/server.mjs` | Express 5 app: auth routes, `/mcp` behind `requireBearerAuth` (stateless: a fresh MCP server per request), `/health`, logging, audit. |
| `test/stub-foundry.mjs`, `test/run.mjs` | `npm test`: a fake Foundry plus a full OAuth handshake and a call to every tool. The stub tracks who is logged in, records real input in `window.__stub`, and stands in for Encounter Builder's `runner` setting and `fight.current()` so the guards can be tested. |

## Rules the code keeps
- **No secrets leave the machine.** The passphrase is stored only as a hash; tokens stay in `data/`. Nothing secret is logged.
- **No delete tools, no settings tools, no package installs.** `run_script` is the one open door, and only when `allowScripts` is true in `config.json`.
- **Every tool call is audited** to `data/audit.log`: time, tool, arguments, result, duration. Long string arguments are shortened per value, so each record stays valid JSON (0.1.4 fixed a bug where trimming the whole record broke scripts over 600 characters).
- **Functions that run in the page must be self-contained.** They are serialised into the page, so they can't close over Node variables; pass everything as arguments.
- **The UI tools are off by default** (`allowUi` in `config.json`) and work only while one of `uiWorlds` is running (default `pf2-test`). Every call checks both through the bridge's own page, so they also need the bridge connected.
- **Real input goes to the test sessions, not the runner's page.** The runner is the account Encounter Builder's `runner` setting names (read when the module is active), otherwise the bridge's own account. On the runner's page, `ui_act` and a `client_tools` reload need `force: true`, and are refused while a monster turn is busy: `api.fight.busy()` when the module offers it, otherwise `api.fight.current(combat)` on every started combat with state `running` or `submitted`, or `go` set. `testingTurn: true` lets a forced call through while busy: for tests of exactly that, or to clear a turn that has hung without restarting the bridge. Stopping a session whose account is the runner follows the same rule (force, not while busy) and returns a warning, because it takes the runner offline until started again. Reads (`ui_read`, `ui_look`, console) are always allowed. `run_script` has no busy check on purpose: Encounter Builder's own test driver runs through it.
- **A session never takes a login someone else holds.** `session start` reads `game.users.getName(name).active` on the bridge's page first and refuses if the account is online (Foundry allows one login per user, so joining would log the other client out). The session accounts may not be the bridge's own account.
- **Screenshots are returned, never stored.** The audit log holds the call's arguments and outcome, not the image.
- **No hooks.** The bridge registers no Foundry hooks on any page (a handler that returned a value would cancel other modules' handlers). Waiting is done by polling.

## Things that cost time to learn
- The SDK's bearer middleware answers 500 unless `verifyAccessToken` throws the SDK's `InvalidTokenError`. Bad grants must throw `InvalidGrantError`.
- `app.set("trust proxy", 1)`, not `true`, or express-rate-limit refuses to start behind the tunnel.
- What claude.ai's connector flow needs:
  - a 401 with `WWW-Authenticate: Bearer resource_metadata=…`;
  - `/.well-known/oauth-protected-resource/mcp`, whose `resource` equals the URL exactly as the owner entered it;
  - authorization-server metadata with `registration_endpoint` and S256;
  - redirect `https://claude.ai/api/mcp/auth_callback`;
  - a form-encoded `/token`;
  - every endpoint answering within 10 s.
- Listen on both `127.0.0.1` and `::1`: on Windows the tunnel's "localhost" can be IPv6.
- Foundry 14 draws the join form with JavaScript, so wait for the user select before filling it.
- Use full Chromium in the new headless mode (`browserChannel: "chromium"`). The headless shell draws in software, which made map redraws 10x slower.
- Chat HTML → text: turn `<br>` and block ends into newlines before reading `textContent`.
- After the tool list changes, claude.ai keeps the old list until the connector is disconnected and reconnected.
- The bridge's Foundry user must exist in the world, and only the owner can create it. Two clients can't share one Foundry user: never log a browser in as the bridge user.
- A page reload clears `window.__bridge`: reinstall the helpers after every reload (`reloadPage` does). While the bridge's own page reloads, its state is `joining` so the watchdog stands back.
- Playwright's `Browser` has no `process()`; each `chromium.launch` is its own process, which is why the sessions use a second launch rather than a second context in the bridge's browser.
- Scaling a screenshot: CDP `Page.captureScreenshot` takes a `scale` inside its `clip`, so the browser scales it and no image library is needed. Scene coordinates become page pixels through `canvas.clientCoordinatesFromCanvas`.
- Playwright locators auto-wait for visibility, so filter with `{ visible: true }` before `.first()`; otherwise a hidden duplicate of a button makes a click wait until its timeout.

## Testing
1. `npm install`, then `npm test`. Every check must pass (107 at 0.2.0, about 90 s). Add a check for every new tool or fix. The run ends by restarting the bridge with `allowUi` off to prove the UI tools are absent then.
2. Then test live through the connector, in the test world: status, every changed tool, a script if scripts are on, a map job if map tools changed, and for the UI tools a comparison with a real browser (a module button, a double-click after a hover, a canvas token drag, a held-key action), since the stub only proves the events arrive trusted. Say which tools were not exercised live.

## Releasing
1. Bring this file up to date with the change: run `python3 tools/doccheck.py` (it lists names this file mentions that are no longer in the code; `WWW-Authenticate` is expected, the SDK sets it) and reread the sections the change touched.
2. Bump `version` in `package.json` and in the `McpServer` constructor in `src/server.mjs`.
3. Commit and push.
4. Build a zip without `node_modules`, `config.json` or `data/`.
5. The owner unzips it over the install folder, keeping `config.json` and `data/`. They run `npm install` if dependencies changed, then restart the bridge window. If tools changed, they reconnect the connector. New config keys (`allowUi`, `uiWorlds`, `uiAccounts`) are added to `config.json` by hand; setup does not write them.

## Keep out of this repo
`config.json`, `data/`, and any campaign content. The repo is public.
