const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = '429_auth';
const MAX_AGE = 60 * 60 * 24 * 14;

function secret() {
  return process.env.AUTH_SECRET || process.env.NETLIFY_AUTH_TOKEN || 'dev-only-change-me';
}
function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('hex');
}
function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ user, exp: Math.floor(Date.now() / 1000) + MAX_AGE })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const i = part.indexOf('=');
    return i < 0 ? null : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }).filter(Boolean));
}
function readAuth(event) {
  const token = parseCookies(event.headers.cookie || event.headers.Cookie || '')[COOKIE];
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
  return data.user || 'owner';
}
function json(statusCode, body, headers = {}) {
  return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) };
}
function privatePath(...parts) {
  return path.join(process.cwd(), 'private', ...parts);
}
function requireAuth(event) {
  const user = readAuth(event);
  if (!user) return null;
  return user;
}

exports.handler = async (event) => {
  const route = (event.queryStringParameters && event.queryStringParameters.route) || 'me';

  if (route === 'login' && event.httpMethod === 'POST') {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (_) {}
    const wantUser = process.env.AUTH_USERNAME || 'owner';
    const wantPass = process.env.AUTH_PASSWORD;
    if (!wantPass) return json(500, { ok: false, error: 'AUTH_PASSWORD is not configured in Netlify environment variables.' });
    if (body.username !== wantUser || body.password !== wantPass) return json(401, { ok: false, error: 'Invalid login.' });
    return json(200, { ok: true, user: wantUser }, {
      'set-cookie': `${COOKIE}=${encodeURIComponent(makeToken(wantUser))}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  if (route === 'logout') {
    return json(200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
  }

  if (route === 'me') return json(200, { authenticated: Boolean(readAuth(event)) });

  const user = requireAuth(event);
  if (!user) return json(401, { ok: false, error: 'Login required.' });

  if (route === 'data') {
    return { statusCode: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: fs.readFileSync(privatePath('data.json'), 'utf8') };
  }

  if (route === 'report') {
    const period = (event.queryStringParameters && event.queryStringParameters.period || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!period) return json(400, { ok: false, error: 'Missing period.' });
    const file = privatePath('reports', `${period}.json`);
    if (!fs.existsSync(file)) return json(404, { ok: false, error: 'Report not found.' });
    return { statusCode: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: fs.readFileSync(file, 'utf8') };
  }

  return json(404, { ok: false, error: 'Unknown route.' });
};
