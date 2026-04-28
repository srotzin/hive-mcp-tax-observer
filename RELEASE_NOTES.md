# Release Notes — hive-mcp-tax-observer

## v1.0.0 — 2026-04-28

First public release of the Hive Tax Observer MCP shim.

### Highlights

- **Observational only.** Hive does NOT provide tax advice, file taxes, issue 1099s, or compute cost basis. Every
  response carries the disclaimer:
  > Hive does not provide tax advice or filing services. This is observational transaction data only. Consult a
  > licensed tax professional for compliance decisions.

- **Real on-chain rails.** Reads against Base mainnet, Ethereum mainnet, and Solana mainnet via public RPC. No
  mocks. No simulated data.

- **Tools exposed**
  - `tax.classify(tx_hash, chain)` — single-tx classification (sale / swap / income / transfer) and cost-basis
    inputs (holder, asset, amount, counterparty, timestamp).
  - `tax.bulk(tx_hashes[], chain)` — array classification (max 50 per call) with by-kind summary.
  - `tax.today()` — 24-hour rollup by kind with taxable-signal subtotal. Free.

- **Backend.** Proxies to `https://hivemorph.onrender.com/v1/tax/*` (Tier B position 3).

- **MCP.** Streamable-HTTP, MCP 2024-11-05, JSON-RPC 2.0. ESM Node.js, `express` only.

- **Brand.** Hive Civilization gold `#C08D23` (Pantone 1245 C).

### What this release does NOT do

- No cost-basis computation.
- No 1099 / W-9 / W-8 / W-2 generation.
- No tax filing.
- No tax advice.
- No compliance determinations.

### Connect

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
