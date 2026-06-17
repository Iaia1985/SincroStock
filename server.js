const express = require("express");
const { pool, initDb } = require("./db");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const { TN_CLIENT_ID, TN_CLIENT_SECRET, APP_URL, MASTER_STORE_ID } = process.env;
const USER_AGENT = "StockSync (contacto@example.com)";

app.get("/connect", (req, res) => {
 res.redirect("https://www.tiendanube.com/apps/" + TN_CLIENT_ID + "/authorize");
});

app.get("/auth/callback", async (req, res) => {
 const { code } = req.query;
 if (!code) return res.status(400).send("Falta el parametro code.");
 try {
   const tokenResp = await fetch("https://www.tiendanube.com/apps/authorize/token", {
     method: "POST",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ client_id: TN_CLIENT_ID, client_secret: TN_CLIENT_SECRET, grant_type: "authorization_code", code }),
   });
   const tokenData = await tokenResp.json();
   if (!tokenData.access_token) return res.status(400).send("No se pudo obtener el token.");
   const storeId = String(tokenData.user_id);
   const accessToken = tokenData.access_token;
   let storeName = "Tienda " + storeId;
   try {
     const infoResp = await fetch("https://api.tiendanube.com/2025-03/" + storeId + "/store", {
       headers: { Authentication: "bearer " + accessToken, "User-Agent": USER_AGENT },
     });
     const info = await infoResp.json();
     storeName = info?.name?.es || info?.name?.pt || storeName;
   } catch (e) {}
   await pool.query(
     "INSERT INTO stores (store_id, name, access_token) VALUES ($1, $2, $3) ON CONFLICT (store_id) DO UPDATE SET access_token = $3, name = $2",
     [storeId, storeName, accessToken]
   );
   try {
     await fetch("https://api.tiendanube.com/2025-03/" + storeId + "/webhooks", {
       method: "POST",
       headers: { Authentication: "bearer " + accessToken, "Content-Type": "application/json", "User-Agent": USER_AGENT },
       body: JSON.stringify({ event: "order/paid", url: APP_URL + "/webhooks/order-paid" }),
     });
   } catch (e) {}
   const isMaster = storeId === MASTER_STORE_ID;
   res.send("<h1>Tienda conectada: " + storeName + " " + (isMaster ? "(TIENDA MAESTRA) " : "") + "</h1><p>ID: " + storeId + "</p><p><a href='/'>Ir al panel</a></p>");
 } catch (err) {
   console.error(err);
   res.status(500).send("Error conectando la tienda.");
 }
});

app.post("/webhooks/order-paid", async (req, res) => {
 res.sendStatus(200);
 const { store_id, id: orderId } = req.body || {};
 if (!store_id || !orderId) return;
 try { await syncFromOrder(String(store_id), orderId); } catch (err) { console.error(err); }
});

async function syncFromOrder(storeId, orderId) {
 const storeRes = await pool.query("SELECT * FROM stores WHERE store_id = $1", [storeId]);
 const store = storeRes.rows[0];
 if (!store) return;
 const orderResp = await fetch("https://api.tiendanube.com/2025-03/" + storeId + "/orders/" + orderId, {
   headers: { Authentication: "bearer " + store.access_token, "User-Agent": USER_AGENT },
 });
 const order = await orderResp.json();
 const items = order.products || [];
 for (const item of items) {
   const variantId = String(item.variant_id);
   const qty = Number(item.quantity || 1);
   const mapRes = await pool.query("SELECT sku FROM sku_mapping WHERE store_id = $1 AND variant_id = $2", [storeId, variantId]);
   if (mapRes.rows.length === 0) continue;
   const sku = mapRes.rows[0].sku;
   if (storeId !== MASTER_STORE_ID) await deductFromMaster(sku, qty);
   const masterStock = await getMasterStock(sku);
   if (masterStock !== null) await pushStockToAllStores(sku, masterStock, storeId);
 }
}

async function deductFromMaster(sku, qty) {
 const masterRes = await pool.query("SELECT * FROM stores WHERE store_id = $1", [MASTER_STORE_ID]);
 const master = masterRes.rows[0];
 if (!master) return;
 const mapRes = await pool.query("SELECT product_id, variant_id FROM sku_mapping WHERE store_id = $1 AND sku = $2", [MASTER_STORE_ID, sku]);
 if (mapRes.rows.length === 0) return;
 const { product_id, variant_id } = mapRes.rows[0];
 const varResp = await fetch("https://api.tiendanube.com/2025-03/" + MASTER_STORE_ID + "/products/" + product_id + "/variants/" + variant_id, {
   headers: { Authentication: "bearer " + master.access_token, "User-Agent": USER_AGENT },
 });
 const variant = await varResp.json();
 const newStock = Math.max(Number(variant.stock || 0) - qty, 0);
 await fetch("https://api.tiendanube.com/2025-03/" + MASTER_STORE_ID + "/products/" + product_id + "/variants/" + variant_id, {
   method: "PUT",
   headers: { Authentication: "bearer " + master.access_token, "Content-Type": "application/json", "User-Agent": USER_AGENT },
   body: JSON.stringify({ stock: newStock }),
 });
}

async function getMasterStock(sku) {
 const masterRes = await pool.query("SELECT * FROM stores WHERE store_id = $1", [MASTER_STORE_ID]);
 const master = masterRes.rows[0];
 if (!master) return null;
 const mapRes = await pool.query("SELECT product_id, variant_id FROM sku_mapping WHERE store_id = $1 AND sku = $2", [MASTER_STORE_ID, sku]);
 if (mapRes.rows.length === 0) return null;
 const { product_id, variant_id } = mapRes.rows[0];
 const varResp = await fetch("https://api.tiendanube.com/2025-03/" + MASTER_STORE_ID + "/products/" + product_id + "/variants/" + variant_id, {
   headers: { Authentication: "bearer " + master.access_token, "User-Agent": USER_AGENT },
 });
 const variant = await varResp.json();
 return Number(variant.stock || 0);
}

async function pushStockToAllStores(sku, newStock, excludeStoreId) {
 const mappings = await pool.query(
   "SELECT m.store_id, m.product_id, m.variant_id, s.access_token FROM sku_mapping m JOIN stores s ON s.store_id = m.store_id WHERE m.sku = $1 AND m.store_id != $2",
   [sku, excludeStoreId || ""]
 );
 for (const row of mappings.rows) {
   if (row.store_id === MASTER_STORE_ID) continue;
   try {
     await fetch("https://api.tiendanube.com/2025-03/" + row.store_id + "/products/" + row.product_id + "/variants/" + row.variant_id, {
       method: "PUT",
       headers: { Authentication: "bearer " + row.access_token, "Content-Type": "application/json", "User-Agent": USER_AGENT },
       body: JSON.stringify({ stock: newStock }),
     });
   } catch (e) { console.error("Error actualizando tienda " + row.store_id + ":", e.message); }
 }
}

app.post("/api/import-master", async (req, res) => {
 try {
   const masterRes = await pool.query("SELECT * FROM stores WHERE store_id = $1", [MASTER_STORE_ID]);
   const master = masterRes.rows[0];
   if (!master) return res.status(400).json({ error: "Tienda maestra no conectada" });
   let page = 1; let imported = 0; let skipped = 0;
   while (true) {
     const resp = await fetch("https://api.tiendanube.com/2025-03/" + MASTER_STORE_ID + "/products?per_page=50&page=" + page, {
       headers: { Authentication: "bearer " + master.access_token, "User-Agent": USER_AGENT },
     });
     const products = await resp.json();
     if (!Array.isArray(products) || products.length === 0) break;
     for (const product of products) {
       const name = product.name?.es || product.name?.pt || product.name?.en || "Producto " + product.id;
       for (const variant of (product.variants || [])) {
         const sku = variant.sku;
         if (!sku) { skipped++; continue; }
         const stock = Number(variant.stock || 0);
         const variantName = name + ((variant.values || []).map(v => v.es || v.pt || "").filter(Boolean).length > 0
           ? " - " + (variant.values || []).map(v => v.es || v.pt || "").filter(Boolean).join(" / ") : "");
         await pool.query(
           "INSERT INTO master_skus (sku, name, stock, threshold) VALUES ($1, $2, $3, $4) ON CONFLICT (sku) DO UPDATE SET name = $2, stock = $3",
           [sku, variantName, stock, 5]
         );
         await pool.query(
           "INSERT INTO sku_mapping (sku, store_id, product_id, variant_id) VALUES ($1, $2, $3, $4) ON CONFLICT (sku, store_id) DO UPDATE SET product_id = $3, variant_id = $4",
           [sku, MASTER_STORE_ID, String(product.id), String(variant.id)]
         );
         imported++;
       }
     }
     if (products.length < 50) break;
     page++;
   }
   res.json({ ok: true, imported, skipped });
 } catch (e) {
   console.error("Error importando:", e.message);
   res.status(500).json({ error: "Error importando productos" });
 }
});

app.post("/api/link-by-sku/:storeId", async (req, res) => {
 const { storeId } = req.params;
 if (storeId === MASTER_STORE_ID) return res.status(400).json({ error: "No se puede vincular la tienda maestra con este metodo" });
 try {
   const storeRes = await pool.query("SELECT * FROM stores WHERE store_id = $1", [storeId]);
   const store = storeRes.rows[0];
   if (!store) return res.status(404).json({ error: "Tienda no encontrada" });
   let page = 1; let linked = 0; let notFound = 0;
   while (true) {
     const resp = await fetch("https://api.tiendanube.com/2025-03/" + storeId + "/products?per_page=50&page=" + page, {
       headers: { Authentication: "bearer " + store.access_token, "User-Agent": USER_AGENT },
     });
     const products = await resp.json();
     if (!Array.isArray(products) || products.length === 0) break;
     for (const product of products) {
       for (const variant of (product.variants || [])) {
         const sku = variant.sku;
         if (!sku) continue;
         const skuExists = await pool.query("SELECT sku FROM master_skus WHERE sku = $1", [sku]);
         if (skuExists.rows.length === 0) { notFound++; continue; }
         await pool.query(
           "INSERT INTO sku_mapping (sku, store_id, product_id, variant_id) VALUES ($1, $2, $3, $4) ON CONFLICT (sku, store_id) DO UPDATE SET product_id = $3, variant_id = $4",
           [sku, storeId, String(product.id), String(variant.id)]
         );
         linked++;
       }
     }
     if (products.length < 50) break;
     page++;
   }
   res.json({ ok: true, linked, notFound });
 } catch (e) {
   console.error("Error vinculando:", e.message);
   res.status(500).json({ error: "Error vinculando productos" });
 }
});

app.get("/api/stores", async (req, res) => {
 const result = await pool.query("SELECT store_id, name, created_at FROM stores ORDER BY id");
 res.json(result.rows);
});

app.get("/api/stores/:storeId/products", async (req, res) => {
 const { storeId } = req.params;
 const storeRes = await pool.query("SELECT * FROM stores WHERE store_id = $1", [storeId]);
 const store = storeRes.rows[0];
 if (!store) return res.status(404).json({ error: "Tienda no encontrada" });
 try {
   const resp = await fetch("https://api.tiendanube.com/2025-03/" + storeId + "/products?per_page=50", {
     headers: { Authentication: "bearer " + store.access_token, "User-Agent": USER_AGENT },
   });
   const products = await resp.json();
   const simplified = (Array.isArray(products) ? products : []).map((p) => ({
     id: p.id,
     name: p.name?.es || p.name?.pt || p.name?.en || "Producto " + p.id,
     variants: (p.variants || []).map((v) => ({
       id: v.id, sku: v.sku || "", stock: v.stock,
       values: (v.values || []).map((val) => val.es || val.pt || val.en || "").filter(Boolean).join(" / "),
     })),
   }));
   res.json(simplified);
 } catch (e) { res.status(500).json({ error: "No se pudo obtener productos" }); }
});

app.get("/api/skus", async (req, res) => {
 const skus = await pool.query("SELECT * FROM master_skus ORDER BY sku");
 const mappings = await pool.query("SELECT m.sku, m.store_id, s.name AS store_name FROM sku_mapping m JOIN stores s ON s.store_id = m.store_id");
 const result = skus.rows.map((sku) => ({
   ...sku,
   stores: mappings.rows.filter((m) => m.sku === sku.sku).map((m) => ({ store_id: m.store_id, store_name: m.store_name })),
 }));
 res.json(result);
});

app.post("/api/skus", async (req, res) => {
 const { sku, name, stock, threshold } = req.body;
 if (!sku || !name) return res.status(400).json({ error: "Falta sku o name" });
 await pool.query(
   "INSERT INTO master_skus (sku, name, stock, threshold) VALUES ($1, $2, $3, $4) ON CONFLICT (sku) DO UPDATE SET name = $2, stock = $3, threshold = $4",
   [sku, name, stock || 0, threshold || 5]
 );
 res.json({ ok: true });
});

app.post("/api/mapping", async (req, res) => {
 const { sku, store_id, product_id, variant_id } = req.body;
 if (!sku || !store_id || !product_id || !variant_id) return res.status(400).json({ error: "Faltan datos" });
 await pool.query(
   "INSERT INTO sku_mapping (sku, store_id, product_id, variant_id) VALUES ($1, $2, $3, $4) ON CONFLICT (sku, store_id) DO UPDATE SET product_id = $3, variant_id = $4",
   [sku, store_id, product_id, variant_id]
 );
 res.json({ ok: true });
});

app.post("/api/sync-all", async (req, res) => {
 try {
   const skus = await pool.query("SELECT DISTINCT sku FROM sku_mapping WHERE store_id = $1", [MASTER_STORE_ID]);
   let updated = 0; let errors = 0;
   for (const row of skus.rows) {
     try {
       const masterStock = await getMasterStock(row.sku);
       if (masterStock !== null) { await pushStockToAllStores(row.sku, masterStock, MASTER_STORE_ID); updated++; }
     } catch (e) { errors++; }
   }
   res.json({ ok: true, updated, errors });
 } catch (e) { res.status(500).json({ error: "Error sincronizando" }); }
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
 app.listen(PORT, () => console.log("Servidor corriendo en el puerto " + PORT));
}).catch((err) => { console.error(err); process.exit(1); });
