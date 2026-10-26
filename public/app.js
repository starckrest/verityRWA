const $ = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => [...root.querySelectorAll(q)];
const roleMeta = {
  issuer: ['Asset issuer', 'Issuer Consortium', 'IS'], verifier: ['Independent verifier', 'Registry Authority', 'VR'],
  appraiser: ['Valuation partner', 'Valuation Network', 'VP'], compliance: ['Compliance officer', 'Compliance Org', 'CO'],
  investor: ['Investor', 'Investor Consortium', 'IN'], auditor: ['Auditor', 'Audit Office', 'AU']
};
const lifecycle = ['REGISTERED', 'VERIFIED', 'VALUED', 'APPROVED', 'TOKENIZED', 'TRANSFER', 'REDEEMED'];
let state;
let currentView = 'assets';
let selectedAssetId = null;
let filterAudit = 'all';
let toastTimer;

async function api(action, data = {}) {
  const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Action failed');
  state = result.state || result;
  return result;
}
async function refresh() { const r = await fetch('/api/state', { cache: 'no-store' }); state = await r.json(); render(); }
const fmt = (value) => Number(value || 0).toLocaleString('en-IN');
const shortDate = (date) => { if (!date) return '—'; const d = new Date(date); return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
const safe = (value = '') => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusClass = (s) => String(s || '').toLowerCase();
const statusPill = (s) => `<span class="status-pill ${statusClass(s)}">${safe(s)}</span>`;
const displayIdentity = value => {
  const raw = String(value || '');
  let decoded = raw;
  if (!raw.includes('CN=') && /^[A-Za-z0-9+/]+=*$/.test(raw)) {
    try { decoded = atob(raw); } catch { /* Keep the original identifier if it is not base64. */ }
  }
  const match = decoded.match(/CN=([^,/]+)/);
  return match ? match[1] : raw || '—';
};
function assetIcon(type) { return ({ land: '⌂', vehicle: '▱', invoice: '▤', commodity: '◈' })[type] || '◈'; }
function assetValue(a) { return a.valuation?.amount || a.attributes.faceValue || '—'; }
function ownedUnits(a, role = state.activeRole) {
  if (!a.token) return 0;
  const identity = state.identities?.[role];
  if (identity) return a.holders?.[`${identity.msp}|${identity.id}`] || 0;
  if (role === 'investor') return Object.entries(a.holders || {}).filter(([k]) => k.endsWith('|investor.demo.co')).reduce((n, [, v]) => n + v, 0);
  return Object.entries(a.holders || {}).filter(([k]) => k.startsWith('IssuerMSP|')).reduce((n, [, v]) => n + v, 0);
}
function render() {
  const meta = roleMeta[state.activeRole] || roleMeta.issuer;
  $('#identity-name').textContent = meta[0]; $('#identity-org').textContent = state.identities?.[state.activeRole]?.msp || meta[1]; $('#role-avatar').textContent = meta[2]; $('#role-select').value = state.activeRole;
  $('#nav-count').textContent = String(state.assets.length).padStart(2, '0');
  $('#sync-time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fabric = state.mode === 'FABRIC';
  $('#reset-btn').classList.toggle('hidden', fabric);
  $('.demo-banner b').textContent = fabric ? 'Fabric consortium network' : 'Interview demo environment';
  $('.demo-banner > div > span').textContent = fabric ? 'Actions use role-scoped local test certificates and are committed to rwa-consortium. Role switching is demo routing, not user authentication.' : 'Transactions are recorded in the local demo ledger. Connect a Fabric network to use consortium identities and endorsement.';
  $('.network-chip b').textContent = fabric ? 'FABRIC' : 'DEMO';
  $('.sidebar-bottom small').textContent = fabric ? 'Permissioned ledger · Connected' : 'Permissioned ledger · Demo';
  $('.page-footer span:last-child').innerHTML = fabric ? 'FABRIC CHANNEL <i>·</i> RWA-CONSORTIUM' : 'DEMO NETWORK <i>·</i> LOCAL LEDGER MODE';
  renderMetrics(); renderMain(); renderRail();
}
function renderMetrics() {
  const total = state.assets.length, active = state.assets.filter(a => a.status === 'TOKENIZED').length;
  const pending = state.assets.filter(a => ['REGISTERED', 'VERIFIED', 'VALUED'].includes(a.status)).length;
  const amount = state.assets.reduce((sum, a) => sum + Number((a.valuation?.amount || a.attributes.faceValue || '').replace(/[^0-9.]/g, '')), 0);
  const isInvestor = state.activeRole === 'investor';
  const items = [
    ['ASSETS UNDER GOVERNANCE', total, `Across ${new Set(state.assets.map(a => a.assetType)).size} asset classes`, '▦'],
    [isInvestor ? 'YOUR TOKEN HOLDINGS' : 'TOKENIZED ASSETS', isInvestor ? state.assets.reduce((n, a) => n + ownedUnits(a), 0) : active, isInvestor ? 'Units held in this demo identity' : `${state.assets.filter(a => a.token).length} linked token series`, '◈'],
    ['IN REVIEW', pending, 'Verification or valuation due', '◷'],
    ['RECORDED VALUE', `₹ ${fmt(amount)}`, 'Latest recorded valuations', '↗']
  ];
  $('#metrics').innerHTML = items.map(([label, value, foot, icon]) => `<div class="metric"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon}</span></div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></div>`).join('');
}
function renderMain() {
  const title = currentView === 'assets' ? 'Asset registry' : currentView === 'transfers' ? 'Transfer desk' : 'Audit explorer';
  $('#breadcrumb').textContent = title; $('#page-title').innerHTML = `${title}<span class="heading-period">.</span>`;
  $('#page-subtitle').textContent = currentView === 'assets' ? 'A trusted path from physical evidence to governed digital ownership.' : currentView === 'transfers' ? 'Review pending ownership movements and their compliance status.' : 'Inspect who changed each asset, when, and why.';
  $('#register-btn').classList.toggle('hidden', currentView !== 'assets' || !['issuer'].includes(state.activeRole));
  $$('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.view === currentView));
  if (currentView === 'assets') renderAssets(); else if (currentView === 'transfers') renderTransfers(); else renderAuditView();
}
function renderAssets() {
  $('#table-title').textContent = state.activeRole === 'investor' ? 'Available assets & holdings' : 'Your asset portfolio';
  $('#table-note').textContent = 'Every asset, one governed lifecycle';
  $('#table-head').innerHTML = '<tr><th>ASSET / REFERENCE</th><th>CLASS</th><th>STATE</th><th>VALUATION</th><th>TOKEN SERIES</th><th>OWNER / HOLDING</th><th></th></tr>';
  const query = $('#search').value.toLowerCase(), filter = $('#filter-status').value;
  const assets = state.assets.filter(a => `${a.name} ${a.id} ${a.subtitle} ${a.assetType}`.toLowerCase().includes(query) && (filter === 'all' || a.status === filter));
  $('#result-count').textContent = `Showing ${assets.length} of ${state.assets.length} assets`;
  $('#table-body').innerHTML = assets.length ? assets.map(a => {
    const owner = state.activeRole === 'investor' && ownedUnits(a) ? `${fmt(ownedUnits(a))} ${a.token.unitName}` : displayIdentity(a.owner.id);
    return `<tr data-asset="${safe(a.id)}"><td><div class="asset-cell"><div class="asset-type-icon ${safe(a.assetType)}">${assetIcon(a.assetType)}</div><div><div class="asset-name">${safe(a.name)}</div><div class="asset-id">${safe(a.id)}</div></div></div></td><td><span class="type-pill">${safe(a.assetType)}</span></td><td>${statusPill(a.status)}</td><td class="value-cell">${safe(assetValue(a))}</td><td class="token-cell ${a.token ? '' : 'muted'}">${a.token ? safe(a.token.id) : 'Not issued'}</td><td class="owner-cell">${safe(owner)}</td><td class="row-arrow">›</td></tr>`;
  }).join('') : '<tr><td colspan="7"><div class="empty-state"><b>No matching assets</b>Try another search or state.</div></td></tr>';
  $$('#table-body tr[data-asset]').forEach(row => row.addEventListener('click', () => openAsset(row.dataset.asset)));
}
function renderTransfers() {
  $('#table-title').textContent = 'Transfer requests'; $('#table-note').textContent = 'Two-party acceptance with eligibility checks';
  $('#table-head').innerHTML = '<tr><th>REQUEST</th><th>ASSET</th><th>FROM → TO</th><th>UNITS</th><th>STATUS</th><th>ACTION</th></tr>';
  const body = state.transfers.map(t => {
    const a = state.assets.find(x => x.id === t.assetId); const investor = state.identities?.investor;
    const canAccept = t.status === 'PENDING' && state.activeRole === 'investor' && (investor ? t.to.id === investor.id : t.to.id === 'investor.demo.co');
    const canReject = t.status === 'PENDING' && state.activeRole === 'compliance';
    return `<tr data-asset="${safe(t.assetId)}"><td><div class="asset-name">${safe(t.id)}</div><div class="asset-id">${shortDate(t.createdAt)}</div></td><td>${safe(a?.name || t.assetId)}</td><td class="owner-cell">${safe(displayIdentity(t.from.id))} → ${safe(displayIdentity(t.to.id))}</td><td>${fmt(t.units)} ${safe(a?.token?.unitName || 'units')}</td><td>${statusPill(t.status)}</td><td>${canAccept ? `<button class="action-button transfer-accept" data-id="${safe(t.id)}">Accept</button>` : canReject ? `<button class="action-button transfer-reject" data-id="${safe(t.id)}">Deny</button>` : '—'}</td></tr>`;
  }).join('');
  $('#table-body').innerHTML = body || '<tr><td colspan="6"><div class="empty-state"><b>No transfers yet</b>Start a transfer from a tokenized asset to see the approval flow here.</div></td></tr>';
  $('#result-count').textContent = `${state.transfers.length} transfer requests`;
  $$('.transfer-accept').forEach(b => b.addEventListener('click', async e => { e.stopPropagation(); await runAction('acceptTransfer', { transferId: b.dataset.id, assetId: state.transfers.find(t => t.id === b.dataset.id).assetId }, 'Transfer accepted and ownership updated'); }));
  $$('.transfer-reject').forEach(b => b.addEventListener('click', async e => { e.stopPropagation(); const reason = prompt('Why is this transfer being denied?'); if (reason) await runAction('rejectTransfer', { transferId: b.dataset.id, assetId: state.transfers.find(t => t.id === b.dataset.id).assetId, reason }, 'Denial recorded in the audit trail'); }));
}
function renderAuditView() {
  $('#table-title').textContent = 'Consortium audit log'; $('#table-note').textContent = 'Append-only demo events · each entry includes an actor, role and reason';
  $('#table-head').innerHTML = '<tr><th>EVENT</th><th>ASSET</th><th>ACTOR</th><th>STATE CHANGE</th><th>TIME</th></tr>';
  const rows = state.audit.filter(e => filterAudit === 'all' || e.action === filterAudit).map(e => {
    const a = state.assets.find(x => x.id === e.assetId); return `<tr data-asset="${safe(e.assetId)}"><td><b>${safe(e.action.replaceAll('_', ' '))}</b><div class="asset-id">${safe(e.txId)}</div></td><td>${safe(a?.name || e.assetId)}</td><td class="owner-cell">${safe(e.actor)}<div class="asset-id">${safe(e.role)}</div></td><td>${safe(e.from || '—')} → ${safe(e.to)}</td><td>${shortDate(e.at)}</td></tr>`;
  }).join('');
  $('#table-body').innerHTML = rows || '<tr><td colspan="5"><div class="empty-state"><b>No events</b>There are no matching ledger events.</div></td></tr>';
  $('#result-count').textContent = `${state.audit.length} committed demo events`;
  $$('#table-body tr[data-asset]').forEach(row => row.addEventListener('click', () => openAsset(row.dataset.asset)));
}
function renderRail() {
  const focus = state.assets.find(a => a.id === selectedAssetId) || state.assets.find(a => a.status === 'TOKENIZED') || state.assets[0];
  const current = lifecycle.indexOf(focus?.status); const idx = current >= 0 ? current : Math.max(0, lifecycle.indexOf('REGISTERED'));
  $('#lifecycle-flow').innerHTML = lifecycle.map((step, i) => {
    const done = i < idx, active = i === idx;
    return `<div class="life-step ${done ? 'done' : active ? 'current' : ''}"><span class="life-bullet">${done ? '✓' : i + 1}</span><div class="life-copy"><b>${step === 'TRANSFER' ? 'Transfer' : step.charAt(0) + step.slice(1).toLowerCase()}</b><small>${done ? 'Complete' : active ? 'Current' : 'Next'}</small></div></div>`;
  }).join('');
  const events = [...state.audit].slice(0, 4);
  $('#activity-list').innerHTML = events.map(e => `<div class="activity-item"><div class="activity-mark ${e.action.includes('REJECT') ? 'reject' : ''}">${e.action.includes('REJECT') ? '!' : '✓'}</div><div class="activity-body"><div class="activity-line"><b>${safe(e.action.replaceAll('_', ' '))}</b> · ${safe(state.assets.find(a => a.id === e.assetId)?.name || e.assetId)}</div><div class="activity-meta">${safe(e.role)} · ${shortDate(e.at)} · ${safe(e.txId)}</div></div></div>`).join('') || '<div class="empty-state">No activity recorded.</div>';
}
function showToast(message, error = false) { const el = $('#toast'); el.textContent = message; el.className = `toast show${error ? ' error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.className = 'toast', 2800); }
async function runAction(action, data, success) { try { const result = await api(action, data); if (result.assetId) selectedAssetId = result.assetId; showToast(result.message && (result.rejected || state.mode === 'FABRIC') ? result.message : success || result.message || 'Transaction recorded', Boolean(result.rejected)); render(); if (selectedAssetId && $('#overlay').classList.contains('open')) openAsset(selectedAssetId); } catch (e) { showToast(e.message, true); } }
function openDrawer(html) { $('#drawer-content').innerHTML = html; $('#overlay').classList.add('open'); }
function closeDrawer() { $('#overlay').classList.remove('open'); }
function openAsset(id) {
  selectedAssetId = id; const a = state.assets.find(x => x.id === id); if (!a) return;
  const events = state.audit.filter(e => e.assetId === id);
  const allowed = [];
  if (state.activeRole === 'verifier' && ['REGISTERED', 'REJECTED'].includes(a.status)) allowed.push(['Verify / reject', 'verify']);
  if (state.activeRole === 'appraiser' && ['VERIFIED', 'VALUED'].includes(a.status)) allowed.push(['Record valuation', 'value']);
  if (state.activeRole === 'compliance' && a.status === 'VALUED') allowed.push(['Approve asset', 'approve']);
  if (state.activeRole === 'issuer' && a.status === 'APPROVED') allowed.push(['Issue token series', 'tokenize']);
  if (['issuer', 'investor'].includes(state.activeRole) && a.status === 'TOKENIZED') allowed.push(['Initiate transfer', 'transfer']);
  if (state.activeRole === 'issuer' && a.status === 'TOKENIZED') allowed.push(['Redeem / retire', 'close']);
  const details = Object.entries(a.attributes).map(([k, v]) => `<div><div class="detail-label">${safe(k.replace(/[A-Z]/g, x => ` ${x}`).replace(/^./, x => x.toUpperCase()))}</div><div class="detail-value">${safe(v)}</div></div>`).join('');
  const token = a.token ? `<div class="drawer-section"><h3>Token representation</h3><div class="detail-grid"><div><div class="detail-label">Series ID</div><div class="detail-value">${safe(a.token.id)}</div></div><div><div class="detail-label">Representation</div><div class="detail-value">${safe(a.token.representation)} · ${fmt(a.token.totalUnits)} ${safe(a.token.unitName)}</div></div><div><div class="detail-label">Token state</div><div class="detail-value">${safe(a.token.status)}</div></div><div><div class="detail-label">Transfer cap</div><div class="detail-value">${a.policy.maxUnits ? fmt(a.policy.maxUnits) + ' units' : 'No cap'}</div></div></div></div>` : '';
  const valuation = a.valuation ? `<div class="drawer-section"><h3>Latest valuation</h3><div class="detail-grid"><div><div class="detail-label">Value</div><div class="detail-value">${safe(a.valuation.amount)} ${safe(a.valuation.currency || '')}</div></div><div><div class="detail-label">Method / date</div><div class="detail-value">${safe(a.valuation.method)} · ${safe(a.valuation.asOf)}</div></div><div><div class="detail-label">Source</div><div class="detail-value">${safe(a.valuation.source)}</div></div></div></div>` : '';
  openDrawer(`<div class="drawer-kicker">ASSET RECORD · VERSION ${a.version}</div><h2 class="drawer-title">${safe(a.name)}</h2><div class="drawer-subtitle">${safe(a.id)} · ${safe(a.subtitle)}</div><div class="drawer-status">${statusPill(a.status)} <span class="type-pill">${safe(a.assetType)}</span></div><div class="drawer-section"><h3>Asset identity</h3><div class="detail-grid"><div><div class="detail-label">Jurisdiction</div><div class="detail-value">${safe(a.jurisdiction)}</div></div><div><div class="detail-label">Registered owner</div><div class="detail-value">${safe(a.owner.id)} · ${safe(a.owner.msp)}</div></div>${details}</div></div><div class="drawer-section"><h3>Supporting evidence</h3>${a.evidence.map(x => `<div class="evidence-row"><span class="evidence-symbol">▤</span><div><b>${safe(x.kind)}</b><small>${safe(x.uri)} · SHA-256 ${safe(x.sha256.slice(0, 16))}…</small></div></div>`).join('')}</div>${valuation}${token}<div class="drawer-section"><h3>Governance history</h3><div class="timeline">${events.map(e => `<div class="timeline-row"><span class="timeline-time">${new Date(e.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span><i class="timeline-dot"></i><div class="timeline-copy"><b>${safe(e.action.replaceAll('_', ' '))} · ${safe(e.role)}</b><p>${safe(e.reason)}<br>${safe(e.txId)}</p></div></div>`).join('') || '<div class="empty-state">No events for this asset.</div>'}</div></div><div class="drawer-actions">${allowed.map(([label, key]) => `<button class="action-button ${key === 'approve' || key === 'tokenize' ? 'strong' : ''}" data-action="${key}">${label}</button>`).join('')}</div>`);
  $$('[data-action]', $('#drawer-content')).forEach(b => b.addEventListener('click', () => showActionForm(a, b.dataset.action)));
}
function formField(label, name, placeholder = '', type = 'text', value = '') { return `<div class="form-field"><label>${label}</label><input name="${name}" type="${type}" placeholder="${placeholder}" value="${safe(value)}" ${name === 'totalUnits' ? 'min="1"' : ''} required></div>`; }
function showActionForm(a, action) {
  const content = $('#drawer-content'), section = document.createElement('section'); section.className = 'drawer-section';
  let title = '', fields = '';
  if (action === 'verify') { title = 'Verification decision'; fields = `<div class="form-field"><label>Decision</label><select name="decision"><option value="APPROVED">Approve</option><option value="REJECTED">Reject</option></select></div><div class="form-field"><label>Verification reason</label><textarea name="reason" placeholder="What did you check? What matched?" required></textarea></div>`; }
  if (action === 'value') { title = 'Record asset valuation'; fields = `${formField('Value', 'amount', 'e.g. 12000000')}${formField('Currency', 'currency', 'INR', 'text', 'INR')}${formField('Valuation method', 'method', 'Comparable sales')}${formField('As-of date', 'asOf', '', 'date')}${formField('Source', 'source', 'Valuation partner')}`; }
  if (action === 'approve') { title = 'Compliance approval'; fields = `<div class="form-field"><label>Approval note</label><textarea name="reason" placeholder="Evidence and policy checks completed" required></textarea></div>`; }
  if (action === 'tokenize') { title = 'Issue linked token series'; fields = `${formField('Token series ID', 'tokenId', `VR-${a.assetType.toUpperCase()}-${a.id.slice(-4)}`, 'text', `VR-${a.assetType.toUpperCase()}-${a.id.slice(-4)}`)}<div class="form-field"><label>Representation</label><select name="representation"><option value="FRACTIONAL">Fractional units</option><option value="WHOLE">Whole asset · one unit</option></select></div>${formField('Total units', 'totalUnits', '1000', 'number', a.assetType === 'vehicle' ? '1' : '1000')}${formField('Unit label', 'unitName', 'units', 'text', 'units')}`; }
  if (action === 'transfer') { const buyer = state.identities?.investor || { msp: 'InvestorMSP', id: 'investor.demo.co' }; fields = `<div class="form-field"><label>Submitting identity</label><input value="${safe(displayIdentity(state.identities?.[state.activeRole]?.id || a.owner.id))}" disabled></div><div class="form-field"><label>Buyer organization (MSP)</label><select name="toMsp"><option value="${safe(buyer.msp)}">${safe(buyer.msp)}</option></select></div>${formField('Buyer identity', 'toId', buyer.id, 'text', buyer.id)}${formField('Units', 'units', '25', 'number', a.token?.representation === 'WHOLE' ? '1' : '')}${a.policy.requireCompliance ? formField('Compliance attestation reference', 'complianceRef', 'CMP-2026-001') : ''}<div class="form-field"><label>Transfer note</label><textarea name="note" placeholder="Purpose or deal reference"></textarea></div>`; title = 'Initiate token transfer'; }
  if (action === 'close') { title = 'Close asset lifecycle'; fields = `<div class="form-field"><label>Outcome</label><select name="status"><option value="REDEEMED">Redeemed</option><option value="RETIRED">Retired</option></select></div><div class="form-field"><label>Reason</label><textarea name="reason" placeholder="Describe the redemption or retirement" required></textarea></div>`; }
  section.innerHTML = `<h3>${title}</h3><form class="form-stack">${fields}<div class="form-actions"><button class="form-submit" type="submit">Submit transaction</button><button class="form-cancel" type="button">Cancel</button></div></form>`;
  content.append(section); section.scrollIntoView({ behavior: 'smooth', block: 'end' });
  $('.form-cancel', section).addEventListener('click', () => section.remove());
  $('form', section).addEventListener('submit', async e => {
    e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget));
    if (action === 'verify') await runAction('verify', { assetId: a.id, ...data }, 'Verification decision recorded');
    if (action === 'value') await runAction('value', { assetId: a.id, ...data }, 'Valuation recorded');
    if (action === 'approve') await runAction('approve', { assetId: a.id, ...data }, 'Asset approved for tokenization');
    if (action === 'tokenize') await runAction('tokenize', { assetId: a.id, ...data }, 'Token series issued and linked to asset');
    if (action === 'transfer') { const [fromMsp, fromId] = data.fromKey.split('|'); await runAction('transfer', { assetId: a.id, ...data, fromMsp, fromId }, 'Transfer request recorded for buyer acceptance'); }
    if (action === 'close') await runAction('close', { assetId: a.id, ...data }, 'Asset lifecycle closed');
  });
}
function registerForm() {
  openDrawer(`<div class="drawer-kicker">NEW CLAIM · EVIDENCE FIRST</div><h2 class="drawer-title">Register an asset</h2><div class="drawer-subtitle">The claim enters review; no token exists yet.</div><section class="drawer-section"><form class="form-stack" id="register-form"><div class="form-field"><label>Asset class</label><select name="assetType"><option value="land">Land / property</option><option value="vehicle">Vehicle / equipment</option><option value="commodity">Commodity / inventory</option><option value="invoice">Invoice / receivable</option><option value="other">Other</option></select></div>${formField('Display name', 'name', 'e.g. North Field Parcel')}${formField('Reference / location', 'subtitle', 'Survey no. · district')}${formField('Jurisdiction', 'jurisdiction', 'IN-MH', 'text', 'IN-MH')}<div class="form-field"><label>Type-specific attributes · JSON</label><textarea name="attributesJSON" required>{
  "surveyNumber": "18/2",
  "area": "2.4 acres",
  "landUse": "Agricultural"
}</textarea></div>${formField('Evidence document name', 'evidenceKind', 'Land title extract', 'text', 'Supporting document')}${formField('Evidence reference', 'evidenceURI', 'evidence/document.pdf', 'text', 'evidence/demo-document.pdf')}<div class="form-actions"><button class="form-submit">Register claim</button><button class="form-cancel" type="button" id="register-cancel">Cancel</button></div></form></section>`);
  $('#register-cancel').addEventListener('click', closeDrawer);
  $('#register-form').addEventListener('submit', async e => { e.preventDefault(); await runAction('register', Object.fromEntries(new FormData(e.currentTarget)), 'Asset registered and queued for verification'); });
}
function showAuditFilters() {
  $('.audit-filter')?.remove();
  const h = $('#table-head'); h.insertAdjacentHTML('beforebegin', `<div class="audit-filter">${['all', 'REGISTER', 'VERIFY', 'VALUE', 'APPROVE', 'TOKENIZE', 'TRANSFER', 'TRANSFER_REJECTED'].map(x => `<button data-audit="${x}" class="${filterAudit === x ? 'active' : ''}">${x.replaceAll('_', ' ')}</button>`).join('')}</div>`);
  $$('[data-audit]').forEach(b => b.addEventListener('click', () => { filterAudit = b.dataset.audit; renderAuditView(); showAuditFilters(); }));
}

$('#role-select').addEventListener('change', async e => { await runAction('setRole', { role: e.target.value }, `Switched to ${roleMeta[e.target.value][0]}`); });
$('.identity-card').addEventListener('click', () => $('#role-select').focus());
$$('[data-view]').forEach(b => b.addEventListener('click', () => { currentView = b.dataset.view; renderMain(); }));
$('#search').addEventListener('input', renderAssets); $('#filter-status').addEventListener('change', renderAssets);
$('#register-btn').addEventListener('click', registerForm);
$('#drawer-close').addEventListener('click', closeDrawer); $('#overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeDrawer(); });
$('#reset-btn').addEventListener('click', async () => { if (confirm('Restore the original interview demo data? This clears demo changes.')) { const r = await api('reset'); state = r; selectedAssetId = null; currentView = 'assets'; render(); closeDrawer(); showToast('Demo data restored'); } });
$('#banner-dismiss').addEventListener('click', () => $('.demo-banner').remove());
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
const originalRenderMain = renderMain;
renderMain = function () { originalRenderMain(); if (currentView === 'audit') showAuditFilters(); };
refresh().catch(e => showToast(e.message, true));
