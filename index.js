require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { Pool } = require('pg');
const contractABI = require('./contract-abi.json');
const { setupDatabase } = require('./db');
const { finalization } = require('process');

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 3000;
const contractAddress = process.env.ODX_CONTRACT_ADDRESS;

const pgPool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD
});

let wsProvider;
let httpProvider;
let contract;
let lastProcessedBlock = 0;

async function setupProviders() {
  wsProvider = new ethers.providers.WebSocketProvider(process.env.WS_RPC_URL);
  httpProvider = new ethers.providers.JsonRpcProvider(process.env.HTTP_RPC_URL);
  contract = new ethers.Contract(contractAddress, contractABI, wsProvider);
  
  wsProvider._websocket.on('close', async () => {
    console.log('WebSocket connection closed, reconnecting...');
    await reconnectWebSocket();
  });

  wsProvider._websocket.on('error', async () => {
    console.log('WebSocket connection errored, reconnecting...');
    await reconnectWebSocket();
  });
}

async function reconnectWebSocket() {
  try {
    await setupProviders();
    const currentBlock = await httpProvider.getBlockNumber();
    
    if (lastProcessedBlock > 0 && currentBlock > lastProcessedBlock) {
      await backfillEvents(lastProcessedBlock + 1, currentBlock);
    }
    
    setupEventListeners();
  } catch (error) {
    console.error('Failed to reconnect:', error);
    setTimeout(reconnectWebSocket, 5000);
  }
}

async function backfillEvents(fromBlock, toBlock) {
  try {
    console.log(`Backfilling events from ${fromBlock} to ${toBlock}`);
    
    const swapEvents = await contract.connect(httpProvider).queryFilter('Swap', fromBlock, toBlock);
    for (const event of swapEvents) {
      await processSwapEvent(event);
    }
    
    lastProcessedBlock = toBlock;
  } catch (error) {
    console.error('Backfill error:', error);
  }
}

async function processSwapEvent(event) {
  try {
    const { tokenIn, tokenOut, amountIn, amountOut } = event.args;
    const block = await event.getBlock();
    const timestamp = block.timestamp;
    
    const pool = await getPoolInfo(tokenIn, tokenOut);
    if (!pool) return;
    
    const price = calculatePrice(pool.reserve0, pool.reserve1, tokenIn, tokenOut);
                console.log("new price", price)
    
    
    await storePrice(tokenIn, tokenOut, price, timestamp);
  } catch (error) {
    console.error('Error processing swap event:', error);
  }
}

function getPoolHash(tokenA, tokenB) {
  const token0 = tokenA < tokenB ? tokenA : tokenB;
  const token1 = tokenA < tokenB ? tokenB : tokenA;
  return ethers.utils.keccak256(ethers.utils.solidityPack(['address', 'address'], [token0, token1]));
}

async function getPoolInfo(tokenA, tokenB) {
  try {
    const result = await contract.getPoolInfo(tokenA, tokenB);
    return {
      reserve0: result[0],
      reserve1: result[1],
      totalLiquidity: result[2]
    };
  } catch (error) {
    console.error('Error getting pool info:', error);
    return null;
  }
}

function calculatePrice(reserve0, reserve1, tokenIn, tokenOut) {
  // Use BigNumber or similar for precision
  const res0 = ethers.BigNumber.from(reserve0);
  const res1 = ethers.BigNumber.from(reserve1);
  
  try {
    if (tokenIn < tokenOut) {
      return parseFloat(ethers.utils.formatUnits(
        res0.mul(ethers.constants.WeiPerEther).div(res1)
      ));
    } else {
      return parseFloat(ethers.utils.formatUnits(
        res1.mul(ethers.constants.WeiPerEther).div(res0)
      ));
    }
  } catch (error) {
    console.error('Price calculation error:', error);
    return 0;
  }
}

async function storePrice(tokenA, tokenB, price, timestamp) {
  const token0 = tokenA < tokenB ? tokenA : tokenB;
  const token1 = tokenA < tokenB ? tokenB : tokenA;
  const pairSymbol = `${token0}_${token1}`;

  const finalPrice = tokenA === token0 ? price : 1 / price;
  console.log("finalPrice", finalPrice);
  
  try {
    await pgPool.query(
      'INSERT INTO price_points(pair, price, timestamp) VALUES($1, $2, to_timestamp($3))',
      [pairSymbol, finalPrice, timestamp]
    );
  } catch (error) {
    console.error('Error storing price:', error);
  }
}


function setupSwapEventListener() {
  console.log('Setting up Swap event listener...');
  
  // Listen for Swap events
  contract.on('Swap', async (user, tokenIn, tokenOut, amountIn, amountOut, event) => {
    console.log(`New Swap event detected at block ${event.blockNumber}`);
    await processSwapEvent(event);
    lastProcessedBlock = event.blockNumber;
  });
}

function formatNumber(num) {
  // Convert to string, limit decimal places to avoid big.js errors
        if (!num) {
                return num
        }
  return parseFloat(num.toFixed(8));
}

async function startServer() {
  try {
    await setupDatabase(pgPool);
    await setupProviders();
    setupSwapEventListener()
    
    app.get('/config', (req, res) => {
      res.json({
        supported_resolutions: ["1", "5", "15", "30", "60", "240", "D", "W"],
        supports_time: true,
        supports_search: true,
        supports_group_request: false
      });
    });
    
    app.get('/symbols', async (req, res) => {
      try {
        const symbol = req.query.symbol;
        const [token0, token1] = symbol.split('_');
        
        res.json({
          name: symbol,
          ticker: symbol,
          description: `${token0}/${token1} Pair`,
          type: "crypto",
          session: "24x7",
          timezone: "Etc/UTC",
          supported_resolutions: ["1", "5", "15", "30", "60", "240", "D", "W"],
          has_intraday: true,
          has_daily: true,
          has_weekly_and_monthly: true
        });
      } catch (error) {
        res.status(404).json({ s: "error", errmsg: "Symbol not found" });
      }
    });
    
    app.get('/search', async (req, res) => {
      try {
        const result = await pgPool.query(
          'SELECT DISTINCT pair FROM price_points'
        );
        
        const symbols = result.rows.map(row => ({
          symbol: row.pair,
          full_name: row.pair,
          description: row.pair.replace('_', '/'),
          exchange: 'ODX',
          type: 'crypto'
        }));
        
        res.json(symbols);
      } catch (error) {
        res.status(500).json({ error: 'Failed to search symbols' });
      }
    });
    
        app.get('/history', async (req, res) => {
          try {
            const { symbol, resolution, from, to } = req.query;

            // Check if there's any data for this symbol at all
            const dataCheck = await pgPool.query(
              'SELECT COUNT(*) FROM price_points WHERE pair = $1',
              [symbol]
            );

            if (parseInt(dataCheck.rows[0].count) === 0) {
              return res.json({
                s: "no_data"
              });
            }

            // Get the last known price before the requested period
            const historicalCheck = await pgPool.query(
              'SELECT price FROM price_points WHERE pair = $1 AND timestamp <= to_timestamp($2) ORDER BY timestamp DESC LIMIT 1',
              [symbol, from]
            );

            let timeGroup;
            switch(resolution) {
              case '1': timeGroup = '1 minute'; break;
              case '5': timeGroup = '5 minutes'; break;
              case '15': timeGroup = '15 minutes'; break;
              case '30': timeGroup = '30 minutes'; break;
              case '60': timeGroup = '1 hour'; break;
              case '240': timeGroup = '4 hours'; break;
              case 'D': timeGroup = '1 day'; break;
              case 'W': timeGroup = '1 week'; break;
              default: timeGroup = '1 hour';
            }

            // Query to get data for the requested period
            const query = `
              WITH series AS (
                SELECT generate_series(
                  date_trunc('minute', to_timestamp($3))::timestamp,
                  date_trunc('minute', to_timestamp($4))::timestamp,
                  $1::interval
                ) AS time
              ),
              candles AS (
                SELECT 
                  time_bucket($1, timestamp) AS time,
                  first(price, timestamp) AS open,
                  max(price) AS high,
                  min(price) AS low,
                  last(price, timestamp) AS close
                FROM price_points
                WHERE pair = $2
                  AND timestamp >= to_timestamp($3)
                  AND timestamp <= to_timestamp($4)
                GROUP BY time
              )
              SELECT 
                s.time,
                c.open,
                c.high,
                c.low,
                c.close
              FROM series s
              LEFT JOIN candles c ON s.time = c.time
              ORDER BY s.time;
            `;

            const result = await pgPool.query(query, [timeGroup, symbol, from, to]);

            // No data in the requested time period, check if we have historical data
            if (result.rows.length === 0 || result.rows.every(row => row.open === null)) {
              if (historicalCheck.rows.length === 0) {
                return res.json({
                  s: "no_data"
                });
              } else {
                // We have historical data, use it for the missing periods
                const lastKnownPrice = parseFloat(historicalCheck.rows[0].price);

                // Create timeframes based on the resolution
                const timestamps = [];
                let interval = 60; // Default 1 minute in seconds

                switch(resolution) {
                  case '1': interval = 60; break;
                  case '5': interval = 300; break;
                  case '15': interval = 900; break;
                  case '30': interval = 1800; break;
                  case '60': interval = 3600; break; 
                  case '240': interval = 14400; break;
                  case 'D': interval = 86400; break;
                  case 'W': interval = 604800; break;
                }

                let currentTime = Math.floor(parseInt(from) / interval) * interval;
                const endTime = Math.ceil(parseInt(to) / interval) * interval;

                while (currentTime <= endTime) {
                  timestamps.push(currentTime);
                  currentTime += interval;
                }

                return res.json({
                  s: "ok",
                  t: timestamps,
                  o: timestamps.map(() => formatNumber(lastKnownPrice)),
                  h: timestamps.map(() => formatNumber(lastKnownPrice)),
                  l: timestamps.map(() => formatNumber(lastKnownPrice)),
                  c: timestamps.map(() => formatNumber(lastKnownPrice)),
                  v: timestamps.map(() => 0.1) // Minimal placeholder volume
                });
              }
            }

            // Process the result when we have some data for the period
            const lastKnownPrice = historicalCheck.rows.length > 0 
              ? parseFloat(historicalCheck.rows[0].price) 
              : null;

            // Fill in missing values with the last known price
            let lastPrice = lastKnownPrice;
            const candles = result.rows.map(row => {
              if (row.close !== null) {
                lastPrice = parseFloat(row.close);
                return {
                  time: row.time,
                  open: parseFloat(row.open),
                  high: parseFloat(row.high),
                  low: parseFloat(row.low),
                  close: parseFloat(row.close)
                };
              } else {
                return {
                  time: row.time,
                  open: lastPrice,
                  high: lastPrice,
                  low: lastPrice,
                  close: lastPrice
                };
              }
            });

            res.json({
              s: "ok",
              t: candles.map(c => Math.floor(new Date(c.time).getTime() / 1000)),
              o: candles.map(c => formatNumber(c.open)),
              h: candles.map(c => formatNumber(c.high)),
              l: candles.map(c => formatNumber(c.low)),
              c: candles.map(c => formatNumber(c.close)),
              v: candles.map(() => 10000) // Minimal placeholder volume
            });

          } catch (error) {
            console.error('History error:', error);
            res.status(500).json({ s: "error", errmsg: "Internal error" });
          }
        });
    
    app.listen(port, () => {
      console.log(`Pricefeed server running on port ${port}`);
    });
  } catch (error) {
    console.error('Server startup error:', error);
  }
}

startServer();
