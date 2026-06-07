import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const sentAlerts = new Set();

export async function sendAlert({ type, tokenAddress, tokenName, tokenSymbol, walletAddress, ethAmount, usdAmount, mcap, lpStatus, holders, txHash }) {

  if (sentAlerts.has(txHash + type)) return;
  sentAlerts.add(txHash + type);

  const isLP = type === 'LP';
  const header = isLP ? '🟡 *Liquidity Added on Base!*' : '🟢 *First Buy Detected on Base!*';
  const walletLabel = isLP ? '💧 LP Creator' : '👤 Buyer';
  const amountLabel = isLP ? '💰 ETH Added' : '💰 Buy Amount';

  const msg = [
    header,
    '',
    `🪙 *Token:* ${tokenName} (${tokenSymbol})`,
    `📍 *Contract:*`,
    `\`${tokenAddress}\``,
    `${walletLabel}:`,
    `\`${walletAddress}\``,
    `${amountLabel}: ${ethAmount} ETH ($${usdAmount})`,
    `📊 *Market Cap:* ${mcap}`,
    `👥 *Holders:* ${holders}`,
    `🔒 *LP Status:* ${lpStatus}`,
    '',
    `🔗 [Basescan](https://basescan.org/tx/${txHash}) | 🦅 [Trade](https://aerodrome.finance/swap?inputCurrency=ETH&outputCurrency=${tokenAddress})`,
  ].join('\n');

  await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}

export async function sendRugAlert({ tokenAddress, tokenName, tokenSymbol, txHash, stage, ethRemoved }) {

  const key = txHash + 'RUG' + stage;
  if (sentAlerts.has(key)) return;
  sentAlerts.add(key);

  let msg = '';

  if (stage === 'removing') {
    msg = [
      '🔴 *LIQUIDITY BEING REMOVED!*',
      '',
      `🪙 *Token:* ${tokenName} (${tokenSymbol})`,
      `📍 *Contract:*`,
      `\`${tokenAddress}\``,
      `💸 *ETH Removed:* ${ethRemoved} ETH`,
      `⚠️ *SELL IMMEDIATELY!*`,
      '',
      `🦅 [SELL NOW](https://aerodrome.finance/swap?inputCurrency=${tokenAddress}&outputCurrency=ETH) | 🔗 [Basescan](https://basescan.org/tx/${txHash})`,
    ].join('\n');
  }

  if (stage === 'removed') {
    msg = [
      '🟤 *LIQUIDITY FULLY REMOVED!*',
      '',
      `🪙 *Token:* ${tokenName} (${tokenSymbol})`,
      `📍 *Contract:*`,
      `\`${tokenAddress}\``,
      `💸 *ETH Removed:* ${ethRemoved} ETH`,
      `💀 *Token is dead*`,
      '',
      `🔗 [View on Basescan](https://basescan.org/tx/${txHash})`,
    ].join('\n');
  }

  if (!msg) return;

  await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}