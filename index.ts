import express from "express";
import { Pool } from "pg";
import { ethers } from "ethers";
import { abi } from "./contract-abi";
import cors from "cors";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Initialize express app
const app = express();
app.use(cors());
app.use(express.json());

// Contract ABI - replace with your actual ABI

// Initialize Postgres connection
const db = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME || "pricefeed",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "password",
});

// Initialize Ethereum provider and contract
const provider = new ethers.providers.WebSocketProvider(
  process.env.WS_RPC_URL || "ws://localhost:8545",
);
const contractAddress = process.env.ODX_CONTRACT_ADDRESS || "0x...";
const contract = new ethers.Contract(contractAddress, abi, provider);

// Global state
let lastProcessedBlock = 0;

// Initialize database tables
async function initializeDatabase() {
  try {
    // Create tokens table
    await db.query(`
      CREATE TABLE IF NOT EXISTS tokens (
        address TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        decimals INTEGER NOT NULL
      );
    `);

    // Create prices table with TimescaleDB hypertable
    await db.query(`
      CREATE TABLE IF NOT EXISTS prices (
        time TIMESTAMPTZ NOT NULL,
        token_in TEXT NOT NULL,
        token_out TEXT NOT NULL,
        price NUMERIC NOT NULL,
        FOREIGN KEY (token_in) REFERENCES tokens(address),
        FOREIGN KEY (token_out) REFERENCES tokens(address)
      );
    `);

    // Convert to hypertable if not already
    await db.query(`
      SELECT create_hypertable('prices', 'time', if_not_exists => TRUE);
    `);

    console.log("Database initialized successfully");
  } catch (error) {
    console.error("Error initializing database:", error);
    process.exit(1);
  }
}

// Store price in database
async function storePrice(
  tokenIn: string,
  tokenOut: string,
  price: string,
  timestamp: number,
) {
  try {
    const time = new Date(timestamp * 1000).toISOString();

    const parsedPrice = Number(ethers.utils.formatEther(price)).toFixed(3);

    await db.query(
      `INSERT INTO prices (time, token_in, token_out, price)
       VALUES ($1, $2, $3, $4)`,
      [time, tokenIn, tokenOut, parsedPrice],
    );

    console.log(
      `Stored price: ${parsedPrice} for ${tokenIn}/${tokenOut} at ${time}`,
    );
  } catch (error) {
    console.error("Error storing price:", error);
  }
}

// Setup event listener for Swap events
function setupSwapEventListener() {
  console.log("Setting up Swap event listener...");

  // Listen for Swap events
  contract.on(
    "Swap",
    async (user, tokenIn, tokenOut, amountIn, amountOut, event) => {
      console.log(`New Swap event detected at block ${event.blockNumber}`);
      await processSwapEvent(event);
      lastProcessedBlock = event.blockNumber;
    },
  );
}

// Get pool information for the token pair - updated for OdxDex
async function getPoolInfo(tokenIn: string, tokenOut: string) {
  try {
    const poolInfo = await contract.callStatic.getPoolInfo(tokenIn, tokenOut);

    return {
      reserve0: poolInfo[0],
      reserve1: poolInfo[1],
      totalLiquidity: poolInfo[2],
    };
  } catch (error) {
    console.error("Error getting pool info:", error);
    return null;
  }
}

// Calculate price based on reserves - Adjusted for OdxDex's constant product formula
function calculatePrice(
  reserve0: ethers.BigNumber,
  reserve1: ethers.BigNumber,
  tokenIn: string,
  tokenOut: string,
) {
  // Determine which token is which in the pool ordering
  const isToken0In = tokenIn.toLowerCase() < tokenOut.toLowerCase();

  // Use the constant product formula price calculation
  if (isToken0In) {
    // Price of token1 in terms of token0
    return reserve1.mul(ethers.utils.parseEther("1")).div(reserve0);
  } else {
    // Price of token0 in terms of token1
    return reserve0.mul(ethers.utils.parseEther("1")).div(reserve1);
  }
}

// Function to auto-register tokens that don't exist in the database
async function ensureTokenExists(tokenAddress: string) {
  try {
    // Check if token already exists
    const result = await db.query(
      "SELECT address FROM tokens WHERE address = $1",
      [tokenAddress],
    );

    if (result.rows.length === 0) {
      // Token doesn't exist, create an ERC20 interface to get token details
      const tokenContract = new ethers.Contract(
        tokenAddress,
        [
          "function name() view returns (string)",
          "function symbol() view returns (string)",
          "function decimals() view returns (uint8)",
        ],
        provider,
      );

      // Get token details
      const [name, symbol, decimals] = await Promise.all([
        tokenContract.name().catch(() => "Unknown Token"),
        tokenContract.symbol().catch(() => "UNKNOWN"),
        tokenContract.decimals().catch(() => 18),
      ]);

      // Insert token into database
      await db.query(
        `INSERT INTO tokens (address, symbol, name, decimals)
         VALUES ($1, $2, $3, $4)`,
        [tokenAddress, symbol, name, decimals],
      );

      console.log(`Auto-registered new token: ${symbol} (${tokenAddress})`);
    }
  } catch (error) {
    console.error(`Error ensuring token exists for ${tokenAddress}:`, error);
  }
}

// Modified processSwapEvent to auto-register tokens
async function processSwapEvent(event: ethers.Event) {
  try {
    const { user, tokenIn, tokenOut, amountIn, amountOut } = event.args as any;
    const block = await event.getBlock();
    const timestamp = block.timestamp;

    // Ensure both tokens exist in the database
    await Promise.all([
      ensureTokenExists(tokenIn),
      ensureTokenExists(tokenOut),
    ]);

    const pool = await getPoolInfo(tokenIn, tokenOut);
    if (!pool) return;

    const price = calculatePrice(
      pool.reserve0,
      pool.reserve1,
      tokenIn,
      tokenOut,
    );
    console.log("New price", price.toString());

    await storePrice(tokenIn, tokenOut, price.toString(), timestamp);
  } catch (error) {
    console.error("Error processing swap event:", error);
  }
}

// TradingView UDF API endpoints
// Set up routes for TradingView UDF API

// Config endpoint
app.get("/config", (req, res) => {
  res.json({
    supported_resolutions: [
      "1",
      "5",
      "15",
      "30",
      "60",
      "240",
      "1D",
      "1W",
      "1M",
    ],
    supports_group_request: false,
    supports_marks: false,
    supports_search: true,
    supports_timescale_marks: false,
  });
});

// Symbol info endpoint
app.get("/symbols", async (req: any, res: any) => {
  const symbol = req.query.symbol as string;
  const [tokenIn, tokenOut] = symbol.split("/");

  try {
    // Look up token details from database
    const tokenInResult = await db.query(
      "SELECT * FROM tokens WHERE symbol = $1",
      [tokenIn],
    );

    const tokenOutResult = await db.query(
      "SELECT * FROM tokens WHERE symbol = $1",
      [tokenOut],
    );

    if (tokenInResult.rows.length === 0 || tokenOutResult.rows.length === 0) {
      return res.status(404).json({ s: "error", errmsg: "Symbol not found" });
    }

    res.json({
      name: `${tokenIn}/${tokenOut}`,
      ticker: symbol,
      description: `${tokenInResult.rows[0].name}/${tokenOutResult.rows[0].name}`,
      type: "crypto",
      session: "24x7",
      timezone: "Etc/UTC",
      exchange: "DEX",
      minmov: 1,
      pricescale: 100000000, // Adjust based on your decimal precision
      has_intraday: true,
      supported_resolutions: [
        "1",
        "5",
        "15",
        "30",
        "60",
        "240",
        "1D",
        "1W",
        "1M",
      ],
      volume_precision: 8,
      data_status: "streaming",
    });
  } catch (error) {
    console.error("Error in symbols endpoint:", error);
    res.status(500).json({ s: "error", errmsg: "Internal server error" });
  }
});

// Symbol search endpoint
app.get("/search", async (req, res) => {
  const query = req.query.query as string;
  const limit = parseInt(req.query.limit as string) || 30;

  try {
    const result = await db.query(
      `SELECT DISTINCT t1.symbol as base, t2.symbol as quote
       FROM tokens t1
       JOIN tokens t2 ON t1.address != t2.address
       WHERE t1.symbol ILIKE $1 OR t2.symbol ILIKE $1 OR t1.name ILIKE $1 OR t2.name ILIKE $1
       LIMIT $2`,
      [`%${query}%`, limit],
    );

    const symbols = result.rows.map((row: any) => ({
      symbol: `${row.base}/${row.quote}`,
      full_name: `${row.base}/${row.quote}`,
      description: `${row.base}/${row.quote} pair`,
      exchange: "DEX",
      type: "crypto",
    }));

    res.json(symbols);
  } catch (error) {
    console.error("Error in search endpoint:", error);
    res.status(500).json({ s: "error", errmsg: "Internal server error" });
  }
});

// History endpoint
app.get("/history", async (req: any, res: any) => {
  const symbol = req.query.symbol as string;
  const from = parseInt(req.query.from as string);
  const to = parseInt(req.query.to as string);
  const resolution = req.query.resolution as string;

  try {
    const [tokenIn, tokenOut] = symbol.split("/");

    // Get token addresses
    const tokenInResult = await db.query(
      "SELECT address FROM tokens WHERE symbol = $1",
      [tokenIn],
    );

    const tokenOutResult = await db.query(
      "SELECT address FROM tokens WHERE symbol = $1",
      [tokenOut],
    );

    if (tokenInResult.rows.length === 0 || tokenOutResult.rows.length === 0) {
      return res.status(404).json({ s: "error", errmsg: "Symbol not found" });
    }

    const tokenInAddress = tokenInResult.rows[0].address;
    const tokenOutAddress = tokenOutResult.rows[0].address;

    // Convert resolution to interval
    let interval = "1m";
    switch (resolution) {
      case "1":
        interval = "1m";
        break;
      case "5":
        interval = "5m";
        break;
      case "15":
        interval = "15m";
        break;
      case "30":
        interval = "30m";
        break;
      case "60":
        interval = "1h";
        break;
      case "240":
        interval = "4h";
        break;
      case "1D":
        interval = "1d";
        break;
      case "1W":
        interval = "1w";
        break;
      case "1M":
        interval = "1M";
        break;
      default:
        interval = "1h";
    }

    // Query the database for OHLCV data
    const result = await db.query(
      `SELECT 
        time_bucket($1, time) AS bucket,
        FIRST(price, time) AS open,
        MAX(price) AS high,
        MIN(price) AS low,
        LAST(price, time) AS close
      FROM prices
      WHERE token_in = $2 AND token_out = $3
        AND time >= to_timestamp($4) AND time <= to_timestamp($5)
      GROUP BY bucket
      ORDER BY bucket ASC`,
      [interval, tokenInAddress, tokenOutAddress, from, to],
    );

    // Format the response
    const t = result.rows.map((row: any) =>
      Math.floor(new Date(row.bucket).getTime() / 1000),
    );
    const o = result.rows.map((row: any) => parseFloat(row.open));
    const h = result.rows.map((row: any) => parseFloat(row.high));
    const l = result.rows.map((row: any) => parseFloat(row.low));
    const c = result.rows.map((row: any) => parseFloat(row.close));

    res.json({
      s: "ok",
      t,
      o,
      h,
      l,
      c,
    });
  } catch (error) {
    console.error("Error in history endpoint:", error);
    res.status(500).json({ s: "error", errmsg: "Internal server error" });
  }
});

// Token management endpoint - to add new tokens
app.post("/tokens", async (req: any, res: any) => {
  const { address, symbol, name, decimals } = req.body;

  if (!address || !symbol || !name || decimals === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    await db.query(
      `INSERT INTO tokens (address, symbol, name, decimals)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (address) DO UPDATE
       SET symbol = $2, name = $3, decimals = $4`,
      [address, symbol, name, decimals],
    );

    res.json({ success: true, message: "Token added/updated" });
  } catch (error) {
    console.error("Error adding token:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Start the server
async function start() {
  try {
    // Initialize database
    await initializeDatabase();

    // Set up event listener
    setupSwapEventListener();

    // Start express server
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Price feed server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

// Start the server
start();
