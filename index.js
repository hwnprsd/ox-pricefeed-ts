require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const { Pool } = require('pg');
const contractABI = require('./contract-abi.json');
const { setupDatabase } = require('./db');

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
        console.log("Processing swap event")
  try {
    const { tokenIn, tokenOut, amountIn, amountOut } = event.args;
    const block = await event.getBlock();
    const timestamp = block.timestamp;
    
    const poolHash = getPoolHash(tokenIn, tokenOut);
    const pool = await getPoolInfo(tokenIn, tokenOut);
    
    if (!pool) return;
    
    const price = calculatePrice(pool.reserve0, pool.reserve1, tokenIn, tokenOut);
    
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
  if (tokenIn < tokenOut) {
    return reserve0.toString() / reserve1.toString();
  } else {
    return reserve1.toString() / reserve0.toString();
  }
}

async function storePrice(tokenA, tokenB, price, timestamp) {
  const token0 = tokenA < tokenB ? tokenA : tokenB;
  const token1 = tokenA < tokenB ? tokenB : tokenA;
  const pairSymbol = `${token0}_${token1}`;
  
  try {
    await pgPool.query(
      'INSERT INTO price_points(pair, price, timestamp) VALUES($1, $2, to_timestamp($3))',
      [pairSymbol, price, timestamp]
    );
  } catch (error) {
    console.error('Error storing price:', error);
  }
}

async function setupEventListeners() {
  contract.on('Swap', async (user, tokenIn, tokenOut, amountIn, amountOut, event) => {
    const blockNumber = event.blockNumber;
    lastProcessedBlock = blockNumber;
    
    await processSwapEvent(event);
  });
}

async function startServer() {
  try {
    await setupDatabase(pgPool);
    await setupProviders();
    setupEventListeners();
    
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
              last(price, timestamp) AS close,
              count(*) AS volume
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
            c.close,
            c.volume
          FROM series s
          LEFT JOIN candles c ON s.time = c.time
          ORDER BY s.time;
        `;
        
        const result = await pgPool.query(query, [timeGroup, symbol, from, to]);
        
        if (result.rows.length === 0) {
          return res.json({
            s: "no_data",
            nextTime: null
          });
        }
        
        const candles = result.rows;
        
        res.json({
          s: "ok",
          t: candles.map(c => Math.floor(new Date(c.time).getTime() / 1000)),
          o: candles.map(c => parseFloat(c.open)),
          h: candles.map(c => parseFloat(c.high)),
          l: candles.map(c => parseFloat(c.low)),
          c: candles.map(c => parseFloat(c.close)),
          v: candles.map(c => parseInt(c.volume))
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
