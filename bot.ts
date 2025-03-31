import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  AccountInfo,
  Commitment,
  Transaction,
  BlockhashWithExpiryBlockHeight,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  Account,
  MintLayout,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  RawAccount,
} from '@solana/spl-token'; // Correct import path
import {
  Liquidity,
  LiquidityPoolKeys,
  LiquidityPoolInfo,
  LiquidityStateLayoutV4,
  Percent,
  Token,
  TokenAmount,
  CurrencyAmount,
  Market as RaydiumMarket,
  LiquidityPoolKeysV4, // Import specific version if needed
} from '@raydium-io/raydium-sdk';
import { Market as SerumMarket } from '@project-serum/serum';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import { createPoolKeys, logger, NETWORK, sleep } from './helpers';
import { ExtendedLiquidityPoolKeys } from './helpers/liquidity';
import { Mutex } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

// Define a more complete type for the expected structure of fetchedPoolInfo, acknowledging potential discrepancies with the SDK's LiquidityPoolInfo
// This type includes properties observed in usage that might not be in the base LiquidityPoolInfo
type FetchedPoolInfo = LiquidityPoolInfo & {
  baseMint?: PublicKey;
  marketId?: PublicKey;
  marketProgramId?: PublicKey;
  poolOpenTime?: BN; // Assuming BN based on .toNumber() usage
};

// Define a type for the parameters expected by Liquidity.fetchInfo, based on usage and errors
// This helps manage the dummy object creation
type LiquidityFetchInfoParams = {
  connection: Connection;
  poolKeys: Partial<LiquidityPoolKeysV4>; // Use Partial to allow dummy object
};

export interface BotConfig {
  wallet: Keypair;
  blocklistNames: string[];
  blocklistSymbols: string[];
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount; 
  maxPoolSize: TokenAmount; 
  quoteToken: Token;
  quoteMint: PublicKey;
  quoteAmount: TokenAmount; 
  quoteAta: PublicKey;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveFilterMatches: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfitPercentage: number;
  stopLossPercentage: number;
  buySlippage: number;
  maxPoolAgeSeconds: number;
  maxSellDurationSeconds: number; 
  sellSlippage: number;
  sellTimedNameKeywords: string[]; 
  sellTimedNameDurationSeconds: number; 
}

export interface BuyOrderDetails {
  mint: string;
  buyTimestamp: number;
  quoteAmountUsed: TokenAmount; 
  minBaseTokenAmountReceived: TokenAmount;
  tokenName?: string; 
}

export class Bot {
  private readonly poolFilters: PoolFilters;

  // snipe list
  private readonly snipeListCache?: SnipeListCache;

  // one token at the time
  private readonly mutex: Mutex;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;

  private readonly poolStorage: PoolCache;
  private readonly txExecutor: TransactionExecutor;
  public readonly config: BotConfig;

  private readonly buyOrders: { [key: string]: BuyOrderDetails } = {}; 
  private readonly sellOrders: { [key: string]: boolean } = {}; 
  private processingMint = new Set<string>(); // Added declaration

  constructor(
    private readonly connection: Connection,
    poolStorage: PoolCache,
    txExecutor: TransactionExecutor,
    config: BotConfig,
  ) {
    this.poolStorage = poolStorage;
    this.txExecutor = txExecutor;
    this.config = config;
    this.mutex = new Mutex();

    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.poolFilters = new PoolFilters(this.connection, {
      quoteToken: this.config.quoteToken,
      blocklistNames: this.config.blocklistNames,
      blocklistSymbols: this.config.blocklistSymbols,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
      maxPoolAgeSeconds: this.config.maxPoolAgeSeconds,
      checkRenounced: this.config.checkRenounced,
      checkFreezable: this.config.checkFreezable,
      checkBurned: this.config.checkBurned,
      filterCheckInterval: this.config.filterCheckInterval,
      consecutiveFilterMatches: this.config.consecutiveFilterMatches,
    });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async buy(accountId: PublicKey): Promise<void> { 
    let baseMintStr: string | undefined;
    let poolKeys: ExtendedLiquidityPoolKeys | null = null;

    try {
      // Fetch pool info inside the buy method
      // Use a dummy poolKeys object to satisfy the type, casting to any
      // Add potentially missing properties to the dummy object
      const fetchParams: LiquidityFetchInfoParams = {
        connection: this.connection,
        poolKeys: { id: accountId } as Partial<LiquidityPoolKeysV4>, // Only ID is needed initially
      };
      const fetchedPoolInfo: FetchedPoolInfo = await Liquidity.fetchInfo(fetchParams as any); // Cast to any due to SDK type issues

      if (!fetchedPoolInfo) throw new Error('Fetched pool info is missing inside buy.');

      // Use optional chaining for direct access
      baseMintStr = fetchedPoolInfo?.baseMint?.toString();

      // Check if baseMintStr is valid before proceeding
      if (!baseMintStr) {
        throw new Error('Base mint could not be determined from fetched pool info.');
      }

      // Initial check moved: Only check mutex if config requires it, before fetching
      if (this.config.oneTokenAtATime && this.mutex.isLocked()) {
          logger.warn(`Mutex is locked, skipping buy`);
          return;
      }

      // Existing validation for one token at a time
      if (this.config.oneTokenAtATime) {
        const bid = this.buyOrders[baseMintStr];
        if (bid) {
          logger.trace({ mint: baseMintStr }, 'Already bought this token, skipping buy.');
          // Release mutex/processing handled in finally
          return;
        }
      }

      // If oneTokenAtATime, acquire mutex *before* proceeding further
      if (this.config.oneTokenAtATime) {
        await this.mutex.acquire();
        // Add to processing *after* acquiring mutex
        this.processingMint.add(baseMintStr); // Use checked baseMintStr
      }

      // 2. Fetch Market Info
      // Ensure serum dependency is installed: npm install @project-serum/serum
      // Check for required properties before using them
      if (!fetchedPoolInfo.marketId || !fetchedPoolInfo.marketProgramId) {
        // Release mutex if acquired
        if (this.config.oneTokenAtATime && this.processingMint.has(baseMintStr)) {
          this.mutex.release();
          this.processingMint.delete(baseMintStr);
        }
        throw new Error('Market ID or Market Program ID is missing from fetched pool info.');
      }
      const marketInfo = await SerumMarket.load( // Use SerumMarket.load
        this.connection,
        fetchedPoolInfo.marketId, 
        { commitment: this.connection.commitment }, // Pass commitment
        fetchedPoolInfo.marketProgramId 
      );

      // 3. Create Pool Keys directly using fetched state and market
      // Extract required market addresses for createPoolKeys
      const marketKeys = {
        eventQueue: marketInfo.decoded.eventQueue,
        bids: marketInfo.bidsAddress,
        asks: marketInfo.asksAddress,
      };
      // Cast fetchedPoolInfo to any to pass to createPoolKeys
      const basicPoolKeys = createPoolKeys(accountId, fetchedPoolInfo as any, marketKeys);

      // 4. Create final ExtendedLiquidityPoolKeys
      // Use optional chaining and nullish coalescing for poolOpenTime (ensure it's BN)
      poolKeys = {
        ...basicPoolKeys,
        // Ensure poolOpenTime is a BN, default to 0 if undefined/null
        poolOpenTime: fetchedPoolInfo?.poolOpenTime instanceof BN ? fetchedPoolInfo.poolOpenTime : new BN(0), 
      };

      // --- Moved Checks: Perform remaining checks using poolKeys ---
      if (this.config.useSnipeList && !this.snipeListCache?.isInList(baseMintStr)) { // Use checked baseMintStr
        logger.trace({ mint: baseMintStr }, 'Skipping buy: not in snipe list');
        // Release mutex/processing handled in finally
        return; // Return here to ensure finally block runs correctly
      }

      // --- End Moved Checks ---

      // Ensure ATA exists
      const quoteAta = await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.config.wallet, // Add payer
        this.config.quoteMint, 
        this.config.wallet.publicKey
      );

      if (!quoteAta) throw new Error('Failed to get or create ATA for quote token.');

      // Use non-null assertion for poolKeys as it's assigned above
      const mintAta = await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.config.wallet, // Add payer
        poolKeys!.baseMint, 
        this.config.wallet.publicKey
      );

      if (!mintAta) throw new Error('Failed to get or create ATA for base token.');

      if (this.config.autoBuyDelay > 0) {
        logger.debug({ mint: baseMintStr }, `Waiting for ${this.config.autoBuyDelay} ms before buy`); // Use baseMintStr
        await sleep(this.config.autoBuyDelay);
      }

      const quoteTokenAmount = this.config.quoteAmount; 

      // Use non-null assertion for poolKeys
      const { amountOut: simulatedAmountOut, minAmountOut: minSimulatedAmountOut } = await this.simulateSwap(poolKeys!, quoteTokenAmount, 'buy');

      const maxPoolSizeRaw = this.config.maxPoolSize.raw; 

      if (maxPoolSizeRaw.gt(new BN(0)) && simulatedAmountOut.raw.gt(maxPoolSizeRaw)) {
        logger.debug(
          { mint: poolKeys!.baseMint.toString() },
          `Skipping buy because pool size (${simulatedAmountOut.toFixed()}) exceeds max pool size (${this.config.maxPoolSize.toFixed()})`,
        );
        return; // Return here to ensure finally block runs correctly
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {

        const startTime = Date.now();
        let latestBlockhash: BlockhashWithExpiryBlockHeight | null = null; // <-- Variable for blockhash

        try {
          logger.info(
            { mint: poolKeys!.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );

          latestBlockhash = await this.connection.getLatestBlockhash();

          // Use non-null assertion for poolKeys
          const result = await this.swap(
            poolKeys!,
            this.config.quoteAta,
            mintAta.address, 
            this.config.quoteToken, 
            new Token(TOKEN_PROGRAM_ID, poolKeys!.baseMint, poolKeys!.baseDecimals), 
            quoteTokenAmount, 
            this.config.buySlippage, 
            this.config.wallet,
            'buy',
            latestBlockhash
          );

          const latency = Date.now() - startTime;

          if (!result.confirmed) {
            logger.error(
              { 
                mint: poolKeys!.baseMint.toString(), 
                signature: result.signature, 
                error: result.error,
                latency: `${latency}ms`,
                attempt: i + 1,
              },
              `Buy transaction failed to confirm attempt ${i + 1}. Error: ${result.error || 'Confirmation timeout'}`,
            );
            continue; 
          }

          const effectiveSlippage = 'N/A';
          logger.info(
            {
              dex: `https://dexscreener.com/solana/${poolKeys!.baseMint.toString()}?maker=${this.config.wallet.publicKey}`,
              mint: poolKeys!.baseMint.toString(),
              signature: result.signature,
              url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              latency: `${latency}ms`, // Log latency
              effectiveSlippage: effectiveSlippage, // Log effective slippage
            },
            `Confirmed buy tx`,
          );

          const buyTimestamp = Date.now();
          // Use non-null assertion for poolKeys
          const baseToken = new Token(TOKEN_PROGRAM_ID, poolKeys!.baseMint, poolKeys!.baseDecimals);
          const minBaseTokenAmountReceived = new TokenAmount(baseToken, minSimulatedAmountOut.raw);

          this.buyOrders[poolKeys!.baseMint.toString()] = {
            mint: poolKeys!.baseMint.toString(),
            buyTimestamp: buyTimestamp,
            quoteAmountUsed: quoteTokenAmount,
            minBaseTokenAmountReceived: minBaseTokenAmountReceived, 
          };
          logger.info({ mint: poolKeys!.baseMint.toString(), timestamp: buyTimestamp }, 'Buy order details recorded.');

          break; 
        } catch (error: any) {
          // Use optional chaining for poolKeys in logger
          const latency = Date.now() - startTime;
          logger.warn(
              {
                  mint: poolKeys?.baseMint?.toString(),
                  error: error.message,
                  errorCode: error.code,
                  attempt: i + 1,
                  latency: `${latency}ms`
              },
              `Error during buy attempt ${i + 1}`
          );
          // Optional delay before retry
          await sleep(500);
       }
      }
    } catch (error) {
      // Use optional chaining and nullish coalescing for poolKeys in logger
      logger.error({ mint: poolKeys?.baseMint?.toString() ?? 'unknown', error }, 'Failed to buy token');
    } finally {
      if (this.config.oneTokenAtATime) {
        // Ensure mutex is released only if it was acquired and the corresponding mint is being processed
        if (baseMintStr && this.processingMint.has(baseMintStr)) { 
           this.mutex.release();
        }
      }
      // Use baseMintStr for cleanup, as its scope is clearer than poolKeys
      if (baseMintStr) {
        logger.trace({ mint: baseMintStr }, `Finally block for buy: Removing pool from processing list.`);
        this.processingMint.delete(baseMintStr);
      } else {
        // Log error if baseMintStr was never determined
        logger.error("Base mint string was undefined in finally block, cannot clean up processing list.");
        // Check if mutex is locked before attempting release (in case of early error)
        if (this.config.oneTokenAtATime && this.mutex.isLocked()) {
          logger.warn("Attempting to release mutex despite potential issues.");
          this.mutex.release();
        }
      }
    }
  }

  public async sell(tokenAccountPubkey: PublicKey): Promise<void> {
    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    try {
      logger.trace({ mint: tokenAccountPubkey.toString() }, `Processing new token...`);

      // Fetch account data inside the sell method
      const accountData = await getAccount(this.connection, tokenAccountPubkey);
      if (!accountData) {
        logger.error({ mint: 'Unknown', }, `Could not fetch account data for ${tokenAccountPubkey.toString()} to sell.`);
        return;
      }

      const mint = accountData.mint.toString();
      const balance = this.config.quoteToken.mint.equals(accountData.mint) ? 0 : accountData.amount;

      if (balance === 0) {
        logger.info({ mint: accountData.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: accountData.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const poolData = await this.poolStorage.get(accountData.mint.toString());

      // Check if poolData and poolData.state exist before accessing properties
      if (!poolData?.state) {
        logger.trace({ mint: accountData.mint.toString() }, `Token pool data or state is not found, can't sell`);
        return;
      }

      // Check for required properties within poolData.state
      if (!poolData.state.baseMint || !poolData.state.baseDecimal || !poolData.state.marketId || !poolData.state.marketProgramId) {
         logger.error({ mint: accountData.mint.toString() }, `Required pool state properties missing, can't sell`);
         return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, accountData.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: accountData.mint.toString() }, `Empty balance, can't sell`);
        return;
      }

      const market = await SerumMarket.load(
        this.connection,
        poolData.state.marketId, 
        { commitment: this.connection.commitment },
        poolData.state.marketProgramId 
      );

      // Extract required market addresses for createPoolKeys
      const marketKeys = {
        eventQueue: market.decoded.eventQueue,
        bids: market.bidsAddress,
        asks: market.asksAddress,
      };
      // Cast poolData.state to any
      const poolKeys: ExtendedLiquidityPoolKeys = createPoolKeys(new PublicKey(poolData.id), poolData.state as any, marketKeys);

      await this.checkSell(poolKeys, accountData);
    } catch (error) {
      logger.error({ mint: tokenAccountPubkey.toString(), error }, `Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  private async checkSell(poolKeys: ExtendedLiquidityPoolKeys, account: Account): Promise<void> { 
    const mint = account.mint.toString(); // Use account
    const buyOrder = this.buyOrders[mint];

    // Ensure we have buy order details to calculate PNL
    if (!buyOrder) {
      logger.warn(`[${mint}] Buy order details not found for PNL calculation. Cannot check sell conditions.`);
      return;
    }
    if (!buyOrder.quoteAmountUsed || buyOrder.quoteAmountUsed.raw.isZero()) {
      logger.warn(`[${mint}] Original quote amount used is missing or zero. Cannot calculate PNL.`);
      return;
    }

    const tokenAmountIn = new TokenAmount(new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals), account.amount, true); // Use account.amount
    if (tokenAmountIn.isZero()) {
      logger.trace(`[${mint}] Token amount is zero, skipping sell check.`);
      return;
    }

    try {
      // Simulate selling the base token back to quote token to get current value
      // Pass the actual poolKeys object to fetchInfo, cast to any if needed
      const poolInfo = await Liquidity.fetchInfo({ connection: this.connection, poolKeys: poolKeys as any }); 
      const { amountOut: currentQuoteValue } = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo: poolInfo, 
        amountIn: tokenAmountIn,
        currencyOut: new Token(TOKEN_PROGRAM_ID, poolKeys.quoteMint, poolKeys.quoteDecimals), // Output is quote token
        slippage: new Percent(0), // No slippage for simulation
      });

      // Calculate PNL Percentage
      const originalQuoteCost = buyOrder.quoteAmountUsed; // TokenAmount (Quote)
      const pnlRaw = currentQuoteValue.raw.sub(originalQuoteCost.raw);
      const pnlPercentage = pnlRaw.mul(new BN(10000)).div(originalQuoteCost.raw).toNumber() / 100; // Calculate percentage with 2 decimal precision

      logger.info(`[${mint}] Current PNL: ${pnlPercentage.toFixed(2)}% (Current: ${currentQuoteValue.toExact()}, Cost: ${originalQuoteCost.toExact()})`);

      let sellReason: string | null = null;

      // 1. Check Take Profit
      if (this.config.takeProfitPercentage > 0 && pnlPercentage >= this.config.takeProfitPercentage) {
        sellReason = `take_profit (${pnlPercentage.toFixed(2)}% >= ${this.config.takeProfitPercentage}%)`;
      }
      // 2. Check Stop Loss
      else if (this.config.stopLossPercentage > 0 && pnlPercentage <= -this.config.stopLossPercentage) {
        sellReason = `stop_loss (${pnlPercentage.toFixed(2)}% <= -${this.config.stopLossPercentage}%)`;
      }
      // 3. Check Max Duration (if no TP/SL hit)
      else if (this.config.maxSellDurationSeconds > 0 && buyOrder.buyTimestamp) {
        const currentTime = Date.now();
        const elapsedSeconds = (currentTime - buyOrder.buyTimestamp) / 1000;
        if (elapsedSeconds >= this.config.maxSellDurationSeconds) {
          sellReason = `max_duration_reached (${elapsedSeconds.toFixed(0)}s >= ${this.config.maxSellDurationSeconds}s)`;
        }
      }
      // 4. Check Timed Sell Keywords (if no TP/SL/Duration hit)
      else if (this.config.sellTimedNameKeywords.length > 0 && this.config.sellTimedNameDurationSeconds > 0 && buyOrder.buyTimestamp) {
        // Placeholder: Assumes buyOrder.tokenName is populated during buy if needed
        const tokenName = buyOrder.tokenName || '';
        const keywordMatch = this.config.sellTimedNameKeywords.find(keyword =>
          tokenName.toLowerCase().includes(keyword.toLowerCase())
        );
        const currentTime = Date.now();
        const elapsedSeconds = (currentTime - buyOrder.buyTimestamp) / 1000;

        if (keywordMatch && elapsedSeconds >= this.config.sellTimedNameDurationSeconds) {
           sellReason = `timed_keyword_match (${keywordMatch} after ${elapsedSeconds.toFixed(0)}s)`;
        }
      }

      // Execute sell if a reason was determined
      if (sellReason) {
         logger.info(`[${mint}] Triggering sell due to: ${sellReason}`);
         await this.sellOrder(poolKeys, tokenAmountIn, sellReason);
      }
    } catch (e: any) {
      logger.error(`[${mint}] Error during sell check simulation or calculation: ${e.message}`);
      logger.error(e.stack); // Log stack trace for better debugging
    }
  }

  private async sellOrder(poolKeys: ExtendedLiquidityPoolKeys, amountIn: TokenAmount, reason: string): Promise<void> {
    const mint = poolKeys.baseMint.toString();
    logger.info({ mint, reason }, 'Attempting to sell token...');

    if (!this.sellOrders[mint]) {
        logger.warn({ mint }, 'Sell order initiated but processing flag was not set. Proceeding cautiously.');
        this.sellOrders[mint] = true;
    }

    let sellConfirmed = false;

    for (let i = 0; i < this.config.maxSellRetries; i++) {
      const startTime = Date.now(); // <-- Start timer for latency logging
      let latestBlockhash: BlockhashWithExpiryBlockHeight | null = null; // <-- Variable for blockhash

      try {
        logger.info(
          { mint: poolKeys.baseMint.toString() },
          `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
        );

        // ---> NEW: Fetch latest blockhash inside the loop <---
        latestBlockhash = await this.connection.getLatestBlockhash();
        // ---> END NEW <---

        const mintAta = await getAssociatedTokenAddress(poolKeys.baseMint, this.config.wallet.publicKey);
        if (!mintAta) {
            throw new Error("Could not find associated token account for base mint to sell from.");
        }

        // ---> MODIFIED: Pass the new blockhash to the swap/execution logic <---
        // Note: Your 'swap' method needs to be adapted to accept and use the blockhash
        // OR the transaction building needs to happen here using the new blockhash.
        // This example assumes 'swap' is modified or logic is inline.
        const result = await this.swap( // Assuming swap is modified or logic is here
          poolKeys,
          mintAta,
          this.config.quoteAta,
          new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals),
          this.config.quoteToken,
          amountIn,
          this.config.sellSlippage,
          this.config.wallet,
          'sell',
          latestBlockhash // <-- Pass the fresh blockhash
        );
        // ---> END MODIFIED <---

        const latency = Date.now() - startTime; // <-- Calculate latency

        if (result.confirmed && result.signature) {
          // ---> ENHANCED LOGGING <---
          // TODO: Calculate actual slippage if possible by fetching transaction details
          const effectiveSlippage = 'N/A'; // Placeholder

          logger.info(
            {
              dex: `https://dexscreener.com/solana/${poolKeys.baseMint.toString()}?maker=${this.config.wallet.publicKey}`,
              mint: poolKeys.baseMint.toString(),
              signature: result.signature,
              url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              latency: `${latency}ms`, // Log latency
              effectiveSlippage: effectiveSlippage, // Log effective slippage (if calculated)
            },
            `Confirmed sell tx`,
          );
          // ---> END ENHANCED LOGGING <---
          sellConfirmed = true;
          break;
        }

        // ---> ENHANCED LOGGING (Failure) <---
        logger.warn(
          {
            mint: poolKeys.baseMint.toString(),
            signature: result.signature,
            error: result.error, // Log the specific error if available
            latency: `${latency}ms`,
            attempt: i + 1,
          },
          `Sell transaction failed to confirm attempt ${i + 1}. Error: ${result.error || 'Confirmation timeout'}`,
        );
        // ---> END ENHANCED LOGGING <---

      } catch (error: any) {
        const latency = Date.now() - startTime;
        // ---> ENHANCED LOGGING (Catch Block) <---
        logger.error(
            {
                mint: poolKeys.baseMint.toString(),
                error: error.message,
                errorCode: error.code, // Log code if present
                attempt: i + 1,
                latency: `${latency}ms`
            },
            `Error during sell attempt ${i + 1}`
        );
        // ---> END ENHANCED LOGGING <---
        await sleep(500); // Optional delay on error
      }
    } // End retry loop

    delete this.sellOrders[mint];
    logger.trace({ mint }, `Sell order processing finished. Confirmed: ${sellConfirmed}`);
  }

  private async swap(
    poolKeys: ExtendedLiquidityPoolKeys,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
    latestBlockhash: BlockhashWithExpiryBlockHeight // <-- Add blockhash parameter
  ): Promise<{ confirmed: boolean; signature?: string; error?: any }> {
    const slippagePercent = new Percent(slippage, 100);
    // Pass the actual poolKeys object to fetchInfo, cast to any if needed
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys: poolKeys as any, 
    });

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo: poolInfo, // Pass fetched pool info directly
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
              ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
              ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
            ]),
        ...(direction === 'buy'
          ? [
              createAssociatedTokenAccountIdempotentInstruction(
                wallet.publicKey,
                ataOut,
                wallet.publicKey,
                tokenOut.mint,
              ),
            ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async filterMatch(poolKeys: ExtendedLiquidityPoolKeys): Promise<boolean> {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await this.poolFilters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveFilterMatches <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveFilterMatches}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  private async priceMatch(amountIn: TokenAmount, poolKeys: ExtendedLiquidityPoolKeys) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return;
    }

    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfitPercentage).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    const takeProfit = this.config.quoteAmount.add(profitAmount);

    const lossFraction = this.config.quoteAmount.mul(this.config.stopLossPercentage).numerator.div(new BN(100));
    const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
    const stopLoss = this.config.quoteAmount.subtract(lossAmount);
    const slippage = new Percent(this.config.sellSlippage, 100);
    let timesChecked = 0;

    do {
      try {
        // Pass the actual poolKeys object to fetchInfo, cast to any if needed
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys: poolKeys as any, 
        });

        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo: poolInfo, // Pass fetched pool info directly
          amountIn: amountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        }).amountOut;

        logger.debug(
          { mint: poolKeys.baseMint.toString() },
          `Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
        );

        if (amountOut.lt(stopLoss)) {
          break;
        }

        if (amountOut.gt(takeProfit)) {
          break;
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);
  }

  private async simulateSwap(
    poolKeys: ExtendedLiquidityPoolKeys,
    amountIn: TokenAmount,
    direction: 'buy' | 'sell' 
  ): Promise<{ amountOut: TokenAmount, minAmountOut: TokenAmount }> {
    // Pass the actual poolKeys object to fetchInfo, cast to any if needed
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys: poolKeys as any, 
    });

    const currencyOut = direction === 'buy' ?
        new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals) :
        new Token(TOKEN_PROGRAM_ID, poolKeys.quoteMint, poolKeys.quoteDecimals);
    const slippage = direction === 'buy' ? this.config.buySlippage : this.config.sellSlippage;
    const slippagePercent = new Percent(slippage, 100);

    const { amountOut: computedAmountOut, minAmountOut: computedMinAmountOut } = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo: poolInfo, // Pass fetched pool info directly
      amountIn,
      currencyOut,
      slippage: slippagePercent,
    });

    const amountOutToken = new TokenAmount(currencyOut, computedAmountOut.raw);
    const minAmountOutToken = new TokenAmount(currencyOut, computedMinAmountOut.raw);

    return { amountOut: amountOutToken, minAmountOut: minAmountOutToken };
  }
}

async function findAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  programId = TOKEN_PROGRAM_ID,
  associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID,
) {
  const [address] = await PublicKey.findProgramAddress(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    associatedTokenProgramId,
  );

  return address;
}

async function getTokenMetadata(connection: Connection, mint: PublicKey): Promise<{ name?: string; symbol?: string } | null> {
  logger.warn({ mint: mint.toString() }, "getTokenMetadata not fully implemented, cannot reliably check name keywords.");

  return null; 
}

export interface Listeners {
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;

  close: () => Promise<void>;
}
