# Hive Tax Observer

[![srotzin/hive-mcp-tax-observer MCP server](https://glama.ai/mcp/servers/srotzin/hive-mcp-tax-observer/badges/score.svg)](https://glama.ai/mcp/servers/srotzin/hive-mcp-tax-observer)

**Observational tax-event tracking for crypto transactions. Real on-chain rails. Not tax advice. Not tax filing.**

> **Hive does not provide tax advice or filing services. This is observational transaction data only. Consult a licensed tax professional for compliance decisions.**

`hive-mcp-tax-observer` is a Model Context Protocol (MCP) server that classifies a settled on-chain transaction
into one of four observational kinds — **sale**, **swap**, **income**, or **transfer** — and surfaces the
cost-basis-relevant inputs (holder, asset, amount, counterparty, timestamp) your own basis tracker needs.
Real reads against Base mainnet, Ethereum mainnet, and Solana mainnet via public RPC.

We do **not** compute cost basis. We do **not** file taxes. We do **not** generate 1099s or any tax forms.
Every response — including health, errors, and bulk responses — carries the observational disclaimer.

---

## What this is

- **Protocol:** MCP 2024-11-05 over Streamable-HTTP / JSON-RPC 2.0
- **Transport:** `POST /mcp`
- **Discovery:** `GET /.well-known/mcp.json`
- **Health:** `GET /health` (200, brand_color, disclaimer, enabled, supported_chains)
- **Backend:** [`https://hivemorph.onrender.com`](https://hivemorph.onrender.com) — `/v1/tax/*`
- **Brand:** Hive Civilization gold `#C08D23` (Pantone 1245 C)

## Tools

| Tool | Description |
|---|---|
| `tax.classify` | Classify a single tx_hash + chain as **sale**, **swap**, **income**, or **transfer**. Returns the cost-basis-relevant inputs and the disclaimer. |
| `tax.bulk` | Classify an array of tx hashes (max 50) in a single call. Returns per-tx results plus a by-kind summary. |
| `tax.today` | 24-hour rollup of classified events by kind, with a taxable-signal subtotal. Free. |

## Backend endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/tax/event` | Single tx classification |
| `POST` | `/v1/tax/bulk` | Bulk tx classification (max 50) |
| `GET` | `/v1/tax/today` | 24h rollup |
| `GET` | `/v1/tax/health` | Service liveness |

## Classification model

Every classification is **observational** and derived from on-chain data alone:

| Kind | Signal |
|---|---|
| `sale` | Sender sent assets out with no offsetting inflow (likely disposition). |
| `swap` | Sender both sent and received assets in the same tx (DEX-style). |
| `income` | Sender received assets with no offsetting outflow. |
| `transfer` | Same beneficial owner, no taxable inflow or outflow detected from this address. |

A `taxable_signal: true` flag is set when the kind is one of `sale`, `swap`, or `income`.
**This is not a tax determination.** It is a heuristic signal derived from the agent-supplied tx hash.

## Run locally

```bash
git clone https://github.com/srotzin/hive-mcp-tax-observer.git
cd hive-mcp-tax-observer
npm install
npm start
# server up on http://localhost:3000/mcp
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/mcp.json
```

## Connect from an MCP client

**Claude Desktop / Cursor / Manus** — add to your `mcp.json`:

```json
{
  "mcpServers": {
    "tax_observer": {
      "command": "npx",
      "args": ["-y", "mcp-remote@latest", "https://hive-mcp-tax-observer.onrender.com/mcp"]
    }
  }
}
```

## Quickstart

```bash
# Classify a single Base transaction
curl -sX POST https://hive-mcp-tax-observer.onrender.com/v1/tax/event \
  -H 'content-type: application/json' \
  -d '{"tx_hash":"0x...","chain":"base"}' | jq

# 24h rollup (free)
curl -s https://hive-mcp-tax-observer.onrender.com/v1/tax/today | jq

# Bulk
curl -sX POST https://hive-mcp-tax-observer.onrender.com/v1/tax/bulk \
  -H 'content-type: application/json' \
  -d '{"chain":"base","tx_hashes":["0x...","0x..."]}' | jq
```

## What we do NOT do

- We do **not** compute cost basis. We surface the inputs your basis tracker needs.
- We do **not** file taxes, generate 1099s, or produce tax forms.
- We do **not** make compliance determinations.
- We do **not** provide tax advice. **Consult a licensed tax professional.**

## Hive Civilization

Part of the [Hive Civilization](https://www.thehiveryiq.com) — sovereign DID, USDC settlement, agent-to-agent rails.

Categories: finance, tax, compliance, web3, agent-to-agent, observability.

## License

MIT (c) Steve Rotzin / Hive Civilization

## Hive Civilization Directory

Part of the Hive Civilization — agent-native financial infrastructure.

- Endpoint Directory: https://thehiveryiq.com
- Live Leaderboard: https://hive-a2amev.onrender.com/leaderboard
- Revenue Dashboard: https://hivemine-dashboard.onrender.com
- Other MCP Servers: https://github.com/srotzin?tab=repositories&q=hive-mcp

Brand: #C08D23
<!-- /hive-footer -->
