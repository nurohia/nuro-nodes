const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const helmet = require('helmet');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 38081;
const NODE_FILE = path.join(__dirname, 'nodes.json');
const CODE_FILE = path.join(__dirname, 'redeem_codes.json');
const APP_CONFIG_FILE = path.join(__dirname, 'app_config.json');

const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const ADMIN_TOKEN_SHA256 = String(process.env.ADMIN_TOKEN_SHA256 || '').trim().toLowerCase();
const ADMIN_PATH_KEY = String(process.env.ADMIN_PATH_KEY || '').trim();
const ADMIN_API_BASE = ADMIN_PATH_KEY ? `/api/internal/${ADMIN_PATH_KEY}` : '';
const ADMIN_SESSION_SECRET = String(process.env.ADMIN_SESSION_SECRET || '').trim();
const ADMIN_SESSION_TTL_HOURS = Number(process.env.ADMIN_SESSION_TTL_HOURS || 12);
const ADMIN_SESSION_COOKIE = 'nexus_admin_session';

const corsWhitelist = (process.env.CORS_WHITELIST || 'http://localhost:38173')
  .split(',')
  .map((i) => i.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '128kb' }));
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || corsWhitelist.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  })
);

const infoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '请求过快，请稍后再试' },
});

const renewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '续费请求过快，请稍后再试' },
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '管理请求过快，请稍后再试' },
});

function hashSha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function safeCompare(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseCookieHeader(cookieHeader) {
  const out = {};
  String(cookieHeader || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((item) => {
      const idx = item.indexOf('=');
      if (idx <= 0) return;
      out[item.slice(0, idx)] = decodeURIComponent(item.slice(idx + 1));
    });
  return out;
}

function getAdminSessionSecret() {
  if (ADMIN_SESSION_SECRET) return ADMIN_SESSION_SECRET;
  if (ADMIN_TOKEN_SHA256) return ADMIN_TOKEN_SHA256;
  if (ADMIN_TOKEN) return hashSha256(ADMIN_TOKEN);
  return '';
}

function signSessionPayload(payloadBase64) {
  const secret = getAdminSessionSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(payloadBase64, 'utf8').digest('hex');
}

function createAdminSessionToken() {
  const now = Date.now();
  const ttl = Math.max(1, ADMIN_SESSION_TTL_HOURS) * 60 * 60 * 1000;
  const payload = {
    iat: now,
    exp: now + ttl,
    nonce: crypto.randomBytes(12).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${signSessionPayload(body)}`;
}

function verifyAdminSessionToken(token) {
  const raw = String(token || '').trim();
  if (!raw.includes('.')) return false;
  const [body, sig] = raw.split('.', 2);
  if (!body || !sig) return false;
  const expected = signSessionPayload(body);
  if (!expected || !safeCompare(sig, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return Number(payload?.exp || 0) > Date.now();
  } catch (e) {
    return false;
  }
}

function parseXuiDate(expireTime) {
  if (!expireTime || Number(expireTime) <= 0) return '永久有效';
  const d = new Date(Number(expireTime));
  if (Number.isNaN(d.getTime())) return '未知';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`;
}

function bytesToGb(bytes) {
  return (Number(bytes || 0) / 1024 / 1024 / 1024).toFixed(2);
}

function parseClientCredentials(settingsRaw) {
  let parsed;
  try {
    parsed = typeof settingsRaw === 'string' ? JSON.parse(settingsRaw) : settingsRaw || {};
  } catch (e) {
    return null;
  }

  if (parsed.method && parsed.password) {
    return { method: parsed.method, password: parsed.password };
  }

  const clients = Array.isArray(parsed.clients) ? parsed.clients : [];
  const first = clients.find((c) => c && c.password && (c.method || parsed.method));
  if (!first) return null;
  return { method: first.method || parsed.method, password: first.password };
}

function buildShadowsocksLink(method, password, host, port, remark) {
  const plain = `${method}:${password}@${host}:${port}`;
  const encoded = Buffer.from(plain).toString('base64');
  return `ss://${encoded}#${encodeURIComponent(remark || 'subscription')}`;
}

function getUrlHost(rawUrl) {
  try {
    return new URL(String(rawUrl || '')).hostname;
  } catch (e) {
    return '';
  }
}

function nodeKey(node, index = 0) {
  return String(node?.id || node?.name || getUrlHost(node?.url) || `node_${index + 1}`);
}

function normalizeNode(input, index) {
  const node = {
    id: String(input?.id || '').trim(),
    name: String(input?.name || '').trim(),
    url: String(input?.url || '').trim(),
    user: String(input?.user || '').trim(),
    pass: String(input?.pass || '').trim(),
  };

  if (!node.name || !node.url || !node.user || !node.pass) {
    throw new Error(`第 ${index + 1} 个节点缺少必填项`);
  }

  try {
    const u = new URL(node.url);
    if (!['http:', 'https:'].includes(u.protocol)) {
      throw new Error('invalid protocol');
    }
  } catch (e) {
    throw new Error(`第 ${index + 1} 个节点 URL 非法`);
  }

  return node;
}

async function loadNodes() {
  const content = await fs.readFile(NODE_FILE, 'utf8');
  const nodes = JSON.parse(String(content || '').replace(/^\uFEFF/, ''));
  if (!Array.isArray(nodes)) throw new Error('nodes.json format invalid');
  return nodes.map((n, i) => normalizeNode(n, i));
}

async function saveNodes(nodes) {
  await fs.writeFile(NODE_FILE, `${JSON.stringify(nodes, null, 2)}\n`, 'utf8');
}

async function loadCodes() {
  try {
    const content = await fs.readFile(CODE_FILE, 'utf8');
    const codes = JSON.parse(String(content || '').replace(/^\uFEFF/, ''));
    return Array.isArray(codes) ? codes : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function saveCodes(codes) {
  await fs.writeFile(CODE_FILE, `${JSON.stringify(codes, null, 2)}\n`, 'utf8');
}

async function loadAppConfig() {
  try {
    const content = await fs.readFile(APP_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(String(content || '').replace(/^\uFEFF/, ''));
    return {
      purchase_url: String(parsed?.purchase_url || '').trim(),
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { purchase_url: '' };
    throw e;
  }
}

async function saveAppConfig(config) {
  const normalized = {
    purchase_url: String(config?.purchase_url || '').trim(),
  };
  await fs.writeFile(APP_CONFIG_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

function generateCode(prefix = 'NX') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => {
    const bytes = crypto.randomBytes(4);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  };
  return `${String(prefix || 'NX').toUpperCase()}-${pick()}-${pick()}-${pick()}`;
}

function addMonthsFromToday(months) {
  const m = Math.max(1, Number(months) || 1);
  const now = new Date();
  const day = now.getDate();
  const d = new Date(now.getFullYear(), now.getMonth(), 1, now.getHours(), now.getMinutes(), now.getSeconds());
  d.setMonth(d.getMonth() + m);
  const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, maxDay));
  return d.getTime();
}

function addMonthsKeepDay(baseMs, months) {
  const m = Math.max(1, Number(months) || 1);
  const base = Number(baseMs) > 0 ? new Date(Number(baseMs)) : new Date();
  if (Number.isNaN(base.getTime())) return addMonthsFromToday(m);

  const day = base.getDate();
  const d = new Date(
    base.getFullYear(),
    base.getMonth(),
    1,
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds()
  );
  d.setMonth(d.getMonth() + m);
  const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, maxDay));
  return d.getTime();
}

function normalizeDomainInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw.includes('://')) {
    return getUrlHost(raw).toLowerCase();
  }
  const noPath = raw.split('/')[0];
  const host = noPath.split(':')[0];
  return host.toLowerCase();
}

function pickNodesByDomain(nodes, domainInput) {
  const host = normalizeDomainInput(domainInput);
  if (!host) return [];
  return nodes.filter((n) => getUrlHost(n.url).toLowerCase() === host);
}

function inboundMatches(item, queryKey) {
  if (!item?.enable) return false;
  const byRemark = String(item.remark || '') === queryKey;
  const creds = parseClientCredentials(item.settings);
  const byPass = String(creds?.password || '') === queryKey;
  return byRemark || byPass;
}

function buildUserResult(inbound, node, creds) {
  const host = getUrlHost(node.url);
  return {
    remark: inbound.remark,
    node_name: node.name,
    protocol: 'SHADOWSOCKS',
    usage: {
      total_used_gb: bytesToGb((Number(inbound.up) || 0) + (Number(inbound.down) || 0)),
      quota_gb: bytesToGb(Number(inbound.total) || 0),
    },
    expiry: parseXuiDate(inbound.expiryTime),
    subscription_link: buildShadowsocksLink(creds.method, creds.password, host, inbound.port, inbound.remark),
  };
}

function isValidAdminToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return false;
  if (ADMIN_TOKEN_SHA256) return safeCompare(hashSha256(token), ADMIN_TOKEN_SHA256);
  if (ADMIN_TOKEN) return safeCompare(token, ADMIN_TOKEN);
  return false;
}

function requireAdminSession(req, res, next) {
  if (!ADMIN_PATH_KEY || !ADMIN_API_BASE) {
    return res.status(503).json({ message: '管理员路径未配置，请设置 ADMIN_PATH_KEY' });
  }
  if (!ADMIN_TOKEN && !ADMIN_TOKEN_SHA256) {
    return res.status(503).json({ message: '管理员令牌未配置，请设置 ADMIN_TOKEN 或 ADMIN_TOKEN_SHA256' });
  }
  const cookies = parseCookieHeader(req.headers.cookie);
  if (!verifyAdminSessionToken(cookies[ADMIN_SESSION_COOKIE])) {
    return res.status(401).json({ message: '管理员鉴权失败' });
  }
  return next();
}

async function loginXui(node) {
  const api = axios.create({
    baseURL: node.url.replace(/\/$/, ''),
    timeout: 3000,
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 500,
  });

  const loginResp = await api.post('/login', {
    username: node.user,
    password: node.pass,
  });

  if (loginResp.status < 200 || loginResp.status >= 300) {
    throw new Error('登录失败');
  }

  const setCookie = loginResp.headers['set-cookie'];
  if (!setCookie || !setCookie.length) {
    throw new Error('缺少登录 Cookie');
  }
  const cookie = setCookie.map((s) => s.split(';')[0]).join('; ');
  return { api, cookie };
}

async function fetchInboundListWithSession(session) {
  const listResp = await session.api.post(
    '/xui/inbound/list',
    {},
    {
      headers: { Cookie: session.cookie },
    }
  );

  if (listResp.status < 200 || listResp.status >= 300) {
    throw new Error('读取入站列表失败');
  }

  const list =
    listResp.data?.obj ||
    listResp.data?.data ||
    listResp.data?.list ||
    (Array.isArray(listResp.data) ? listResp.data : []);

  if (!Array.isArray(list)) {
    throw new Error('入站列表格式异常');
  }
  return list;
}

async function findInboundOnNode(node, queryKey, index) {
  const session = await loginXui(node);
  const list = await fetchInboundListWithSession(session);
  const inbound = list.find((item) => inboundMatches(item, queryKey));
  if (!inbound) {
    throw new Error(`node ${nodeKey(node, index)} not found`);
  }

  const creds = parseClientCredentials(inbound.settings);
  if (!creds || !creds.method || !creds.password) {
    throw new Error(`node ${nodeKey(node, index)} invalid settings`);
  }

  const host = getUrlHost(node.url);
  if (!host) {
    throw new Error(`node ${nodeKey(node, index)} host missing`);
  }

  return { inbound, creds, session };
}

async function queryNode(node, queryKey, index) {
  const found = await findInboundOnNode(node, queryKey, index);
  return buildUserResult(found.inbound, node, found.creds);
}

function buildUpdateForm(inbound, nextExpiryTime) {
  const payload = {
    up: 0,
    down: 0,
    total: Number(inbound.total) || 0,
    remark: inbound.remark,
    enable: inbound.enable === true,
    expiryTime: nextExpiryTime,
    listen: inbound.listen || '',
    port: inbound.port,
    protocol: inbound.protocol,
    settings: inbound.settings,
    streamSettings: inbound.streamSettings,
    sniffing: inbound.sniffing,
    allocate: inbound.allocate,
    tag: inbound.tag,
  };

  const form = new URLSearchParams();
  Object.entries(payload).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'object') {
      form.append(k, JSON.stringify(v));
      return;
    }
    form.append(k, String(v));
  });
  return form;
}

async function updateInboundRenewal(session, inbound, nextExpiryTime) {
  const inboundId = Number(inbound?.id);
  if (!Number.isFinite(inboundId) || inboundId <= 0) {
    throw new Error('入站 ID 无效，无法续费');
  }

  const form = buildUpdateForm(inbound, nextExpiryTime);
  const updateResp = await session.api.post(`/xui/inbound/update/${inboundId}`, form.toString(), {
    headers: {
      Cookie: session.cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  if (updateResp.status < 200 || updateResp.status >= 300) {
    throw new Error('续费提交失败');
  }
}

app.post('/api/node/info', infoLimiter, async (req, res) => {
  const nodeDomain = String(req.body?.node_domain || '').trim();
  const queryKey = String(req.body?.password || req.body?.credential || '').trim();
  if (!nodeDomain || !queryKey) {
    return res.status(400).json({ message: '节点域名和凭证不能为空' });
  }

  let nodes;
  try {
    nodes = await loadNodes();
  } catch (e) {
    return res.status(500).json({ message: '节点配置加载失败' });
  }
  if (!nodes.length) return res.status(503).json({ message: '暂无可用节点' });

  const scopedNodes = pickNodesByDomain(nodes, nodeDomain);
  if (!scopedNodes.length) {
    return res.status(404).json({ message: '未找到该节点域名' });
  }

  try {
    const result = await Promise.any(scopedNodes.map((node, idx) => queryNode(node, queryKey, idx)));
    return res.status(200).json(result);
  } catch (e) {
    return res.status(404).json({ message: '未找到该凭证或节点已停机' });
  }
});

app.post('/api/node/renew', renewLimiter, async (req, res) => {
  const nodeDomain = String(req.body?.node_domain || '').trim();
  const queryKey = String(req.body?.password || req.body?.credential || '').trim();
  const redeemCodeRaw = String(req.body?.redeem_code || '').trim().toUpperCase();
  if (!nodeDomain || !queryKey || !redeemCodeRaw) {
    return res.status(400).json({ message: '节点域名、凭证和兑换码不能为空' });
  }

  let codes;
  try {
    codes = await loadCodes();
  } catch (e) {
    return res.status(500).json({ message: '兑换码配置加载失败' });
  }

  const codeItem = codes.find((c) => String(c.code || '').toUpperCase() === redeemCodeRaw);
  if (!codeItem || codeItem.revoked || codeItem.used) {
    return res.status(401).json({ message: '兑换码无效或已使用' });
  }

  let nodes;
  try {
    nodes = await loadNodes();
  } catch (e) {
    return res.status(500).json({ message: '节点配置加载失败' });
  }

  const scopedNodes = pickNodesByDomain(nodes, nodeDomain);
  if (!scopedNodes.length) {
    return res.status(404).json({ message: '未找到该节点域名' });
  }

  try {
    const found = await Promise.any(
      scopedNodes.map((node, idx) => findInboundOnNode(node, queryKey, idx).then((r) => ({ ...r, node })))
    );
    const nextExpiryTime = addMonthsKeepDay(found.inbound.expiryTime, codeItem.months || 1);

    await updateInboundRenewal(found.session, found.inbound, nextExpiryTime);

    codeItem.used = true;
    codeItem.used_at = new Date().toISOString();
    codeItem.used_by = found.inbound.remark;
    await saveCodes(codes);

    const renewedInbound = {
      ...found.inbound,
      up: 0,
      down: 0,
      expiryTime: nextExpiryTime,
    };

    return res.status(200).json({
      ...buildUserResult(renewedInbound, found.node, found.creds),
      renew: {
        months: Number(codeItem.months || 1),
        code: codeItem.code,
      },
    });
  } catch (e) {
    return res.status(404).json({ message: '未找到该凭证或节点已停机' });
  }
});

app.get('/api/public/meta', async (req, res) => {
  try {
    const config = await loadAppConfig();
    return res.status(200).json({ purchase_url: config.purchase_url });
  } catch (e) {
    return res.status(500).json({ message: '读取站点配置失败' });
  }
});

app.post(`${ADMIN_API_BASE}/auth/login`, adminLimiter, async (req, res) => {
  if (!ADMIN_PATH_KEY || !ADMIN_API_BASE) {
    return res.status(503).json({ message: '管理员路径未配置，请设置 ADMIN_PATH_KEY' });
  }
  if (!ADMIN_TOKEN && !ADMIN_TOKEN_SHA256) {
    return res.status(503).json({ message: '管理员令牌未配置，请设置 ADMIN_TOKEN 或 ADMIN_TOKEN_SHA256' });
  }

  const token = String(req.body?.token || '').trim();
  if (!isValidAdminToken(token)) return res.status(401).json({ message: '管理员鉴权失败' });

  const session = createAdminSessionToken();
  const secureCookie = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  res.cookie(ADMIN_SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie,
    path: ADMIN_API_BASE,
    maxAge: Math.max(1, ADMIN_SESSION_TTL_HOURS) * 60 * 60 * 1000,
  });
  return res.status(200).json({ message: '登录成功' });
});

app.post(`${ADMIN_API_BASE}/auth/logout`, adminLimiter, async (req, res) => {
  res.clearCookie(ADMIN_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
    path: ADMIN_API_BASE,
  });
  return res.status(200).json({ message: '已退出' });
});

app.get(`${ADMIN_API_BASE}/auth/status`, adminLimiter, async (req, res) => {
  const cookies = parseCookieHeader(req.headers.cookie);
  const ok = verifyAdminSessionToken(cookies[ADMIN_SESSION_COOKIE]);
  return res.status(ok ? 200 : 401).json({ ok });
});

app.get(`${ADMIN_API_BASE}/nodes`, adminLimiter, requireAdminSession, async (req, res) => {
  try {
    const nodes = await loadNodes();
    return res.status(200).json({ nodes });
  } catch (e) {
    return res.status(500).json({ message: '读取节点配置失败' });
  }
});

app.post(`${ADMIN_API_BASE}/nodes`, adminLimiter, requireAdminSession, async (req, res) => {
  const rawNodes = req.body?.nodes;
  if (!Array.isArray(rawNodes)) return res.status(400).json({ message: 'nodes 必须是数组' });

  try {
    const nodes = rawNodes.map((n, i) => normalizeNode(n, i));
    await saveNodes(nodes);
    return res.status(200).json({ message: '节点配置保存成功', count: nodes.length });
  } catch (e) {
    return res.status(400).json({ message: e.message || '节点配置校验失败' });
  }
});

app.get(`${ADMIN_API_BASE}/nodes/health`, adminLimiter, requireAdminSession, async (req, res) => {
  try {
    const nodes = await loadNodes();
    const checks = await Promise.all(
      nodes.map(async (node, idx) => {
        const startedAt = Date.now();
        try {
          const session = await loginXui(node);
          const list = await fetchInboundListWithSession(session);
          return {
            id: nodeKey(node, idx),
            name: node.name,
            ok: true,
            inbound_count: list.length,
            latency_ms: Date.now() - startedAt,
            message: '连接正常',
          };
        } catch (e) {
          return {
            id: nodeKey(node, idx),
            name: node.name,
            ok: false,
            inbound_count: 0,
            latency_ms: Date.now() - startedAt,
            message: e.message || '连接失败',
          };
        }
      })
    );
    return res.status(200).json({ checks });
  } catch (e) {
    return res.status(500).json({ message: '健康检测失败' });
  }
});

app.post(`${ADMIN_API_BASE}/nodes/test`, adminLimiter, requireAdminSession, async (req, res) => {
  try {
    const node = normalizeNode(req.body?.node || {}, 0);
    const startedAt = Date.now();
    const session = await loginXui(node);
    const list = await fetchInboundListWithSession(session);
    return res.status(200).json({
      id: nodeKey(node, 0),
      name: node.name,
      ok: true,
      inbound_count: list.length,
      latency_ms: Date.now() - startedAt,
      message: '连接正常',
    });
  } catch (e) {
    return res.status(200).json({
      id: 'node_1',
      name: String(req.body?.node?.name || '节点1'),
      ok: false,
      inbound_count: 0,
      latency_ms: 0,
      message: e.message || '连接失败',
    });
  }
});

app.get(`${ADMIN_API_BASE}/codes`, adminLimiter, requireAdminSession, async (req, res) => {
  try {
    const codes = await loadCodes();
    const normalized = codes
      .slice()
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return res.status(200).json({ codes: normalized });
  } catch (e) {
    return res.status(500).json({ message: '读取兑换码失败' });
  }
});

app.post(`${ADMIN_API_BASE}/codes/generate`, adminLimiter, requireAdminSession, async (req, res) => {
  const count = Math.min(200, Math.max(1, Number(req.body?.count || 1)));
  const months = Math.min(12, Math.max(1, Number(req.body?.months || 1)));
  const prefix = String(req.body?.prefix || 'NX').trim().slice(0, 8) || 'NX';

  try {
    const codes = await loadCodes();
    const now = new Date().toISOString();
    const created = [];

    for (let i = 0; i < count; i += 1) {
      let code = generateCode(prefix);
      while (codes.some((c) => String(c.code || '').toUpperCase() === code)) {
        code = generateCode(prefix);
      }
      const item = {
        code,
        months,
        used: false,
        revoked: false,
        created_at: now,
        used_at: '',
        used_by: '',
      };
      codes.push(item);
      created.push(item);
    }

    await saveCodes(codes);
    return res.status(200).json({ created, count: created.length });
  } catch (e) {
    return res.status(500).json({ message: '生成兑换码失败' });
  }
});

app.post(`${ADMIN_API_BASE}/codes/revoke`, adminLimiter, requireAdminSession, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ message: 'code 不能为空' });

  try {
    const codes = await loadCodes();
    const item = codes.find((c) => String(c.code || '').toUpperCase() === code);
    if (!item) return res.status(404).json({ message: '兑换码不存在' });
    if (item.used) return res.status(400).json({ message: '兑换码已使用，无法作废' });

    item.revoked = true;
    await saveCodes(codes);
    return res.status(200).json({ message: '兑换码已作废' });
  } catch (e) {
    return res.status(500).json({ message: '作废兑换码失败' });
  }
});

app.post(`${ADMIN_API_BASE}/codes/cleanup`, adminLimiter, requireAdminSession, async (req, res) => {
  try {
    const codes = await loadCodes();
    const before = codes.length;
    const kept = codes.filter((item) => !item.used && !item.revoked);
    const removed = before - kept.length;
    await saveCodes(kept);
    return res.status(200).json({ message: '清理完成', removed, total: kept.length });
  } catch (e) {
    return res.status(500).json({ message: '清理兑换码失败' });
  }
});

app.post(`${ADMIN_API_BASE}/codes/delete`, adminLimiter, requireAdminSession, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ message: 'code 不能为空' });

  try {
    const codes = await loadCodes();
    const before = codes.length;
    const next = codes.filter((c) => String(c.code || '').toUpperCase() !== code);
    if (next.length === before) return res.status(404).json({ message: '兑换码不存在' });
    await saveCodes(next);
    return res.status(200).json({ message: '兑换码已删除' });
  } catch (e) {
    return res.status(500).json({ message: '删除兑换码失败' });
  }
});

app.post(`${ADMIN_API_BASE}/codes/delete-all`, adminLimiter, requireAdminSession, async (req, res) => {
  try {
    await saveCodes([]);
    return res.status(200).json({ message: '已删除全部兑换码', total: 0 });
  } catch (e) {
    return res.status(500).json({ message: '删除全部兑换码失败' });
  }
});

app.get(`${ADMIN_API_BASE}/settings`, adminLimiter, requireAdminSession, async (req, res) => {
  try {
    const config = await loadAppConfig();
    return res.status(200).json(config);
  } catch (e) {
    return res.status(500).json({ message: '读取站点配置失败' });
  }
});

app.post(`${ADMIN_API_BASE}/settings/purchase-url`, adminLimiter, requireAdminSession, async (req, res) => {
  const purchaseUrl = String(req.body?.purchase_url || '').trim();
  if (purchaseUrl) {
    try {
      const parsed = new URL(purchaseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ message: '购买地址必须是 http/https 链接' });
      }
    } catch (e) {
      return res.status(400).json({ message: '购买地址格式不正确' });
    }
  }

  try {
    await saveAppConfig({ purchase_url: purchaseUrl });
    return res.status(200).json({ message: '购买地址已更新', purchase_url: purchaseUrl });
  } catch (e) {
    return res.status(500).json({ message: '更新购买地址失败' });
  }
});

app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: '跨域请求被拒绝' });
  }
  return res.status(500).json({ message: '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`BFF gateway listening on port ${PORT}`);
});
