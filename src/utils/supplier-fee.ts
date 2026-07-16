/** 仅 IPXO 供应商在月费（美元）基础上加收 4% 手续费 */
const IPXO_FEE_MULTIPLIER = 1.04;

export function isIpxoSupplier(supplier: unknown): boolean {
  return String(supplier ?? '').trim().toLowerCase() === 'ipxo';
}

/**
 * 在「展示用月费（美元）」基础上，仅当供应商为 IPXO 时乘以 1.04；其余供应商不收取该手续费。
 */
export function applyMonthlyUsdWithOptionalIpxoFee(baseMonthlyUsd: number, supplier: unknown): number {
  return isIpxoSupplier(supplier) ? baseMonthlyUsd * IPXO_FEE_MULTIPLIER : baseMonthlyUsd;
}
