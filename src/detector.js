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
  } catch {
    return 2500; // fallback price
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
  } catch {
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

        const ethPrice = await getEthPrice();
        const ethAmount