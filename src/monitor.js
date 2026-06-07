import { parseAbiItem, formatEther } from 'viem';
import { client, watchToken } from './detector.js';

const ERC20_ABI = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

const MIN_LP_ETH = 0.1;
const MIN_MCAP_USD = 8000;

async function getEthPrice() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT');
    const data = await res.json();
    return parseFloat(data.price);
  } catch (e) {
    try {
      const res = await fetch('https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD');
      const data = await res.json();
      return parseFloat(data.USD);
    } catch (e2) {
      return 2500;
    }
  }
}

async function getTokenMeta(address) {
  try {
    const [name, symbol] = await Promise.all([
      client.readContract({ address, abi: ERC20_ABI, functionName: 'name' }),
      client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }),
    ]);
    return { name, symbol };
  } catch {
    return { name: 'Unknown', symbol: '???' };
  }
}

async function checkMintFunction(address) {
  try {
    const bytecode = await client.getBytecode({ address });
    if (!bytecode) return false;
    return bytecode.includes('40c10f19') || bytecode.includes('a0712d68');
  } catch {
    return false;
  }
}

async function getMaxEthInBlock(blockNumber) {
  try {
    const blockData = await client.getBlock({ blockNumber, includeTransactions: true });
    const WETH = '0x4200000000000000000000000000000000000006';
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

    // Check tx.value first
    let maxEth = 0;
    for (const tx of blockData.transactions) {
      if (tx.value > 0n) {
        const val = parseFloat(formatEther(tx.value));
        if (val > maxEth) maxEth = val;
      }
    }
    if (maxEth >= MIN_LP_ETH) return maxEth;

    // Check WETH transfers in block receipts
    try {
      const receipts = await Promise.all(
        blockData.transactions.slice(0, 20).map(tx =>
          client.getTransactionReceipt({ hash: tx.hash }).catch(() => null)
        )
      );
      for (const receipt of receipts) {
        if (!receipt) continue;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() === WETH.toLowerCase() && log.topics[0] === transferTopic) {
            const amt = parseFloat(formatEther(BigInt(log.data)));
            if (amt > maxEth) maxEth = amt;
          }
        }
      }
    } catch (e) { }

    return maxEth;
  } catch (e) {
    return 0;
  }
}

async function runFilters(contractAddress, block) {
  console.log('Running filters for: ' + contractAddress);

  const ethPrice = await getEthPrice();

  // 1. Check mint function
  const hasMint = await checkMintFunction(contractAddress);
  if (hasMint) {
    console.log('❌ Filtered: has mint function - ' + contractAddress);
    return false;
  }

  // 2. Get total supply
  let totalSupply = 0n;
  try {
    totalSupply = await client.readContract({
      address: contractAddress,
      abi: [{ name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
      functionName: 'totalSupply',
    });
  } catch (e) {
    console.log('❌ Filtered: cant read supply - ' + contractAddress);
    return false;
  }

  // 3. Check LP ETH in deploy block
  const maxEth = await getMaxEthInBlock(block.number);

  if (maxEth < MIN_LP_ETH) {
    console.log('❌ Filtered: LP ETH too low (' + maxEth.toFixed(3) + ' ETH) - ' + contractAddress);
    return false;
  }

  // 4. Check rough Mcap
  const roughMcap = maxEth * ethPrice * 2;
  if (roughMcap < MIN_MCAP_USD) {
    console.log('❌ Filtered: Mcap too low ($' + Math.round(roughMcap) + ') - ' + contractAddress);
    return false;
  }

  console.log('✅ Passed filters: ' + contractAddress);
  return true;
}

export function startMonitor() {
  console.log('🔍 Monitoring Base for new token deployments...');

  client.watchBlocks({
    onBlock: async (block) => {
      if (!block.transactions?.length) return;

      for (const tx of block.transactions) {
        if (tx.to !== null) continue;

        try {
          const receipt = await client.getTransactionReceipt({ hash: tx.hash });
          if (!receipt.contractAddress) continue;

          const contractAddress = receipt.contractAddress;

          const hasTransfer = receipt.logs.some(
            log => log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
          );
          if (!hasTransfer) continue;

          const { name, symbol } = await getTokenMeta(contractAddress);
          console.log('🆕 New ERC-20: ' + name + ' (' + symbol + ') at ' + contractAddress);

          const passed = await runFilters(contractAddress, block);
          if (!passed) continue;

          watchToken(contractAddress, block.number, name, symbol);

        } catch (err) {
          // silently skip
        }
      }
    },
    includeTransactions: true,
  });
}