// Calls the Claude API — on demand only, never automatically. This is what
// powers the "Load AI response" button and the News tab once it's switched on.
//
// Uses the official @anthropic-ai/sdk. Docs: https://docs.claude.com

const Anthropic = require('@anthropic-ai/sdk');

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

// Cheapest current model — plenty for summarizing match context into a
// written analysis. Swap to a stronger model later if the quality isn't
// good enough; check console.anthropic.com for current model names/pricing,
// since these change over time.
const ANALYSIS_MODEL = 'claude-haiku-4-5-20251001';

async function generateAIAnalysis(matchContext) {
  const client = getClient();
  if (!client) {
    return { error: 'ANTHROPIC_API_KEY is not set — add it to your .env file.' };
  }

  const prompt = `You are a sports analyst. Based ONLY on the match data below (don't invent stats not given here), write a match breakdown.

MATCH DATA:
${JSON.stringify(matchContext, null, 2)}

Respond with ONLY valid JSON, no other text, in exactly this shape:
{
  "conclusion": "2-3 sentence verdict on the match",
  "reasoning": "a paragraph explaining the reasoning, referencing specific numbers from the data above",
  "primaryPick": { "market": "e.g. Match winner", "selection": "e.g. Arsenal to win", "percentage": 57 },
  "secondaryPick": { "market": "e.g. Total goals", "selection": "e.g. Over 2.5 goals", "percentage": 61 }
}`;

  try {
    const msg = await client.messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content.find((b) => b.type === 'text').text;
    const cleaned = text.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[claude] generateAIAnalysis failed:', err.message);
    return { error: 'AI analysis failed — see server logs.' };
  }
}

async function generateNewsAndRumors(teamA, teamB, matchDateISO) {
  const client = getClient();
  if (!client) {
    return { error: 'ANTHROPIC_API_KEY is not set — add it to your .env file.' };
  }

  const prompt = `Search for recent news, injury updates, and transfer rumours relevant to the upcoming ${teamA} vs ${teamB} match on ${matchDateISO}. Use at most 5-6 searches, top sources only. Then write 2-3 short paragraphs summarizing what's relevant for a fan deciding how to watch or bet on this match — team news, storylines, anything notable. Keep it factual; don't speculate beyond what your searches turn up.`;

  try {
    const msg = await client.messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 1200,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: prompt }]
    });
    const textBlocks = msg.content.filter((b) => b.type === 'text');
    const summary = textBlocks.map((b) => b.text).join('\n');

    // Pull real source links out of the response's citations, so the reader
    // can go check the originals instead of only trusting the AI's summary.
    // NOTE: built from my understanding of the web_search tool's citation
    // format, not verified against a real response — I don't have a key to
    // test this against. If `sources` comes back empty even when the summary
    // clearly used real searches, this extraction logic is the first place
    // to check, not necessarily a sign the search itself failed.
    const sourcesMap = new Map();
    textBlocks.forEach((b) => {
      (b.citations || []).forEach((c) => {
        if (c.url && !sourcesMap.has(c.url)) {
          sourcesMap.set(c.url, c.title || c.url);
        }
      });
    });
    const sources = Array.from(sourcesMap, ([url, title]) => ({ url, title }));

    return { summary, sources };
  } catch (err) {
    console.error('[claude] generateNewsAndRumors failed:', err.message);
    return { error: 'News search failed — see server logs.' };
  }
}

module.exports = { generateAIAnalysis, generateNewsAndRumors };
