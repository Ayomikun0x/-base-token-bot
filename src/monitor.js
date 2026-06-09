import { createPublicClient, webSocket, parseAbi, formatEther } from 'viem';
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

const processedPairs = new Set();
let unwatch = null;
let reconnectTimeout = null;

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

async function getLiquidityUsd(pairAddress, client) {
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

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  console.log('🔄 Reconnecting in 15 seconds...');
  reconnectTimeout = setTimeout(() => {
    startWatching();
  }, 15000);
}

function startWatching() {
  try {
    if (unwatch) unwatch();

    const client = createPublicClient({
      chain,
      transport: webSocket(process.env.BASE_WSS_RPC),
    });

    unwatch = client.watchContractEvent({
      address: UNISWAP_V2_FACTORY,
      abi: FACTORY_ABI,
      eventName: 'PairCreated',
      onLogs: async (logs) => {
        for (const log of logs) {
          const { token0, token1, pair } = log.args;
          if (processedPairs.has(pair)) continue;
          processedPairs.add(pair);

          const tokenAddress = token0.toLowerCase() === WETH.toLowerCase() ? token1 : token0;
          const { name, symbol } = await getTokenMeta(tokenAddress);
          console.log('🪙 New ERC-20: ' + name + ' (' + symbol + ') at ' + tokenAddress);

          const liquidity = await getLiquidityUsd(pair, client);
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
      },
      onError: (error) => {
        console.log('⚠️ WebSocket error, reconnecting...');
        scheduleReconnect();
      },
    });

    console.log('✅ Watching Uniswap V2 pairs...');

  } catch (err) {
    console.log('Start error: ' + err.message);
    scheduleReconnect();
  }
}

export function startMonitor() {
  console.log('🔍 Monitoring Base for new token deployments...');
  setInterval(() => console.log('💓 Bot alive - ' + new Date().toISOString()), 60000);
  startWatching();
}
