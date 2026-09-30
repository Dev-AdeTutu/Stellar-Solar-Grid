// Example bot (#891): keeps a buy/sell quote around a mid price and listens for fills.
// Usage: API_KEY=sg_... BASE=http://localhost:3001 node simple-market-maker.mjs
const BASE = process.env.BASE ?? "http://localhost:3001";
const headers = { "Content-Type": "application/json", "X-API-Key": process.env.API_KEY };
const MID = Number(process.env.MID_PRICE ?? 0.12), SPREAD = 0.01;

async function api(method, path, body) {
  const r = await fetch(`${BASE}/api/trading${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (r.status === 429) { await new Promise((s) => setTimeout(s, 1000)); return api(method, path, body); }
  return r.status === 204 ? null : r.json();
}

let open = [];
async function requote() {
  await Promise.all(open.map((id) => api("DELETE", `/orders/${id}`)));
  const bid = await api("POST", "/orders", { side: "buy", kwh: 5, price: +(MID - SPREAD).toFixed(4) });
  const ask = await api("POST", "/orders", { side: "sell", kwh: 5, price: +(MID + SPREAD).toFixed(4) });
  open = [bid.id, ask.id];
  console.log("quoted", bid.price, ask.price);
}

const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/trading/ws?apiKey=${process.env.API_KEY}`);
ws.onmessage = (m) => console.log("feed", m.data);
await requote();
setInterval(requote, 30_000);
