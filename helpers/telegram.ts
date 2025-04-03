import TelegramBot from 'node-telegram-bot-api';
import { logger } from './logger';
import { TELEGRAM_ALERTS_ENABLED, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './constants';

let bot: TelegramBot | null = null;

if (TELEGRAM_ALERTS_ENABLED) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logger.error('Telegram alerts enabled, but TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in .env file.');
  } else {
    try {
      // Initialize the bot only if enabled and configured
      // Using polling for simplicity, consider webhooks for production environments
      bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false }); // Set polling to false initially
      logger.info('Telegram bot initialized for alerts.');

      // Optional: Test message on startup (uncomment if needed)
      // sendMessage('Bot started successfully!').catch(e => logger.error({ error: e }, 'Failed to send startup message to Telegram.'));

    } catch (error) {
      logger.error({ error }, 'Failed to initialize Telegram bot.');
      bot = null; // Ensure bot is null if initialization fails
    }
  }
}

/**
 * Sends a message to the configured Telegram chat.
 * @param message The message text to send. Supports basic Markdown.
 */
export async function sendTelegramMessage(message: string): Promise<void> {
  if (!bot || !TELEGRAM_ALERTS_ENABLED || !TELEGRAM_CHAT_ID) {
    // Silently ignore if bot is not initialized or alerts are disabled
    return;
  }

  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    logger.trace('Sent Telegram message.');
  } catch (error) {
    logger.error({ error, messageText: message }, 'Failed to send Telegram message.');
    // Consider adding retry logic or specific error handling here
  }
}

// Example usage (will be integrated into bot.ts later):
// import { sendTelegramMessage } from './helpers/telegram';
// sendTelegramMessage(`*Buy Alert*\nToken: [${name}](https://solscan.io/token/${mint})\nAmount: ${amount} ${quoteSymbol}\nPrice: ${price}`);
// sendTelegramMessage(`*Sell Alert*\nToken: [${name}](https://solscan.io/token/${mint})\nReason: ${reason}`);
