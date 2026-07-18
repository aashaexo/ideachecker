# IdeaChecker 💡

An open-source AI research agent that tells you the truth about your startup
idea. Pitch an idea, and the agent deep-researches the live web — then reports
whether it's good, **who already built it**, **who raised money**, and **how
hard it is to pull off**.

Built on the [Parallel](https://parallel.ai) Task API: one research task per
check, at a flat price of a few cents.

## What you get for every idea

- ✅ **Verdict** — promising / needs work / risky, with a blunt one-liner
- 📊 **Scores** out of 10 — market, feasibility, originality, monetization
- 🌍 **Market reality** — how many companies/people already built this, and how
  saturated the space is
- 🏢 **Competitors** — who they are, what they do, funding raised (round, year,
  investors), and status (active / acquired / shut down)
- 🔨 **Difficulty** — how hard it is to build, time to MVP, key challenges
- 💪 **Strengths**, ⚠️ **risks**, and 🎯 **next steps** — specific to your idea
- 🔗 **Sources** — citations from the live research

## Quickstart

```bash
git clone https://github.com/aashaexo/ideachecker
cd ideachecker
npm install

cp .env.example .env        # add your PARALLEL_API_KEY (https://platform.parallel.ai)
export $(grep -v '^#' .env | xargs)

npm start                   # → http://localhost:3000
```

No API key? The app runs in **demo mode** with clearly-labeled sample data so
you can explore the UI first.

## How it works

```
idea ──► Parallel Task API (deep web research + structured output) ──► report
              │
              └── searches the live web for competitors, funding
                  rounds, shutdowns, and difficulty signals;
                  returns schema-validated JSON with per-field citations
```

The whole agent is one Parallel task run per check (`server.js`). The task
carries a JSON output schema, so the report always comes back structured —
competitors, funding, scores — with citations attached to each field, which
the app surfaces as sources. Free-text categorical fields are normalized
server-side so the UI always renders cleanly.

## Cost controls

Each check is **one task at a flat, known price** — cost per check is bounded
by construction:

| Processor | Cost per check | Notes |
|---|---|---|
| `lite` | ~$0.005 | Fastest, shallowest |
| `base` | ~$0.01 | Quick checks |
| `core` | ~$0.025 | **Default** — good depth for competitor/funding research |
| `pro` | ~$0.10 | Deeper research, slower |
| `ultra` | ~$0.30 | Maximum depth |

On top of that, total spend is hard-capped (default **$4**, i.e. ~160 checks
on `core`). The running total persists to `budget.json` across restarts; once
the cap is reached the API returns HTTP 429 until you raise
`IDEACHECKER_BUDGET_USD` or delete `budget.json`. Live spend shows in the UI
and at `GET /api/budget`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PARALLEL_API_KEY` | — | Your Parallel API key (demo mode if unset) |
| `PARALLEL_PROCESSOR` | `core` | Research depth / flat cost per check |
| `IDEACHECKER_BUDGET_USD` | `4` | Hard cap on total spend |
| `PORT` | `3000` | Server port |

## API

- `POST /api/check` — body `{"idea": "..."}`; returns the full report JSON
- `GET /api/budget` — current spend, cap, processor, and cost per check

## Stack

- Plain Node.js HTTP server — no framework, ~1 dependency
- Single-page frontend — no build step
- [`parallel-web`](https://www.npmjs.com/package/parallel-web) SDK

## Contributing

Issues and PRs welcome. Ideas: report history, shareable report links, batch
checking, an "ultra deep-dive" mode.

## License

[MIT](LICENSE)
