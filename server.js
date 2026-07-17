import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.IDEACHECKER_MODEL || "claude-opus-4-8";

const hasApiKey = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
);
const client = hasApiKey ? new Anthropic() : null;

// ---------------------------------------------------------------------------
// Stage 1 — research: Claude searches the web for competitors, funding, and
// market reality. Server-side tools; may span multiple pause_turn rounds.
// ---------------------------------------------------------------------------

const RESEARCH_SYSTEM = `You are a startup research analyst. Given a startup idea, research the
competitive landscape thoroughly using web search. You must find:
1. Existing companies building this or something close — how crowded is the space?
2. Funding: which of those companies raised money, how much, from whom, and roughly when.
3. Failures or shutdowns in the space, if notable.
4. How hard this is to build: technical, regulatory, and go-to-market difficulty.
5. Anything else that determines whether this idea is good: market size signals,
   timing, distribution dynamics.

Search for the idea's category and obvious keyword variations, not just the exact
phrasing. Prefer recent information. When you're done researching, write a dense,
factual research brief with company names, funding amounts, and dates. Be honest
about what you could not verify.`;

const RESEARCH_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 4 },
];

async function researchIdea(idea) {
  let messages = [
    { role: "user", content: `Research this startup idea:\n\n${idea}` },
  ];
  const allContent = [];
  let response;
  for (let round = 0; round < 6; round++) {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: RESEARCH_SYSTEM,
      tools: RESEARCH_TOOLS,
      messages,
    });
    allContent.push(...response.content);
    if (response.stop_reason !== "pause_turn") break;
    // Server-side tool loop paused; resend to let it resume where it left off.
    messages = [...messages, { role: "assistant", content: response.content }];
  }

  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("The model declined to research this idea."), {
      status: 422,
    });
  }

  const brief = allContent
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const sources = [];
  const seen = new Set();
  for (const block of allContent) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.url && !seen.has(r.url)) {
          seen.add(r.url);
          sources.push({ title: r.title || r.url, url: r.url });
        }
      }
    }
  }
  return { brief, sources };
}

// ---------------------------------------------------------------------------
// Stage 2 — structure: turn the research brief into a strict JSON report.
// (Separate call because citations from search results don't combine with
// structured output in a single request.)
// ---------------------------------------------------------------------------

const SCORE = { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["promising", "needs-work", "risky"] },
    one_liner: {
      type: "string",
      description: "One blunt sentence: is this idea good or not, and why",
    },
    scores: {
      type: "object",
      properties: {
        market: SCORE,
        feasibility: SCORE,
        originality: SCORE,
        monetization: SCORE,
      },
      required: ["market", "feasibility", "originality", "monetization"],
      additionalProperties: false,
    },
    market_reality: {
      type: "object",
      properties: {
        how_many_built_it: {
          type: "string",
          description:
            "How many companies/people have built this or something close, e.g. 'At least 12 direct competitors, dozens of adjacent tools'",
        },
        saturation: { type: "string", enum: ["low", "medium", "high"] },
        summary: { type: "string" },
      },
      required: ["how_many_built_it", "saturation", "summary"],
      additionalProperties: false,
    },
    competitors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          funding: {
            type: "string",
            description: "e.g. '$42M Series B (2024, a16z)' or 'Bootstrapped' or 'Unknown'",
          },
          status: { type: "string", enum: ["active", "acquired", "shut-down", "unknown"] },
        },
        required: ["name", "description", "funding", "status"],
        additionalProperties: false,
      },
    },
    difficulty: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["easy", "moderate", "hard", "very-hard"] },
        time_to_mvp: { type: "string", description: "e.g. '2-3 months for a solo dev'" },
        key_challenges: { type: "array", items: { type: "string" } },
      },
      required: ["level", "time_to_mvp", "key_challenges"],
      additionalProperties: false,
    },
    strengths: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    suggestions: { type: "array", items: { type: "string" } },
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

const STRUCTURE_SYSTEM = `You are IdeaChecker, a sharp, honest startup evaluator. You are given a
startup idea and a research brief compiled from live web research. Produce a
structured report grounded in the brief — use the real company names, funding
amounts, and facts it contains. Score conservatively; 9-10 should be rare.
If the brief lacks data on something, say so honestly rather than inventing facts.`;

async function structureReport(idea, brief) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: STRUCTURE_SYSTEM,
    output_config: { format: { type: "json_schema", schema: REPORT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `IDEA:\n${idea}\n\nRESEARCH BRIEF:\n${brief}`,
      },
    ],
  });
  if (response.stop_reason === "refusal") {
    throw Object.assign(new Error("The model declined to evaluate this idea."), {
      status: 422,
    });
  }
  const textBlock = response.content.find((b) => b.type === "text");
  return JSON.parse(textBlock.text);
}

async function analyzeIdea(idea) {
  const { brief, sources } = await researchIdea(idea);
  const report = await structureReport(idea, brief);
  return { ...report, sources };
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
        "Several funded players already serve the broad market; the openings are underserved niches and distribution angles they ignore. (Demo data — run with an API key for live research.)",
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
  if (!hasApiKey) {
    console.log("No ANTHROPIC_API_KEY found — running in demo mode with sample data.");
  }
});
