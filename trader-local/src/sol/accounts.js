// Freedom Trader 本地系统 - Solana 账户解析
// 从 Chrome 扩展 sol/accounts.js 直接复用

import { Buffer } from 'buffer';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from './connection.js';
import { deriveBondingCurve, deriveBcFeeConfig, deriveAmmFeeConfig, deriveATA } from './pda.js';
import { PUMP_PROGRAM, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './constants.js';

const BC_OFFSET = 8;

export function parseBondingCurve(data) {
  const buf = Buffer.from(data);
  return {
    virtualTokenReserves: buf.readBigUInt64LE(BC_OFFSET),
    virtualSolReserves:   buf.readBigUInt64LE(BC_OFFSET + 8),
    realTokenReserves:    buf.readBigUInt64LE(BC_OFFSET + 16),
    realSolReserves:      buf.readBigUInt64LE(BC_OFFSET + 24),
    tokenTotalSupply:     buf.readBigUInt64LE(BC_OFFSET + 32),
    complete:             buf.readUInt8(BC_OFFSET + 40) === 1,
    creator:              new PublicKey(buf.subarray(BC_OFFSET + 41, BC_OFFSET + 73)),
    isMayhemMode:         buf.readUInt8(BC_OFFSET + 73) === 1,
  };
}

export async function getBondingCurve(mint) {
  const conn = getConnection();
  const pda = deriveBondingCurve(typeof mint === 'string' ? new PublicKey(mint) : mint);
  const info = await conn.getAccountInfo(pda);
  if (!info) return null;
  return { ...parseBondingCurve(info.data), address: pda };
}

export function parseFeeConfig(data) {
  const buf = Buffer.from(data);
  return {
    protocolFeeBps: buf.readBigUInt64LE(49),
    creatorFeeBps:  buf.readBigUInt64LE(57),
  };
}

let _bcFeeConfig = null;
let _ammFeeConfig = null;

export async function getBcFeeConfig() {
  if (_bcFeeConfig) return _bcFeeConfig;
  const conn = getConnection();
  const pda = deriveBcFeeConfig();
  const info = await conn.getAccountInfo(pda);
  if (!info) throw new Error('Cannot read BC fee config');
  _bcFeeConfig = parseFeeConfig(info.data);
  return _bcFeeConfig;
}

export async function getAmmFeeConfig() {
  if (_ammFeeConfig) return _ammFeeConfig;
  const conn = getConnection();
  const pda = deriveAmmFeeConfig();
  const info = await conn.getAccountInfo(pda);
  if (!info) throw new Error('Cannot read AMM fee config');
  _ammFeeConfig = parseFeeConfig(info.data);
  return _ammFeeConfig;
}

const POOL_OFFSET = 8;

export function parsePool(data) {
  const buf = Buffer.from(data);
  return {
    poolBump:              buf.readUInt8(POOL_OFFSET),
    index:                 buf.readUInt16LE(POOL_OFFSET + 1),
    creator:               new PublicKey(buf.subarray(POOL_OFFSET + 3, POOL_OFFSET + 35)),
    baseMint:              new PublicKey(buf.subarray(POOL_OFFSET + 35, POOL_OFFSET + 67)),
    quoteMint:             new PublicKey(buf.subarray(POOL_OFFSET + 67, POOL_OFFSET + 99)),
    lpMint:                new PublicKey(buf.subarray(POOL_OFFSET + 99, POOL_OFFSET + 131)),
    baseTokenAccount:      new PublicKey(buf.subarray(POOL_OFFSET + 131, POOL_OFFSET + 163)),
    quoteTokenAccount:     new PublicKey(buf.subarray(POOL_OFFSET + 163, POOL_OFFSET + 195)),
    lpSupply:              buf.readBigUInt64LE(POOL_OFFSET + 195),
    coinCreator:           new PublicKey(buf.subarray(POOL_OFFSET + 203, POOL_OFFSET + 235)),
  };
}

export async function getPool(poolAddress) {
  const conn = getConnection();
  const addr = typeof poolAddress === 'string' ? new PublicKey(poolAddress) : poolAddress;
  const info = await conn.getAccountInfo(addr);
  if (!info) return null;
  return { ...parsePool(info.data), address: addr };
}

export async function getPoolReserves(pool) {
  const conn = getConnection();
  const infos = await conn.getMultipleAccountsInfo([
    pool.baseTokenAccount,
    pool.quoteTokenAccount,
  ]);
  if (!infos[0] || !infos[1]) throw new Error('Pool token accounts not found');
  return {
    baseReserve: Buffer.from(infos[0].data).readBigUInt64LE(64),
    quoteReserve: Buffer.from(infos[1].data).readBigUInt64LE(64),
  };
}

const METAPLEX_METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export async function getTokenMetadata(mint) {
  const conn = getConnection();
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;

  const metaplex = await getMetaplexMetadata(conn, mintPk);
  if (metaplex) return metaplex;

  return getToken2022Metadata(conn, mintPk);
}

async function getMetaplexMetadata(conn, mintPk) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_METADATA_PROGRAM.toBuffer(), mintPk.toBuffer()],
    METAPLEX_METADATA_PROGRAM,
  );
  try {
    const info = await conn.getAccountInfo(pda);
    if (!info) return null;
    const buf = Buffer.from(info.data);
    let off = 1 + 32 + 32;
    const nameLen = buf.readUInt32LE(off); off += 4;
    const name = buf.subarray(off, off + nameLen).toString('utf8').replace(/\0+$/, '').trim();
    off += nameLen;
    const symLen = buf.readUInt32LE(off); off += 4;
    const symbol = buf.subarray(off, off + symLen).toString('utf8').replace(/\0+$/, '').trim();
    return { name, symbol };
  } catch (e) {
    console.warn('[getMetaplexMetadata]', e.message);
    return null;
  }
}

const TOKEN_METADATA_EXT_TYPE = 19;

async function getToken2022Metadata(conn, mintPk) {
  try {
    const info = await conn.getAccountInfo(mintPk);
    if (!info || info.data.length <= 165) return null;
    if (!info.owner.equals(TOKEN_2022_PROGRAM)) return null;

    const buf = Buffer.from(info.data);
    let off = 166;
    while (off + 4 <= buf.length) {
      const extType = buf.readUInt16LE(off);
      const extLen = buf.readUInt16LE(off + 2);

      if (extType === TOKEN_METADATA_EXT_TYPE && extLen >= 68) {
        let mOff = off + 4 + 32 + 32;
        const nameLen = buf.readUInt32LE(mOff); mOff += 4;
        const name = buf.subarray(mOff, mOff + nameLen).toString('utf8').replace(/\0+$/, '').trim();
        mOff += nameLen;
        const symLen = buf.readUInt32LE(mOff); mOff += 4;
        const symbol = buf.subarray(mOff, mOff + symLen).toString('utf8').replace(/\0+$/, '').trim();
        return { name, symbol };
      }

      off += 4 + extLen;
    }
    return null;
  } catch (e) {
    console.warn('[getToken2022Metadata]', e.message);
    return null;
  }
}

export async function getTokenProgram(mint) {
  const conn = getConnection();
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const info = await conn.getAccountInfo(mintPk);
  if (!info) throw new Error(`Mint account not found: ${mintPk.toBase58()}`);
  if (info.owner.equals(TOKEN_2022_PROGRAM)) return TOKEN_2022_PROGRAM;
  return SPL_TOKEN_PROGRAM;
}

export async function getTokenBalance(owner, mint, tokenProgram) {
  const conn = getConnection();
  const ownerPk = typeof owner === 'string' ? new PublicKey(owner) : owner;
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const tp = tokenProgram || SPL_TOKEN_PROGRAM;

  try {
    const resp = await conn.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk });
    if (resp.value.length > 0) {
      return BigInt(resp.value[0].account.data.parsed.info.tokenAmount.amount);
    }
  } catch { /* fall through to ATA lookup */ }

  try {
    const ata = deriveATA(ownerPk, mintPk, tp);
    const bal = await conn.getTokenAccountBalance(ata);
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}

const GLOBAL_CONFIG_OFFSET = 8;
const FEE_RECIPIENTS_COUNT = 8;
let _ammGlobalConfig = null;

export async function getAmmGlobalConfig() {
  if (_ammGlobalConfig) return _ammGlobalConfig;
  const conn = getConnection();
  const info = await conn.getAccountInfo(
    new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw')
  );
  if (!info) throw new Error('Cannot read AMM global config');
  const buf = Buffer.from(info.data);

  const lpFeeBps = buf.readBigUInt64LE(GLOBAL_CONFIG_OFFSET + 32);
  const protocolFeeBps = buf.readBigUInt64LE(GLOBAL_CONFIG_OFFSET + 40);

  const arrOffset = GLOBAL_CONFIG_OFFSET + 49;
  const recipients = [];
  for (let i = 0; i < FEE_RECIPIENTS_COUNT; i++) {
    const start = arrOffset + i * 32;
    const pk = new PublicKey(buf.subarray(start, start + 32));
    if (!pk.equals(PublicKey.default)) recipients.push(pk);
  }

  _ammGlobalConfig = { lpFeeBps, protocolFeeBps, feeRecipients: recipients };
  return _ammGlobalConfig;
}

let _dynamicFeeConfig = null;
let _dynamicFeeConfigTs = 0;
const FEE_CONFIG_TTL = 300_000;

export async function warmDynamicFeeConfig() {
  if (_dynamicFeeConfig && (Date.now() - _dynamicFeeConfigTs < FEE_CONFIG_TTL)) return;
  try {
    const conn = getConnection();
    const pda = deriveAmmFeeConfig();
    const info = await conn.getAccountInfo(pda);
    if (info) {
      _dynamicFeeConfig = parseDynamicFeeConfig(info.data);
      _dynamicFeeConfigTs = Date.now();
    }
  } catch (e) {
    console.warn('[FEE] 读取动态费率配置失败:', e.message);
  }
}

export function getAmmDynamicFeesSync(baseReserve, quoteReserve, baseMintSupply) {
  const supply = baseMintSupply || 1_000_000_000_000_000n;
  const marketCap = (supply * quoteReserve) / baseReserve;
  if (!_dynamicFeeConfig) return { totalFeeBps: 125n };
  return lookupFeeTier(_dynamicFeeConfig, marketCap);
}

export async function getAmmDynamicFees(baseReserve, quoteReserve, baseMintSupply) {
  await warmDynamicFeeConfig();
  return getAmmDynamicFeesSync(baseReserve, quoteReserve, baseMintSupply);
}

function parseDynamicFeeConfig(data) {
  const buf = Buffer.from(data);
  const flatLp = buf.readBigUInt64LE(41);
  const flatProtocol = buf.readBigUInt64LE(49);
  const flatCreator = buf.readBigUInt64LE(57);

  const tierCount = buf.readUInt32LE(65);
  const tiers = [];
  let off = 69;
  for (let i = 0; i < Math.min(tierCount, 30); i++) {
    const thLo = buf.readBigUInt64LE(off);
    const thHi = buf.readBigUInt64LE(off + 8);
    const threshold = thLo + (thHi << 64n);
    const lpFee = buf.readBigUInt64LE(off + 16);
    const protocolFee = buf.readBigUInt64LE(off + 24);
    const creatorFee = buf.readBigUInt64LE(off + 32);
    tiers.push({ threshold, lpFee, protocolFee, creatorFee, total: lpFee + protocolFee + creatorFee });
    off += 40;
  }

  return { flatFees: { lp: flatLp, protocol: flatProtocol, creator: flatCreator }, tiers };
}

function lookupFeeTier(config, marketCap) {
  const { tiers } = config;
  if (!tiers || tiers.length === 0) return { totalFeeBps: 125n };

  let matched = tiers[0];
  for (const tier of tiers) {
    if (marketCap >= tier.threshold) matched = tier;
    else break;
  }
  return { totalFeeBps: matched.total, lpFeeBps: matched.lpFee, protocolFeeBps: matched.protocolFee, creatorFeeBps: matched.creatorFee };
}
