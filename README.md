# IdeaChecker

An AI agent that gives your startup or business idea an honest, investor-grade
evaluation. Powered by Claude.

Enter an idea and get back:

- A **verdict** (promising / needs work / risky) with a one-line assessment
- **Scores** out of 10 for feasibility, market, originality, and monetization
- Specific **strengths**, **risks**, and suggested **next steps**

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # optional — without it the app runs in demo mode
npm start
```

Then open http://localhost:3000.

Without an API key the app serves a canned demo analysis so the UI is fully
explorable; with a key it calls Claude (`claude-opus-4-8` by default, override
with `IDEACHECKER_MODEL`) using structured outputs, so responses always match
the expected schema.

## Stack

- Plain Node.js HTTP server (`server.js`) — no framework
- Single-page frontend (`public/index.html`) — no build step
- [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) for the Claude API
