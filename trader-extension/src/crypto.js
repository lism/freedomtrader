// 消息代理 - 所有加密操作转发给 background service worker
// 密钥缓存在 background 中，页面切换不丢失

function send(action, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...data }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response?.error) {
        reject(new Error(response.error));
      } else {
        resolve(response);
      }
    });
  });
}

export async function setPassword(password) {
  await send('setPassword', { password });
}

export async function unlock(password) {
  const res = await send('unlock', { password });
  return res.ok;
}

export function lock() {
  return send('lock');
}

export async function isUnlocked() {
  const res = await send('isUnlocked');
  return res.unlocked;
}

export async function hasPassword() {
  const res = await send('hasPassword');
  return res.has;
}

export async function getLockDuration() {
  const res = await send('getLockDuration');
  return res.duration;
}

export async function setLockDuration(minutes) {
  await send('setLockDuration', { minutes });
}

export async function encryptPrivateKey(privateKey, password) {
  const res = await send('encrypt', { plaintext: privateKey, password });
  if (!res.result && res.error) throw new Error(res.error);
  return 'enc:' + res.result;
}

export async function decryptPrivateKey(encryptedValue) {
  if (!encryptedValue) return null;
  const ciphertext = encryptedValue.startsWith('enc:') ? encryptedValue.slice(4) : encryptedValue;
  const res = await send('decrypt', { ciphertext });
  return res.result;
}

export function isEncrypted(value) {
  if (!value) return false;
  return value.startsWith('enc:');
}

export async function changePassword(oldPassword, newPassword) {
  const res = await send('changePassword', { oldPassword, newPassword });
  if (res.error) throw new Error(res.error);
}
