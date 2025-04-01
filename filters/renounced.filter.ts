import { Filter, FilterResult, MinimalTokenMetadata } from './pool-filters';
import { MintLayout } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers';

export class RenouncedFreezeFilter implements Filter {
  readonly requiresMetadata = true; // Indicate that this filter needs metadata contextually
  private readonly errorMessage: string[] = [];

  constructor(
    private readonly connection: Connection,
    private readonly checkRenounced: boolean,
    private readonly checkFreezable: boolean,
  ) {
    if (this.checkRenounced) {
      this.errorMessage.push('mint authority');
    }

    if (this.checkFreezable) {
      this.errorMessage.push('freeze authority');
    }
  }

  async execute(poolKeys: LiquidityPoolKeysV4, metadata?: MinimalTokenMetadata): Promise<FilterResult> {
    // While metadata isn't directly used here, fetching it might provide context
    // or allow combining checks. The core logic relies on fetching the Mint account.

    try {
      const accountInfo = await this.connection.getAccountInfo(poolKeys.baseMint, this.connection.commitment);
      if (!accountInfo?.data) {
        return { ok: false, message: 'RenouncedFreeze -> Failed to fetch mint account data' };
      }

      const mintData = MintLayout.decode(accountInfo.data);

      // Check Renounced: mintAuthorityOption === 0 means no mint authority (renounced)
      const isRenounced = !this.checkRenounced || mintData.mintAuthorityOption === 0;

      // Check Freezable: freezeAuthorityOption !== 0 means there IS a freeze authority (freezable)
      const isFreezable = this.checkFreezable && mintData.freezeAuthorityOption !== 0;

      // Filter passes if it's renounced (if check enabled) AND NOT freezable (if check enabled)
      const ok = isRenounced && !isFreezable;

      const message: string[] = [];
      if (!isRenounced && this.checkRenounced) {
        message.push('mint authority exists');
      }
      if (isFreezable && this.checkFreezable) {
        message.push('freeze authority exists');
      }

      if (!ok) {
        const finalMessage = `RenouncedFreeze -> Token check failed: ${message.join(' and ')}`;
        logger.trace({ mint: poolKeys.baseMint.toString() }, finalMessage);
        return { ok: false, message: finalMessage };
      }

      return { ok: true };

    } catch (e: any) {
      logger.error(
        { mint: poolKeys.baseMint.toString(), error: e },
        `RenouncedFreeze -> Failed to check ${this.errorMessage.join(' and ')}`,
      );
      return {
        ok: false,
        message: `RenouncedFreeze -> Error checking authorities: ${e.message}`,
      };
    }
  }
}