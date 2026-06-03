import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

export async function sendAlert({ tokenAddress, tokenName, tokenSymbol, buyerAddress, amountIn, txHash }) {
  const msg = `
🟢 *First Buy Detected on Base!*

🪙 Token: \`${tokenName}\` (${tokenSymbol})
📍 Contract: \`${tokenAddress}\`
👤 Buyer: \`${buyerAddress}\`
💰 ETH spent: ${amountIn} ETH

🔗 [View on Basescan](https://basescan.org/tx/${txHash})
🦅 [Trade on Aerodrome](https://aerodrome.finance/swap?inputCurrency=ETH&outputCurrency=${tokenAddress})
  `.trim();

  await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
} 
