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
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const returnsApi = {
  list: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/returns${qs ? `?${qs}` : ''}`);
  },
  get: (id) => apiFetch(`/returns/${id}`),
  approve: (id) => apiFetch(`/returns/${id}/approve`, { method: 'PUT' }),
  reject: (id, reason) => apiFetch(`/returns/${id}/reject`, {
    method: 'PUT',
    body: JSON.stringify({ reason }),
  }),
  process: (id) => apiFetch(`/returns/${id}/process`, { method: 'PUT' }),
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
  exportUrl: () => `${API_BASE}/analytics/export`,
};

export const billingApi = {
  plans: () => apiFetch('/billing/plans'),
  subscribe: (plan) => apiFetch('/billing/subscribe', {
    method: 'POST',
    body: JSON.stringify({ plan }),
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
