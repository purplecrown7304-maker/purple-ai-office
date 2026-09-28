const SCALE = 1_000_000;
export const MAX_MONEY_MICROS = 999_999_999_999;
export function usdToMicros(value: string): number {
  if (!/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(value)) throw new Error('INVALID_MONEY');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * SCALE + Number(fraction.padEnd(6, '0'));
}
export function assertMicros(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY_MICROS) throw new Error('INVALID_MONEY');
}
export function microsToUsd(value: number): string {
  assertMicros(value);
  return `${Math.floor(value / SCALE)}.${String(value % SCALE).padStart(6, '0')}`;
}
