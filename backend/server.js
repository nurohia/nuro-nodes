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
let runtimeAdminTokenSha256 = ADMIN_TOKEN_SHA256 || (ADMIN_TOKEN ? hashSha256(ADMIN_TOKEN) : '');

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
  if (runtimeAdminTokenSha256) return runtimeAdminTokenSha256;
  return '';
}

function hasAdminTokenConfigured() {
  return Boolean(runtimeAdminTokenSha256);
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

function parseJsonObject(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw || {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function buildShadowsocksLink(method, password, host, port, remark) {
  const plain = `${method}:${password}@${host}:${port}`;
  const encoded = Buffer.from(plain).toString('base64');
  return `ss://${encoded}#${encodeURIComponent(remark || 'subscription')}`;
}

function encodeBase64UrlJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function encodeBase64PrettyJson(obj) {
  return Buffer.from(JSON.stringify(obj, null, 2), 'utf8').toString('base64');
}

function parseInboundProfile(inbound) {
  const protocol = String(inbound?.protocol || '').trim().toLowerCase();
  const settings = parseJsonObject(inbound?.settings);
  const streamSettings = parseJsonObject(inbound?.streamSettings);
  const clients = Array.isArray(settings.clients) ? settings.clients.filter(Boolean) : [];
  const firstClient = clients[0] || {};
  const firstAccount = Array.isArray(settings.accounts) ? settings.accounts[0] || {} : {};

  const candidates = new Set();
  const remark = String(inbound?.remark || '').trim();
  if (remark) candidates.add(remark);

  if (protocol === 'shadowsocks') {
    const method = String(settings.method || firstClient.method || '').trim();
    const password = String(settings.password || firstClient.password || '').trim();
    if (password) candidates.add(password);
    return {
      protocol,
      method,
      password,
      authCandidates: Array.from(candidates),
      streamSettings,
    };
  }

  if (protocol === 'vmess' || protocol === 'vless') {
    const id = String(firstClient.id || '').trim();
    const email = String(firstClient.email || '').trim();
    if (id) candidates.add(id);
    if (email) candidates.add(email);
    return {
      protocol,
      id,
      email,
      flow: String(firstClient.flow || '').trim(),
      security: String(firstClient.security || '').trim(),
      alterId: Number(firstClient.alterId || 0),
      authCandidates: Array.from(candidates),
      streamSettings,
    };
  }

  if (protocol === 'trojan') {
    const password = String(firstClient.password || '').trim();
    const email = String(firstClient.email || '').trim();
    if (password) candidates.add(password);
    if (email) candidates.add(email);
    return {
      protocol,
      password,
      email,
      flow: String(firstClient.flow || '').trim(),
      authCandidates: Array.from(candidates),
      streamSettings,
    };
  }

  if (protocol === 'socks' || protocol === 'http') {
    const user = String(firstAccount.user || '').trim();
    const pass = String(firstAccount.pass || '').trim();
    if (user) candidates.add(user);
    if (pass) candidates.add(pass);
    return {
      protocol,
      user,
      pass,
      authCandidates: Array.from(candidates),
      streamSettings,
    };
  }

  return {
    protocol,
    authCandidates: Array.from(candidates),
    streamSettings,
  };
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

function normalizeNodeNameForCompare(name) {
  return String(name || '').trim().toLowerCase();
}

function normalizeNodeUrlForCompare(rawUrl) {
  try {
    const u = new URL(String(rawUrl || '').trim());
    const pathPart = String(u.pathname || '/').replace(/\/+$/, '') || '/';
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${pathPart}`;
  } catch (e) {
    return '';
  }
}

function validateNodeUniqueness(nodes) {
  const nameMap = new Map();
  const urlMap = new Map();

  nodes.forEach((node, index) => {
    const nameKey = normalizeNodeNameForCompare(node?.name);
    const urlKey = normalizeNodeUrlForCompare(node?.url);

    if (nameKey) {
      if (nameMap.has(nameKey)) {
        const prevIndex = nameMap.get(nameKey);
        throw new Error(`节点名称重复：第 ${index + 1} 个与第 ${prevIndex + 1} 个节点名称相同`);
      }
      nameMap.set(nameKey, index);
    }

    if (urlKey) {
      if (urlMap.has(urlKey)) {
        const prevIndex = urlMap.get(urlKey);
        throw new Error(`x-ui 地址重复：第 ${index + 1} 个与第 ${prevIndex + 1} 个节点地址相同`);
      }
      urlMap.set(urlKey, index);
    }
  });
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
    return Array.isArray(codes) ? codes.map((item) => normalizeCodeItem(item)) : [];
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
      admin_token_sha256: String(parsed?.admin_token_sha256 || '').trim().toLowerCase(),
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { purchase_url: '', admin_token_sha256: '' };
    throw e;
  }
}

async function saveAppConfig(config) {
  const prev = await loadAppConfig().catch(() => ({ purchase_url: '', admin_token_sha256: '' }));
  const normalized = {
    purchase_url:
      config?.purchase_url === undefined ? String(prev.purchase_url || '').trim() : String(config?.purchase_url || '').trim(),
    admin_token_sha256:
      config?.admin_token_sha256 === undefined
        ? String(prev.admin_token_sha256 || '').trim().toLowerCase()
        : String(config?.admin_token_sha256 || '').trim().toLowerCase(),
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

function normalizeCodeItem(item) {
  const code = String(item?.code || '').trim().toUpperCase();
  return {
    ...item,
    code,
    node_id: String(item?.node_id || '').trim(),
    node_host: normalizeDomainInput(item?.node_host || ''),
    node_name: String(item?.node_name || '').trim(),
  };
}

function createNodeId(usedIds) {
  let id = '';
  do {
    id = `node_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  } while (usedIds.has(id));
  return id;
}

function ensureNodeIds(nextNodes, prevNodes = []) {
  const usedIds = new Set();

  return nextNodes.map((node, index) => {
    const next = { ...node };
    const ownId = String(next.id || '').trim();
    const prevId = String(prevNodes[index]?.id || '').trim();
    if (ownId && !usedIds.has(ownId)) {
      next.id = ownId;
      usedIds.add(next.id);
      return next;
    }
    if (prevId && !usedIds.has(prevId)) {
      next.id = prevId;
      usedIds.add(next.id);
      return next;
    }
    next.id = createNodeId(usedIds);
    usedIds.add(next.id);
    return next;
  });
}

function syncCodesWithNodes(codes, prevNodes, nextNodes) {
  const nextById = new Map();
  const nextByHost = new Map();
  nextNodes.forEach((node) => {
    const id = String(node?.id || '').trim();
    const host = normalizeDomainInput(node?.url || '');
    if (!id) return;
    nextById.set(id, node);
    if (host) nextByHost.set(host, node);
  });

  const legacyHostToNodeId = new Map();
  prevNodes.forEach((prevNode, index) => {
    const prevHost = normalizeDomainInput(prevNode?.url || '');
    const targetId = String(nextNodes[index]?.id || prevNode?.id || '').trim();
    if (prevHost && targetId) legacyHostToNodeId.set(prevHost, targetId);
  });

  return codes.map((rawItem) => {
    const item = normalizeCodeItem(rawItem);
    let bindNode = null;

    if (item.node_id && nextById.has(item.node_id)) {
      bindNode = nextById.get(item.node_id);
    } else if (item.node_host && nextByHost.has(item.node_host)) {
      bindNode = nextByHost.get(item.node_host);
    } else if (item.node_host && legacyHostToNodeId.has(item.node_host)) {
      const mappedId = legacyHostToNodeId.get(item.node_host);
      bindNode = mappedId ? nextById.get(mappedId) || null : null;
    }

    if (!bindNode) return item;
    return {
      ...item,
      node_id: String(bindNode.id || '').trim(),
      node_host: normalizeDomainInput(bindNode.url || ''),
      node_name: String(bindNode.name || '').trim(),
    };
  });
}

function pickNodesByDomain(nodes, domainInput) {
  const host = normalizeDomainInput(domainInput);
  if (!host) return [];
  return nodes.filter((n) => getUrlHost(n.url).toLowerCase() === host);
}

function resolveTransport(streamSettings) {
  const stream = streamSettings || {};
  const transport = String(stream.network || 'tcp').trim().toLowerCase();
  const security = String(stream.security || '').trim().toLowerCase();
  const isTls = security === 'tls' || security === 'reality';
  const tcpHeaderType = String(stream?.tcpSettings?.header?.type || '').trim().toLowerCase();
  const wsHost = String(stream?.wsSettings?.headers?.Host || '').trim();
  const httpHostRaw = stream?.httpSettings?.host;
  const httpHost = Array.isArray(httpHostRaw) ? httpHostRaw.filter(Boolean).join(',') : String(httpHostRaw || '').trim();
  const tcpHostRaw = stream?.tcpSettings?.header?.request?.headers?.Host;
  const tcpHost = Array.isArray(tcpHostRaw) ? tcpHostRaw.filter(Boolean).join(',') : String(tcpHostRaw || '').trim();
  const grpcAuthority = String(stream?.grpcSettings?.authority || '').trim();
  const host = String(
    wsHost ||
      httpHost ||
      grpcAuthority ||
      tcpHost ||
      ''
  ).trim();
  const wsPath = String(stream?.wsSettings?.path || '').trim();
  const httpPath = String(stream?.httpSettings?.path || '').trim();
  const grpcServiceName = String(stream?.grpcSettings?.serviceName || '').trim();
  const path = String(wsPath || httpPath || grpcServiceName || '').trim();
  const sni = String(stream?.tlsSettings?.serverName || stream?.realitySettings?.serverName || '').trim();
  return { transport, security, isTls, host, path, sni, tcpHeaderType };
}

function buildProtocolLink(inbound, host, profile) {
  const protocol = profile.protocol;
  const port = Number(inbound?.port || 0);
  const remark = String(inbound?.remark || 'subscription');
  const t = resolveTransport(profile.streamSettings);

  if (!host || !Number.isFinite(port) || port <= 0) return '';

  if (protocol === 'shadowsocks') {
    if (!profile.method || !profile.password) return '';
    return buildShadowsocksLink(profile.method, profile.password, host, port, remark);
  }

  if (protocol === 'vmess') {
    if (!profile.id) return '';
    const vmessType = t.transport === 'tcp' ? t.tcpHeaderType || 'none' : 'none';
    const vmessObj = {
      v: '2',
      ps: remark,
      add: host,
      port,
      id: profile.id,
      aid: Number(profile.alterId || 0),
      net: t.transport || 'tcp',
      type: vmessType,
      host: t.host || '',
      path: t.path || '',
      tls: t.isTls ? 'tls' : 'none',
    };
    return `vmess://${encodeBase64PrettyJson(vmessObj)}`;
  }

  if (protocol === 'vless') {
    if (!profile.id) return '';
    const params = new URLSearchParams();
    params.set('encryption', 'none');
    params.set('security', t.security || 'none');
    params.set('type', t.transport || 'tcp');
    if (profile.flow) params.set('flow', profile.flow);
    if (t.host) params.set('host', t.host);
    if (t.path) params.set('path', t.path);
    if (t.sni) params.set('sni', t.sni);
    return `vless://${encodeURIComponent(profile.id)}@${host}:${port}?${params.toString()}#${encodeURIComponent(remark)}`;
  }

  if (protocol === 'trojan') {
    if (!profile.password) return '';
    const params = new URLSearchParams();
    params.set('security', t.security || 'none');
    params.set('type', t.transport || 'tcp');
    if (profile.flow) params.set('flow', profile.flow);
    if (t.host) params.set('host', t.host);
    if (t.path) params.set('path', t.path);
    if (t.sni) params.set('sni', t.sni);
    return `trojan://${encodeURIComponent(profile.password)}@${host}:${port}?${params.toString()}#${encodeURIComponent(remark)}`;
  }

  if (protocol === 'socks') {
    const auth = profile.user && profile.pass ? `${encodeURIComponent(profile.user)}:${encodeURIComponent(profile.pass)}@` : '';
    return `socks://${auth}${host}:${port}`;
  }

  if (protocol === 'http') {
    const auth = profile.user && profile.pass ? `${encodeURIComponent(profile.user)}:${encodeURIComponent(profile.pass)}@` : '';
    return `http://${auth}${host}:${port}`;
  }

  return '';
}

function inboundMatches(item, queryKey) {
  if (!item?.enable) return false;
  const key = String(queryKey || '').trim();
  if (!key) return false;
  const profile = parseInboundProfile(item);
  return profile.authCandidates.includes(key);
}

function buildUserResult(inbound, node, profile) {
  const host = getUrlHost(node.url);
  const protocol = String(inbound?.protocol || profile?.protocol || '').trim().toUpperCase();
  return {
    remark: inbound.remark,
    node_name: node.name,
    protocol: protocol || 'UNKNOWN',
    usage: {
      total_used_gb: bytesToGb((Number(inbound.up) || 0) + (Number(inbound.down) || 0)),
      quota_gb: bytesToGb(Number(inbound.total) || 0),
    },
    expiry: parseXuiDate(inbound.expiryTime),
    subscription_link: buildProtocolLink(inbound, host, profile),
  };
}

function isValidAdminToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return false;
  if (!runtimeAdminTokenSha256) return false;
  return safeCompare(hashSha256(token), runtimeAdminTokenSha256);
}

function requireAdminSession(req, res, next) {
  if (!ADMIN_PATH_KEY || !ADMIN_API_BASE) {
    return res.status(503).json({ message: '管理员路径未配置，请设置 ADMIN_PATH_KEY' });
  }
  if (!hasAdminTokenConfigured()) {
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

  const profile = parseInboundProfile(inbound);
  if (!profile || !profile.protocol) {
    throw new Error(`node ${nodeKey(node, index)} invalid settings`);
  }

  const host = getUrlHost(node.url);
  if (!host) {
    throw new Error(`node ${nodeKey(node, index)} host missing`);
  }

  return { inbound, profile, session };
}

async function queryNode(node, queryKey, index) {
  const found = await findInboundOnNode(node, queryKey, index);
  return buildUserResult(found.inbound, node, found.profile);
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
  const renewHost = normalizeDomainInput(nodeDomain);
  const scopedNodeIds = new Set(scopedNodes.map((node) => String(node?.id || '').trim()).filter(Boolean));
  if (codeItem.node_id) {
    if (!scopedNodeIds.has(String(codeItem.node_id).trim())) {
      return res.status(403).json({ message: '该兑换码不可用于当前节点' });
    }
  } else if (codeItem.node_host && codeItem.node_host !== renewHost) {
    return res.status(403).json({ message: '该兑换码不可用于当前节点' });
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
      ...buildUserResult(renewedInbound, found.node, found.profile),
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

app.post(`${ADMIN_API_BASE}/auth/update-token`, adminLimiter, requireAdminSession, async (req, res) => {
  const nextToken = String(req.body?.token || '').trim();
  if (nextToken.length < 8) {
    return res.status(400).json({ message: '新令牌长度至少 8 位' });
  }

  const prevHash = runtimeAdminTokenSha256;
  const nextHash = hashSha256(nextToken);
  runtimeAdminTokenSha256 = nextHash;

  try {
    await saveAppConfig({ admin_token_sha256: nextHash });
    res.clearCookie(ADMIN_SESSION_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      secure: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
      path: ADMIN_API_BASE,
    });
    return res.status(200).json({ message: '管理员令牌已更新，请重新登录' });
  } catch (e) {
    runtimeAdminTokenSha256 = prevHash;
    return res.status(500).json({ message: '更新管理员令牌失败' });
  }
});

app.post(`${ADMIN_API_BASE}/auth/login`, adminLimiter, async (req, res) => {
  if (!ADMIN_PATH_KEY || !ADMIN_API_BASE) {
    return res.status(503).json({ message: '管理员路径未配置，请设置 ADMIN_PATH_KEY' });
  }
  if (!hasAdminTokenConfigured()) {
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
    const prevNodes = await loadNodes().catch(() => []);
    const normalizedNodes = rawNodes.map((n, i) => normalizeNode(n, i));
    validateNodeUniqueness(normalizedNodes);
    const nodes = ensureNodeIds(normalizedNodes, prevNodes);
    await saveNodes(nodes);

    const prevCodes = await loadCodes().catch(() => []);
    const syncedCodes = syncCodesWithNodes(prevCodes, prevNodes, nodes);
    await saveCodes(syncedCodes);

    return res.status(200).json({ message: '节点配置保存成功', count: nodes.length, nodes });
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
  const nodeHost = normalizeDomainInput(req.body?.node_host || '');
  if (!nodeHost) return res.status(400).json({ message: 'node_host 不能为空' });

  try {
    const nodes = await loadNodes();
    const bindNode = nodes.find((node) => getUrlHost(node.url).toLowerCase() === nodeHost);
    if (!bindNode) return res.status(400).json({ message: '绑定节点不存在或已变更' });

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
        node_id: String(bindNode.id || '').trim(),
        node_host: nodeHost,
        node_name: bindNode.name,
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
    const scopedCodesRaw = Array.isArray(req.body?.codes) ? req.body.codes : null;
    const scopedSet = scopedCodesRaw
      ? new Set(scopedCodesRaw.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean))
      : null;

    const next = [];
    let removed = 0;
    codes.forEach((item) => {
      const code = String(item.code || '').toUpperCase();
      const inScope = scopedSet ? scopedSet.has(code) : true;
      if (inScope && (item.used || item.revoked)) {
        removed += 1;
        return;
      }
      next.push(item);
    });

    await saveCodes(next);
    return res.status(200).json({ message: '清理完成', removed, total: next.length });
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
    const scopedCodesRaw = Array.isArray(req.body?.codes) ? req.body.codes : null;
    if (!scopedCodesRaw) {
      await saveCodes([]);
      return res.status(200).json({ message: '已删除全部兑换码', total: 0, removed: -1 });
    }

    const scopedSet = new Set(scopedCodesRaw.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean));
    const codes = await loadCodes();
    const next = codes.filter((item) => !scopedSet.has(String(item.code || '').toUpperCase()));
    const removed = codes.length - next.length;
    await saveCodes(next);
    return res.status(200).json({ message: '已删除选中兑换码', total: next.length, removed });
  } catch (e) {
    return res.status(500).json({ message: '删除全部兑换码失败' });
  }
});

app.get(`${ADMIN_API_BASE}/settings`, adminLimiter, requireAdminSession, async (req, res) => {
  try {
    const config = await loadAppConfig();
    return res.status(200).json({ purchase_url: config.purchase_url });
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

async function bootstrapAndStart() {
  try {
    const config = await loadAppConfig();
    if (config.admin_token_sha256) {
      runtimeAdminTokenSha256 = config.admin_token_sha256;
    }
  } catch (_) {}

  app.listen(PORT, () => {
    console.log(`BFF gateway listening on port ${PORT}`);
  });
}

bootstrapAndStart();
