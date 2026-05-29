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
    description: "Get wine bottle sales from Commerce7 orders. Filter by date range and channel. Returns revenue and bottles sold per wine.",
    inputSchema: { type: "object", properties: {
      from_date:  { type: "string", description: "Start date YYYY-MM-DD" },
      to_date:    { type: "string", description: "End date YYYY-MM-DD" },
      channel:    { type: "string", enum: ["all","Web","POS","Club"], default: "all" },
      wine_only:  { type: "boolean", default: true },
    }, required: ["from_date","to_date"] },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "get_orders",
    description: "Get recent orders with full detail. Filter by date, channel, customer name, or order number.",
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
    const { from_date, to_date, channel = "all", wine_only = true } = args;
    let params = `&orderCreatedDate=gt:${from_date}&orderCreatedDate=lt:${to_date}&paymentStatus=Paid`;
    if (channel !== "all") params += `&channel=${channel}`;
    const orders = await paginate("/order?paymentStatus=Paid", "orders", `&orderCreatedDate=gt:${from_date}&orderCreatedDate=lt:${to_date}${channel !== "all" ? `&channel=${channel}` : ""}`);
    const wineRe = /^20\d\d_/;
    const byProduct = {};
    let totalRevenue = 0, totalBottles = 0, orderIds = new Set();
    for (const o of orders) {
      let hasWine = false;
      for (const item of (o.items || [])) {
        const isWine = wineRe.test(item.sku);
        if (wine_only && !isWine) continue;
        if (!byProduct[item.sku]) byProduct[item.sku] = { title: item.productTitle, sku: item.sku, bottles: 0, revenue: 0, order_ids: new Set() };
        byProduct[item.sku].bottles   += item.quantity;
        byProduct[item.sku].revenue   += item.price * item.quantity;
        byProduct[item.sku].order_ids.add(o.id);
        totalRevenue += item.price * item.quantity;
        totalBottles += item.quantity;
        if (isWine) hasWine = true;
      }
      if (hasWine || !wine_only) orderIds.add(o.id);
    }
    const wines = Object.values(byProduct)
      .map(r => ({ title: r.title, sku: r.sku, bottles: r.bottles, cases: Math.floor(r.bottles / BPC), revenue: dollars(r.revenue), avg_price: r.bottles > 0 ? dollars(r.revenue / r.bottles) : "$0", orders: r.order_ids.size }))
      .sort((a, b) => b.bottles - a.bottles);
    return { period: `${from_date} to ${to_date}`, channel: channel === "all" ? "All channels" : channel, summary: { total_orders: orderIds.size, total_bottles: totalBottles, total_cases: Math.floor(totalBottles / BPC), total_revenue: dollars(totalRevenue) }, by_wine: wines };
  }

  // ── get_orders ─────────────────────────────────────────────────────────────
  if (name === "get_orders") {
    const { from_date, to_date, channel = "all", customer_name, limit = 20 } = args;
    let path = "/order?paymentStatus=Paid";
    if (from_date) path += `&orderCreatedDate=gt:${from_date}`;
    if (to_date)   path += `&orderCreatedDate=lt:${to_date}`;
    if (channel !== "all") path += `&channel=${channel}`;
    const d = await c7Get(`${path}&limit=${Math.min(limit, 50)}`);
    let orders = d.orders || [];
    if (customer_name) {
      const q = customer_name.toLowerCase();
      orders = orders.filter(o => {
        const fn = (o.shipTo?.firstName || "").toLowerCase();
        const ln = (o.shipTo?.lastName || "").toLowerCase();
        return fn.includes(q) || ln.includes(q) || `${fn} ${ln}`.includes(q);
      });
    }
    return {
      total_available: d.total,
      returned: orders.length,
      orders: orders.map(o => ({
        order_number:  o.orderNumber,
        date:          o.orderCreatedDate,
        channel:       o.channel,
        customer:      `${o.shipTo?.firstName || ""} ${o.shipTo?.lastName || ""}`.trim(),
        total:         dollars(o.total),
        subtotal:      dollars(o.subTotal),
        item_count:    o.items?.length || 0,
        items:         (o.items || []).map(i => ({ title: i.productTitle, sku: i.sku, qty: i.quantity, price: dollars(i.price) })),
        fulfillment:   o.fulfillmentStatus,
        customer_type: o.customerType,
      }))
    };
  }

  // ── get_club_members ───────────────────────────────────────────────────────
  if (name === "get_club_members") {
    const { status = "Active", limit = 50 } = args;
    const path = status === "all" ? "/club-membership?limit=50" : `/club-membership?status=${status}&limit=50`;
    const memberships = await paginate(status === "all" ? "/club-membership" : `/club-membership?status=${status}`, "clubMemberships");
    const byClub = {};
    for (const m of memberships) {
      const title = m.clubTitle || "Unknown";
      if (!byClub[title]) byClub[title] = { club: title, count: 0, members: [] };
      byClub[title].count++;
      if (byClub[title].members.length < 5) {
        byClub[title].members.push({ name: `${m.firstName || ""} ${m.lastName || ""}`.trim(), email: m.email, signup_date: m.signupDate, status: m.status });
      }
    }
    return { status_filter: status, total_memberships: memberships.length, by_club: Object.values(byClub).sort((a, b) => b.count - a.count) };
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
