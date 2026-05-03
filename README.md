# PriorityOS — AI-Powered PM Issue Triage

**Live demo → [priority-os-production.up.railway.app](https://priority-os-production.up.railway.app)**

A full-stack product management triage tool that takes raw incoming issues and runs them through a structured PM workflow: MoSCoW classification → RICE scoring → theme clustering → solution strategy → roadmap planning → JIRA export.

Built with Node.js / Express, SQLite, and Claude Haiku 4.5 for AI-assisted classification, clustering, and performance measurement.

---

## Features

### 1. Issue Intake
Capture incoming issues from any source — Customer Support, Product Analytics, Sales, Customer Success, or Internal stakeholders. Each issue records a title, description, source, and customer tier (Standard / VIP).

**CSV Import** — bulk-load issues from a spreadsheet in one click. Click **↑ Import CSV** in the nav, drag-and-drop (or browse for) a `.csv` file, preview the parsed rows, and confirm. A downloadable template is provided.

Required column: `title` — Optional: `description`, `source`, `tier`

```csv
title,description,source,tier
Login crashes on mobile,"iOS Safari white screen after submit",support,vip
Dashboard loads slowly,"8+ seconds for large accounts",analytics,standard
```

Valid `source` values: `support`, `analytics`, `sales`, `internal`, `cs`
Valid `tier` values: `standard`, `vip` (anything else defaults to `standard`)

### 2. MoSCoW Classification
Classify every issue into one of four buckets:

| Label | Meaning |
|-------|---------|
| **Must Have** | Revenue-critical, SLA breach, core function broken |
| **Should Have** | Important, workaround exists, affects >10% users |
| **Could Have** | Nice to have, low urgency, <5% impact |
| **Won't Have** | Noise, out of scope, duplicate, feature creep |

One-click **AI classify** (Claude Haiku 4.5) suggests a MoSCoW label with a reasoning sentence. Every AI suggestion is logged with a timestamp and latency so agreement vs. override can be tracked over time.

### 3. RICE Scoring
Score Must/Should issues on four dimensions:

- **Reach** — accounts affected per sprint (1–10)
- **Impact** — effect on core metrics (0.5 / 1 / 2 / 3)
- **Confidence** — certainty in estimates (20% / 50% / 80% / 100%)
- **Effort** — engineering person-weeks (0.5 / 1 / 2 / 4 / 8)

`RICE = (Reach × Impact × Confidence%) ÷ Effort`

VIP/Enterprise accounts apply a 2× reach multiplier. AI can suggest RICE inputs based on the issue context.

### 4. Prioritized Backlog
Ranked list of all scored issues sorted by RICE score descending. Issues are bucketed into three tiers:

| Tier | RICE Score | Action |
|------|-----------|--------|
| **Escalation** | ≥ 40 | Assign owner within 24 hours |
| **Sprint** | 20–39 | Include in next sprint |
| **Future** | < 20 | Backlog for later |

### 5. Problem Themes
AI clusters all classified issues into 5–10 strategic themes — core problem areas that, if solved, would eliminate multiple issues at once.

Each theme includes:
- A **$100 budget allocation test** — AI distributes a notional $100 across themes by expected ROI (all must sum to exactly 100)
- Issue count and rank by business impact
- One-click navigation to that theme's solution strategy

### 6. Solution Strategy — 4-Quadrant Matrix
For any theme, AI generates 5–8 solution approaches and plots them on a **Value × Effort matrix**:

| Quadrant | Action |
|----------|--------|
| High Value · Low Effort | **Do First** |
| High Value · High Effort | **Plan for Quarter** |
| Low Value · Low Effort | **Do in Slack** |
| Low Value · High Effort | **Drop** |

### 7. Now / Next / Later Roadmap
A three-column roadmap auto-populated from RICE tiers:

- **Now** — Escalation-tier issues (RICE ≥ 40)
- **Next** — Sprint-tier issues (RICE 20–39)
- **Later** — Future-tier issues (RICE < 20)

Column assignments can be manually overridden per issue and are persisted to the database.

### 8. JIRA Export
Push Must Have and Should Have issues directly to a JIRA project:

- Must Have → **Bug** with **High** priority
- Should Have → **Story** with **Medium** priority
- Each ticket gets `priorityos`, source, and tier labels
- Results display created ticket keys as clickable links

Requires JIRA credentials in environment variables (see Setup).

### 9. PM Dashboard
System health overview — noise eliminated %, escalation count, sprint backlog size, pipeline completion rate, MoSCoW distribution, RICE tier breakdown, source mix, and the **AI Classifier Go/No-Go panel** (see below).

### 10. AI Eval Tab
Ground-truth evaluation runner. Feed labeled test cases into the classifier and measure accuracy against known-correct MoSCoW labels. Tracks pass/fail per scenario and surfaces systematic misclassification patterns.

---

## AI Performance Monitoring

### Model performance metrics
Every call to the AI classifier is logged to an `ai_logs` table:

| Column | Description |
|--------|-------------|
| `ai_moscow` | Label the model predicted |
| `human_moscow` | Label the PM ultimately assigned |
| `agreed` | 1 if they match, 0 if the PM overrode |
| `latency_ms` | Round-trip time for the API call |

This produces a live **agreement rate** and **confusion matrix** accessible at `/api/metrics`.

### Feedback loop
Human overrides are the feedback signal. When a PM changes an AI-suggested label, the disagreement is recorded. These rows can be used to:
- Identify systematic misclassification (e.g. AI over-classifies `could` as `should`)
- Refine the system prompt rubric based on real override patterns
- Build a labeled dataset for fine-tuning a future custom classifier

### Training approach
PriorityOS uses **zero-shot prompt inference** — no custom model training. The PM rubric (MoSCoW definitions, VIP tier rules, source context) is encoded directly in the system prompt. This approach is appropriate here because:
- Labeled training data is scarce at launch
- Prompt iteration is faster than fine-tuning cycles
- Domain knowledge (what "Must Have" means for this product) changes frequently

### Go/No-Go thresholds
The Dashboard tab shows a live **Go/No-Go verdict** based on AI vs. human agreement rate:

| Verdict | Condition | Meaning |
|---------|-----------|---------|
| **GO** | ≥ 75% agreement | AI is reliable — proceed to wider rollout |
| **REVIEW** | 50–74% agreement | Acceptable but prompt needs tuning |
| **NO-GO** | < 50% agreement | AI is unreliable — do not use in production |
| **Pending** | < 5 reviews | Insufficient data to decide |

Exposed via `GET /api/metrics`:
```json
{
  "total": 15,
  "resolved": 15,
  "agreed": 14,
  "agreementRate": 93,
  "avgLatencyMs": 3676,
  "goNoGo": "go",
  "thresholds": { "go": 75, "review": 50 },
  "confusion": [
    { "ai_moscow": "must", "human_moscow": "must", "count": 8 },
    { "ai_moscow": "could", "human_moscow": "wont", "count": 1 }
  ]
}
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express 5 |
| Database | SQLite (better-sqlite3) |
| AI | Anthropic Claude Haiku 4.5 |
| Frontend | Vanilla JS + Tailwind CDN |
| Fonts | DM Sans + DM Mono |
| Hosting | Railway |

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/MayankSewatkar/issue-prioritization-tool.git
cd issue-prioritization-tool
npm install
```

### 2. Configure environment

Create a `.env` file in the project root:

```env
# Required for AI features
ANTHROPIC_API_KEY=sk-ant-...

# Optional — required for JIRA export
JIRA_BASE_URL=https://yourorg.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=your_api_token
JIRA_PROJECT_KEY=MYPROJ
```

To get a JIRA API token: **Atlassian account settings → Security → API tokens**.

### 3. Run

```bash
# Production
npm start

# Development (auto-restart on file changes)
npm run dev
```

Open `http://localhost:3000` in your browser.

---

## Deploy to Railway

### 1. Install Railway CLI and login

```bash
npm install -g @railway/cli
railway login
```

### 2. Link and deploy

```bash
railway init        # create a new project
railway up          # deploy
railway domain      # generate a public URL
```

### 3. Set environment variables

```bash
railway variables set ANTHROPIC_API_KEY=sk-ant-...

# Optional JIRA
railway variables set JIRA_BASE_URL=https://yourorg.atlassian.net
railway variables set JIRA_EMAIL=you@company.com
railway variables set JIRA_API_TOKEN=your_token
railway variables set JIRA_PROJECT_KEY=MYPROJ
```

Railway auto-injects `PORT` — the app reads it via `process.env.PORT`.

---

## Workflow

```
Intake → MoSCoW → RICE Score → Backlog → Themes → Strategy → Roadmap → JIRA
```

1. **Add issues** via the Intake tab, click "Load Samples" for demo data, or **↑ Import CSV** to bulk-load from a spreadsheet
2. **Classify** each issue in the MoSCoW tab (manual or AI) — every AI call is logged
3. **Score** Must/Should issues in the RICE tab
4. **Review** the ranked Backlog
5. **Generate Themes** to cluster issues into strategic buckets
6. **Build Strategy** — select a theme and generate its solution matrix
7. **Plan Roadmap** — review Now/Next/Later columns, override as needed
8. **Export to JIRA** — push issues directly to your sprint board
9. **Monitor performance** — Dashboard → Go/No-Go panel shows live AI accuracy

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/issues` | GET | All issues |
| `/api/issues` | POST | Create issue (accepts `log_id` to link AI suggestion) |
| `/api/issues/:id` | PATCH | Update MoSCoW, RICE, or roadmap column (triggers feedback log) |
| `/api/import` | POST | Bulk import issues from a parsed CSV (`{ rows: [...] }`) |
| `/api/classify` | POST | AI MoSCoW + RICE suggestion (returns `logId`, `latencyMs`) |
| `/api/metrics` | GET | AI performance stats — agreement rate, latency, confusion matrix, Go/No-Go |
| `/api/themes` | GET/POST | Manage problem theme clusters |
| `/api/strategy` | POST | Generate 4-quadrant solution matrix for a theme |
| `/api/roadmap` | GET | Issues grouped by Now/Next/Later |
| `/api/eval/runs` | GET/POST | AI eval test runs |

---

## Project Structure

```
issue-prioritization-tool/
├── server.js       # Express API + SQLite + Anthropic integration
├── index.html      # Single-page frontend (all JS inline)
├── seed-ai.js      # Script to seed sample issues via the API
├── package.json
├── .env            # Your secrets (not committed)
└── issues.db       # SQLite database (auto-created on first run)
```

---

## AI Features

All AI features require `ANTHROPIC_API_KEY`. The app degrades gracefully — all manual workflows remain fully functional without it.

| Feature | Model | Logged |
|---------|-------|--------|
| MoSCoW classification | Claude Haiku 4.5 | Yes — agreement rate tracked |
| RICE input suggestion | Claude Haiku 4.5 | No |
| Theme clustering | Claude Haiku 4.5 | No |
| Solution generation | Claude Haiku 4.5 | No |
| Ground-truth eval | Claude Haiku 4.5 | Yes — per-run pass/fail |
