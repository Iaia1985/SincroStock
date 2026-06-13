import { useState } from "react";
import { Package, AlertTriangle, Store, Search, ArrowUpDown, CheckCircle2 } from "lucide-react";

const STORES = [
  { id: "A", name: "Tienda Norte" },
  { id: "B", name: "Tienda Centro" },
  { id: "C", name: "Tienda Sur" },
  { id: "D", name: "Tienda Outlet" },
  { id: "E", name: "Tienda Mayorista" },
  { id: "F", name: "Tienda Express" },
];

const SKUS = [
  {
    sku: "REM-AZ-M",
    name: "Remera básica azul - M",
    stock: 42,
    threshold: 10,
    stores: ["A", "B", "E"],
  },
  {
    sku: "REM-AZ-L",
    name: "Remera básica azul - L",
    stock: 6,
    threshold: 10,
    stores: ["A", "B", "C", "E"],
  },
  {
    sku: "PANT-NEG-40",
    name: "Pantalón cargo negro - 40",
    stock: 18,
    threshold: 5,
    stores: ["B", "D"],
  },
  {
    sku: "CAMP-VER-S",
    name: "Campera verde militar - S",
    stock: 3,
    threshold: 8,
    stores: ["A", "C", "D", "E", "F"],
  },
  {
    sku: "MED-GRIS-U",
    name: "Medias grises - única",
    stock: 120,
    threshold: 30,
    stores: ["A", "B", "C", "D", "E", "F"],
  },
  {
    sku: "GORRA-NEG",
    name: "Gorra negra bordada",
    stock: 0,
    threshold: 5,
    stores: ["C", "F"],
  },
  {
    sku: "BUFANDA-RYO",
    name: "Bufanda rayada multicolor",
    stock: 27,
    threshold: 10,
    stores: ["E"],
  },
];

function stockStatus(item) {
  if (item.stock === 0) return "out";
  if (item.stock <= item.threshold) return "low";
  return "ok";
}

const statusStyles = {
  out: { bg: "bg-[#C1453F]", text: "text-[#C1453F]", label: "Agotado" },
  low: { bg: "bg-[#E0973C]", text: "text-[#E0973C]", label: "Stock bajo" },
  ok: { bg: "bg-[#5B8C5A]", text: "text-[#5B8C5A]", label: "OK" },
};

export default function StockDashboard() {
  const [query, setQuery] = useState("");
  const [sortDesc, setSortDesc] = useState(false);

  const filtered = SKUS.filter(
    (s) =>
      s.name.toLowerCase().includes(query.toLowerCase()) ||
      s.sku.toLowerCase().includes(query.toLowerCase())
  );

  const sorted = [...filtered].sort((a, b) =>
    sortDesc ? a.stock - b.stock : b.stock - a.stock
  );

  const totalSkus = SKUS.length;
  const lowOrOut = SKUS.filter((s) => stockStatus(s) !== "ok").length;
  const totalUnits = SKUS.reduce((sum, s) => sum + s.stock, 0);

  return (
    <div className="min-h-screen bg-[#F7F5F0] text-[#1A2E35] font-sans">
      {/* Header */}
      <header className="border-b-2 border-[#1A2E35] px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-[#1A2E35] flex items-center justify-center rounded-sm">
            <Package size={18} className="text-[#F7F5F0]" />
          </div>
          <h1 className="font-mono text-lg font-bold tracking-tight">
            DEPÓSITO::CENTRAL
          </h1>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-[#4A7C7C]">
          <CheckCircle2 size={14} />
          {STORES.length} tiendas conectadas
        </div>
      </header>

      <main className="px-5 py-6 max-w-5xl mx-auto">
        {/* Summary strip — ticket stub style */}
        <div className="grid grid-cols-3 gap-px bg-[#1A2E35] border-2 border-[#1A2E35] mb-6 overflow-hidden rounded-sm">
          <div className="bg-[#F7F5F0] p-4">
            <div className="font-mono text-2xl font-bold">{totalSkus}</div>
            <div className="text-xs text-[#1A2E35]/60 mt-1">SKUs maestros</div>
          </div>
          <div className="bg-[#F7F5F0] p-4">
            <div className="font-mono text-2xl font-bold">{totalUnits}</div>
            <div className="text-xs text-[#1A2E35]/60 mt-1">Unidades totales</div>
          </div>
          <div className="bg-[#1A2E35] p-4">
            <div className="font-mono text-2xl font-bold text-[#F7F5F0] flex items-center gap-1.5">
              <AlertTriangle size={18} className="text-[#E0973C]" />
              {lowOrOut}
            </div>
            <div className="text-xs text-[#F7F5F0]/60 mt-1">Alertas activas</div>
          </div>
        </div>

        {/* Search + sort */}
        <div className="flex items-center gap-2 mb-4">
          <div className="flex-1 flex items-center gap-2 border-2 border-[#1A2E35] bg-white px-3 py-2 rounded-sm">
            <Search size={16} className="text-[#1A2E35]/50" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por SKU o nombre..."
              className="w-full outline-none text-sm bg-transparent placeholder:text-[#1A2E35]/40"
            />
          </div>
          <button
            onClick={() => setSortDesc(!sortDesc)}
            className="border-2 border-[#1A2E35] px-3 py-2 rounded-sm flex items-center gap-1.5 text-xs font-mono hover:bg-[#1A2E35] hover:text-[#F7F5F0] transition-colors"
          >
            <ArrowUpDown size={14} />
            STOCK
          </button>
        </div>

        {/* SKU list — label/ticket style rows */}
        <div className="space-y-2">
          {sorted.map((item) => {
            const status = stockStatus(item);
            const style = statusStyles[status];
            return (
              <div
                key={item.sku}
                className="border-2 border-[#1A2E35] bg-white rounded-sm flex flex-col sm:flex-row sm:items-center overflow-hidden"
              >
                {/* status tab */}
                <div
                  className={`${style.bg} sm:w-2 h-1.5 sm:h-auto w-full flex-shrink-0`}
                />

                <div className="flex-1 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-[#1A2E35]/50 tracking-wider">
                      {item.sku}
                    </div>
                    <div className="font-medium text-sm">{item.name}</div>
                  </div>

                  {/* store badges */}
                  <div className="flex items-center gap-1 flex-wrap">
                    {item.stores.map((sId) => (
                      <span
                        key={sId}
                        title={STORES.find((s) => s.id === sId)?.name}
                        className="w-6 h-6 flex items-center justify-center text-[10px] font-mono font-bold border border-[#1A2E35]/30 rounded-sm bg-[#F7F5F0]"
                      >
                        {sId}
                      </span>
                    ))}
                  </div>

                  {/* stock count */}
                  <div className="flex items-center gap-2 sm:w-32 sm:justify-end">
                    <span className="font-mono text-lg font-bold">
                      {item.stock}
                    </span>
                    <span
                      className={`${style.text} text-[10px] font-mono font-bold uppercase border border-current px-1.5 py-0.5 rounded-sm`}
                    >
                      {style.label}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {sorted.length === 0 && (
          <div className="text-center py-10 text-sm text-[#1A2E35]/50 font-mono">
            Sin resultados para "{query}"
          </div>
        )}

        <p className="text-xs text-[#1A2E35]/40 mt-8 text-center font-mono">
          Vista de demostración — datos de ejemplo
        </p>
      </main>
    </div>
  );
}
