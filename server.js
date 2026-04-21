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
    createdAt: row.created_at
  };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// GET /api/issues
app.get('/api/issues', (req, res) => {
  const rows = db.prepare('SELECT * FROM issues ORDER BY created_at DESC').all();
  res.json(rows.map(toIssue));
});

// POST /api/issues
app.post('/api/issues', (req, res) => {
  const { title, desc = '', source = 'support', tier = 'standard', hint = '' } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });

  const stmt = db.prepare(`
    INSERT INTO issues (title, desc, source, tier, hint, moscow)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(title.trim(), desc, source, tier, hint, hint || null);
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(toIssue(row));
});

// PATCH /api/issues/:id
app.patch('/api/issues/:id', (req, res) => {
  const { id } = req.params;
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Issue not found' });

  const { moscow, rice } = req.body;
  if (moscow !== undefined) {
    db.prepare('UPDATE issues SET moscow = ? WHERE id = ?').run(moscow, id);
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

  const { title, desc, source, tier } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

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

    let text = response.content[0].text.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(text);
    res.json({ ...parsed, aiAvailable: true });
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
  res.json({ ok: true, aiAvailable: hasApiKey });
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
