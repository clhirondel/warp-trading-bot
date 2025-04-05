import { Filter, FilterResult } from './pool-filters';
import { logger } from '../helpers';
import { ExtendedLiquidityPoolKeys } from '../helpers/liquidity';

export class MaxPoolAgeFilter implements Filter {
  constructor(private readonly maxAgeSeconds: number) {}

  async execute(poolKeys: ExtendedLiquidityPoolKeys): Promise<FilterResult> {
    // Now poolKeys.poolOpenTime is directly accessible thanks to ExtendedLiquidityPoolKeys

    if (!poolKeys.poolOpenTime) {
      // Cannot determine age if poolOpenTime is missing
      logger.warn({ mint: poolKeys.baseMint.toString() }, 'Pool open time not available, skipping age check.');
      return { ok: true }; // Pass filter if age cannot be determined
    }

    const poolOpenTimestamp = poolKeys.poolOpenTime.toNumber() * 1000; // Convert seconds to milliseconds
    const currentTimestamp = Date.now();
    const poolAgeSeconds = (currentTimestamp - poolOpenTimestamp) / 1000;

    if (poolAgeSeconds > this.maxAgeSeconds) {
      const message = `Pool ${poolKeys.id.toString()} is older than ${this.maxAgeSeconds} seconds (${poolAgeSeconds.toFixed(0)}s), skipping.`;
      logger.trace({ mint: poolKeys.baseMint.toString() }, message);
      return { ok: false, message };
    }

    return { ok: true };
  }
}
