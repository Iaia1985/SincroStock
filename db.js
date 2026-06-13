// db.js
// Conexion a la base de datos Postgres (Railway la provee automaticamente
// a traves de la variable de entorno DATABASE_URL) y creacion de las
// tablas que necesitamos si todavia no existen.

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  // Tabla 1: tiendas conectadas
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stores (
      id SERIAL PRIMARY KEY,
      store_id TEXT UNIQUE NOT NULL,
      name TEXT,
      access_token TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Tabla 2: catalogo maestro (SKUs del deposito central)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS master_skus (
      id SERIAL PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      threshold INTEGER NOT NULL DEFAULT 5,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Tabla 3: mapeo SKU <-> tienda <-> producto/variante
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sku_mapping (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL REFERENCES master_skus(sku) ON DELETE CASCADE,
      store_id TEXT NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      UNIQUE (sku, store_id)
    );
  `);

  console.log("Base de datos lista (tablas verificadas/creadas).");
}

module.exports = { pool, initDb };
