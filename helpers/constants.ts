import { Logger } from 'pino';
import dotenv from 'dotenv';
import { Commitment } from '@solana/web3.js';
import { logger } from './logger';

dotenv.config();

const retrieveEnvVariable = (variableName: string, logger: Logger) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

// Wallet
export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);

// Connection
export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = (retrieveEnvVariable('COMMITMENT_LEVEL', logger) || 'confirmed') as Commitment;
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);

// Bot
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger);
export const ONE_TOKEN_AT_A_TIME = retrieveEnvVariable('ONE_TOKEN_AT_A_TIME', logger) === 'true';
export const COMPUTE_UNIT_LIMIT = Number(retrieveEnvVariable('COMPUTE_UNIT_LIMIT', logger));
export const COMPUTE_UNIT_PRICE = Number(retrieveEnvVariable('COMPUTE_UNIT_PRICE', logger));
export const PRE_LOAD_EXISTING_MARKETS = retrieveEnvVariable('PRE_LOAD_EXISTING_MARKETS', logger) === 'true';
export const CACHE_NEW_MARKETS = retrieveEnvVariable('CACHE_NEW_MARKETS', logger) === 'true';
export const TRANSACTION_EXECUTOR = retrieveEnvVariable('TRANSACTION_EXECUTOR', logger);
export const CUSTOM_FEE = retrieveEnvVariable('CUSTOM_FEE', logger);

// Buy
export const AUTO_BUY_DELAY = Number(retrieveEnvVariable('AUTO_BUY_DELAY', logger));
export const QUOTE_MINT = (retrieveEnvVariable('QUOTE_MINT', logger) || 'So11111111111111111111111111111111111111112') as 'WSOL' | 'USDC';
export const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger) || '0.01';
export const MAX_BUY_RETRIES = Number(retrieveEnvVariable('MAX_BUY_RETRIES', logger));
export const BUY_SLIPPAGE = Number(retrieveEnvVariable('BUY_SLIPPAGE', logger));

// Sell
export const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
export const AUTO_SELL_DELAY = Number(retrieveEnvVariable('AUTO_SELL_DELAY', logger));
export const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger) || '10');
export const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger) || '25'); // Handle default
export const STOP_LOSS = Number(retrieveEnvVariable('STOP_LOSS', logger) || '10'); // Handle default
export const PRICE_CHECK_INTERVAL = Number(retrieveEnvVariable('PRICE_CHECK_INTERVAL', logger) || '2000'); // Handle default
export const PRICE_CHECK_DURATION = Number(retrieveEnvVariable('PRICE_CHECK_DURATION', logger) || '600000');
export const TAKE_PROFIT_PERCENTAGE = Number(retrieveEnvVariable('TAKE_PROFIT_PERCENTAGE', logger) || '0');
export const STOP_LOSS_PERCENTAGE = Number(retrieveEnvVariable('STOP_LOSS_PERCENTAGE', logger) || '0');
export const SELL_SLIPPAGE = Number(retrieveEnvVariable('SELL_SLIPPAGE', logger));
export const SELL_TIMED_NAME_KEYWORDS = (retrieveEnvVariable('SELL_TIMED_NAME_KEYWORDS', logger) || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s);
export const SELL_TIMED_NAME_DURATION_SECONDS = Number(retrieveEnvVariable('SELL_TIMED_NAME_DURATION_SECONDS', logger) || '60');
export const MAX_SELL_DURATION_SECONDS = Number(retrieveEnvVariable('MAX_SELL_DURATION_SECONDS', logger) || '0'); // Handle default

// Filters
export const FILTER_CHECK_INTERVAL = Number(retrieveEnvVariable('FILTER_CHECK_INTERVAL', logger));
export const FILTER_CHECK_DURATION = Number(retrieveEnvVariable('FILTER_CHECK_DURATION', logger));
export const CONSECUTIVE_FILTER_MATCHES = Number(retrieveEnvVariable('CONSECUTIVE_FILTER_MATCHES', logger));
export const CHECK_IF_MUTABLE = retrieveEnvVariable('CHECK_IF_MUTABLE', logger) === 'true';
export const CHECK_IF_SOCIALS = retrieveEnvVariable('CHECK_IF_SOCIALS', logger) === 'true';
export const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED', logger) === 'true';
export const CHECK_IF_FREEZABLE = (retrieveEnvVariable('CHECK_IF_FREEZABLE', logger) || 'false') === 'true';
export const CHECK_IF_BURNED = (retrieveEnvVariable('CHECK_IF_BURNED', logger) || 'true') === 'true';
export const MIN_POOL_SIZE_AMOUNT = retrieveEnvVariable('MIN_POOL_SIZE', logger) || '5';
export const MAX_POOL_SIZE_AMOUNT = retrieveEnvVariable('MAX_POOL_SIZE', logger) || '50';
export const USE_SNIPE_LIST = (retrieveEnvVariable('USE_SNIPE_LIST', logger) || 'false') === 'true';
export const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger) || '30000');

// New Filter: Max Pool Age
export const MAX_POOL_AGE_SECONDS = Number(retrieveEnvVariable('MAX_POOL_AGE_SECONDS', logger) || '3600');

// New Filter: Blocklist
export const FILTER_BLOCKLIST_NAMES = (retrieveEnvVariable('FILTER_BLOCKLIST_NAMES', logger) || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s);
export const FILTER_BLOCKLIST_SYMBOLS = (retrieveEnvVariable('FILTER_BLOCKLIST_SYMBOLS', logger) || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s);
