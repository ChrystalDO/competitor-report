// generate-report.js
// Pulls last 30 days of promotional emails from Gmail,
// analyses them with Claude, and writes a fresh index.html

const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const https = require('https');

const isDryRun = process.argv.includes('--dry-run');

// ── NETWORK WORKAROUND ───────────────────────────────────────────────────────
// Recent Node.js versions (22.x/24.x) changed how keep-alive sockets get reused,
// which triggers a known bug in gaxios/node-fetch where a pooled socket to
// *.googleapis.com gets closed mid-response. This surfaces as:
//   GaxiosError: Invalid response body ... Premature close (ERR_STREAM_PREMATURE_CLOSE)
// most commonly during the OAuth2 token refresh. Disabling keep-alive avoids the
// bad socket reuse entirely (each request gets a fresh connection).
https.globalAgent = new https.Agent({ keepAlive: false });

// ── RETRY HELPER ──────────────────────────────────────────────────────────────
async function withRetry(fn, { retries = 4, baseDelayMs = 1000, label = 'operation' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isPrematureClose =
        err.code === 'ERR_STREAM_PREMATURE_CLOSE' ||
        err.message?.includes('Premature close') ||
        err.cause?.code === 'ERR_STREAM_PREMATURE_CLOSE';

      if (attempt === retries || !isPrematureClose) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`  ${label} failed (${err.message}) — retrying in ${delay}ms [attempt ${attempt}/${retries}]`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
  throw lastErr;
}

// ── GMAIL AUTH ──────────────────────────────────────────────────────────────
async function getGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN
  });

  // Force the token refresh up front, wrapped in our own retry loop.
  // This makes auth failures fail fast/clearly here rather than resurfacing
  // deep inside the first Gmail API call, and gives premature-close errors
  // more (and longer-backed-off) chances to succeed than gaxios's internal retry alone.
  await withRetry(() => auth.getAccessToken(), { label: 'OAuth token refresh' });

  return google.gmail({ version: 'v1', auth });
}

// ── FETCH EMAILS ─────────────────────────────────────────────────────────────
async function fetchPromotionalEmails(gmail) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateStr = thirtyDaysAgo.toISOString().split('T')[0].replace(/-/g, '/');

  console.log(`Fetching promotional emails since ${dateStr}...`);

  const threads = [];
  let pageToken = null;

  do {
    const res = await gmail.users.threads.list({
      userId: 'me',
      q: `category:promotions after:${dateStr}`,
      maxResults: 50,
      pageToken: pageToken || undefined
    });

    const batch = res.data.threads || [];
    console.log(`  Found ${batch.length} threads on this page`);

    // Fetch full content for each thread
    for (const thread of batch) {
      try {
        const full = await gmail.users.threads.get({
          userId: 'me',
          id: thread.id,
          format: 'full'
        });

        const msg = full.data.messages?.[0];
        if (!msg) continue;

        const headers = msg.payload?.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const date = headers.find(h => h.name === 'Date')?.value || '';

        // Extract sender email
        const emailMatch = from.match(/<(.+?)>/) || [null, from];
        const senderEmail = emailMatch[1]?.trim() || from.trim();

        // Extract plain text body
        let body = '';
        const extractBody = (part) => {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            body += Buffer.from(part.body.data, 'base64').toString('utf-8').slice(0, 1500);
          }
          if (part.parts) part.parts.forEach(extractBody);
        };
        if (msg.payload) extractBody(msg.payload);

        threads.push({ subject, from, senderEmail, date, body: body.slice(0, 1500) });
      } catch (err) {
        console.warn(`  Skipping thread ${thread.id}: ${err.message}`);
      }
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken && threads.length < 200);

  console.log(`Total emails fetched: ${threads.length}`);
  return threads;
}

// ── GROUP BY SENDER ──────────────────────────────────────────────────────────
function groupBySender(emails) {
  const senders = {};
  for (const email of emails) {
    const key = email.senderEmail.toLowerCase();
    if (!senders[key]) {
      senders[key] = {
        email: email.senderEmail,
        from: email.from,
        emails: []
      };
    }
    senders[key].emails.push(email);
  }
  // Sort by frequency descending
  return Object.values(senders)
    .sort((a, b) => b.emails.length - a.emails.length)
    .slice(0, 20); // top 20 senders
}

// ── ANALYSE WITH CLAUDE ──────────────────────────────────────────────────────
async function analyseWithClaude(senderGroups, reportPeriod) {
  if (isDryRun) {
    console.log('[DRY RUN] Skipping Claude API call');
    return getMockAnalysis(senderGroups);
  }

  const client = new Anthropic();

  // Build a summary of each sender's emails for Claude to analyse
  const senderSummaries = senderGroups.map(s => ({
    sender: s.from,
    email: s.email,
    count: s.emails.length,
    subjects: s.emails.map(e => e.subject).slice(0, 8),
    bodySamples: s.emails.slice(0, 3).map(e => e.body.slice(0, 500))
  }));

  const prompt = `You are a travel industry email marketing analyst. Analyse these ${senderGroups.length} competitor email senders from the past 30 days and return a JSON object.

Report period: ${reportPeriod}

Sender data:
${JSON.stringify(senderSummaries, null, 2)}

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "summary": {
    "totalSenders": <number>,
    "totalEmails": <number>,
    "topDiscountSeen": "<e.g. 70%>",
    "mostActiveSender": "<brand name>"
  },
  "senders": [
    {
      "name": "<clean brand name>",
      "email": "<sender email>",
      "emailCount": <number>,
      "volume": "<High|Medium|Low>",
      "recentSubjects": ["<subject 1>", "<subject 2>", "<subject 3>"],
      "messagingStrategy": "<2-3 sentence analysis of their messaging approach, tone, and tactics>",
      "destinationsAndPricing": "<2-3 sentence summary of key destinations promoted and any pricing signals found>",
      "tags": {
        "messaging": ["<tag1>", "<tag2>"],
        "destinations": ["<dest1>", "<dest2>", "<dest3>"],
        "discount": "<e.g. Up to 20% off or null if no discount found>"
      }
    }
  ],
  "insights": [
    {
      "title": "<insight title>",
      "body": "<2-3 sentence insight with specific examples from the data>"
    }
  ]
}

Rules:
- Include all ${senderGroups.length} senders
- Volume: High = 8+ emails/month, Medium = 3-7, Low = 1-2
- insights array should have exactly 5-6 items covering: discount landscape, hot destinations, market trends, frequency patterns, content strategy, any other notable patterns
- Be specific — mention actual brand names, prices, and destinations from the data
- messagingStrategy and destinationsAndPricing must be based on the actual email content provided`;

  console.log('Sending to Claude for analysis...');

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = message.content[0].text.trim();

  try {
    return JSON.parse(raw);
  } catch (e) {
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/^```json\n?|\n?```$/g, '').trim();
    return JSON.parse(cleaned);
  }
}

// ── MOCK ANALYSIS (for dry runs) ─────────────────────────────────────────────
function getMockAnalysis(senderGroups) {
  return {
    summary: {
      totalSenders: senderGroups.length,
      totalEmails: senderGroups.reduce((n, s) => n + s.emails.length, 0),
      topDiscountSeen: '70%',
      mostActiveSender: senderGroups[0]?.from || 'Unknown'
    },
    senders: senderGroups.slice(0, 5).map(s => ({
      name: s.from.split('<')[0].trim() || s.email,
      email: s.email,
      emailCount: s.emails.length,
      volume: s.emails.length >= 8 ? 'High' : s.emails.length >= 3 ? 'Medium' : 'Low',
      recentSubjects: s.emails.slice(0, 3).map(e => e.subject),
      messagingStrategy: '[Dry run — no Claude analysis performed]',
      destinationsAndPricing: '[Dry run — no Claude analysis performed]',
      tags: { messaging: ['Test'], destinations: ['Test'], discount: null }
    })),
    insights: [
      { title: 'Dry run mode', body: 'This is a test run. No Claude API call was made.' }
    ]
  };
}

// ── BUILD HTML ───────────────────────────────────────────────────────────────
function buildHtml(analysis, reportPeriod, generatedAt) {
  const { summary, senders, insights } = analysis;
  const maxEmails = Math.max(...senders.map(s => s.emailCount), 1);

  const volClass = v => v === 'High' ? 'vol-high' : v === 'Medium' ? 'vol-mid' : 'vol-low';
  const barPct = count => Math.round((count / maxEmails) * 100);

  const freqRows = senders.map(s => `
    <tr>
      <td class="brand-cell">${esc(s.name)}</td>
      <td class="domain-cell">${esc(s.email)}</td>
      <td class="count-cell">${s.emailCount}</td>
      <td><span class="vol-badge ${volClass(s.volume)}">${s.volume}</span></td>
      <td class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${barPct(s.emailCount)}%"></div></div></td>
    </tr>`).join('');

  const senderCards = senders.map(s => {
    const subjects = (s.recentSubjects || []).slice(0, 3).map(esc).join(' &middot; ');
    const msgTags = (s.tags?.messaging || []).map(t => `<span class="tag tag-tone">${esc(t)}</span>`).join('');
    const destTags = (s.tags?.destinations || []).map(t => `<span class="tag tag-dest">${esc(t)}</span>`).join('');
    const discTag = s.tags?.discount ? `<span class="tag tag-disc">${esc(s.tags.discount)}</span>` : '';

    return `
    <div class="sender-card">
      <div class="sender-head">
        <div>
          <div class="sender-name">${esc(s.name)}</div>
          <div class="sender-domain">${esc(s.email)}</div>
        </div>
        <div>
          <div class="sender-freq">${s.emailCount}</div>
          <div class="sender-freq-label">emails / 30 days</div>
        </div>
      </div>
      <div class="sender-subjects"><strong>Subject lines</strong> ${subjects || '(none recorded)'}</div>
      <div class="sender-body">
        <div class="sender-col">
          <div class="sender-col-label">Messaging strategy</div>
          <p>${esc(s.messagingStrategy)}</p>
          <div class="tag-row">${msgTags}${discTag}</div>
        </div>
        <div class="sender-col">
          <div class="sender-col-label">Destinations &amp; pricing</div>
          <p>${esc(s.destinationsAndPricing)}</p>
          <div class="tag-row">${destTags}</div>
        </div>
      </div>
    </div>`;
  }).join('');

  const insightCards = insights.map((ins, i) => `
    <div class="insight-card">
      <div class="insight-num">0${i + 1}</div>
      <div>
        <div class="insight-title">${esc(ins.title)}</div>
        <p class="insight-body">${esc(ins.body)}</p>
      </div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Competitor Email Intelligence &mdash; ${esc(reportPeriod)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--ink:#1a1917;--ink-2:#4a4845;--ink-3:#8a8785;--paper:#faf9f6;--paper-2:#f2f0eb;--paper-3:#e8e4dc;--accent:#c8602a;--accent-2:#e8a87c;--teal:#1d6f6e;--teal-light:#e8f4f3;--blue:#2a5c8a;--blue-light:#e8f0f8;--green:#3a6b3a;--green-light:#e8f2e8;--rule:rgba(26,25,23,0.12)}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'DM Sans',sans-serif;background:var(--paper);color:var(--ink);font-size:16px;line-height:1.7;-webkit-font-smoothing:antialiased}
.masthead{background:var(--ink);color:var(--paper);padding:3rem 0 0;position:relative;overflow:hidden}
.masthead::before{content:'';position:absolute;top:-60px;right:-60px;width:320px;height:320px;border-radius:50%;background:var(--accent);opacity:.08}
.masthead-inner{max-width:920px;margin:0 auto;padding:0 2.5rem}
.kicker{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent-2);margin-bottom:1rem;display:flex;align-items:center;gap:10px}
.kicker::before{content:'';display:inline-block;width:24px;height:1px;background:var(--accent-2)}
h1.report-title{font-family:'DM Serif Display',serif;font-size:clamp(2.4rem,5vw,3.8rem);font-weight:400;line-height:1.1;letter-spacing:-.02em;color:var(--paper);margin-bottom:1.2rem}
h1.report-title em{font-style:italic;color:var(--accent-2)}
.report-meta{font-size:13px;color:rgba(250,249,246,.5);font-weight:300;margin-bottom:2.5rem;display:flex;gap:2rem;flex-wrap:wrap}
.kpi-strip{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid rgba(250,249,246,.12);margin-top:1rem}
.kpi-item{padding:1.5rem;border-right:1px solid rgba(250,249,246,.12)}
.kpi-item:last-child{border-right:none}
.kpi-num{font-family:'DM Serif Display',serif;font-size:2.8rem;color:var(--accent-2);line-height:1;margin-bottom:.3rem}
.kpi-label{font-size:11px;font-weight:300;color:rgba(250,249,246,.5);letter-spacing:.05em;text-transform:uppercase}
.main{max-width:920px;margin:0 auto;padding:0 2.5rem 5rem}
.section-header{display:flex;align-items:baseline;gap:1rem;margin:3.5rem 0 1.5rem;padding-bottom:.75rem;border-bottom:1px solid var(--rule)}
.section-header h2{font-family:'DM Serif Display',serif;font-size:1.7rem;font-weight:400;letter-spacing:-.01em}
.section-num{font-family:'DM Mono',monospace;font-size:11px;color:var(--ink-3);letter-spacing:.1em}
.freq-table{width:100%;border-collapse:collapse;margin:1rem 0}
.freq-table thead tr{border-bottom:2px solid var(--ink)}
.freq-table th{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3);font-weight:400;padding:.6rem .8rem;text-align:left}
.freq-table td{padding:.7rem .8rem;font-size:14px;border-bottom:1px solid var(--rule);vertical-align:middle}
.freq-table tbody tr:hover{background:var(--paper-2)}
.brand-cell{font-weight:500}.domain-cell{font-size:12px;color:var(--ink-3);font-family:'DM Mono',monospace}
.count-cell{font-family:'DM Serif Display',serif;font-size:1.4rem;color:var(--accent)}
.bar-cell{width:160px}.bar-track{background:var(--paper-3);border-radius:2px;height:6px;overflow:hidden}
.bar-fill{height:100%;background:var(--accent);border-radius:2px}
.vol-badge{display:inline-block;font-size:10px;font-family:'DM Mono',monospace;letter-spacing:.08em;padding:2px 8px;border-radius:20px;text-transform:uppercase}
.vol-high{background:var(--green-light);color:var(--green)}.vol-mid{background:var(--blue-light);color:var(--blue)}.vol-low{background:var(--paper-3);color:var(--ink-3)}
.sender-grid{display:flex;flex-direction:column;gap:2px;margin:1rem 0}
.sender-card{background:var(--paper);border:1px solid var(--rule);border-radius:2px;overflow:hidden;transition:box-shadow .2s}
.sender-card:hover{box-shadow:0 4px 24px rgba(26,25,23,.08)}
.sender-head{display:grid;grid-template-columns:1fr auto;align-items:start;padding:1.25rem 1.5rem 1rem;background:var(--paper-2);border-bottom:1px solid var(--rule);gap:1rem}
.sender-name{font-family:'DM Serif Display',serif;font-size:1.25rem;font-weight:400;letter-spacing:-.01em;margin-bottom:2px}
.sender-domain{font-family:'DM Mono',monospace;font-size:11px;color:var(--ink-3)}
.sender-freq{font-family:'DM Serif Display',serif;font-size:1.8rem;color:var(--accent);line-height:1;text-align:right;white-space:nowrap}
.sender-freq-label{font-size:10px;color:var(--ink-3);font-family:'DM Sans',sans-serif;font-weight:300;text-align:right}
.sender-subjects{padding:.75rem 1.5rem;background:var(--ink);font-size:12px;color:rgba(250,249,246,.6);font-style:italic;line-height:1.5;border-bottom:1px solid var(--rule)}
.sender-subjects strong{color:rgba(250,249,246,.4);font-style:normal;font-size:10px;letter-spacing:.1em;text-transform:uppercase;font-family:'DM Mono',monospace;font-weight:400;margin-right:6px}
.sender-body{display:grid;grid-template-columns:1fr 1fr}
.sender-col{padding:1.25rem 1.5rem}.sender-col:first-child{border-right:1px solid var(--rule)}
.sender-col-label{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--teal);margin-bottom:.5rem;font-weight:500}
.sender-col p{font-size:13.5px;color:var(--ink-2);line-height:1.65}
.tag-row{display:flex;flex-wrap:wrap;gap:5px;margin-top:.75rem}
.tag{font-size:10px;font-family:'DM Mono',monospace;padding:2px 8px;border-radius:20px;letter-spacing:.05em;border:1px solid}
.tag-disc{background:var(--green-light);color:var(--green);border-color:rgba(58,107,58,.2)}
.tag-dest{background:var(--teal-light);color:var(--teal);border-color:rgba(29,111,110,.2)}
.tag-tone{background:#fdf2ec;color:var(--accent);border-color:rgba(200,96,42,.2)}
.tag-seg{background:var(--blue-light);color:var(--blue);border-color:rgba(42,92,138,.2)}
.insights-grid{display:flex;flex-direction:column;gap:1rem;margin:1rem 0}
.insight-card{display:grid;grid-template-columns:48px 1fr;gap:1.25rem;padding:1.5rem;border:1px solid var(--rule);border-radius:2px;background:var(--paper);align-items:start}
.insight-num{font-family:'DM Serif Display',serif;font-size:2.5rem;color:var(--paper-3);line-height:1;user-select:none}
.insight-title{font-family:'DM Serif Display',serif;font-size:1.1rem;font-weight:400;margin-bottom:.4rem;color:var(--ink)}
.insight-body{font-size:14px;color:var(--ink-2);line-height:1.7}
.insight-body strong{color:var(--ink);font-weight:500}
footer{background:var(--ink);color:rgba(250,249,246,.4);padding:2rem 2.5rem;font-size:12px;font-family:'DM Mono',monospace;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;letter-spacing:.05em}
@media(max-width:640px){.kpi-strip{grid-template-columns:repeat(2,1fr)}.kpi-item{border-right:none;border-bottom:1px solid rgba(250,249,246,.12)}.sender-body{grid-template-columns:1fr}.sender-col:first-child{border-right:none;border-bottom:1px solid var(--rule)}.main{padding:0 1.25rem 3rem}.masthead-inner{padding:0 1.25rem}.bar-cell{display:none}footer{flex-direction:column;align-items:flex-start}}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
.sender-card{animation:fadeUp .4s ease both}
</style>
</head>
<body>
<header class="masthead">
  <div class="masthead-inner">
    <p class="kicker">Competitor intelligence</p>
    <h1 class="report-title">Travel Email<br><em>Marketing Monitor</em></h1>
    <div class="report-meta">
      <span>&#128197; ${esc(reportPeriod)}</span>
      <span>&#128202; 30-day analysis window</span>
      <span>&#128235; ${summary.totalSenders} senders &middot; ${summary.totalEmails} emails</span>
    </div>
  </div>
  <div class="kpi-strip">
    <div class="kpi-item"><div class="kpi-num">${summary.totalSenders}</div><div class="kpi-label">Senders tracked</div></div>
    <div class="kpi-item"><div class="kpi-num">${summary.totalEmails}</div><div class="kpi-label">Emails analysed</div></div>
    <div class="kpi-item"><div class="kpi-num">${summary.topDiscountSeen || '—'}</div><div class="kpi-label">Max discount seen</div></div>
    <div class="kpi-item"><div class="kpi-num" style="font-size:1.4rem;padding-top:.4rem">${esc(summary.mostActiveSender || '—')}</div><div class="kpi-label">Most active sender</div></div>
  </div>
</header>

<main class="main">
  <div class="section-header"><span class="section-num">01</span><h2>Send frequency</h2></div>
  <table class="freq-table">
    <thead><tr><th>Brand</th><th>Domain</th><th>Emails</th><th>Volume</th><th>Frequency bar</th></tr></thead>
    <tbody>${freqRows}</tbody>
  </table>

  <div class="section-header"><span class="section-num">02</span><h2>Sender profiles</h2></div>
  <div class="sender-grid">${senderCards}</div>

  <div class="section-header"><span class="section-num">03</span><h2>Strategic insights</h2></div>
  <div class="insights-grid">${insightCards}</div>
</main>

<footer>
  <span>Competitor Email Intelligence &mdash; ${esc(reportPeriod)}</span>
  <span>Auto-generated ${esc(generatedAt)} &middot; ${summary.totalSenders} senders &middot; ${summary.totalEmails} emails</span>
</footer>
</body>
</html>`;
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getReportPeriod() {
  const now = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const fmt = d => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  return `${fmt(from)} – ${fmt(now)}`;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Competitor Email Report Generator ===');
  console.log(isDryRun ? 'Mode: DRY RUN' : 'Mode: LIVE');

  const reportPeriod = getReportPeriod();
  const generatedAt = new Date().toLocaleDateString('en-AU', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  let emails = [];

  if (!isDryRun) {
    const gmail = await getGmailClient();
    emails = await fetchPromotionalEmails(gmail);
  } else {
    console.log('[DRY RUN] Skipping Gmail fetch');
    emails = [];
  }

  const senderGroups = isDryRun
    ? [{ from: 'Test Sender <test@example.com>', email: 'test@example.com', emails: [{ subject: 'Test email' }] }]
    : groupBySender(emails);

  console.log(`Grouped into ${senderGroups.length} senders`);

  const analysis = await analyseWithClaude(senderGroups, reportPeriod);

  const html = buildHtml(analysis, reportPeriod, generatedAt);

  const outPath = path.join(__dirname, 'index.html');
  fs.writeFileSync(outPath, html, 'utf-8');
  console.log(`Report written to ${outPath}`);
  console.log(`Senders: ${analysis.summary.totalSenders} | Emails: ${analysis.summary.totalEmails}`);
  console.log('Done!');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
