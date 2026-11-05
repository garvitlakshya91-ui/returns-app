const API_BASE = '/api/admin';

// Session token via the CDN App Bridge global (`window.shopify`), loaded
// from https://cdn.shopify.com/shopifycloud/app-bridge.js in index.html.
// shopify.idToken() returns a fresh signed session-token JWT that the
// backend verifies in verifyShopifySession. Falls back to 'dev-token' when
// not embedded (e.g. local standalone dev) — the backend rejects that, which
// is the expected behavior outside Shopify Admin.
async function getToken() {
  if (typeof window !== 'undefined' && window.shopify && typeof window.shopify.idToken === 'function') {
    try {
      return await window.shopify.idToken();
    } catch (err) {
      console.warn('App Bridge idToken error:', err);
    }
  }
  return 'dev-token';
}

async function apiFetch(path, options = {}) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Request failed' }));
    const err = new Error(body.error || `HTTP ${res.status}`);
    // Machine-readable detail the pages act on (e.g. a 409 with a fix).
    err.status = res.status;
    err.code = body.code || null;
    err.reason = body.reason || null;
    err.planUrl = body.planUrl || null;
    throw err;
  }
  return res.json();
}

export const returnsApi = {
  stats: () => apiFetch('/returns/stats'),
  list: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/returns${qs ? `?${qs}` : ''}`);
  },
  get: (id) => apiFetch(`/returns/${id}`),
  // opts.withoutLabel: approve with no label; the customer posts it themselves.
  approve: (id, opts = {}) => apiFetch(`/returns/${id}/approve`, { method: 'PUT', body: JSON.stringify(opts) }),
  reject: (id, reason) => apiFetch(`/returns/${id}/reject`, {
    method: 'PUT',
    body: JSON.stringify({ reason }),
  }),
  process: (id) => apiFetch(`/returns/${id}/process`, { method: 'PUT' }),
  generateLabel: (id) => apiFetch(`/returns/${id}/label`, { method: 'PUT' }),
  markReceived: (id) => apiFetch(`/returns/${id}/received`, { method: 'PUT' }),
  bulk: (action, ids, reason, opts = {}) => apiFetch('/returns/bulk', {
    method: 'POST',
    body: JSON.stringify({ action, ids, reason, ...opts }),
  }),
  demo: () => apiFetch('/returns/demo', { method: 'POST' }),
};

export const policiesApi = {
  list: () => apiFetch('/policies'),
  create: (data) => apiFetch('/policies', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) => apiFetch(`/policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
};

export const settingsApi = {
  get: () => apiFetch('/settings'),
  update: (settings) => apiFetch('/settings', { method: 'PUT', body: JSON.stringify({ settings }) }),
};

export const analyticsApi = {
  summary: (days = 30) => apiFetch(`/analytics/summary?days=${days}`),
  skus: (limit = 10) => apiFetch(`/analytics/skus?limit=${limit}`),
  trend: (days = 30) => apiFetch(`/analytics/trend?days=${days}`),
  // The export needs the session token, so it cannot be a plain link.
  downloadExport: async () => {
    const token = await getToken();
    const res = await fetch(`${API_BASE}/analytics/export`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Export failed' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'returns.csv';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};

export const billingApi = {
  plans: () => apiFetch('/billing/plans'),
  // Whether managed labels can be bought right now ({ allowed, reason, message, planUrl }).
  labels: () => apiFetch('/billing/labels'),
  subscribe: (plan, interval) => apiFetch('/billing/subscribe', {
    method: 'POST',
    body: JSON.stringify({ plan, interval }),
  }),
  confirm: (plan) => apiFetch('/billing/confirm', {
    method: 'POST',
    body: JSON.stringify({ plan }),
  }),
};

export const carriersApi = {
  list: () => apiFetch('/carriers'),
  save: (data) => apiFetch('/carriers', { method: 'POST', body: JSON.stringify(data) }),
  delete: (id) => apiFetch(`/carriers/${id}`, { method: 'DELETE' }),
};
