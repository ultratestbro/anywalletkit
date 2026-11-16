const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

function uint256(amount: bigint): void {
  if (typeof amount !== "bigint" || amount < 0n || amount > UINT256_MAX) throw new RangeError("stargate: amount must be uint256 bigint");
}

/** Stargate converts through a uint64 shared-decimal amount. */
export function conversionRate(localDecimals: number, sharedDecimals: number): bigint {
  if (!Number.isInteger(localDecimals) || !Number.isInteger(sharedDecimals) || sharedDecimals < 0 || localDecimals < sharedDecimals || localDecimals > 255 || localDecimals - sharedDecimals > 77) {
    throw new RangeError("stargate: invalid local/shared decimals");
  }
  return 10n ** BigInt(localDecimals - sharedDecimals);
}

/** Source amount that can be represented on the wire; dust is not silently added to the output. */
export function splitSourceAmount(amountLD: bigint, localDecimals: number, sharedDecimals: number): {amountSD: bigint; sentLD: bigint; dustLD: bigint} {
  uint256(amountLD);
  const rate = conversionRate(localDecimals, sharedDecimals);
  const amountSD = amountLD / rate;
  if (amountSD > UINT64_MAX) throw new RangeError("stargate: shared amount exceeds uint64");
  return {amountSD, sentLD: amountSD * rate, dustLD: amountLD % rate};
}

/** quoteOFT's received amount uses SOURCE local decimals, not destination decimals. */
export function destinationAmount(receivedSourceLD: bigint, sourceDecimals: number, destinationDecimals: number, sharedDecimals: number): bigint {
  const {amountSD, dustLD} = splitSourceAmount(receivedSourceLD, sourceDecimals, sharedDecimals);
  if (dustLD !== 0n) throw new RangeError("stargate: quote receipt is not shared-decimal aligned");
  const amount = amountSD * conversionRate(destinationDecimals, sharedDecimals);
  uint256(amount);
  return amount;
}

/** Round the caller's destination floor UP, then encode it in source local units. */
export function sourceMinimum(minDestinationLD: bigint, sourceDecimals: number, destinationDecimals: number, sharedDecimals: number): bigint {
  uint256(minDestinationLD);
  const destinationRate = conversionRate(destinationDecimals, sharedDecimals);
  const minimumSD = (minDestinationLD + destinationRate - 1n) / destinationRate;
  if (minimumSD > UINT64_MAX) throw new RangeError("stargate: minimum exceeds uint64 shared amount");
  const minimumLD = minimumSD * conversionRate(sourceDecimals, sharedDecimals);
  uint256(minimumLD);
  return minimumLD;
}

/** Stargate fee details are negative for charges, positive for rewards. Both use source local units. */
export function splitFeeDetails(details: readonly {feeAmountLD: bigint}[]): {feeLD: bigint; rewardLD: bigint} {
  let feeLD = 0n, rewardLD = 0n;
  for (const {feeAmountLD} of details) {
    if (typeof feeAmountLD !== "bigint" || feeAmountLD < -(1n << 255n) || feeAmountLD >= (1n << 255n)) throw new RangeError("stargate: fee must be int256 bigint");
    if (feeAmountLD < 0n) feeLD -= feeAmountLD;
    else rewardLD += feeAmountLD;
  }
  return {feeLD, rewardLD};
}
