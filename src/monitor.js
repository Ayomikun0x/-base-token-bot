import { createPublicClient, http, parseAbi, formatEther } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { sendAlert } from './telegram.js';
import { autoBuy } from './trader.js';

const IS_TESTNET = process.env.RPC_URL?.includes('sepolia');
const chain = IS_TESTNET ? baseSepolia : base;
const BASESCAN_KEY = process.env.BASESCAN_API_KEY;
const MIN_LIQUIDITY = 5000;

const UNISWAP_V2_FACTORY = '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC9';
const AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const WETH = '0x4200000000000000000000000000000000000006';

const V2_FACTORY_ABI = parseAbi([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
]);

const AERODROME_ABI = parseAbi([
  'event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint)',
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
    const url = `https://api.basescan.org/v2/api?chainid=8453&module=token&action=tokeninfo&contractaddress=${address}&apikey=${BASESCAN_KEY}`;
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

async function processToken(tokenAddress, pairAddress, source) {
  if (processedPairs.has(pairAddress)) return;
  processedPairs.add(pairAddress);

  const { name, symbol } = await getTokenMeta(tokenAddress);
  console.log('🪙 New ERC-20 [' + source + ']: ' + name + ' (' + symbol + ') at ' + tokenAddress);

  const liquidity = await getLiquidityUsd(pairAddress);
  if (liquidity < MIN_LIQUIDITY) {
    console.log('🚫 Filtered: Liquidity too low ($' + liquidity.toFixed(0) + ')');
    return;
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

async function pollNewPairs() {
  try {
    const block = await client.getBlockNumber();
    const fromBlock = block - 100n;

    // Check Uniswap V2
    const v2Logs = await client.getLogs({
      address: UNISWAP_V2_FACTORY,
      event: V2_FACTORY_ABI[0],
      fromBlock,
      toBlock: block,
    });

    for (const log of v2Logs) {
      const { token0, token1, pair } = log.args;
      const tokenAddress = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0;
      await processToken(tokenAddress, pair, 'V2');
    }

    // Check Aerodrome
    const aeroLogs = await client.getLogs({
      address: AERODROME_FACTORY,
      event: AERODROME_ABI[0],
      fromBlock,
      toBlock: block,
    });

    for (const log of aeroLogs) {
      const { token0, token1, pool } = log.args;
      const tokenAddress = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0;
      await processToken(tokenAddress, pool, 'Aerodrome');
    }

    const total = v2Logs.length + aeroLogs.length;
    if (total > 0) console.log('Found ' + total + ' new pairs in blocks ' + fromBlock + '-' + block);

  } catch (err) {
    console.log('Poll error: ' + err.message);
  }
}

export function startMonitor() {
  console.log('🔍 Monitoring Base for new token deployments...');
  setInterval(pollNewPairs, 5000);
  setInterval(() => console.log('💓 Bot alive - ' + new Date().toISOString()), 60000);
  pollNewPairs();
}
