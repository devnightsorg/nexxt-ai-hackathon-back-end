// Plain demo screen for the jury: agents, mandates, live audit log. No frontend framework.
export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Trust Gateway - Admin</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#667085; --line:#e3e6eb; --ok:#127a3e; --okbg:#e6f6ec; --bad:#b42318; --badbg:#fdecea; --info:#1d4ed8; --infobg:#e8effd; --accent:#fee600; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:var(--bg); color:var(--text); }
  header { background:#1d2330; color:#fff; padding:14px 20px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  header h1 { font-size:18px; margin:0; }
  header .tag { background:var(--accent); color:#1d2330; font-weight:700; padding:2px 8px; border-radius:4px; font-size:12px; }
  header input { padding:6px 8px; border-radius:4px; border:0; min-width:220px; }
  main { padding:16px 20px; display:grid; gap:16px; max-width:1400px; margin:0 auto; }
  section { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 16px; overflow-x:auto; }
  h2 { font-size:16px; margin:4px 0 10px; }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; white-space:nowrap; }
  button { cursor:pointer; padding:5px 10px; border-radius:4px; border:1px solid #c4c9d2; background:#fff; font:inherit; font-size:13px; }
  button.danger { border-color:var(--bad); color:var(--bad); }
  button.danger:hover { background:var(--badbg); }
  .pill { display:inline-block; padding:1px 8px; border-radius:10px; font-size:12px; font-weight:600; }
  .allow, .active { background:var(--okbg); color:var(--ok); }
  .deny, .revoked, .expired { background:var(--badbg); color:var(--bad); }
  .info, .pending, .superseded { background:var(--infobg); color:var(--info); }
  .muted { color:var(--muted); }
  #status { font-size:13px; }
  .human_only { background:#f2e8fd; color:#6b21a8; }
  .agent_only { background:#fff4cc; color:#7a5a00; }
  .both { background:var(--okbg); color:var(--ok); }
  .unclassified { background:#eceef2; color:var(--muted); }
  .sim-banner { display:inline-block; background:var(--badbg); color:var(--bad); font-weight:700; font-size:12px; padding:2px 8px; border-radius:4px; margin-left:8px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:10px; }
  .tile { border:1px solid var(--line); border-radius:6px; padding:8px 10px; }
  .tile .v { font-size:22px; font-weight:700; }
  .tile .l { color:var(--muted); font-size:13px; }
  tr.flash td { animation: flash 1.5s ease-out; }
  @keyframes flash { from { background:#fff6b3; } to { background:transparent; } }
</style>
</head>
<body>
<header>
  <h1>Agent Trust Gateway</h1><span class="tag">DEMO - SIMULATED DATA</span>
  <label>Admin token <input id="token" type="password" placeholder="ADMIN_TOKEN from .env"></label>
  <span id="status" class="muted"></span>
</header>
<main>
  <section><h2>Agent Channel <span class="sim-banner">SIMULATED DATA - NOT REAL DEPOSITS / NOT BANK KPIs</span></h2>
    <div class="tiles" id="channel"></div>
    <p class="muted" id="denied-codes"></p>
    <p class="muted">Counts since the last <code>npm run seed</code>. Only successful mock executions count - simulations, idempotent replays and denied attempts are excluded.</p>
  </section>
  <section><h2>Bank catalog by distribution channel <span class="muted">[MOCK]</span> <button id="reload-catalog">Reload catalog</button></h2>
    <p class="muted">The bank decides where each product is sold. External AI agents (MCP) only see and can use <b>agent_only</b> and <b>both</b>. <b>human_only</b> and unclassified products are blocked by server code.</p>
    <table id="catalog"></table>
  </section>
  <section><h2>Agents</h2><table id="agents"></table></section>
  <section><h2>Mandates (customer-approved, bank-signed)</h2><table id="mandates"></table></section>
  <section><h2>Audit log <span class="muted">(latest first, refresh every 2 s)</span></h2><table id="audit"></table></section>
</main>
<script>
const tokenInput = document.getElementById('token');
try { tokenInput.value = sessionStorage.getItem('agw-token') || ''; } catch (e) {}
tokenInput.addEventListener('change', () => { try { sessionStorage.setItem('agw-token', tokenInput.value); } catch (e) {} refresh(); });

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eur = (c) => c == null ? '' : 'EUR ' + (c / 100).toFixed(2);
const pill = (v) => '<span class="pill ' + esc(v) + '">' + esc(v) + '</span>';
const time = (iso) => iso ? new Date(iso).toLocaleTimeString() : '';

async function api(method, path, body) {
  const res = await fetch('/admin/api' + path, {
    method, headers: { 'authorization': 'Bearer ' + tokenInput.value, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

async function act(method, path, body, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try { await api(method, path, body); await refresh(); } catch (e) { alert(e.message); }
}

function renderAgents(agents) {
  document.getElementById('agents').innerHTML = '<tr><th>Agent</th><th>Owner</th><th>Operator</th><th>Status</th><th>Reason</th><th></th></tr>' +
    agents.map((a) => '<tr><td>' + esc(a.agent_id) + '</td><td>' + esc(a.owner_id) + '</td><td>' + esc(a.operator_id) + '</td><td>' + pill(a.status) +
      '</td><td class="muted">' + esc(a.status_reason) + '</td><td>' +
      (a.status === 'pending' ? '<button data-act="approve" data-id="' + esc(a.agent_id) + '">Approve</button> ' : '') +
      (a.status !== 'revoked' ? '<button data-act="mandate" data-id="' + esc(a.agent_id) + '">New mandate (customer approves)</button> ' +
        '<button class="danger" data-act="revoke-agent" data-id="' + esc(a.agent_id) + '">Revoke agent</button>' : '') +
      '</td></tr>').join('');
}

function renderMandates(mandates) {
  const now = Date.now();
  document.getElementById('mandates').innerHTML = '<tr><th>Mandate</th><th>Agent</th><th>Products</th><th>Per action</th><th>Used / aggregate</th><th>Approval above</th><th>Expires</th><th>Status</th><th></th></tr>' +
    mandates.slice().reverse().map((m) => {
      const st = m.status === 'active' && Date.parse(m.expires_at) <= now ? 'expired' : m.status;
      return '<tr><td>' + esc(m.mandate_id) + '</td><td>' + esc(m.agent_id) + '</td><td>' + esc(m.allowed_products.join(', ')) + '</td><td>' + eur(m.per_action_limit_cents) +
        '</td><td>' + eur(m.consumed_cents) + ' / ' + eur(m.aggregate_limit_cents) + '</td><td>' + eur(m.human_approval_above_cents) +
        '</td><td>' + esc(new Date(m.expires_at).toLocaleString()) + '</td><td>' + pill(st) + '</td><td>' +
        (m.status === 'active' ? '<button class="danger" data-act="revoke-mandate" data-id="' + esc(m.mandate_id) + '">Revoke mandate</button>' : '') + '</td></tr>';
    }).join('');
}

let lastTopAudit = null;
function renderAudit(events) {
  const top = events[0] && events[0].audit_id;
  const fresh = new Set();
  if (lastTopAudit) { for (const e of events) { if (e.audit_id === lastTopAudit) break; fresh.add(e.audit_id); } }
  lastTopAudit = top;
  document.getElementById('audit').innerHTML = '<tr><th>Time</th><th>Result</th><th>Event</th><th>Agent / actor</th><th>Mandate</th><th>Product</th><th>Amount</th><th>Code</th><th>Reason</th></tr>' +
    events.map((e) => '<tr' + (fresh.has(e.audit_id) ? ' class="flash"' : '') + '><td>' + time(e.ts) + '</td><td>' + pill(e.result) + '</td><td>' + esc(e.event) +
      '</td><td>' + esc(e.agent_id || e.actor) + '</td><td>' + esc(e.mandate_id) + '</td><td>' + esc(e.product_id) + '</td><td>' + eur(e.amount_cents) +
      '</td><td><b>' + esc(e.error_code) + '</b></td><td class="muted">' + esc(e.reason) + '</td></tr>').join('');
}

const CHANNEL_ORDER = ['human_only', 'agent_only', 'both', 'unclassified'];
let catalog = null;

async function loadCatalog() {
  if (!tokenInput.value) return;
  try {
    const res = await api('GET', '/offers');
    catalog = res.offers;
    const rows = catalog.slice().sort((a, b) => CHANNEL_ORDER.indexOf(a.distribution_channel) - CHANNEL_ORDER.indexOf(b.distribution_channel));
    document.getElementById('catalog').innerHTML = '<tr><th>Channel</th><th>Visible to AI agents</th><th>Product ID</th><th>Title</th><th>Type</th><th>Rate p.a.</th><th>Term</th><th>Minimum</th></tr>' +
      rows.map((o) => {
        const agent = o.distribution_channel === 'agent_only' || o.distribution_channel === 'both';
        return '<tr><td>' + pill(o.distribution_channel) + '</td><td>' + (agent ? 'yes' : '<b>no</b>') + '</td><td>' + esc(o.product_id) + '</td><td>' + esc(o.title) +
          '</td><td>' + esc(o.product_type) + '</td><td>' + (o.rate_bps / 100).toFixed(2) + '%</td><td>' + (o.term_months ? esc(o.term_months) + ' months' : 'flexible') +
          '</td><td>' + eur(o.min_amount_cents) + '</td></tr>';
      }).join('') + '<tr><td colspan="8" class="muted">Source: ' + esc(res.source) + '</td></tr>';
  } catch (e) { document.getElementById('catalog').innerHTML = '<tr><td class="muted">Catalog error: ' + esc(e.message) + '</td></tr>'; }
}
document.getElementById('reload-catalog').addEventListener('click', loadCatalog);

function renderChannel(stats) {
  const count = (ch) => catalog ? catalog.filter((o) => o.distribution_channel === ch).length : '-';
  const tiles = [
    ['Agent-only offers', count('agent_only')],
    ['Shared offers (both)', count('both')],
    ['Human-only offers', count('human_only')],
    ['Unique agents with successful mock executions', stats.unique_agents_with_executions],
    ['Simulated deposits executed', stats.simulated_deposits_executed],
    ['Simulated deposit volume', eur(stats.simulated_deposit_volume_cents)],
    ['Denied agent actions', stats.denied_agent_actions],
  ];
  document.getElementById('channel').innerHTML = tiles.map((t) => '<div class="tile"><div class="v">' + esc(t[1]) + '</div><div class="l">' + esc(t[0]) + '</div></div>').join('');
  const codes = Object.entries(stats.denied_by_error_code).sort((a, b) => b[1] - a[1]);
  document.getElementById('denied-codes').textContent = codes.length ? 'Denied by code: ' + codes.map((c) => c[0] + ' ' + c[1]).join(', ') : '';
}

async function refresh() {
  const status = document.getElementById('status');
  if (!tokenInput.value) { status.textContent = 'Enter the admin token to load data.'; return; }
  if (!catalog) await loadCatalog();
  try {
    const [agents, mandates, audit, stats] = await Promise.all([api('GET', '/agents'), api('GET', '/mandates'), api('GET', '/audit?limit=60'), api('GET', '/channel-stats')]);
    renderChannel(stats); renderAgents(agents); renderMandates(mandates); renderAudit(audit);
    status.textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) { status.textContent = 'Error: ' + e.message; }
}

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.act === 'approve') act('POST', '/agents/' + id + '/approve');
  if (b.dataset.act === 'revoke-agent') act('POST', '/agents/' + id + '/revoke', { reason: 'customer revoked agent in admin page' }, 'Revoke agent ' + id + '?');
  if (b.dataset.act === 'revoke-mandate') act('POST', '/mandates/' + id + '/revoke', { reason: 'customer revoked mandate in admin page' }, 'Revoke mandate ' + id + '?');
  if (b.dataset.act === 'mandate') act('POST', '/mandates', { agent_id: id, customer_approval: true }, 'Simulate customer approval of a new default mandate for ' + id + '?');
});

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
