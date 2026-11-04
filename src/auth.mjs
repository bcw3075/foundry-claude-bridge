/* A single-owner OAuth 2.0 authorization server, just enough for Claude to connect:
   dynamic client registration, PKCE authorization code, rotating refresh tokens.
   Approval is one passphrase typed by the owner on the consent page; nothing else can mint a token. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { InvalidTokenError, InvalidGrantError, InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const rand = (n = 32) => crypto.randomBytes(n).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

export function hashPassphrase(pass) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(pass.normalize("NFKC"), salt, 64).toString("base64url");
  return `scrypt$${salt}$${hash}`;
}
export function checkPassphrase(pass, stored) {
  if (!stored || typeof pass !== "string") return false;
  const [, salt, hash] = stored.split("$");
  const got = crypto.scryptSync(pass.normalize("NFKC"), salt, 64);
  const want = Buffer.from(hash, "base64url");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** JSON file store with atomic writes; small enough to rewrite whole. */
class JsonStore {
  constructor(file, init) { this.file = file; this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : init; }
  save() { const tmp = this.file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2)); fs.renameSync(tmp, this.file); }
}

const escape = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export class BridgeAuthProvider {
  constructor(cfg, log) {
    this.cfg = cfg; this.log = log;
    this.clients = new JsonStore(path.join(cfg.dataDir, "clients.json"), {});
    this.tokens = new JsonStore(path.join(cfg.dataDir, "tokens.json"), { access: {}, refresh: {} });
    this.pending = new Map();   /* authorization requests awaiting the passphrase */
    this.codes = new Map();     /* issued authorization codes */
    this.attempts = [];         /* passphrase attempt timestamps, for rate limiting */
    this.clientsStore = {
      getClient: id => this.clients.data[id],
      registerClient: client => {
        const full = { ...client, client_id: rand(16), client_id_issued_at: now() };
        /* keep the store small: one Claude registration per redirect set is plenty */
        for (const [id, c] of Object.entries(this.clients.data)) if (JSON.stringify(c.redirect_uris) === JSON.stringify(full.redirect_uris) && c.client_name === full.client_name) delete this.clients.data[id];
        this.clients.data[full.client_id] = full; this.clients.save();
        this.log("auth", `registered client ${full.client_name ?? full.client_id}`);
        return full;
      }
    };
  }

  /* ---- authorization: show the consent page ---- */
  async authorize(client, params, res) {
    this.sweep();
    const id = rand(16);
    this.pending.set(id, { client_id: client.client_id, ...params, created: now() });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(this.consentPage(id, client));
  }

  consentPage(id, client, error = "") {
    const name = escape(client.client_name ?? client.client_id);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve a connection</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#1d1a17;color:#efe8da;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#2a2521;padding:28px 32px;border-radius:12px;max-width:420px;box-shadow:0 8px 30px #0008}h1{font-size:20px;margin:0 0 8px}p{margin:8px 0;color:#cfc6b4}
input{width:100%;box-sizing:border-box;font-size:16px;padding:10px;border-radius:8px;border:1px solid #574c40;background:#1d1a17;color:#efe8da;margin:12px 0}
button{font-size:16px;padding:10px 18px;border-radius:8px;border:0;cursor:pointer}.ok{background:#c7793b;color:#1d1a17;font-weight:600}.no{background:#3b332d;color:#efe8da;margin-left:8px}.err{color:#ff9c7a}</style></head>
<body><form method="post" action="/approve"><h1>Foundry Claude Bridge</h1>
<p><b>${name}</b> wants to use your Foundry bridge. Approve it only if you just added this connector in Claude yourself.</p>
${error ? `<p class="err">${escape(error)}</p>` : ""}
<input type="hidden" name="request" value="${id}">
<label>Approval passphrase<input type="password" name="passphrase" autocomplete="current-password" autofocus required></label>
<button class="ok" name="decision" value="approve">Approve</button><button class="no" name="decision" value="deny">Deny</button></form></body></html>`;
  }

  /* POST /approve from the consent page */
  async handleApprove(req, res) {
    const { request, passphrase, decision } = req.body ?? {};
    const p = this.pending.get(request);
    if (!p) { res.status(400).type("text").send("That approval request has expired. Add the connector again in Claude."); return; }
    const client = this.clients.data[p.client_id];
    const back = (extra) => { const u = new URL(p.redirectUri); for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v); if (p.state) u.searchParams.set("state", p.state); return u.href; };
    if (decision !== "approve") { this.pending.delete(request); this.log("auth", "connection denied by owner"); res.redirect(back({ error: "access_denied", error_description: "The owner denied the connection." })); return; }
    const t = Date.now(); this.attempts = this.attempts.filter(a => t - a < 15 * 60 * 1000);
    if (this.attempts.length >= 8) { res.status(429).type("text").send("Too many attempts. Wait 15 minutes."); return; }
    if (!checkPassphrase(passphrase, this.cfg.passphrase)) { this.attempts.push(t); this.log("auth", "wrong passphrase"); res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(this.consentPage(request, client, "That passphrase is wrong.")); return; }
    this.pending.delete(request);
    const code = rand(32);
    this.codes.set(code, { ...p, created: now() });
    this.log("auth", `connection approved for ${client?.client_name ?? p.client_id}`);
    res.redirect(back({ code }));
  }

  async challengeForAuthorizationCode(client, code) {
    const c = this.codes.get(code); if (!c || c.client_id !== client.client_id) throw new InvalidGrantError("Unknown authorization code.");
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const c = this.codes.get(code); this.codes.delete(code);
    if (!c || c.client_id !== client.client_id) throw new InvalidGrantError("Unknown authorization code.");
    if (now() - c.created > 300) throw new InvalidGrantError("Authorization code expired.");
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidRequestError("redirect_uri does not match.");
    if (resource && c.resource && resource.href !== c.resource.href) throw new InvalidRequestError("resource does not match.");
    return this.issue(client.client_id, c.scopes ?? [], (c.resource ?? resource)?.href);
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const r = this.tokens.data.refresh[refreshToken];
    if (!r || r.client_id !== client.client_id) throw new InvalidGrantError("Unknown refresh token.");
    delete this.tokens.data.refresh[refreshToken];
    if (r.access) delete this.tokens.data.access[r.access];
    if (resource && r.resource && resource.href !== r.resource) throw new InvalidRequestError("resource does not match.");
    return this.issue(client.client_id, scopes?.length ? scopes : r.scopes, r.resource);
  }

  issue(client_id, scopes, resource) {
    const access = rand(32), refresh = rand(32), exp = now() + this.cfg.accessTokenTtl;
    this.tokens.data.access[access] = { client_id, scopes, resource, expires: exp };
    this.tokens.data.refresh[refresh] = { client_id, scopes, resource, access, created: now() };
    this.prune(); this.tokens.save();
    return { access_token: access, token_type: "bearer", expires_in: this.cfg.accessTokenTtl, refresh_token: refresh, scope: scopes.join(" ") || undefined };
  }

  async verifyAccessToken(token) {
    const a = this.tokens.data.access[token];
    if (!a) throw new InvalidTokenError("Unknown token.");
    if (a.expires <= now()) throw new InvalidTokenError("Token expired.");
    return { token, clientId: a.client_id, scopes: a.scopes ?? [], expiresAt: a.expires, resource: a.resource ? new URL(a.resource) : undefined };
  }

  async revokeToken(client, { token }) {
    if (this.tokens.data.access[token]?.client_id === client.client_id) delete this.tokens.data.access[token];
    if (this.tokens.data.refresh[token]?.client_id === client.client_id) delete this.tokens.data.refresh[token];
    this.tokens.save();
  }

  /** Forget every token, so each Claude connection must be approved again. */
  revokeAll() { this.tokens.data = { access: {}, refresh: {} }; this.tokens.save(); }

  prune() {
    const t = now();
    for (const [k, v] of Object.entries(this.tokens.data.access)) if (v.expires + 86400 < t) delete this.tokens.data.access[k];
    for (const [k, v] of Object.entries(this.tokens.data.refresh)) if (v.created + 90 * 86400 < t) delete this.tokens.data.refresh[k];
  }
  sweep() {
    const t = now();
    for (const [k, v] of this.pending) if (t - v.created > 600) this.pending.delete(k);
    for (const [k, v] of this.codes) if (t - v.created > 300) this.codes.delete(k);
  }
}
