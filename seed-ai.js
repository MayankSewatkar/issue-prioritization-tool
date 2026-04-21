require('dotenv').config();

const BASE = 'http://localhost:3000';

const issues = [
  // ── CRITICAL / LIKELY MUST HAVE ──────────────────────────────────────────
  {
    title: 'Google Ads attribution data stopped syncing for all accounts',
    desc: 'Campaign performance data has not updated since 02:00 UTC. All customers seeing stale ROAS numbers. Affects automated bid strategies that rely on live conversion data.',
    source: 'analytics',
    tier: 'vip',
  },
  {
    title: 'Lead scoring model returning inverted rankings — low-intent leads marked as hot',
    desc: 'Multiple enterprise customers reporting their sales reps are calling cold leads first. Root cause appears to be a model weight flip after last nights retrain pipeline. Churning one account over this.',
    source: 'cs',
    tier: 'vip',
  },
  {
    title: 'AI ad copy generation returning null for 38% of requests',
    desc: 'Product analytics alert: copy generation endpoint has a 38% null response rate since the v2.4 deploy. Customers on the Growth plan cannot generate new ad variants.',
    source: 'analytics',
    tier: 'standard',
  },
  {
    title: 'Automated bidding engine paused — all campaigns running on manual bids',
    desc: 'Budget optimization engine crashed at 06:14 UTC. Estimated $240k in managed ad spend now running without optimization. Three enterprise customers have already escalated.',
    source: 'cs',
    tier: 'vip',
  },
  {
    title: 'Revenue forecast dashboard showing $0 for current and next quarter',
    desc: 'All customers on the Analytics Pro tier see $0 in the revenue forecast widget. The underlying pipeline data is intact — this appears to be a rendering or query bug introduced in last nights release.',
    source: 'support',
    tier: 'standard',
  },

  // ── IMPORTANT / LIKELY SHOULD HAVE ───────────────────────────────────────
  {
    title: 'Salesforce CRM sync dropping contact updates when deal stage changes',
    desc: 'When a deal moves from Qualified to Proposal in Salesforce, the corresponding lead record in our platform does not update. Affects 6 enterprise accounts using the native Salesforce integration.',
    source: 'support',
    tier: 'vip',
  },
  {
    title: 'Audience segmentation export timing out for cohorts larger than 500k records',
    desc: 'Power users in the retail vertical frequently build audiences of 1M+ records. Export jobs fail silently after 10 minutes with no error message. Users have to split manually.',
    source: 'support',
    tier: 'standard',
  },
  {
    title: 'Email sequence performance metrics delayed by 48+ hours',
    desc: 'Open rates, click-through rates, and reply rates for outbound sequences are not updating in real time. Sales teams cannot make intra-day adjustments to active campaigns.',
    source: 'sales',
    tier: 'standard',
  },
  {
    title: 'Lookalike audience builder silently fails on seed audiences above 500k',
    desc: 'Analytics shows a 0% success rate for lookalike jobs using large seeds. No error is shown to the user — job just disappears from the queue. Affects ecommerce customers with large first-party data.',
    source: 'analytics',
    tier: 'standard',
  },
  {
    title: 'AI copywriter ignores saved brand voice guidelines after account reconnect',
    desc: 'When a customer disconnects and reconnects their ad account (common during onboarding audits), brand voice settings are silently reset to defaults. Affects tone, vocabulary blacklists, and CTA style.',
    source: 'support',
    tier: 'standard',
  },
  {
    title: 'Competitor ad intelligence feed stale — no new ads indexed in 5 days',
    desc: 'The competitive intelligence module shows no new ads from tracked competitors since Monday. Customers on the Intelligence tier use this daily for creative benchmarking.',
    source: 'sales',
    tier: 'standard',
  },
  {
    title: 'HubSpot integration not mapping custom deal properties on initial sync',
    desc: 'Custom deal stage and revenue properties created in HubSpot are not pulled during the first sync. Users have to manually re-map after every fresh integration setup.',
    source: 'support',
    tier: 'standard',
  },

  // ── LOW PRIORITY / COULD HAVE ─────────────────────────────────────────────
  {
    title: 'Add campaign comparison view — overlay two date ranges on the same chart',
    desc: 'Multiple customers have requested the ability to compare period-over-period performance in a single chart rather than switching between date ranges manually.',
    source: 'sales',
    tier: 'standard',
  },
  {
    title: 'Improve empty state messaging on the Audiences page for new accounts',
    desc: 'New users who have not yet imported data see a blank page with no guidance. Should show a walkthrough prompt or sample audience to illustrate value.',
    source: 'internal',
    tier: 'standard',
  },
  {
    title: 'Export reports as PowerPoint in addition to PDF',
    desc: 'Several agency customers requested PPTX export so they can drop charts directly into client decks without reformatting.',
    source: 'sales',
    tier: 'standard',
  },

  // ── NOISE / WON'T HAVE ────────────────────────────────────────────────────
  {
    title: 'Build a native iOS and Android mobile app',
    desc: 'One SMB prospect mentioned they would prefer a mobile app during a sales demo. No other requests on record.',
    source: 'sales',
    tier: 'standard',
  },
  {
    title: 'Add WhatsApp as an outreach channel',
    desc: 'Single support ticket requesting WhatsApp integration. Not on roadmap. Would require separate compliance review for each market.',
    source: 'support',
    tier: 'standard',
  },
  {
    title: 'Change the sidebar icon for the Audiences module to something more intuitive',
    desc: 'Internal design feedback from one team member that the current icon looks too similar to the Segments icon.',
    source: 'internal',
    tier: 'standard',
  },
];

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function patch(path, body) {
  const res = await fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function del(path) {
  await fetch(BASE + path, { method: 'DELETE' });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('\n🗑️  Clearing existing issues...');
  await del('/api/issues');

  console.log(`\n📥 Creating ${issues.length} synthetic issues...\n`);

  for (let i = 0; i < issues.length; i++) {
    const iss = issues[i];
    process.stdout.write(`  [${String(i+1).padStart(2,'0')}/${issues.length}] ${iss.title.slice(0,55)}...`);

    // Create the issue
    const created = await post('/api/issues', iss);

    // AI classify + RICE suggest
    const ai = await post('/api/classify', {
      title: iss.title,
      desc: iss.desc,
      source: iss.source,
      tier: iss.tier,
    });

    if (ai.error || !ai.moscow) {
      console.log(' ❌ AI error:', ai.error);
      continue;
    }

    // Apply MoSCoW
    await patch(`/api/issues/${created.id}`, { moscow: ai.moscow });

    // Apply RICE if forwarded
    if (ai.rice && (ai.moscow === 'must' || ai.moscow === 'should')) {
      await patch(`/api/issues/${created.id}`, {
        rice: {
          reach:      ai.rice.reach,
          impact:     ai.rice.impact,
          confidence: ai.rice.confidence,
          effort:     ai.rice.effort,
          vip:        iss.tier === 'vip',
        },
      });
    }

    const riceStr = ai.rice
      ? ` | RICE R:${ai.rice.reach} I:${ai.rice.impact} C:${ai.rice.confidence} E:${ai.rice.effort}`
      : '';
    console.log(` ✓  → ${ai.moscow.toUpperCase().padEnd(6)}${riceStr}`);

    // Small delay to avoid rate limits
    await sleep(300);
  }

  console.log('\n✅ Done! Open http://localhost:3000 to see the full pipeline.\n');
}

run().catch(console.error);
