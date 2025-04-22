async function setupDatabase(pgPool) {
  try {
    await pgPool.query(`
      CREATE EXTENSION IF NOT EXISTS timescaledb;
    `);
    
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS price_points (
        pair TEXT NOT NULL,
        price NUMERIC NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL
      );
    `);
    
    await pgPool.query(`
      SELECT create_hypertable('price_points', 'timestamp', if_not_exists => TRUE);
    `);
    
    await pgPool.query(`
      CREATE INDEX IF NOT EXISTS idx_price_points_pair ON price_points (pair);
    `);
    
    console.log('Database setup complete');
  } catch (error) {
    console.error('Database setup error:', error);
    throw error;
  }
}

module.exports = { setupDatabase };
