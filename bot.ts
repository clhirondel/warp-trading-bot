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
  Price, // Added Price import
  Token,
  TokenAmount,
  CurrencyAmount,
  Market as RaydiumMarket,
  LiquidityPoolKeysV4, // Import specific version if needed
} from '@raydium-io/raydium-sdk';
import { Market as SerumMarket } from '@project-serum/serum';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters, MinimalTokenMetadata } from './filters'; // Import MinimalTokenMetadata
import { TransactionExecutor } from './transactions';
import { createPoolKeys, logger, NETWORK, sleep } from './helpers';
import { sendTelegramMessage } from './helpers/telegram'; // Import Telegram helper
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
  minMarketCap: number; // Added minMarketCap
  autoBuy: boolean; // Added autoBuy flag
}

export interface BuyOrderDetails {
  mint: string;
  buyTimestamp: number;
  quoteAmountUsed: TokenAmount;
  minBaseTokenAmountReceived: TokenAmount;
  tokenName?: string; // Optional: Store token name if fetched
  tokenSymbol?: string; // Optional: Store token symbol if fetched
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
      minMarketCap: this.config.minMarketCap, // Pass minMarketCap
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
    let fetchedPoolInfo: FetchedPoolInfo | null = null;
    let marketInfo: SerumMarket | null = null;
    let metadata: MinimalTokenMetadata | undefined = undefined; // Store fetched metadata

    try {
      // Fetch pool info inside the buy method
      const fetchParams: LiquidityFetchInfoParams = {
        connection: this.connection,
        poolKeys: { id: accountId } as Partial<LiquidityPoolKeysV4>, // Only ID is needed initially
      };
      fetchedPoolInfo = await Liquidity.fetchInfo(fetchParams as any); // Cast to any due to SDK type issues

      if (!fetchedPoolInfo) throw new Error('Fetched pool info is missing inside buy.');

      baseMintStr = fetchedPoolInfo?.baseMint?.toString();

      if (!baseMintStr) {
        throw new Error('Base mint could not be determined from fetched pool info.');
      }

      // Initial check moved: Only check mutex if config requires it, before fetching
      if (this.config.oneTokenAtATime && this.mutex.isLocked()) {
        logger.warn({ mint: baseMintStr }, `Mutex is locked, skipping buy`);
        return;
      }

      // Existing validation for one token at a time
      if (this.config.oneTokenAtATime) {
        const bid = this.buyOrders[baseMintStr];
        if (bid) {
          logger.trace({ mint: baseMintStr }, 'Already bought this token, skipping buy.');
          return;
        }
      }

      // If oneTokenAtATime, acquire mutex *before* proceeding further
      if (this.config.oneTokenAtATime) {
        await this.mutex.acquire();
        this.processingMint.add(baseMintStr); // Use checked baseMintStr
      }

      // 2. Fetch Market Info
      if (!fetchedPoolInfo.marketId || !fetchedPoolInfo.marketProgramId) {
        throw new Error('Market ID or Market Program ID is missing from fetched pool info.');
      }
      marketInfo = await SerumMarket.load( // Use SerumMarket.load
        this.connection,
        fetchedPoolInfo.marketId,
        { commitment: this.connection.commitment }, // Pass commitment
        fetchedPoolInfo.marketProgramId
      );

      // 3. Create Pool Keys directly using fetched state and market
      const marketKeys = {
        eventQueue: marketInfo.decoded.eventQueue,
        bids: marketInfo.bidsAddress,
        asks: marketInfo.asksAddress,
      };
      const basicPoolKeys = createPoolKeys(accountId, fetchedPoolInfo as any, marketKeys);

      // 4. Create final ExtendedLiquidityPoolKeys
      poolKeys = {
        ...basicPoolKeys,
        poolOpenTime: fetchedPoolInfo?.poolOpenTime instanceof BN ? fetchedPoolInfo.poolOpenTime : new BN(0),
      };

      // --- Moved Checks: Perform remaining checks using poolKeys ---
      if (this.config.useSnipeList && !this.snipeListCache?.isInList(baseMintStr)) { // Use checked baseMintStr
        logger.trace({ mint: baseMintStr }, 'Skipping buy: not in snipe list');
        return; // Return here to ensure finally block runs correctly
      }

      // --- Execute Filters ---
      // Fetch metadata if needed by any filter
      const needsMetadata = this.poolFilters.filters.some((f) => f.requiresMetadata);
      if (needsMetadata) {
        try {
          metadata = await this.poolFilters.fetchMetadata(poolKeys); // Use the PoolFilters helper
          if (metadata) {
            logger.trace({ mint: poolKeys.baseMint.toString() }, `Fetched metadata for filters: Name=${metadata.name}, Symbol=${metadata.symbol}`);
          } else {
            logger.warn({ mint: poolKeys.baseMint.toString() }, 'Metadata not found for filter checks.');
          }
        } catch (error) {
          logger.error({ mint: poolKeys.baseMint.toString(), error }, 'Error fetching metadata for filters.');
          // Decide how to handle metadata fetch errors - maybe fail the buy?
          // For now, continue and let filters decide based on undefined metadata
        }
      }

      const filterResult = await this.poolFilters.execute(poolKeys, metadata);
      if (!filterResult.ok) {
        logger.info({ mint: poolKeys.baseMint.toString(), message: filterResult.message }, `Skipping buy due to filter: ${filterResult.message}`);
        return; // Filter failed, stop buy process
      }
      logger.info({ mint: poolKeys.baseMint.toString() }, `Token passed all filters.`);

      // --- Send Potential Buy Alert ---
      const potentialBuyMessage = `✅ *Potential Buy* ✅\nToken: ${metadata?.symbol || 'Symbol N/A'} (${metadata?.name || 'Name N/A'})\nMint: \`${poolKeys.baseMint.toString()}\`\n[Solscan](https://solscan.io/token/${poolKeys.baseMint.toString()})`;
      sendTelegramMessage(potentialBuyMessage).catch(e => logger.error({ error: e }, 'Failed to send potential buy Telegram message.'));
      // --- End Potential Buy Alert ---

      // --- End Filter Execution ---

      // --- Check AUTO_BUY flag ---
      if (!this.config.autoBuy) {
        logger.info({ mint: poolKeys.baseMint.toString() }, `Monitor mode: AUTO_BUY is false, skipping actual buy.`);
        return; // Stop processing if autoBuy is disabled
      }
      // --- End Check AUTO_BUY flag ---

      // Ensure ATA exists
      const quoteAta = await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.config.wallet, // Add payer
        this.config.quoteMint,
        this.config.wallet.publicKey
      );

      if (!quoteAta) throw new Error('Failed to get or create ATA for quote token.');

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

      const { amountOut: simulatedAmountOut, minAmountOut: minSimulatedAmountOut } = await this.simulateSwap(poolKeys!, quoteTokenAmount, 'buy');

      const maxPoolSizeRaw = this.config.maxPoolSize.raw;

      if (!maxPoolSizeRaw.isZero() && simulatedAmountOut.raw.gt(maxPoolSizeRaw)) {
        logger.debug(
          { mint: poolKeys!.baseMint.toString() },
          `Skipping buy because pool size (${simulatedAmountOut.toFixed()}) exceeds max pool size (${this.config.maxPoolSize.toFixed()})`,
        );
        return; // Return here to ensure finally block runs correctly
      }

      let buyConfirmed = false; // Flag to track if buy succeeded
      let lastError: any = null; // Store last error for alert

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        const startTime = Date.now();
        let latestBlockhash: BlockhashWithExpiryBlockHeight | null = null; // <-- Variable for blockhash

        try {
          logger.info(
            { mint: poolKeys!.baseMint.toString() },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );

          latestBlockhash = await this.connection.getLatestBlockhash(); // Fetch blockhash inside loop

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
            latestBlockhash // Pass fresh blockhash
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
            lastError = result.error || 'Confirmation timeout'; // Store error
            continue;
          }

          const effectiveSlippage = 'N/A'; // Placeholder
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
          const baseToken = new Token(TOKEN_PROGRAM_ID, poolKeys!.baseMint, poolKeys!.baseDecimals);
          const minBaseTokenAmountReceived = new TokenAmount(baseToken, minSimulatedAmountOut.raw);

          // --- Send Confirmed Buy Alert ---
          if (this.config.autoBuy) { // Only send if autoBuy was on
            const pricePerBase = quoteTokenAmount.isZero() ? 'N/A' : new Price(this.config.quoteToken, quoteTokenAmount.raw, baseToken, minBaseTokenAmountReceived.raw).toSignificant(6); // Approx price
            const confirmedBuyMessage = `💰 *Confirmed Buy* 💰\nToken: ${metadata?.symbol || 'Symbol N/A'} (${metadata?.name || 'Name N/A'})\nMint: \`${poolKeys!.baseMint.toString()}\`\nAmount: ${quoteTokenAmount.toFixed()} ${this.config.quoteToken.symbol}\nApprox Price: ${pricePerBase} ${this.config.quoteToken.symbol}\n[Solscan TX](https://solscan.io/tx/${result.signature}?cluster=${NETWORK})`;
            sendTelegramMessage(confirmedBuyMessage).catch(e => logger.error({ error: e }, 'Failed to send confirmed buy Telegram message.'));
          }
          // --- End Confirmed Buy Alert ---

          // Store buy order details, including metadata if fetched
          this.buyOrders[poolKeys!.baseMint.toString()] = {
            mint: poolKeys!.baseMint.toString(),
            buyTimestamp: buyTimestamp,
            quoteAmountUsed: quoteTokenAmount,
            minBaseTokenAmountReceived: minBaseTokenAmountReceived,
            tokenName: metadata?.name, // Store fetched name
            tokenSymbol: metadata?.symbol, // Store fetched symbol
          };
          logger.info({ mint: poolKeys!.baseMint.toString(), timestamp: buyTimestamp }, 'Buy order details recorded.');

          break;
        } catch (error: any) {
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
          lastError = error; // Store error
          await sleep(500); // Optional delay before retry
        }
      }

      // --- Send Buy Failed Alert ---
      if (!buyConfirmed && this.config.autoBuy) { // Check if buy wasn't confirmed and autoBuy was on
          const errorMessage = lastError instanceof Error ? lastError.message : JSON.stringify(lastError);
          const buyFailedMessage = `❌ *Buy Failed* ❌\nToken: ${metadata?.symbol || 'Symbol N/A'} (${metadata?.name || 'Name N/A'})\nMint: \`${poolKeys!.baseMint.toString()}\`\nReason: ${errorMessage}`;
          sendTelegramMessage(buyFailedMessage).catch(e => logger.error({ error: e }, 'Failed to send buy failed Telegram message.'));
      }
      // --- End Buy Failed Alert ---
    } catch (error) {
      logger.error({ mint: poolKeys?.baseMint?.toString() ?? baseMintStr ?? 'unknown', error }, 'Failed to buy token');
    } finally {
      if (this.config.oneTokenAtATime) {
        if (baseMintStr && this.processingMint.has(baseMintStr)) {
          this.mutex.release();
        }
      }
      if (baseMintStr) {
        logger.trace({ mint: baseMintStr }, `Finally block for buy: Removing pool from processing list.`);
        this.processingMint.delete(baseMintStr);
      } else {
        logger.error("Base mint string was undefined in finally block, cannot clean up processing list.");
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

    let accountData: Account | null = null;
    let mint: string | null = null;

    try {
      logger.trace({ tokenAccount: tokenAccountPubkey.toString() }, `Processing token account...`);

      accountData = await getAccount(this.connection, tokenAccountPubkey);
      if (!accountData) {
        logger.error({ tokenAccount: tokenAccountPubkey.toString() }, `Could not fetch account data for token account to sell.`);
        return;
      }

      mint = accountData.mint.toString();
      const balance = accountData.amount; // Use BigInt directly

      // Check if it's the quote token account itself
      if (this.config.quoteMint.equals(accountData.mint)) {
        logger.trace({ mint }, `Ignoring quote token account.`);
        return;
      }

      if (balance === 0n) { // Use BigInt literal
        logger.info({ mint }, `Token balance is zero, cannot sell.`);
        return;
      }

      // Check if already processing sell for this mint
      if (this.sellOrders[mint]) {
        logger.trace({ mint }, `Already processing sell for this token, skipping.`);
        return;
      }
      this.sellOrders[mint] = true; // Mark as processing

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint }, `Waiting for ${this.config.autoSellDelay} ms before sell check`);
        await sleep(this.config.autoSellDelay);
      }

      const poolData = await this.poolStorage.get(mint);

      if (!poolData?.state) {
        logger.warn({ mint }, `Token pool data or state is not found, cannot determine sell parameters.`);
        delete this.sellOrders[mint]; // Remove processing flag
        return;
      }

      if (!poolData.state.baseMint || !poolData.state.baseDecimal || !poolData.state.marketId || !poolData.state.marketProgramId) {
        logger.error({ mint }, `Required pool state properties missing, cannot sell.`);
        delete this.sellOrders[mint]; // Remove processing flag
        return;
      }

      // Load market info to build pool keys
      const marketInfo = await SerumMarket.load(
        this.connection,
        poolData.state.marketId,
        { commitment: this.connection.commitment },
        poolData.state.marketProgramId
      );

      const marketKeys = {
        eventQueue: marketInfo.decoded.eventQueue,
        bids: marketInfo.bidsAddress,
        asks: marketInfo.asksAddress,
      };
      const poolKeys: ExtendedLiquidityPoolKeys = createPoolKeys(new PublicKey(poolData.id), poolData.state as any, marketKeys);

      // Now perform the sell check
      await this.checkSell(poolKeys, accountData);

    } catch (error) {
      logger.error({ mint: mint ?? tokenAccountPubkey.toString(), error }, `Failed to process sell for token account`);
      if (mint) delete this.sellOrders[mint]; // Ensure processing flag is removed on error
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
      // Ensure processing flag is removed if checkSell didn't execute sellOrder
      if (mint && this.sellOrders[mint]) {
        logger.trace({ mint }, `Sell check finished without sell execution, removing processing flag.`);
        delete this.sellOrders[mint];
      }
    }
  }

  private async checkSell(poolKeys: ExtendedLiquidityPoolKeys, account: Account): Promise<void> {
    const mint = account.mint.toString();
    const buyOrder = this.buyOrders[mint];

    if (!buyOrder) {
      logger.warn(`[${mint}] Buy order details not found. Cannot check PNL or time-based sell conditions.`);
      // No sell order initiated yet, so no need to delete this.sellOrders[mint] here
      return;
    }
    if (!buyOrder.quoteAmountUsed || buyOrder.quoteAmountUsed.raw.isZero()) {
      logger.warn(`[${mint}] Original quote amount used is missing or zero. Cannot calculate PNL.`);
      return;
    }

    const tokenAmountIn = new TokenAmount(new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals), account.amount, true);
    if (tokenAmountIn.isZero()) {
      logger.trace(`[${mint}] Token amount is zero, skipping sell check.`);
      return;
    }

    try {
      // Simulate selling the base token back to quote token
      const poolInfo = await Liquidity.fetchInfo({ connection: this.connection, poolKeys: poolKeys as any });
      const { amountOut: currentQuoteValue } = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo: poolInfo,
        amountIn: tokenAmountIn,
        currencyOut: this.config.quoteToken, // Output is quote token
        slippage: new Percent(0), // No slippage for simulation
      });

      // Calculate PNL Percentage
      const originalQuoteCost = buyOrder.quoteAmountUsed; // TokenAmount (Quote)
      const pnlRaw = currentQuoteValue.raw.sub(originalQuoteCost.raw);
      const pnlPercentage = originalQuoteCost.raw.isZero() ? 0 : pnlRaw.mul(new BN(10000)).div(originalQuoteCost.raw).toNumber() / 100; // Avoid division by zero

      logger.info(`[${mint}] PNL Check: Current Value ≈ ${currentQuoteValue.toExact()} ${this.config.quoteToken.symbol}, Cost: ${originalQuoteCost.toExact()} ${this.config.quoteToken.symbol}, PNL: ${pnlPercentage.toFixed(2)}%`);

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
        const tokenName = buyOrder.tokenName || ''; // Use stored name if available
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
        // --- Send Sell Trigger Alert ---
        const tokenName = buyOrder.tokenName || 'Name N/A';
        const tokenSymbol = buyOrder.tokenSymbol || 'Symbol N/A';
        const sellTriggerMessage = `🚨 *Triggering Sell* 🚨\nToken: ${tokenSymbol} (${tokenName})\nMint: \`${mint}\`\nReason: ${sellReason}\n[Solscan](https://solscan.io/token/${mint})`;
        sendTelegramMessage(sellTriggerMessage).catch(e => logger.error({ error: e }, 'Failed to send sell trigger Telegram message.'));
        // --- End Sell Trigger Alert ---
        await this.sellOrder(poolKeys, tokenAmountIn, sellReason);
        // sellOrder handles deleting the sellOrders flag on completion/failure
      }
      // If no sell reason, the sellOrders flag will be deleted in the finally block of the calling `sell` method
    } catch (e: any) {
      logger.error(`[${mint}] Error during sell check simulation or calculation: ${e.message}`);
      logger.error(e.stack); // Log stack trace for better debugging
      // No sell order initiated yet, so no need to delete this.sellOrders[mint] here
    }
  }

  private async sellOrder(poolKeys: ExtendedLiquidityPoolKeys, amountIn: TokenAmount, reason: string): Promise<void> {
    const mint = poolKeys.baseMint.toString();
    logger.info({ mint, reason }, 'Attempting to execute sell order...');

    // Double-check if the processing flag is set (it should be by the caller)
    if (!this.sellOrders[mint]) {
      logger.warn({ mint }, 'Sell order initiated but processing flag was not set. This indicates a potential logic issue. Proceeding cautiously.');
      // Set it defensively, though the caller should have done this.
      this.sellOrders[mint] = true;
    }

    let sellConfirmed = false;

    for (let i = 0; i < this.config.maxSellRetries; i++) {
      const startTime = Date.now();
      let latestBlockhash: BlockhashWithExpiryBlockHeight | null = null;

      try {
        logger.info(
          { mint: poolKeys.baseMint.toString() },
          `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
        );

        latestBlockhash = await this.connection.getLatestBlockhash(); // Fetch fresh blockhash

        const mintAta = await getAssociatedTokenAddress(poolKeys.baseMint, this.config.wallet.publicKey);
        if (!mintAta) {
          throw new Error("Could not find associated token account for base mint to sell from.");
        }

        const result = await this.swap(
          poolKeys,
          mintAta,
          this.config.quoteAta,
          new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals),
          this.config.quoteToken,
          amountIn,
          this.config.sellSlippage,
          this.config.wallet,
          'sell',
          latestBlockhash // Pass fresh blockhash
        );

        const latency = Date.now() - startTime;

        if (result.confirmed && result.signature) {
          const effectiveSlippage = 'N/A'; // Placeholder
          logger.info(
            {
              dex: `https://dexscreener.com/solana/${poolKeys.baseMint.toString()}?maker=${this.config.wallet.publicKey}`,
              mint: poolKeys.baseMint.toString(),
              signature: result.signature,
              url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              latency: `${latency}ms`,
              effectiveSlippage: effectiveSlippage,
            },
            `Confirmed sell tx`,
          );
          sellConfirmed = true;

          // --- Send Confirmed Sell Alert ---
          const sellTokenName = this.buyOrders[mint]?.tokenName || 'Name N/A'; // Get name from buy order if possible
          const sellTokenSymbol = this.buyOrders[mint]?.tokenSymbol || 'Symbol N/A';
          const confirmedSellMessage = `💸 *Confirmed Sell* 💸\nToken: ${sellTokenSymbol} (${sellTokenName})\nMint: \`${mint}\`\nReason: ${reason}\n[Solscan TX](https://solscan.io/tx/${result.signature}?cluster=${NETWORK})`;
          sendTelegramMessage(confirmedSellMessage).catch(e => logger.error({ error: e }, 'Failed to send confirmed sell Telegram message.'));
          // --- End Confirmed Sell Alert ---

          // Remove from buy orders after successful sell
          delete this.buyOrders[mint];
          logger.trace({ mint }, `Removed from buy orders after successful sell.`);
          break; // Exit retry loop on success
        }

        logger.warn(
          {
            mint: poolKeys.baseMint.toString(),
            signature: result.signature,
            error: result.error,
            latency: `${latency}ms`,
            attempt: i + 1,
          },
          `Sell transaction failed to confirm attempt ${i + 1}. Error: ${result.error || 'Confirmation timeout'}`,
        );

      } catch (error: any) {
        const latency = Date.now() - startTime;
        logger.error(
          {
            mint: poolKeys.baseMint.toString(),
            error: error.message,
            errorCode: error.code,
            attempt: i + 1,
            latency: `${latency}ms`
          },
          `Error during sell attempt ${i + 1}`
        );
        await sleep(500); // Optional delay on error
      }
    } // End retry loop

    // --- Send Sell Failed Alert ---
    if (!sellConfirmed) {
        const sellTokenName = this.buyOrders[mint]?.tokenName || 'Name N/A'; // Get name from buy order if possible
        const sellTokenSymbol = this.buyOrders[mint]?.tokenSymbol || 'Symbol N/A';
        // We don't have the specific error from the loop easily here, so provide a general failure message
        const sellFailedMessage = `❌ *Sell Failed* ❌\nToken: ${sellTokenSymbol} (${sellTokenName})\nMint: \`${mint}\`\nReason: Failed to confirm after ${this.config.maxSellRetries} retries.`;
        sendTelegramMessage(sellFailedMessage).catch(e => logger.error({ error: e }, 'Failed to send sell failed Telegram message.'));
    }
     // --- End Sell Failed Alert ---

    // Clean up the processing flag regardless of confirmation outcome
    delete this.sellOrders[mint];
    logger.trace({ mint }, `Sell order processing finished. Confirmed: ${sellConfirmed}. Removed processing flag.`);
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
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys: poolKeys as any,
    });

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo: poolInfo,
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
      recentBlockhash: latestBlockhash.blockhash, // Use provided blockhash
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
              ataOut, // ata for the token being bought
              wallet.publicKey,
              tokenOut.mint, // mint of the token being bought
            ),
          ]
          : []),
        ...innerTransaction.instructions,
        ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []), // Close the base token ATA after selling
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    // Pass the full blockhash object for confirmation
    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  // filterMatch remains unchanged as it doesn't directly impact PNL calculation
  private async filterMatch(poolKeys: ExtendedLiquidityPoolKeys): Promise<boolean> {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        // Fetch metadata if needed by filters for this specific check
        let metadata: MinimalTokenMetadata | undefined;
        const needsMetadata = this.poolFilters.filters.some(f => f.requiresMetadata);
        if (needsMetadata) {
          metadata = await this.poolFilters.fetchMetadata(poolKeys).catch(err => {
            logger.warn({ mint: poolKeys.baseMint.toString(), error: err }, 'Error fetching metadata during filter check.');
            return undefined;
          });
        }

        const { ok, message } = await this.poolFilters.execute(poolKeys, metadata);

        if (ok) {
          matchCount++;
          logger.trace(
            { mint: poolKeys.baseMint.toString() },
            `Filter match ${matchCount}/${this.config.consecutiveFilterMatches} passed.`
          );

          if (this.config.consecutiveFilterMatches <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter matched ${matchCount} times consecutively.`
            );
            return true;
          }
        } else {
          logger.trace(
            { mint: poolKeys.baseMint.toString(), message },
            `Filter match failed: ${message}`
          );
          matchCount = 0; // Reset count if a check fails
        }

        await sleep(this.config.filterCheckInterval);
      } catch (error) {
        logger.error({ mint: poolKeys.baseMint.toString(), error }, 'Error during filter check execution.');
        matchCount = 0; // Reset count on error
        await sleep(this.config.filterCheckInterval); // Still wait before next check
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    logger.debug(
      { mint: poolKeys.baseMint.toString() },
      `Filter check duration ended. Matches: ${matchCount}/${this.config.consecutiveFilterMatches}. Required: ${this.config.consecutiveFilterMatches}.`
    );
    return false; // Didn't meet consecutive matches within the duration
  }


  // priceMatch is deprecated by the new checkSell logic, but kept for reference if needed later
  private async priceMatch(amountIn: TokenAmount, poolKeys: ExtendedLiquidityPoolKeys) {
    // This method is effectively replaced by the PNL logic in checkSell
    logger.warn("priceMatch method is deprecated and should not be actively used. PNL logic is handled in checkSell.");
    return;
  }

  private async simulateSwap(
    poolKeys: ExtendedLiquidityPoolKeys,
    amountIn: TokenAmount,
    direction: 'buy' | 'sell'
  ): Promise<{ amountOut: TokenAmount, minAmountOut: TokenAmount }> {
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys: poolKeys as any,
    });

    const currencyOut = direction === 'buy' ?
      new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals) :
      this.config.quoteToken; // Use the configured quoteToken for sell simulation output
    const slippage = direction === 'buy' ? this.config.buySlippage : this.config.sellSlippage;
    const slippagePercent = new Percent(slippage, 100);

    const { amountOut: computedAmountOut, minAmountOut: computedMinAmountOut } = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo: poolInfo,
      amountIn,
      currencyOut,
      slippage: slippagePercent,
    });

    // Ensure the output amounts are TokenAmount instances
    const amountOutToken = new TokenAmount(currencyOut, computedAmountOut.raw);
    const minAmountOutToken = new TokenAmount(currencyOut, computedMinAmountOut.raw);

    return { amountOut: amountOutToken, minAmountOut: minAmountOutToken };
  }
}

// getTokenMetadata remains a placeholder
async function getTokenMetadata(connection: Connection, mint: PublicKey): Promise<{ name?: string; symbol?: string } | null> {
  logger.warn({ mint: mint.toString() }, "getTokenMetadata not fully implemented, cannot reliably check name keywords.");
  // Placeholder implementation: Fetch metadata using PoolFilters helper if needed elsewhere,
  // but this function itself doesn't seem actively used for its return value currently.
  // Consider removing or implementing fully if required.
  return null;
}

// Interfaces like Listeners remain unchanged
export interface Listeners {
  on(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;

  close: () => Promise<void>;
}
