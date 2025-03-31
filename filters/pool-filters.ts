import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { BurnFilter } from './burn.filter';
import { MutableFilter } from './mutable.filter';
import { RenouncedFreezeFilter } from './renounced.filter';
import { PoolSizeFilter } from './pool-size.filter';
import { MaxPoolAgeFilter } from './max-pool-age.filter';
import { ExtendedLiquidityPoolKeys } from '../helpers/liquidity';
import { CHECK_IF_BURNED, CHECK_IF_FREEZABLE, CHECK_IF_MINT_IS_RENOUNCED, CHECK_IF_MUTABLE, CHECK_IF_SOCIALS, logger } from '../helpers';

export interface Filter {
  execute(poolKeys: ExtendedLiquidityPoolKeys): Promise<FilterResult>;
}

export interface FilterResult {
  ok: boolean;
  message?: string;
}

export interface PoolFilterArgs {
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  maxPoolAgeSeconds: number;
  quoteToken: Token;
}

export class PoolFilters {
  private readonly filters: Filter[] = [];

  constructor(
    readonly connection: Connection,
    readonly args: PoolFilterArgs,
  ) {
    if (CHECK_IF_BURNED) {
      this.filters.push(new BurnFilter(connection));
    }

    if (CHECK_IF_MINT_IS_RENOUNCED || CHECK_IF_FREEZABLE) {
      this.filters.push(new RenouncedFreezeFilter(connection, CHECK_IF_MINT_IS_RENOUNCED, CHECK_IF_FREEZABLE));
    }

    if (CHECK_IF_MUTABLE || CHECK_IF_SOCIALS) {
      this.filters.push(new MutableFilter(connection, getMetadataAccountDataSerializer(), CHECK_IF_MUTABLE, CHECK_IF_SOCIALS));
    }

    if (!args.minPoolSize.isZero() || !args.maxPoolSize.isZero()) {
      this.filters.push(new PoolSizeFilter(connection, args.quoteToken, args.minPoolSize, args.maxPoolSize));
    }

    // Add MaxPoolAge filter if configured
    if (args.maxPoolAgeSeconds > 0) {
      this.filters.push(new MaxPoolAgeFilter(args.maxPoolAgeSeconds));
    }
  }

  public async execute(poolKeys: ExtendedLiquidityPoolKeys): Promise<boolean> {
    if (this.filters.length === 0) {
      return true;
    }

    const result = await Promise.all(this.filters.map((f) => f.execute(poolKeys)));
    const pass = result.every((r) => r.ok);

    if (pass) {
      return true;
    }

    for (const filterResult of result.filter((r) => !r.ok)) {
      logger.trace(filterResult.message);
    }

    return false;
  }
}
