async function pollNewPairs() {
  try {
    const url = `${BASESCAN_API}?module=logs&action=getLogs&address=${UNISWAP_V2_FACTORY}&topic0=0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9&page=1&offset=10&sort=desc&apikey=${BASESCAN_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!data.result || data.result.length === 0) return;

    for (const log of data.result) {
      const pair = '0x' + log.topics[3].slice(26);
      if (processedPairs.has(pair)) continue;
      processedPairs.add(pair);

      const token0 = '0x' + log.topics[1].slice(26);
      const token1 = '0x' + log.topics[2].slice(26);
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
