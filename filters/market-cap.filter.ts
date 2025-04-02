import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount, Percent, Price } from '@raydium-io/raydium-sdk';
import { Filter, FilterResult, MinimalTokenMetadata } from './pool-filters';
import { ExtendedLiquidityPoolKeys } from '../helpers/liquidity';
import { logger } from '../helpers';
import { MintLayout, TOKEN_PROGRAM_ID, AccountLayout, getAssociatedTokenAddress } from '@solana/spl-token';
import BigNumber from 'bignumber.js';

// Known burn addresses
const BURN_ADDRESSES = [
  new PublicKey('11111111111111111111111111111111'), // System Program (often used as burn)
  new PublicKey('1nc1nerator11111111111111111111111111111111'), // SPL Token Burn Incinerator
  // Add other known general or project-specific burn addresses if needed
];

export class MarketCapFilter implements Filter {
  constructor(
    private readonly connection: Connection,
    private readonly quoteToken: Token,
    private readonly minMarketCap: number, // Minimum market cap in quote token value (e.g., USDC, SOL)
  ) {}

  // Helper function to get burned supply from known addresses
  private async getBurnedSupply(baseMint: PublicKey): Promise<bigint> {
    let totalBurnedSupply = 0n;

    for (const burnAddress of BURN_ADDRESSES) {
      try {
        // Find the Associated Token Account (ATA) for the mint owned by the burn address
        // Allow off-curve addresses as burn addresses might not be standard PDAs
        const burnAta = await getAssociatedTokenAddress(baseMint, burnAddress, true);
        const burnAtaInfo = await this.connection.getAccountInfo(burnAta);

        if (burnAtaInfo) {
          const burnAccountData = AccountLayout.decode(burnAtaInfo.data);
          totalBurnedSupply += burnAccountData.amount; // Add the amount found in this burn ATA
        }
      } catch (e) {
        // Ignore errors (like ATA not found), just means no tokens burned to this specific address
        if (e instanceof Error && !(e.message.includes('could not find account') || e.message.includes('TokenAccountNotFoundError'))) {
           // Log unexpected errors
           logger.warn({ mint: baseMint.toString(), burnAddress: burnAddress.toString(), error: e.message }, `MarketCapFilter: Error checking burn address`);
        }
      }
    }
    logger.trace({ mint: baseMint.toString(), burned: totalBurnedSupply.toString() }, `MarketCapFilter: Total burned supply from known addresses`);
    return totalBurnedSupply;
  }

  async execute(poolKeys: ExtendedLiquidityPoolKeys, metadata?: MinimalTokenMetadata): Promise<FilterResult> {
    if (this.minMarketCap <= 0) {
      return { ok: true }; // Filter is disabled if minMarketCap is zero or negative
    }

    try {
      // 1. Fetch Base Token Total Supply
      const mintInfo = await this.connection.getAccountInfo(poolKeys.baseMint);
      if (!mintInfo) {
        logger.warn({ mint: poolKeys.baseMint.toString() }, `MarketCapFilter: Failed to fetch mint info`);
        return { ok: false, message: 'MarketCapFilter: Failed to fetch mint info' };
      }
      const mintData = MintLayout.decode(mintInfo.data);
      const totalSupply = mintData.supply; // Total supply as BigInt

      // 1.5 Fetch Burned Supply using the helper function
      const burnedSupply = await this.getBurnedSupply(poolKeys.baseMint);

      // Calculate Circulating Supply
      const circulatingSupply = totalSupply > burnedSupply ? totalSupply - burnedSupply : 0n; // Ensure non-negative

      if (circulatingSupply === 0n) {
        logger.warn({ mint: poolKeys.baseMint.toString() }, `MarketCapFilter: Circulating supply is zero after accounting for burns, cannot calculate market cap`);
        return { ok: false, message: 'MarketCapFilter: Circulating supply is zero' };
      }

      const baseToken = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, mintData.decimals);
      const circulatingSupplyAmount = new TokenAmount(baseToken, circulatingSupply); // Use circulating supply

      // 2. Fetch Pool Reserves
      const quoteVaultInfo = await this.connection.getTokenAccountBalance(poolKeys.quoteVault);
      const baseVaultInfo = await this.connection.getTokenAccountBalance(poolKeys.baseVault);

      if (!quoteVaultInfo?.value?.uiAmount || !baseVaultInfo?.value?.uiAmount) {
         logger.warn({ mint: poolKeys.baseMint.toString(), poolId: poolKeys.id.toString() }, `MarketCapFilter: Failed to fetch vault balances`);
         return { ok: false, message: 'MarketCapFilter: Failed to fetch vault balances' };
      }

      const baseReserve = new TokenAmount(baseToken, baseVaultInfo.value.amount, true);
      const quoteReserve = new TokenAmount(this.quoteToken, quoteVaultInfo.value.amount, true);

      if (baseReserve.isZero()) {
        logger.warn({ mint: poolKeys.baseMint.toString(), poolId: poolKeys.id.toString() }, `MarketCapFilter: Base reserve is zero, cannot calculate price`);
        return { ok: false, message: 'MarketCapFilter: Base reserve is zero' };
      }

      // 3. Calculate Price
      const price = new Price(this.quoteToken, quoteReserve.raw, baseToken, baseReserve.raw);

      // 4. Calculate Market Cap (Based on Circulating Supply)
      const marketCap = new BigNumber(circulatingSupplyAmount.toExact()).times(price.toSignificant());

      // 5. Compare
      const minMarketCapBigNum = new BigNumber(this.minMarketCap);
      if (marketCap.lt(minMarketCapBigNum)) {
        return {
          ok: false,
          message: `MarketCapFilter: Market Cap (${marketCap.toFormat(2)}) is below minimum (${minMarketCapBigNum.toFormat(2)})`,
        };
      }

      logger.trace({ mint: poolKeys.baseMint.toString(), poolId: poolKeys.id.toString(), marketCap: marketCap.toFormat(2) }, `MarketCapFilter: Passed`);
      return { ok: true };

    } catch (error) {
      logger.error({ mint: poolKeys.baseMint.toString(), error }, `MarketCapFilter: Error executing filter`);
      return { ok: false, message: 'MarketCapFilter: Error executing filter' };
    }
  }
}
