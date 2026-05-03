require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── DATABASE ────────────────────────────────────────────────────────────────
const db = new Database('issues.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS issues (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    desc        TEXT    DEFAULT '',
    source      TEXT    DEFAULT 'support',
    tier        TEXT    DEFAULT 'standard',
    hint        TEXT    DEFAULT '',
    moscow      TEXT    DEFAULT NULL,
    rice_reach      REAL DEFAULT NULL,
    rice_impact     REAL DEFAULT NULL,
    rice_confidence REAL DEFAULT NULL,
    rice_effort     REAL DEFAULT NULL,
    rice_vip        INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS themes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT    DEFAULT '',
    issue_ids   TEXT    DEFAULT '[]',
    rank        INTEGER DEFAULT 0,
    budget      INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS solutions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id     INTEGER,
    title        TEXT    NOT NULL,
    description  TEXT    DEFAULT '',
    value_score  REAL    DEFAULT 5,
    effort_score REAL    DEFAULT 5,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Add roadmap_column to existing issues table (safe to run repeatedly)
try { db.exec(`ALTER TABLE issues ADD COLUMN roadmap_column TEXT DEFAULT NULL`); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS eval_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    total        INTEGER,
    passed       INTEGER,
    pass_rate    TEXT,
    critical_errors INTEGER,
    overall_score REAL,
    results      TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ai_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id     INTEGER DEFAULT NULL,
    ai_moscow    TEXT    NOT NULL,
    human_moscow TEXT    DEFAULT NULL,
    agreed       INTEGER DEFAULT NULL,
    latency_ms   INTEGER DEFAULT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ─── ANTHROPIC CLIENT ────────────────────────────────────────────────────────
const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
const anthropic = hasApiKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// Shared system prompt for classification — cached for cost efficiency
const CLASSIFY_SYSTEM = `You are a Senior Product Manager for a B2B SaaS company (AI Marketing & Sales Intelligence for retail/ecommerce).
Your job is to classify incoming product issues using MoSCoW and suggest RICE scoring inputs.

MoSCoW definitions:
- must: Critical — breaks revenue flow, SLA breach, core feature down, major customer impact
- should: Important — has workaround, affects >10% users, degrades key metric
- could: Minor — UX polish, low urgency, <5% users, no direct revenue impact
- wont: Noise — duplicate, out of scope, single low-value request, feature creep

RICE definitions (for B2B SaaS with ~100 active accounts):
- reach: 1–10 (1=<5% accounts, 5=~40%, 10=>80%). VIP accounts count extra — if tier is vip, mentally double reach.
- impact: 0.5=minimal, 1=moderate, 2=significant (measurable metric change), 3=massive (churn risk, >10% ROAS drop)
- confidence: 20=guess, 50=partial data, 80=strong signal, 100=hard data
- effort: 0.5=<1 day, 1=2-3 days, 2=1 week, 4=2-3 weeks, 8=full sprint

Always respond with valid JSON only. No markdown, no explanation outside the JSON.`;

const THEMES_SYSTEM = `You are a Senior Product Manager for a B2B SaaS company (AI Marketing & Sales Intelligence for retail/ecommerce).
Cluster product issues into 5–10 strategic themes. Each theme is a core problem area that, if fully solved, eliminates multiple issues.

Rules:
- name: 2–4 words (e.g. "Attribution Accuracy", "Onboarding Optimization", "API Reliability")
- description: one sentence — what core problem does this theme address?
- issue_ids: array of issue IDs that belong to this theme (every issue must belong to exactly one theme)
- rank: 1 = highest business impact
- budget: integer 0–100. Imagine spending $100 across all themes — allocate by expected ROI. All budgets must sum to exactly 100.

Always respond with valid JSON only. No markdown, no explanation outside the JSON.`;

const SOLUTIONS_SYSTEM = `You are a Senior Product Manager for a B2B SaaS company (AI Marketing & Sales Intelligence for retail/ecommerce).
Given a strategic theme and its issues, generate 5–8 distinct solution approaches.

For each solution:
- title: 4–8 words, action-oriented (e.g. "Rebuild attribution pipeline with event replay")
- description: 1–2 sentences — what specifically would be built or changed?
- value_score: 1–10 (10 = massive revenue/retention impact; 1 = negligible)
- effort_score: 1–10 (10 = many months of eng; 1 = hours)

Solutions should represent meaningfully different approaches — not variations of the same idea.
Always respond with valid JSON only. No markdown, no explanation outside the JSON.`;

// ─── EVAL GOLDENS ─────────────────────────────────────────────────────────────

const EVAL_GOLDENS = [
  {
    id: 'G-001', scenario: 'Critical revenue metric broken for all enterprise accounts', category: 'critical_outage',
    input: { title: 'ROAS dashboard returns 0 for all enterprise accounts', desc: 'All enterprise clients reporting 0 ROAS since last deploy. Critical revenue metric broken.', source: 'support', tier: 'vip' },
    expected: { moscow: 'must', acceptable: ['must'], rice_ranges: { reach:[8,10], impact:[2,3], confidence:[80,100], effort:[1,4] } },
    must_mention: ['revenue','enterprise','roas','critical'], critical_misses: ['could','wont']
  },
  {
    id: 'G-002', scenario: 'Lead scoring inverted — active churn risk', category: 'critical_outage',
    input: { title: 'Lead scoring model returning inverted rankings — low-intent leads marked as hot', desc: 'Enterprise customers reporting their sales reps are calling cold leads first. Root cause: model weight flip after last night\'s retrain. One account is churning over this.', source: 'cs', tier: 'vip' },
    expected: { moscow: 'must', acceptable: ['must'], rice_ranges: { reach:[7,10], impact:[3,3], confidence:[80,100], effort:[1,2] } },
    must_mention: ['churn','revenue','enterprise'], critical_misses: ['should','could','wont']
  },
  {
    id: 'G-003', scenario: 'AI copy generation failing for 38% of requests', category: 'partial_outage',
    input: { title: 'AI ad copy generation returning null for 38% of requests', desc: 'Product analytics alert: copy generation endpoint has a 38% null response rate since the v2.4 deploy. Customers on the Growth plan cannot generate new ad variants.', source: 'analytics', tier: 'standard' },
    expected: { moscow: 'must', acceptable: ['must'], rice_ranges: { reach:[5,8], impact:[2,3], confidence:[80,100], effort:[1,4] } },
    must_mention: ['38%','null','copy'], critical_misses: ['could','wont']
  },
  {
    id: 'G-004', scenario: 'Audience export times out — workaround exists', category: 'performance_degradation',
    input: { title: 'Audience segmentation export timing out for cohorts larger than 500k records', desc: 'Power users in the retail vertical build audiences of 1M+ records. Export jobs fail silently after 10 minutes. Users have to split manually as a workaround.', source: 'support', tier: 'standard' },
    expected: { moscow: 'should', acceptable: ['should','must'], rice_ranges: { reach:[3,6], impact:[1,2], confidence:[70,100], effort:[2,8] } },
    must_mention: ['retail','export','workaround'], critical_misses: ['wont']
  },
  {
    id: 'G-005', scenario: 'Email sequence metrics delayed 48+ hours', category: 'performance_degradation',
    input: { title: 'Email sequence performance metrics delayed by 48+ hours', desc: 'Open rates, CTR, and reply rates for outbound sequences are not updating in real time. Sales teams cannot make intra-day adjustments to active campaigns.', source: 'sales', tier: 'standard' },
    expected: { moscow: 'should', acceptable: ['should'], rice_ranges: { reach:[4,7], impact:[1,2], confidence:[70,100], effort:[1,4] } },
    must_mention: ['sales','delay','campaign'], critical_misses: ['must','wont']
  },
  {
    id: 'G-006', scenario: 'Single prospect requesting native mobile app', category: 'noise',
    input: { title: 'Build a native iOS and Android mobile app', desc: 'One SMB prospect mentioned they would prefer a mobile app during a sales demo. No other requests on record.', source: 'sales', tier: 'standard' },
    expected: { moscow: 'wont', acceptable: ['wont'], rice_ranges: { reach:[1,2], impact:[0.5,1], confidence:[20,50], effort:[8,8] } },
    must_mention: ['single','one','prospect'], critical_misses: ['must','should']
  },
  {
    id: 'G-007', scenario: 'Internal designer requests sidebar icon change', category: 'noise',
    input: { title: 'Change the sidebar icon for the Audiences module', desc: 'Internal design feedback from one team member that the current icon looks too similar to the Segments icon.', source: 'internal', tier: 'standard' },
    expected: { moscow: 'could', acceptable: ['could','wont'], rice_ranges: { reach:[1,3], impact:[0.5,0.5], confidence:[20,50], effort:[0.5,1] } },
    must_mention: ['cosmetic','internal','icon'], critical_misses: ['must','should']
  },
  {
    id: 'G-008', scenario: 'VIP SLA breach — $40k MRR account', category: 'sla_breach',
    input: { title: 'Ad spend sync delay >6 hours for Acme Corp', desc: 'Acme Corp ($40k MRR) reporting sync lag consistently above 6 hours. SLA guarantee is 2 hours. Customer is threatening to escalate.', source: 'cs', tier: 'vip' },
    expected: { moscow: 'must', acceptable: ['must'], rice_ranges: { reach:[2,4], impact:[2,3], confidence:[80,100], effort:[1,4] } },
    must_mention: ['sla','vip','$40k','escalat'], critical_misses: ['should','could','wont']
  }
];

const REASONING_RATER_SYSTEM = `You are a PM quality reviewer checking if an AI classifier's reasoning is accurate and useful.

Evaluate whether the reasoning sentence cites the specific signals from the issue (scope, severity, business impact), accurately explains the MoSCoW label, and is NOT generic ("This is important").

Respond ONLY with valid JSON: {"score": <1-5>, "reasoning": "<one sentence>"}
5=cites specific signals fully, 4=mostly accurate minor gaps, 3=correct label but vague, 2=misses key signals, 1=inaccurate`;

// ─── EVAL RATERS ──────────────────────────────────────────────────────────────

function rateMoscow(golden, output) {
  const actual = output.moscow || '';
  const exact = actual === golden.expected.moscow;
  const acceptable = (golden.expected.acceptable || [golden.expected.moscow]).includes(actual);
  const critical = (golden.critical_misses || []).includes(actual);
  return {
    rater: 'moscow_accuracy',
    score: exact ? 5 : acceptable ? 4 : critical ? 1 : 2,
    expected: golden.expected.moscow, actual,
    exact_match: exact, critical_error: critical,
    verdict: acceptable ? 'correct' : critical ? 'critical' : 'wrong'
  };
}

function rateRice(golden, output) {
  const rice = output.rice || {};
  const ranges = golden.expected.rice_ranges;
  const valid = { impact:[0.5,1,2,3], confidence:[20,50,80,100], effort:[0.5,1,2,4,8] };
  let correct = 0; const total = Object.keys(ranges).length;
  const out = [];

  for (const [dim, [lo, hi]] of Object.entries(ranges)) {
    const val = rice[dim];
    if (val == null) { out.push(`${dim}=missing`); continue; }
    const ok = valid[dim] ? (lo <= val && val <= hi) : (lo <= val && val <= hi);
    if (ok) correct++; else out.push(`${dim}=${val} (expected ${lo}–${hi})`);
  }

  return {
    rater: 'rice_calibration',
    score: Math.round((correct / total) * 5),
    dims_correct: `${correct}/${total}`,
    out_of_range: out
  };
}

function rateKeywords(golden, output) {
  const text = `${output.moscow_reasoning || ''} ${output.rice_reasoning || ''}`.toLowerCase();
  const required = golden.must_mention || [];
  const found = required.filter(kw => text.includes(kw.toLowerCase()));
  const missing = required.filter(kw => !text.includes(kw.toLowerCase()));
  const score = required.length ? Math.max(1, Math.round((found.length / required.length) * 5)) : 5;
  return {
    rater: 'reasoning_keywords',
    score, found, missing,
    pass_rate: `${found.length}/${required.length}`
  };
}

async function rateReasoningAI(golden, output) {
  if (!anthropic) return { rater: 'reasoning_quality', score: null, skipped: true };
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200,
      system: [{ type: 'text', text: REASONING_RATER_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content:
        `Issue: ${golden.input.title}\nTier: ${golden.input.tier} | Source: ${golden.input.source}\nExpected MoSCoW: ${golden.expected.moscow}\n\nAI MoSCoW reasoning: ${output.moscow_reasoning || ''}\nAI RICE reasoning: ${output.rice_reasoning || ''}` }]
    });
    let text = response.content[0].text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
    const parsed = JSON.parse(text);
    return { rater: 'reasoning_quality', ...parsed };
  } catch { return { rater: 'reasoning_quality', score: 3, reasoning: 'Grader error — defaulted to 3' }; }
}

async function gradeGolden(golden, output) {
  const r_moscow = rateMoscow(golden, output);
  const r_rice   = rateRice(golden, output);
  const r_kw     = rateKeywords(golden, output);
  const r_ai     = await rateReasoningAI(golden, output);

  const scores = [r_moscow.score, r_rice.score, r_kw.score, r_ai.score].filter(s => s != null);
  const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0) / scores.length * 10) / 10 : 0;

  return {
    golden_id: golden.id, scenario: golden.scenario, category: golden.category,
    input: golden.input, output,
    ratings: { moscow_accuracy: r_moscow, rice_calibration: r_rice, reasoning_keywords: r_kw, reasoning_quality: r_ai },
    scores: { moscow_accuracy: r_moscow.score, rice_calibration: r_rice.score, reasoning_keywords: r_kw.score, reasoning_quality: r_ai.score },
    average_score: avg,
    critical_error: r_moscow.critical_error,
    passed: avg >= 3.5 && !r_moscow.critical_error
  };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function toIssue(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    desc: row.desc,
    source: row.source,
    tier: row.tier,
    hint: row.hint,
    moscow: row.moscow,
    rice: row.rice_reach !== null ? {
      reach: row.rice_reach,
      impact: row.rice_impact,
      confidence: row.rice_confidence,
      effort: row.rice_effort,
      vip: !!row.rice_vip
    } : null,
    roadmapColumn: row.roadmap_column || null,
    createdAt: row.created_at
  };
}

// ─── JIRA CONFIG ─────────────────────────────────────────────────────────────
const jira = {
  baseUrl:    (process.env.JIRA_BASE_URL    || '').replace(/\/$/, ''),
  email:      process.env.JIRA_EMAIL        || '',
  token:      process.env.JIRA_API_TOKEN    || '',
  projectKey: process.env.JIRA_PROJECT_KEY  || '',
};
const hasJira = !!(jira.baseUrl && jira.email && jira.token && jira.projectKey);

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// GET /api/issues
app.get('/api/issues', (req, res) => {
  const rows = db.prepare('SELECT * FROM issues ORDER BY created_at DESC').all();
  res.json(rows.map(toIssue));
});

// POST /api/issues
app.post('/api/issues', (req, res) => {
  const { title, desc = '', source = 'support', tier = 'standard', hint = '', log_id } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });

  const stmt = db.prepare(`
    INSERT INTO issues (title, desc, source, tier, hint, moscow)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(title.trim(), desc, source, tier, hint, hint || null);
  const newId = result.lastInsertRowid;

  // Link and resolve a pending AI log from the preview flow
  if (log_id) {
    const logRow = db.prepare('SELECT ai_moscow FROM ai_logs WHERE id = ?').get(log_id);
    if (logRow) {
      const agreed = hint && hint === logRow.ai_moscow ? 1 : 0;
      db.prepare(`UPDATE ai_logs SET issue_id = ?, human_moscow = ?, agreed = ? WHERE id = ?`)
        .run(newId, hint || null, hint ? agreed : null, log_id);
    }
  }

  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(newId);
  res.status(201).json(toIssue(row));
});

// POST /api/import  — bulk CSV import
app.post('/api/import', (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array required' });

  const validSources = new Set(['support','analytics','sales','internal','cs']);
  const validTiers   = new Set(['standard','vip']);

  const stmt = db.prepare(`INSERT INTO issues (title, desc, source, tier, hint, moscow) VALUES (?, ?, ?, ?, ?, ?)`);
  const inserted = [];
  const skipped  = [];

  const importMany = db.transaction(() => {
    for (const r of rows) {
      const title = (r.title || '').trim();
      if (!title) { skipped.push({ row: r, reason: 'missing title' }); continue; }
      const source = validSources.has(r.source) ? r.source : 'support';
      const tier   = validTiers.has(r.tier)     ? r.tier   : 'standard';
      const desc   = (r.description || r.desc || '').trim();
      const result = stmt.run(title, desc, source, tier, '', null);
      inserted.push(db.prepare('SELECT * FROM issues WHERE id = ?').get(result.lastInsertRowid));
    }
  });

  importMany();
  res.status(201).json({ inserted: inserted.map(toIssue), skipped, count: inserted.length });
});

// PATCH /api/issues/:id
app.patch('/api/issues/:id', (req, res) => {
  const { id } = req.params;
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Issue not found' });

  const { moscow, rice, roadmap_column } = req.body;
  if (moscow !== undefined) {
    db.prepare('UPDATE issues SET moscow = ? WHERE id = ?').run(moscow, id);
    // Resolve any pending AI log for this issue (feedback loop)
    const pending = db.prepare(
      `SELECT id, ai_moscow FROM ai_logs WHERE issue_id = ? AND human_moscow IS NULL ORDER BY created_at DESC LIMIT 1`
    ).get(id);
    if (pending) {
      db.prepare(`UPDATE ai_logs SET human_moscow = ?, agreed = ? WHERE id = ?`)
        .run(moscow, pending.ai_moscow === moscow ? 1 : 0, pending.id);
    }
  }
  if (roadmap_column !== undefined) {
    db.prepare('UPDATE issues SET roadmap_column = ? WHERE id = ?').run(roadmap_column, id);
  }
  if (rice !== undefined) {
    if (rice === null) {
      db.prepare(`UPDATE issues SET rice_reach=NULL, rice_impact=NULL, rice_confidence=NULL, rice_effort=NULL, rice_vip=0 WHERE id = ?`).run(id);
    } else {
      db.prepare(`
        UPDATE issues SET rice_reach=?, rice_impact=?, rice_confidence=?, rice_effort=?, rice_vip=? WHERE id=?
      `).run(rice.reach, rice.impact, rice.confidence, rice.effort, rice.vip ? 1 : 0, id);
    }
  }

  res.json(toIssue(db.prepare('SELECT * FROM issues WHERE id = ?').get(id)));
});

// DELETE /api/issues/:id
app.delete('/api/issues/:id', (req, res) => {
  const result = db.prepare('DELETE FROM issues WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Issue not found' });
  res.json({ ok: true });
});

// DELETE /api/issues  (clear all)
app.delete('/api/issues', (req, res) => {
  db.prepare('DELETE FROM issues').run();
  res.json({ ok: true });
});

// POST /api/classify  — AI MoSCoW + RICE suggestion
app.post('/api/classify', async (req, res) => {
  if (!anthropic) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured', aiAvailable: false });
  }

  const { title, desc, source, tier, issue_id } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const t0 = Date.now();
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: [{ type: 'text', text: CLASSIFY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `Classify this issue and suggest RICE inputs:

Title: ${title}
Description: ${desc || 'N/A'}
Source: ${source || 'support'}
Customer Tier: ${tier || 'standard'}

Respond with JSON exactly like this:
{
  "moscow": "must|should|could|wont",
  "moscow_reasoning": "one sentence why",
  "rice": {
    "reach": <number 1-10>,
    "impact": <0.5|1|2|3>,
    "confidence": <20|50|80|100>,
    "effort": <0.5|1|2|4|8>
  },
  "rice_reasoning": "one sentence covering reach and impact estimates"
}`
      }]
    });

    const latency = Date.now() - t0;
    let text = response.content[0].text.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(text);

    // Log the AI suggestion for feedback loop tracking
    const logRow = db.prepare(
      `INSERT INTO ai_logs (issue_id, ai_moscow, latency_ms) VALUES (?, ?, ?)`
    ).run(issue_id || null, parsed.moscow, latency);

    res.json({ ...parsed, aiAvailable: true, logId: logRow.lastInsertRowid, latencyMs: latency });
  } catch (err) {
    console.error('Classify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/seed  — load sample issues
app.post('/api/seed', (req, res) => {
  db.prepare('DELETE FROM issues').run();

  const samples = [
    { title: 'ROAS dashboard returns 0 for all enterprise accounts', desc: 'All enterprise clients reporting 0 ROAS since last deploy. Critical revenue metric broken.', source: 'support', tier: 'vip', moscow: 'must', rice: { reach: 10, impact: 3, confidence: 100, effort: 1, vip: false } },
    { title: 'Attribution model produces inconsistent multi-touch results', desc: 'Last-click vs. linear attribution returning different counts on the same data set.', source: 'analytics', tier: 'standard', moscow: 'must', rice: { reach: 7, impact: 3, confidence: 80, effort: 4, vip: false } },
    { title: 'Ad spend sync delay >6 hours for Acme Corp', desc: 'Acme Corp ($40k MRR) reporting sync lag consistently. SLA is 2 hours.', source: 'cs', tier: 'vip', moscow: 'must', rice: { reach: 2, impact: 3, confidence: 100, effort: 2, vip: true } },
    { title: 'Bulk export CSV missing campaign_id and date columns', desc: 'Power users relying on export for downstream BI tools are affected.', source: 'support', tier: 'standard', moscow: 'should', rice: { reach: 4, impact: 1, confidence: 80, effort: 1, vip: false } },
    { title: 'Filter presets do not persist across browser sessions', desc: 'Users have to reconfigure filters every login. High friction for daily users.', source: 'sales', tier: 'standard', moscow: 'should', rice: { reach: 7, impact: 1, confidence: 80, effort: 1, vip: false } },
    { title: 'Onboarding step 3 has 62% drop-off rate', desc: 'Analytics flagged this week. Root cause unknown — may be UX or data load issue.', source: 'analytics', tier: 'standard', moscow: 'should', rice: { reach: 7, impact: 2, confidence: 50, effort: 2, vip: false } },
    { title: 'Add dark mode to settings page', desc: 'Multiple users requested. No revenue impact identified.', source: 'support', tier: 'standard', moscow: 'could', rice: null },
    { title: 'Support TikTok Ads as a data source', desc: 'One prospect asked about this during a sales call.', source: 'sales', tier: 'standard', moscow: 'wont', rice: null },
    { title: 'Page header slightly off-brand on mobile Safari', desc: 'Minor visual regression noticed internally on iPhone 14.', source: 'internal', tier: 'standard', moscow: 'wont', rice: null },
    { title: 'Add tooltip explanations to ROAS metric cards', desc: 'Requested by new customers unfamiliar with attribution terminology.', source: 'support', tier: 'standard', moscow: 'could', rice: null },
  ];

  const insert = db.prepare(`
    INSERT INTO issues (title, desc, source, tier, moscow, rice_reach, rice_impact, rice_confidence, rice_effort, rice_vip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items) => {
    for (const s of items) {
      insert.run(
        s.title, s.desc, s.source, s.tier, s.moscow,
        s.rice?.reach ?? null, s.rice?.impact ?? null,
        s.rice?.confidence ?? null, s.rice?.effort ?? null,
        s.rice?.vip ? 1 : 0
      );
    }
  });

  insertMany(samples);
  const rows = db.prepare('SELECT * FROM issues ORDER BY created_at DESC').all();
  res.json(rows.map(toIssue));
});

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({ ok: true, aiAvailable: hasApiKey, jiraAvailable: hasJira, jiraProject: jira.projectKey });
});

// ─── JIRA EXPORT ─────────────────────────────────────────────────────────────

app.post('/api/export/jira', async (req, res) => {
  if (!hasJira) {
    return res.status(400).json({
      error: 'JIRA not configured',
      setup: 'Add JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY to your .env file'
    });
  }

  const { issueIds } = req.body;
  const rows = issueIds?.length
    ? db.prepare(`SELECT * FROM issues WHERE id IN (${issueIds.map(() => '?').join(',')})`).all(...issueIds)
    : db.prepare(`SELECT * FROM issues WHERE moscow IN ('must','should') ORDER BY created_at DESC`).all();

  if (!rows.length) return res.status(400).json({ error: 'No issues to export' });

  const auth = Buffer.from(`${jira.email}:${jira.token}`).toString('base64');
  const results = [];

  for (const row of rows) {
    const reach = row.rice_vip ? (row.rice_reach || 0) * 2 : (row.rice_reach || 0);
    const score = row.rice_reach !== null
      ? ((reach * row.rice_impact * (row.rice_confidence / 100)) / row.rice_effort).toFixed(1)
      : null;

    const priority = row.moscow === 'must' ? 'High' : row.moscow === 'should' ? 'Medium' : 'Low';
    const issueType = row.moscow === 'must' ? 'Bug' : 'Story';

    const descLines = [
      row.desc || '',
      '',
      `*PriorityOS Data*`,
      `Source: ${row.source} | Tier: ${row.tier} | MoSCoW: ${row.moscow?.toUpperCase()}`,
      score ? `RICE Score: ${score}` : '',
    ].filter(l => l !== undefined);

    const body = {
      fields: {
        project:     { key: jira.projectKey },
        summary:     row.title,
        description: {
          type: 'doc', version: 1,
          content: descLines.map(line => ({
            type: 'paragraph',
            content: [{ type: 'text', text: line }]
          }))
        },
        issuetype: { name: issueType },
        priority:  { name: priority },
        labels:    ['priorityos', row.source, ...(row.tier === 'vip' ? ['vip'] : [])]
      }
    };

    try {
      const r = await fetch(`${jira.baseUrl}/rest/api/3/issue`, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (r.ok) {
        results.push({ issueId: row.id, jiraKey: data.key, jiraUrl: `${jira.baseUrl}/browse/${data.key}`, ok: true });
      } else {
        results.push({ issueId: row.id, ok: false, error: JSON.stringify(data.errors || data.errorMessages) });
      }
    } catch (e) {
      results.push({ issueId: row.id, ok: false, error: e.message });
    }
  }

  res.json({ results, project: jira.projectKey, baseUrl: jira.baseUrl });
});

// ─── THEMES ──────────────────────────────────────────────────────────────────

function toTheme(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, description: row.description,
    issueIds: JSON.parse(row.issue_ids || '[]'), rank: row.rank, budget: row.budget, createdAt: row.created_at };
}

app.get('/api/themes', (req, res) => {
  res.json(db.prepare('SELECT * FROM themes ORDER BY rank ASC').all().map(toTheme));
});

app.delete('/api/themes', (req, res) => {
  db.prepare('DELETE FROM solutions').run();
  db.prepare('DELETE FROM themes').run();
  res.json({ ok: true });
});

app.patch('/api/themes/:id', (req, res) => {
  const { id } = req.params;
  const { budget, rank } = req.body;
  if (budget !== undefined) db.prepare('UPDATE themes SET budget = ? WHERE id = ?').run(budget, id);
  if (rank   !== undefined) db.prepare('UPDATE themes SET rank = ? WHERE id = ?').run(rank, id);
  res.json(toTheme(db.prepare('SELECT * FROM themes WHERE id = ?').get(id)));
});

app.post('/api/themes/generate', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const issues = db.prepare('SELECT * FROM issues WHERE moscow IS NOT NULL').all();
  if (issues.length < 3) return res.status(400).json({ error: 'Need at least 3 classified issues first' });

  const list = issues.map(i =>
    `ID:${i.id} | [${i.moscow?.toUpperCase()}] ${i.title}${i.desc ? ' — ' + i.desc.slice(0, 120) : ''}`
  ).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1800,
      system: [{ type: 'text', text: THEMES_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Cluster these ${issues.length} issues into 5–10 strategic themes:\n\n${list}\n\nRespond with:\n{"themes":[{"name":"...","description":"...","issue_ids":[1,2],"rank":1,"budget":25}]}` }]
    });
    let text = response.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(text);

    db.prepare('DELETE FROM solutions').run();
    db.prepare('DELETE FROM themes').run();
    const ins = db.prepare('INSERT INTO themes (name, description, issue_ids, rank, budget) VALUES (?, ?, ?, ?, ?)');
    db.transaction(items => items.forEach(t =>
      ins.run(t.name, t.description || '', JSON.stringify(t.issue_ids || []), t.rank || 0, t.budget || 0)
    ))(parsed.themes);

    res.json(db.prepare('SELECT * FROM themes ORDER BY rank ASC').all().map(toTheme));
  } catch (err) {
    console.error('Themes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SOLUTIONS ────────────────────────────────────────────────────────────────

function toSolution(row) {
  if (!row) return null;
  return { id: row.id, themeId: row.theme_id, title: row.title, description: row.description,
    valueScore: row.value_score, effortScore: row.effort_score, createdAt: row.created_at };
}

app.get('/api/solutions', (req, res) => {
  const { theme_id } = req.query;
  const rows = theme_id
    ? db.prepare('SELECT * FROM solutions WHERE theme_id = ? ORDER BY value_score DESC').all(theme_id)
    : db.prepare('SELECT * FROM solutions ORDER BY theme_id, value_score DESC').all();
  res.json(rows.map(toSolution));
});

app.patch('/api/solutions/:id', (req, res) => {
  const { id } = req.params;
  const { value_score, effort_score } = req.body;
  if (value_score  !== undefined) db.prepare('UPDATE solutions SET value_score = ? WHERE id = ?').run(value_score, id);
  if (effort_score !== undefined) db.prepare('UPDATE solutions SET effort_score = ? WHERE id = ?').run(effort_score, id);
  res.json(toSolution(db.prepare('SELECT * FROM solutions WHERE id = ?').get(id)));
});

app.delete('/api/solutions/:id', (req, res) => {
  db.prepare('DELETE FROM solutions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/solutions/generate', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const { theme_id } = req.body;
  if (!theme_id) return res.status(400).json({ error: 'theme_id required' });

  const theme = db.prepare('SELECT * FROM themes WHERE id = ?').get(theme_id);
  if (!theme) return res.status(404).json({ error: 'Theme not found' });

  const ids = JSON.parse(theme.issue_ids || '[]');
  const issues = ids.length
    ? db.prepare(`SELECT * FROM issues WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : [];
  const issueList = issues.map(i => `- ${i.title}${i.desc ? ': ' + i.desc.slice(0, 120) : ''}`).join('\n') || '(no linked issues)';

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1400,
      system: [{ type: 'text', text: SOLUTIONS_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Theme: "${theme.name}"\nCore problem: ${theme.description}\n\nRelated issues:\n${issueList}\n\nRespond with:\n{"solutions":[{"title":"...","description":"...","value_score":8,"effort_score":3}]}` }]
    });
    let text = response.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(text);

    db.prepare('DELETE FROM solutions WHERE theme_id = ?').run(theme_id);
    const ins = db.prepare('INSERT INTO solutions (theme_id, title, description, value_score, effort_score) VALUES (?, ?, ?, ?, ?)');
    db.transaction(items => items.forEach(s =>
      ins.run(theme_id, s.title, s.description || '', s.value_score ?? 5, s.effort_score ?? 5)
    ))(parsed.solutions);

    res.json(db.prepare('SELECT * FROM solutions WHERE theme_id = ? ORDER BY value_score DESC').all(theme_id).map(toSolution));
  } catch (err) {
    console.error('Solutions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── EVAL ─────────────────────────────────────────────────────────────────────

app.get('/api/evals/goldens', (req, res) => {
  res.json(EVAL_GOLDENS.map(g => ({
    id: g.id, scenario: g.scenario, category: g.category, input: g.input, expected: g.expected
  })));
});

app.post('/api/evals/run', async (req, res) => {
  if (!anthropic) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const results = [];
  for (const golden of EVAL_GOLDENS) {
    let output;
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 512,
        system: [{ type: 'text', text: CLASSIFY_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content:
          `Classify this issue and suggest RICE inputs:\n\nTitle: ${golden.input.title}\nDescription: ${golden.input.desc || 'N/A'}\nSource: ${golden.input.source}\nCustomer Tier: ${golden.input.tier}\n\nRespond with JSON exactly like this:\n{"moscow":"must|should|could|wont","moscow_reasoning":"one sentence why","rice":{"reach":<1-10>,"impact":<0.5|1|2|3>,"confidence":<20|50|80|100>,"effort":<0.5|1|2|4|8>},"rice_reasoning":"one sentence"}`
        }]
      });
      let text = response.content[0].text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
      output = JSON.parse(text);
    } catch(e) {
      output = { moscow: null, moscow_reasoning: '', rice: null, rice_reasoning: '', error: e.message };
    }
    const result = await gradeGolden(golden, output);
    results.push(result);
  }

  const passed = results.filter(r => r.passed).length;
  const criticals = results.filter(r => r.critical_error).length;
  const dimScores = {};
  for (const r of results) {
    for (const [dim, score] of Object.entries(r.scores)) {
      if (score != null) { dimScores[dim] = (dimScores[dim] || []); dimScores[dim].push(score); }
    }
  }
  const avgDims = Object.fromEntries(
    Object.entries(dimScores).map(([d,vs]) => [d, Math.round(vs.reduce((a,b)=>a+b,0)/vs.length*10)/10])
  );
  const overall = Object.values(avgDims).length
    ? Math.round(Object.values(avgDims).reduce((a,b)=>a+b,0) / Object.values(avgDims).length * 10) / 10
    : 0;

  const summary = {
    total: EVAL_GOLDENS.length, passed, failed: EVAL_GOLDENS.length - passed,
    pass_rate: `${Math.round(passed / EVAL_GOLDENS.length * 100)}%`,
    critical_errors: criticals, overall_score: overall, average_scores: avgDims
  };

  db.prepare(`INSERT INTO eval_runs (total, passed, pass_rate, critical_errors, overall_score, results)
    VALUES (?,?,?,?,?,?)`).run(summary.total, summary.passed, summary.pass_rate, summary.critical_errors, summary.overall_score, JSON.stringify({ summary, results }));

  res.json({ summary, results });
});

app.get('/api/evals/runs', (req, res) => {
  const rows = db.prepare('SELECT id, run_at, total, passed, pass_rate, critical_errors, overall_score FROM eval_runs ORDER BY run_at DESC LIMIT 10').all();
  res.json(rows);
});

app.get('/api/evals/runs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM eval_runs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Run not found' });
  res.json(JSON.parse(row.results));
});

// GET /api/metrics  — AI feedback loop stats for dashboard Go/No-Go panel
app.get('/api/metrics', (req, res) => {
  const total    = db.prepare('SELECT COUNT(*) as c FROM ai_logs').get().c;
  const resolved = db.prepare('SELECT COUNT(*) as c FROM ai_logs WHERE human_moscow IS NOT NULL').get().c;
  const agreed   = db.prepare('SELECT COUNT(*) as c FROM ai_logs WHERE agreed = 1').get().c;
  const avgLat   = db.prepare('SELECT AVG(latency_ms) as a FROM ai_logs WHERE latency_ms IS NOT NULL').get().a;

  const confusion = db.prepare(`
    SELECT ai_moscow, human_moscow, COUNT(*) as count
    FROM ai_logs WHERE human_moscow IS NOT NULL
    GROUP BY ai_moscow, human_moscow ORDER BY count DESC
  `).all();

  const agreementRate = resolved >= 1 ? Math.round(agreed / resolved * 100) : null;
  const goNoGo = resolved < 5   ? 'insufficient'
    : agreementRate >= 75        ? 'go'
    : agreementRate >= 50        ? 'review'
    :                              'no-go';

  res.json({
    total, resolved, agreed,
    disagreed: resolved - agreed,
    agreementRate,
    avgLatencyMs: avgLat ? Math.round(avgLat) : null,
    confusion,
    goNoGo,
    thresholds: { go: 75, review: 50 }
  });
});

// Catch-all → serve index.html
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── AUTO-SEED ON COLD START ─────────────────────────────────────────────────
function autoSeed() {
  const count = db.prepare('SELECT COUNT(*) as n FROM issues').get().n;
  if (count > 0) return;

  const samples = [
    { title: 'Google Ads attribution data stopped syncing for all accounts', desc: 'Campaign performance data has not updated since 02:00 UTC. All customers seeing stale ROAS numbers. Affects automated bid strategies that rely on live conversion data.', source: 'analytics', tier: 'vip', moscow: 'must', rice: { reach: 10, impact: 3, confidence: 100, effort: 2, vip: true } },
    { title: 'Lead scoring model returning inverted rankings — low-intent leads marked as hot', desc: 'Multiple enterprise customers reporting their sales reps are calling cold leads first. Root cause appears to be a model weight flip after last nights retrain pipeline. Churning one account over this.', source: 'cs', tier: 'vip', moscow: 'must', rice: { reach: 10, impact: 3, confidence: 100, effort: 1, vip: true } },
    { title: 'AI ad copy generation returning null for 38% of requests', desc: 'Product analytics alert: copy generation endpoint has a 38% null response rate since the v2.4 deploy. Customers on the Growth plan cannot generate new ad variants.', source: 'analytics', tier: 'standard', moscow: 'must', rice: { reach: 6, impact: 3, confidence: 100, effort: 2, vip: false } },
    { title: 'Automated bidding engine paused — all campaigns running on manual bids', desc: 'Budget optimization engine crashed at 06:14 UTC. Estimated $240k in managed ad spend now running without optimization. Three enterprise customers have escalated.', source: 'cs', tier: 'vip', moscow: 'must', rice: { reach: 10, impact: 3, confidence: 100, effort: 2, vip: true } },
    { title: 'Revenue forecast dashboard showing $0 for current and next quarter', desc: 'All customers on the Analytics Pro tier see $0 in the revenue forecast widget. The underlying pipeline data is intact — this appears to be a rendering or query bug.', source: 'support', tier: 'standard', moscow: 'must', rice: { reach: 8, impact: 3, confidence: 100, effort: 1, vip: false } },
    { title: 'Salesforce CRM sync dropping contact updates when deal stage changes', desc: 'When a deal moves from Qualified to Proposal in Salesforce, the corresponding lead record does not update. Affects 6 enterprise accounts using the native Salesforce integration.', source: 'support', tier: 'vip', moscow: 'must', rice: { reach: 10, impact: 3, confidence: 100, effort: 4, vip: true } },
    { title: 'Lookalike audience builder silently fails on seed audiences above 500k', desc: 'Analytics shows a 0% success rate for lookalike jobs using large seeds. No error shown — job just disappears. Affects ecommerce customers with large first-party data.', source: 'analytics', tier: 'standard', moscow: 'must', rice: { reach: 6, impact: 2, confidence: 100, effort: 2, vip: false } },
    { title: 'Competitor ad intelligence feed stale — no new ads indexed in 5 days', desc: 'The competitive intelligence module shows no new ads from tracked competitors since Monday. Customers on Intelligence tier use this daily for creative benchmarking.', source: 'sales', tier: 'standard', moscow: 'must', rice: { reach: 6, impact: 2, confidence: 100, effort: 2, vip: false } },
    { title: 'Audience segmentation export timing out for cohorts larger than 500k records', desc: 'Power users in the retail vertical frequently build audiences of 1M+ records. Export jobs fail silently after 10 minutes. Users have to split manually.', source: 'support', tier: 'standard', moscow: 'should', rice: { reach: 4, impact: 2, confidence: 80, effort: 4, vip: false } },
    { title: 'Email sequence performance metrics delayed by 48+ hours', desc: 'Open rates, CTR, and reply rates for outbound sequences are not updating in real time. Sales teams cannot make intra-day adjustments to active campaigns.', source: 'sales', tier: 'standard', moscow: 'should', rice: { reach: 6, impact: 2, confidence: 80, effort: 2, vip: false } },
    { title: 'AI copywriter ignores saved brand voice guidelines after account reconnect', desc: 'When a customer disconnects and reconnects their ad account, brand voice settings are silently reset to defaults. Affects tone, vocabulary blacklists, and CTA style.', source: 'support', tier: 'standard', moscow: 'should', rice: { reach: 4, impact: 2, confidence: 80, effort: 2, vip: false } },
    { title: 'HubSpot integration not mapping custom deal properties on initial sync', desc: 'Custom deal stage and revenue properties created in HubSpot are not pulled during the first sync. Users have to manually re-map after every fresh integration setup.', source: 'support', tier: 'standard', moscow: 'should', rice: { reach: 4, impact: 1, confidence: 80, effort: 2, vip: false } },
    { title: 'Add campaign comparison view — overlay two date ranges on the same chart', desc: 'Multiple customers requested period-over-period comparison in a single chart rather than switching between date ranges manually.', source: 'sales', tier: 'standard', moscow: 'should', rice: { reach: 5, impact: 1, confidence: 50, effort: 2, vip: false } },
    { title: 'Improve empty state messaging on the Audiences page for new accounts', desc: 'New users who have not imported data see a blank page with no guidance. Should show a walkthrough prompt or sample audience.', source: 'internal', tier: 'standard', moscow: 'should', rice: { reach: 3, impact: 1, confidence: 50, effort: 1, vip: false } },
    { title: 'Export reports as PowerPoint in addition to PDF', desc: 'Several agency customers requested PPTX export so they can drop charts directly into client decks without reformatting.', source: 'sales', tier: 'standard', moscow: 'could', rice: null },
    { title: 'Build a native iOS and Android mobile app', desc: 'One SMB prospect mentioned they would prefer a mobile app during a sales demo. No other requests on record.', source: 'sales', tier: 'standard', moscow: 'wont', rice: null },
    { title: 'Add WhatsApp as an outreach channel', desc: 'Single support ticket requesting WhatsApp integration. Not on roadmap. Would require separate compliance review for each market.', source: 'support', tier: 'standard', moscow: 'wont', rice: null },
    { title: 'Change the sidebar icon for the Audiences module', desc: 'Internal design feedback from one team member that the current icon looks too similar to the Segments icon.', source: 'internal', tier: 'standard', moscow: 'could', rice: null },
  ];

  const insert = db.prepare(`
    INSERT INTO issues (title, desc, source, tier, moscow, rice_reach, rice_impact, rice_confidence, rice_effort, rice_vip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction((items) => {
    for (const s of items) {
      insert.run(s.title, s.desc, s.source, s.tier, s.moscow,
        s.rice?.reach ?? null, s.rice?.impact ?? null,
        s.rice?.confidence ?? null, s.rice?.effort ?? null,
        s.rice?.vip ? 1 : 0);
    }
  });
  insertAll(samples);
  console.log('  Auto-seeded 18 sample issues for demo.');
}

autoSeed();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  PriorityOS running at http://localhost:${PORT}`);
  console.log(`  AI classification: ${hasApiKey ? '✅ enabled (Claude Haiku 4.5)' : '⚠️  disabled (add ANTHROPIC_API_KEY to .env)'}\n`);
});
