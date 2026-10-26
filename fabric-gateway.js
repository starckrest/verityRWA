import { readFile, readdir } from 'node:fs/promises';
import { createPrivateKey, createHash, randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import { connect, hash, signers } from '@hyperledger/fabric-gateway';

const DEFAULT_BASE = new URL('./fabric-dev/fabric-samples/test-network/organizations/', import.meta.url);
const ORG = {
  org1: { mspId: 'Org1MSP', peer: 'localhost:7051', tls: new URL('peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt', DEFAULT_BASE), users: new URL('peerOrganizations/org1.example.com/users/', DEFAULT_BASE) },
  org2: { mspId: 'Org2MSP', peer: 'localhost:9051', tls: new URL('peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt', DEFAULT_BASE), users: new URL('peerOrganizations/org2.example.com/users/', DEFAULT_BASE) },
};

const roles = {
  issuer: { org: 'org1', user: 'RwaIssuer@org1.example.com' },
  investor: { org: 'org1', user: 'RwaInvestor@org1.example.com' },
  compliance: { org: 'org1', user: 'RwaCompliance@org1.example.com' },
  verifier: { org: 'org2', user: 'RwaVerifier@org2.example.com' },
  appraiser: { org: 'org2', user: 'RwaAppraiser@org2.example.com' },
  auditor: { org: 'org2', user: 'RwaAuditor@org2.example.com' },
};
const decodeJSON = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
let roleIdentityCache;

function getRoleIdentities() {
  if (!roleIdentityCache) {
    roleIdentityCache = Promise.all(Object.keys(roles).map(async actorRole => {
      const result = await withContract(actorRole, c => c.evaluateTransaction('MyIdentity'));
      return [actorRole, decodeJSON(result)];
    })).catch(error => { roleIdentityCache = undefined; throw error; });
  }
  return roleIdentityCache;
}

async function firstFile(directory) {
  const names = await readdir(directory);
  const file = names.find(name => !name.startsWith('.'));
  if (!file) throw new Error(`No credential found in ${directory}`);
  return new URL(file, directory);
}

async function withContract(role, operation) {
  const user = roles[role];
  if (!user) throw new Error(`Unsupported Fabric role: ${role}`);
  const org = ORG[user.org];
  const msp = new URL(`${user.user}/msp/`, org.users);
  const cert = await readFile(new URL('signcerts/cert.pem', msp));
  const privateKey = await readFile(await firstFile(new URL('keystore/', msp)));
  const tlsCert = await readFile(org.tls);
  const client = new grpc.Client(process.env.FABRIC_PEER_ENDPOINT || org.peer, grpc.credentials.createSsl(tlsCert), {
    'grpc.ssl_target_name_override': process.env.FABRIC_PEER_HOST || 'peer0.' + user.org + '.example.com',
    'grpc.default_authority': process.env.FABRIC_PEER_HOST || 'peer0.' + user.org + '.example.com',
  });
  const gateway = connect({
    client,
    identity: { mspId: org.mspId, credentials: cert },
    signer: signers.newPrivateKeySigner(createPrivateKey(privateKey)),
    hash: hash.sha256,
    evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
    endorseOptions: () => ({ deadline: Date.now() + 15000 }),
    submitOptions: () => ({ deadline: Date.now() + 5000 }),
    commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
  });
  try {
    const network = gateway.getNetwork(process.env.FABRIC_CHANNEL || 'rwa-consortium');
    return await operation(network.getContract(process.env.FABRIC_CHAINCODE || 'verityrwa'));
  } finally {
    gateway.close();
    client.close();
  }
}

export async function queryLedger(role = 'auditor') {
  return withContract(role, async contract => {
    const [assets, transfers] = await Promise.all([
      contract.evaluateTransaction('ListAssets'),
      contract.evaluateTransaction('ListTransfers'),
    ]);
    const [holdings, identities] = await Promise.all([
      contract.evaluateTransaction('ListHoldings'),
      getRoleIdentities(),
    ]);
    const rawAssets = decodeJSON(assets), rawTransfers = decodeJSON(transfers), rawHoldings = decodeJSON(holdings);
    const tokens = await Promise.all(rawAssets.filter(a => a.tokenId).map(async a => [a.tokenId, decodeJSON(await contract.evaluateTransaction('ReadToken', a.tokenId))]));
    const tokenById = new Map(tokens);
    const audits = await Promise.all(rawAssets.map(async a => decodeJSON(await contract.evaluateTransaction('AssetAudit', a.id))));
    const audit = audits.flat().sort((a, b) => b.at.localeCompare(a.at));
    const mappedAssets = rawAssets.map(a => {
      const attrs = a.attributes || {}, token = tokenById.get(a.tokenId);
      const holders = Object.fromEntries(rawHoldings.filter(h => h.tokenId === a.tokenId).map(h => [`${h.ownerMsp}|${h.ownerId}`, h.units]));
      const displayName = attrs.displayName || a.id;
      const subtitle = attrs.reference || a.jurisdiction;
      const visibleAttributes = Object.fromEntries(Object.entries(attrs).filter(([key]) => !['displayName', 'reference'].includes(key)));
      return { id: a.id, assetType: a.assetType, name: displayName, subtitle, attributes: visibleAttributes, jurisdiction: a.jurisdiction,
        evidence: a.evidence || [], owner: { msp: a.ownerMsp, id: a.ownerId }, status: a.status,
        verification: a.verification === 'APPROVE' ? 'APPROVED' : a.verification,
        valuation: a.valuation ? { ...a.valuation, amount: `${a.valuation.amount}`, reportSha256: a.valuation.reportSha256 } : null,
        token: token ? { id: token.id, representation: token.representation, totalUnits: token.totalUnits, unitName: token.unitName, status: token.status } : null,
        policy: { maxUnits: a.transferPolicy?.maxUnits || 0, allowedBuyerMsps: a.transferPolicy?.allowedBuyerMsps || [], requireCompliance: Boolean(a.transferPolicy?.requireCompliance) },
        holders, version: a.version };
    });
    const assetByToken = new Map(mappedAssets.filter(a => a.token).map(a => [a.token.id, a.id]));
    const mappedTransfers = rawTransfers.map(t => ({ id: t.id, assetId: assetByToken.get(t.tokenId), tokenId: t.tokenId,
      from: { msp: t.fromMsp, id: t.fromId }, to: { msp: t.toMsp, id: t.toId }, units: t.units, status: t.status,
      reason: t.reason || '', complianceRef: t.complianceRef || '', createdAt: t.createdAt || '' }));
    return { mode: 'FABRIC', assets: mappedAssets, transfers: mappedTransfers,
      audit: audit.map(e => ({ assetId: e.assetId, txId: e.txId, actor: e.actorId, role: e.role, action: e.action, from: e.from || '', to: e.to || '', reason: e.reason || '', at: e.at })),
      identities: Object.fromEntries(identities), activeRole: role };
  });
}

export async function submitLedger(role, transaction, ...args) {
  return withContract(role, contract => contract.submitTransaction(transaction, ...args));
}

export async function performLedgerAction(role, action, body) {
  const submit = (name, ...args) => submitLedger(role, name, ...args);
  if (action === 'register') {
    const id = `ASSET-${String(body.assetType || 'other').toUpperCase().slice(0, 4)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const attributes = Object.fromEntries(Object.entries(JSON.parse(body.attributesJSON)).map(([k, v]) => [k, String(v)]));
    attributes.displayName = body.name.trim(); attributes.reference = body.subtitle.trim();
    const report = JSON.stringify({ name: body.name, subtitle: body.subtitle, attributes });
    const evidence = [{ kind: body.evidenceKind || 'Supporting document', uri: body.evidenceURI || 'evidence/demo-document.pdf', sha256: createHash('sha256').update(report).digest('hex') }];
    await submit('RegisterAsset', id, body.assetType, JSON.stringify(attributes), body.jurisdiction, JSON.stringify(evidence), JSON.stringify({ maxUnits: 0, allowedBuyerMsps: [], requireCompliance: false }));
    return { message: 'Asset claim registered on Fabric', assetId: id };
  }
  const current = await queryLedger(role);
  const asset = current.assets.find(a => a.id === body.assetId);
  if (!asset) throw new Error('Asset not found on the Fabric channel');
  switch (action) {
    case 'verify':
      await submit('VerifyAsset', asset.id, body.decision === 'APPROVED' ? 'APPROVE' : 'REJECT', body.reason); break;
    case 'value': {
      const valuation = { amount: String(body.amount), currency: body.currency, method: body.method, asOf: body.asOf, source: body.source };
      valuation.reportSha256 = createHash('sha256').update(JSON.stringify(valuation)).digest('hex');
      await submit('RecordValuation', asset.id, JSON.stringify(valuation)); break;
    }
    case 'approve': await submit('ApproveAsset', asset.id, body.reason || 'Compliance checks passed'); break;
    case 'tokenize': await submit('IssueToken', asset.id, body.tokenId, body.representation, String(body.totalUnits), body.unitName); break;
    case 'transfer': {
      const requestId = `TR-${randomUUID().slice(0, 8).toUpperCase()}`;
      const units = Number(body.units);
      const actor = current.identities?.[role];
      const held = actor ? (asset.holders?.[`${actor.msp}|${actor.id}`] || 0) : 0;
      const eligible = asset.policy?.allowedBuyerMsps || [];
      let preflightReason = '';
      if (Number.isSafeInteger(units) && units > 0) {
        if (asset.status !== 'TOKENIZED' || asset.token?.status !== 'ACTIVE') preflightReason = 'Asset or token is not transferable';
        else if (eligible.length && !eligible.includes(body.toMsp)) preflightReason = 'Buyer organization is not eligible';
        else if (asset.policy?.maxUnits > 0 && units > asset.policy.maxUnits) preflightReason = 'Transfer exceeds the per-transfer unit limit';
        else if (asset.policy?.requireCompliance && !body.complianceRef) preflightReason = 'Compliance attestation is required';
        else if (asset.token?.representation === 'WHOLE' && (actor?.msp !== asset.owner.msp || actor?.id !== asset.owner.id)) preflightReason = 'Only the registered owner may transfer this whole asset';
        else if (units > held) preflightReason = `Insufficient units: identity holds ${held} unit(s), requested ${units}`;
      }
      if (preflightReason) {
        await submitLedger('compliance', 'RecordRejectedAttempt', requestId, asset.token.id, body.toMsp, body.toId, String(units), preflightReason);
        return { message: `Transfer rejected; reason recorded on Fabric: ${preflightReason}`, rejected: true };
      }
      try {
        await submit('SubmitTransfer', requestId, asset.token.id, body.toMsp, body.toId, String(body.units), body.complianceRef || '');
      } catch (error) {
        const reason = String(error.message || 'Transfer rules rejected this request').slice(0, 500);
        try { await submitLedger('compliance', 'RecordRejectedAttempt', requestId, asset.token.id, body.toMsp, body.toId, String(body.units), reason); }
        catch { throw error; }
        return { message: `Transfer rejected; reason recorded on Fabric: ${reason}`, rejected: true };
      }
      return { message: 'Transfer request submitted to Fabric for buyer acceptance', transferId: requestId };
    }
    case 'acceptTransfer': await submit('AcceptTransfer', body.transferId); break;
    case 'rejectTransfer': await submitLedger('compliance', 'RejectTransfer', body.transferId, body.reason); break;
    case 'close': await submit('CloseAsset', asset.id, body.status === 'REDEEMED' ? 'REDEEM' : 'RETIRE', body.reason); break;
    default: throw new Error(`Unsupported Fabric action: ${action}`);
  }
  return { message: 'Transaction committed to Fabric' };
}

export async function checkLedger(role = 'auditor') {
  await withContract(role, contract => contract.evaluateTransaction('ListAssets'));
  return { channel: process.env.FABRIC_CHANNEL || 'rwa-consortium', chaincode: process.env.FABRIC_CHAINCODE || 'verityrwa', mspId: ORG[roles[role].org].mspId };
}
