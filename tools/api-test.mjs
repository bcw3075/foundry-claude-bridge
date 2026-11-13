/* The API usage test (Encounter Builder's API route, step 1): send recorded monster turns to two Claude models through the Claude API and
   write down what each answered, how many tokens it used, how long it took and what it cost. Nothing happens in Foundry: this only reads one
   file of recorded turns from it.

   Run it yourself on the bridge's PC, from the bridge's folder:   node tools/api-test.mjs
   Needs "anthropicApiKey" in config.json (the owner puts it there; this script never prints or stores it).

   It reads <foundryUrl>/assets/api-test/situations.json ({ system, ask, situations: [{ id, title, event }] }), sends each situation to each
   model RUNS times (the system prompt cached), and writes api-test-results/results.json beside this folder after every call, so a stopped
   run keeps what it had. It stops before a call that could take the total past CEILING dollars, and says so. */
import fs from "node:fs";
import path from "node:path";
import { loadConfig, ROOT } from "../src/config.mjs";

const CEILING = 5, RUNS = 3, MAX_TOKENS = 4000;
const MODELS = { "claude-sonnet-5-5": "Sonnet 5.5", "claude-opus-5-5": "Opus 5.5" };
/* dollars per million tokens, checked 2026-11-12: [fresh input, 5-minute cache write, cache read, output]. Sonnet's cache read is listed as
   $0.10 in some places and $0.20 in others: the higher is used, so the ceiling stays safe. */
const PRICE = { "claude-sonnet-5-5": [2, 2.5, 0.2, 10], "claude-opus-5-5": [4, 5, 0.2, 20] };
const OUT_DIR = path.join(ROOT, "api-test-results"), OUT = path.join(OUT_DIR, "results.json");

const cfg = loadConfig(), key = cfg.anthropicApiKey;
if (!key || typeof key !== "string") { console.log('No "anthropicApiKey" in config.json. Add it there (inside the braces) and run this again.'); process.exit(1); }
const cost = (model, u) => { const p = PRICE[model]; return ((u.input_tokens ?? 0) * p[0] + (u.cache_creation_input_tokens ?? 0) * p[1] + (u.cache_read_input_tokens ?? 0) * p[2] + (u.output_tokens ?? 0) * p[3]) / 1e6; };
/* the most one call could cost: every prompt token written to the cache fresh, and the whole answer allowance used */
const worst = (model, chars) => { const p = PRICE[model]; return (Math.ceil(chars / 2.5) * p[1] + MAX_TOKENS * p[3]) / 1e6; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(model, system, user, maxTokens = MAX_TOKENS) {
  const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: user }], ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}) };
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body) });
    const seconds = (Date.now() - t0) / 1000, json = await res.json().catch(() => ({}));
    if (res.ok) return { seconds, json };
    const msg = json?.error?.message ?? res.statusText;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { console.log(`  (the API answered ${res.status}: ${msg}; trying again in ${10 * (attempt + 1)} s)`); await sleep(10000 * (attempt + 1)); continue; }
    throw new Error(`The API answered ${res.status}: ${msg}`);
  }
}
/* the JSON object in an answer: the whole text, or the first {...} in it (a model may wrap it in a code fence) */
function planOf(text) {
  const t = String(text ?? "").trim(); try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

const out = { started: new Date().toISOString(), ceiling: CEILING, prices: PRICE, models: MODELS, check: null, calls: [], spent: 0, stopped: null };
const save = () => { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); };

console.log("API usage test. Results go to", OUT);
let data;
try { const r = await fetch(`${cfg.foundryUrl.replace(/\/+$/, "")}/assets/api-test/situations.json`, { cache: "no-store" }); if (!r.ok) throw new Error(`Foundry answered ${r.status}`); data = await r.json(); }
catch (e) { console.log("Couldn't read the recorded turns from Foundry:", e.message, "(is Foundry running?)"); process.exit(1); }
console.log(`${data.situations.length} situations, ${Object.keys(MODELS).length} models, ${RUNS} runs each; the system prompt is ${data.system.length} characters.`);

/* 1. can this PC reach the API at all: one tiny call */
try { const { seconds, json } = await call("claude-sonnet-5-5", null, "Reply with the single word: ok", 5); const c = cost("claude-sonnet-5-5", json.usage ?? {});
  out.check = { ok: true, seconds, answer: json.content?.map(x => x.text).join("") ?? "", usage: json.usage, dollars: c }; out.spent += c; save();
  console.log(`Reached the API in ${seconds.toFixed(1)} s (answer: "${out.check.answer.trim()}").`); }
catch (e) { out.check = { ok: false, error: e.message }; save(); console.log("Couldn't reach the API:", e.message); process.exit(1); }

/* 2. the runs: run by run, so if the ceiling stops it early every situation and model has had a turn */
outer: for (let run = 1; run <= RUNS; run++) for (const s of data.situations) for (const model of Object.keys(MODELS)) {
  const user = `${data.ask}\n\n${JSON.stringify(s.event)}`, w = worst(model, data.system.length + user.length);
  if (out.spent + w > CEILING) { out.stopped = `Stopped before run ${run} of ${s.id} on ${MODELS[model]}: it could have taken the total ($${out.spent.toFixed(3)}) past $${CEILING}.`; console.log(out.stopped); break outer; }
  process.stdout.write(`Run ${run}, ${s.id}, ${MODELS[model]}: `);
  try { const { seconds, json } = await call(model, data.system, user), u = json.usage ?? {}, c = cost(model, u), text = (json.content ?? []).filter(x => x.type === "text").map(x => x.text).join("");
    out.spent += c; out.calls.push({ run, situation: s.id, title: s.title, model, seconds, usage: u, dollars: c, stop: json.stop_reason, text, plan: planOf(text) });
    console.log(`${seconds.toFixed(1)} s, ${u.cache_read_input_tokens ?? 0} cached + ${(u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)} fresh in, ${u.output_tokens ?? 0} out, $${c.toFixed(4)} (total $${out.spent.toFixed(3)})`); }
  catch (e) { out.calls.push({ run, situation: s.id, model, error: e.message }); console.log("failed:", e.message); }
  save();
}
out.finished = new Date().toISOString(); save();
console.log(`Done: ${out.calls.length} calls, $${out.spent.toFixed(3)} in all. Tell Angel it's finished.`);
