// server.js
//
// Backend de "Stock Sync": conecta varias tiendas Tienda Nube a un
// deposito central. Cuando se vende un producto en una tienda, se
// descuenta del stock central y se actualiza en todas las demas tiendas
// donde ese mismo SKU se vende.
//
// Variables de entorno necesarias (se configuran en Railway):
//   TN_CLIENT_ID      -> client_id de tu app en Tienda Nube
//   TN_CLIENT_SECRET  -> client_secret de tu app en Tienda Nube
//   APP_URL           -> URL publica de esta app (ej: https://tu-app.up.railway.app)
//   DATABASE_URL      -> la pone Railway automaticamente al agregar Postgres

const express = require("express");
const { pool, initDb } = require("./db");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const {
  TN_CLIENT_ID,
  TN_CLIENT_SECRET,
  APP_URL,
} = process.env;

const USER_AGENT = "StockSync (contacto@example.com)";

// ---------------------------------------------------------------------
// PASO 1: Conectar una tienda (OAuth)
// ---------------------------------------------------------------------

// Esta es la URL que vas a abrir desde el navegador, ESTANDO LOGUEADO
// en el admin de la tienda que querés conectar.
app.get("/connect", (req, res) => {
  const url = `https://www.tiendanube.com/apps/${TN_CLIENT_ID}/authorize`;
  res.redirect(url);
});

// Tienda Nube redirige aca despues de que el usuario autoriza la app.
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Falta el parametro 'code'.");

  try {
    // Intercambiamos el "code" por un access_token permanente.
    const tokenResp = await fetch(
      "https://www.tiendanube.com/apps/authorize/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: TN_CLIENT_ID,
          client_secret: TN_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
        }),
      }
    );
    const tokenData = await tokenResp.json();

    if (!tokenData.access_token) {
      console.error("Error obteniendo token:", tokenData);
      return res.status(400).send("No se pudo obtener el token. Revisa los logs.");
    }

    const storeId = String(tokenData.user_id);
    const accessToken = tokenData.access_token;

    // Pedimos el nombre de la tienda para mostrarlo lindo en el panel.
    let storeName = `Tienda ${storeId}`;
    try {
      const infoResp = await fetch(`https://api.tiendanube.com/2025-03/${storeId}/store`, {
        headers: {
          Authentication: `bearer ${accessToken}`,
          "User-Agent": USER_AGENT,
        },
      });
      const info = await infoResp.json();
      storeName = info?.name?.es || info?.name?.pt || storeName;
    } catch (e) {
      console.warn("No se pudo obtener el nombre de la tienda:", e.message);
    }

    // Guardamos (o actualizamos) la tienda en la base de datos.
    await pool.query(
      `INSERT INTO stores (store_id, name, access_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (store_id) DO UPDATE
       SET access_token = $3, name = $2`,
      [storeId, storeName, accessToken]
    );

    // Registramos el webhook de "pedido pagado" para esta tienda.
    try {
      await fetch(`https://api.tiendanube.com/2025-03/${storeId}/webhooks`, {
        method: "POST",
        headers: {
          Authentication: `bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          event: "order/paid",
          url: `${APP_URL}/webhooks/order-paid`,
        }),
      });
    } catch (e) {
      console.warn("No se pudo registrar el webhook:", e.message);
    }

    res.send(`
      <h1>Tienda conectada: ${storeName} ✅</h1>
      <p>ID de tienda: ${storeId}</p>
      <p><a href="/">Ir al panel</a></p>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error conectando la tienda. Revisa los logs.");
  }
});

// ---------------------------------------------------------------------
// PASO 2: Recibir avisos de ventas (webhook) y sincronizar stock
// ---------------------------------------------------------------------

app.post("/webhooks/order-paid", async (req, res) => {
  // Respondemos rapido para que Tienda Nube no reintente de mas.
  res.sendStatus(200);

  const { store_id, id: orderId } = req.body || {};
  if (!store_id || !orderId) return;

  try {
    await syncFromOrder(String(store_id), orderId);
  } catch (err) {
    console.error("Error sincronizando pedido:", err);
  }
});

async function syncFromOrder(storeId, orderId) {
  const storeRes = await pool.query("SELECT * FROM stores WHERE store_id = $1", [storeId]);
  const store = storeRes.rows[0];
  if (!store) return;

  // Buscamos el detalle del pedido para saber que productos se vendieron.
  const orderResp = await fetch(
    `https://api.tiendanube.com/2025-03/${storeId}/orders/${orderId}`,
    {
      headers: {
        Authentication: `bearer ${store.access_token}`,
        "User-Agent": USER_AGENT,
      },
    }
  );
  const order = await orderResp.json();
  const items = order.products || [];

  for (const item of items) {
    const productId = String(item.product_id);
    const variantId = String(item.variant_id);
    const qty = Number(item.quantity || 1);

    // Buscamos a que SKU maestro corresponde este producto/variante
    // vendido en ESTA tienda.
    const mapRes = await pool.query(
      `SELECT sku FROM sku_mapping WHERE store_id = $1 AND product_id = $2 AND variant_id = $3`,
      [storeId, productId, variantId]
    );
    if (mapRes.rows.length === 0) continue; // no esta mapeado, lo ignoramos

    const sku = mapRes.rows[0].sku;

    // Descontamos del stock central (sin bajar de 0).
    const updated = await pool.query(
      `UPDATE master_skus SET stock = GREATEST(stock - $1, 0) WHERE sku = $2 RETURNING stock`,
      [qty, sku]
    );
    const newStock = updated.rows[0]?.stock;
    if (newStock === undefined) continue;

    // Empujamos el nuevo stock a TODAS las tiendas donde se vende este SKU.
    await pushStockToAllStores(sku, newStock);
  }
}

async function pushStockToAllStores(sku, newStock) {
  const mappings = await pool.query(
    `SELECT m.store_id, m.product_id, m.variant_id, s.access_token
     FROM sku_mapping m
     JOIN stores s ON s.store_id = m.store_id
     WHERE m.sku = $1`,
    [sku]
  );

  for (const row of mappings.rows) {
    try {
      await fetch(
        `https://api.tiendanube.com/2025-03/${row.store_id}/products/${row.product_id}/variants/${row.variant_id}`,
        {
          method: "PUT",
          headers: {
            Authentication: `bearer ${row.access_token}`,
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({ stock: newStock }),
        }
      );
    } catch (e) {
      console.error(`Error actualizando stock en tienda ${row.store_id}:`, e.message);
    }
  }
}

// ---------------------------------------------------------------------
// API para el panel (dashboard)
// ---------------------------------------------------------------------

// Lista de tiendas conectadas
app.get("/api/stores", async (req, res) => {
  const result = await pool.query("SELECT store_id, name, created_at FROM stores ORDER BY id");
  res.json(result.rows);
});

// Lista de SKUs maestros con las tiendas donde se venden
app.get("/api/skus", async (req, res) => {
  const skus = await pool.query("SELECT * FROM master_skus ORDER BY sku");
  const mappings = await pool.query(
    `SELECT m.sku, m.store_id, s.name AS store_name
     FROM sku_mapping m JOIN stores s ON s.store_id = m.store_id`
  );

  const result = skus.rows.map((sku) => ({
    ...sku,
    stores: mappings.rows
      .filter((m) => m.sku === sku.sku)
      .map((m) => ({ store_id: m.store_id, store_name: m.store_name })),
  }));

  res.json(result);
});

// Crear o actualizar un SKU maestro
app.post("/api/skus", async (req, res) => {
  const { sku, name, stock, threshold } = req.body;
  if (!sku || !name) return res.status(400).json({ error: "Falta sku o name" });

  await pool.query(
    `INSERT INTO master_skus (sku, name, stock, threshold)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sku) DO UPDATE
     SET name = $2, stock = $3, threshold = $4`,
    [sku, name, stock || 0, threshold || 5]
  );
  res.json({ ok: true });
});

// Crear un mapeo SKU <-> tienda <-> producto/variante
app.post("/api/mapping", async (req, res) => {
  const { sku, store_id, product_id, variant_id } = req.body;
  if (!sku || !store_id || !product_id || !variant_id) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  await pool.query(
    `INSERT INTO sku_mapping (sku, store_id, product_id, variant_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (sku, store_id) DO UPDATE
     SET product_id = $3, variant_id = $4`,
    [sku, store_id, product_id, variant_id]
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Arranque del servidor
// ---------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));
  })
  .catch((err) => {
    console.error("Error inicializando la base de datos:", err);
    process.exit(1);
  });
