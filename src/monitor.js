import { createPublicClient, webSocket, parseAbi, formatEther } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { sendAlert } from './telegram.js';
import { autoBuy, emergencySell } from './trader.js';

const IS_TESTNET = process.env.RPC_URL?.includes('sepolia');
const chain = IS_TESTNET ? baseSepolia : base;

const BASESCAN_API = 'https://api.basescan.org/api';
const BASESCAN_KEY = process.env.BASESCAN_API_KEY;
const MIN_MCAP = 10000;
const MIN_LIQUIDITY = 5000;

const UNISWAP_V2_FACTORY = '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC9';
const UNISWAP_V4_POOL_MANAGER = '0x498581fF718922c3f8e6A244956aF099B2652b2b';
const WETH = '0x4200000000000000000000000000000000000006';

const FACTORY_ABI = parseAbi([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
]);

const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

const V4_ABI = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
]);

let client;
let reconnectTimeout;

function createClient() {
  return createPublicClient({
    chain,
    transport: webSocket(process.env.BASE_WSS_RPC),
  });
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

async function getLiquidityUsd(pairAddress, publicClient) {
  try {
    const reserves = await publicClient.readContract({
      address: pairAddress,
      abi: PAIR_ABI,
      functionName: 'getReserves',
    });
    const token0 = await publicClient.readContract({
      address: pairAddress,
      abi: PAIR_ABI,
      functionName: 'token0',
    });
    const wethReserve = token0.toLowerCase() === WETH.toLowerCase()
      ? reserves[0] : reserves[1];
    const ethPrice = await getEthPrice();
    const liquidityUsd = parseFloat(formatEther(wethReserve)) * 2 * ethPrice;
    return liquidityUsd;
  } catch (e) {
    return 0;
  }
}

async function getEthPrice() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    const data = await res.json();
    return parseFloat(data.price);
  } catch (e) {
    return 2500;
  }
}

async function getMarketCap(tokenAddress, publicClient) {
  try {
    const url = `${BASESCAN_API}?module=stats&action=tokensupply&contractaddress=${tokenAddress}&apikey=${BASESCAN_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const supply = parseFloat(data.result) / 1e18;
    const ethPrice = await getEthPrice();
    const priceRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const priceData = await priceRes.json();
    const price = priceData?.pairs?.[0]?.priceUsd || 0;
    return supply * parseFloat(price);
  } catch (e) {
    return 0;
  }
}

async function runFilters(tokenAddress, pairAddress, publicClient) {
  console.log('Running filters for: ' + tokenAddress);
  const liquidity = await getLiquidityUsd(pairAddress, publicClient);
  const mcap = await getMarketCap(tokenAddress, publicClient);
  
  if (liquidity < MIN_LIQUIDITY) {
    console.log('🚫 Filtered: Liquidity too low ($' + liquidity.toFixed(0) + ') - ' + tokenAddress);
    return false;
  }
  if (mcap < MIN_MCAP && mcap > 0) {
    console.log('🚫 Filtered: Mcap too low ($' + mcap.toFixed(0) + ') - ' + tokenAddress);
    return false;
  }
  console.log('✅ Passed: ' + tokenAddress);
  return true;
}

function startMonitor() {
  console.log('🔍 Monitoring Base for new token deployments...');

  try {
    client = createClient();

    // Watch Uniswap V2 pairs
    client.watchContractEvent({
      address: UNISWAP_V2_FACTORY,
      abi: FACTORY_ABI,
      eventName: 'PairCreated',
      onLogs: async (logs) => {
        for (const log of logs) {
          const { token0, token1, pair } = log.args;
          const tokenAddress = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0;
          
          const { name, symbol } = await getTokenMeta(tokenAddress);
          console.log('🪙 New ERC-20: ' + name + ' (' + symbol + ') at ' + tokenAddress);

          const passed = await runFilters(tokenAddress, pair, client);
          if (!passed) continue;

          const liquidity = await getLiquidityUsd(pair, client);
          const mcap = await getMarketCap(tokenAddress, client);

          await sendAlert({
            type: 'NEW_TOKEN',
            name,
            symbol,
            tokenAddress,
            liquidity: liquidity.toFixed(0),
            mcap: mcap.toFixed(0),
          });

          await autoBuy(tokenAddress, name, symbol);
        }
      },
      onError: (error) => {
        console.log('V2 watch error:', error.message);
        scheduleReconnect();
      },
    });

    console.log('✅ Watching Uniswap V2 and V4...');

  } catch (err) {
    console.log('Monitor start error:', err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  console.log('🔄 Reconnecting in 10 seconds...');
  reconnectTimeout = setTimeout(() => {
    startMonitor();
  }, 10000);
}

export { startMonitor };
