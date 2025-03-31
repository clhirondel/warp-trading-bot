import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { getMetadataAccountDataSerializer, MPL_TOKEN_METADATA_PROGRAM_ID as MPL_TOKEN_METADATA_PROGRAM_ID_ADDRESS } from '@metaplex-foundation/mpl-token-metadata';
import { BurnFilter } from './burn.filter';
import { MutableFilter } from './mutable.filter';
import { NameSymbolFilter } from '../filters/name-symbol.filter';
import { RenouncedFreezeFilter } from './renounced.filter';
import { PoolSizeFilter } from './pool-size.filter';
import { MaxPoolAgeFilter } from './max-pool-age.filter';
import { ExtendedLiquidityPoolKeys } from '../helpers/liquidity';
import { CHECK_IF_BURNED, CHECK_IF_FREEZABLE, CHECK_IF_MINT_IS_RENOUNCED, CHECK_IF_MUTABLE, CHECK_IF_SOCIALS, logger } from '../helpers';

export interface Filter {
  execute(poolKeys: ExtendedLiquidityPoolKeys, metadata?: MinimalTokenMetadata): Promise<FilterResult>;

  /** Indicates if the filter requires token metadata to be fetched */
  readonly requiresMetadata?: boolean;
}

/** Subset of token metadata needed for filters */
export interface MinimalTokenMetadata {
  name: string;
  symbol: string;
}

export interface FilterResult {
  ok: boolean;
  message?: string;
}

export interface PoolFilterArgs {
  blocklistNames: string[];
  blocklistSymbols: string[];
  filterCheckInterval: number;
  consecutiveFilterMatches: number;
  maxPoolAgeSeconds: number;
  minPoolSize: TokenAmount; // Derived from MIN_POOL_SIZE_AMOUNT
  maxPoolSize: TokenAmount; // Derived from MAX_POOL_SIZE_AMOUNT
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  quoteToken: Token;
}

export class PoolFilters implements Filter {
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

    // Add NameSymbol filter if blocklists are provided
    if (args.blocklistNames.length > 0 || args.blocklistSymbols.length > 0) {
      this.filters.push(new NameSymbolFilter(args.blocklistNames, args.blocklistSymbols));
    }

    // Add MaxPoolAge filter if configured
    if (args.maxPoolAgeSeconds > 0) {
      this.filters.push(new MaxPoolAgeFilter(args.maxPoolAgeSeconds));
    }
  }

  public async execute(poolKeys: ExtendedLiquidityPoolKeys): Promise<FilterResult> {
    const filters = this.filters;
    if (filters.length === 0) {
      return { ok: true };
    }

    let metadata: MinimalTokenMetadata | undefined = undefined;
    const needsMetadata = this.filters.some(
      (f) =>
        f instanceof NameSymbolFilter ||
        f instanceof MutableFilter ||
        f instanceof RenouncedFreezeFilter ||
        f instanceof BurnFilter
    );

    if (needsMetadata) {
      try {
        // Fetch metadata using Metaplex Program Derived Address (PDA)
        const metaplexProgramId = new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID_ADDRESS);
        const seeds = [
          Buffer.from('metadata'),
          metaplexProgramId.toBuffer(),
          poolKeys.baseMint.toBuffer(),
        ];
        const [metadataPda] = PublicKey.findProgramAddressSync(seeds, metaplexProgramId);

        const accountInfo = await this.connection.getAccountInfo(metadataPda);

        if (accountInfo) {
          const [metadataAccount] = getMetadataAccountDataSerializer().deserialize(accountInfo.data);
          // Clean up names/symbols (remove null chars, trim)
          const name = metadataAccount.name.replace(/\0/g, '').trim();
          const symbol = metadataAccount.symbol.replace(/\0/g, '').trim();
          metadata = { name, symbol };
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Fetched metadata: Name=${name}, Symbol=${symbol}`);
        } else {
          logger.warn({ mint: poolKeys.baseMint.toString() }, 'Failed to fetch metadata account info.');
          // Decide how to handle missing metadata - fail filters requiring it?
          // For now, we let filters decide based on undefined metadata
        }
      } catch (error) {
        logger.error({ mint: poolKeys.baseMint.toString(), error }, 'Error fetching or deserializing metadata.');
        // Decide how to handle fetch errors - fail filters requiring it?
        // For now, we let filters decide based on undefined metadata
      }
    }

    // Execute filters
    for (const filter of filters) { // Check each filter
      try {
        const result = await filter.execute(poolKeys, metadata);
        if (!result.ok) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Pool excluded: ${result.message}`);
          return result; // Return the failed FilterResult
        }
      } catch (error) {
        logger.error({ mint: poolKeys.baseMint.toString(), filter: filter.constructor.name, error }, 'Error executing filter');
        return { ok: false, message: `Error in ${filter.constructor.name}` }; // Treat error as filter failure
      }
    }

    return { ok: true }; // All filters passed
  }
}
