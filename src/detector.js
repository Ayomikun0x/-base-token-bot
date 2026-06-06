import { createPublicClient, webSocket, parseAbiItem, formatEther } from 'viem';
import { base } from 'viem/chains';
import { sendAlert } from './telegram.js';

const watchedTokens = new Map();

// Known DEX routers and factories on Base
const DEX_ADDRESSES = [
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', // Uniswap V2 Router
  '0x8909dc15e40173ff4699343b6eb8132c65e18ec6', // Uniswap V2 Factory
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3 Router
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // KyberSwap Router
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', // Aerodrome Router
].map(a => a.toLowerCase());

export const client = createPublicClient({
  chain: base,
  transport: webSocket(process.env.BASE_WSS_RPC),
});

async function getEthPrice() {
  // Try multiple price sources
  const sources = [
    'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT',
    'https://api.coinbase.com/v2/prices/ETH-USD/spot',
    'https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD',
  ];

  for (const url of sources) {
    try {
      const res = await fetch(url);
      const data = await res.json();
      // Handle different response formats
      if (data.price) return parseFloat(data.price); // Binance
      if (data.data?.amount) return parseFloat(data.data.amount); // Coinbase
      if (data.USD) return parseFloat(data.USD); // CryptoCompare
    } catch (e) {
      continue;
    }
  }
  return 2500; // fallback
}

async function getTokenSupply(address) {
  try {
    const supply = await client.readContract({
      address,
      abi: [{ name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
      functionName: 'totalSupply',
    });
    return supply;
  } catch (e) {
    return 0n;
  }
}

function isDexAddress(address) {
  return DEX_ADDRESSES.includes(address?.toLowerCase());
}

export function watchToken(tokenAddress, deployBlock, name, symbol) {
  if (watchedTokens.has(tokenAddress.toLowerCase())) return;

  watchedTokens.set(tokenAddress.toLowerCase(), {
    deployBlock,
    name,
    symbol,
    lpAlerted: false,
    buyAlerted: false,
    unwatch: null,
  });

  console.log('Watching new token: ' + tokenAddress);

  const unwatch = client.watchEvent({
    event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
    address: tokenAddress,
    onLogs: async (logs) => {
      for (const log of logs) {
        const state = watchedTokens.get(tokenAddress.toLowerCase());
        if (!state) return;
        if (state.lpAlerted && state.buyAlerted) return;

        if (!log.args.value || log.args.value === 0n) continue;

        const from = log.args.from?.toLowerCase();
        const to = log.args.to?.toLowerCase();
        if (!to || to === '0x0000000000000000000000000000000000000000') continue;

        try {
          const ethPrice = await getEthPrice();
          const tx = await client.getTransaction({ hash: log.transactionHash });
          const ethAmt = parseFloat(formatEther(tx.value || 0n));
          const usdAmount = (ethAmt * ethPrice).toFixed(2);

          const totalSupply = await getTokenSupply(tokenAddress);
          const supplyNum = parseFloat(formatEther(totalSupply));
          const tokensBought = parseFloat(formatEther(log.args.value));
          const tokenPriceUsd = tokensBought > 0 && ethAmt > 0 ? (ethAmt * ethPrice) / tokensBought : 0;
          const mcap = supplyNum > 0 && tokenPriceUsd > 0
            ? '$' + Math.round(supplyNum * tokenPriceUsd).toLocaleString()
            : 'N/A';

          // LP creation — tokens going TO a DEX pair/router
          if (!state.lpAlerted && (isDexAddress(to) || log.blockNumber <= deployBlock + 3n)) {
            state.lpAlerted = true;
            await sendAlert({
              type: 'LP',
              tokenAddress,
              tokenName: state.name || 'Unknown',
              tokenSymbol: state.symbol || '???',
              walletAddress: from,
              ethAmount: ethAmt.toFixed(4),
              usdAmount,
              mcap,
              txHash: log.transactionHash,
            });
            continue;
          }

          // First buy — tokens going to a regular wallet
          if (!state.buyAlerted && !isDexAddress(to) && log.blockNumber > deployBlock + 3n) {
            state.buyAlerted = true;
            await sendAlert({
              type: 'BUY',
              tokenAddress,
              tokenName: state.name || 'Unknown',
              tokenSymbol: state.symbol || '???',
              walletAddress: to,
              ethAmount: ethAmt.toFixed(4),
              usdAmount,
              mcap,
              txHash: log.transactionHash,
            });
          }

        } catch (err) {
          console.log('Error: ' + err.message);
        }

        // Stop watching once both LP and buy are detected
        const updatedState = watchedTokens.get(tokenAddress.toLowerCase());
        if (updatedState?.lpAlerted && updatedState?.buyAlerted) {
          updatedState.unwatch?.();
          watchedTokens.delete(tokenAddress.toLowerCase());
          break;
        }
      }
    },
  });

  watchedTokens.get(tokenAddress.toLowerCase()).unwatch = unwatch;

  setTimeout(() => {
    if (watchedTokens.has(tokenAddress.toLowerCase())) {
      watchedTokens.get(tokenAddress.toLowerCase()).unwatch?.();
      watchedTokens.delete(tokenAddress.toLowerCase());
      console.log('Removed stale watch: ' + tokenAddress);
    }
  }, 30 * 60 * 1000);
}