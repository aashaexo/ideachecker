import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Parallel from "parallel-web";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Parallel Task API processor. Higher tiers research deeper and cost more per
// task: lite < base < core < pro < ultra. "core" is a good default for
// competitive/funding research.
const PROCESSOR = process.env.PARALLEL_PROCESSOR || "core";

// Flat price per task run by processor (USD). Used for budget accounting —
// keep in sync with https://parallel.ai pricing.
const PROCESSOR_COST = {
  lite: 0.005,
  base: 0.01,
  core: 0.025,
  pro: 0.1,
  ultra: 0.3,
};

const hasApiKey = Boolean(process.env.PARALLEL_API_KEY);
const client = hasApiKey
  ? new Parallel({ apiKey: process.env.PARALLEL_API_KEY })
  : null;

// ---------------------------------------------------------------------------
// Budget guard — hard cap on cumulative API spend, persisted across restarts.
// Each analysis is one Parallel task run at a flat, known price, so cost per
// check is bounded by construction.
// ---------------------------------------------------------------------------

const BUDGET_USD = Number(process.env.IDEACHECKER_BUDGET_USD || 4);
const BUDGET_FILE = path.join(here, "budget.json");

function loadSpent() {
  try {
    return Number(JSON.parse(readFileSync(BUDGET_FILE, "utf8")).spentUsd) || 0;
  } catch {
    return 0;
  }
}
let spentUsd = loadSpent();

function recordSpend(cost) {
  spentUsd += cost;
  try {
    writeFileSync(BUDGET_FILE, JSON.stringify({ spentUsd }, null, 2));
  } catch (err) {
    console.error("could not persist budget:", err);
  }
}

function assertBudget() {
  const perCheck = PROCESSOR_COST[PROCESSOR] ?? 0.1;
  if (spentUsd + perCheck > BUDGET_USD) {
    throw Object.assign(
      new Error(
        `Budget cap reached ($${spentUsd.toFixed(2)} of $${BUDGET_USD.toFixed(2)} spent). ` +
          "Raise IDEACHECKER_BUDGET_USD or delete budget.json to continue.",
      ),
      { status: 429 },
    );
  }
}

// ---------------------------------------------------------------------------
// The research task — one Parallel Task API run does the deep web research
// and returns the report already shaped by the JSON schema, with per-field
// citations in the basis.
// ---------------------------------------------------------------------------

const desc = (description) => ({ type: "string", description });

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    verdict: desc(
      "Overall call on the idea. Exactly one of: promising, needs-work, risky",
    ),
    one_liner: desc(
      "One blunt sentence: is this idea good or not, and the main reason why",
    ),
    scores: {
      type: "object",
      properties: {
        market: {
          type: "integer",
          description: "Market opportunity score from 1 (tiny/shrinking) to 10 (huge/growing)",
        },
        feasibility: {
          type: "integer",
          description: "How feasible it is to build and launch, 1 (nearly impossible) to 10 (trivial)",
        },
        originality: {
          type: "integer",
          description: "How original vs. crowded, 1 (fully commoditized) to 10 (genuinely novel)",
        },
        monetization: {
          type: "integer",
          description: "How clear the path to revenue is, 1 (no path) to 10 (obvious and proven)",
        },
      },
      required: ["market", "feasibility", "originality", "monetization"],
      additionalProperties: false,
    },
    market_reality: {
      type: "object",
      properties: {
        how_many_built_it: desc(
          "How many companies or people have already built this or something close, with numbers where possible, e.g. 'At least 12 direct competitors and dozens of adjacent tools'",
        ),
        saturation: desc("Market saturation level. Exactly one of: low, medium, high"),
        summary: desc(
          "2-3 sentences on the real state of this market based on the research",
        ),
      },
      required: ["how_many_built_it", "saturation", "summary"],
      additionalProperties: false,
    },
    competitors: {
      type: "array",
      description:
        "Real companies found in research that built this or something close, including failed ones — they carry the most signal",
      items: {
        type: "object",
        properties: {
          name: desc("Company name"),
          description: desc("What they do, one sentence"),
          funding: desc(
            "Funding raised with round, year, and lead investors where known, e.g. '$42M Series B (2024, a16z)', or 'Bootstrapped' or 'Unknown'",
          ),
          status: desc("Exactly one of: active, acquired, shut-down, unknown"),
        },
        required: ["name", "description", "funding", "status"],
        additionalProperties: false,
      },
    },
    difficulty: {
      type: "object",
      properties: {
        level: desc("How hard to build. Exactly one of: easy, moderate, hard, very-hard"),
        time_to_mvp: desc("Realistic time to a working MVP, e.g. '2-3 months for a solo dev'"),
        key_challenges: {
          type: "array",
          description: "The 3-5 hardest problems: technical, regulatory, or go-to-market",
          items: { type: "string" },
        },
      },
      required: ["level", "time_to_mvp", "key_challenges"],
      additionalProperties: false,
    },
    strengths: {
      type: "array",
      description: "3-5 specific strengths of this idea, grounded in the research",
      items: { type: "string" },
    },
    risks: {
      type: "array",
      description: "3-5 specific risks, grounded in what happened to others in this space",
      items: { type: "string" },
    },
    suggestions: {
      type: "array",
      description: "3-5 concrete next steps the founder should take",
      items: { type: "string" },
    },
  },
  required: [
    "verdict",
    "one_liner",
    "scores",
    "market_reality",
    "competitors",
    "difficulty",
    "strengths",
    "risks",
    "suggestions",
  ],
  additionalProperties: false,
};

const TASK_INSTRUCTIONS = `Evaluate this startup idea like a seasoned investor and operator: direct,
specific, grounded in how markets actually work. Research the competitive
landscape thoroughly — search the idea's category and keyword variations, not
just its exact phrasing. Find: existing companies building this or something
close (how crowded is it?), who raised money (amounts, rounds, investors,
dates), notable failures or shutdowns, and how hard this is to build
(technical, regulatory, go-to-market). Score conservatively — 9 or 10 should
be rare. Strengths, risks, and suggestions must be specific to this idea,
never generic filler. If something could not be verified, say so honestly.

STARTUP IDEA TO EVALUATE:
`;

// Normalize free-text enum-ish fields so the UI's badge/pill classes always
// get a known value even if the model phrases it differently.
function pick(value, allowed, fallback) {
  const v = String(value || "").toLowerCase().trim().replace(/\s+/g, "-");
  return allowed.includes(v) ? v : fallback;
}
const clampScore = (n) => Math.min(10, Math.max(1, Math.round(Number(n) || 5)));

async function analyzeIdea(idea) {
  assertBudget();

  const run = await client.taskRun.create({
    input: TASK_INSTRUCTIONS + idea,
    processor: PROCESSOR,
    task_spec: {
      output_schema: { type: "json", json_schema: REPORT_SCHEMA },
    },
    metadata: { app: "ideachecker" },
  });
  recordSpend(PROCESSOR_COST[PROCESSOR] ?? 0.1);

  // Blocks server-side until the run completes; deep research can take a few
  // minutes on higher processors.
  const result = await client.taskRun.result(
    run.run_id,
    { timeout: 600 },
    { timeout: 660_000 },
  );

  if (result.output?.type !== "json" || !result.output.content) {
    throw new Error("Unexpected task output format");
  }
  const r = result.output.content;

  // Collect deduped citations from the per-field basis.
  const sources = [];
  const seen = new Set();
  for (const fb of result.output.basis || []) {
    for (const c of fb.citations || []) {
      if (c.url && !seen.has(c.url)) {
        seen.add(c.url);
        sources.push({ title: c.title || c.url, url: c.url });
      }
    }
  }

  return {
    verdict: pick(r.verdict, ["promising", "needs-work", "risky"], "needs-work"),
    one_liner: String(r.one_liner || ""),
    scores: {
      market: clampScore(r.scores?.market),
      feasibility: clampScore(r.scores?.feasibility),
      originality: clampScore(r.scores?.originality),
      monetization: clampScore(r.scores?.monetization),
    },
    market_reality: {
      how_many_built_it: String(r.market_reality?.how_many_built_it || "Unknown"),
      saturation: pick(r.market_reality?.saturation, ["low", "medium", "high"], "medium"),
      summary: String(r.market_reality?.summary || ""),
    },
    competitors: (Array.isArray(r.competitors) ? r.competitors : []).map((c) => ({
      name: String(c.name || "Unknown"),
      description: String(c.description || ""),
      funding: String(c.funding || "Unknown"),
      status: pick(c.status, ["active", "acquired", "shut-down", "unknown"], "unknown"),
    })),
    difficulty: {
      level: pick(r.difficulty?.level, ["easy", "moderate", "hard", "very-hard"], "moderate"),
      time_to_mvp: String(r.difficulty?.time_to_mvp || "Unknown"),
      key_challenges: (r.difficulty?.key_challenges || []).map(String),
    },
    strengths: (r.strengths || []).map(String),
    risks: (r.risks || []).map(String),
    suggestions: (r.suggestions || []).map(String),
    sources: sources.slice(0, 12),
  };
}

// ---------------------------------------------------------------------------
// Demo mode — deterministic sample report so the app works without an API key.
// All names and figures below are illustrative placeholders, not real data.
// ---------------------------------------------------------------------------

function demoAnalysis(idea) {
  const short = idea.length < 80 ? idea : idea.slice(0, 77) + "...";
  return {
    demo: true,
    verdict: "needs-work",
    one_liner: `"${short}" targets a real pain, but the space is more crowded than it looks — you'll need a wedge the incumbents can't copy.`,
    scores: { market: 6, feasibility: 7, originality: 4, monetization: 6 },
    market_reality: {
      how_many_built_it:
        "Roughly 10-15 direct competitors and dozens of adjacent tools (sample estimate)",
      saturation: "medium",
      summary:
        "Several funded players already serve the broad market; the openings are underserved niches and distribution angles they ignore. (Demo data — set PARALLEL_API_KEY for live research.)",
    },
    competitors: [
      {
        name: "MarketLeader Co (sample)",
        description: "The category incumbent with the broadest feature set and enterprise sales motion",
        funding: "$40M Series B (2023)",
        status: "active",
      },
      {
        name: "FastFollower (sample)",
        description: "YC-backed startup taking the self-serve, product-led route",
        funding: "$3.5M seed (2024)",
        status: "active",
      },
      {
        name: "EarlyMover (sample)",
        description: "First mover that failed to find repeatable distribution",
        funding: "$12M total raised",
        status: "shut-down",
      },
    ],
    difficulty: {
      level: "moderate",
      time_to_mvp: "6-10 weeks for a small team (sample estimate)",
      key_challenges: [
        "Earning trust in a market where switching costs are low",
        "Reaching customers without burning cash on paid acquisition",
        "Differentiating beyond features incumbents can ship in a quarter",
      ],
    },
    strengths: [
      "Solves a concrete, recurring pain point rather than a hypothetical one",
      "Small enough scope to ship an MVP in weeks, not months",
      "Prior funding in the space proves investors believe in the market",
    ],
    risks: [
      "A shut-down first mover suggests distribution, not product, is the hard part",
      "Funded incumbents can outspend you on acquisition",
      "Unclear willingness to pay until validated with real customers",
    ],
    suggestions: [
      "Interview 10 target users — count how many already pay for a workaround",
      "Pick the niche the funded players ignore and own it completely",
      "Study why the failed competitor died before writing any code",
    ],
    sources: [
      { title: "Sample source — Crunchbase funding data", url: "https://example.com/crunchbase" },
      { title: "Sample source — TechCrunch coverage", url: "https://example.com/techcrunch" },
    ],
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/check") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let idea;
    try {
      idea = JSON.parse(raw).idea?.trim();
    } catch {
      return send(res, 400, { error: "Invalid JSON body" });
    }
    if (!idea) return send(res, 400, { error: "Describe your idea first" });
    if (idea.length > 4000)
      return send(res, 400, { error: "Keep the idea under 4000 characters" });

    try {
      const analysis = hasApiKey ? await analyzeIdea(idea) : demoAnalysis(idea);
      return send(res, 200, analysis);
    } catch (err) {
      console.error("analysis failed:", err);
      return send(res, err.status || 502, {
        error: err.status ? err.message : "Analysis failed — try again",
      });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/budget") {
    return send(res, 200, {
      live: hasApiKey,
      processor: PROCESSOR,
      cost_per_check_usd: PROCESSOR_COST[PROCESSOR] ?? null,
      spent_usd: Number(spentUsd.toFixed(4)),
      limit_usd: BUDGET_USD,
      remaining_usd: Number(Math.max(0, BUDGET_USD - spentUsd).toFixed(4)),
    });
  }

  if (req.method === "GET") {
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.join(here, "public", path.normalize(file));
    if (!filePath.startsWith(path.join(here, "public"))) {
      return send(res, 403, { error: "Forbidden" });
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      });
      return res.end(data);
    } catch {
      return send(res, 404, { error: "Not found" });
    }
  }

  send(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`IdeaChecker running at http://localhost:${PORT}`);
  if (hasApiKey) {
    console.log(
      `Processor: ${PROCESSOR} (~$${PROCESSOR_COST[PROCESSOR] ?? "?"}/check) | ` +
        `budget: $${spentUsd.toFixed(2)} of $${BUDGET_USD.toFixed(2)} spent`,
    );
  } else {
    console.log(
      "No PARALLEL_API_KEY found — running in demo mode with sample data. " +
        "Get a key at https://platform.parallel.ai",
    );
  }
});
