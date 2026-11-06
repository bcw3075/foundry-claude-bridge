/* Real input and sight on a hidden page. Everything here works on a "client": the bridge's own FoundryClient or a
   Session from sessions.mjs (both have `page`, `name`, `console`, `eval`). Input goes through Playwright's mouse and
   keyboard, so the page sees trusted events, the same as a person's. Nothing here adds a hook to the page.
   Functions passed to the page must be self-contained (they are serialised). */

/* ---------- in-page functions ---------- */

/** What is on screen: open windows (v2 and v1, framed ones unless `all`), notifications, selection, targets, scene, combat. */
export function uiSnapshot({ maxChars = 1500, windows = true, ids = null, all = false } = {}) {
  const clean = s => String(s ?? "").replace(/\s+/g, " ").trim();
  const list = [], seen = [];
  const add = (app, kind) => {
    const id = String(app.id ?? app.appId ?? `${kind}-${list.length}`);
    if (seen.includes(id)) return;
    seen.push(id);
    if (ids && !ids.includes(id)) return;
    /* Foundry registers every UI element (sidebar, hotbar, HUD) as an application; only framed ones are windows */
    const framed = kind === "v2" ? app.hasFrame !== false : app.popOut !== false;
    if (!all && !framed) return;
    const el = app.element?.jquery ? app.element[0] : app.element;
    const cls = app.constructor?.name ?? "?";
    const D = window.foundry?.applications?.api?.DialogV2;
    const dialog = !!((D && app instanceof D) || /dialog|prompt/i.test(cls));
    const r = el?.getBoundingClientRect?.();
    const w = { id, kind, class: cls, title: clean(app.title ?? el?.querySelector?.(".window-title, h1, h2")?.textContent).slice(0, 120), dialog, minimized: !!app.minimized,
      rect: r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null };
    if (el) {
      w.buttons = [...el.querySelectorAll("button, a.button, [data-action]")].filter(b => clean(b.textContent) || b.dataset?.action).slice(0, 25)
        .map(b => ({ text: clean(b.textContent).slice(0, 60), action: b.dataset?.action ?? null, name: b.name || null, disabled: !!b.disabled }));
      w.fields = [...el.querySelectorAll("input, select, textarea")].slice(0, 30)
        .map(f => ({ name: f.name || f.id || null, type: f.type ?? f.tagName.toLowerCase(), value: f.type === "checkbox" ? !!f.checked : String(f.value ?? "").slice(0, 80) }));
      w.text = clean(el.innerText ?? el.textContent).slice(0, maxChars);
    }
    list.push(w);
  };
  if (windows) {
    for (const app of (window.foundry?.applications?.instances?.values?.() ?? [])) add(app, "v2");
    for (const app of Object.values(window.ui?.windows ?? {})) add(app, "v1");
  }
  const notifications = [...document.querySelectorAll("#notifications .notification, #notifications li")]
    .map(n => ({ type: [...n.classList].find(c => ["info", "warning", "error", "success"].includes(c)) ?? null, text: clean(n.textContent).slice(0, 300) }));
  const nameOf = t => t?.name ?? t?.document?.name ?? "?";
  const c = window.game?.combat;
  return {
    user: window.game?.user?.name ?? null, path: location.pathname, ready: !!(window.game?.ready && window.canvas?.ready), hidden: document.hidden,
    scene: window.canvas?.scene?.name ?? null, sceneId: window.canvas?.scene?.id ?? null,
    control: window.ui?.controls?.control?.name ?? null, tool: window.ui?.controls?.tool?.name ?? null,
    controlled: (window.canvas?.tokens?.controlled ?? []).map(nameOf), targets: [...(window.game?.user?.targets ?? [])].map(nameOf),
    combat: c ? { round: c.round, turn: c.turn, current: c.combatant?.name ?? null } : null, paused: !!window.game?.paused,
    windows: list, notifications, windowIds: seen
  };
}

/** A small probe for ui_wait: window ids, the last chat message, the scene, whether a selector or text is present. */
function uiProbe({ selector = null, text = null } = {}) {
  const ids = [];
  for (const app of (window.foundry?.applications?.instances?.values?.() ?? [])) ids.push(String(app.id ?? ids.length));
  for (const app of Object.values(window.ui?.windows ?? {})) ids.push(String(app.appId ?? app.id ?? ids.length));
  const last = window.game?.messages?.contents?.at?.(-1);
  return {
    windowIds: ids, lastMessage: last?.id ?? null,
    sceneId: window.canvas?.scene?.id ?? null, ready: !!(window.canvas?.ready && !window.canvas?.loading),
    found: !!((selector && document.querySelector(selector)) || (text && (document.body?.innerText ?? "").includes(text)))
  };
}

/** Chat messages after a given id (the same shape as chat_read). */
function chatAfter({ since, limit = 10 }) {
  let list = window.game.messages.contents;
  if (since) { const i = list.findIndex(m => m.id === since); if (i >= 0) list = list.slice(i + 1); }
  return list.slice(-limit).map(m => ({
    id: m.id, time: new Date(m.timestamp).toISOString(), user: m.author?.name ?? m.user?.name ?? null, speaker: m.speaker?.alias ?? null,
    whisperTo: (m.whisper ?? []).map(id => window.game.users.get(id)?.name ?? id), blind: !!m.blind,
    flavor: window.__bridge.text(m.flavor ?? ""), text: window.__bridge.text(m.content).slice(0, 2000),
    rolls: (m.rolls ?? []).map(r => ({ formula: r.formula, total: r.total }))
  }));
}

/** Scene coordinates → page coordinates for the mouse. */
function sceneToClient({ x, y }) {
  if (typeof window.canvas?.clientCoordinatesFromCanvas === "function") { const p = window.canvas.clientCoordinatesFromCanvas({ x, y }); return { x: p.x, y: p.y }; }
  const t = window.canvas.stage.worldTransform.apply({ x, y });
  const r = window.canvas.app.view.getBoundingClientRect();
  return { x: t.x + r.left, y: t.y + r.top };
}

/** Where a named window sits on screen. */
function windowRect({ title }) {
  const q = String(title).toLowerCase();
  const apps = [...(window.foundry?.applications?.instances?.values?.() ?? []), ...Object.values(window.ui?.windows ?? {})];
  const app = apps.find(a => String(a.title ?? "").toLowerCase().includes(q));
  const el = app?.element?.jquery ? app.element[0] : app?.element;
  const r = el?.getBoundingClientRect?.();
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}

/* ---------- Node side ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MODS = { shift: "Shift", control: "Control", ctrl: "Control", alt: "Alt", meta: "Meta" };

/** Resolve a step's target: a locator (selector, button, text) or a point (at, scene). */
async function locate(client, loc, timeout) {
  const page = client.page;
  if (!loc) return null;
  if (loc.at) return { point: { x: loc.at.x, y: loc.at.y }, how: "at" };
  if (loc.scene) { const p = await client.eval(sceneToClient, loc.scene, { timeout }); return { point: { x: Math.round(p.x), y: Math.round(p.y) }, how: "scene" }; }
  if (loc.selector) return { locator: page.locator(loc.selector).filter({ visible: true }).first(), how: `selector ${loc.selector}` };
  if (loc.button) return { locator: page.getByRole("button", { name: loc.button }).filter({ visible: true }).first(), how: `button "${loc.button}"` };
  if (loc.text) return { locator: page.getByText(loc.text).filter({ visible: true }).first(), how: `text "${loc.text}"` };
  return null;
}

async function pointOf(target, timeout) {
  if (target.point) return target.point;
  const box = await target.locator.boundingBox({ timeout });
  if (!box) throw new Error(`${target.how} isn't visible`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** Run a batch of real input steps on a client. Stops at the first failing step; reports every step. */
export async function act(client, steps, { stepTimeoutMs = 10000, totalMs = 90000 } = {}) {
  const page = client.page, kb = page.keyboard, mouse = page.mouse;
  const t0 = Date.now();
  const before = await client.eval(uiSnapshot, { windows: true, maxChars: 0 });
  const held = new Set();
  const out = [];
  let failed = null;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i], timeout = Math.min(s.timeoutMs ?? stepTimeoutMs, 30000);
    const rec = { step: i, do: s.do };
    const t1 = Date.now();
    try {
      if (Date.now() - t0 > totalMs) throw new Error(`the batch has run for over ${Math.round(totalMs / 1000)} s`);
      const mods = (s.modifiers ?? []).map(m => MODS[String(m).toLowerCase()] ?? m);
      const target = await locate(client, s, timeout);
      const needsTarget = ["click", "dblclick", "rightclick", "hover", "drag", "fill", "select", "scroll"];
      if (needsTarget.includes(s.do) && !target) throw new Error("this step needs a target: selector, button, text, at {x,y} or scene {x,y}");
      switch (s.do) {
        case "click": case "dblclick": case "rightclick": {
          const button = s.do === "rightclick" ? "right" : "left", clickCount = s.do === "dblclick" ? 2 : 1;
          if (target.locator) { rec.point = await pointOf(target, timeout).catch(() => undefined); await target.locator.click({ button, clickCount, modifiers: mods, timeout }); }   /* position first: a clicked button often vanishes */
          else {
            rec.point = target.point;
            for (const m of mods) await kb.down(m);
            try { await mouse.move(target.point.x, target.point.y); await sleep(50); await mouse.click(target.point.x, target.point.y, { button, clickCount }); }
            finally { for (const m of [...mods].reverse()) await kb.up(m); }
          }
          break;
        }
        case "hover": { const p = await pointOf(target, timeout); rec.point = p; await mouse.move(p.x, p.y); break; }
        case "drag": {
          const dest = await locate(client, s.to, timeout);
          if (!dest) throw new Error("drag needs `to`: selector, button, text, at or scene");
          const a = await pointOf(target, timeout), b = await pointOf(dest, timeout);
          rec.from = a; rec.to = b;
          for (const m of mods) await kb.down(m);
          try {
            await mouse.move(a.x, a.y); await sleep(50); await mouse.down(); await sleep(80);
            const n = Math.max(6, s.steps ?? 12);
            for (let k = 1; k <= n; k++) { await mouse.move(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n); await sleep(30); }
            await sleep(80); await mouse.up();
          } finally { for (const m of [...mods].reverse()) await kb.up(m); }
          break;
        }
        case "type": {
          if (target) { const p = await pointOf(target, timeout); await mouse.click(p.x, p.y); rec.point = p; }
          await kb.type(String(s.value ?? ""), { delay: 10 });
          break;
        }
        case "fill": { if (!target.locator) throw new Error("fill needs a selector, button or text target"); await target.locator.fill(String(s.value ?? ""), { timeout }); break; }
        case "select": { if (!target.locator) throw new Error("select needs a selector target"); rec.selected = await target.locator.selectOption(String(s.value ?? ""), { timeout }); break; }
        case "press": { if (!s.key) throw new Error("press needs `key`"); await kb.press(s.key); break; }
        case "keydown": { if (!s.key) throw new Error("keydown needs `key`"); await kb.down(s.key); held.add(s.key); break; }
        case "keyup": { if (!s.key) throw new Error("keyup needs `key`"); await kb.up(s.key); held.delete(s.key); break; }
        case "scroll": { const p = await pointOf(target, timeout); rec.point = p; await mouse.move(p.x, p.y); await mouse.wheel(s.dx ?? 0, s.dy ?? 0); break; }
        case "wait": { await sleep(Math.min(s.ms ?? 500, 10000)); break; }
        default: throw new Error(`unknown step "${s.do}"`);
      }
      rec.ok = true;
    } catch (e) {
      rec.ok = false; rec.error = String(e?.message ?? e).split("\n")[0].slice(0, 300);
      failed = i;
    }
    rec.ms = Date.now() - t1;
    out.push(rec);
    if (failed !== null) break;
  }
  for (const k of held) await kb.up(k).catch(() => {});   /* never leave a key held between calls */
  await sleep(150);
  const after = await client.eval(uiSnapshot, { windows: true, maxChars: 600 }).catch(() => null);
  const opened = after ? after.windows.filter(w => !before.windowIds.includes(w.id)) : [];
  const closed = after ? before.windowIds.filter(id => !after.windowIds.includes(id)) : [];
  const skipped = failed === null ? [] : steps.slice(failed + 1).map((s, k) => ({ step: failed + 1 + k, do: s.do, skipped: true }));
  return { ok: failed === null, ...(failed === null ? {} : { failed, error: out[failed].error }), steps: [...out, ...skipped], opened, closedWindows: closed, notifications: after?.notifications ?? [], ms: Date.now() - t0 };
}

/** Read the screen as text. */
export function read(client, opts) { return client.eval(uiSnapshot, opts); }

/** A JPEG of the page, a window, an element or an area, scaled down to `maxWidth`. Returned, never stored. */
export async function look(client, { region = "screen", title, selector, maxWidth = 1000, quality = 60 } = {}) {
  const page = client.page;
  let clip;
  const vp = page.viewportSize() ?? { width: 1600, height: 1000 };
  if (region === "window") { clip = await client.eval(windowRect, { title: title ?? "" }); if (!clip) throw new Error(`No open window with "${title}" in its title.`); }
  else if (region === "element") { const box = await page.locator(selector).first().boundingBox({ timeout: 5000 }); if (!box) throw new Error(`Nothing visible matches "${selector}".`); clip = box; }
  else if (region && typeof region === "object") clip = region;
  else clip = { x: 0, y: 0, width: vp.width, height: vp.height };
  clip = { x: Math.max(0, Math.floor(clip.x)), y: Math.max(0, Math.floor(clip.y)), width: Math.max(1, Math.ceil(clip.width)), height: Math.max(1, Math.ceil(clip.height)) };
  const scale = Math.min(1, maxWidth / clip.width);
  const cdp = await page.context().newCDPSession(page);
  try {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality, clip: { ...clip, scale }, captureBeyondViewport: false });
    return { data, mimeType: "image/jpeg", width: Math.round(clip.width * scale), height: Math.round(clip.height * scale), clip, bytes: Math.round(data.length * 3 / 4) };
  } finally { await cdp.detach().catch(() => {}); }
}

/** Wait for a dialog, any window, a chat message, a scene change, a selector, a text, or any visible change on screen. */
export async function wait(client, { for: what, selector, text, maxSeconds = 30, frames = false, since } = {}) {
  const t0 = Date.now(), deadline = t0 + Math.min(maxSeconds, 90) * 1000;
  const start = await client.eval(uiProbe, { selector, text });
  let last = what === "screen" ? await look(client, { maxWidth: 400, quality: 40 }) : null;
  const result = extra => ({ happened: true, for: what, afterSeconds: Math.round((Date.now() - t0) / 10) / 100, ...extra });
  while (Date.now() < deadline) {
    await sleep(300);
    const now = await client.eval(uiProbe, { selector, text });
    if (what === "dialog" || what === "window") {
      const fresh = now.windowIds.filter(id => !start.windowIds.includes(id));
      if (fresh.length) {
        const snap = await client.eval(uiSnapshot, { ids: fresh, maxChars: 1500 });
        const hits = what === "dialog" ? snap.windows.filter(w => w.dialog) : snap.windows;
        if (hits.length) return result({ windows: hits, notifications: snap.notifications });
      }
    } else if (what === "chat") {
      const from = since ?? start.lastMessage;
      if (now.lastMessage !== from) return result({ messages: await client.eval(chatAfter, { since: from, limit: 10 }) });
    } else if (what === "scene") {
      if (now.sceneId !== start.sceneId && now.ready) return result({ scene: (await client.eval(uiSnapshot, { windows: false })).scene, sceneId: now.sceneId });
    } else if (what === "selector" || what === "text") {
      if (now.found) return result({ found: selector ?? text });
    } else if (what === "screen") {
      const cur = await look(client, { maxWidth: 400, quality: 40 });
      if (cur.data !== last.data) { const frame = frames ? await look(client, { maxWidth: 800 }) : null; return result({ changed: true, frame }); }
      last = cur;
    } else throw new Error(`unknown wait target "${what}"`);
  }
  return { happened: false, for: what, waitedSeconds: Math.round((Date.now() - t0) / 1000) };
}
