/**
 * Utility functions for consistent XLM and currency formatting.
 */

const STROOPS_PER_XLM = 10_000_000;

/**
 * Format stroops (1 XLM = 10,000,000 stroops) to consistently formatted XLM with 2 decimal places.
 * e.g., 5_000_000 -> "0.50", 13_765_440 -> "1.38", 100_000_000 -> "10.00"
 *
 * @param stroops Amount in stroops (number, bigint, or string)
 * @param fullPrecision When true, shows up to 7 decimal places without trailing zeros (for transaction details)
 */
export function formatXLM(
  stroops: number | bigint | string,
  fullPrecision = false
): string {
  const num = typeof stroops === "bigint" ? Number(stroops) : Number(stroops || 0);
  const xlm = num / STROOPS_PER_XLM;

  if (fullPrecision) {
    return xlm.toFixed(7).replace(/(\.\d*?[1-9])0+$|\.0*$/, "$1");
  }

  return xlm.toFixed(2);
}

/**
 * Format an amount that is already in XLM units to 2 decimal places.
 * e.g., 1.376544 -> "1.38", 0.5 -> "0.50", 10 -> "10.00"
 */
export function formatXlmAmount(
  amountXlm: number | string,
  fullPrecision = false
): string {
  const num = Number(amountXlm || 0);

  if (fullPrecision) {
    return num.toFixed(7).replace(/(\.\d*?[1-9])0+$|\.0*$/, "$1");
  }

  return num.toFixed(2);
}
