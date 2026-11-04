import http from 'http';

// ── Credentials ───────────────────────────────────────────────────────────────
const TENANT     = process.env.C7_TENANT     || "spruce-hill-winery";
const APP_ID     = process.env.C7_APP_ID     || "shw-claude-integration";
const APP_SECRET = process.env.C7_APP_SECRET || "";

if (!APP_SECRET) {
  console.error("ERROR: C7_APP_SECRET environment variable is not set.");
  process.exit(1);
}
const BASE_URL   = "https://api.commerce7.com/v1";
const PORT       = process.env.PORT || 3000;

// ── Location IDs ──────────────────────────────────────────────────────────────
const LOC_SEATTLE      = "260678dc-fdf7-484c-8cca-7674efa31af0";
const LOC_GIG_HARBOR   = "6b0c61b0-c9cc-4c79-b318-089e6c5ad70d";
const LOC_TASTING_ROOM = "82d43a0c-5a34-4fc5-bc44-f27fa747c091";
const LOC_FAMILY_USE   = "733c34c7-647d-4897-af5d-2dfe6d39c081";
const LOC_LIBRARY      = "003467dc-2e9a-42a8-bb5c-40ad53207f43";
const LOCATION_NAMES   = {
  [LOC_SEATTLE]:      "Seattle",
  [LOC_GIG_HARBOR]:   "Gig Harbor",
  [LOC_TASTING_ROOM]: "Tasting Room Pours",
  [LOC_FAMILY_USE]:   "Family Use",
  [LOC_LIBRARY]:      "Library",
};
const BPC = 12; // bottles per case

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Content-Type": "application/json",
};

// ── Commerce7 API ─────────────────────────────────────────────────────────────
const c7Auth = "Basic " + Buffer.from(`${APP_ID}:${APP_SECRET}`).toString("base64");

async function c7Get(path) {
  const r = await fetch(`${BASE_URL}${path}`, {
    headers: { "Authorization": c7Auth, "tenant": TENANT, "Content-Type": "application/json" }
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(`C7 ${r.status}: ${e.message || r.statusText}`);
  }
  return r.json();
}

async function paginate(path, key, extraParams = "") {
  let page = 1, results = [], total = null;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const d = await c7Get(`${path}${sep}page=${page}&limit=50${extraParams}`);
    const batch = d[key] || [];
    if (total === null) total = d.total || batch.length;
    results = results.concat(batch);
    if (batch.length < 50 || results.length >= total) break;
    page++;
  }
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function atLoc(v, lid) {
  return (v.inventory || []).find(i => i.inventoryLocationId === lid)?.availableForSaleCount || 0;
}
function allBottles(v) {
  return (v.inventory || []).reduce((s, i) => s + (i.availableForSaleCount || 0), 0);
}
function fmt(b) {
  if (b <= 0) return "0 bottles";
  const c = Math.floor(b / BPC), r = b % BPC;
  return r > 0 ? `${c} cases + ${r} btl (${b} total)` : `${c} cases (${b} btl)`;
}
function dollars(cents) { return `$${(cents / 100).toFixed(2)}`; }

// ── Pacific-time date handling ───────────────────────────────────────────────
// Commerce7 stores timestamps in UTC but its reports (Day Sales Summary, etc.)
// bucket orders by Pacific calendar day. All date filtering here does the same.
const TZ = "America/Los_Angeles";
const pacDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
function pacificDay(iso) {          // "2026-11-01T02:48:06.000Z" -> "2026-10-31"
  if (!iso) return null;
  return pacDayFmt.format(new Date(iso));
}
function shiftDay(ymd, days) {      // "2026-10-31", +1 -> "2026-11-01"
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function inPacificRange(o, from_date, to_date) {
  const d = pacificDay(o.orderPaidDate);
  if (!d) return false;
  return (!from_date || d >= from_date) && (!to_date || d <= to_date);
}
// Ask the API for a window one day wider on each side (its date filter is UTC
// and date-only), then trim precisely by Pacific day client-side.
function apiDateWindow(from_date, to_date) {
  if (!from_date && !to_date) return "";
  const lo = from_date ? shiftDay(from_date, -1) : "2000-01-01";
  const hi = to_date ? shiftDay(to_date, 2) : "2100-01-01";
  return `&orderPaidDate=btw:${lo}|${hi}`;
}
// ── Product -> department lookup (departments are how C7 groups products for accounting) ──
let deptCache = { at: 0, bySku: {}, byProductId: {} };
async function getDeptMaps() {
  if (Date.now() - deptCache.at < 10 * 60 * 1000) return deptCache;
  const products = await paginate("/product", "products");
  const bySku = {}, byProductId = {};
  for (const p of products) {
    const dept = p.department?.title || p.department?.code || "(none)";
    byProductId[p.id] = dept;
    for (const v of (p.variants || [])) if (v.sku) bySku[v.sku] = dept;
  }
  deptCache = { at: Date.now(), bySku, byProductId };
  return deptCache;
}
function isWineItem(item) {
  if (item.type) return item.type === "Wine";
  return /^20\d\d_/.test(item.sku || "");
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_inventory",
    description: "Get current wine inventory. Filter by location (seattle, gig_harbor, or all). Shows cases and bottles.",
    inputSchema: { type: "object", properties: {
      location:       { type: "string", enum: ["all","seattle","gig_harbor"], default: "all" },
      min_bottles:    { type: "number", default: 1 },
      available_only: { type: "boolean", default: true },
    }},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_product",
    description: "Look up a specific wine by name or SKU. Returns full inventory detail across all locations.",
    inputSchema: { type: "object", properties: { search: { type: "string" } }, required: ["search"] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "check_restock",
    description: "Check which wines at a location are below a target case level.",
    inputSchema: { type: "object", properties: {
      location:     { type: "string", enum: ["seattle","gig_harbor"] },
      target_cases: { type: "number", default: 4 },
    }, required: ["location"] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "compare_locations",
    description: "Compare inventory side by side between Seattle and Gig Harbor for all available wines.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_all_locations",
    description: "Get inventory across all five locations: Seattle, Gig Harbor, Tasting Room Pours, Family Use, and Library.",
    inputSchema: { type: "object", properties: {
      available_only:    { type: "boolean", default: true },
      min_total_bottles: { type: "number", default: 1 },
    }},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_sales",
    description: "Get sales from Commerce7 paid orders by Pacific-time calendar day (matches C7 reports). Returns net/gross revenue, discounts, tax, tips, and bottles per wine. Use wine_only=false to tie to the Day Sales Summary.",
    inputSchema: { type: "object", properties: {
      from_date:  { type: "string", description: "Start date YYYY-MM-DD" },
      to_date:    { type: "string", description: "End date YYYY-MM-DD" },
      channel:    { type: "string", enum: ["all","Web","POS","Club"], default: "all" },
      wine_only:  { type: "boolean", default: true },
      include_raw_sample: { type: "boolean", default: false, description: "Debug: include the field names of one raw order so available fields can be inspected" },
    }, required: ["from_date","to_date"] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_orders",
    description: "Get orders with full detail. Date filters use Pacific-time calendar days (matches C7 reports). Filter by date, channel, or customer name.",
    inputSchema: { type: "object", properties: {
      from_date:     { type: "string", description: "Start date YYYY-MM-DD (optional)" },
      to_date:       { type: "string", description: "End date YYYY-MM-DD (optional)" },
      channel:       { type: "string", enum: ["all","Web","POS","Club"], default: "all" },
      customer_name: { type: "string", description: "Filter by customer name (partial match)" },
      limit:         { type: "number", default: 20, description: "Max orders to return (default 20, max 50)" },
    }},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_club_members",
    description: "Get wine club membership data. Returns active members by club tier, total counts, and recent signups.",
    inputSchema: { type: "object", properties: {
      status: { type: "string", enum: ["Active","Cancelled","Paused","all"], default: "Active" },
      limit:  { type: "number", default: 50 },
    }},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_customers",
    description: "Look up customers by name or email. Returns contact info, club status, lifetime value, and order history.",
    inputSchema: { type: "object", properties: {
      search: { type: "string", description: "Name or email to search for" },
      limit:  { type: "number", default: 10 },
    }, required: ["search"] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_reservations",
    description: "Get upcoming or recent reservations. Filter by date range or status.",
    inputSchema: { type: "object", properties: {
      from_date: { type: "string", description: "Start date YYYY-MM-DD (optional)" },
      to_date:   { type: "string", description: "End date YYYY-MM-DD (optional)" },
      status:    { type: "string", description: "Filter by status (optional)" },
      limit:     { type: "number", default: 20 },
    }},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_coupons",
    description: "Get active coupons and promotions. Returns discount codes, values, usage counts, and expiry dates.",
    inputSchema: { type: "object", properties: {
      active_only: { type: "boolean", default: true },
    }},
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

// ── Tool execution ─────────────────────────────────────────────────────────────
async function executeTool(name, args = {}) {

  // ── get_inventory ──────────────────────────────────────────────────────────
  if (name === "get_inventory") {
    const { location = "all", min_bottles = 1, available_only = true } = args;
    const products = await paginate("/product", "products");
    const rows = [];
    for (const p of products) {
      if (p.department?.code !== "Wine") continue;
      if (available_only && p.adminStatus !== "Available") continue;
      for (const v of (p.variants || [])) {
        if (!v.hasInventory) continue;
        const b = location === "seattle" ? atLoc(v, LOC_SEATTLE)
                : location === "gig_harbor" ? atLoc(v, LOC_GIG_HARBOR)
                : allBottles(v);
        if (b < min_bottles) continue;
        const row = { name: p.title, subtitle: p.subTitle || "", sku: v.sku, wine_type: p.wine?.type || "", bottles: b, cases: Math.floor(b / BPC), remainder: b % BPC, formatted: fmt(b) };
        if (location === "all") {
          row.seattle_bottles      = atLoc(v, LOC_SEATTLE);
          row.gig_harbor_bottles   = atLoc(v, LOC_GIG_HARBOR);
          row.tasting_room_bottles = atLoc(v, LOC_TASTING_ROOM);
          row.family_use_bottles   = atLoc(v, LOC_FAMILY_USE);
        }
        rows.push(row);
      }
    }
    rows.sort((a, b) => b.bottles - a.bottles);
    const tot = rows.reduce((s, r) => s + r.bottles, 0);
    return { location, summary: { total_skus: rows.length, total_bottles: tot, total_cases: Math.floor(tot / BPC) }, wines: rows };
  }

  // ── get_product ────────────────────────────────────────────────────────────
  if (name === "get_product") {
    const products = await paginate("/product", "products");
    const q = (args.search || "").toLowerCase();
    const matches = products.filter(p => p.title?.toLowerCase().includes(q) || p.variants?.some(v => v.sku?.toLowerCase().includes(q)));
    if (!matches.length) return { message: `No wines found matching "${args.search}".` };
    return matches.map(p => ({
      id: p.id, title: p.title, subtitle: p.subTitle, wine_type: p.wine?.type,
      admin_status: p.adminStatus, web_status: p.webStatus, price: dollars(p.variants?.[0]?.price || 0),
      variants: p.variants.map(v => ({
        sku: v.sku, price: dollars(v.price), has_inventory: v.hasInventory,
        inventory_by_location: Object.fromEntries((v.inventory || []).map(i => [
          LOCATION_NAMES[i.inventoryLocationId] || i.inventoryLocationId,
          { available: i.availableForSaleCount, reserved: i.reserveCount, allocated: i.allocatedCount, formatted: fmt(i.availableForSaleCount || 0) }
        ])),
        total_bottles: allBottles(v), total_formatted: fmt(allBottles(v)),
      })),
    }));
  }

  // ── check_restock ──────────────────────────────────────────────────────────
  if (name === "check_restock") {
    const { location, target_cases = 4 } = args;
    const lid = location === "seattle" ? LOC_SEATTLE : LOC_GIG_HARBOR;
    const tb  = target_cases * BPC;
    const products = await paginate("/product", "products");
    const flagged = [], ok = [];
    for (const p of products) {
      if (p.department?.code !== "Wine" || p.adminStatus !== "Available") continue;
      for (const v of (p.variants || [])) {
        if (!v.hasInventory) continue;
        const b = atLoc(v, lid); if (b <= 0) continue;
        const needed = Math.max(0, tb - b);
        const e = { name: p.title, sku: v.sku, bottles: b, formatted: fmt(b), needed_bottles: needed, needed_cases: Math.ceil(needed / BPC), at_target: needed === 0 };
        needed > 0 ? flagged.push(e) : ok.push(e);
      }
    }
    flagged.sort((a, b) => b.needed_bottles - a.needed_bottles);
    return { location: LOCATION_NAMES[lid], target_cases, summary: { below_target: flagged.length, at_or_above: ok.length, total_bottles_needed: flagged.reduce((s, r) => s + r.needed_bottles, 0) }, needs_restock: flagged, at_target: ok };
  }

  // ── compare_locations ──────────────────────────────────────────────────────
  if (name === "compare_locations") {
    const products = await paginate("/product", "products");
    const rows = [];
    for (const p of products) {
      if (p.department?.code !== "Wine" || p.adminStatus !== "Available") continue;
      for (const v of (p.variants || [])) {
        if (!v.hasInventory) continue;
        const s = atLoc(v, LOC_SEATTLE), h = atLoc(v, LOC_GIG_HARBOR);
        if (s + h === 0) continue;
        rows.push({ name: p.title, sku: v.sku, wine_type: p.wine?.type || "", seattle_bottles: s, seattle_formatted: fmt(s), gig_harbor_bottles: h, gig_harbor_formatted: fmt(h), total_bottles: s + h, total_formatted: fmt(s + h) });
      }
    }
    rows.sort((a, b) => b.total_bottles - a.total_bottles);
    return { summary: { total_skus: rows.length, seattle_total: rows.reduce((s, r) => s + r.seattle_bottles, 0), gig_harbor_total: rows.reduce((s, r) => s + r.gig_harbor_bottles, 0) }, wines: rows };
  }

  // ── get_all_locations ──────────────────────────────────────────────────────
  if (name === "get_all_locations") {
    const { available_only = true, min_total_bottles = 1 } = args;
    const products = await paginate("/product", "products");
    const rows = [];
    for (const p of products) {
      if (p.department?.code !== "Wine") continue;
      if (available_only && p.adminStatus !== "Available") continue;
      for (const v of (p.variants || [])) {
        if (!v.hasInventory) continue;
        const s = atLoc(v, LOC_SEATTLE), h = atLoc(v, LOC_GIG_HARBOR), t = atLoc(v, LOC_TASTING_ROOM), f = atLoc(v, LOC_FAMILY_USE), l = atLoc(v, LOC_LIBRARY);
        const total = s + h + t + f + l;
        if (total < min_total_bottles) continue;
        rows.push({ name: p.title, sku: v.sku, wine_type: p.wine?.type || "", seattle: s, gig_harbor: h, tasting_room_pours: t, family_use: f, library: l, total_bottles: total, total_formatted: fmt(total) });
      }
    }
    rows.sort((a, b) => b.total_bottles - a.total_bottles);
    const totals = { seattle: 0, gig_harbor: 0, tasting_room_pours: 0, family_use: 0, library: 0, grand_total: 0 };
    rows.forEach(r => { totals.seattle += r.seattle; totals.gig_harbor += r.gig_harbor; totals.tasting_room_pours += r.tasting_room_pours; totals.family_use += r.family_use; totals.library += r.library; totals.grand_total += r.total_bottles; });
    return { summary: { total_skus: rows.length, ...totals }, wines: rows };
  }

  // ── get_sales ──────────────────────────────────────────────────────────────
  if (name === "get_sales") {
    const { from_date, to_date, channel = "all", wine_only = true, include_raw_sample = false } = args;
    const dept = await getDeptMaps().catch(() => ({ bySku: {}, byProductId: {} }));
    const byDept = {}, byType = {}, tenders = {}, discByName = {}; let discOrderTotal = 0;
    let basePath = `/order?paymentStatus=Paid${apiDateWindow(from_date, to_date)}`;
    if (channel !== "all") basePath += `&channel=${channel}`;
    const allOrders = await paginate(basePath, "orders");
    const orders = allOrders.filter(o => inPacificRange(o, from_date, to_date));

    const byProduct = {};
    let lineRevenue = 0, grossRevenue = 0, bottles = 0, units = 0, orderIds = new Set();
    let subTotal = 0, taxTotal = 0, tipTotal = 0, shipTotal = 0, total = 0, totalAfterTip = 0;
    for (const o of orders) {
      let hasWine = false;
      for (const item of (o.items || [])) {
        const isWine = isWineItem(item);
        if (wine_only && !isWine) continue;
        const qty = item.quantity || 0;
        const line = (item.price || 0) * qty;
        const gross = (item.originalPrice ?? item.price ?? 0) * qty;
        if (!byProduct[item.sku]) byProduct[item.sku] = { title: item.productTitle, sku: item.sku, is_wine: isWine, units: 0, revenue: 0, gross: 0, order_ids: new Set() };
        const r = byProduct[item.sku];
        r.units += qty; r.revenue += line; r.gross += gross; r.order_ids.add(o.id);
        lineRevenue += line; grossRevenue += gross; units += qty;
        const dn = dept.bySku[item.sku] || dept.byProductId[item.productId] || "(unknown)";
        const d = byDept[dn] || (byDept[dn] = { net: 0, gross: 0, units: 0 });
        d.net += line; d.gross += gross; d.units += qty;
        const tn = item.type || "(none)";
        const t = byType[tn] || (byType[tn] = { net: 0, gross: 0, units: 0 });
        t.net += line; t.gross += gross; t.units += qty;
        if (isWine) { bottles += qty; hasWine = true; }
      }
      if (hasWine || !wine_only) {
        for (const pay of (o.tenders || [])) {
          const base = pay.tenderType || "(unknown)";
          const k = (base === "External" && pay.otherPaymentMethod) ? `External: ${pay.otherPaymentMethod}` : base;
          const key = `${k} | ${pay.chargeType || "?"} | ${pay.chargeStatus || "?"}`;
          const t = tenders[key] || (tenders[key] = { amount: 0, tip: 0, count: 0 });
          t.amount += pay.amountTendered || 0; t.tip += pay.tip || 0; t.count++;
        }
        for (const c of [...(o.coupons || []), ...(o.promotions || [])]) {
          const n = (c.title || c.code || "(unnamed)") + (o.promotions?.includes(c) ? " [promotion]" : " [coupon]");
          const d = discByName[n] || (discByName[n] = { value: 0, orders: 0 });
          d.value += c.totalValue ?? c.productValue ?? 0; d.orders++;
        }
        discOrderTotal += o.discountTotal || 0;
        orderIds.add(o.id);
        subTotal += o.subTotal || 0; taxTotal += o.taxTotal || 0; tipTotal += o.tipTotal || 0;
        shipTotal += o.shipTotal || 0; total += o.total || 0; totalAfterTip += o.totalAfterTip || 0;
      }
    }
    const wines = Object.values(byProduct)
      .map(r => ({ title: r.title, sku: r.sku, is_wine: r.is_wine, bottles: r.is_wine ? r.units : 0, units: r.units, cases: r.is_wine ? Math.floor(r.units / BPC) : 0,
                   revenue: dollars(r.revenue), gross: dollars(r.gross), discount: dollars(r.gross - r.revenue),
                   avg_price: r.units > 0 ? dollars(r.revenue / r.units) : "$0", orders: r.order_ids.size }))
      .sort((a, b) => b.units - a.units);
    return {
      period: `${from_date} to ${to_date} (Pacific calendar days)`,
      channel: channel === "all" ? "All channels" : channel,
      summary: {
        total_orders: orderIds.size,
        total_bottles: bottles,                       // wine bottles only
        total_cases: Math.floor(bottles / BPC),
        total_units: units,                           // all line items incl. tastings, pours, merch
        net_revenue: dollars(lineRevenue),            // sum of line prices after discounts
        gross_revenue: dollars(grossRevenue),         // at original price
        discounts: dollars(grossRevenue - lineRevenue),
        total_revenue: dollars(lineRevenue),          // kept for backward compatibility (= net_revenue)
        // Order-level totals (whole orders counted; ties to C7 Day Sales Summary when wine_only=false)
        order_subtotal: dollars(subTotal),
        shipping: dollars(shipTotal),
        tax: dollars(taxTotal),
        order_total: dollars(total),
        tips: dollars(tipTotal),
        total_after_tip: dollars(totalAfterTip),
      },
      by_department: Object.fromEntries(Object.entries(byDept).map(([k, v]) => [k, { net: dollars(v.net), gross: dollars(v.gross), discount: dollars(v.gross - v.net), units: v.units }])),
      by_item_type: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { net: dollars(v.net), gross: dollars(v.gross), discount: dollars(v.gross - v.net), units: v.units }])),
      discounts_by_name: Object.fromEntries(Object.entries(discByName).sort((a, b) => b[1].value - a[1].value).map(([k, v]) => [k, { total: dollars(v.value), orders: v.orders }])),
      discounts_order_level_total: dollars(discOrderTotal),   // sum of order.discountTotal; compare with summary.discounts
      tender_totals: Object.fromEntries(Object.entries(tenders).sort().map(([k, v]) => [k, { amount_excl_tip: dollars(v.amount), tips: dollars(v.tip), amount_incl_tip: dollars(v.amount + v.tip), payments: v.count }])),
      ...(include_raw_sample && orders[0] ? {
        raw_order_fields: Object.keys(orders[0]),
        raw_item_fields: Object.keys((orders[0].items || [])[0] || {}),
        raw_tender_sample: (orders[0].tenders || []).map(({ creditCard, ...rest }) => ({ ...rest, creditCard: creditCard ? { gateway: creditCard.gateway, cardBrand: creditCard.cardBrand } : null })),
        raw_order_with_coupon: (({ coupons, promotions, discountTotal, subTotal, items }) => ({ coupons, promotions, discountTotal, subTotal, first_item: items?.[0] && { sku: items[0].sku, price: items[0].price, originalPrice: items[0].originalPrice } }))(orders.find(o => (o.coupons || []).length) || {}),
        raw_order_with_promotion: (({ coupons, promotions, discountTotal }) => ({ coupons, promotions, discountTotal }))(orders.find(o => (o.promotions || []).length) || {}),
        raw_non_sale_tenders: orders.flatMap(o => (o.tenders || []).filter(t => t.chargeType !== "Sale" || t.chargeStatus !== "Success").map(({ creditCard, ...r }) => r)).slice(0, 3),
      } : {}),
      note: wine_only ? "wine_only=true: non-wine items excluded from revenue/units; order-level totals cover whole orders that contain wine" : "Order-level totals tie to the Commerce7 Day Sales Summary report",
      by_wine: wines
    };
  }

  // ── get_orders ─────────────────────────────────────────────────────────────
  if (name === "get_orders") {
    const { from_date, to_date, channel = "all", customer_name, limit = 20 } = args;
    let path = `/order?paymentStatus=Paid${apiDateWindow(from_date, to_date)}`;
    if (channel !== "all") path += `&channel=${channel}`;
    const cap = Math.min(limit, 50);
    let orders;
    if (from_date || to_date) {
      // Fetch the whole (widened) window, then trim by Pacific day
      orders = (await paginate(path, "orders")).filter(o => inPacificRange(o, from_date, to_date));
    } else {
      const d = await c7Get(`${path}&limit=${cap}`);
      orders = d.orders || [];
    }
    if (customer_name) {
      const q = customer_name.toLowerCase();
      orders = orders.filter(o => {
        const fn = (o.shipTo?.firstName || o.billTo?.firstName || "").toLowerCase();
        const ln = (o.shipTo?.lastName || o.billTo?.lastName || "").toLowerCase();
        return fn.includes(q) || ln.includes(q) || `${fn} ${ln}`.includes(q);
      });
    }
    orders.sort((a, b) => (b.orderPaidDate || "").localeCompare(a.orderPaidDate || ""));
    const matched = orders.length;
    orders = orders.slice(0, cap);
    return {
      total_matching: matched,
      returned: orders.length,
      truncated: matched > orders.length,
      orders: orders.map(o => ({
        order_number:  o.orderNumber,
        date:          o.orderPaidDate,
        date_pacific:  pacificDay(o.orderPaidDate),
        channel:       o.channel,
        pos_profile:   o.posProfile?.title || o.posProfile?.name || undefined,
        customer:      `${o.shipTo?.firstName || o.billTo?.firstName || ""} ${o.shipTo?.lastName || o.billTo?.lastName || ""}`.trim(),
        subtotal:      dollars(o.subTotal),
        tax:           dollars(o.taxTotal || 0),
        total:         dollars(o.total),
        tip:           dollars(o.tipTotal || 0),
        total_after_tip: dollars(o.totalAfterTip ?? o.total),
        item_count:    o.items?.length || 0,
        items:         (o.items || []).map(i => ({ title: i.productTitle, sku: i.sku, type: i.type, qty: i.quantity, price: dollars(i.price), original_price: dollars(i.originalPrice ?? i.price) })),
        fulfillment:   o.fulfillmentStatus,
        customer_type: o.customerType,
      }))
    };
  }

  // ── get_club_members ───────────────────────────────────────────────────────
  if (name === "get_club_members") {
    const { status = "Active", limit = 50 } = args;
    const memberships = await paginate(status === "all" ? "/club-membership" : `/club-membership?status=${status}`, "clubMemberships");
    // C7 nests the club under m.club and the person under m.customer (there is no m.clubTitle / m.firstName)
    const perClub = Math.max(1, Math.min(limit, 50));
    const byClub = {};
    for (const m of memberships) {
      const title = m.club?.title || m.clubTitle || "Unknown";
      if (!byClub[title]) byClub[title] = { club: title, count: 0, members: [] };
      byClub[title].count++;
      byClub[title].members.push({
        name:        `${m.customer?.firstName || ""} ${m.customer?.lastName || ""}`.trim() || m.customerId || "",
        email:       m.customer?.emails?.[0]?.email || m.customer?.email || "",
        signup_date: pacificDay(m.signupDate || m.createdAt) || null,
        status:      m.status,
        ...(m.cancelDate ? { cancel_date: pacificDay(m.cancelDate) } : {}),
      });
    }
    for (const c of Object.values(byClub)) {
      c.members.sort((a, b) => (b.signup_date || "").localeCompare(a.signup_date || ""));   // most recent signups first
      c.members_shown = Math.min(perClub, c.members.length);
      c.members = c.members.slice(0, perClub);
    }
    return {
      status_filter: status,
      total_memberships: memberships.length,
      note: `members lists show up to ${perClub} most recent signups per club; raise limit (max 50) for more`,
      by_club: Object.values(byClub).sort((a, b) => b.count - a.count),
    };
  }

  // ── get_customers ──────────────────────────────────────────────────────────
  if (name === "get_customers") {
    const { search, limit = 10 } = args;
    const d = await c7Get(`/customer?q=${encodeURIComponent(search)}&limit=${Math.min(limit, 50)}`);
    const customers = d.customers || [];
    return {
      total_found: d.total,
      customers: customers.map(c => ({
        id:             c.id,
        name:           `${c.firstName || ""} ${c.lastName || ""}`.trim(),
        email:          c.emails?.[0]?.email || "",
        city:           c.city,
        state:          c.stateCode,
        club_status:    c.orderInformation?.currentClubTitle || "Not a member",
        lifetime_value: dollars(c.orderInformation?.lifetimeValue || 0),
        order_count:    c.orderInformation?.orderCount || 0,
        last_order:     c.orderInformation?.lastOrderDate || null,
        is_club_member: c.orderInformation?.isActiveClubMember || false,
      }))
    };
  }

  // ── get_reservations ───────────────────────────────────────────────────────
  if (name === "get_reservations") {
    const { from_date, to_date, status, limit = 20 } = args;
    let path = `/reservation?limit=${Math.min(limit, 50)}`;
    if (from_date) path += `&reservationDate=gt:${from_date}`;
    if (to_date)   path += `&reservationDate=lt:${to_date}`;
    if (status)    path += `&status=${status}`;
    const d = await c7Get(path);
    const reservations = d.reservations || [];
    return {
      total_available: d.total,
      returned: reservations.length,
      reservations: reservations.map(r => ({
        id:           r.id,
        date:         r.reservationDate,
        party_size:   r.partySize,
        status:       r.status,
        customer:     `${r.firstName || ""} ${r.lastName || ""}`.trim(),
        email:        r.email || "",
        phone:        r.phone || "",
        location:     LOCATION_NAMES[r.inventoryLocationId] || r.inventoryLocationId,
        notes:        r.notes || "",
      }))
    };
  }

  // ── get_coupons ────────────────────────────────────────────────────────────
  if (name === "get_coupons") {
    const { active_only = true } = args;
    const coupons = await paginate("/coupon", "coupons");
    const filtered = active_only ? coupons.filter(c => c.status === "Active") : coupons;
    return {
      total: filtered.length,
      coupons: filtered.map(c => ({
        code:        c.code,
        title:       c.title,
        status:      c.status,
        type:        c.type,
        value:       c.amount ? dollars(c.amount) : c.percent ? `${c.percent}%` : "N/A",
        uses:        c.useCount || 0,
        max_uses:    c.maxUses || "unlimited",
        expires:     c.expiryDate || "no expiry",
        min_order:   c.minimumOrderAmount ? dollars(c.minimumOrderAmount) : "none",
      }))
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── JSON-RPC helpers ───────────────────────────────────────────────────────────
const jrpc      = (id, result)        => JSON.stringify({ jsonrpc: "2.0", id, result });
const jrpcError = (id, code, message) => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

// ── HTTP Server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS headers on every response
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    res.writeHead(200); res.end("{}"); return;
  }

  if (req.method === "GET") {
    const url = req.url || "/";

    // OAuth protected resource metadata — tells Claude this server needs no auth
    if (url === "/.well-known/oauth-protected-resource" || url === "/.well-known/oauth-protected-resource/") {
      res.writeHead(200);
      res.end(JSON.stringify({
        resource: "https://shw-mcp-production.up.railway.app",
        authorization_servers: [],
        bearer_methods_supported: [],
        scopes_supported: []
      }));
      return;
    }

    // MCP discovery / health check
    res.writeHead(200);
    res.end(JSON.stringify({
      name: "shw-commerce7",
      version: "1.0.0",
      description: "Spruce Hill Winery Commerce7 MCP",
      authentication: { type: "none" }
    }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405); res.end(JSON.stringify({ error: "Method not allowed" })); return;
  }

  // Read body
  let body;
  try {
    const raw = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", chunk => data += chunk);
      req.on("end",  () => resolve(data));
      req.on("error", reject);
    });
    body = raw ? JSON.parse(raw) : {};
  } catch (e) {
    res.writeHead(200); res.end(jrpcError(null, -32700, "Parse error")); return;
  }

  const { id = null, method, params = {} } = body || {};
  if (!method) { res.writeHead(200); res.end(jrpcError(null, -32600, "Invalid request")); return; }

  try {
    let result;
    if (method === "initialize") {
      result = { protocolVersion: "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "shw-commerce7", version: "1.0.0" } };
    } else if (method === "notifications/initialized") {
      res.writeHead(200); res.end("{}"); return;
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      const toolResult = await executeTool(params.name, params.arguments || {});
      result = { content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }] };
    } else if (method === "ping") {
      result = {};
    } else {
      res.writeHead(200); res.end(jrpcError(id, -32601, `Method not found: ${method}`)); return;
    }
    res.writeHead(200); res.end(jrpc(id, result));
  } catch (e) {
    console.error("Tool error:", e.message);
    res.writeHead(200); res.end(jrpcError(id, -32603, e.message));
  }
});

server.listen(PORT, () => console.log(`SHW MCP server running on port ${PORT}`));
