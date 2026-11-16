// Cloudflare Worker: учёт посещений портфолио.
//   POST /hit           — записать визит (вызывается со страницы портфолио)
//   GET  /stats?key=... — сводка: IP → число визитов → даты (HTML; &format=json — JSON)
//
// Хранилище: KV namespace VISITS, ключ "ip:<адрес>", значение — массив визитов.
// Ключ живёт RETENTION_DAYS дней с последнего визита, затем удаляется автоматически.

const MAX_VISITS_PER_IP = 200;
const MAX_FIELD = 300;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/hit') return handleHit(request, env);
    if (url.pathname === '/stats') return handleStats(request, env, url);
    return new Response('Not found', { status: 404 });
  },
};

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function cut(value) {
  return String(value || '').slice(0, MAX_FIELD);
}

async function handleHit(request, env) {
  const origin = request.headers.get('Origin') || '';
  const origins = allowedOrigins(env);
  const cors = origins.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {};

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  // Принимаем только запросы со страниц портфолио.
  if (origins.length && !origins.includes(origin)) return new Response('Forbidden', { status: 403 });

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  let body = {};
  try {
    body = JSON.parse(await request.text());
  } catch {
    // пустое или некорректное тело — пишем визит без page/referrer
  }

  const visit = {
    t: new Date().toISOString(),
    page: cut(body.page),
    ref: cut(body.referrer),
    ua: cut(request.headers.get('User-Agent')),
    country: (request.cf && request.cf.country) || '',
  };

  const key = 'ip:' + ip;
  const visits = (await env.VISITS.get(key, 'json')) || [];
  visits.push(visit);
  if (visits.length > MAX_VISITS_PER_IP) visits.splice(0, visits.length - MAX_VISITS_PER_IP);

  const days = Number(env.RETENTION_DAYS) || 180;
  await env.VISITS.put(key, JSON.stringify(visits), { expirationTtl: days * 86400 });

  return new Response(null, { status: 204, headers: cors });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function loadAll(env) {
  const rows = [];
  let cursor;
  do {
    const page = await env.VISITS.list({ prefix: 'ip:', cursor });
    for (const k of page.keys) {
      const visits = (await env.VISITS.get(k.name, 'json')) || [];
      if (visits.length) rows.push({ ip: k.name.slice(3), count: visits.length, visits });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  // Сначала IP с самым свежим визитом.
  rows.sort((a, b) => (a.visits.at(-1).t < b.visits.at(-1).t ? 1 : -1));
  return rows;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function handleStats(request, env, url) {
  if (!env.STATS_KEY || !safeEqual(url.searchParams.get('key') || '', env.STATS_KEY)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const rows = await loadAll(env);
  const noStore = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' };

  if (url.searchParams.get('format') === 'json') {
    return Response.json(rows, { headers: noStore });
  }

  const tz = env.TIMEZONE || 'Europe/Moscow';
  const fmt = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' });
  const total = rows.reduce((n, r) => n + r.count, 0);

  const body = rows.map((r) => {
    const items = r.visits.slice().reverse().map((v) => {
      const extra = [v.page, v.ref && 'из ' + v.ref, v.country].filter(Boolean).map(esc).join(' · ');
      return `<li><b>${esc(fmt.format(new Date(v.t)))}</b> ${extra}<br><small>${esc(v.ua)}</small></li>`;
    }).join('');
    return `<tr><td><code>${esc(r.ip)}</code></td><td>${r.count}</td><td><details><summary>последний: ${esc(fmt.format(new Date(r.visits.at(-1).t)))}</summary><ol>${items}</ol></details></td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Посещения портфолио</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:24px;color:#1d1d1b}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}small{color:#666}ol{margin:6px 0;padding-left:20px}</style>
</head><body><h1>Посещения портфолио</h1>
<p>Уникальных IP: ${rows.length} · всего визитов: ${total} · время: ${esc(tz)}</p>
<table><thead><tr><th>IP</th><th>Визитов</th><th>Даты</th></tr></thead><tbody>${body || '<tr><td colspan="3">Пока нет визитов</td></tr>'}</tbody></table>
</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...noStore } });
}
