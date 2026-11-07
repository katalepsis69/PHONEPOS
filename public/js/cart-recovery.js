export function serializeCartForRecovery(cart) {
  return JSON.stringify(Array.isArray(cart) ? cart : []);
}

export function deserializeCartForRecovery(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}