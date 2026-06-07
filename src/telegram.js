import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const sentAlerts = new Set();

function pad(label, value) {
  return `${label.padEnd(12)} ${value}`;
}

export async function sendAlert({ type, tokenAddress, tokenName, tokenSymbol, walletAddress, ethAmount, usdAmount, mcap, lpStatus, holders, txHash }) {

  if (sentAlerts.has(txHash + type)) return;
  sentAlerts.add(txHash + type);

  const isLP = type === 'LP';
  const header = isLP ? '🟡 *Liquidity Added on Base!*' : '🟢 *First Buy Detected on Base!*';
  const walletLabel = isLP ? '💧 LP Creator' : '👤 Buyer';
  const amountLabel = isLP ? '💰 ETH Added' : '💰 Buy Amount';

  const msg = `
${header}

\`\`\`
${pad('Token:', tokenName + ' (' + tokenSymbol + ')')}
${pad('Contract:', tokenAddress)}
${pad(walletLabel + ':', walletAddress)}
${pad(amountLabel + ':', ethAmount + ' ETH ($' + usdAmount + ')')}
${pad('Market Cap:', mcap)}
${pad('Holders:', holders)}
${pad('LP Status:', lpStatus)}
\`\`\`

🔗 [Basescan](https://basescan.org/tx/${txHash}) | 🦅 [Trade](https://aerodrome.finance/swap?inputCurrency=ETH&outputCurrency=${tokenAddress})
  `.trim();

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
    msg = `
🔴 *LIQUIDITY BEING REMOVED!*

\`\`\`
${pad('Token:', tokenName + ' (' + tokenSymbol + ')')}
${pad('Contract:', tokenAddress)}
${pad('ETH Removed:', ethRemoved + ' ETH')}
${pad('Status:', 'SELL IMMEDIATELY!')}
\`\`\`

🦅 [SELL NOW](https://aerodrome.finance/swap?inputCurrency=${tokenAddress}&outputCurrency=ETH) | 🔗 [Basescan](https://basescan.org/tx/${txHash})
    `.trim();
  }

  if (stage === 'removed') {
    msg = `
🟤 *LIQUIDITY FULLY REMOVED!*

\`\`\`
${pad('Token:', tokenName + ' (' + tokenSymbol + ')')}
${pad('Contract:', tokenAddress)}
${pad('ETH Removed:', ethRemoved + ' ETH')}
${pad('Status:', 'Token is dead 💀')}
\`\`\`

🔗 [View on Basescan](https://basescan.org/tx/${txHash})
    `.trim();
  }

  if (!msg) return;

  await bot.telegram.sendMessage(process.env.TELEGRAM_CHAT_ID, msg, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
}