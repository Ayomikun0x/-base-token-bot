import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const sentAlerts = new Set();

export async function sendAlert({ type, tokenAddress, tokenName, tokenSymbol, walletAddress, ethAmount, usdAmount, mcap, txHash }) {

  if (sentAlerts.has(txHash + type)) return;
  sentAlerts.add(txHash + type);

  const isLP = type === 'LP';

  const msg = `
${isLP ? '🟡 *Liquidity Added on Base!*' : '🟢 *First Buy Detected on Base!*'}

🪙 Token: \`${tokenName}\` (${tokenSymbol})
📍 Contract: \`${tokenAddress}\`
${isLP ? '💧 LP Creator:' : '👤 Buyer:'} \`${walletAddress}\`
💰 ${isLP ? 'ETH Added:' : 'Buy Amount:'} ${ethAmount} ETH ($${usdAmount})
📊 Market Cap: ${mcap}

🔗 [View on Basescan](https://basescan.org/tx/${txHash})
🦅 [Trade on Aerodrome](https://aerodrome.finance/swap?inputCurrency=ETH&outputCurrency=${tokenAddress})
  `.trim();

  await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}