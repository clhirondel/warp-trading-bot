import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount, MAINNET_PROGRAM_ID as RAYDIUM_MAINNET_PROGRAM_ID } from '@raydium-io/raydium-sdk';
import { getMetadataAccountDataSerializer, MPL_TOKEN_METADATA_PROGRAM_ID as MPL_TOKEN_METADATA_PROGRAM_ID_ADDRESS, MetadataAccountData } from '@metaplex-foundation/mpl-token-metadata';
import { BurnFilter } from './burn.filter';
import { MutableFilter } from './mutable.filter';
import { NameSymbolFilter } from '../filters/name-symbol.filter';
import { RenouncedFreezeFilter } from './renounced.filter';
import { PoolSizeFilter } from './pool-size.filter';
import { MaxPoolAgeFilter } from './max-pool-age.filter';
import { MarketCapFilter } from './market-cap.filter'; // Added import
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
  uri: string; // Add URI for potential future use (like fetching full metadata)
  isMutable?: boolean; // Add mutability status if available
  mintAuthorityOption?: number; // Add mint authority status
  freezeAuthorityOption?: number; // Add freeze authority status
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
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  quoteToken: Token;
  minMarketCap: number; // Added minMarketCap
}

export class PoolFilters implements Filter {
  readonly filters: Filter[] = [];

  constructor(
    readonly connection: Connection,
    readonly args: PoolFilterArgs,
  ) {
    if (CHECK_IF_BURNED) {
      // BurnFilter needs LP supply, not directly metadata, but often checked alongside metadata filters
      this.filters.push(new BurnFilter(connection));
    }

    if (CHECK_IF_MINT_IS_RENOUNCED || CHECK_IF_FREEZABLE) {
      // RenouncedFreezeFilter needs Mint account data, which can be fetched alongside metadata
      const filter = new RenouncedFreezeFilter(connection, CHECK_IF_MINT_IS_RENOUNCED, CHECK_IF_FREEZABLE);
      (filter as any).requiresMetadata = true; // Mark as needing metadata fetch contextually
      this.filters.push(filter);
    }

    if (CHECK_IF_MUTABLE || CHECK_IF_SOCIALS) {
      // MutableFilter explicitly requires metadata
      const filter = new MutableFilter(connection, getMetadataAccountDataSerializer(), CHECK_IF_MUTABLE, CHECK_IF_SOCIALS);
      (filter as any).requiresMetadata = true;
      this.filters.push(filter);
    }

    if (!args.minPoolSize.isZero() || !args.maxPoolSize.isZero()) {
      // PoolSizeFilter needs vault balance, not metadata
      this.filters.push(new PoolSizeFilter(connection, args.quoteToken, args.minPoolSize, args.maxPoolSize));
    }

    if (args.blocklistNames.length > 0 || args.blocklistSymbols.length > 0) {
      // NameSymbolFilter explicitly requires metadata
      const filter = new NameSymbolFilter(args.blocklistNames, args.blocklistSymbols);
      (filter as any).requiresMetadata = true;
      this.filters.push(filter);
    }

    if (args.maxPoolAgeSeconds > 0) {
      // MaxPoolAgeFilter uses poolOpenTime from ExtendedLiquidityPoolKeys, not metadata
      this.filters.push(new MaxPoolAgeFilter(args.maxPoolAgeSeconds));
    }

    if (args.minMarketCap > 0) {
      // MarketCapFilter needs connection, quoteToken, and minMarketCap
      this.filters.push(new MarketCapFilter(connection, args.quoteToken, args.minMarketCap));
    }
  }

  // Helper to fetch metadata, callable from Bot or within execute
  async fetchMetadata(poolKeys: ExtendedLiquidityPoolKeys): Promise<MinimalTokenMetadata | undefined> {
    try {
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
        // Clean up names/symbols
        const name = metadataAccount.name.replace(/\0/g, '').trim();
        const symbol = metadataAccount.symbol.replace(/\0/g, '').trim();
        const uri = metadataAccount.uri.replace(/\0/g, '').trim();

        return {
          name,
          symbol,
          uri,
          isMutable: metadataAccount.isMutable,
          // Include mint/freeze authority if needed by other logic, though filters fetch it directly
          // mintAuthorityOption: metadataAccount.mintAuthorityOption,
          // freezeAuthorityOption: metadataAccount.freezeAuthorityOption,
        };
      } else {
        logger.warn({ mint: poolKeys.baseMint.toString() }, 'Metadata account not found.');
        return undefined;
      }
    } catch (error) {
      logger.error({ mint: poolKeys.baseMint.toString(), error }, 'Error fetching or deserializing metadata.');
      return undefined;
    }
  }


  public async execute(poolKeys: ExtendedLiquidityPoolKeys, metadata?: MinimalTokenMetadata): Promise<FilterResult> {
    // If metadata wasn't passed in (e.g., called directly without pre-fetch), fetch it if needed
    let internalMetadata = metadata;
    if (!internalMetadata) {
      const needsMetadata = this.filters.some(f => (f as any).requiresMetadata);
      if (needsMetadata) {
        internalMetadata = await this.fetchMetadata(poolKeys);
        if (!internalMetadata) {
          // Decide handling: fail all metadata filters or let them handle undefined?
          // Current approach: let filters handle undefined
          logger.warn({ mint: poolKeys.baseMint.toString() }, 'Metadata needed but fetch failed within execute.');
        }
      }
    }


    // Execute filters
    for (const filter of this.filters) {
      try {
        // Pass the potentially fetched internalMetadata to filters
        const result = await filter.execute(poolKeys, internalMetadata);
        if (!result.ok) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Pool excluded by ${filter.constructor.name}: ${result.message}`);
          return result; // Return the first failed FilterResult
        }
      } catch (error) {
        logger.error({ mint: poolKeys.baseMint.toString(), filter: filter.constructor.name, error }, 'Error executing filter');
        return { ok: false, message: `Error in ${filter.constructor.name}` }; // Treat error as filter failure
      }
    }

    return { ok: true }; // All filters passed
  }
}
