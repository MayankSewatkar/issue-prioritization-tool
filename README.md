# PriorityOS — AI-Powered PM Issue Triage

**Live demo → [priority-os-production.up.railway.app](https://priority-os-production.up.railway.app)**

A full-stack product management triage tool that takes raw incoming issues and runs them through a structured PM workflow: MoSCoW classification → RICE scoring → theme clustering → solution strategy → roadmap planning → JIRA export.

Built with Node.js / Express, SQLite, and Claude Haiku 4.5 for AI-assisted classification and clustering.

---

## Features

### 1. Issue Intake
Capture incoming issues from any source — Customer Support, Product Analytics, Sales, Customer Success, or Internal stakeholders. Each issue records a title, description, source, and customer tier (Standard / VIP).

### 2. MoSCoW Classification
Classify every issue into one of four buckets:

| Label | Meaning |
|-------|---------|
| **Must Have** | Revenue-critical, SLA breach, core function broken |
| **Should Have** | Important, workaround exists, affects >10% users |
| **Could Have** | Nice to have, low urgency, <5% impact |
| **Won't Have** | Noise, out of scope, duplicate, feature creep |

Includes one-click **AI classify** (Claude Haiku 4.5) that suggests a MoSCoW label with a reasoning sentence.

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
System health overview — noise eliminated %, escalation count, sprint backlog size, pipeline completion rate, MoSCoW distribution, RICE tier breakdown, and source mix.

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

1. **Add issues** via the Intake tab or click "Load Samples" for demo data
2. **Classify** each issue in the MoSCoW tab (manual or AI)
3. **Score** Must/Should issues in the RICE tab
4. **Review** the ranked Backlog
5. **Generate Themes** to cluster issues into strategic buckets
6. **Build Strategy** — select a theme and generate its solution matrix
7. **Plan Roadmap** — review Now/Next/Later columns, override as needed
8. **Export to JIRA** — push issues directly to your sprint board

---

## Project Structure

```
issue-prioritization-tool/
├── server.js       # Express API + SQLite + Anthropic integration
├── index.html      # Single-page frontend (all JS inline)
├── package.json
├── .env            # Your secrets (not committed)
└── issues.db       # SQLite database (auto-created on first run)
```

---

## AI Features

All AI features require `ANTHROPIC_API_KEY`. The app degrades gracefully — all manual workflows remain fully functional without it.

| Feature | Model | Prompt caching |
|---------|-------|---------------|
| MoSCoW classification | Claude Haiku 4.5 | Yes |
| RICE input suggestion | Claude Haiku 4.5 | Yes |
| Theme clustering | Claude Haiku 4.5 | Yes |
| Solution generation | Claude Haiku 4.5 | Yes |
