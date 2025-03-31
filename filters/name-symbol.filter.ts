import { Filter, FilterResult, MinimalTokenMetadata } from './pool-filters';
import { ExtendedLiquidityPoolKeys } from '../helpers/liquidity';

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
      // Returning true (pass) to not block unnecessarily if metadata fetch failed.
      // Alternatively, could return false if strict blocking is desired even on fetch failure.
      return { ok: true, message: 'NameSymbolFilter: Metadata not available' };
    }

    const lowerCaseName = metadata.name.toLowerCase();
    const lowerCaseSymbol = metadata.symbol.toLowerCase();

    // Check if the name is in the blocklist
    if (this.blocklistNames.has(lowerCaseName)) {
      return { ok: false, message: `NameSymbolFilter: Blocklisted name: ${metadata.name}` };
    }

    // Check if the symbol is in the blocklist
    if (this.blocklistSymbols.has(lowerCaseSymbol)) {
      return { ok: false, message: `NameSymbolFilter: Blocklisted symbol: ${metadata.symbol}` };
    }

    // If neither name nor symbol is blocklisted, the filter passes
    return { ok: true };
  }
}
