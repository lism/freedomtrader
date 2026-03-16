// Freedom Trader 本地系统 - PumpSwap AMM 交易指令构建
// 从 Chrome 扩展 sol/pump-swap.js 直接复用

import { Buffer } from 'buffer';
import { TransactionInstruction, SystemProgram } from '@solana/web3.js';
import {
  PUMP_AMM, PUMP_AMM_GLOBAL_CONFIG, PUMP_FEE, WSOL_MINT,
  SPL_TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM,
  DISCRIMINATORS,
} from './constants.js';
import {
  derivePoolAuthority, derivePool, derivePoolV2,
  deriveEventAuthority, deriveAmmCreatorVault, deriveAmmFeeConfig,
  deriveATA, deriveGlobalVolumeAccumulator, deriveUserVolumeAccumulator,
} from './pda.js';
import { getAmmGlobalConfig, getPool, getPoolReserves, getTokenProgram } from './accounts.js';
import { getConnection } from './connection.js';

function writeU64LE(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function writeOptionBoolFalse() {
  return Buffer.from([1, 0]);
}

export async function findPoolForMint(mint) {
  const poolAuth = derivePoolAuthority(mint);
  const poolPda = derivePool(poolAuth, mint, WSOL_MINT);
  const pool = await getPool(poolPda);
  if (pool) return pool;

  try {
    const conn = getConnection();
    const accounts = await conn.getProgramAccounts(PUMP_AMM, {
      filters: [
        { memcmp: { offset: 8 + 35, bytes: mint.toBase58() } },
      ],
    });

    if (accounts.length > 0) {
      const { parsePool } = await import('./accounts.js');
      const parsed = parsePool(accounts[0].account.data);
      return { ...parsed, address: accounts[0].pubkey };
    }
  } catch (e) {
    console.warn('[findPoolForMint] getProgramAccounts fallback 失败:', e.message);
  }

  return null;
}

export function calcAmmBuyQuote(spendableQuoteIn, baseReserve, quoteReserve, totalFeeBps, slippagePct) {
  const quoteIn = BigInt(spendableQuoteIn);
  const feeBps = totalFeeBps || 125n;

  const netQuote = (quoteIn * 10000n) / (10000n + feeBps);
  const baseOut = (netQuote * baseReserve) / (quoteReserve + netQuote);

  const slipDownBps = BigInt(Math.floor((100 - slippagePct) * 100));
  const minBaseOut = (baseOut * slipDownBps) / 10000n;

  const slipUpBps = BigInt(Math.floor((100 + slippagePct) * 100));
  const maxQuoteIn = (quoteIn * slipUpBps) / 10000n;

  return { baseOut: minBaseOut, maxQuoteIn };
}

export function calcAmmSellQuote(baseAmountIn, baseReserve, quoteReserve, totalFeeBps, slippagePct) {
  const amountIn = BigInt(baseAmountIn);
  const grossQuote = (amountIn * quoteReserve) / (baseReserve + amountIn);

  const feeBps = totalFeeBps || 125n;
  const fee = (grossQuote * feeBps) / 10000n;
  const netQuote = grossQuote - fee;

  const slipBps = BigInt(Math.floor((100 - slippagePct) * 100));
  const minQuoteOut = (netQuote * slipBps) / 10000n;

  return { netQuote, minQuoteOut };
}

export function buildWrapSolInstructions(user, lamports, wsolAta) {
  const instructions = [];

  instructions.push(createATAIdempotentIx(user, WSOL_MINT, SPL_TOKEN_PROGRAM, wsolAta));

  instructions.push(SystemProgram.transfer({
    fromPubkey: user,
    toPubkey: wsolAta,
    lamports: BigInt(lamports),
  }));

  const syncData = Buffer.alloc(1);
  syncData.writeUInt8(17);
  instructions.push(new TransactionInstruction({
    keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
    programId: SPL_TOKEN_PROGRAM,
    data: syncData,
  }));

  return instructions;
}

export function buildCloseWsolIx(user, wsolAta) {
  const data = Buffer.alloc(1);
  data.writeUInt8(9);
  return new TransactionInstruction({
    keys: [
      { pubkey: wsolAta, isSigner: false, isWritable: true },
      { pubkey: user,    isSigner: false, isWritable: true },
      { pubkey: user,    isSigner: true,  isWritable: false },
    ],
    programId: SPL_TOKEN_PROGRAM,
    data,
  });
}

function createATAIdempotentIx(owner, mint, tokenProgram, ata) {
  return new TransactionInstruction({
    keys: [
      { pubkey: owner,                    isSigner: true,  isWritable: true },
      { pubkey: ata,                      isSigner: false, isWritable: true },
      { pubkey: owner,                    isSigner: false, isWritable: false },
      { pubkey: mint,                     isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM,           isSigner: false, isWritable: false },
      { pubkey: tokenProgram,             isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM,
    data: Buffer.from([1]),
  });
}

export function buildCreateBaseATAIx(user, baseMint, baseTokenProgram) {
  const ata = deriveATA(user, baseMint, baseTokenProgram);
  return {
    ix: createATAIdempotentIx(user, baseMint, baseTokenProgram, ata),
    ata,
  };
}

export function buildPumpSwapBuyIx(
  user, pool, baseTokenProgram, globalConfig,
  baseAmountOut, maxQuoteAmountIn
) {
  const data = Buffer.concat([
    DISCRIMINATORS.AMM_BUY,
    writeU64LE(baseAmountOut),
    writeU64LE(maxQuoteAmountIn),
    writeOptionBoolFalse(),
  ]);

  const userBaseAta = deriveATA(user, pool.baseMint, baseTokenProgram);
  const userQuoteAta = deriveATA(user, WSOL_MINT, SPL_TOKEN_PROGRAM);

  const feeRecipient = globalConfig.feeRecipients.length > 0
    ? globalConfig.feeRecipients[Math.floor(Math.random() * globalConfig.feeRecipients.length)]
    : user;
  const feeRecipientAta = deriveATA(feeRecipient, WSOL_MINT, SPL_TOKEN_PROGRAM);

  const eventAuth = deriveEventAuthority(PUMP_AMM);
  const creatorVaultAuth = deriveAmmCreatorVault(pool.coinCreator);
  const creatorVaultAta = deriveATA(creatorVaultAuth, WSOL_MINT, SPL_TOKEN_PROGRAM);
  const globalVolAcc = deriveGlobalVolumeAccumulator();
  const userVolAcc = deriveUserVolumeAccumulator(user);
  const feeConfig = deriveAmmFeeConfig();
  const poolV2 = derivePoolV2(pool.baseMint);

  const keys = [
    { pubkey: pool.address,          isSigner: false, isWritable: true },
    { pubkey: user,                  isSigner: true,  isWritable: true },
    { pubkey: PUMP_AMM_GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: pool.baseMint,         isSigner: false, isWritable: false },
    { pubkey: WSOL_MINT,             isSigner: false, isWritable: false },
    { pubkey: userBaseAta,           isSigner: false, isWritable: true },
    { pubkey: userQuoteAta,          isSigner: false, isWritable: true },
    { pubkey: pool.baseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: pool.quoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: feeRecipient,          isSigner: false, isWritable: false },
    { pubkey: feeRecipientAta,       isSigner: false, isWritable: true },
    { pubkey: baseTokenProgram,      isSigner: false, isWritable: false },
    { pubkey: SPL_TOKEN_PROGRAM,     isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM,        isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: eventAuth,             isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM,              isSigner: false, isWritable: false },
    { pubkey: creatorVaultAta,       isSigner: false, isWritable: true },
    { pubkey: creatorVaultAuth,      isSigner: false, isWritable: false },
    { pubkey: globalVolAcc,          isSigner: false, isWritable: true },
    { pubkey: userVolAcc,            isSigner: false, isWritable: true },
    { pubkey: feeConfig,             isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE,              isSigner: false, isWritable: false },
    { pubkey: poolV2,                isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId: PUMP_AMM, data });
}

export function buildPumpSwapSellIx(
  user, pool, baseTokenProgram, globalConfig,
  baseAmountIn, minQuoteOut
) {
  const data = Buffer.concat([
    DISCRIMINATORS.AMM_SELL,
    writeU64LE(baseAmountIn),
    writeU64LE(minQuoteOut),
  ]);

  const userBaseAta = deriveATA(user, pool.baseMint, baseTokenProgram);
  const userQuoteAta = deriveATA(user, WSOL_MINT, SPL_TOKEN_PROGRAM);

  const feeRecipient = globalConfig.feeRecipients.length > 0
    ? globalConfig.feeRecipients[Math.floor(Math.random() * globalConfig.feeRecipients.length)]
    : user;
  const feeRecipientAta = deriveATA(feeRecipient, WSOL_MINT, SPL_TOKEN_PROGRAM);

  const eventAuth = deriveEventAuthority(PUMP_AMM);
  const creatorVaultAuth = deriveAmmCreatorVault(pool.coinCreator);
  const creatorVaultAta = deriveATA(creatorVaultAuth, WSOL_MINT, SPL_TOKEN_PROGRAM);
  const feeConfig = deriveAmmFeeConfig();
  const poolV2 = derivePoolV2(pool.baseMint);

  const keys = [
    { pubkey: pool.address,          isSigner: false, isWritable: true },
    { pubkey: user,                  isSigner: true,  isWritable: true },
    { pubkey: PUMP_AMM_GLOBAL_CONFIG, isSigner: false, isWritable: false },
    { pubkey: pool.baseMint,         isSigner: false, isWritable: false },
    { pubkey: WSOL_MINT,             isSigner: false, isWritable: false },
    { pubkey: userBaseAta,           isSigner: false, isWritable: true },
    { pubkey: userQuoteAta,          isSigner: false, isWritable: true },
    { pubkey: pool.baseTokenAccount, isSigner: false, isWritable: true },
    { pubkey: pool.quoteTokenAccount, isSigner: false, isWritable: true },
    { pubkey: feeRecipient,          isSigner: false, isWritable: false },
    { pubkey: feeRecipientAta,       isSigner: false, isWritable: true },
    { pubkey: baseTokenProgram,      isSigner: false, isWritable: false },
    { pubkey: SPL_TOKEN_PROGRAM,     isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM,        isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: eventAuth,             isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM,              isSigner: false, isWritable: false },
    { pubkey: creatorVaultAta,       isSigner: false, isWritable: true },
    { pubkey: creatorVaultAuth,      isSigner: false, isWritable: false },
    { pubkey: feeConfig,             isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE,              isSigner: false, isWritable: false },
    { pubkey: poolV2,                isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId: PUMP_AMM, data });
}
