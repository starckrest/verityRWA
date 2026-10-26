import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { checkLedger, performLedgerAction, queryLedger } from './fabric-gateway.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const LEDGER_MODE = process.env.LEDGER_MODE || 'demo';
const STORE = join(ROOT, 'data', 'demo-ledger.json');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const roles = ['issuer', 'verifier', 'appraiser', 'compliance', 'investor', 'auditor'];

function digest(text) { return createHash('sha256').update(text).digest('hex'); }
function stamp() { return new Date().toISOString(); }
function event(state, asset, actor, action, from, to, reason) {
  const txId = `tx-${randomUUID().slice(0, 8)}`;
  const item = { assetId: asset.id, txId, actor, role: state.activeRole, action, from, to, reason, at: stamp() };
  state.audit.unshift(item);
  asset.version += 1;
  return item;
}
function seed() {
  const landEvidence = { kind: 'Land title extract', uri: 'evidence/land-title-042.pdf', sha256: digest('demo land title evidence') };
  const vehicleEvidence = { kind: 'Registration certificate', uri: 'evidence/vehicle-reg-118.pdf', sha256: digest('demo vehicle registration') };
  const land = { id: 'ASSET-LAND-0042', assetType: 'land', name: 'Orchard Road Parcel', subtitle: 'Survey No. 18/2 · Pune, Maharashtra', attributes: { surveyNumber: '18/2', area: '2.4 acres', landUse: 'Agricultural', district: 'Pune' }, jurisdiction: 'IN-MH', evidence: [landEvidence], owner: { msp: 'IssuerMSP', id: 'issuer.land.co' }, status: 'TOKENIZED', verification: 'APPROVED', valuation: { amount: '₹ 1,20,00,000', currency: 'INR', method: 'Comparable sales', asOf: '2026-10-20', source: 'Western Valuers LLP' }, token: { id: 'VR-LAND-0042', representation: 'FRACTIONAL', totalUnits: 1000, unitName: 'units', status: 'ACTIVE' }, policy: { maxUnits: 100, allowedBuyerMsps: ['InvestorMSP'], requireCompliance: true }, holders: { 'IssuerMSP|issuer.land.co': 1000 }, version: 4 };
  const vehicle = { id: 'ASSET-VEH-0118', assetType: 'vehicle', name: 'Mahindra 575 DI Tractor', subtitle: 'MH12 AB 7712 · 2023', attributes: { vin: 'MA1AB2CD3EF004218', make: 'Mahindra', model: '575 DI', year: '2023', registration: 'MH12 AB 7712' }, jurisdiction: 'IN-MH', evidence: [vehicleEvidence], owner: { msp: 'IssuerMSP', id: 'issuer.fleet.co' }, status: 'VERIFIED', verification: 'APPROVED', valuation: null, token: null, policy: { maxUnits: 1, allowedBuyerMsps: ['InvestorMSP'], requireCompliance: false }, holders: {}, version: 2 };
  const invoice = { id: 'ASSET-INV-0021', assetType: 'invoice', name: 'AgriCo Supply Invoice', subtitle: 'INV-2026-0021 · due 18 Nov 2026', attributes: { invoiceNumber: 'INV-2026-0021', debtor: 'AgriCo Foods Ltd.', dueDate: '2026-11-18', faceValue: '₹ 8,40,000' }, jurisdiction: 'IN', evidence: [{ kind: 'Invoice document', uri: 'evidence/invoice-0021.pdf', sha256: digest('demo invoice evidence') }], owner: { msp: 'IssuerMSP', id: 'issuer.trade.co' }, status: 'REGISTERED', verification: 'PENDING', valuation: null, token: null, policy: { maxUnits: 1, allowedBuyerMsps: [], requireCompliance: true }, holders: {}, version: 1 };
  return { mode: 'DEMO', activeRole: 'issuer', assets: [land, vehicle, invoice], transfers: [], audit: [
    { assetId: land.id, txId: 'tx-7c31a90d', actor: 'issuer.land.co', role: 'issuer', action: 'REGISTER', from: '', to: 'REGISTERED', reason: 'Initial asset claim and evidence submitted', at: '2026-10-18T09:15:00.000Z' },
    { assetId: land.id, txId: 'tx-a4220bf1', actor: 'verifier.registry.org', role: 'verifier', action: 'VERIFY', from: 'REGISTERED', to: 'VERIFIED', reason: 'Parcel record matched district registry', at: '2026-10-19T10:30:00.000Z' },
    { assetId: land.id, txId: 'tx-0f31d886', actor: 'appraiser.valuations.org', role: 'appraiser', action: 'VALUE', from: 'VERIFIED', to: 'VALUED', reason: 'Comparable sales valuation · Western Valuers LLP', at: '2026-10-20T12:10:00.000Z' },
    { assetId: land.id, txId: 'tx-244b793a', actor: 'compliance.bank.org', role: 'compliance', action: 'APPROVE', from: 'VALUED', to: 'APPROVED', reason: 'Evidence and valuation checks passed', at: '2026-10-21T08:40:00.000Z' },
    { assetId: land.id, txId: 'tx-91d2e4f8', actor: 'issuer.land.co', role: 'issuer', action: 'TOKENIZE', from: 'APPROVED', to: 'TOKENIZED', reason: 'VR-LAND-0042 · 1,000 fractional units issued', at: '2026-10-21T09:00:00.000Z' },
    { assetId: vehicle.id, txId: 'tx-fc43b521', actor: 'verifier.registry.org', role: 'verifier', action: 'VERIFY', from: 'REGISTERED', to: 'VERIFIED', reason: 'Registration certificate matched vehicle record', at: '2026-10-23T07:30:00.000Z' }
  ] };
}
async function readDemoState() {
  try { return JSON.parse(await readFile(STORE, 'utf8')); }
  catch { const state = seed(); await persist(state); return state; }
}
async function readState() {
  const saved = await readDemoState();
  if (LEDGER_MODE !== 'fabric') return saved;
  return { ...(await queryLedger(saved.activeRole)), activeRole: saved.activeRole, mode: 'FABRIC' };
}
async function persist(state) { await mkdir(join(ROOT, 'data'), { recursive: true }); await writeFile(STORE, JSON.stringify(state, null, 2)); }
function findAsset(state, id) { const a = state.assets.find(x => x.id === id); if (!a) throw new Error('Asset not found'); return a; }
function checkRole(state, allowed) { if (!allowed.includes(state.activeRole)) throw new Error(`This action requires ${allowed.join(' or ')} role`); }
function doAction(state, body) {
  const { action } = body;
  if (action === 'setRole') { if (!roles.includes(body.role)) throw new Error('Unknown role'); state.activeRole = body.role; return { message: `Viewing as ${body.role}` }; }
  if (action === 'reset') return { reset: true };
  if (action === 'register') {
    checkRole(state, ['issuer']);
    if (!body.name?.trim() || !body.assetType || !body.jurisdiction || !body.subtitle?.trim()) throw new Error('Complete the asset name, type, location and jurisdiction');
    let attributes; try { attributes = JSON.parse(body.attributesJSON); } catch { throw new Error('Asset attributes must be valid JSON'); }
    if (!attributes || Array.isArray(attributes) || typeof attributes !== 'object' || !Object.keys(attributes).length) throw new Error('Add at least one type-specific asset attribute');
    const id = `ASSET-${body.assetType.toUpperCase().slice(0, 4)}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const asset = { id, assetType: body.assetType, name: body.name.trim(), subtitle: body.subtitle.trim(), attributes, jurisdiction: body.jurisdiction, evidence: [{ kind: body.evidenceKind || 'Supporting document', uri: body.evidenceURI || 'evidence/demo-document.pdf', sha256: digest(body.name + body.subtitle + JSON.stringify(attributes)) }], owner: { msp: 'IssuerMSP', id: 'issuer.demo.co' }, status: 'REGISTERED', verification: 'PENDING', valuation: null, token: null, policy: { maxUnits: 0, allowedBuyerMsps: [], requireCompliance: false }, holders: {}, version: 1 };
    state.assets.unshift(asset); event(state, asset, 'issuer.demo.co', 'REGISTER', '', asset.status, 'Asset claim and supporting evidence submitted'); return { message: 'Asset registered', assetId: id };
  }
  const a = findAsset(state, body.assetId);
  switch (action) {
    case 'verify': {
      checkRole(state, ['verifier']); if (!['REGISTERED', 'REJECTED'].includes(a.status)) throw new Error('Asset is not awaiting verification');
      if (!['APPROVED', 'REJECTED'].includes(body.decision) || !body.reason?.trim()) throw new Error('Choose a decision and enter a reason');
      const from = a.status; a.verification = body.decision; a.status = body.decision === 'APPROVED' ? 'VERIFIED' : 'REJECTED'; event(state, a, 'verifier.registry.org', 'VERIFY', from, a.status, body.reason.trim()); break;
    }
    case 'value': {
      checkRole(state, ['appraiser']); if (!['VERIFIED', 'VALUED'].includes(a.status)) throw new Error('Verify the asset before valuing it');
      const { amount, currency, method, asOf, source } = body; if (![amount, currency, method, asOf, source].every(Boolean)) throw new Error('Complete every valuation field');
      const from = a.status; a.valuation = { amount, currency, method, asOf, source }; a.status = 'VALUED'; event(state, a, 'appraiser.valuations.org', 'VALUE', from, a.status, `${method} · ${source} · ${asOf}`); break;
    }
    case 'approve': {
      checkRole(state, ['compliance']); if (a.status !== 'VALUED' || a.verification !== 'APPROVED' || !a.valuation) throw new Error('Approved verification and valuation are required');
      const from = a.status; a.status = 'APPROVED'; event(state, a, 'compliance.bank.org', 'APPROVE', from, a.status, body.reason || 'Compliance checks passed'); break;
    }
    case 'tokenize': {
      checkRole(state, ['issuer']); if (a.status !== 'APPROVED' || a.token) throw new Error('Only approved, untokenized assets may be issued');
      const units = Number(body.totalUnits); if (!Number.isSafeInteger(units) || units < 1 || (body.representation === 'WHOLE' && units !== 1)) throw new Error('Whole assets need 1 unit; fractional units must be a positive integer');
      a.token = { id: body.tokenId || `VR-${a.assetType.toUpperCase()}-${a.id.slice(-4)}`, representation: body.representation, totalUnits: units, unitName: body.unitName || 'units', status: 'ACTIVE' };
      a.holders[`${a.owner.msp}|${a.owner.id}`] = units; const from = a.status; a.status = 'TOKENIZED'; event(state, a, 'issuer.asset.co', 'TOKENIZE', from, a.status, `${a.token.id} · ${units.toLocaleString()} ${a.token.unitName}`); break;
    }
    case 'transfer': {
      checkRole(state, ['issuer', 'investor']); if (!a.token || a.status !== 'TOKENIZED') throw new Error('Asset is not transferable');
      const fromKey = `${body.fromMsp}|${body.fromId}`; const units = Number(body.units); if (!Number.isSafeInteger(units) || units < 1) throw new Error('Enter a positive unit count');
      if (a.token.representation === 'WHOLE' && (body.fromMsp !== a.owner.msp || body.fromId !== a.owner.id || units !== 1)) throw new Error('Whole-asset transfer must be initiated by its registered owner for 1 unit');
      if (a.policy.allowedBuyerMsps.length && !a.policy.allowedBuyerMsps.includes(body.toMsp)) throw new Error('Buyer organization is not eligible');
      if (a.policy.maxUnits && units > a.policy.maxUnits) throw new Error('Transfer exceeds the per-transfer limit');
      if (a.policy.requireCompliance && !body.complianceRef) throw new Error('Compliance attestation is required');
      if ((a.holders[fromKey] || 0) < units) throw new Error('Insufficient token balance');
      const id = `TR-${randomUUID().slice(0, 8).toUpperCase()}`; state.transfers.unshift({ id, assetId: a.id, tokenId: a.token.id, from: { msp: body.fromMsp, id: body.fromId }, to: { msp: body.toMsp, id: body.toId }, units, status: 'PENDING', complianceRef: body.complianceRef || '', createdAt: stamp() });
      event(state, a, `${body.fromId}`, 'TRANSFER_REQUEST', 'HELD', 'PENDING', `${id} · ${units} ${a.token.unitName} to ${body.toId}`); break;
    }
    case 'acceptTransfer': {
      checkRole(state, ['investor']); const t = state.transfers.find(x => x.id === body.transferId); if (!t || t.status !== 'PENDING') throw new Error('Pending transfer not found');
      const fromKey = `${t.from.msp}|${t.from.id}`, toKey = `${t.to.msp}|${t.to.id}`; if ((a.holders[fromKey] || 0) < t.units) throw new Error('Seller balance changed');
      a.holders[fromKey] -= t.units; a.holders[toKey] = (a.holders[toKey] || 0) + t.units; t.status = 'ACCEPTED'; t.acceptedAt = stamp();
      if (a.token.representation === 'WHOLE') a.owner = { msp: t.to.msp, id: t.to.id };
      event(state, a, t.to.id, 'TRANSFER', 'PENDING', 'ACCEPTED', `${t.id} · ${t.units} ${a.token.unitName}`); break;
    }
    case 'rejectTransfer': {
      checkRole(state, ['compliance']); const t = state.transfers.find(x => x.id === body.transferId); if (!t || t.status !== 'PENDING') throw new Error('Pending transfer not found'); if (!body.reason?.trim()) throw new Error('A denial reason is required');
      t.status = 'REJECTED'; t.reason = body.reason.trim(); t.reviewedAt = stamp(); event(state, a, 'compliance.bank.org', 'TRANSFER_REJECTED', 'PENDING', 'REJECTED', t.reason); break;
    }
    case 'close': {
      checkRole(state, ['issuer']); if (a.status !== 'TOKENIZED') throw new Error('Only tokenized assets can be closed'); if (!['REDEEMED', 'RETIRED'].includes(body.status)) throw new Error('Choose redemption or retirement');
      const from = a.status; a.status = body.status; a.token.status = 'CLOSED'; event(state, a, 'issuer.asset.co', body.status, from, a.status, body.reason || 'Lifecycle completed'); break;
    }
    default: throw new Error('Unknown action');
  }
  return { message: 'Transaction recorded' };
}

async function bodyJSON(req) { let raw = ''; for await (const chunk of req) raw += chunk; if (raw.length > 1_000_000) throw new Error('Request is too large'); return raw ? JSON.parse(raw) : {}; }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const send = (status, data, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type.startsWith('application/json') ? JSON.stringify(data) : data); };
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') return send(200, await readState());
    if (url.pathname === '/api/fabric/health' && req.method === 'GET') {
      const role = url.searchParams.get('role') || 'auditor';
      return send(200, { connected: true, ...(await checkLedger(role)) });
    }
    if (url.pathname === '/api/fabric/state' && req.method === 'GET') {
      const role = url.searchParams.get('role') || 'auditor';
      return send(200, await queryLedger(role));
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const body = await bodyJSON(req);
      if (LEDGER_MODE === 'fabric') {
        const saved = await readDemoState();
        if (body.action === 'reset') throw new Error('Reset is available only in local demo mode; Fabric ledger history is immutable.');
        const result = body.action === 'setRole' ? doAction(saved, body) : await performLedgerAction(saved.activeRole, body.action, body);
        await persist(saved);
        return send(200, { ...result, state: await readState() });
      }
      if (body.action === 'reset') { const fresh = seed(); await persist(fresh); return send(200, fresh); }
      const state = await readDemoState(); const result = doAction(state, body); await persist(state); return send(200, { ...result, state });
    }
    const safe = normalize(decodeURIComponent(url.pathname)).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '');
    const path = safe ? join(ROOT, 'public', safe) : join(ROOT, 'public', 'index.html');
    if (!path.startsWith(join(ROOT, 'public'))) return send(403, { error: 'Forbidden' });
    const data = await readFile(path); return send(200, data, MIME[extname(path)] || 'application/octet-stream');
  } catch (error) { return send(error.message === 'Asset not found' ? 404 : 400, { error: error.message || 'Request failed' }); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`VerityRWA demo ready at http://localhost:${PORT}`));
