import { Filter, FilterResult, MinimalTokenMetadata } from './pool-filters';
import { ExtendedLiquidityPoolKeys } from '../helpers/liquidity';
import { logger } from '../helpers'; // Import logger

/**
 * Filters tokens based on whether their name or symbol are in provided blocklists.
 */
export class NameSymbolFilter implements Filter {
  readonly requiresMetadata = true; // This filter needs metadata

  private readonly blocklistNames: Set<string>;
  private readonly blocklistSymbols: Set<string>;

  constructor(blocklistNames: string[], blocklistSymbols: string[]) {
    // Store blocklists as Sets for efficient lookup (O(1) average)
    // Convert to lowercase during construction for case-insensitive comparison
    this.blocklistNames = new Set(blocklistNames.map(name => name.toLowerCase()));
    this.blocklistSymbols = new Set(blocklistSymbols.map(symbol => symbol.toLowerCase()));
  }

  async execute(poolKeys: ExtendedLiquidityPoolKeys, metadata?: MinimalTokenMetadata): Promise<FilterResult> {
    if (!metadata) {
      // If metadata couldn't be fetched, we cannot perform the check.
      // Returning false because the check couldn't be completed.
      // Alternatively, could return true if strict blocking is not desired on fetch failure.
      logger.warn({ mint: poolKeys.baseMint.toString() }, 'NameSymbolFilter: Metadata not available, filter cannot be checked.');
      return { ok: false, message: 'NameSymbolFilter: Metadata not available' };
    }

    const lowerCaseName = metadata.name.toLowerCase();
    const lowerCaseSymbol = metadata.symbol.toLowerCase();

    // Check if the name is in the blocklist
    if (this.blocklistNames.has(lowerCaseName)) {
      const message = `NameSymbolFilter: Blocklisted name: ${metadata.name}`;
      logger.trace({ mint: poolKeys.baseMint.toString() }, message);
      return { ok: false, message };
    }

    // Check if the symbol is in the blocklist
    if (this.blocklistSymbols.has(lowerCaseSymbol)) {
      const message = `NameSymbolFilter: Blocklisted symbol: ${metadata.symbol}`;
      logger.trace({ mint: poolKeys.baseMint.toString() }, message);
      return { ok: false, message };
    }

    // If neither name nor symbol is blocklisted, the filter passes
    return { ok: true };
  }
}