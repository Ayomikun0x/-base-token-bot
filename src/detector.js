import { createPublicClient, webSocket, parseAbiItem, formatEther } from 'viem';
import { base } from 'viem/chains';
import { sendAlert } from './telegram.js';

const watchedTokens = new Map();

const DEX_ADDRESSES = [
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', // Uniswap V2 Router
  '0x8909dc15e40173ff4699343b6eb8132c65e18ec6', // Uniswap V2 Factory
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap V3 Router
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', // KyberSwap Router
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43', // Aerodrome Router
  '0x498581ff718922c3f8e6a244956af099b2652b2b', // Uniswap V4 Pool Manager
  '0x7c5f5a4bbd8fd63184577525326123b519429bdc', // Uniswap V4 Position Manager
  '0x6ff5693b99212da76ad316178a184ab56d299b43', // Uniswap V4 Universal Router
].map(a => a.toLowerCase());

const WETH = '0x4200000000000000000000000000000000000006';
const MIN_ETH_BUY = 0.001; // minimum ETH for a real buy

export const client = createPublicClient({
  chain: base,
  transport: webSocket(process.env.BASE_WSS_RPC),
});

async function getEthPrice() {
  const sources = [
    { url: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', parse: d => parseFloat(d.price) },
    { url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot', parse: d => parseFloat(d.data?.amount) },
    { url: 'https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD', parse: d => parseFloat(d.USD) },
  ];
  for (const s of sources) {
    try {
      const res = await fetch(s.url);
      const data = await res.json();
      const price = s.parse(data);
      if (price && !isNaN(price)) return price;
    } catch (e) { continue; }
  }
  return 2500;
}

async function getTokenSupply(address) {
  try {
    const supply = await client.readContract({
      address,
      abi: [{ name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
      functionName: 'totalSupply',
    });
    return supply;
  } catch (e) { return 0n; }
}

async function getWethAmountFromTx(txHash) {
  // Get WETH transfer amount from transaction logs
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    const wethTransferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === WETH.toLowerCase() &&
        log.topics[0] === wethTransferTopic
      ) {
        const amount = BigInt(log.data);
        return parseFloat(formatEther(amount));
      }
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

function isDexAddress(address) {
  return DEX_ADDRESSES.includes(address?.toLowerCase());
}

function calcMcap(ethAmt, ethPrice, tokensInPool, totalSupply) {
  if (tokensInPool <= 0 || ethAmt <= 0) return 'N/A';
  const pricePerToken = (ethAmt * ethPrice) / tokensInPool;
  const mcap = pricePerToken * totalSupply;
  if (isNaN(mcap) || mcap <= 0) return 'N/A';
  return '$' + Math.round(mcap).toLocaleString();
}

export function watchToken(tokenAddress, deployBlock, name, symbol) {
  if (watchedTokens.has(tokenAddress.toLowerCase())) return;

  watchedTokens.set(tokenAddress.toLowerCase(), {
    deployBlock,
    name,
    symbol,
    lpAlerted: false,
    buyAlerted: false,
    lpTokensInPool: 0,
    lpEthAmount: 0,
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

          // Get ETH amount from tx.value first, then fallback to WETH transfer
          const tx = await client.getTransaction({ hash: log.transactionHash });
          let ethAmt = parseFloat(formatEther(tx.value || 0n));
          if (ethAmt < MIN_ETH_BUY) {
            ethAmt = await getWethAmountFromTx(log.transactionHash);
          }

          const totalSupplyRaw = await getTokenSupply(tokenAddress);
          const totalSupply = parseFloat(formatEther(totalSupplyRaw));
          const tokensTransferred = parseFloat(formatEther(log.args.value));

          // LP creation
          if (!state.lpAlerted && (isDexAddress(to) || log.blockNumber <= deployBlock + 3n)) {
            state.lpAlerted = true;
            state.lpTokensInPool = tokensTransferred;
            state.lpEthAmount = ethAmt;

            const mcap = calcMcap(ethAmt, ethPrice, tokensTransferred, totalSupply);
            const usdAmount = (ethAmt * ethPrice).toFixed(2);

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

          // First buy — skip if ETH amount too small
          if (!state.buyAlerted && !isDexAddress(to) && log.blockNumber > deployBlock + 3n) {
            if (ethAmt < MIN_ETH_BUY) {
              console.log('Skipping tiny buy: ' + ethAmt + ' ETH');
              continue;
            }

            state.buyAlerted = true;

            const poolEth = state.lpEthAmount > 0 ? state.lpEthAmount : ethAmt;
            const poolTokens = state.lpTokensInPool > 0 ? state.lpTokensInPool : tokensTransferred;
            const mcap = calcMcap(poolEth, ethPrice, poolTokens, totalSupply);
            const usdAmount = (ethAmt * ethPrice).toFixed(2);

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