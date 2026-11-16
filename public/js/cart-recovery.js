export function serializeCartForRecovery(cart) {
  return JSON.stringify(Array.isArray(cart) ? cart : []);
}

export function deserializeCartForRecovery(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Shape-validate: a tampered or corrupt storage blob must not interpolate
    // garbage qty into the display strings. Money math is Number-guarded, but
    // the rendering is not.
    return parsed.filter(it => it && typeof it === 'object' && Number.isFinite(Number(it.qty)) && Number(it.qty) > 0);
  } catch (_) {
    return [];
  }
}