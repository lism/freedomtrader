export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeAddress(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

export function formatPercent(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}
