# Browser MCP server comparison

Generated: 2026-11-10T00:01:47.435Z

Measured locally with a hermetic `/form` page. RSS is the full process tree after the first snapshot.
This is a tool-layer comparison, not a model task-success benchmark.

| Server | Tools | Schema bytes | Startup | Navigate | Snapshot chars | RSS (MB) | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cat-burglar (ours) | 30 | 24274 | 163 ms | 984 ms | 553 | 993.7 | ok |
| Playwright MCP | 25 | 21177 | 2024 ms | 402 ms | 841 | 1232.3 | ok |
| Chrome DevTools MCP | 32 | 28918 | 844 ms | 452 ms | 859 | 1029.9 | ok |
| Obscura MCP | 38 | 13258 | 3 ms | 19 ms | 572 | 43 | ok |

