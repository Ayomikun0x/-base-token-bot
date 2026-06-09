import { createPublicClient, http, parseAbi, formatEther } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { sendAlert } from './telegram.js';
import { autoBuy } from './trader.js';

const IS_TESTNET = process.env.RPC_URL?.includes('sepolia');
const chain = IS_TESTNET ? baseSepolia : base;

const BASESCAN_API = 'https://api.basescan.org/api';
const BASESCAN_KEY = process.env.BASESCAN_API_KEY;
const MIN_MCAP = 10000;
const MIN_LIQUIDITY = 5000;

const UNISWAP_V2_FACTORY = '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC9';
const WETH = '0x4200000000000000000000000000000000000006';

const FACTORY_ABI = parseAbi([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
]);

const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
]);

const client = createPublicClient({
  chain,
  transport: http(process.env.RPC_URL),
});

const processedPairs = new Set();

async function getEthPrice() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    const data = await res.json();
    return parseFloat(data.price);
  } catch (e) {
    return 2500;
  }
}

async function getTokenMeta(address) {
  try {
    const url = `${BASESCAN_API}?module=token&action=tokeninfo&contractaddress=${address}&apikey=${BASESCAN_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.result && data.result[0]) {
      return { name: data.result[0].tokenName, symbol: data.result[0].symbol };
    }
  } catch (e) {}
  return { name: 'Unknown', symbol: '???' };
}

async function getLiquidityUsd(pairAddress) {
  try {
    const reserves = await client.readContract({
      address: pairAddress,
      abi: PAIR_ABI,
      functionName: 'getReserves',
    });
    const token0 = await client.readContract({
      address: pairAddress,
      abi: PAIR_ABI,
      functionName: 'token0',
    });
    const wethReserve = token0.toLowerCase() === WETH.toLowerCase()
      ? reserves[0] : reserves[1];
    const ethPrice = await getEthPrice();
    return parseFloat(formatEther(wethReserve)) * 2 * ethPrice;
  } catch (e) {
    return 0;
  }
}

async function pollNewPairs() {
  try {
    const block = await client.getBlockNumber();
    const fromBlock = block - 5n;

    const logs = await client.getLogs({
      address: UNISWAP_V2_FACTORY,
      event: FACTORY_ABI[0],
      fromBlock,
      toBlock: block,
    });

    for (const log of logs) {
      const { token0, token1, pair } = log.args;
      if (processedPairs.has(pair)) continue;
      processedPairs.add(pair);

      const tokenAddress = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0;
      const { name, symbol } = await getTokenMeta(tokenAddress);
      console.log('🪙 New ERC-20: ' + name + ' (' + symbol + ') at ' + tokenAddress);

      const liquidity = await getLiquidityUsd(pair);
      if (liquidity < MIN_LIQUIDITY) {
        console.log('🚫 Filtered: Liquidity too low ($' + liquidity.toFixed(0) + ')');
        continue;
      }

      console.log('✅ Passed: ' + tokenAddress);

      await sendAlert({
        type: 'NEW_TOKEN',
        name,
        symbol,
        tokenAddress,
        liquidity: liquidity.toFixed(0),
        mcap: '0',
      });

      await autoBuy(tokenAddress, name, symbol);
    }
  } catch (err) {
    console.log('Poll error: ' + err.message);
  }
}

export function startMonitor() {
  console.log('🔍 Monitoring Base for new token deployments...');
  setInterval(pollNewPairs, 5000);
setInterval(() => console.log('💓 Bot alive - ' + new Date().toISOString()), 30000);
  pollNewPairs();
}
