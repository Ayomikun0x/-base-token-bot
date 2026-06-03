import { parseAbiItem, formatEther } from 'viem';
import { client, watchToken } from './detector.js';

const ERC20_ABI = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

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
          console.log(`🆕 New ERC-20 deployed: ${name} (${symbol}) at ${contractAddress}`);

          watchToken(contractAddress, block.number, name, symbol);

        } catch (err) {
          // silently skip failed receipts
        }
      }
    },
    includeTransactions: true,
  });
} 
