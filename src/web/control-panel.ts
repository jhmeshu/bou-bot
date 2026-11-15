/**
 * Minimal control panel (PRD §7.9): pause, take over, review alerts, resume.
 * Single static HTML + fetch calls to the admin API. Auth via ADMIN_TOKEN
 * (stored in localStorage after first entry — nothing sensitive renders
 * without it).
 */
export function controlPanelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>bou-bot control panel</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 720px; padding: 16px; }
  h1 { font-size: 1.2rem; }
  .card { border: 1px solid #8884; border-radius: 10px; padding: 12px; margin: 12px 0; }
  button { padding: 8px 14px; margin: 4px 4px 4px 0; border-radius: 8px; border: 1px solid #8886; cursor: pointer; }
  button.warn { border-color: #c44; color: #c44; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; }
  .muted { opacity: 0.65; font-size: 0.85rem; }
  input { padding: 8px; border-radius: 8px; border: 1px solid #8886; width: 260px; }
  .alert { border-left: 4px solid #c44; padding-left: 10px; margin: 8px 0; }
  .alert.normal { border-left-color: #d80; }
</style>
</head>
<body>
<h1>🤖 bou-bot control panel</h1>
<div id="auth">
  <label>Admin token: <input id="token" type="password"/></label>
  <button onclick="enter()">Enter</button>
</div>
<div id="app" style="display:none">
  <div class="card"><b>Status</b><pre id="status">loading…</pre>
    <button onclick="cmd('pause')">⏸ Pause</button>
    <button onclick="cmd('takeover')">🙋 Take over</button>
    <button onclick="cmd('resume')">▶️ Resume</button>
    <button class="warn" onclick="cmd('reinvite')">✉️ Re-invite (after STOP)</button>
  </div>
  <div class="card"><b>Unresolved alerts</b><div id="alerts">loading…</div></div>
  <div class="card"><b>Recent audit</b><pre id="audit" class="muted">loading…</pre></div>
</div>
<script>
let T = localStorage.getItem('adminToken') || '';
const H = () => ({ 'x-admin-token': T, 'content-type': 'application/json' });
function enter() { T = document.getElementById('token').value.trim(); localStorage.setItem('adminToken', T); refresh(); }
async function refresh() {
  if (!T) return;
  try {
    const [s, a, au] = await Promise.all([
      fetch('/admin/api/status', { headers: H() }),
      fetch('/admin/api/alerts', { headers: H() }),
      fetch('/admin/api/audit', { headers: H() }),
    ]);
    if (s.status === 401) { document.getElementById('app').style.display = 'none'; return; }
    document.getElementById('auth').style.display = 'none';
    document.getElementById('app').style.display = '';
    document.getElementById('status').textContent = JSON.stringify(await s.json(), null, 1);
    const alerts = (await a.json()).alerts;
    document.getElementById('alerts').innerHTML = alerts.length === 0 ? '<span class="muted">none ✅</span>' :
      alerts.map(x => '<div class="alert ' + x.severity + '"><b>' + x.severity + ' — ' + x.reason + '</b><br/>' +
        x.created_at + '<br/><i>' + x.trigger_message + '</i><br/>' +
        '<button onclick="resolve(' + x.id + ')">mark seen</button></div>').join('');
    document.getElementById('audit').textContent = (await au.json()).audit
      .map(x => x.created_at + ' [' + x.actor + '] ' + x.event + ' ' + x.detail).join('\\n');
  } catch (e) { /* server unreachable */ }
}
async function cmd(c) {
  await fetch('/admin/api/command', { method: 'POST', headers: H(), body: JSON.stringify({ cmd: c }) });
  refresh();
}
async function resolve(id) {
  await fetch('/admin/api/alerts/' + id + '/resolve', { method: 'POST', headers: H() });
  refresh();
}
if (T) refresh();
</script>
</body>
</html>`;
}
