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

export function getReturnStatus(returnId) {
  return apiFetch(`/returns/${returnId}`);
}

export function uploadPhotos(returnId, files) {
  const formData = new FormData();
  files.forEach((file) => formData.append('photos', file));
  return fetch(`${API_BASE}/returns/${returnId}/photos`, {
    method: 'POST',
    body: formData,
  }).then((res) => res.json());
}

export function getDropoffLocations(shopId, carrier, postcode) {
  return apiFetch(`/carriers/${shopId}/dropoff?carrier=${carrier}&postcode=${postcode}`);
}

export function createPayment(returnId) {
  return apiFetch(`/returns/${returnId}/pay`, { method: 'POST' });
}
