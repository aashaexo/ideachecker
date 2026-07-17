# IdeaChecker

An AI research agent that evaluates startup and business ideas. Pitch an idea
and the agent researches the live market with web search, then tells you
straight whether it's good — and what you're up against.

Every report includes:

- A **verdict** (promising / needs work / risky) with a one-line assessment
- **Scores** out of 10 for market, feasibility, originality, and monetization
- **Market reality** — how many people/companies have already built this, and
  how saturated the space is
- **Competitors** — who they are, what they do, **who raised money** (amounts,
  rounds, status: active / acquired / shut down)
- **Difficulty** — how easy it is to build, estimated time to MVP, and the key
  challenges
- Specific **strengths**, **risks**, and suggested **next steps**
- **Sources** — links found during research

## How it works

Two-stage agent pipeline (`server.js`):

1. **Research** — Claude (`claude-opus-4-8`) runs live web search + web fetch
   (server-side tools, including `pause_turn` continuation handling) to find
   competitors, funding rounds, shutdowns, and difficulty signals, and writes a
   research brief.
2. **Structure** — a second call converts the brief into a strict JSON report
   via structured outputs, so responses always match the expected schema.

Source URLs are collected from the web-search result blocks and returned with
the report.

## Budget cap

Total API spend is hard-capped at **$4 by default**. The server computes the
real cost of every API call from the response's usage data (input/output
tokens, cache tokens, and web searches at $10/1k) and persists the running
total to `budget.json` (gitignored), so the cap survives restarts. Once the
cap is reached, live analyses return HTTP 429 until you raise the cap or reset
the file:

```bash
export IDEACHECKER_BUDGET_USD=10   # raise the cap
rm budget.json                     # or reset the spend counter
```

Current spend is visible at `GET /api/budget` and in the UI under the idea box.
A typical live analysis costs roughly $0.10–$0.30, so $4 covers on the order of
15–40 idea checks. (Note: concurrent requests are each checked against the cap
when they start, so simultaneous analyses can overshoot it by at most one
in-flight analysis.)

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # optional — without it the app runs in demo mode
npm start
```

Then open http://localhost:3000. A full live analysis typically takes 1–2
minutes (real web research). Override the model with `IDEACHECKER_MODEL`.

Without an API key the app serves a clearly-labeled sample report so the UI is
fully explorable.

## Stack

- Plain Node.js HTTP server (`server.js`) — no framework
- Single-page frontend (`public/index.html`) — no build step
- [`@anthropic-ai/sdk`](https://github.com/anthropics/anthropic-sdk-typescript) for the Claude API
