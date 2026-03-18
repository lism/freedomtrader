export function log(tag, message, extra) {
  if (extra === undefined) {
    console.log(`[${tag}] ${message}`);
    return;
  }
  console.log(`[${tag}] ${message}`, extra);
}

export function logError(tag, message, error) {
  console.error(`[${tag}] ${message}: ${error?.message || error}`);
}

export function logInfo(tag, message) {
  console.log(`[${tag}] ${message}`);
}
