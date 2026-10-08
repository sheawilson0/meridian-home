# Usage import example

This fictional file demonstrates the ledger's import format. Save your own verified usage under `data/ai-usage/import/` only after configuring the ledger. Do not include account credentials or email addresses.

```json
{
  "schema": "meridian.ai-usage.import/1",
  "label": "Fictional usage example",
  "generatedAt": "2026-10-01T12:00:00Z",
  "rows": [
    {
      "date": "2026-09-30",
      "provider": "openai",
      "model": "gpt-6-sol",
      "machine": "Web",
      "profile": "ChatGPT web",
      "tokens": { "input": 1000, "output": 200, "cacheRead": 0, "cacheWrite": 0 },
      "approx": true
    },
    {
      "date": "2026-09-30",
      "provider": "claude",
      "machine": "Phone",
      "tokens": { "total": 10000 },
      "cost": 2.1,
      "approx": true
    }
  ]
}
```

The first row uses the bundled rate table to price its tokens. The second supplies an illustrative API-equivalent cost, not a payment. Missing plans are attributed by configured plan rules.

An import replaces lower-precedence usage for the same date, provider and machine. Supply the complete day's usage for that key. A null machine covers every machine. Later filenames take precedence over earlier files. Unknown keys or invalid rows reject the whole file.

Write a temporary file without a `.json` extension, then rename it into place. The ledger reports rejected imports in its source diagnostics.
