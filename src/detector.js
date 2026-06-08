import { createPublicClient, webSocket, parseAbiItem, formatEther } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { sendAlert, sendRugAlert } from './telegram.js';
import { autoBuy, emergencySell } from './trader.js';

const watchedTokens = new Map();
const watchedPools = new Map();

const LP_LOCK_CONTRACTS = [
  '0x231278ded31593e3ad0f895d279525144b58206d',
  '0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe',
  '0xdae1a0fb2d8b1f664d7e3ee5ef8b70cfce7ac7ee',
].map(a => a.toLowerCase());

const DEAD_ADDRESSES = [
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000000',
].map(a => a.toLowerCase());

const DEX_ADDRESSES = [
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
  '0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
  '0x2626664c2603336e57b271c5c0b26f421741e481',
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
  '0x498581ff718922c3f8e6a244956af099b2652b2b',
  '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
  '0x6ff5693b99212da76ad316178a184ab56d299b43',
].map(a => a.toLowerCase());

const WETH = '0x4200000000000000000000000000000000000006';
const BASESCAN_API = 'https://api.etherscan.io/v2/api';
const IS_TESTNET = process.env.RPC_URL?.includes('sepolia');

export const client = createPublicClient({
  chain: IS_TESTNET ? baseSepolia : base,
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

async function getHolderCount(tokenAddress) {
  try {
    const apiKey = process.env.BASESCAN_API_KEY;
    const url = `${BASESCAN_API}?chainid=8453&module=account&action=tokentx&contractaddress=${tokenAddress}&page=1&offset=100&sort=asc&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === '1' && data.result?.length > 0) {
      const uniqueAddresses = new Set(data.result.map(tx => tx.to.toLowerCase()));
      return uniqueAddresses.size.toString();
    }
    return '1';
  } catch (e) { return '—'; }
}

async function getEthAmountFromTx(txHash) {
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    const tx = await client.getTransaction({ hash: txHash });

    let ethAmt = parseFloat(formatEther(tx.value || 0n));
    if (ethAmt >= 0.001) return ethAmt;

    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    let maxWeth = 0;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === WETH.toLowerCase() && log.topics[0] === transferTopic) {
        const amt = parseFloat(formatEther(BigInt(log.data)));
        if (amt > maxWeth) maxWeth = amt;
      }
    }
    if (maxWeth >= 0.001) return maxWeth;

    try {
      const apiKey = process.env.BASESCAN_API_KEY;
      const url = `${BASESCAN_API}?chainid=8453&module=account&action=txlistinternal&txhash=${txHash}&apikey=${apiKey}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.status === '1' && data.result?.length > 0) {
        let maxInternal = 0;
        for (const itx of data.result) {
          const val = parseFloat(formatEther(BigInt(itx.value || '0')));
          if (val > maxInternal) maxInternal = val;
        }
        if (maxInternal >= 0.001) return maxInternal;
      }
    } catch (e) { }

    return 0;
  } catch (e) { return 0; }
}

async function checkLpStatus(txHash, deployerAddress) {
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

    for (const log of receipt.logs) {
      if (log.topics[0] !== transferTopic) continue;
      if (log.topics.length < 3) continue;

      const from = '0x' + log.topics[1].slice(26).toLowerCase();
      const to = '0x' + log.topics[2].slice(26).toLowerCase();

      if (log.address.toLowerCase() === deployerAddress?.toLowerCase()) continue;

      if (from === '0x0000000000000000000000000000000000000000') {
        if (DEAD_ADDRESSES.includes(to)) return '🔥 LP Burned';
        if (LP_LOCK_CONTRACTS.includes(to)) return '🔒 LP Locked';
        if (to === deployerAddress?.toLowerCase()) return '🚨 Dev Holds LP — High Rug Risk!';
        return '⚠️ LP Not Locked';
      }
    }
    return '⚠️ LP Not Locked';
  } catch (e) {
    return '⚠️ LP Status Unknown';
  }
}

function isDexAddress(address) {
  return DEX_ADDRESSES.includes(address?.toLowerCase());
}

function calcMcap(ethInPool, ethPrice, tokensInPool, totalSupply) {
  if (tokensInPool <= 0 || ethInPool <= 0 || totalSupply <= 0) return 'N/A';
  const pricePerToken = (ethInPool * ethPrice) / tokensInPool;
  const mcap = pricePerToken * totalSupply;
  if (isNaN(mcap) || mcap <= 0) return 'N/A';
  return '$' + Math.round(mcap).toLocaleString();
}

async function findPoolAddress(tokenAddress, txHash) {
  try {
    const receipt = await client.getTransactionReceipt({ hash: txHash });

    const syncTopic = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
    for (const log of receipt.logs) {
      if (log.topics[0] === syncTopic) {
        return { address: log.address, version: 'v2' };
      }
    }

    const v4InitTopic = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
    for (const log of receipt.logs) {
      if (log.topics[0] === v4InitTopic) {
        return { address: '0x498581ff718922c3f8e6a244956af099b2652b2b', version: 'v4', poolId: log.topics[1] };
      }
    }

    return null;
  } catch (e) { return null; }
}

function watchPoolForRug(tokenAddress, tokenName, tokenSymbol, poolInfo, initialEthReserve) {
  if (!poolInfo) return;

  const poolKey = poolInfo.address.toLowerCase();
  if (watchedPools.has(poolKey)) return;

  console.log('👁️ Watching pool for rug: ' + poolInfo.address);

  let unwatch;

  if (poolInfo.version === 'v2') {
    unwatch = client.watchEvent({
      address: poolInfo.address,
      event: parseAbiItem('event Burn(address indexed sender, uint amount0, uint amount1, address indexed to)'),
      onLogs: async (logs) => {
        for (const log of logs) {
          const amount0 = parseFloat(formatEther(BigInt(log.args.amount0 || 0)));
          const amount1 = parseFloat(formatEther(BigInt(log.args.amount1 || 0)));
          const ethRemoved = Math.max(amount0, amount1);

          if (initialEthReserve > 0 && ethRemoved < initialEthReserve * 0.05) continue;

          console.log('🔴 RUG DETECTED for ' + tokenAddress);

          await sendRugAlert({
            tokenAddress, tokenName, tokenSymbol,
            txHash: log.transactionHash,
            stage: 'removing',
            ethRemoved: ethRemoved.toFixed(4),
          });

          // Emergency sell
          await emergencySell(tokenAddress, tokenName, tokenSymbol);

          setTimeout(async () => {
            await sendRugAlert({
              tokenAddress, tokenName, tokenSymbol,
              txHash: log.transactionHash,
              stage: 'removed',
              ethRemoved: ethRemoved.toFixed(4),
            });
          }, 30000);

          watchedPools.get(poolKey)?.();
          watchedPools.delete(poolKey);
        }
      },
    });
  } else if (poolInfo.version === 'v4') {
    unwatch = client.watchEvent({
      address: poolInfo.address,
      event: parseAbiItem('event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)'),
      onLogs: async (logs) => {
        for (const log of logs) {
          if (poolInfo.poolId && log.topics[1] !== poolInfo.poolId) continue;
          const delta = BigInt(log.args.liquidityDelta || 0);
          if (delta >= 0n) continue;

          console.log('🔴 V4 RUG DETECTED for ' + tokenAddress);

          await sendRugAlert({
            tokenAddress, tokenName, tokenSymbol,
            txHash: log.transactionHash,
            stage: 'removing',
            ethRemoved: 'Unknown',
          });

          await emergencySell(tokenAddress, tokenName, tokenSymbol);

          setTimeout(async () => {
            await sendRugAlert({
              tokenAddress, tokenName, tokenSymbol,
              txHash: log.transactionHash,
              stage: 'removed',
              ethRemoved: 'Unknown',
            });
          }, 30000);

          watchedPools.get(poolKey)?.();
          watchedPools.delete(poolKey);
        }
      },
    });
  }

  if (unwatch) {
    watchedPools.set(poolKey, unwatch);
    setTimeout(() => {
      if (watchedPools.has(poolKey)) {
        watchedPools.get(poolKey)?.();
        watchedPools.delete(poolKey);
      }
    }, 24 * 60 * 60 * 1000);
  }
}

export function watchToken(tokenAddress, deployBlock, name, symbol) {
  if (watchedTokens.has(tokenAddress.toLowerCase())) return;

  watchedTokens.set(tokenAddress.toLowerCase(), {
    deployBlock, name, symbol,
    lpAlerted: false, buyAlerted: false,
    lpTokensInPool: 0, lpEthAmount: 0,
    poolInfo: null, deployerAddress: null,
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
          const ethAmt = await getEthAmountFromTx(log.transactionHash);
          const totalSupplyRaw = await getTokenSupply(tokenAddress);
          const totalSupply = parseFloat(formatEther(totalSupplyRaw));
          const tokensTransferred = parseFloat(formatEther(log.args.value));

          // LP creation
          if (!state.lpAlerted && (isDexAddress(to) || log.blockNumber <= deployBlock + 3n)) {
            state.lpAlerted = true;
            state.lpTokensInPool = tokensTransferred;
            state.lpEthAmount = ethAmt;
            state.deployerAddress = from;

            const poolInfo = await findPoolAddress(tokenAddress, log.transactionHash);
            state.poolInfo = poolInfo;

            const mcap = calcMcap(ethAmt, ethPrice, tokensTransferred, totalSupply);
            const usdAmount = (ethAmt * ethPrice).toFixed(2);
            const lpStatus = await checkLpStatus(log.transactionHash, from);
            const holders = await getHolderCount(tokenAddress);

            await sendAlert({
              type: 'LP', tokenAddress,
              tokenName: state.name || 'Unknown',
              tokenSymbol: state.symbol || '???',
              walletAddress: from,
              ethAmount: ethAmt.toFixed(4),
              usdAmount, mcap, lpStatus, holders,
              txHash: log.transactionHash,
            });

            if (poolInfo) watchPoolForRug(tokenAddress, state.name, state.symbol, poolInfo, ethAmt);
            continue;
          }

          // First buy
          if (!state.buyAlerted && !isDexAddress(to) && log.blockNumber > deployBlock + 3n) {
            if (ethAmt < 0.001) continue;

            state.buyAlerted = true;

            const poolEth = state.lpEthAmount > 0 ? state.lpEthAmount : ethAmt;
            const poolTokens = state.lpTokensInPool > 0 ? state.lpTokensInPool : tokensTransferred;
            const mcap = calcMcap(poolEth, ethPrice, poolTokens, totalSupply);
            const usdAmount = (ethAmt * ethPrice).toFixed(2);
            const lpStatus = await checkLpStatus(log.transactionHash, state.deployerAddress);
            const holders = await getHolderCount(tokenAddress);

            await sendAlert({
              type: 'BUY', tokenAddress,
              tokenName: state.name || 'Unknown',
              tokenSymbol: state.symbol || '???',
              walletAddress: to,
              ethAmount: ethAmt.toFixed(4),
              usdAmount, mcap, lpStatus, holders,
              txHash: log.transactionHash,
            });

            // Auto buy
            await autoBuy(tokenAddress, state.name || 'Unknown', state.symbol || '???');
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