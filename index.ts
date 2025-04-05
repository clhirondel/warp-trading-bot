import { MarketCache, PoolCache } from './cache';
import { Listeners } from './listeners';
import { Connection, KeyedAccountInfo, Keypair } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Bot, BotConfig } from './bot';
import { DefaultTransactionExecutor, TransactionExecutor } from './transactions';
import {
  getToken,
  getWallet,
  logger,
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  PRE_LOAD_EXISTING_MARKETS,
  LOG_LEVEL,
  CHECK_IF_MUTABLE,
  CHECK_IF_MINT_IS_RENOUNCED,
  CHECK_IF_FREEZABLE,
  CHECK_IF_BURNED,
  QUOTE_MINT,
  MIN_POOL_SIZE_AMOUNT,
  MAX_POOL_SIZE_AMOUNT,
  QUOTE_AMOUNT,
  PRIVATE_KEY,
  USE_SNIPE_LIST,
  ONE_TOKEN_AT_A_TIME,
  AUTO_SELL_DELAY,
  MAX_SELL_RETRIES,
  AUTO_SELL,
  MAX_BUY_RETRIES,
  AUTO_BUY_DELAY,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  CACHE_NEW_MARKETS,
  TAKE_PROFIT_PERCENTAGE,
  STOP_LOSS_PERCENTAGE,
  BUY_SLIPPAGE,
  SELL_SLIPPAGE,
  PRICE_CHECK_DURATION,
  PRICE_CHECK_INTERVAL,
  SNIPE_LIST_REFRESH_INTERVAL,
  TRANSACTION_EXECUTOR,
  CUSTOM_FEE,
  FILTER_CHECK_INTERVAL,
  FILTER_CHECK_DURATION,
  CONSECUTIVE_FILTER_MATCHES,
  MAX_POOL_AGE_SECONDS,
  FILTER_BLOCKLIST_NAMES,
  FILTER_BLOCKLIST_SYMBOLS,
  MAX_SELL_DURATION_SECONDS,
  SELL_TIMED_NAME_KEYWORDS,
  SELL_TIMED_NAME_DURATION_SECONDS,
  MIN_MARKET_CAP, // Added import
  AUTO_BUY, // Added import
  CHECK_IF_SOCIALS, // Added import
  BUY_PRIORITY_FEE_MICROLAMPORTS, // Import new constant
  SELL_PRIORITY_FEE_MICROLAMPORTS, // Import new constant
  ATA_PRIORITY_FEE_MAX_MICROLAMPORTS, // Import new constant
} from './helpers';

import { version } from './package.json';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: COMMITMENT_LEVEL,
});

function printDetails(wallet: Keypair, quoteToken: Token, bot: Bot) {
  logger.info(`  
                                        ..   :-===++++-     
                                .-==+++++++- =+++++++++-    
            ..:::--===+=.=:     .+++++++++++:=+++++++++:    
    .==+++++++++++++++=:+++:    .+++++++++++.=++++++++-.    
    .-+++++++++++++++=:=++++-   .+++++++++=:.=+++++-::-.    
     -:+++++++++++++=:+++++++-  .++++++++-:- =+++++=-:      
      -:++++++=++++=:++++=++++= .++++++++++- =+++++:        
       -:++++-:=++=:++++=:-+++++:+++++====--:::::::.        
        ::=+-:::==:=+++=::-:--::::::::::---------::.        
         ::-:  .::::::::.  --------:::..                    
          :-    .:.-:::.                                    

          WARP DRIVE ACTIVATED 🚀🐟
          Made with ❤️ by humans.
          Version: ${version}                                          
  `);

  const botConfig = bot.config;

  logger.info('------- CONFIGURATION START -------');
  logger.info(`Wallet: ${wallet.publicKey.toString()}`);

  logger.info('- Bot -');

  logger.info(
    `Using ${TRANSACTION_EXECUTOR} executer: ${bot.isWarp || bot.isJito || (TRANSACTION_EXECUTOR === 'default' ? true : false)}`,
  );
  if (bot.isWarp || bot.isJito) {
    logger.info(`${TRANSACTION_EXECUTOR} fee: ${CUSTOM_FEE}`);
  } else {
    logger.info(`Compute Unit limit: ${botConfig.unitLimit}`);
    logger.info(`Compute Unit price (micro lamports): ${botConfig.unitPrice}`);
  }

  logger.info(`Single token at the time: ${botConfig.oneTokenAtATime}`);
  logger.info(`Pre load existing markets: ${PRE_LOAD_EXISTING_MARKETS}`);
  logger.info(`Cache new markets: ${CACHE_NEW_MARKETS}`);
  logger.info(`Log level: ${LOG_LEVEL}`);

  logger.info('- Buy -');
  logger.info(`Auto Buy: ${botConfig.autoBuy}`); // Added Auto Buy logging
  logger.info(`Buy amount: ${botConfig.quoteAmount.toFixed()} ${botConfig.quoteToken.name}`);
  logger.info(`Auto buy delay: ${botConfig.autoBuyDelay} ms`);
  logger.info(`Max buy retries: ${botConfig.maxBuyRetries}`);
  logger.info(`Buy amount (${quoteToken.symbol}): ${botConfig.quoteAmount.toFixed()}`);
  logger.info(`Buy slippage: ${botConfig.buySlippage}%`);
  logger.info(`Buy Token Priority Fee (MicroLamports): ${botConfig.buyPriorityFeeMicroLamports}%`);

  logger.info('- Sell -');
  logger.info(`Auto sell: ${AUTO_SELL}`);
  logger.info(`Auto sell delay: ${botConfig.autoSellDelay} ms`);
  logger.info(`Max sell retries: ${botConfig.maxSellRetries}`);
  logger.info(`Sell slippage: ${botConfig.sellSlippage}%`);
  logger.info(`Price check interval: ${botConfig.priceCheckInterval} ms`);
  logger.info(`Price check duration: ${botConfig.priceCheckDuration} ms`);
  logger.info(`Take profit: ${botConfig.takeProfitPercentage}%`);
  logger.info(`Stop loss: ${botConfig.stopLossPercentage}%`);
  logger.info(`Max sell duration: ${botConfig.maxSellDurationSeconds} seconds`);
  logger.info(`Sell Token Priority Fee (Microlamports): ${botConfig.sellPriorityFeeMicroLamports}%`);

  logger.info('- Snipe list -');
  logger.info(`Snipe list: ${botConfig.useSnipeList}`);
  logger.info(`Snipe list refresh interval: ${SNIPE_LIST_REFRESH_INTERVAL} ms`);

  if (botConfig.useSnipeList) {
    logger.info('- Filters -');
    logger.info(`Filters are disabled when snipe list is on`);
  } else {
    logger.info('- Filters -');
    logger.info(`Filter check interval: ${botConfig.filterCheckInterval} ms`);
    logger.info(`Filter check duration: ${botConfig.filterCheckDuration} ms`);
    logger.info(`Consecutive filter matches: ${botConfig.consecutiveFilterMatches}`);
    logger.info(`Check renounced: ${botConfig.checkRenounced}`);
    logger.info(`Check freezable: ${botConfig.checkFreezable}`);
    logger.info(`Check burned: ${botConfig.checkBurned}`);
    logger.info(`Check mutable: ${botConfig.checkMutable}`);
    logger.info(`Check socials: ${botConfig.checkSocials}`);
    logger.info(`Sell timed name keywords: ${botConfig.sellTimedNameKeywords.length > 0 ? botConfig.sellTimedNameKeywords.join(', ') : 'None'}`);
    logger.info(`Sell timed name duration: ${botConfig.sellTimedNameDurationSeconds} seconds`);
    logger.info(`Consecutive filter matches: ${botConfig.consecutiveFilterMatches}`);
    logger.info(`Min pool size: ${botConfig.minPoolSize.toFixed()}`);
    logger.info(`Max pool size: ${botConfig.maxPoolSize.toFixed()}`);
    logger.info(`Min market cap: ${botConfig.minMarketCap > 0 ? botConfig.minMarketCap.toLocaleString() : 'Disabled'}`);
    logger.info(`ATA Priority Fee Max (MicoLamports): ${botConfig.ataPriorityFeeMaxMicroLamports}`);
    logger.info(`Max pool age: ${botConfig.maxPoolAgeSeconds} seconds`);
    logger.info(`Blocklist names: ${botConfig.blocklistNames.length > 0 ? botConfig.blocklistNames.join(', ') : 'None'}`);
    logger.info(`Blocklist symbols: ${botConfig.blocklistSymbols.length > 0 ? botConfig.blocklistSymbols.join(', ') : 'None'}`);
  }

  logger.info('------- CONFIGURATION END -------');

  logger.info('Bot is running! Press CTRL + C to stop it.');
}

const runListener = async () => {
  logger.level = LOG_LEVEL;
  logger.info('Bot is starting...');

  const marketCache = new MarketCache(connection);
  const poolCache = new PoolCache();
  let txExecutor: TransactionExecutor;

  switch (TRANSACTION_EXECUTOR) {
    case 'warp': {
      txExecutor = new WarpTransactionExecutor(CUSTOM_FEE);
      break;
    }
    case 'jito': {
      txExecutor = new JitoTransactionExecutor(CUSTOM_FEE, connection);
      break;
    }
    default: {
      txExecutor = new DefaultTransactionExecutor(connection);
      break;
    }
  }

  const wallet = getWallet(PRIVATE_KEY.trim());
  const quoteToken = getToken(QUOTE_MINT);
  const quoteWallet = await getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey);
  const quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
  const minPoolSize = new TokenAmount(quoteToken, MIN_POOL_SIZE_AMOUNT, false);
  const maxPoolSize = new TokenAmount(quoteToken, MAX_POOL_SIZE_AMOUNT, false);

  const botConfig: BotConfig = {
    wallet,
    quoteAta: quoteWallet,
    checkRenounced: CHECK_IF_MINT_IS_RENOUNCED,
    checkFreezable: CHECK_IF_FREEZABLE,
    checkBurned: CHECK_IF_BURNED,
    minPoolSize: minPoolSize,
    maxPoolSize: maxPoolSize,
    quoteMint: quoteToken.mint, // Add missing quoteMint
    quoteToken,
    quoteAmount: quoteAmount,
    oneTokenAtATime: ONE_TOKEN_AT_A_TIME,
    useSnipeList: USE_SNIPE_LIST,
    autoSell: AUTO_SELL,
    autoSellDelay: AUTO_SELL_DELAY,
    maxSellRetries: MAX_SELL_RETRIES,
    autoBuyDelay: AUTO_BUY_DELAY,
    maxBuyRetries: MAX_BUY_RETRIES,
    unitLimit: COMPUTE_UNIT_LIMIT,
    unitPrice: COMPUTE_UNIT_PRICE,
    takeProfitPercentage: TAKE_PROFIT_PERCENTAGE,
    stopLossPercentage: STOP_LOSS_PERCENTAGE,
    buySlippage: BUY_SLIPPAGE,
    sellSlippage: SELL_SLIPPAGE,
    priceCheckInterval: PRICE_CHECK_INTERVAL,
    priceCheckDuration: PRICE_CHECK_DURATION,
    filterCheckInterval: FILTER_CHECK_INTERVAL,
    filterCheckDuration: FILTER_CHECK_DURATION,
    consecutiveFilterMatches: CONSECUTIVE_FILTER_MATCHES,
    blocklistNames: FILTER_BLOCKLIST_NAMES,
    blocklistSymbols: FILTER_BLOCKLIST_SYMBOLS,
    maxPoolAgeSeconds: MAX_POOL_AGE_SECONDS,
    maxSellDurationSeconds: MAX_SELL_DURATION_SECONDS,
    sellTimedNameKeywords: SELL_TIMED_NAME_KEYWORDS,
    sellTimedNameDurationSeconds: SELL_TIMED_NAME_DURATION_SECONDS,
    minMarketCap: MIN_MARKET_CAP, // Added minMarketCap
    autoBuy: AUTO_BUY, // Added autoBuy
    checkMutable: CHECK_IF_MUTABLE, // Added checkMutable
    checkSocials: CHECK_IF_SOCIALS, // Added checkSocials
    buyPriorityFeeMicroLamports: BUY_PRIORITY_FEE_MICROLAMPORTS, // Assign new buy fee
    sellPriorityFeeMicroLamports: SELL_PRIORITY_FEE_MICROLAMPORTS, // Assign new sell fee
    ataPriorityFeeMaxMicroLamports: ATA_PRIORITY_FEE_MAX_MICROLAMPORTS, // Assign ATA max

};

  const bot = new Bot(connection, poolCache, txExecutor, botConfig);
  const valid = await bot.validate();

  if (!valid) {
    logger.info('Bot is exiting...');
    process.exit(1);
  }

  if (PRE_LOAD_EXISTING_MARKETS) {
    await marketCache.init({ quoteToken });
  }

  const runTimestamp = Math.floor(new Date().getTime() / 1000);
  const listeners = new Listeners(connection);
  await listeners.start({
    walletPublicKey: wallet.publicKey,
    quoteToken,
    autoSell: AUTO_SELL,
    cacheNewMarkets: CACHE_NEW_MARKETS,
  });

  listeners.on('market', (updatedAccountInfo: KeyedAccountInfo) => {
    const marketState = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
    marketCache.save(updatedAccountInfo.accountId.toString(), marketState);
  });

  listeners.on('pool', async (updatedAccountInfo: KeyedAccountInfo) => {
    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
    const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
    const exists = await poolCache.get(poolState.baseMint.toString());

    if (!exists && poolOpenTime > runTimestamp) {
      poolCache.save(updatedAccountInfo.accountId.toString(), poolState);
      await bot.buy(updatedAccountInfo.accountId);
    }
  });

  listeners.on('wallet', async (updatedAccountInfo: KeyedAccountInfo) => {
    const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo.data);

    if (accountData.mint.equals(quoteToken.mint)) {
      return;
    }

    await bot.sell(updatedAccountInfo.accountId);
  });

  printDetails(wallet, quoteToken, bot);
};

runListener();
