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
| `src/foundry.mjs` | `FoundryClient`: launches Chromium, joins the world, re-joins after restarts (watchdog every 15 s), runs functions inside the page, and keeps a job queue in the page for long work. |
| `src/tools.mjs` | Every MCP tool. Each call is timed and written to the audit log, success or failure. |
| `src/server.mjs` | Express 5 app: auth routes, `/mcp` behind `requireBearerAuth` (stateless: a fresh MCP server per request), `/health`, logging, audit. |
| `test/stub-foundry.mjs`, `test/run.mjs` | `npm test`: a fake Foundry plus a full OAuth handshake and a call to every tool. |

## Rules the code keeps
- **No secrets leave the machine.** The passphrase is stored only as a hash; tokens stay in `data/`. Nothing secret is logged.
- **No delete tools, no settings tools, no package installs.** `run_script` is the one open door, and only when `allowScripts` is true in `config.json`.
- **Every tool call is audited** to `data/audit.log`: time, tool, arguments, result, duration. Long string arguments are shortened per value, so each record stays valid JSON (0.1.4 fixed a bug where trimming the whole record broke scripts over 600 characters).
- **Functions that run in the page must be self-contained.** They are serialised into the page, so they can't close over Node variables; pass everything as arguments.

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

## Testing
1. `npm install`, then `npm test`. Every check must pass. Add a check for every new tool or fix.
2. Then test live through the connector, in the test world: status, every changed tool, a script if scripts are on, and a map job if map tools changed. Say which tools were not exercised live.

## Releasing
1. Bring this file up to date with the change: run `python3 tools/doccheck.py` (it lists names this file mentions that are no longer in the code; `WWW-Authenticate` is expected, the SDK sets it) and reread the sections the change touched.
2. Bump `version` in `package.json` and in the `McpServer` constructor in `src/server.mjs`.
3. Commit and push.
4. Build a zip without `node_modules`, `config.json` or `data/`.
5. The owner unzips it over the install folder, keeping `config.json` and `data/`. They run `npm install` if dependencies changed, then restart the bridge window. If tools changed, they reconnect the connector.

## Keep out of this repo
`config.json`, `data/`, and any campaign content. The repo is public.
