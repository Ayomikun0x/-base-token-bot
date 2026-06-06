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

async function findLiquidityPool(tokenAddress) {
  try {
    // Watch for PairCreated event from Uniswap V2 factory on Base
    const UNISWAP_V2_FACTORY = '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6';
    const WETH = '0x4200000000000000000000000000000000000006';

    const logs = await client.getLogs({
      address: UNISWAP_V2_FACTORY,
      event: parseAbiItem('event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'),
      args: {
        token0: tokenAddress,
      },
      fromBlock: 'latest',
    });

    if (logs.length > 0) return logs[0].args.pair;

    const logs2 = await client.getLogs({
      address: UNISWAP_V2_FACTORY,
      event: parseAbiItem('event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'),
      args: {
        token1: tokenAddress,
      },
      fromBlock: 'latest',
    });

    if (logs2.length > 0) return logs2[0].args.pair;

    return null;
  } catch (e) {
    return null;
  }
}

export function watchToken(tokenAddress, deployBlock, name, symbol) {
  if (watchedTokens.has(tokenAddress.toLowerCase())) return;

  watchedTokens.set(tokenAddress.toLowerCase(), {
    deployBlock,
    name,
    symbol,
    alerted: false,
    unwatch: null,
  });

  console.log('Watching new token: ' + tokenAddress);

  // Watch Transfer events specifically for this token
  // First buy = Transfer from a DEX router/pool to a buyer wallet
  const unwatch = client.watchEvent({
    event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
    address: tokenAddress,
    onLogs: async (logs) => {
      for (const log of logs) {
        const state = watchedTokens.get(tokenAddress.toLowerCase());
        if (!state || state.alerted) return;

        // Skip if this is in the same block as deployment (LP creation)
        if (log.blockNumber <= deployBlock + 2n) continue;

        // Skip zero value transfers
        if (!log.args.value || log.args.value === 0n) continue;

        // Skip if recipient looks like a contract deployer or zero address
        const to = log.args.to?.toLowerCase();
        if (!to || to === '0x0000000000000000000000000000000000000000') continue;

        console.log('First buy found for ' + tokenAddress);

        try {
          const ethPrice = await getEthPrice();

          // Get transaction to find ETH value
          const tx = await client.getTransaction({ hash: log.transactionHash });
          const ethAmt = parseFloat(formatEther(tx.value || 0n));
          const usdAmount = (ethAmt * ethPrice).toFixed(2);

          const totalSupply = await getTokenSupply(tokenAddress);
          const supplyNum = parseFloat(formatEther(totalSupply));
          const tokensBought = parseFloat(formatEther(log.args.value));
          const tokenPriceUsd = tokensBought > 0 && ethAmt > 0 ? (ethAmt * ethPrice) / tokensBought : 0;
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
          console.log('Error processing transfer: ' + err.message);
        }

        state.unwatch?.();
        watchedTokens.delete(tokenAddress.toLowerCase());
        break;
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