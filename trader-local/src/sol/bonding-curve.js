// Freedom Trader 本地系统 - Bonding Curve 计算和交易指令构建
// 从 Chrome 扩展 sol/bonding-curve.js 直接复用

import { Buffer } from 'buffer';
import { TransactionInstruction } from '@solana/web3.js';
import {
  PUMP_PROGRAM, PUMP_GLOBAL, PUMP_FEE, PUMP_FEE_RECIPIENTS,
  SYSTEM_PROGRAM, DISCRIMINATORS,
} from './constants.js';
import {
  deriveBondingCurve, deriveBondingCurveV2, deriveCreatorVault,
  deriveEventAuthority, deriveGlobalVolumeAccumulator,
  deriveUserVolumeAccumulator, deriveBcFeeConfig, deriveATA,
} from './pda.js';
import { getBcFeeConfig } from './accounts.js';

function randomFeeRecipient() {
  return PUMP_FEE_RECIPIENTS[Math.floor(Math.random() * PUMP_FEE_RECIPIENTS.length)];
}

function writeU64LE(value) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function writeOptionBoolFalse() {
  return Buffer.from([1, 0]);
}

export function calcBcBuyQuoteSync(spendableSolIn, bc, fee, slippagePct) {
  const totalFeeBps = fee.protocolFeeBps + fee.creatorFeeBps;
  const solIn = BigInt(spendableSolIn);

  let netSol = (solIn * 10000n) / (10000n + totalFeeBps);
  const protocolFee = (netSol * fee.protocolFeeBps + 9999n) / 10000n;
  const creatorFee = (netSol * fee.creatorFeeBps + 9999n) / 10000n;
  const fees = protocolFee + creatorFee;
  if (netSol + fees > solIn) {
    netSol -= (netSol + fees - solIn);
  }

  const effectiveSol = netSol - 1n;
  if (effectiveSol <= 0n) return { tokensOut: 0n, minTokensOut: 0n };

  const tokensOut = (effectiveSol * bc.virtualTokenReserves) /
    (bc.virtualSolReserves + effectiveSol);

  const slipBps = BigInt(Math.floor((100 - slippagePct) * 100));
  const minTokensOut = (tokensOut * slipBps) / 10000n;

  return { tokensOut, minTokensOut };
}

export async function calcBondingCurveBuyQuote(spendableSolIn, bc, slippagePct) {
  const fee = await getBcFeeConfig();
  return calcBcBuyQuoteSync(spendableSolIn, bc, fee, slippagePct);
}

export function calcBondingCurveSellQuote(tokenAmount, bc, feeConfig, slippagePct) {
  let amount = BigInt(tokenAmount);

  if (bc.realTokenReserves != null && amount > bc.realTokenReserves) {
    amount = bc.realTokenReserves;
  }

  if (bc.realSolReserves != null && bc.realSolReserves <= 0n) {
    return { netSol: 0n, minSolOut: 0n, capped: true };
  }

  let grossSol = (amount * bc.virtualSolReserves) / (bc.virtualTokenReserves + amount);

  if (bc.realSolReserves != null && grossSol > bc.realSolReserves) {
    grossSol = bc.realSolReserves;
  }

  const protocolFee = (grossSol * feeConfig.protocolFeeBps + 9999n) / 10000n;
  const creatorFee = (grossSol * feeConfig.creatorFeeBps + 9999n) / 10000n;
  const netSol = grossSol - protocolFee - creatorFee;

  const slipBps = BigInt(Math.floor((100 - slippagePct) * 100));
  const minSolOut = (netSol * slipBps) / 10000n;

  const capped = amount < BigInt(tokenAmount);
  return { netSol, minSolOut, capped };
}

export function buildBondingCurveBuyIx(
  mint, user, bondingCurve, tokenProgram, spendableSolIn, minTokensOut
) {
  const data = Buffer.concat([
    DISCRIMINATORS.BUY_EXACT_SOL_IN,
    writeU64LE(spendableSolIn),
    writeU64LE(minTokensOut),
    writeOptionBoolFalse(),
  ]);

  const bcPda = deriveBondingCurve(mint);
  const bcV2Pda = deriveBondingCurveV2(mint);
  const associatedBc = deriveATA(bcPda, mint, tokenProgram);
  const associatedUser = deriveATA(user, mint, tokenProgram);
  const creatorVault = deriveCreatorVault(bondingCurve.creator);
  const eventAuth = deriveEventAuthority(PUMP_PROGRAM);
  const globalVolAcc = deriveGlobalVolumeAccumulator(PUMP_PROGRAM);
  const userVolAcc = deriveUserVolumeAccumulator(user, PUMP_PROGRAM);
  const feeConfig = deriveBcFeeConfig();

  const keys = [
    { pubkey: PUMP_GLOBAL,      isSigner: false, isWritable: false },
    { pubkey: randomFeeRecipient(), isSigner: false, isWritable: true },
    { pubkey: mint,             isSigner: false, isWritable: false },
    { pubkey: bcPda,            isSigner: false, isWritable: true },
    { pubkey: associatedBc,     isSigner: false, isWritable: true },
    { pubkey: associatedUser,   isSigner: false, isWritable: true },
    { pubkey: user,             isSigner: true,  isWritable: true },
    { pubkey: SYSTEM_PROGRAM,   isSigner: false, isWritable: false },
    { pubkey: tokenProgram,     isSigner: false, isWritable: false },
    { pubkey: creatorVault,     isSigner: false, isWritable: true },
    { pubkey: eventAuth,        isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM,     isSigner: false, isWritable: false },
    { pubkey: globalVolAcc,     isSigner: false, isWritable: false },
    { pubkey: userVolAcc,       isSigner: false, isWritable: true },
    { pubkey: feeConfig,        isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE,         isSigner: false, isWritable: false },
    { pubkey: bcV2Pda,          isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId: PUMP_PROGRAM, data });
}

export function buildBondingCurveSellIx(
  mint, user, bondingCurve, tokenProgram, tokenAmount, minSolOut
) {
  const data = Buffer.concat([
    DISCRIMINATORS.BC_SELL,
    writeU64LE(tokenAmount),
    writeU64LE(minSolOut),
  ]);

  const bcPda = deriveBondingCurve(mint);
  const bcV2Pda = deriveBondingCurveV2(mint);
  const associatedBc = deriveATA(bcPda, mint, tokenProgram);
  const associatedUser = deriveATA(user, mint, tokenProgram);
  const creatorVault = deriveCreatorVault(bondingCurve.creator);
  const eventAuth = deriveEventAuthority(PUMP_PROGRAM);
  const feeConfig = deriveBcFeeConfig();

  const keys = [
    { pubkey: PUMP_GLOBAL,      isSigner: false, isWritable: false },
    { pubkey: randomFeeRecipient(), isSigner: false, isWritable: true },
    { pubkey: mint,             isSigner: false, isWritable: false },
    { pubkey: bcPda,            isSigner: false, isWritable: true },
    { pubkey: associatedBc,     isSigner: false, isWritable: true },
    { pubkey: associatedUser,   isSigner: false, isWritable: true },
    { pubkey: user,             isSigner: true,  isWritable: true },
    { pubkey: SYSTEM_PROGRAM,   isSigner: false, isWritable: false },
    { pubkey: creatorVault,     isSigner: false, isWritable: true },
    { pubkey: tokenProgram,     isSigner: false, isWritable: false },
    { pubkey: eventAuth,        isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM,     isSigner: false, isWritable: false },
    { pubkey: feeConfig,        isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE,         isSigner: false, isWritable: false },
    { pubkey: bcV2Pda,          isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId: PUMP_PROGRAM, data });
}
