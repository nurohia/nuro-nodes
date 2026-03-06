<template>
  <main class="page-wrap">
    <section class="panel">
      <header class="hero">
        <div class="hero-glow"></div>
        <h1>Nuro-Nodes</h1>
        <p>{{ isAdminView ? '私有后台管理控制台' : '节点状态查询中心' }}</p>
        <div v-if="isAdminView && adminReady" class="hero-actions">
          <button class="btn" :disabled="adminBusy" @click="openPurchaseDialog">购买地址</button>
          <button class="btn secondary" :disabled="adminBusy" @click="clearAdminToken">退出后台</button>
        </div>
      </header>

      <section v-if="!isAdminView" class="query-view">
        <div v-if="!result" class="auth-box">
          <label for="nodeDomain">节点域名</label>
          <input
            id="nodeDomain"
            v-model.trim="nodeDomain"
            type="text"
            placeholder="例如: node-a.example.com"
            :disabled="loading"
          />

          <label for="credential">节点密码</label>
          <input
            id="credential"
            v-model.trim="password"
            type="password"
            placeholder="请输入节点密码"
            :disabled="loading"
            @keyup.enter="handleSubmit"
          />

          <button class="btn" :disabled="loading || !password || !nodeDomain" @click="handleSubmit">
            <span v-if="loading" class="spinner"></span>
            <span>{{ loading ? '查询中...' : '立即查询' }}</span>
          </button>
        </div>

        <div v-else class="dashboard">
          <article class="kpi">
            <p>已用流量</p>
            <h2>{{ result.usage.total_used_gb }} GB</h2>
          </article>
          <article class="kpi">
            <p>剩余/总量</p>
            <h2>{{ remainingText }}</h2>
          </article>
          <article class="kpi wide">
            <p>到期时间</p>
            <h2>{{ result.expiry }}</h2>
          </article>

          <article class="sub-card">
            <p>订阅链接</p>
            <code>{{ result.subscription_link }}</code>
            <div class="btn-row quad">
              <button class="btn" @click="copyLink">一键复制</button>
              <button class="btn secondary" @click="openRenew">续费</button>
              <button class="btn" @click="goBuyCode">购买兑换码</button>
              <button class="btn secondary" @click="resetView">返回查询</button>
            </div>
          </article>
        </div>
      </section>

      <section v-else class="admin-view">
        <div v-if="!adminReady" class="auth-box">
          <label for="adminToken">管理员令牌</label>
          <div class="inline">
            <input
              id="adminToken"
              v-model.trim="adminLoginToken"
              type="password"
              name="nexus_admin_token_login"
              autocomplete="new-password"
              autocapitalize="off"
              spellcheck="false"
              placeholder="请输入 ADMIN_TOKEN"
              :disabled="adminBusy"
              @keyup.enter="loginAdminFromLogin"
            />
            <button class="btn" :disabled="adminBusy || !adminLoginToken" @click="loginAdminFromLogin">
              <span v-if="adminBusy" class="spinner"></span>
              <span>{{ adminBusy ? '连接中...' : '进入后台' }}</span>
            </button>
          </div>
        </div>

        <div v-if="adminReady" class="admin-panel">
          <div class="panel-meta">
            <span>节点总数 {{ adminNodes.length }}</span>
            <span>兑换码总数 {{ codeList.length }}</span>
          </div>

          <div class="admin-menu">
            <button class="btn" :class="{ secondary: adminTab === 'dashboard' }" @click="switchAdminTab('dashboard')">仪表盘</button>
            <button class="btn" :class="{ secondary: adminTab === 'nodes' }" @click="switchAdminTab('nodes')">面板管理</button>
            <button class="btn" :class="{ secondary: adminTab === 'codes' }" @click="switchAdminTab('codes')">兑换码管理</button>
          </div>

          <div v-if="adminTab === 'dashboard'" class="admin-dashboard admin-pane">
            <div class="token-tools">
              <input
                v-model.trim="adminUpdateToken"
                type="password"
                name="nexus_admin_token_update"
                autocomplete="new-password"
                autocapitalize="off"
                spellcheck="false"
                placeholder="输入新令牌后点击更新"
                :disabled="adminBusy"
                @keyup.enter="loginAdminFromUpdate"
              />
              <button class="btn" :disabled="adminBusy || !adminUpdateToken" @click="loginAdminFromUpdate">更新令牌</button>
            </div>
            <article class="kpi">
              <p>节点数量</p>
              <h2>{{ adminNodes.length }}</h2>
            </article>
            <article class="kpi">
              <p>可用兑换码</p>
              <h2>{{ availableCodeCount }}</h2>
            </article>
            <article class="kpi">
              <p>已使用兑换码</p>
              <h2>{{ usedCodeCount }}</h2>
            </article>
            <article class="kpi">
              <p>已作废兑换码</p>
              <h2>{{ revokedCodeCount }}</h2>
            </article>
          </div>

          <div v-if="adminTab === 'nodes'" class="admin-pane">
            <div class="toolbar">
              <button class="btn" :disabled="adminBusy" @click="testAllNodes">全量检测</button>
              <button class="btn" :disabled="adminBusy" @click="addNode">新增节点</button>
              <button class="btn secondary" :disabled="adminBusy" @click="saveNodes">保存配置</button>
            </div>

            <div v-if="!adminNodes.length" class="empty-card">
              <strong>暂无节点数据</strong>
              <p>点击“新增节点”后填写 x-ui 信息，再保存配置。</p>
            </div>

            <div v-else class="node-grid-wrap">
              <div class="node-grid">
                <article v-for="(node, index) in adminNodes" :key="`node-${index}`" class="node-card">
                  <div class="node-header">
                    <strong>节点 {{ index + 1 }}</strong>
                    <span class="badge" :class="healthClass(nodeHealthId(node, index))">
                      {{ healthText(nodeHealthId(node, index)) }}
                    </span>
                  </div>

                  <label>显示名称</label>
                  <input v-model.trim="node.name" type="text" placeholder="TW-SeedNet" />

                  <label>x-ui 地址</label>
                  <input v-model.trim="node.url" type="text" placeholder="http://example.com:8080" />

                  <label>x-ui 账号</label>
                  <input v-model.trim="node.user" type="text" placeholder="admin" />

                  <label>x-ui 密码</label>
                  <input v-model.trim="node.pass" type="password" placeholder="******" />

                  <div class="btn-row">
                    <button class="btn" :disabled="adminBusy" @click="testOneNode(node)">测试</button>
                    <button class="btn danger" :disabled="adminBusy" @click="removeNode(index)">删除</button>
                  </div>
                </article>
              </div>
            </div>
          </div>

          <section v-if="adminTab === 'codes'" class="code-manager admin-pane">
            <div class="code-head">
              <strong>兑换码管理</strong>
              <div class="code-head-actions">
                <button class="btn danger" :disabled="adminBusy || !filteredCodeList.length" @click="deleteAllCodes">一键删除</button>
                <button class="btn danger" :disabled="adminBusy || !filteredCodeList.length" @click="cleanupCodes">一键清理</button>
                <button class="btn" :disabled="adminBusy || !codeList.length" @click="openFilterDialog">查询</button>
              </div>
            </div>
            <div class="code-gen">
              <input v-model.number="genCount" type="number" min="1" max="200" placeholder="数量" />
              <input v-model.number="genMonths" type="number" min="1" max="12" placeholder="月数" />
              <input v-model.trim="genPrefix" type="text" maxlength="8" placeholder="前缀 NX" />
              <button class="btn secondary" :disabled="adminBusy || !nodeOptions.length" @click="openGenerateDialog">生成兑换码</button>
            </div>
            <div v-if="!filteredCodeList.length" class="empty-card">
              <strong>暂无兑换码数据</strong>
              <p>可以先生成兑换码，或调整查询筛选条件。</p>
            </div>

            <div v-else class="code-list">
              <article v-for="item in filteredCodeList" :key="item.code" class="code-item">
                <div>
                  <strong>{{ item.code }}</strong>
                  <p>{{ item.months }}个月 · {{ item.used ? '已使用' : item.revoked ? '已作废' : '可用' }}</p>
                  <p class="code-node">面板：{{ item.node_name || item.node_host || '未绑定' }}</p>
                </div>
                <div class="code-item-actions">
                  <button class="btn danger" :disabled="adminBusy" @click="deleteCode(item.code)">删除</button>
                  <button
                    class="btn danger"
                    :disabled="adminBusy || item.used || item.revoked"
                    @click="revokeCode(item.code)"
                  >
                    作废
                  </button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </section>
    </section>

    <div v-if="showRenew" class="renew-mask" @click.self="closeRenew">
      <div class="renew-dialog">
        <h3>输入兑换码续费</h3>
        <input
          v-model.trim="renewCode"
          type="text"
          placeholder="请输入兑换码"
          :disabled="renewBusy"
          @keyup.enter="submitRenew"
        />
        <div class="btn-row">
          <button class="btn secondary" :disabled="renewBusy" @click="closeRenew">取消</button>
          <button class="btn" :disabled="renewBusy || !renewCode" @click="submitRenew">确认续费</button>
        </div>
      </div>
    </div>

    <div v-if="showPurchaseDialog" class="renew-mask" @click.self="closePurchaseDialog">
      <div class="renew-dialog">
        <h3>设置购买地址</h3>
        <input
          v-model.trim="purchaseInput"
          type="text"
          placeholder="https://shop.example.com"
          :disabled="purchaseBusy"
          @keyup.enter="savePurchaseUrl"
        />
        <div class="btn-row">
          <button class="btn secondary" :disabled="purchaseBusy" @click="closePurchaseDialog">取消</button>
          <button class="btn" :disabled="purchaseBusy" @click="savePurchaseUrl">保存</button>
        </div>
      </div>
    </div>

    <div v-if="showGenerateDialog" class="renew-mask" @click.self="closeGenerateDialog">
      <div class="renew-dialog">
        <h3>生成兑换码</h3>
        <select v-model="genNodeHost" :disabled="adminBusy || generatedCodes.length > 0">
          <option disabled value="">请选择节点</option>
          <option v-for="node in nodeOptions" :key="node.host" :value="node.host">{{ node.label }}</option>
        </select>
        <div v-if="generatedCodes.length" class="generated-box">
          <button
            v-for="item in generatedCodes"
            :key="item.code"
            type="button"
            class="code-chip"
            @click="copyGeneratedOne(item.code)"
          >
            {{ item.code }}
          </button>
        </div>
        <div class="btn-row">
          <button class="btn secondary" :disabled="adminBusy" @click="closeGenerateDialog">取消</button>
          <button
            v-if="!generatedCodes.length"
            class="btn"
            :disabled="adminBusy || !genNodeHost"
            @click="generateCodes"
          >
            弹窗生成
          </button>
          <button v-else class="btn" :disabled="adminBusy" @click="copyGeneratedAndConfirm">复制并确定</button>
        </div>
      </div>
    </div>

    <div v-if="showFilterDialog" class="renew-mask" @click.self="closeFilterDialog">
      <div class="renew-dialog">
        <h3>查询兑换码</h3>
        <select v-model="pendingFilterHost" :disabled="adminBusy">
          <option value="ALL">全部节点</option>
          <option v-for="node in nodeOptions" :key="`filter-${node.host}`" :value="node.host">{{ node.label }}</option>
        </select>
        <div class="btn-row">
          <button class="btn secondary" :disabled="adminBusy" @click="closeFilterDialog">取消</button>
          <button class="btn" :disabled="adminBusy" @click="applyFilter">确定查询</button>
        </div>
      </div>
    </div>

    <transition name="toast-fade">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>
  </main>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const ADMIN_PATH_KEY = String(import.meta.env.VITE_ADMIN_PATH_KEY || '').trim();
const isAdminView = Boolean(ADMIN_PATH_KEY && window.location.pathname === `/${ADMIN_PATH_KEY}`);
const ADMIN_API_BASE = `${API_BASE}/api/internal/${ADMIN_PATH_KEY}`;

const nodeDomain = ref('');
const password = ref('');
const loading = ref(false);
const result = ref(null);
const toast = ref('');

const showRenew = ref(false);
const renewCode = ref('');
const renewBusy = ref(false);
const purchaseUrl = ref('');
const showPurchaseDialog = ref(false);
const purchaseInput = ref('');
const purchaseBusy = ref(false);

const adminLoginToken = ref('');
const adminUpdateToken = ref('');
const adminBusy = ref(false);
const adminReady = ref(false);
const adminTab = ref('dashboard');
const adminNodes = ref([]);
const savedNodesSnapshot = ref('[]');
const healthMap = ref({});
const codeList = ref([]);
const genCount = ref(10);
const genMonths = ref(1);
const genPrefix = ref('NX');
const showGenerateDialog = ref(false);
const genNodeHost = ref('');
const generatedCodes = ref([]);
const showFilterDialog = ref(false);
const codeNodeFilter = ref('ALL');
const pendingFilterHost = ref('ALL');
const codeNodeHints = ref({});

const remainingText = computed(() => {
  if (!result.value?.usage) return '--';
  const used = Number(result.value.usage.total_used_gb || 0);
  const quota = Number(result.value.usage.quota_gb || 0);
  if (!Number.isFinite(quota) || quota <= 0) return '∞';
  return `${Math.max(quota - used, 0).toFixed(2)} / ${quota.toFixed(2)} GB`;
});

const availableCodeCount = computed(() => codeList.value.filter((c) => !c.used && !c.revoked).length);
const usedCodeCount = computed(() => codeList.value.filter((c) => c.used).length);
const revokedCodeCount = computed(() => codeList.value.filter((c) => c.revoked).length);
const hasUnsavedNodesChanges = computed(() => {
  if (!adminReady.value) return false;
  return JSON.stringify(adminNodes.value || []) !== savedNodesSnapshot.value;
});
const nodeOptions = computed(() =>
  (adminNodes.value || [])
    .map((node, index) => {
      const host = normalizeHost(node?.url || '');
      if (!host) return null;
      return {
        host,
        label: `${String(node?.name || `节点 ${index + 1}`)} (${host})`,
      };
    })
    .filter(Boolean)
);
const filteredCodeList = computed(() => {
  if (codeNodeFilter.value === 'ALL') return codeList.value;
  return codeList.value.filter((item) => String(item.node_host || '').toLowerCase() === codeNodeFilter.value);
});

onMounted(() => {
  fetchPublicMeta();
  if (isAdminView) restoreAdminSession();
});

function showToast(msg) {
  toast.value = msg;
  setTimeout(() => {
    toast.value = '';
  }, 2200);
}

function mapError(status) {
  if (status === 401 || status === 404) return '未找到该凭证或节点已停机';
  if (status === 429) return '请求过快，请稍后再试';
  if (status === 400) return '请输入有效域名与凭证';
  return '服务暂时不可用，请稍后重试';
}

function mapRenewError(status) {
  if (status === 401) return '兑换码无效或已使用';
  if (status === 403) return '该兑换码不属于当前节点';
  if (status === 400) return '请输入有效的节点域名、凭证和兑换码';
  if (status === 404) return '未找到该凭证或节点已停机';
  if (status === 429) return '续费请求过快，请稍后再试';
  return '续费失败，请稍后重试';
}

function mapAdminError(status) {
  if (status === 401) return '管理员令牌错误或会话失效';
  if (status === 403) return '管理接口访问被拒绝';
  if (status === 503) return '服务端未配置管理员参数';
  if (status === 400) return '请求参数格式不正确';
  if (status === 429) return '管理请求过快，请稍后再试';
  return '后台操作失败，请检查配置';
}

function adminHeaders() {
  return { 'Content-Type': 'application/json' };
}

function normalizeHost(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    if (raw.includes('://')) return new URL(raw).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
  const noPath = raw.split('/')[0];
  const host = noPath.split(':')[0];
  return String(host || '').toLowerCase();
}

function nodeHealthId(node, index) {
  const fromUrl = (() => {
    try {
      return new URL(String(node?.url || '')).hostname;
    } catch (e) {
      return '';
    }
  })();
  return String(node?.id || node?.name || fromUrl || `node_${index + 1}`);
}

async function handleSubmit() {
  if (!nodeDomain.value || !password.value || loading.value) return;
  loading.value = true;

  try {
    const resp = await fetch(`${API_BASE}/api/node/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node_domain: nodeDomain.value,
        password: password.value,
      }),
    });
    if (!resp.ok) throw new Error(String(resp.status));

    result.value = await resp.json();
    showToast('查询成功');
  } catch (err) {
    showToast(mapError(Number(err.message || 0)));
  } finally {
    loading.value = false;
  }
}

async function copyLink() {
  if (!result.value?.subscription_link) return;
  try {
    await navigator.clipboard.writeText(result.value.subscription_link);
    showToast('订阅链接已复制');
  } catch (_) {
    showToast('复制失败，请手动复制');
  }
}

function resetView() {
  result.value = null;
  password.value = '';
}

function openRenew() {
  renewCode.value = '';
  showRenew.value = true;
}

function closeRenew() {
  if (renewBusy.value) return;
  showRenew.value = false;
}

function openPurchaseDialog() {
  purchaseInput.value = purchaseUrl.value;
  showPurchaseDialog.value = true;
}

function closePurchaseDialog() {
  if (purchaseBusy.value) return;
  showPurchaseDialog.value = false;
}

async function savePurchaseUrl() {
  if (!adminReady.value || purchaseBusy.value) return;
  purchaseBusy.value = true;
  try {
    const resp = await fetch(`${ADMIN_API_BASE}/settings/purchase-url`, {
      method: 'POST',
      headers: adminHeaders(),
      credentials: 'include',
      body: JSON.stringify({ purchase_url: purchaseInput.value }),
    });
    if (!resp.ok) throw new Error(String(resp.status));
    const data = await resp.json();
    purchaseUrl.value = String(data?.purchase_url || '').trim();
    showPurchaseDialog.value = false;
    showToast('购买地址已更新');
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    purchaseBusy.value = false;
  }
}

function goBuyCode() {
  if (!purchaseUrl.value) {
    showToast('暂未设置购买地址');
    return;
  }
  window.open(purchaseUrl.value, '_blank', 'noopener,noreferrer');
}

async function submitRenew() {
  if (!nodeDomain.value || !password.value || !renewCode.value || renewBusy.value) return;
  renewBusy.value = true;

  try {
    const resp = await fetch(`${API_BASE}/api/node/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        node_domain: nodeDomain.value,
        password: password.value,
        redeem_code: renewCode.value,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(String(resp.status));
      err.detail = String(data?.message || '').trim();
      throw err;
    }
    result.value = data;
    showRenew.value = false;
    renewCode.value = '';
    showToast(`续费成功 +${data?.renew?.months || 1}个月`);
  } catch (err) {
    const status = Number(err?.message || 0);
    const detail = String(err?.detail || '').trim();
    showToast(detail || mapRenewError(status));
  } finally {
    renewBusy.value = false;
  }
}

async function fetchAdminNodes() {
  const resp = await fetch(`${ADMIN_API_BASE}/nodes`, {
    method: 'GET',
    headers: adminHeaders(),
    credentials: 'include',
  });
  if (!resp.ok) throw new Error(String(resp.status));

  const data = await resp.json();
  adminNodes.value = Array.isArray(data.nodes) ? data.nodes : [];
  savedNodesSnapshot.value = JSON.stringify(adminNodes.value || []);
  healthMap.value = {};
  if (!nodeOptions.value.some((item) => item.host === genNodeHost.value)) {
    genNodeHost.value = nodeOptions.value[0]?.host || '';
  }
  adminReady.value = true;
}

async function fetchCodes() {
  const resp = await fetch(`${ADMIN_API_BASE}/codes`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!resp.ok) throw new Error(String(resp.status));
  const data = await resp.json();
  codeList.value = Array.isArray(data.codes)
    ? data.codes.map((item) => ({
        ...item,
        node_host:
          normalizeHost(item?.node_host || '') ||
          normalizeHost(codeNodeHints.value[String(item?.code || '').toUpperCase()]?.node_host || ''),
        node_name:
          String(item?.node_name || '').trim() ||
          String(codeNodeHints.value[String(item?.code || '').toUpperCase()]?.node_name || '').trim(),
      }))
    : [];
  if (codeNodeFilter.value !== 'ALL' && !nodeOptions.value.some((x) => x.host === codeNodeFilter.value)) {
    codeNodeFilter.value = 'ALL';
  }
}

async function fetchPublicMeta() {
  try {
    const resp = await fetch(`${API_BASE}/api/public/meta`, { method: 'GET' });
    if (!resp.ok) return;
    const data = await resp.json();
    purchaseUrl.value = String(data?.purchase_url || '').trim();
  } catch (_) {}
}

async function fetchAdminSettings() {
  const resp = await fetch(`${ADMIN_API_BASE}/settings`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!resp.ok) throw new Error(String(resp.status));
  const data = await resp.json();
  purchaseUrl.value = String(data?.purchase_url || '').trim();
}

async function authenticateAdmin(token, opts = {}) {
  const successText = String(opts?.successText || '已进入后台');
  const dropReadyOnFail = Boolean(opts?.dropReadyOnFail);
  const rawToken = String(token || '').trim();
  if (!isAdminView || !rawToken || adminBusy.value) return false;
  adminBusy.value = true;

  try {
    const resp = await fetch(`${ADMIN_API_BASE}/auth/login`, {
      method: 'POST',
      headers: adminHeaders(),
      credentials: 'include',
      body: JSON.stringify({ token: rawToken }),
    });
    if (!resp.ok) throw new Error(String(resp.status));

    await Promise.all([fetchAdminNodes(), fetchCodes(), fetchAdminSettings()]);
    adminTab.value = 'dashboard';
    showToast(successText);
    return true;
  } catch (err) {
    if (dropReadyOnFail) adminReady.value = false;
    showToast(mapAdminError(Number(err.message || 0)));
    return false;
  } finally {
    adminBusy.value = false;
  }
}

async function loginAdminFromLogin() {
  const ok = await authenticateAdmin(adminLoginToken.value, {
    successText: '已进入后台',
    dropReadyOnFail: true,
  });
  if (!ok) return;
  adminLoginToken.value = '';
  adminUpdateToken.value = '';
}

async function loginAdminFromUpdate() {
  if (!isAdminView || !adminReady.value || !adminUpdateToken.value || adminBusy.value) return;
  adminBusy.value = true;
  try {
    const resp = await fetch(`${ADMIN_API_BASE}/auth/update-token`, {
      method: 'POST',
      headers: adminHeaders(),
      credentials: 'include',
      body: JSON.stringify({ token: adminUpdateToken.value }),
    });
    if (!resp.ok) throw new Error(String(resp.status));
    resetAdminLocalState();
    showToast('令牌已更新，请重新登录');
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    adminBusy.value = false;
  }
}

async function restoreAdminSession() {
  if (!isAdminView || adminBusy.value) return;
  adminBusy.value = true;

  try {
    const resp = await fetch(`${ADMIN_API_BASE}/auth/status`, {
      method: 'GET',
      credentials: 'include',
    });
    if (!resp.ok) {
      adminReady.value = false;
      return;
    }
    await Promise.all([fetchAdminNodes(), fetchCodes(), fetchAdminSettings()]);
  } catch (_) {
    adminReady.value = false;
  } finally {
    adminBusy.value = false;
  }
}

async function saveNodes() {
  if (!adminReady.value || adminBusy.value) return;
  adminBusy.value = true;

  try {
    const resp = await fetch(`${ADMIN_API_BASE}/nodes`, {
      method: 'POST',
      headers: adminHeaders(),
      credentials: 'include',
      body: JSON.stringify({ nodes: adminNodes.value }),
    });
    if (!resp.ok) throw new Error(String(resp.status));
    savedNodesSnapshot.value = JSON.stringify(adminNodes.value || []);
    showToast('节点配置已保存');
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    adminBusy.value = false;
  }
}

async function testAllNodes() {
  if (!adminReady.value || adminBusy.value) return;
  adminBusy.value = true;

  try {
    const resp = await fetch(`${ADMIN_API_BASE}/nodes/health`, {
      method: 'GET',
      headers: adminHeaders(),
      credentials: 'include',
    });
    if (!resp.ok) throw new Error(String(resp.status));

    const data = await resp.json();
    const checks = Array.isArray(data.checks) ? data.checks : [];
    const next = {};
    checks.forEach((item) => {
      next[item.id] = item;
    });
    healthMap.value = next;
    showToast(`检测完成：${checks.filter((x) => x.ok).length}/${checks.length} 可用`);
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    adminBusy.value = false;
  }
}

async function testOneNode(node) {
  if (!adminReady.value || adminBusy.value) return;
  adminBusy.value = true;
  try {
    const resp = await fetch(`${ADMIN_API_BASE}/nodes/test`, {
      method: 'POST',
      headers: adminHeaders(),
      credentials: 'include',
      body: JSON.stringify({ node }),
    });
    if (!resp.ok) throw new Error(String(resp.status));
    const data = await resp.json();
    healthMap.value = { ...healthMap.value, [data.id]: data };
    showToast(data.ok ? `节点 ${data.name} 可用` : `节点 ${data.name} 不可用`);
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    adminBusy.value = false;
  }
}

function openGenerateDialog() {
  if (!nodeOptions.value.length || adminBusy.value) return;
  genNodeHost.value =
    genNodeHost.value && nodeOptions.value.some((x) => x.host === genNodeHost.value)
      ? genNodeHost.value
      : nodeOptions.value[0].host;
  generatedCodes.value = [];
  showGenerateDialog.value = true;
}

function closeGenerateDialog() {
  if (adminBusy.value) return;
  if (generatedCodes.value.length) {
    showToast('请先点击“复制并确定”完成本次生成');
    return;
  }
  showGenerateDialog.value = false;
  generatedCodes.value = [];
}

function openFilterDialog() {
  if (!codeList.value.length || adminBusy.value) return;
  pendingFilterHost.value = codeNodeFilter.value;
  showFilterDialog.value = true;
}

function closeFilterDialog() {
  if (adminBusy.value) return;
  showFilterDialog.value = false;
}

async function applyFilter() {
  if (adminBusy.value) return;
  adminBusy.value = true;
  try {
    codeNodeFilter.value = pendingFilterHost.value || 'ALL';
    await Promise.all([fetchAdminNodes(), fetchCodes()]);
    showFilterDialog.value = false;
    showToast('查询结果已更新');
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    adminBusy.value = false;
  }
}

async function copyGeneratedOne(code) {
  try {
    await navigator.clipboard.writeText(code);
    showToast('兑换码已复制');
  } catch (_) {
    showToast('复制失败，请手动复制');
  }
}

async function copyGeneratedAndConfirm() {
  if (!generatedCodes.value.length) return;
  try {
    await navigator.clipboard.writeText(generatedCodes.value.map((item) => item.code).join('\n'));
    showToast('兑换码已复制');
  } catch (_) {
    showToast('复制失败，请手动复制');
  }
  await fetchCodes();
  showGenerateDialog.value = false;
  generatedCodes.value = [];
}

async function generateCodes() {
  if (!adminReady.value || adminBusy.value || !genNodeHost.value) return;
  adminBusy.value = true;
  try {
    const resp = await fetch(`${ADMIN_API_BASE}/codes/generate`, {
      method: 'POST',
      headers: adminHeaders(),
      credentials: 'include',
      body: JSON.stringify({
        count: genCount.value,
        months: genMonths.value,
        prefix: genPrefix.value,
        node_host: genNodeHost.value,
      }),
    });
    if (!resp.ok) throw new Error(String(resp.status));
    const data = await resp.json();
    const selectedNode = nodeOptions.value.find((item) => item.host === genNodeHost.value);
    generatedCodes.value = Array.isArray(data.created)
      ? data.created.map((item) => ({
          ...item,
          node_host: normalizeHost(item?.node_host || '') || genNodeHost.value,
          node_name: String(item?.node_name || '').trim() || String(selectedNode?.label || '').split(' (')[0],
        }))
      : [];
    generatedCodes.value.forEach((item) => {
      const key = String(item?.code || '').toUpperCase();
      if (!key) return;
      codeNodeHints.value[key] = {
        node_host: String(item?.node_host || '').toLowerCase(),
        node_name: String(item?.node_name || '').trim(),
      };
    });
    showToast(`已生成 ${generatedCodes.value.length || data.count || 0} 个兑换码`);
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    adminBusy.value = false;
  }
}

async function revokeCode(code) {
  if (!adminReady.value || adminBusy.value) return;
  adminBusy.value = true;
  try {
    const resp = await fetch(`${ADMIN_API_BASE}/codes/revoke`, {
      method: 'POST',
      headers: adminHeaders(),
      credentials: 'include',
      body: JSON.stringify({ code }),
    });
    if (!resp.ok) throw new Error(String(resp.status));
    await fetchCodes();
    showToast('兑换码已作废');
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    adminBusy.value = false;
  }
}

async function cleanupCodes() {
  if (!adminReady.value || adminBusy.value) return;
  const ok = window.confirm('确认清理当前列表中“已使用”和“已作废”的兑换码吗？此操作不可恢复。');
  if (!ok) return;
  const scopedCodes = filteredCodeList.value.map((item) => item.code);
  if (!scopedCodes.length) return;
  adminBusy.value = true;
  try {
    const resp = await fetch(`${ADMIN_API_BASE}/codes/cleanup`, {
      method: 'POST',
      headers: adminHeaders(),
      credentials: 'include',
      body: JSON.stringify({ codes: scopedCodes }),
    });
    if (!resp.ok) throw new Error(String(resp.status));
    const data = await resp.json();
    await fetchCodes();
    showToast(`已清理 ${Number(data.removed || 0)} 条记录`);
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    adminBusy.value = false;
  }
}

async function deleteCode(code) {
  if (!adminReady.value || adminBusy.value) return;
  const ok = window.confirm(`确认删除兑换码 ${code} 吗？此操作不可恢复。`);
  if (!ok) return;
  adminBusy.value = true;
  try {
    const resp = await fetch(`${ADMIN_API_BASE}/codes/delete`, {
      method: 'POST',
      headers: adminHeaders(),
      credentials: 'include',
      body: JSON.stringify({ code }),
    });
    if (!resp.ok) throw new Error(String(resp.status));
    await fetchCodes();
    showToast('兑换码已删除');
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    adminBusy.value = false;
  }
}

async function deleteAllCodes() {
  if (!adminReady.value || adminBusy.value) return;
  const ok = window.confirm('确认删除当前列表中的全部兑换码吗？此操作不可恢复。');
  if (!ok) return;
  const scopedCodes = filteredCodeList.value.map((item) => item.code);
  if (!scopedCodes.length) return;
  adminBusy.value = true;
  try {
    const resp = await fetch(`${ADMIN_API_BASE}/codes/delete-all`, {
      method: 'POST',
      headers: adminHeaders(),
      credentials: 'include',
      body: JSON.stringify({ codes: scopedCodes }),
    });
    if (!resp.ok) throw new Error(String(resp.status));
    await fetchCodes();
    showToast('已删除当前列表兑换码');
  } catch (err) {
    showToast(mapAdminError(Number(err.message || 0)));
  } finally {
    adminBusy.value = false;
  }
}

function addNode() {
  adminNodes.value.push({ name: '', url: '', user: '', pass: '' });
}

function removeNode(index) {
  adminNodes.value.splice(index, 1);
}

function resetAdminLocalState() {
  adminLoginToken.value = '';
  adminUpdateToken.value = '';
  adminReady.value = false;
  adminNodes.value = [];
  healthMap.value = {};
  codeList.value = [];
  showGenerateDialog.value = false;
  showFilterDialog.value = false;
  generatedCodes.value = [];
  codeNodeHints.value = {};
  genNodeHost.value = '';
  codeNodeFilter.value = 'ALL';
  pendingFilterHost.value = 'ALL';
  savedNodesSnapshot.value = '[]';
}

function clearAdminToken() {
  fetch(`${ADMIN_API_BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  }).catch(() => {});
  resetAdminLocalState();
  showToast('已退出后台会话');
}

function restoreNodesFromSnapshot() {
  try {
    adminNodes.value = JSON.parse(savedNodesSnapshot.value || '[]');
  } catch (_) {
    adminNodes.value = [];
  }
}

async function switchAdminTab(nextTab) {
  if (adminBusy.value) return;
  if (adminTab.value === nextTab) return;
  if (adminTab.value === 'nodes' && hasUnsavedNodesChanges.value) {
    const leave = window.confirm('面板管理存在未保存修改，离开后这些修改将丢失。是否继续离开？');
    if (!leave) return;
    restoreNodesFromSnapshot();
    showToast('未保存修改已丢弃');
  }
  adminTab.value = nextTab;
  if (!adminReady.value) return;

  if (nextTab === 'dashboard' || nextTab === 'codes') {
    adminBusy.value = true;
    try {
      await Promise.all([fetchAdminNodes(), fetchCodes()]);
    } catch (err) {
      showToast(mapAdminError(Number(err.message || 0)));
    } finally {
      adminBusy.value = false;
    }
  }
}

function healthText(key) {
  const item = healthMap.value[key];
  if (!item) return '未检测';
  return item.ok ? `可用 ${item.latency_ms}ms` : `不可用: ${item.message}`;
}

function healthClass(key) {
  const item = healthMap.value[key];
  if (!item) return 'idle';
  return item.ok ? 'ok' : 'bad';
}
</script>
