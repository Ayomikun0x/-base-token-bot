import { createWalletClient, createPublicClient, http, parseEther, formatEther, parseAbi } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { sendTradeAlert } from './telegram.js';

// Trade settings
const BUY_AMOUNT_USD = 5;
const TAKE_PROFIT_PERCENT = 80;
const STOP_LOSS_PERCENT = 40;
const MAX_HOLD_TIME_MS = 30 * 60 * 1000; // 30 minutes

const IS_TESTNET = process.env.RPC_URL?.includes('sepolia');

const chain = IS_TESTNET ? baseSepolia : base;
const rpcUrl = process.env.RPC_URL || 'https://mainnet.base.org';

const UNISWAP_V2_ROUTER = IS_TESTNET
  ? '0x1689E7B1F10000AE47eBfE339a4f69dECd19F602' // Sepolia router
  : '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24'; // Mainnet router

const WETH = IS_TESTNET
  ? '0x4200000000000000000000000000000000000006'
  : '0x4200000000000000000000000000000000000006';

const ROUTER_ABI = parseAbi([
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const rawKey = (String(process.env.KEY_PART1 || '') + String(process.env.KEY_PART2 || '')).replace(/\s/g, '');
const formattedKey = rawKey?.startsWith('0x') ? rawKey : '0x' + rawKey;
console.log('Key length:', formattedKey?.length);
const account = privateKeyToAccount(formattedKey);

const walletClient = createWalletClient({
  account,
  chain,
  transport: http(rpcUrl),
});

const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl),
});

// Track open trades
const openTrades = new Map();

async function getEthPrice() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    const data = await res.json();
    return parseFloat(data.price);
  } catch (e) {
    return 2500;
  }
}

async function getTokenPrice(tokenAddress, ethPrice) {
  try {
    const amountsOut = await publicClient.readContract({
      address: UNISWAP_V2_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [parseEther('0.001'), [WETH, tokenAddress]],
    });
    const tokensPerEth = parseFloat(formatEther(amountsOut[1])) * 1000;
    const pricePerToken = ethPrice / tokensPerEth;
    return pricePerToken;
  } catch (e) {
    return 0;
  }
}

export async function autoBuy(tokenAddress, tokenName, tokenSymbol) {
  if (openTrades.has(tokenAddress.toLowerCase())) return;

  try {
    console.log('🤖 Auto buying: ' + tokenName);

    const ethPrice = await getEthPrice();
    const ethToBuy = BUY_AMOUNT_USD / ethPrice;
    const ethAmount = parseEther(ethToBuy.toFixed(6));

    // Get expected tokens out
    const amountsOut = await publicClient.readContract({
      address: UNISWAP_V2_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [ethAmount, [WETH, tokenAddress]],
    });

    const expectedTokens = amountsOut[1];
    const minTokens = expectedTokens * 80n / 100n; // 20% slippage

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    // Execute buy
    const txHash = await walletClient.writeContract({
      address: UNISWAP_V2_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'swapExactETHForTokens',
      args: [minTokens, [WETH, tokenAddress], account.address, deadline],
      value: ethAmount,
    });

    console.log('✅ Buy tx: ' + txHash);

    // Get actual tokens received
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const tokenBalance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account.address],
    });

    const buyPriceUsd = BUY_AMOUNT_USD;
    const entryPrice = await getTokenPrice(tokenAddress, ethPrice);

    // Store trade info
    openTrades.set(tokenAddress.toLowerCase(), {
      tokenAddress,
      tokenName,
      tokenSymbol,
      tokenBalance,
      buyPriceUsd,
      entryPrice,
      buyTime: Date.now(),
      txHash,
    });

    await sendTradeAlert({
      type: 'BUY',
      tokenName,
      tokenSymbol,
      tokenAddress,
      amountUsd: buyPriceUsd.toFixed(2),
      txHash,
    });

    // Start monitoring for TP/SL
    monitorTrade(tokenAddress, entryPrice, ethPrice);

  } catch (err) {
    console.log('❌ Buy failed: ' + err.message);
  }
}

async function sellToken(tokenAddress, reason) {
  const trade = openTrades.get(tokenAddress.toLowerCase());
  if (!trade) return;

  try {
    console.log('💸 Selling: ' + trade.tokenName + ' — ' + reason);

    const ethPrice = await getEthPrice();

    // Approve router to spend tokens
    const allowance = await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, UNISWAP_V2_ROUTER],
    });

    if (allowance < trade.tokenBalance) {
      await walletClient.writeContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [UNISWAP_V2_ROUTER, trade.tokenBalance],
      });
      await new Promise(r => setTimeout(r, 3000)); // wait for approval
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

    const txHash = await walletClient.writeContract({
      address: UNISWAP_V2_ROUTER,
      abi: ROUTER_ABI,
      functionName: 'swapExactTokensForETH',
      args: [trade.tokenBalance, 0n, [tokenAddress, WETH], account.address, deadline],
    });

    console.log('✅ Sell tx: ' + txHash);

    // Calculate PnL
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const currentEthBalance = await publicClient.getBalance({ address: account.address });
    const exitPrice = await getTokenPrice(tokenAddress, ethPrice);
    const pnlPercent = ((exitPrice - trade.entryPrice) / trade.entryPrice * 100).toFixed(1);
    const pnlUsd = (trade.buyPriceUsd * parseFloat(pnlPercent) / 100).toFixed(2);

    await sendTradeAlert({
      type: 'SELL',
      tokenName: trade.tokenName,
      tokenSymbol: trade.tokenSymbol,
      tokenAddress,
      reason,
      pnlPercent,
      pnlUsd,
      txHash,
    });

    openTrades.delete(tokenAddress.toLowerCase());

  } catch (err) {
    console.log('❌ Sell failed: ' + err.message);
    openTrades.delete(tokenAddress.toLowerCase());
  }
}

async function monitorTrade(tokenAddress, entryPrice, initialEthPrice) {
  const checkInterval = setInterval(async () => {
    const trade = openTrades.get(tokenAddress.toLowerCase());
    if (!trade) {
      clearInterval(checkInterval);
      return;
    }

    try {
      const ethPrice = await getEthPrice();
      const currentPrice = await getTokenPrice(tokenAddress, ethPrice);

      if (currentPrice === 0) return;

      const changePercent = ((currentPrice - entryPrice) / entryPrice) * 100;

      console.log(trade.tokenSymbol + ' price change: ' + changePercent.toFixed(1) + '%');

      // Take profit
      if (changePercent >= TAKE_PROFIT_PERCENT) {
        clearInterval(checkInterval);
        await sellToken(tokenAddress, 'Take Profit +' + changePercent.toFixed(1) + '%');
        return;
      }

      // Stop loss
      if (changePercent <= -STOP_LOSS_PERCENT) {
        clearInterval(checkInterval);
        await sellToken(tokenAddress, 'Stop Loss ' + changePercent.toFixed(1) + '%');
        return;
      }

      // Time limit
      if (Date.now() - trade.buyTime >= MAX_HOLD_TIME_MS) {
        clearInterval(checkInterval);
        await sellToken(tokenAddress, 'Time Limit (30 min)');
        return;
      }

    } catch (err) {
      console.log('Monitor error: ' + err.message);
    }
  }, 15000); // Check every 15 seconds
}

export async function emergencySell(tokenAddress, tokenName, tokenSymbol) {
  if (openTrades.has(tokenAddress.toLowerCase())) {
    await sellToken(tokenAddress, '🔴 Rug Detected!');
  }
}
