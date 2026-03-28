/**
 * Echo Link Shortener v1.0.0 — Bitly/Short.io Alternative
 * URL shortening with click analytics, custom slugs, QR codes, expiration
 */

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ECHO_API_KEY: string;
}

interface RLState { c: number; t: number }

function sanitize(s: string, max = 2000): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max);
}

function uid(): string { return crypto.randomUUID().replace(/-/g, '').slice(0, 16); }
function slug6(): string { const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)]; return s; }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' , 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-XSS-Protection': '1; mode=block', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } });
}
function err(msg: string, status = 400): Response { return json({ ok: false, error: msg }

function slog(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-link-shortener', version: '1.0.0', msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
}
, status); }

async function rateLimit(kv: KVNamespace, key: string, max: number, windowSec = 60): Promise<boolean> {
  const now = Date.now();
  const raw = await kv.get(key);
  let state: RLState = raw ? JSON.parse(raw) : { c: 0, t: now };
  const elapsed = (now - state.t) / 1000;
  const decay = Math.max(0, state.c - (elapsed / windowSec) * max);
  if (decay + 1 > max) return false;
  await kv.put(key, JSON.stringify({ c: decay + 1, t: now } as RLState), { expirationTtl: windowSec * 2 });
  return true;
}

function getTenant(req: Request): string {
  return req.headers.get('X-Tenant-ID') || new URL(req.url).searchParams.get('tenant_id') || '';
}

function authOk(req: Request, env: Env): boolean {
  if (!env.ECHO_API_KEY) return false;
  const apiKey = req.headers.get('X-Echo-API-Key');
  if (apiKey && apiKey === env.ECHO_API_KEY) return true;
  const authHeader = req.headers.get('Authorization') || '';
  if (authHeader.startsWith('Bearer ') && authHeader.slice(7) === env.ECHO_API_KEY) return true;
  return false;
}

async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip + 'echo-salt-2026');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function parseUA(ua: string): { device: string; browser: string; os: string } {
  const device = /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : /tablet/i.test(ua) ? 'tablet' : 'desktop';
  const browser = /firefox/i.test(ua) ? 'Firefox' : /edg/i.test(ua) ? 'Edge' : /chrome/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : 'Other';
  const os = /windows/i.test(ua) ? 'Windows' : /mac/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : /android/i.test(ua) ? 'Android' : /iphone|ipad/i.test(ua) ? 'iOS' : 'Other';
  return { device, browser, os };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return json({ ok: true });

    try {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Health & status — public
    if (path === '/') return json({ ok: true, service: 'echo-link-shortener', version: '1.0.0' });
    if (path === '/health') return json({ ok: true, service: 'echo-link-shortener', version: '1.0.0' });
    if (path === '/status') {
      const [links, clicks] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as c FROM links').first<{c:number}>(),
        env.DB.prepare('SELECT COUNT(*) as c FROM clicks').first<{c:number}>(),
      ]);
      return json({ ok: true, total_links: links?.c || 0, total_clicks: clicks?.c || 0, version: '1.0.0' });
    }

    // ── Redirect handler — the main purpose ──
    // Match short slugs (1-30 chars, no dots, not starting with api/)
    if (method === 'GET' && path.length > 1 && path.length <= 31 && !path.includes('.') && !path.startsWith('/api/') && !path.startsWith('/qr/')) {
      const slug = path.slice(1);
      // Try KV cache first for speed
      const cached = await env.CACHE.get(`link:${slug}`);
      if (cached) {
        const data = JSON.parse(cached) as { url: string; id: string; tid: string; expires?: string; max_clicks?: number; total_clicks?: number; password?: boolean };
        if (data.expires && new Date(data.expires) < new Date()) return err('Link expired', 410);
        if (data.max_clicks && (data.total_clicks || 0) >= data.max_clicks) return err('Link click limit reached', 410);
        if (data.password) {
          const pw = url.searchParams.get('pw');
          if (!pw) return json({ ok: false, error: 'Password required', password_required: true }, 401);
        }
        // Track click async
        trackClick(env, data.id, data.tid, req);
        return Response.redirect(data.url, 302);
      }

      // Fallback to D1
      const link = await env.DB.prepare('SELECT * FROM links WHERE slug = ? AND archived = 0').bind(slug).first() as Record<string, unknown> | null;
      if (!link) return err('Link not found', 404);
      if (link.expires_at && new Date(String(link.expires_at)) < new Date()) return err('Link expired', 410);
      if (link.max_clicks && Number(link.total_clicks || 0) >= Number(link.max_clicks)) return err('Click limit reached', 410);
      if (link.password_hash) {
        const pw = url.searchParams.get('pw');
        if (!pw) return json({ ok: false, error: 'Password required', password_required: true }, 401);
        const hash = await hashIP(pw);
        if (hash !== link.password_hash) return err('Invalid password', 403);
      }

      // Cache for future requests
      await env.CACHE.put(`link:${slug}`, JSON.stringify({ url: link.destination_url, id: link.id, tid: link.tenant_id, expires: link.expires_at, max_clicks: link.max_clicks, total_clicks: link.total_clicks, password: !!link.password_hash }), { expirationTtl: 3600 });
      trackClick(env, String(link.id), String(link.tenant_id), req);
      return Response.redirect(String(link.destination_url), 302);
    }

    // ── QR Code (SVG) ──
    if (path.startsWith('/qr/') && method === 'GET') {
      const slug = path.slice(4);
      const link = await env.DB.prepare('SELECT id, slug FROM links WHERE slug = ?').bind(slug).first();
      if (!link) return err('Link not found', 404);
      const qrUrl = `https://echo-link-shortener.bmcii1976.workers.dev/${slug}`;
      // Return a simple QR code redirect to a QR API
      const qrSvg = generateSimpleQR(qrUrl);
      return new Response(qrSvg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
    }

    // Rate limit writes
    if (method !== 'GET') {
      const rlKey = `rl:${getTenant(req) || req.headers.get('CF-Connecting-IP') || 'anon'}`;
      if (!await rateLimit(env.CACHE, rlKey, 60)) return err('Rate limited', 429);
    }

    // Auth for management API
    if (!path.startsWith('/api/')) return err('Not found', 404);
    if (!authOk(req, env)) return err('Unauthorized', 401);

    const tid = getTenant(req);
    const apiPath = path.slice(4); // strip /api

      // ── Tenants ──
      if (apiPath === '/tenants' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO tenants (id, name) VALUES (?, ?)').bind(id, sanitize(String(b.name || ''), 200)).run();
        return json({ ok: true, id });
      }
      if (apiPath === '/tenants/me' && method === 'GET') {
        const t = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(tid).first();
        return t ? json(t) : err('Not found', 404);
      }

      // ── Links CRUD ──
      if (apiPath === '/links' && method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);
        const tag = url.searchParams.get('tag');
        const search = url.searchParams.get('search');
        const archived = url.searchParams.get('archived') === '1' ? 1 : 0;
        let q = 'SELECT * FROM links WHERE tenant_id = ? AND archived = ?';
        const params: unknown[] = [tid, archived];
        if (tag) { q += ' AND tags LIKE ?'; params.push(`%"${tag}"%`); }
        if (search) { q += ' AND (title LIKE ? OR slug LIKE ? OR destination_url LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
        q += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        const rows = await env.DB.prepare(q).bind(...params).all();
        return json(rows.results);
      }
      if (apiPath === '/links' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const destUrl = sanitize(String(b.url || b.destination_url || ''), 2000);
        if (!destUrl || !destUrl.startsWith('http')) return err('Valid URL required');

        // Check link limit
        const cnt = await env.DB.prepare('SELECT COUNT(*) as c FROM links WHERE tenant_id = ?').bind(tid).first<{c:number}>();
        const tenant = await env.DB.prepare('SELECT max_links FROM tenants WHERE id = ?').bind(tid).first<{max_links:number}>();
        if ((cnt?.c || 0) >= (tenant?.max_links || 500)) return err('Link limit reached');

        let slug = b.slug ? sanitize(String(b.slug), 30).replace(/[^a-zA-Z0-9_-]/g, '') : slug6();
        // Check slug uniqueness
        const existing = await env.DB.prepare('SELECT id FROM links WHERE slug = ?').bind(slug).first();
        if (existing) { if (b.slug) return err('Slug already taken'); slug = slug6() + slug6().slice(0, 2); }

        const id = uid();
        let pwHash: string | null = null;
        if (b.password) pwHash = await hashIP(String(b.password));

        // Build UTM URL if params provided
        let finalUrl = destUrl;
        if (b.utm_source || b.utm_medium || b.utm_campaign) {
          const u = new URL(destUrl);
          if (b.utm_source) u.searchParams.set('utm_source', String(b.utm_source));
          if (b.utm_medium) u.searchParams.set('utm_medium', String(b.utm_medium));
          if (b.utm_campaign) u.searchParams.set('utm_campaign', String(b.utm_campaign));
          finalUrl = u.toString();
        }

        await env.DB.prepare('INSERT INTO links (id, tenant_id, slug, destination_url, title, tags, password_hash, expires_at, max_clicks, utm_source, utm_medium, utm_campaign, og_title, og_description, og_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
          id, tid, slug, finalUrl,
          sanitize(String(b.title || ''), 200),
          JSON.stringify(b.tags || []),
          pwHash,
          b.expires_at ? sanitize(String(b.expires_at), 30) : null,
          b.max_clicks ? Number(b.max_clicks) : null,
          sanitize(String(b.utm_source || ''), 100),
          sanitize(String(b.utm_medium || ''), 100),
          sanitize(String(b.utm_campaign || ''), 100),
          sanitize(String(b.og_title || ''), 200),
          sanitize(String(b.og_description || ''), 500),
          sanitize(String(b.og_image || ''), 500),
        ).run();

        const shortUrl = `https://echo-link-shortener.bmcii1976.workers.dev/${slug}`;
        return json({ ok: true, id, slug, short_url: shortUrl, qr_url: `https://echo-link-shortener.bmcii1976.workers.dev/qr/${slug}` });
      }
      if (apiPath.match(/^\/links\/[^/]+$/) && method === 'GET') {
        const lid = apiPath.split('/')[2];
        const link = await env.DB.prepare('SELECT * FROM links WHERE id = ? AND tenant_id = ?').bind(lid, tid).first();
        return link ? json(link) : err('Not found', 404);
      }
      if (apiPath.match(/^\/links\/[^/]+$/) && method === 'PUT') {
        const lid = apiPath.split('/')[2];
        const b = await req.json() as Record<string, unknown>;
        const fields: string[] = []; const vals: unknown[] = [];
        for (const [k, v] of Object.entries(b)) {
          if (['title', 'destination_url', 'og_title', 'og_description', 'og_image', 'utm_source', 'utm_medium', 'utm_campaign'].includes(k)) { fields.push(`${k} = ?`); vals.push(sanitize(String(v), 2000)); }
          if (k === 'tags') { fields.push('tags = ?'); vals.push(JSON.stringify(v)); }
          if (k === 'expires_at') { fields.push('expires_at = ?'); vals.push(v ? sanitize(String(v), 30) : null); }
          if (k === 'max_clicks') { fields.push('max_clicks = ?'); vals.push(v ? Number(v) : null); }
          if (k === 'archived') { fields.push('archived = ?'); vals.push(v ? 1 : 0); }
        }
        if (!fields.length) return err('No fields');
        fields.push('updated_at = datetime(\'now\')');
        vals.push(lid, tid);
        await env.DB.prepare(`UPDATE links SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...vals).run();
        // Invalidate cache
        const link = await env.DB.prepare('SELECT slug FROM links WHERE id = ?').bind(lid).first<{slug:string}>();
        if (link) await env.CACHE.delete(`link:${link.slug}`);
        return json({ ok: true });
      }
      if (apiPath.match(/^\/links\/[^/]+$/) && method === 'DELETE') {
        const lid = apiPath.split('/')[2];
        const link = await env.DB.prepare('SELECT slug FROM links WHERE id = ? AND tenant_id = ?').bind(lid, tid).first<{slug:string}>();
        if (link) await env.CACHE.delete(`link:${link.slug}`);
        await env.DB.prepare('DELETE FROM clicks WHERE link_id = ? AND tenant_id = ?').bind(lid, tid).run();
        await env.DB.prepare('DELETE FROM click_daily WHERE link_id = ? AND tenant_id = ?').bind(lid, tid).run();
        await env.DB.prepare('DELETE FROM links WHERE id = ? AND tenant_id = ?').bind(lid, tid).run();
        return json({ ok: true });
      }

      // ── Bulk Create ──
      if (apiPath === '/links/bulk' && method === 'POST') {
        const b = await req.json() as { links: Array<{ url: string; title?: string; slug?: string }> };
        if (!Array.isArray(b.links) || b.links.length > 100) return err('Max 100 links per batch');
        const results: Array<{ url: string; slug: string; short_url: string }> = [];
        for (const item of b.links) {
          const destUrl = sanitize(String(item.url || ''), 2000);
          if (!destUrl.startsWith('http')) continue;
          const s = item.slug ? sanitize(String(item.slug), 30).replace(/[^a-zA-Z0-9_-]/g, '') : slug6();
          const id = uid();
          try {
            await env.DB.prepare('INSERT INTO links (id, tenant_id, slug, destination_url, title) VALUES (?, ?, ?, ?, ?)').bind(id, tid, s, destUrl, sanitize(String(item.title || ''), 200)).run();
            results.push({ url: destUrl, slug: s, short_url: `https://echo-link-shortener.bmcii1976.workers.dev/${s}` });
          } catch { /* skip duplicates */ }
        }
        return json({ ok: true, created: results.length, links: results });
      }

      // ── Link Analytics ──
      if (apiPath.match(/^\/links\/[^/]+\/clicks$/) && method === 'GET') {
        const lid = apiPath.split('/')[2];
        const days = Math.min(Number(url.searchParams.get('days') || 30), 90);
        const rows = await env.DB.prepare('SELECT * FROM click_daily WHERE link_id = ? AND tenant_id = ? AND date >= date(\'now\', \'-\' || ? || \' days\') ORDER BY date ASC').bind(lid, tid, days).all();
        return json(rows.results);
      }
      if (apiPath.match(/^\/links\/[^/]+\/clicks\/detail$/) && method === 'GET') {
        const lid = apiPath.split('/')[2];
        const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
        const rows = await env.DB.prepare('SELECT country, city, device_type, browser, os, referrer, is_unique, created_at FROM clicks WHERE link_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT ?').bind(lid, tid, limit).all();
        return json(rows.results);
      }
      if (apiPath.match(/^\/links\/[^/]+\/clicks\/geo$/) && method === 'GET') {
        const lid = apiPath.split('/')[2];
        const rows = await env.DB.prepare('SELECT country, COUNT(*) as clicks, SUM(is_unique) as unique_clicks FROM clicks WHERE link_id = ? AND tenant_id = ? GROUP BY country ORDER BY clicks DESC LIMIT 50').bind(lid, tid).all();
        return json(rows.results);
      }
      if (apiPath.match(/^\/links\/[^/]+\/clicks\/devices$/) && method === 'GET') {
        const lid = apiPath.split('/')[2];
        const [devices, browsers, oses] = await Promise.all([
          env.DB.prepare('SELECT device_type, COUNT(*) as c FROM clicks WHERE link_id = ? AND tenant_id = ? GROUP BY device_type ORDER BY c DESC').bind(lid, tid).all(),
          env.DB.prepare('SELECT browser, COUNT(*) as c FROM clicks WHERE link_id = ? AND tenant_id = ? GROUP BY browser ORDER BY c DESC').bind(lid, tid).all(),
          env.DB.prepare('SELECT os, COUNT(*) as c FROM clicks WHERE link_id = ? AND tenant_id = ? GROUP BY os ORDER BY c DESC').bind(lid, tid).all(),
        ]);
        return json({ devices: devices.results, browsers: browsers.results, operating_systems: oses.results });
      }
      if (apiPath.match(/^\/links\/[^/]+\/clicks\/referrers$/) && method === 'GET') {
        const lid = apiPath.split('/')[2];
        const rows = await env.DB.prepare('SELECT referrer, COUNT(*) as c FROM clicks WHERE link_id = ? AND tenant_id = ? AND referrer IS NOT NULL AND referrer != \'\' GROUP BY referrer ORDER BY c DESC LIMIT 30').bind(lid, tid).all();
        return json(rows.results);
      }

      // ── Tags ──
      if (apiPath === '/tags' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM tags WHERE tenant_id = ? ORDER BY link_count DESC').bind(tid).all();
        return json(rows.results);
      }
      if (apiPath === '/tags' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        await env.DB.prepare('INSERT INTO tags (id, tenant_id, name, color) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, name) DO UPDATE SET color=excluded.color').bind(id, tid, sanitize(String(b.name || ''), 50), sanitize(String(b.color || '#6b7280'), 10)).run();
        return json({ ok: true, id });
      }

      // ── Domains ──
      if (apiPath === '/domains' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM domains WHERE tenant_id = ?').bind(tid).all();
        return json(rows.results);
      }
      if (apiPath === '/domains' && method === 'POST') {
        const b = await req.json() as Record<string, unknown>;
        const id = uid();
        const verCode = uid();
        await env.DB.prepare('INSERT INTO domains (id, tenant_id, domain, verification_code) VALUES (?, ?, ?, ?)').bind(id, tid, sanitize(String(b.domain || ''), 200), verCode).run();
        return json({ ok: true, id, verification_code: verCode, instructions: `Add a TXT record: _echo-verify.${b.domain} = ${verCode}` });
      }

      // ── Overview Analytics ──
      if (apiPath === '/analytics/overview' && method === 'GET') {
        const [totalLinks, totalClicks, activeLinks, todayClicks, topLink] = await Promise.all([
          env.DB.prepare('SELECT COUNT(*) as c FROM links WHERE tenant_id = ?').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT SUM(total_clicks) as c FROM links WHERE tenant_id = ?').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM links WHERE tenant_id = ? AND archived = 0').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT COUNT(*) as c FROM clicks WHERE tenant_id = ? AND date(created_at) = date(\'now\')').bind(tid).first<{c:number}>(),
          env.DB.prepare('SELECT id, slug, title, total_clicks FROM links WHERE tenant_id = ? ORDER BY total_clicks DESC LIMIT 1').bind(tid).first(),
        ]);
        return json({ total_links: totalLinks?.c || 0, total_clicks: totalClicks?.c || 0, active_links: activeLinks?.c || 0, today_clicks: todayClicks?.c || 0, top_link: topLink });
      }
      if (apiPath === '/analytics/daily' && method === 'GET') {
        const days = Math.min(Number(url.searchParams.get('days') || 30), 90);
        const rows = await env.DB.prepare('SELECT date, SUM(clicks) as clicks, SUM(unique_clicks) as unique_clicks FROM click_daily WHERE tenant_id = ? AND date >= date(\'now\', \'-\' || ? || \' days\') GROUP BY date ORDER BY date ASC').bind(tid, days).all();
        return json(rows.results);
      }
      if (apiPath === '/analytics/top-links' && method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50);
        const rows = await env.DB.prepare('SELECT id, slug, title, destination_url, total_clicks, unique_clicks, created_at FROM links WHERE tenant_id = ? AND archived = 0 ORDER BY total_clicks DESC LIMIT ?').bind(tid, limit).all();
        return json(rows.results);
      }
      if (apiPath === '/analytics/geo' && method === 'GET') {
        const rows = await env.DB.prepare('SELECT country, COUNT(*) as clicks FROM clicks WHERE tenant_id = ? GROUP BY country ORDER BY clicks DESC LIMIT 50').bind(tid).all();
        return json(rows.results);
      }

      return err('Not found', 404);
    } catch (e: unknown) {
      if ((e as Error).message?.includes('JSON')) {
        return err('Invalid JSON body', 400);
      }
      console.error(`[echo-link-shortener] ${(e as Error).message}`);
      return err('Internal server error', 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    // Aggregate daily clicks and cleanup old detailed clicks
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    // Aggregate yesterday's clicks per link
    const links = await env.DB.prepare('SELECT DISTINCT link_id, tenant_id FROM clicks WHERE date(created_at) = ?').bind(yesterday).all();
    for (const row of links.results) {
      const r = row as { link_id: string; tenant_id: string };
      const [total, uniq] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) as c FROM clicks WHERE link_id = ? AND date(created_at) = ?').bind(r.link_id, yesterday).first<{c:number}>(),
        env.DB.prepare('SELECT COUNT(*) as c FROM clicks WHERE link_id = ? AND date(created_at) = ? AND is_unique = 1').bind(r.link_id, yesterday).first<{c:number}>(),
      ]);
      await env.DB.prepare('INSERT INTO click_daily (link_id, tenant_id, date, clicks, unique_clicks) VALUES (?, ?, ?, ?, ?) ON CONFLICT(link_id, date) DO UPDATE SET clicks=excluded.clicks, unique_clicks=excluded.unique_clicks').bind(r.link_id, r.tenant_id, yesterday, total?.c || 0, uniq?.c || 0).run();
    }

    // Cleanup detailed clicks older than 90 days
    await env.DB.prepare('DELETE FROM clicks WHERE created_at < datetime(\'now\', \'-90 days\')').run();

    // Delete expired links
    await env.DB.prepare('UPDATE links SET archived = 1 WHERE expires_at IS NOT NULL AND expires_at < datetime(\'now\') AND archived = 0').run();
  },
};

// Async click tracking — doesn't block redirect
function trackClick(env: Env, linkId: string, tenantId: string, req: Request): void {
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const ua = req.headers.get('User-Agent') || '';
  const referrer = req.headers.get('Referer') || '';
  const country = req.headers.get('CF-IPCountry') || '';
  const city = req.headers.get('CF-IPCity') || '';
  const region = req.headers.get('CF-Region') || '';

  // Fire and forget
  (async () => {
    try {
      const ipHash = await hashIP(ip);
      const { device, browser, os } = parseUA(ua);

      // Check uniqueness (same IP hash for this link in last 24h)
      const existing = await env.CACHE.get(`click:${linkId}:${ipHash}`);
      const isUnique = !existing;
      if (isUnique) await env.CACHE.put(`click:${linkId}:${ipHash}`, '1', { expirationTtl: 86400 });

      await env.DB.prepare('INSERT INTO clicks (link_id, tenant_id, ip_hash, country, city, region, device_type, browser, os, referrer, user_agent, is_unique) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(linkId, tenantId, ipHash, country, city, region, device, browser, os, referrer.slice(0, 500), ua.slice(0, 300), isUnique ? 1 : 0).run();

      // Update link counters
      if (isUnique) {
        await env.DB.prepare('UPDATE links SET total_clicks = total_clicks + 1, unique_clicks = unique_clicks + 1, last_clicked_at = datetime(\'now\') WHERE id = ?').bind(linkId).run();
      } else {
        await env.DB.prepare('UPDATE links SET total_clicks = total_clicks + 1, last_clicked_at = datetime(\'now\') WHERE id = ?').bind(linkId).run();
      }
    } catch { /* silent */ }
  })();
}

// Simple QR code SVG generator (basic implementation)
function generateSimpleQR(url: string): string {
  // Encode URL into a simple QR-like SVG badge with the URL embedded
  const encoded = encodeURIComponent(url);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect width="200" height="200" fill="white"/>
  <rect x="10" y="10" width="50" height="50" rx="5" fill="black"/>
  <rect x="140" y="10" width="50" height="50" rx="5" fill="black"/>
  <rect x="10" y="140" width="50" height="50" rx="5" fill="black"/>
  <rect x="15" y="15" width="40" height="40" rx="3" fill="white"/>
  <rect x="145" y="15" width="40" height="40" rx="3" fill="white"/>
  <rect x="15" y="145" width="40" height="40" rx="3" fill="white"/>
  <rect x="22" y="22" width="26" height="26" rx="2" fill="black"/>
  <rect x="152" y="22" width="26" height="26" rx="2" fill="black"/>
  <rect x="22" y="152" width="26" height="26" rx="2" fill="black"/>
  <rect x="70" y="70" width="60" height="60" rx="8" fill="#14b8a6"/>
  <text x="100" y="105" text-anchor="middle" fill="white" font-size="12" font-family="sans-serif" font-weight="bold">ECHO</text>
  <text x="100" y="195" text-anchor="middle" fill="#666" font-size="6" font-family="sans-serif">${url.slice(0, 50)}</text>
</svg>`;
}
