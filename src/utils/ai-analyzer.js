'use strict';
const Groq = require('groq-sdk');
const { applyRuleEngine } = require('../rules/rule-engine');

// ── Groq client (singleton) ───────────────────────────────────
let _client = null;
function getClient() {
  if (!_client) {
    _client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _client;
}

// ── analyzeError ──────────────────────────────────────────────
// Layer 1: Rule engine (instant, no API call)
// Layer 2: Groq LLM  (deep structured analysis)
// ─────────────────────────────────────────────────────────────
async function analyzeError(errorText, context = '') {
  // Layer 1 — rule engine first
  const ruleMatch = applyRuleEngine(errorText);

  const prompt = `You are an expert Apache Spark and Linux DevOps engineer.
Analyze this error and provide a structured fix.

ERROR:
${errorText}

CONTEXT: ${context}
${ruleMatch
    ? `Rule Engine already matched: [${ruleMatch.id}] ${ruleMatch.label} — suggested fix: ${ruleMatch.fix}`
    : 'No rule engine match found.'}

Reply ONLY as valid JSON. No markdown fences. No extra text before or after.
{
  "severity": "critical|high|medium|low",
  "root_cause": "one sentence explaining why this happened",
  "solution_steps": ["step 1", "step 2", "step 3"],
  "fix_command": "single executable bash command",
  "prevention": "one sentence prevention tip",
  "estimated_fix_time": "X minutes"
}`;

  try {
    // Layer 2 — Groq LLM call
    // Model: llama-3.3-70b-versatile
    //   → fastest inference on Groq hardware
    //   → strong JSON instruction following
    //   → best for DevOps / system administration tasks
    const completion = await getClient().chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,        // low temp = deterministic JSON output
      max_tokens: 1024,
      messages: [
        {
          role: 'system',
          content: 'You are a Spark and Linux DevOps expert. Always reply with valid JSON only. No prose, no markdown.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const raw = completion.choices[0].message.content.trim();

    // Strip any accidental markdown fences Groq sometimes adds
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return { ruleMatch, aiAnalysis: parsed };

  } catch (err) {
    // Fallback — return rule engine fix if available
    return {
      ruleMatch,
      aiAnalysis: {
        severity: 'unknown',
        root_cause: 'Groq API call failed: ' + err.message,
        solution_steps: ruleMatch ? [ruleMatch.fix] : ['Inspect the error manually'],
        fix_command: ruleMatch ? ruleMatch.fix : '',
        prevention: 'Ensure GROQ_API_KEY is valid in .env',
        estimated_fix_time: 'unknown',
      },
    };
  }
}

module.exports = { analyzeError };
