/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
/**
 * Display helpers that never round a usage value upward.
 *
 * Over reporting a quota would tell a human that a cap was reached when it was
 * not, so every rendered number is truncated toward zero instead of rounded.
 */

const PRECISION_DIGITS = 12;

/**
 * Truncate a number to a fixed number of fraction digits and render it.
 *
 * The scaled value is first re read at twelve significant digits so that binary
 * floating point noise (84.25 times 100 is 8425.000000000001) cannot push a
 * value across a digit boundary in either direction.
 */
export function floorFixed(value: number, fractionDigits: number): string {
  if (!Number.isFinite(value)) return (0).toFixed(fractionDigits);
  const scale = 10 ** fractionDigits;
  const scaled = Number((value * scale).toPrecision(PRECISION_DIGITS));
  return (Math.floor(scaled) / scale).toFixed(fractionDigits);
}
