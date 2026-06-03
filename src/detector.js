import { createPublicClient, webSocket, parseAbiItem, formatEther } from 'viem';
import { base } from 'viem/chains';
import { sendAlert } from './telegram.js';

const watchedTokens = new Map();

export const client = createPublicClient({
  chain: base,
  transport: webSocket(process.env.BASE_WSS_RPC),
});

export function watchToken(tokenAddress, deployBlock, name, symbol) {
  if (watchedTokens.has(tokenAddress.toLowerCase())) return;

  watchedTokens.set(tokenAddress.toLowerCase(), {
    deployBlock,
    name,
    symbol,
    lpCreated: false,
    unwatch: null,
  });

  console.log(`👀 Watching new token: ${tokenAddress}`);

  const unwatch = client.watchEvent({
    event: parseAbiItem('event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        const state = watchedTokens.get(tokenAddress.toLowerCase());
        if (!state) return;

        if (!state.lpCreated && log.blockNumber <= deployBlock + 2n) {
          state.lpCreated = true;
          console.log(`💧 LP created for ${tokenAddress}, waiting for first real buy...`);
          continue;
        }

        console.log(`🎯 First buy found for ${tokenAddress}`);

        const amountIn = formatEther(log.args.amount1In > 0n ? log.args.amount1In : log.args.amount0In);

        await sendAlert({
          tokenAddress,
          tokenName: state.name || 'Unknown',
          tokenSymbol: state.symbol || '???',
          buyerAddress: log.args.to,
          amountIn,
          txHash: log.transactionHash,
        });

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
      console.log(`🗑️ Removed stale token watch: ${tokenAddress}`);
    }
  }, 30 * 60 * 1000);
} 
