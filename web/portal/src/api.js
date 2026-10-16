const API_BASE = '/api/portal';

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// The merchant's portal branding (heading, colour, logo, support email).
export function getBranding(shopSlug) {
  return apiFetch(`/shops/${encodeURIComponent(shopSlug)}/branding`);
}

export function lookupOrder(email, orderNumber, shopSlug) {
  return apiFetch('/lookup', {
    method: 'POST',
    body: JSON.stringify({ email, orderNumber, shopSlug }),
  });
}

export function createReturn(data) {
  return apiFetch('/returns', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getReturnStatus(returnId, email) {
  return apiFetch(`/returns/${returnId}?email=${encodeURIComponent(email || '')}`);
}

// Preview the return fee for the chosen items/reasons before submitting.
export function quoteReturn(shopId, items) {
  return apiFetch('/quote', {
    method: 'POST',
    body: JSON.stringify({ shopId, items }),
  });
}

export function uploadPhotos(returnId, files, email, itemId) {
  const formData = new FormData();
  files.forEach((file) => formData.append('photos', file));
  formData.append('email', email || '');
  if (itemId) formData.append('itemId', itemId);
  return fetch(`${API_BASE}/returns/${returnId}/photos`, {
    method: 'POST',
    body: formData,
  }).then((res) => res.json());
}

export function getDropoffLocations(shopId, carrier, postcode) {
  return apiFetch(`/carriers/${shopId}/dropoff?carrier=${carrier}&postcode=${postcode}`);
}
