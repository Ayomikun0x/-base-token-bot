import { parseAbiItem, formatEther } from 'viem';
import { client, watchToken } from './detector.js';

const ERC20_ABI = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];

// Minimum filters
const MIN_LP_ETH = 0.5;
const MIN_MCAP_USD = 8000;
const MAX_TAX_PERCENT = 5;

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
  // Check if contract bytecode contains mint function signature
  try {
    const bytecode = await client.getBytecode({ address });
    if (!bytecode) return false;
    // mint(address,uint256) selector = 0x40c10f19
    // mint(uint256) selector = 0xa0712d68
    return bytecode.includes('40c10f19') || bytecode.includes('a0712d68');
  } catch {
    return false;
  }
}

async function checkHoneypot(tokenAddress, poolAddress) {
  // Simple honeypot check — try to simulate a sell
  // If transfer to pool fails it's likely a honeypot
  try {
    await client.readContract({
      address: tokenAddress,
      abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
      functionName: 'transfer',
      args: [poolAddress, 1n],
    });
    return false; // not a honeypot
  } catch (e) {
    const msg = e.message?.toLowerCase() || '';
    // If error mentions blacklist/whitelist/forbidden it's a honeypot
    if (msg.includes('blacklist') || msg.includes('forbidden') || msg.includes('not allowed') || msg.includes('whitelist')) {
      return true;
    }
    return false;
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

  // 2. Get total supply and check LP from block receipts
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

  // 3. Check LP ETH — look at transaction value in deploy block
  try {
    const blockData = await client.getBlock({ blockNumber: block.number, includeTransactions: true });
    let maxEthInBlock = 0;
    for (const tx of blockData.transactions) {
      if (tx.value > 0n) {
        const ethVal = parseFloat(formatEther(tx.value));
        if (ethVal > maxEthInBlock) maxEthInBlock = ethVal;
      }
    }

    if (maxEthInBlock < MIN_LP_ETH) {
      console.log('❌ Filtered: LP ETH too low (' + maxEthInBlock.toFixed(3) + ' ETH) - ' + contractAddress);
      return false;
    }

    // 4. Check Mcap estimate
    // Use max ETH in block as rough LP estimate
    const supplyNum = parseFloat(formatEther(totalSupply));
    // Rough token price = LP ETH / (half of supply going to pool estimate)
    const roughMcap = maxEthInBlock * ethPrice * 2; // rough estimate
    if (roughMcap < MIN_MCAP_USD) {
      console.log('❌ Filtered: Mcap too low ($' + Math.round(roughMcap) + ') - ' + contractAddress);
      return false;
    }

  } catch (e) {
    console.log('Filter check error: ' + e.message);
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

          // Run all filters
          const passed = await runFilters(contractAddress, block);
          if (!passed) continue;

          // Start watching for LP and first buy
          watchToken(contractAddress, block.number, name, symbol);

        } catch (err) {
          // silently skip
        }
      }
    },
    includeTransactions: true,
  });
}