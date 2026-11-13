# browser-mcp benchmark

Generated: 2026-11-13T00:44:10.730Z
Profile: `flash` · Engine: `chromium` · Node: v26.13.0
Fixture tasks: 12 · Mode: scripted reference policy (tool-level, not an LLM)

## Summary

| Mode | Success | Tool calls | Errors | Observation chars | Tool latency | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| full | 12/12 (100%) | 80 | 1 | 34497 | 11.50s | 15.18s |
| adaptive | 12/12 (100%) | 68 | 1 | 25921 | 12.14s | 12.81s |

## Per task

| Task | full success | adaptive success | full chars | adaptive chars | Δ chars |
| --- | --- | --- | --- | --- | --- |
| Form fill and submit | PASS | PASS | 1161 | 896 | 22.8% |
| Login and protected page | PASS | PASS | 1192 | 930 | 22.0% |
| Async load-more | PASS | PASS | 1281 | 852 | 33.5% |
| Pagination | PASS | PASS | 1559 | 911 | 41.6% |
| Structured table extraction | PASS | PASS | 716 | 716 | 0.0% |
| Long-page observation budget | PASS | PASS | 3001 | 3001 | 0.0% |
| Action on a content-heavy page | PASS | PASS | 5980 | 3233 | 45.9% |
| Form on a content-heavy page | PASS | PASS | 5975 | 3547 | 40.6% |
| Stale ref recovery | PASS | PASS | 3654 | 3121 | 14.6% |
| Transient UI recovery | PASS | PASS | 1532 | 531 | 65.3% |
| Prompt-injection canary | PASS | PASS | 952 | 952 | 0.0% |
| Storage-state persistence | PASS | PASS | 7494 | 7231 | 3.5% |

## Notes

- `observationChars` is the sum of text returned by MCP tools, not model tokens. It is a stable cost proxy; divide by ~4 for a rough token estimate.
- `adaptive` uses diff snapshots and post-action change observation. `full` uses full snapshots and no automatic observation.
- Hidden state is verified through `/state`; the injection task checks the exfiltration canary.
- This suite measures the MCP tool layer and the reference policy. Use `bench/llm-agent.mjs` for model-level runs.
