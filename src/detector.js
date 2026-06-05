import { createPublicClient, webSocket, parseAbiItem, formatEther } from 'viem';
import { base } from 'viem/chains';
import { sendAlert } from './telegram.js';

const watchedTokens = new Map();

export const client = createPublicClient({
  chain: base,
  transport: webSocket(process.env.BASE_WSS_RPC),
});

async function getEthPrice() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    const data = await res.json();
    return parseFloat(data.price);
  } catch (e) {
    return 2500;
  }
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

function safeBigInt(val) {
  try { return BigInt(val || 0); } catch { return 0n; }
}

export function watchToken(tokenAddress, deployBlock, name, symbol) {
  if (watchedTokens.has(tokenAddress.toLowerCase())) return;

  watchedTokens.set(tokenAddress.toLowerCase(), {
    deployBlock,
    name,
    symbol,
    lpCreated: false,
    unwatch: null,
  });

  console.log('Watching new token: ' + tokenAddress);

  const unwatch = client.watchEvent({
    event: parseAbiItem('event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        const state = watchedTokens.get(tokenAddress.toLowerCase());
        if (!state) return;

        if (!state.lpCreated && log.blockNumber <= deployBlock + 2n) {
          state.lpCreated = true;
          console.log('LP created for ' + tokenAddress);
          continue;
        }

        console.log('First buy found for ' + tokenAddress);

        try {
          const ethPrice = await getEthPrice();

          const a0in = safeBigInt(log.args.amount0In);
          const a1in = safeBigInt(log.args.amount1In);
          const a0out = safeBigInt(log.args.amount0Out);
          const a1out = safeBigInt(log.args.amount1Out);

          const ethIn = a0in < a1in ? a0in : a1in;
          const tokensOut = a0out > a1out ? a0out : a1out;

          const ethAmt = parseFloat(formatEther(ethIn));
          const usdAmount = (ethAmt * ethPrice).toFixed(2);

          const totalSupply = await getTokenSupply(tokenAddress);
          const supplyNum = parseFloat(formatEther(totalSupply));
          const tokensBought = parseFloat(formatEther(tokensOut));
          const tokenPriceUsd = tokensBought > 0 ? (ethAmt * ethPrice) / tokensBought : 0;
          const mcap = supplyNum > 0 && tokenPriceUsd > 0 ? '$' + Math.round(supplyNum * tokenPriceUsd).toLocaleString() : 'N/A';

          await sendAlert({
            tokenAddress,
            tokenName: state.name || 'Unknown',
            tokenSymbol: state.symbol || '???',
            buyerAddress: log.args.to,
            ethAmount: ethAmt.toFixed(4),
            usdAmount,
            mcap,
            txHash: log.transactionHash,
          });
        } catch (err) {
          console.log('Error processing swap: ' + err.message);
        }

        state.unwatch?.();
        watchedTokens.delete(tokenAddress.toLowerCase());
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