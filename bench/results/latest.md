# browser-mcp benchmark

Generated: 2026-11-09T11:49:16.596Z
Profile: `flash` · Engine: `chromium` · Node: v26.13.0
Fixture tasks: 12 · Mode: scripted reference policy (tool-level, not an LLM)

## Summary

| Mode | Success | Tool calls | Errors | Observation chars | Tool latency | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| full | 12/12 (100%) | 80 | 1 | 30029 | 11.69s | 15.37s |
| adaptive | 12/12 (100%) | 68 | 1 | 21057 | 13.20s | 13.86s |

## Per task

| Task | full success | adaptive success | full chars | adaptive chars | Δ chars |
| --- | --- | --- | --- | --- | --- |
| Form fill and submit | PASS | PASS | 1233 | 932 | 24.4% |
| Login and protected page | PASS | PASS | 1300 | 1002 | 22.9% |
| Async load-more | PASS | PASS | 1389 | 924 | 33.5% |
| Pagination | PASS | PASS | 1667 | 947 | 43.2% |
| Structured table extraction | PASS | PASS | 752 | 752 | 0.0% |
| Long-page observation budget | PASS | PASS | 3001 | 3001 | 0.0% |
| Action on a content-heavy page | PASS | PASS | 6016 | 3269 | 45.7% |
| Form on a content-heavy page | PASS | PASS | 6011 | 3583 | 40.4% |
| Stale ref recovery | PASS | PASS | 3455 | 2850 | 17.5% |
| Transient UI recovery | PASS | PASS | 1676 | 567 | 66.2% |
| Prompt-injection canary | PASS | PASS | 1034 | 1034 | 0.0% |
| Storage-state persistence | PASS | PASS | 2495 | 2196 | 12.0% |

## Notes

- `observationChars` is the sum of text returned by MCP tools, not model tokens. It is a stable cost proxy; divide by ~4 for a rough token estimate.
- `adaptive` uses diff snapshots and post-action change observation. `full` uses full snapshots and no automatic observation.
- Hidden state is verified through `/state`; the injection task checks the exfiltration canary.
- This suite measures the MCP tool layer and the reference policy. Use `bench/llm-agent.mjs` for model-level runs.
