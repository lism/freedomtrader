// Freedom Trader 本地系统 - 加密模块
// 替代 Chrome 扩展的 background service worker 加密逻辑
// 使用 Node.js crypto 模块直接操作

import crypto from 'crypto';
import { loadWallets, saveWallets } from './config.js';

const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;

let _cachedKey = null;

// 密码哈希
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

// 派生 AES 密钥
function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

// 获取或创建 salt
function getOrCreateSalt() {
  const data = loadWallets();
  if (data.salt) {
    return Buffer.from(data.salt, 'base64');
  }
  const salt = crypto.randomBytes(16);
  data.salt = salt.toString('base64');
  saveWallets(data);
  return salt;
}

// 设置密码
export function setPassword(password) {
  const salt = getOrCreateSalt();
  const hash = hashPassword(password, salt).toString('base64');
  const data = loadWallets();
  data.pwHash = hash;
  saveWallets(data);
  _cachedKey = deriveKey(password, salt);
  console.log('[CRYPTO] 密码已设置');
}

// 验证密码并解锁
export function unlock(password) {
  const salt = getOrCreateSalt();
  const data = loadWallets();
  if (!data.pwHash) return false;

  const hash = hashPassword(password, salt).toString('base64');
  if (hash !== data.pwHash) return false;

  _cachedKey = deriveKey(password, salt);
  console.log('[CRYPTO] 已解锁');
  return true;
}

// 锁定
export function lock() {
  _cachedKey = null;
  console.log('[CRYPTO] 已锁定');
}

// 检查是否已设置密码
export function hasPassword() {
  const data = loadWallets();
  return !!data.pwHash;
}

// 检查是否已解锁
export function isUnlocked() {
  return _cachedKey !== null;
}

// 加密
export function encrypt(plaintext) {
  if (!_cachedKey) throw new Error('未解锁');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', _cachedKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, authTag]);
  return 'enc:' + combined.toString('base64');
}

// 解密
export function decrypt(ciphertext) {
  if (!_cachedKey) throw new Error('未解锁');
  const raw = ciphertext.startsWith('enc:') ? ciphertext.slice(4) : ciphertext;
  const combined = Buffer.from(raw, 'base64');
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(combined.length - 16);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', _cachedKey, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted, null, 'utf-8') + decipher.final('utf-8');
}

// 检查是否为加密值
export function isEncrypted(value) {
  if (!value) return false;
  return value.startsWith('enc:');
}

// 加密私钥
export function encryptPrivateKey(privateKey) {
  return encrypt(privateKey);
}

// 解密私钥
export function decryptPrivateKey(encryptedKey) {
  return decrypt(encryptedKey);
}
