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

export function watchToken(tokenAddress, deployBlock, name, symbol) {
  if (watchedTokens.has(tokenAddress.toLowerCase())) return;

  watchedTokens.set(tokenAddress.toLowerCase(), {
    deployBlock,
    name,
    symbol,
    lpCreated: false,
    alerted: false,
    unwatch: null,
    unwatchV3: null,
  });

  console.log('Watching new token: ' + tokenAddress);

  // V2 swap handler
  const unwatchV2 = client.watchEvent({
    event: parseAbiItem('event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        const state = watchedTokens.get(tokenAddress.toLowerCase());
        if (!state || state.alerted) return;

        if (!state.lpCreated && log.blockNumber <= deployBlock + 2n) {
          state.lpCreated = true;
          continue;
        }

        try {
          const ethPrice = await getEthPrice();
          const a0in = BigInt(log.args.amount0In || 0);
          const a1in = BigInt(log.args.amount1In || 0);
          const a0out = BigInt(log.args.amount0Out || 0);
          const a1out = BigInt(log.args.amount1Out || 0);

          // ETH is the input side (non-zero input)
          const ethRaw = a0in > 0n ? a0in : a1in;
          const tokensRaw = a0out > 0n ? a0out : a1out;

          const ethAmt = parseFloat(formatEther(ethRaw));
          const usdAmount = (ethAmt * ethPrice).toFixed(2);

          const totalSupply = await getTokenSupply(tokenAddress);
          const supplyNum = parseFloat(formatEther(totalSupply));
          const tokensBought = parseFloat(formatEther(tokensRaw));
          const tokenPriceUsd = tokensBought > 0 ? (ethAmt * ethPrice) / tokensBought : 0;
          const mcap = supplyNum > 0 && tokenPriceUsd > 0 ? '$' + Math.round(supplyNum * tokenPriceUsd).toLocaleString() : 'N/A';

          state.alerted = true;

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
          console.log('V2 swap error: ' + err.message);
        }

        state.unwatch?.();
        state.unwatchV3?.();
        watchedTokens.delete(tokenAddress.toLowerCase());
      }
    },
  });

  // V3 swap handler
  const unwatchV3 = client.watchEvent({
    event: parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        const state = watchedTokens.get(tokenAddress.toLowerCase());
        if (!state || state.alerted) return;

        if (!state.lpCreated && log.blockNumber <= deployBlock + 2n) {
          state.lpCreated = true;
          continue;
        }

        try {
          const ethPrice = await getEthPrice();
          const amt0 = BigInt(log.args.amount0 || 0);
          const amt1 = BigInt(log.args.amount1 || 0);

          // Negative amount = tokens going out, positive = ETH coming in
          const ethRaw = amt0 > 0n ? amt0 : amt1;
          const tokensRaw = amt0 < 0n ? -amt0 : -amt1;

          const ethAmt = parseFloat(formatEther(ethRaw));
          const usdAmount = (ethAmt * ethPrice).toFixed(2);

          const totalSupply = await getTokenSupply(tokenAddress);
          const supplyNum = parseFloat(formatEther(totalSupply));
          const tokensBought = parseFloat(formatEther(tokensRaw < 0n ? -tokensRaw : tokensRaw));
          const tokenPriceUsd = tokensBought > 0 ? (ethAmt * ethPrice) / tokensBought : 0;
          const mcap = supplyNum > 0 && tokenPriceUsd > 0 ? '$' + Math.round(supplyNum * tokenPriceUsd).toLocaleString() : 'N/A';

          state.alerted = true;

          await sendAlert({
            tokenAddress,
            tokenName: state.name || 'Unknown',
            tokenSymbol: state.symbol || '???',
            buyerAddress: log.args.recipient,
            ethAmount: ethAmt.toFixed(4),
            usdAmount,
            mcap,
            txHash: log.transactionHash,
          });
        } catch (err) {
          console.log('V3 swap error: ' + err.message);
        }

        state.unwatch?.();
        state.unwatchV3?.();
        watchedTokens.delete(tokenAddress.toLowerCase());
      }
    },
  });

  const tokenState = watchedTokens.get(tokenAddress.toLowerCase());
  if (tokenState) {
    tokenState.unwatch = unwatchV2;
    tokenState.unwatchV3 = unwatchV3;
  }

  setTimeout(() => {
    if (watchedTokens.has(tokenAddress.toLowerCase())) {
      const s = watchedTokens.get(tokenAddress.toLowerCase());
      s.unwatch?.();
      s.unwatchV3?.();
      watchedTokens.delete(tokenAddress.toLowerCase());
      console.log('Removed stale watch: ' + tokenAddress);
    }
  }, 30 * 60 * 1000);
}