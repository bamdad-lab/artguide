// Art Ear test backend.
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
const VISION_PRICE = 0.0035; // Cloud Vision web detection, per image after the monthly free tier
const LENS_MODEL = "claude-haiku-5-5"; // turns raw image-search results into clean suggestions

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
  if (p === "/api/me" && m === "GET") return json({ name: invite.name, dailyLimit: invite.daily_limit, usedToday: await callsToday(env, invite.code), lens: !!env.GOOGLE_VISION_API_KEY });
  if (p === "/api/messages" && m === "POST") return messages(req, env, invite);
  if (p === "/api/lens" && m === "POST") return json(await lens(req, env, invite));
  if (p === "/api/thumbs" && m === "POST") return json(await thumbs(env, await body(req)));
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
  // The server decides the model, so testers can't choose and every call in one scan matches.
  b.model = await modelForScan(env, invite, req.headers.get("x-scan-id"));
  const model = MODELS[b.model];
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
  await logCall(env, invite.code, b.model, j?.model || null, cost.input, cost.output, cost.searches, cost.usd, r.status);
  return new Response(text, { status: r.status, headers: { "content-type": "application/json", "x-art-ear-model": b.model } });
}

async function modelForScan(env, invite, scanId) {
  if (!scanId || !/^[\w-]{8,64}$/.test(scanId)) throw err(400, "invalid_request", "Missing scan id");
  const row = await env.DB.prepare("SELECT model, code FROM scan_models WHERE scan_id = ?").bind(scanId).first();
  if (row) { if (row.code !== invite.code) throw err(403, "forbidden", "Not your scan"); return row.model; }
  let chosen = MODELS[invite.model] ? invite.model : null;
  if (!chosen) {
    // Balanced: give this scan the model with the fewest scans so far across everyone; break ties at random.
    const counts = Object.fromEntries(Object.keys(MODELS).map((k) => [k, 0]));
    const rows = await env.DB.prepare("SELECT model, COUNT(*) AS n FROM scan_models GROUP BY model").all();
    for (const r of rows.results) if (r.model in counts) counts[r.model] = r.n;
    const least = Math.min(...Object.values(counts));
    const pool = Object.keys(counts).filter((k) => counts[k] === least);
    chosen = pool[crypto.getRandomValues(new Uint32Array(1))[0] % pool.length];
  }
  await env.DB.prepare("INSERT OR IGNORE INTO scan_models (scan_id, code, model, at) VALUES (?, ?, ?, ?)").bind(scanId, invite.code, chosen, Date.now()).run();
  return (await env.DB.prepare("SELECT model FROM scan_models WHERE scan_id = ?").bind(scanId).first()).model;
}

// ---------- image search (Google Cloud Vision web detection) ----------
async function lens(req, env, invite) {
  if (!env.GOOGLE_VISION_API_KEY) return { available: false };
  const used = await callsToday(env, invite.code);
  if (used >= invite.daily_limit) throw err(429, "daily_limit", `Daily limit of ${invite.daily_limit} requests reached. It resets at midnight UTC.`);
  const b = await body(req);
  if (typeof b.photo !== "string" || !b.photo.startsWith("data:image/jpeg;base64,")) throw err(400, "invalid_request", "Missing photo");
  if (b.photo.length > MAX_PHOTO_BYTES * 1.4) throw err(413, "too_large", "Photo too large");
  const vr = await fetch(`${env.VISION_URL || "https://vision.googleapis.com/v1/images:annotate"}?key=${encodeURIComponent(env.GOOGLE_VISION_API_KEY)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ image: { content: b.photo.slice(23) }, features: [{ type: "WEB_DETECTION", maxResults: 20 }] }] }),
  });
  const vj = await vr.json().catch(() => ({}));
  await logCall(env, invite.code, "google-vision", null, 0, 0, 0, vr.ok ? VISION_PRICE : 0, vr.status);
  if (!vr.ok || vj.responses?.[0]?.error) return { available: true, ok: false, error: vj.error?.message || vj.responses?.[0]?.error?.message || "Image search failed" };
  const web = vj.responses?.[0]?.webDetection || {};
  const clean = (t) => String(t || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const pages = (web.pagesWithMatchingImages || []).slice(0, 15).map((pg) => {
    let host = ""; try { host = new URL(pg.url).hostname.replace(/^www\./, ""); } catch (e) {}
    const img = pg.fullMatchingImages?.[0]?.url || pg.partialMatchingImages?.[0]?.url || null;
    return { url: pg.url, title: clean(pg.pageTitle), host, full: (pg.fullMatchingImages || []).length, partial: (pg.partialMatchingImages || []).length, image: img };
  });
  const out = {
    available: true, ok: true,
    bestGuess: (web.bestGuessLabels || []).map((l) => l.label).filter(Boolean),
    entities: (web.webEntities || []).filter((e) => e.description).slice(0, 8).map((e) => ({ name: e.description, score: e.score })),
    pages,
    similar: (web.visuallySimilarImages || []).slice(0, 6).map((i) => i.url),
    candidates: [],
  };
  if (pages.length || out.entities.length) out.candidates = await lensCandidates(env, invite, out);
  return out;
}

// Ask a small, cheap model to turn page titles into up to three clean artwork names.
async function lensCandidates(env, invite, v) {
  const listing = v.pages.map((pg, i) => `${i}. [${pg.host}] ${pg.title} (exact matches: ${pg.full}, partial: ${pg.partial})`).join("\n");
  const prompt = `These are results of a reverse image search on a visitor's photo of an artwork.
Best guess: ${v.bestGuess.join("; ") || "none"}
Web entities: ${v.entities.map((e) => e.name).join("; ") || "none"}
Pages showing the same image:
${listing || "none"}

List up to 3 specific artworks these results point to, most likely first. Use only what the results say: do not add facts.
- Pages with exact matches show the same picture; pages with only partial matches may show a different but similar-looking work. Rank works named on exact-match pages first.
- Prefer works named on museum, collection or encyclopedia pages. Skip shops, posters and generic topics.
- For each work give the page number it came from, or null if it came only from the best guess or web entities.
- If the results don't name a specific artwork, return an empty list.
Reply with JSON only.`;
  const schema = { type: "object", additionalProperties: false, required: ["candidates"], properties: { candidates: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["title", "artist", "page", "evidence"],
    properties: { title: { type: "string" }, artist: { type: ["string", "null"] }, page: { type: ["integer", "null"] }, evidence: { type: "string" } } } } } };
  const r = await fetch(env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: LENS_MODEL, max_tokens: 2000, messages: [{ role: "user", content: prompt }], output_config: { effort: "low", format: { type: "json_schema", schema } } }),
  });
  const j = await r.json().catch(() => null);
  const cost = r.ok && j ? priceOf(j, LENS_MODEL) : { usd: 0, input: 0, output: 0, searches: 0 };
  await logCall(env, invite.code, LENS_MODEL, j?.model || null, cost.input, cost.output, 0, cost.usd, r.status);
  if (!r.ok || !j) return [];
  try {
    const parsed = JSON.parse((j.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""));
    const out = (parsed.candidates || []).slice(0, 3).map((c) => {
      const pg = Number.isInteger(c.page) ? v.pages[c.page] : null;
      // exact: this page shows the same picture. similar: only a look-alike. guess: named by Google with no page.
      const match = pg ? (pg.full > 0 ? "exact" : "similar") : "guess";
      return { title: c.title, artist: c.artist || null, evidence: c.evidence, url: pg?.url || null, host: pg?.host || null, match, image: pg?.full > 0 ? pg.image : null, imageSource: pg?.full > 0 ? pg.host : null };
    });
    const order = { exact: 0, guess: 1, similar: 2 };
    out.sort((a, b) => order[a.match] - order[b.match]);
    // Pages often carry no usable picture; look one up on Wikipedia so people can compare.
    const pics = await thumbs(env, { items: out.filter((c) => !c.image).map((c) => ({ title: c.title, artist: c.artist, url: c.match === "exact" ? c.url : null })) });
    let k = 0;
    for (const c of out) if (!c.image) { const t = pics.items[k++]; if (t?.image) { c.image = t.image; c.imageSource = t.from || "Wikipedia"; } }
    return out;
  } catch (e) { return []; }
}

// ---------- reference pictures from Wikipedia ----------
// Returns a thumbnail only when the article title clearly matches the work, so we don't show the wrong picture.
// Tries, in order: the page's own share picture, a matching Wikipedia article, a matching Wikimedia Commons file.
async function thumbs(env, b) {
  const items = Array.isArray(b.items) ? b.items.slice(0, 6) : [];
  const results = await Promise.all(items.map(async (it) => {
    const title = String(it.title || "").slice(0, 150), artist = String(it.artist || "").slice(0, 100);
    const skip = new Set(Array.isArray(it.skip) ? it.skip : []); // pictures that already failed to load on the phone
    const tries = [() => pageImage(env, it.url), () => wikiThumb(env, title, artist), () => commonsThumb(env, title, artist)];
    for (const t of tries) {
      const r = await t().catch(() => null);
      if (r?.image && !skip.has(r.image)) return r;
    }
    return null;
  }));
  return { items: results.map((r) => r || { image: null }) };
}
// The Open Graph picture a page offers for sharing. Museum collection pages almost always set one.
async function pageImage(env, url) {
  if (!url || !/^https:\/\//.test(url)) return null;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3500);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "Mozilla/5.0 (compatible; ArtEar/0.1; museum audio guide test)", accept: "text/html" }, redirect: "follow" });
    if (!r.ok || !(r.headers.get("content-type") || "").includes("html")) return null;
    const html = (await r.text()).slice(0, 300000);
    const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/i);
    const c = m && m[0].match(/content=["']([^"']+)["']/i);
    if (!c) return null;
    const img = new URL(c[1].replace(/&amp;/g, "&"), r.url).href;
    let host = ""; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch (e) {}
    return /^https:\/\//.test(img) ? { image: img, from: host } : null;
  } finally { clearTimeout(t); }
}
async function commonsThumb(env, title, artist) {
  if (!words(title).length) return null;
  const q = new URLSearchParams({ action: "query", format: "json", generator: "search", gsrsearch: `${title} ${artist}`.trim(), gsrlimit: "5",
    gsrnamespace: "6", prop: "imageinfo", iiprop: "url|mime", iiurlwidth: "320" });
  const r = await fetch(`${env.COMMONS_URL || "https://commons.wikimedia.org/w/api.php"}?${q}`, { headers: { "user-agent": "ArtEar/0.1 (museum audio guide test)" } });
  if (!r.ok) return null;
  const pages = Object.values((await r.json()).query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const want = words(title);
  for (const pg of pages) {
    const info = pg.imageinfo?.[0];
    if (!info?.thumburl || !/^image\/(jpeg|png|webp)/.test(info.mime || "")) continue;
    const have = new Set(words(pg.title.replace(/^File:/, "")));
    if (want.filter((w) => have.has(w)).length / want.length >= 0.6) return { image: info.thumburl, from: "Wikimedia Commons" };
  }
  return null;
}
const words = (t) => String(t || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !["the", "a", "an", "of", "and", "in", "on", "de", "la", "le"].includes(w));
async function wikiThumb(env, title, artist) {
  if (!words(title).length) return null;
  const q = new URLSearchParams({ action: "query", format: "json", generator: "search", gsrsearch: `${title} ${artist} painting`.trim(), gsrlimit: "3",
    prop: "pageimages", piprop: "thumbnail", pithumbsize: "320", gsrnamespace: "0" });
  const r = await fetch(`${env.WIKI_URL || "https://en.wikipedia.org/w/api.php"}?${q}`, { headers: { "user-agent": "ArtEar/0.1 (museum audio guide test)" } });
  if (!r.ok) return null;
  const pages = Object.values((await r.json()).query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const want = words(title);
  for (const pg of pages) {
    const have = new Set(words(pg.title));
    const hit = want.filter((w) => have.has(w)).length / want.length;
    if (hit >= 0.6 && pg.thumbnail?.source) return { image: pg.thumbnail.source, page: pg.title, from: "Wikipedia" };
  }
  return null;
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
    SELECT i.code, i.name, i.daily_limit, i.active, i.created_at, i.model,
      (SELECT COUNT(*) FROM scans s WHERE s.code = i.code) AS scans,
      (SELECT COALESCE(SUM(usd), 0) FROM calls c WHERE c.code = i.code) AS usd,
      (SELECT COUNT(*) FROM calls c WHERE c.code = i.code AND c.at >= ?) AS calls_today
    FROM invites i ORDER BY i.created_at DESC`).bind(day).all();
  const total = await env.DB.prepare("SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS calls FROM calls").first();
  const lensUsd = (await env.DB.prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM calls WHERE model IN ('google-vision', ?)").bind(LENS_MODEL).first()).usd;
  const assigned = (await env.DB.prepare("SELECT model, COUNT(*) AS n FROM scan_models GROUP BY model").all()).results;
  return { invites: rows.results, totalUsd: total.usd, totalCalls: total.calls, spentToday: await spentToday(env), dailyCap: Number(env.DAILY_USD_CAP || 5),
    lensEnabled: !!env.GOOGLE_VISION_API_KEY, lensUsd, assigned, models: Object.keys(MODELS) };
}
async function createInvite(env, b) {
  const name = String(b.name || "").trim().slice(0, 60);
  if (!name) throw err(400, "invalid_request", "Name required");
  const limit = Math.max(1, Math.min(Number(b.dailyLimit) || 100, 500));
  const model = MODELS[b.model] ? b.model : null;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const code = Array.from(bytes, (x) => alphabet[x % alphabet.length]).join("");
  await env.DB.prepare("INSERT INTO invites (code, name, daily_limit, active, created_at, model) VALUES (?, ?, ?, 1, ?, ?)").bind(code, name, limit, Date.now(), model).run();
  return { code, name, dailyLimit: limit, model };
}
async function updateInvite(env, code, b) {
  const sets = [], args = [];
  if (typeof b.active === "boolean") { sets.push("active = ?"); args.push(b.active ? 1 : 0); }
  if (b.dailyLimit != null) { sets.push("daily_limit = ?"); args.push(Math.max(1, Math.min(Number(b.dailyLimit) || 60, 500))); }
  if (typeof b.name === "string" && b.name.trim()) { sets.push("name = ?"); args.push(b.name.trim().slice(0, 60)); }
  if (b.model !== undefined) { sets.push("model = ?"); args.push(MODELS[b.model] ? b.model : null); }
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
const logCall = (env, code, model, served, input, output, searches, usd, status) =>
  env.DB.prepare("INSERT INTO calls (code, at, model, served, input_tokens, output_tokens, searches, usd, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(code, Date.now(), model, served, input, output, searches, usd, status).run();
async function requireInvite(req, env) {
  const code = bearer(req).toUpperCase();
  if (!/^[A-Z0-9]{6,20}$/.test(code)) throw err(401, "unauthorized", "Invite code missing or malformed");
  const inv = await env.DB.prepare("SELECT code, name, daily_limit, active, model FROM invites WHERE code = ?").bind(code).first();
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
    "access-control-allow-headers": "authorization, content-type, x-scan-id",
    "access-control-expose-headers": "x-art-ear-model",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}
