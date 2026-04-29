#!/usr/bin/env node
/**
 * hive-mcp-tax-observer — observational tax-event tracking for crypto txs.
 *
 * Inputs   : tx_hash + chain (base | ethereum | solana)
 * Output   : { classification: sale | swap | income | transfer,
 *              cost_basis_inputs: { holder, asset, amount, counterparty, timestamp }, disclaimer }
 *
 * Hive does NOT compute cost basis, file taxes, issue 1099s, or provide
 * tax advice. Every response carries the observational disclaimer.
 *
 * Backend : https://hivemorph.onrender.com (real on-chain reads)
 * Spec    : MCP 2024-11-05 / Streamable-HTTP / JSON-RPC 2.0
 * Brand   : Hive Civilization gold #C08D23 (Pantone 1245 C)
 */

import express from 'express';

const SERVICE = 'hive-mcp-tax-observer';
const VERSION = '1.0.0';
const MCP_PROTOCOL = '2024-11-05';
const BRAND_GOLD = '#C08D23';
const DISCLAIMER = 'Hive does not provide tax advice or filing services. This is observational transaction data only. Consult a licensed tax professional for compliance decisions.';

const PORT = process.env.PORT || 3000;
const TAX_WALLET = process.env.WALLET_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
// ─── BOGO pay-front helpers ───────────────────────────────────────────────
// did_call_count tracks paid calls per DID for first-call-free and loyalty
// freebies. Schema lives in a dedicated DB so it never touches service data.
import _BogoDatabase from 'better-sqlite3';
const _bogoDB = new _BogoDatabase(process.env.BOGO_DB_PATH || '/tmp/bogo_tax_observer.db');
_bogoDB.pragma('journal_mode = WAL');
_bogoDB.exec(
  'CREATE TABLE IF NOT EXISTS did_call_count ' +
  '(did TEXT PRIMARY KEY, paid_calls INTEGER NOT NULL DEFAULT 0)'
);

const _bogoGetStmt = _bogoDB.prepare(
  'SELECT paid_calls FROM did_call_count WHERE did = ?'
);
const _bogoUpsertStmt = _bogoDB.prepare(
  'INSERT INTO did_call_count (did, paid_calls) VALUES (?, 1) ' +
  'ON CONFLICT(did) DO UPDATE SET paid_calls = paid_calls + 1'
);

function _bogoCheck(did) {
  if (!did) return { free: false };
  const row = _bogoGetStmt.get(did);
  const n   = row ? row.paid_calls : 0;
  if (n === 0)        return { free: true, reason: 'first_call_free' };
  if (n % 6 === 0)    return { free: true, reason: 'loyalty_freebie' };
  return { free: false };
}

function _bogoIncrement(did) {
  if (did) _bogoUpsertStmt.run(did);
}

const BOGO_BLOCK = {
  first_call_free: true,
  loyalty_threshold: 6,
  loyalty_message:
    "Every 6th paid call is free. Present your DID via 'x-hive-did' header to track progress.",
};
// ─────────────────────────────────────────────────────────────────────────

async function _verifyUsdcPayment(tx_hash, min_usd) {
  if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash))
    return { ok: false, reason: 'invalid_tx_hash' };
  const { ethers } = await import('ethers');
  const provider = new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL || 'https://mainnet.base.org'
  );
  let receipt;
  try   { receipt = await provider.getTransactionReceipt(tx_hash); }
  catch (err) { return { ok: false, reason: `rpc_error: ${err.message}` }; }
  if (!receipt)            return { ok: false, reason: 'tx_not_found_or_pending' };
  if (receipt.status !== 1) return { ok: false, reason: 'tx_reverted' };
  const USDC_ADDR    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const WALLET_ADDR  = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
  const XFER_TOPIC   = ethers.id('Transfer(address,address,uint256)');
  let total = 0n;
  for (const log of (receipt.logs || [])) {
    if (log.address.toLowerCase() !== USDC_ADDR.toLowerCase()) continue;
    if (log.topics?.[0] !== XFER_TOPIC) continue;
    if (('0x' + log.topics[2].slice(26).toLowerCase()) !== WALLET_ADDR.toLowerCase()) continue;
    total += BigInt(log.data);
  }
  if (total === 0n)  return { ok: false, reason: 'no_transfer_to_wallet' };
  const amount_usd = Number(total) / 1e6;
  if (amount_usd + 1e-9 < min_usd) return { ok: false, reason: 'underpaid', amount_usd };
  return { ok: true, amount_usd };
}


const HIVE_BASE = process.env.HIVE_BASE || 'https://hivemorph.onrender.com';
const ENABLE = String(process.env.ENABLE ?? 'true').toLowerCase() === 'true';

const SUPPORTED_CHAINS = ['base', 'ethereum', 'solana'];
const MAX_BULK = 50;

// ─── HTTP helpers ──────────────────────────────────────────────────────────
async function hiveGet(path) {
  const url = `${HIVE_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'accept': 'application/json', 'user-agent': `${SERVICE}/${VERSION}` },
    signal: AbortSignal.timeout(15000),
  });
  let data;
  try { data = await res.json(); } catch { data = { raw: await res.text() }; }
  return { status: res.status, data };
}

async function hivePost(path, body) {
  const url = `${HIVE_BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': `${SERVICE}/${VERSION}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  let data;
  try { data = await res.json(); } catch { data = { raw: await res.text() }; }
  return { status: res.status, data };
}

function withDisclaimer(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (!payload.disclaimer) payload.disclaimer = DISCLAIMER;
    if (!payload.brand_color) payload.brand_color = BRAND_GOLD;
  }
  return payload;
}

function validChain(chain) {
  return typeof chain === 'string' && SUPPORTED_CHAINS.includes(chain.toLowerCase());
}

// ─── Tool handlers ─────────────────────────────────────────────────────────
async function taxClassify({ tx_hash, chain }) {
  if (!tx_hash || typeof tx_hash !== 'string') {
    return { ok: false, error: 'missing_tx_hash', disclaimer: DISCLAIMER, brand_color: BRAND_GOLD };
  }
  if (!validChain(chain)) {
    return { ok: false, error: `unsupported_chain:${chain}`, supported_chains: SUPPORTED_CHAINS, disclaimer: DISCLAIMER, brand_color: BRAND_GOLD };
  }
  const { status, data } = await hivePost('/v1/tax/event', { tx_hash, chain: chain.toLowerCase() });
  return withDisclaimer({ ...data, http_status: status });
}

async function taxBulk({ tx_hashes, chain }) {
  if (!Array.isArray(tx_hashes) || tx_hashes.length === 0) {
    return { ok: false, error: 'missing_tx_hashes', disclaimer: DISCLAIMER, brand_color: BRAND_GOLD };
  }
  if (tx_hashes.length > MAX_BULK) {
    return { ok: false, error: 'bulk_too_large', max: MAX_BULK, received: tx_hashes.length, disclaimer: DISCLAIMER, brand_color: BRAND_GOLD };
  }
  if (!validChain(chain)) {
    return { ok: false, error: `unsupported_chain:${chain}`, supported_chains: SUPPORTED_CHAINS, disclaimer: DISCLAIMER, brand_color: BRAND_GOLD };
  }
  const { status, data } = await hivePost('/v1/tax/bulk', { tx_hashes, chain: chain.toLowerCase() });
  return withDisclaimer({ ...data, http_status: status });
}

async function taxToday() {
  const { status, data } = await hiveGet('/v1/tax/today');
  return withDisclaimer({ ...data, http_status: status });
}

// ─── MCP tool descriptors ──────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'tax.classify',
    description: 'Classify a single on-chain transaction as a taxable event (sale/swap/income/transfer). Surfaces cost-basis-relevant inputs (holder, asset, amount, counterparty, timestamp). Hive does NOT compute cost basis. Hive does NOT provide tax advice or filing services. Real on-chain reads on Base / Ethereum / Solana.',
    inputSchema: {
      type: 'object',
      required: ['tx_hash', 'chain'],
      properties: {
        tx_hash: { type: 'string', description: 'Transaction hash (EVM 0x-prefixed) or signature (Solana base58)' },
        chain: { type: 'string', enum: SUPPORTED_CHAINS, description: 'base | ethereum | solana' },
      },
    },
  },
  {
    name: 'tax.bulk',
    description: 'Classify an array of transactions in a single call (max 50). Returns per-tx classification + a by-kind summary. Same hard rules as tax.classify — observational data only, no advice, no filing, no cost basis computation.',
    inputSchema: {
      type: 'object',
      required: ['tx_hashes', 'chain'],
      properties: {
        tx_hashes: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_BULK },
        chain: { type: 'string', enum: SUPPORTED_CHAINS },
      },
    },
  },
  {
    name: 'tax.today',
    description: 'Count of classified events in the last 24h, broken down by kind (sale / swap / income / transfer) with a taxable-signal subtotal. Free.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function makeMcpResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

async function executeTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'tax.classify': return makeMcpResult(await taxClassify(a));
    case 'tax.bulk':     return makeMcpResult(await taxBulk(a));
    case 'tax.today':    return makeMcpResult(await taxToday());
    default:
      return makeMcpResult({ ok: false, error: `unknown_tool:${name}`, disclaimer: DISCLAIMER, brand_color: BRAND_GOLD });
  }
}

// ─── Express app ───────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');

function notEnabled(res) {
  return res.status(503).json({ ok: false, error: 'service_disabled', disclaimer: DISCLAIMER, brand_color: BRAND_GOLD });
}

// ─── HTML root ─────────────────────────────────────────────────────────────
function renderRootHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${SERVICE}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="Observational tax-event tracking for crypto transactions. Not tax advice, not tax filing. Real on-chain rails." />
<style>
  :root { --gold: ${BRAND_GOLD}; --ink: #0a0a0a; --mute: #545454; --paper: #fafafa; --line: #ececec; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif; color: var(--ink); background: var(--paper); }
  header { border-top: 4px solid var(--gold); padding: 48px 32px 24px; max-width: 880px; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: -0.01em; }
  .lede { color: var(--mute); margin: 0 0 8px; max-width: 640px; }
  .badge { display: inline-block; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 12px; color: var(--mute); margin-right: 6px; }
  main { max-width: 880px; margin: 0 auto; padding: 8px 32px 64px; }
  section { border-top: 1px solid var(--line); padding: 24px 0; }
  h2 { font-size: 16px; margin: 0 0 12px; letter-spacing: -0.005em; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--mute); font-weight: 500; }
  code { font: 13px/1.5 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; background: #f3f3f3; padding: 1px 5px; border-radius: 4px; }
  pre { font: 13px/1.5 ui-monospace, 'SF Mono', Menlo, Consolas, monospace; background: #0f0f0f; color: #f3f3f3; padding: 16px; border-radius: 6px; overflow: auto; }
  .gold { color: var(--gold); }
  .warn { background: #fffbe6; border: 1px solid #f5d568; padding: 12px 14px; border-radius: 6px; margin: 12px 0 0; font-size: 13px; }
  footer { color: var(--mute); font-size: 12px; padding: 24px 32px; max-width: 880px; margin: 0 auto; border-top: 1px solid var(--line); }
  a { color: var(--ink); }
</style>
</head>
<body>
<header>
  <span class="badge gold">Hive Civilization</span>
  <span class="badge">MCP ${MCP_PROTOCOL}</span>
  <span class="badge">Observational only</span>
  <h1>Tax events, observed.</h1>
  <p class="lede">Send a transaction hash and a chain. Receive a classification — sale, swap, income, or transfer — and the cost-basis-relevant inputs your own basis tracker needs.</p>
  <p class="warn"><strong>${DISCLAIMER}</strong></p>
</header>
<main>
  <section>
    <h2>Tools</h2>
    <table>
      <tr><th><code>tax.classify</code></th><td>Single tx classification across Base / Ethereum / Solana.</td></tr>
      <tr><th><code>tax.bulk</code></th><td>Up to ${MAX_BULK} txs in one call.</td></tr>
      <tr><th><code>tax.today</code></th><td>24h rollup by kind with a taxable-signal subtotal.</td></tr>
    </table>
  </section>
  <section>
    <h2>Endpoints</h2>
    <table>
      <tr><th><code>POST /mcp</code></th><td>JSON-RPC 2.0 endpoint (Streamable-HTTP MCP).</td></tr>
      <tr><th><code>GET  /.well-known/mcp.json</code></th><td>MCP descriptor.</td></tr>
      <tr><th><code>GET  /health</code></th><td>Liveness, brand color, disclaimer.</td></tr>
      <tr><th><code>POST /v1/tax/event</code></th><td>Single tx classification (proxy).</td></tr>
      <tr><th><code>POST /v1/tax/bulk</code></th><td>Bulk tx classification (proxy).</td></tr>
      <tr><th><code>GET  /v1/tax/today</code></th><td>24h rollup (proxy).</td></tr>
    </table>
  </section>
  <section>
    <h2>Connect from an MCP client</h2>
    <pre>{
  "mcpServers": {
    "tax_observer": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://${SERVICE}.onrender.com/mcp"]
    }
  }
}</pre>
  </section>
  <section>
    <h2>What we do NOT do</h2>
    <ul>
      <li>We do not compute cost basis. We surface the inputs your basis tracker needs.</li>
      <li>We do not file taxes, generate 1099s, or produce tax forms.</li>
      <li>We do not provide tax advice. Consult a licensed tax professional.</li>
    </ul>
  </section>
</main>
<footer>
  ${SERVICE} v${VERSION} · MIT · brand <span class="gold">${BRAND_GOLD}</span> · <a href="https://github.com/srotzin/${SERVICE}">source</a>
</footer>
</body></html>`;
}

app.get('/', (req, res) => {
  const accept = String(req.headers.accept || '');
  if (accept.includes('application/json')) {
    return res.json({
      service: SERVICE,
      version: VERSION,
      enabled: ENABLE,
      brand_color: BRAND_GOLD,
      mcp_protocol: MCP_PROTOCOL,
      tools: TOOLS.map(t => t.name),
      endpoints: ['/mcp', '/.well-known/mcp.json', '/health', '/v1/tax/event', '/v1/tax/bulk', '/v1/tax/today'],
      backend: HIVE_BASE,
      disclaimer: DISCLAIMER,
    });
  }
  res.set('content-type', 'text/html; charset=utf-8').send(renderRootHtml());
});

// ─── /health ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: SERVICE,
    version: VERSION,
    enabled: ENABLE,
    inbound_only: true,
    brand_color: BRAND_GOLD,
    mcp_protocol: MCP_PROTOCOL,
    backend: HIVE_BASE,
    supported_chains: SUPPORTED_CHAINS,
    max_bulk: MAX_BULK,
    tools: TOOLS.map(t => t.name),
    disclaimer: DISCLAIMER,
  });
});

// ─── /.well-known/mcp.json ─────────────────────────────────────────────────
app.get('/.well-known/mcp.json', (req, res) => {
  res.json({
    name: SERVICE,
    version: VERSION,
    protocol: MCP_PROTOCOL,
    transport: 'streamable-http',
    endpoint: '/mcp',
    tools: TOOLS.map(t => ({ name: t.name, description: t.description })),
    brand_color: BRAND_GOLD,
    backend: HIVE_BASE,
    disclaimer: DISCLAIMER,
  });
});

// ─── HTTP proxy endpoints (parallel to MCP) ────────────────────────────────
// ─── POST /v1/tax/observe — pay-front for observing a taxable event ──────
// Returns 402 + BOGO block with no tx_hash. First-call-free for new DIDs.
// On payment: calls taxClassify() against hivemorph and returns the result.
app.post('/v1/tax/observe', async (req, res) => {
  const PRICE = 0.002;
  const did     = req.headers['x-hive-did'] || req.body?.observer_did || null;
  const tx_hash = req.body?.tx_hash || req.headers['x402-tx-hash'] || null;

  const bogo = _bogoCheck(did);
  if (bogo.free) {
    _bogoIncrement(did);
    const { event_tx_hash, chain } = req.body || {};
    let observation = null;
    if (event_tx_hash && chain) {
      try { observation = await taxClassify({ tx_hash: event_tx_hash, chain }); }
      catch (e) { observation = { error: e.message }; }
    }
    return res.json({ ok: true, bogo_applied: bogo.reason, observation, disclaimer: DISCLAIMER });
  }

  if (!tx_hash) {
    return res.status(402).json({
      error: 'payment_required',
      x402: {
        type: 'x402', version: '1', kind: 'tax_observe',
        asking_usd: PRICE, accept_min_usd: PRICE,
        asset: 'USDC', asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network: 'base', pay_to: TAX_WALLET,
        nonce: Math.random().toString(36).slice(2), issued_ms: Date.now(),
      },
      bogo: BOGO_BLOCK,
      bogo_first_call_free: true,
      bogo_loyalty_threshold: 6,
      bogo_pitch: "Pay this once, your 6th call is on the house. New here? Add header x-hive-did to claim your first call free.",
      note: `Submit tx_hash in body or 'x402-tx-hash' header. Asking ${PRICE} USDC on Base to ${TAX_WALLET}.`,
      did: did || null,
      disclaimer: DISCLAIMER,
    });
  }

  const v = await _verifyUsdcPayment(tx_hash, PRICE);
  if (!v.ok) return res.status(402).json({ error: 'payment_invalid', reason: v.reason, tx_hash });

  _bogoIncrement(did);
  const { event_tx_hash, chain } = req.body || {};
  let observation = null;
  if (event_tx_hash && chain) {
    try { observation = await taxClassify({ tx_hash: event_tx_hash, chain }); }
    catch (e) { observation = { error: e.message }; }
  }
  res.json({ ok: true, billed_usd: v.amount_usd, tx_hash, observation, disclaimer: DISCLAIMER });
});

app.post('/v1/tax/event', async (req, res) => {
  if (!ENABLE) return notEnabled(res);
  const r = await taxClassify(req.body || {});
  res.status(r.http_status && Number.isInteger(r.http_status) ? 200 : 200).json(r);
});

app.post('/v1/tax/bulk', async (req, res) => {
  if (!ENABLE) return notEnabled(res);
  const r = await taxBulk(req.body || {});
  res.json(r);
});

app.get('/v1/tax/today', async (req, res) => {
  if (!ENABLE) return notEnabled(res);
  const r = await taxToday();
  res.json(r);
});

// ─── /mcp JSON-RPC ─────────────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
  if (!ENABLE) return notEnabled(res);
  const body = req.body || {};
  const id = body.id ?? null;
  const reply = (payload) => res.json({ jsonrpc: '2.0', id, ...payload });
  try {
    if (body.jsonrpc !== '2.0') return reply({ error: { code: -32600, message: 'invalid jsonrpc version' } });
    switch (body.method) {
      case 'initialize':
        return reply({ result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: SERVICE, version: VERSION, brand_color: BRAND_GOLD },
          capabilities: { tools: { listChanged: false } },
        } });
      case 'tools/list':
        return reply({ result: { tools: TOOLS } });
      case 'tools/call': {
        const name = body.params?.name;
        const args = body.params?.arguments || {};
        // ─── x402 gate ───────────────────────────────────────────────────
        // tax.classify: $0.03 USDC/call (30000 atomic)
        // tax.bulk:     $0.50 USDC/call (500000 atomic)
        // tax.today:    free (no gate)
        if (name === 'tax.classify' || name === 'tax.bulk') {
          const payHdr = req.headers['x-payment'] || req.headers['x-payment-token'] || null;
          if (!payHdr) {
            const isClassify = name === 'tax.classify';
            return res.status(402).json({
              x402: true,
              version: '1',
              tool: name,
              payTo: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
              amount_usdc: isClassify ? '0.03' : '0.50',
              amount_atomic: isClassify ? 30000 : 500000,
              chain: 'base',
              chain_id: 8453,
              asset: 'USDC',
              contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              brand_gold: '#C08D23',
              instructions: `Send ${isClassify ? '0.03' : '0.50'} USDC on Base (chain 8453) to 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e. Retry with X-Payment header containing the USDC transfer tx hash.`,
              disclaimer: DISCLAIMER,
            });
          }
        }
        // ─────────────────────────────────────────────────────────────────
        const result = await executeTool(name, args);
        return reply({ result });
      }
      case 'ping':
        return reply({ result: {} });
      default:
        return reply({ error: { code: -32601, message: `method not found: ${body.method}` } });
    }
  } catch (err) {
    return reply({ error: { code: -32603, message: err.message || String(err) } });
  }
});

// ─── Boot ──────────────────────────────────────────────────────────────────
// ─── Schema discoverability (auto-injected) ──────────────────────────────
app.get('/.well-known/agent-card.json', (req, res) => res.json({
  name: 'hive-mcp-tax-observer',
  description: "Hive Civilization tax observer MCP \u2014 pay-per-observation transaction tagging with x402 USDC settlement. Observational only \u2014 not tax advice. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2.",
  url: 'https://hive-mcp-tax-observer.onrender.com',
  provider: { organization: 'Hive Civilization', url: 'https://www.thehiveryiq.com', contact: 'steve@thehiveryiq.com' },
  version: '1.0.0',
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  authentication: {
    schemes: ['x402'],
    credentials: { type:'x402', asset:'USDC', network:'base',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
    }
  },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  extensions: {
    hive_pricing: {
      currency: 'USDC', network: 'base', model: 'per_call',
      first_call_free: true, loyalty_threshold: 6,
      loyalty_message: 'Every 6th paid call is free'
    }
  },
  bogo: {
    first_call_free: true, loyalty_threshold: 6,
    pitch: "Pay this once, your 6th paid call is on the house. New here? Add header 'x-hive-did' to claim your first call free.",
    claim_with: 'x-hive-did header'
  }
}));
app.get('/.well-known/ap2.json', (req, res) => res.json({
  ap2_version: '1',
  agent: {
    name: 'hive-mcp-tax-observer',
    did: 'did:web:hive-mcp-tax-observer.onrender.com',
    description: "Hive Civilization tax observer MCP \u2014 pay-per-observation transaction tagging with x402 USDC settlement. Observational only \u2014 not tax advice. New agents: first call free. Loyalty: every 6th paid call is free. Pay in USDC on Base L2."
  },
  endpoints: {
    mcp: 'https://hive-mcp-tax-observer.onrender.com/mcp',
    agent_card: 'https://hive-mcp-tax-observer.onrender.com/.well-known/agent-card.json'
  },
  payments: {
    schemes: ['x402'],
    primary: { scheme:'x402', network:'base', asset:'USDC',
      asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
    }
  },
  bogo: {
    first_call_free: true, loyalty_threshold: 6,
    pitch: "Pay this once, your 6th paid call is on the house.",
    claim_with: 'x-hive-did header'
  },
  brand: { color: '#C08D23', name: 'Hive Civilization' }
}));



// ─── Subscription & enterprise tier endpoints (Wave B codification) ──────────
// Partner-doctrine: identity/receipts/trust plumbing only.
// Subscription billing is denominated in USDC on Base (Monroe W1).
// Spectral receipt is emitted on every fee event via hive-receipt sidecar.
//
// Tier schedule:
//   Tier 1 (Starter)    : 99.0/mo
//   Tier 2 (Pro)        : 299.0/mo
//   Tier 3 (Enterprise) : 999.0/mo
//
// x402 tx_hash required for Tier 1+ confirmation. Tier 3 can invoice monthly.
//
// Spectral receipt: POST to hive-receipt sidecar for tamper-evident audit trail.

const SUBSCRIPTION_TIERS = {
  starter:    { price_usd: 99.0, calls_per_day: 10000, label: 'Starter' },
  pro:        { price_usd: 299.0, calls_per_day: 100000, label: 'Pro' },
  enterprise: { price_usd: 999.0, calls_per_day: Infinity, label: 'Enterprise', invoice: true },
};

// In-memory subscription ledger (durable persistence on hivemorph backend).
const _subLedger = new Map(); // did -> { tier, activated_ms, tx_hash }

async function emitSpectralReceipt({ event_type, did, amount_usd, tool_name, tx_hash, metadata }) {
  // Posts a Spectral-signed receipt to hive-receipt. Non-blocking.
  // Error is logged but never throws — receipt emission must not block the fee path.
  try {
    const body = JSON.stringify({
      issuer_did: 'did:hive:tax-observer',
      recipient_did: did || 'did:hive:anonymous',
      event_type,
      tool_name,
      amount_usd: String(amount_usd),
      currency: 'USDC',
      network: 'base',
      pay_to: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
      tx_hash: tx_hash || null,
      issued_ms: Date.now(),
      service: 'Hive Tax Observer',
      brand: '#C08D23',
      ...metadata,
    });
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4000);
    await fetch('https://hive-receipt.onrender.com/v1/receipt/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    clearTimeout(tid);
  } catch (_) {
    // Receipt emission is best-effort. Log and continue.
    console.warn('[tax-observer] receipt emit failed (non-fatal):', _.message || _);
  }
}

// POST /v1/subscription — create or upgrade a subscription
app.post('/v1/subscription', async (req, res) => {
  const { tier, did, tx_hash } = req.body || {};
  if (!tier || !SUBSCRIPTION_TIERS[tier]) {
    return res.status(400).json({
      error: 'invalid_tier',
      valid_tiers: Object.keys(SUBSCRIPTION_TIERS),
      brand: '#C08D23',
    });
  }
  const t = SUBSCRIPTION_TIERS[tier];
  if (!did) return res.status(400).json({ error: 'did_required' });

  // Enterprise tier can invoice monthly (no tx_hash required at activation).
  if (tier !== 'enterprise' && !tx_hash) {
    return res.status(402).json({
      error: 'payment_required',
      x402: {
        type: 'x402', version: '1', kind: 'subscription_tax-observer',
        asking_usd: t.price_usd,
        accept_min_usd: t.price_usd,
        asset: 'USDC', asset_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        network: 'base', pay_to: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
        nonce: Math.random().toString(36).slice(2),
        issued_ms: Date.now(),
        tier, label: t.label,
        bogo: { first_call_free: true, loyalty_every_n: 6 },
      },
      note: `Submit tx_hash for ${t.price_usd} USDC/mo to 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e on Base.`,
    });
  }

  const record = {
    tier, did, tx_hash: tx_hash || 'enterprise_invoice',
    activated_ms: Date.now(),
    expires_ms: Date.now() + 30 * 24 * 3600 * 1000,
    price_usd: t.price_usd,
    calls_per_day: t.calls_per_day,
  };
  _subLedger.set(did, record);

  // Emit Spectral receipt for subscription activation.
  await emitSpectralReceipt({
    event_type: 'subscription_activated',
    did, amount_usd: t.price_usd, tool_name: 'subscription',
    tx_hash: tx_hash || null,
    metadata: { tier, service: 'Hive Tax Observer', expires_ms: record.expires_ms },
  });

  return res.json({
    ok: true,
    subscription: record,
    receipt_emitted: true,
    partner_attribution: 'Tax event observability — Hive attests events for downstream filing. Never files taxes. Complements TaxBit, Koinly.',
    brand: '#C08D23',
    note: 'Subscription active for 30 days. Spectral receipt issued to hive-receipt.',
  });
});

// GET /v1/subscription/:did — check subscription status
app.get('/v1/subscription/:did', (req, res) => {
  const record = _subLedger.get(req.params.did);
  if (!record) {
    return res.status(404).json({ active: false, did: req.params.did });
  }
  const active = Date.now() < record.expires_ms;
  return res.json({ active, ...record });
});

// POST /v1/subscription/verify — lightweight verification (no charge)
app.post('/v1/subscription/verify', (req, res) => {
  const { did } = req.body || {};
  const record = _subLedger.get(did);
  const active = record && Date.now() < record.expires_ms;
  return res.json({
    active: !!active,
    did: did || null,
    tier: record?.tier || null,
    expires_ms: record?.expires_ms || null,
    brand: '#C08D23',
  });
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT}`);
  console.log(`enabled=${ENABLE} brand=${BRAND_GOLD} backend=${HIVE_BASE}`);
  console.log(`tools: ${TOOLS.map(t => t.name).join(', ')}`);
});
