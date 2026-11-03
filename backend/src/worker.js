// Gallery Ear test backend.
// Holds the Anthropic key, checks invite codes, caps spending, and stores everyone's scans.

const MODELS = {
  "claude-opus-5-5": { price: [4, 20], fallback: true },
  "claude-sonnet-5-5": { price: [2, 10], fallback: true },
  "claude-haiku-5-5": { price: [0.1, 0.5], over100k: [0.5, 2.5], fallback: false },
};
// A refusal fallback can hand a request to one of these, so price by the model that served it.
const OTHER_PRICES = { "claude-opus-5": [5, 25], "claude-opus-4-8": [5, 25], "claude-opus-4-7": [5, 25], "claude-sonnet-5": [2, 10], "claude-fable-5-1": [10, 50] };
const SEARCH_TOOLS = new Set(["web_search_20260209", "web_search_20250305"]);
const SEARCH_PRICE = 0.01;
const MAX_TOKENS = 16000;
const MAX_PHOTO_BYTES = 1_500_000;

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const res = await route(req, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const status = e.status || 500;
      return json({ error: { type: e.type || "server_error", message: status === 500 ? "Server error" : e.message } }, status, cors);
    }
  },
};

async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "");
  const m = req.method;

  if (p === "/api/health") return json({ ok: true });

  if (p.startsWith("/api/admin/")) {
    requireAdmin(req, env);
    if (p === "/api/admin/invites" && m === "GET") return json(await adminInvites(env));
    if (p === "/api/admin/invites" && m === "POST") return json(await createInvite(env, await body(req)), 201);
    let mm;
    if ((mm = p.match(/^\/api\/admin\/invites\/([A-Z0-9]+)$/)) && m === "PATCH") return json(await updateInvite(env, mm[1], await body(req)));
    if (p === "/api/admin/scans" && m === "GET") return json(await adminScans(env, url.searchParams.get("photos") === "1"));
    if ((mm = p.match(/^\/api\/admin\/photos\/([\w-]+)$/)) && m === "GET") return photo(env, mm[1], null);
    throw err(404, "not_found", "Unknown admin route");
  }

  const invite = await requireInvite(req, env);
  if (p === "/api/me" && m === "GET") return json({ name: invite.name, dailyLimit: invite.daily_limit, usedToday: await callsToday(env, invite.code) });
  if (p === "/api/messages" && m === "POST") return messages(req, env, invite);
  if (p === "/api/scans" && m === "GET") {
    const rows = await env.DB.prepare("SELECT id, data, photo IS NOT NULL AS has_photo FROM scans WHERE code = ? ORDER BY created_at DESC").bind(invite.code).all();
    return json(rows.results.map((r) => ({ ...JSON.parse(r.data), id: r.id, hasPhoto: !!r.has_photo })));
  }
  let mm;
  if ((mm = p.match(/^\/api\/scans\/([\w-]{8,64})$/))) {
    const id = mm[1];
    const existing = await env.DB.prepare("SELECT code FROM scans WHERE id = ?").bind(id).first();
    if (existing && existing.code !== invite.code) throw err(403, "forbidden", "Not your scan");
    if (m === "PUT") return json(await putScan(env, invite.code, id, await body(req), !!existing));
    if (m === "DELETE") { await env.DB.prepare("DELETE FROM scans WHERE id = ? AND code = ?").bind(id, invite.code).run(); return json({ deleted: true }); }
  }
  if ((mm = p.match(/^\/api\/photos\/([\w-]+)$/)) && m === "GET") return photo(env, mm[1], invite.code);
  throw err(404, "not_found", "Unknown route");
}

// ---------- Claude proxy ----------
async function messages(req, env, invite) {
  const used = await callsToday(env, invite.code);
  if (used >= invite.daily_limit) throw err(429, "daily_limit", `Daily limit of ${invite.daily_limit} requests reached. It resets at midnight UTC.`);
  const spent = await spentToday(env);
  if (spent >= Number(env.DAILY_USD_CAP || 5)) throw err(429, "budget", "The test has reached today's spending cap. Try again tomorrow.");

  const b = await body(req);
  const model = MODELS[b.model];
  if (!model) throw err(400, "invalid_request", "Model not allowed");
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > 8) throw err(400, "invalid_request", "Bad messages");
  const tools = (b.tools || []).filter((t) => SEARCH_TOOLS.has(t.type)).map((t) => ({ type: t.type, name: "web_search", max_uses: Math.min(Number(t.max_uses) || 6, 6) }));
  const upstream = {
    model: b.model,
    max_tokens: Math.min(Number(b.max_tokens) || 4000, MAX_TOKENS),
    messages: b.messages,
    ...(b.output_config ? { output_config: pick(b.output_config, ["effort", "format"]) } : {}),
    ...(tools.length ? { tools } : {}),
  };
  const headers = { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" };
  if (model.fallback) { upstream.fallbacks = "default"; headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; }

  const r = await fetch(env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify(upstream) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (e) {}
  const cost = r.ok && j ? priceOf(j, b.model) : { usd: 0, input: 0, output: 0, searches: 0 };
  await env.DB.prepare("INSERT INTO calls (code, at, model, served, input_tokens, output_tokens, searches, usd, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(invite.code, Date.now(), b.model, j?.model || null, cost.input, cost.output, cost.searches, cost.usd, r.status).run();
  return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
}

function priceOf(j, requested) {
  const u = j.usage || {};
  const input = u.input_tokens || 0, output = u.output_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  const searches = u.server_tool_use?.web_search_requests || 0;
  const served = j.model || requested;
  const m = MODELS[served];
  let p = m ? (m.over100k && input + cr + cw > 100000 ? m.over100k : m.price) : null;
  if (!p) { const k = Object.keys(OTHER_PRICES).find((x) => served.startsWith(x)); p = k ? OTHER_PRICES[k] : MODELS[requested].price; }
  const usd = (input * p[0] + cw * p[0] * 1.25 + cr * p[0] * 0.1 + output * p[1]) / 1e6 + searches * SEARCH_PRICE;
  return { usd, input: input + cr + cw, output, searches };
}

// ---------- scans ----------
async function putScan(env, code, id, b, exists) {
  const data = b.data && typeof b.data === "object" ? b.data : null;
  if (!data) throw err(400, "invalid_request", "Missing data");
  delete data.photo;
  const text = JSON.stringify(data);
  if (text.length > 200_000) throw err(413, "too_large", "Scan record too large");
  let photoBytes = null;
  if (typeof b.photo === "string" && b.photo.startsWith("data:image/jpeg;base64,")) {
    const raw = atob(b.photo.slice(23));
    if (raw.length > MAX_PHOTO_BYTES) throw err(413, "too_large", "Photo too large");
    photoBytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  const now = Date.now();
  if (exists) {
    if (photoBytes) await env.DB.prepare("UPDATE scans SET data = ?, photo = ?, updated_at = ? WHERE id = ? AND code = ?").bind(text, photoBytes, now, id, code).run();
    else await env.DB.prepare("UPDATE scans SET data = ?, updated_at = ? WHERE id = ? AND code = ?").bind(text, now, id, code).run();
  } else {
    await env.DB.prepare("INSERT INTO scans (id, code, data, photo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, code, text, photoBytes, Number(data.at) || now, now).run();
  }
  return { saved: true, photo: !!photoBytes };
}

async function photo(env, id, code) {
  const row = code
    ? await env.DB.prepare("SELECT photo FROM scans WHERE id = ? AND code = ?").bind(id, code).first()
    : await env.DB.prepare("SELECT photo FROM scans WHERE id = ?").bind(id).first();
  if (!row || !row.photo) throw err(404, "not_found", "No photo");
  return new Response(new Uint8Array(row.photo), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" } });
}

// ---------- admin ----------
async function adminInvites(env) {
  const day = startOfDay();
  const rows = await env.DB.prepare(`
    SELECT i.code, i.name, i.daily_limit, i.active, i.created_at,
      (SELECT COUNT(*) FROM scans s WHERE s.code = i.code) AS scans,
      (SELECT COALESCE(SUM(usd), 0) FROM calls c WHERE c.code = i.code) AS usd,
      (SELECT COUNT(*) FROM calls c WHERE c.code = i.code AND c.at >= ?) AS calls_today
    FROM invites i ORDER BY i.created_at DESC`).bind(day).all();
  const total = await env.DB.prepare("SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS calls FROM calls").first();
  return { invites: rows.results, totalUsd: total.usd, totalCalls: total.calls, spentToday: await spentToday(env), dailyCap: Number(env.DAILY_USD_CAP || 5) };
}
async function createInvite(env, b) {
  const name = String(b.name || "").trim().slice(0, 60);
  if (!name) throw err(400, "invalid_request", "Name required");
  const limit = Math.max(1, Math.min(Number(b.dailyLimit) || 60, 500));
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const code = Array.from(bytes, (x) => alphabet[x % alphabet.length]).join("");
  await env.DB.prepare("INSERT INTO invites (code, name, daily_limit, active, created_at) VALUES (?, ?, ?, 1, ?)").bind(code, name, limit, Date.now()).run();
  return { code, name, dailyLimit: limit };
}
async function updateInvite(env, code, b) {
  const sets = [], args = [];
  if (typeof b.active === "boolean") { sets.push("active = ?"); args.push(b.active ? 1 : 0); }
  if (b.dailyLimit != null) { sets.push("daily_limit = ?"); args.push(Math.max(1, Math.min(Number(b.dailyLimit) || 60, 500))); }
  if (typeof b.name === "string" && b.name.trim()) { sets.push("name = ?"); args.push(b.name.trim().slice(0, 60)); }
  if (!sets.length) throw err(400, "invalid_request", "Nothing to change");
  await env.DB.prepare(`UPDATE invites SET ${sets.join(", ")} WHERE code = ?`).bind(...args, code).run();
  return { updated: true };
}
async function adminScans(env, withPhotos) {
  const rows = await env.DB.prepare(`SELECT s.id, s.code, i.name, s.data, s.photo IS NOT NULL AS has_photo${withPhotos ? ", s.photo" : ""}
    FROM scans s LEFT JOIN invites i ON i.code = s.code ORDER BY s.created_at DESC`).all();
  return rows.results.map((r) => ({
    ...JSON.parse(r.data), id: r.id, invite: r.code, person: r.name, hasPhoto: !!r.has_photo,
    ...(withPhotos && r.photo ? { photo: "data:image/jpeg;base64," + b64(new Uint8Array(r.photo)) } : {}),
  }));
}

// ---------- helpers ----------
async function requireInvite(req, env) {
  const code = bearer(req).toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(code)) throw err(401, "unauthorized", "Invite code missing or malformed");
  const inv = await env.DB.prepare("SELECT code, name, daily_limit, active FROM invites WHERE code = ?").bind(code).first();
  if (!inv) throw err(401, "unauthorized", "Unknown invite code");
  if (!inv.active) throw err(403, "disabled", "This invite has been switched off");
  return inv;
}
function requireAdmin(req, env) {
  const t = bearer(req);
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 12 || !safeEqual(t, env.ADMIN_TOKEN)) throw err(401, "unauthorized", "Admin password wrong");
}
const bearer = (req) => (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
function safeEqual(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
const startOfDay = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
async function callsToday(env, code) { return (await env.DB.prepare("SELECT COUNT(*) AS n FROM calls WHERE code = ? AND at >= ?").bind(code, startOfDay()).first()).n; }
async function spentToday(env) { return (await env.DB.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM calls WHERE at >= ?").bind(startOfDay()).first()).usd; }
async function body(req) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 6_000_000) throw err(413, "too_large", "Request too large");
  try { return await req.json(); } catch (e) { throw err(400, "invalid_request", "Body must be JSON"); }
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
function err(status, type, message) { const e = new Error(message); e.status = status; e.type = type; return e; }
function json(data, status = 200, headers = {}) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } }); }
function corsHeaders(req, env) {
  const origin = req.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    "access-control-allow-origin": allowed.includes(origin) ? origin : allowed[0] || "",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}
