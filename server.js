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

const SYSTEM_PROMPT = `You are IdeaChecker, a sharp, honest startup and business idea evaluator.
Given an idea, assess it the way a seasoned investor and operator would: direct,
specific, and grounded in how markets actually work. Score conservatively — a 9
or 10 should be rare. Strengths, risks, and suggestions must be specific to the
idea, never generic filler.`;

const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["promising", "needs-work", "risky"],
      description: "Overall call on the idea",
    },
    one_liner: {
      type: "string",
      description: "One blunt sentence summarizing the assessment",
    },
    scores: {
      type: "object",
      properties: {
        feasibility: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
        market: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
        originality: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
        monetization: { type: "integer", enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      },
      required: ["feasibility", "market", "originality", "monetization"],
      additionalProperties: false,
    },
    strengths: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    suggestions: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "one_liner", "scores", "strengths", "risks", "suggestions"],
  additionalProperties: false,
};

async function analyzeIdea(idea) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Evaluate this idea:\n\n${idea}`,
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

// Deterministic canned analysis so the app is fully explorable without an API key.
function demoAnalysis(idea) {
  const short = idea.length < 80 ? idea : idea.slice(0, 77) + "...";
  return {
    demo: true,
    verdict: "needs-work",
    one_liner: `"${short}" has a real audience, but the moat and distribution story need sharpening before it's fundable.`,
    scores: { feasibility: 7, market: 6, originality: 5, monetization: 6 },
    strengths: [
      "Solves a concrete, recurring pain point rather than a hypothetical one",
      "Small enough scope to ship an MVP in weeks, not months",
      "Clear early-adopter niche you can reach without paid acquisition",
    ],
    risks: [
      "Low switching costs — incumbents can copy the core feature quickly",
      "Unclear willingness to pay: the pain is real but may not be budget-line real",
      "Distribution depends on channels you don't yet control",
    ],
    suggestions: [
      "Interview 10 target users and ask what they do today — count how many already pay for a workaround",
      "Narrow the first version to the single highest-pain workflow and charge from day one",
      "Pick one distribution channel (community, SEO, partnerships) and validate it before building more",
    ],
  };
}

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
    console.log("No ANTHROPIC_API_KEY found — running in demo mode with canned analysis.");
  }
});
