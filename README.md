# VerityRWA — Fabric Real-World Asset Platform

VerityRWA is a Hyperledger Fabric chaincode starter for registering physical assets, verifying evidence, recording asset-specific valuations, issuing traceable whole or fractional units, governing transfers, and retiring assets. It is built around consortium identities and endorsement rather than a token contract detached from the real asset.

## Build sequence

1. Bring up a Fabric test network with issuer, verifier, appraiser, compliance, and investor identities.
2. Register an asset with its type-specific attributes, jurisdiction, owner identity, and evidence references plus SHA-256 digests.
3. Have an authorized verifier approve or reject it and record a reason.
4. Record the asset's own valuation, including amount, currency, method, as-of date, source, and report digest.
5. Require compliance approval before issuing a token series. The series links to one asset and states whether it represents the whole asset or fractional units.
6. Check buyer eligibility and transfer limits, record the transfer request, require buyer acceptance, then settle ownership.
7. Record denied attempts in a separate compliance transaction. A Fabric transaction that fails endorsement or validation cannot persist writes from that same failed transaction.
8. Redeem or retire the asset, then inspect its explicit audit trail and Fabric key history.

## Design choices

- One shared asset registry supports different `assetType` values and type-specific attributes (examples: land, vehicle, commodity, invoice). Governance remains common; adding a type adds a schema and validation rules, not a new platform.
- A token series is created only from an approved, verified, valued asset. Each token resolves to its real asset. Fractional units are claims against the asset, not duplicate legal title.
- Public state contains evidence references and hashes, never raw identity documents or private commercial documents. Keep files in controlled off-ledger storage; use Fabric private data collections for details that consortium subsets must share.
- MSP identity and certificate attributes enforce roles in chaincode. They complement, but do not replace, endorsement policies configured on the channel, collection, or individual key.
- The ledger proves which consortium identities endorsed submitted facts; it cannot independently prove that a physical asset exists. Connect registries, inspectors, custody, and valuation sources for that trust boundary.

## Run the interview demo in VS Code

Use the ready-made **VerityRWA demo server** launch configuration for a fast UI-only rehearsal on port `4173`. For the Fabric-backed interview flow, use **VerityRWA · Fabric live** on port `4179`; it reads and writes the local `rwa-consortium` channel through Fabric Gateway. The role selector chooses among local test certificates for demonstration and is not end-user authentication.

The current workspace has a Fabric 2.5 test network, channel, role identities, and chaincode already provisioned. Start Docker Desktop, then:

1. Open this folder in VS Code and run `npm install` in the integrated terminal if dependencies are not installed.
2. In **Run and Debug**, select **VerityRWA · Fabric live** and press **F5**. VS Code first runs the **Start VerityRWA Fabric network** task, then starts the dashboard server.
3. Open `http://localhost:4179` in a browser. The banner and channel indicator show when the UI is using Fabric.
4. Switch roles in the left rail to demonstrate issuer registration/tokenization, verifier review, appraiser valuation, compliance approval, investor acceptance, and auditor inspection.

For a brand-new local network, initialize it once from the VS Code terminal (do not run channel creation against a populated ledger):

```sh
export PATH="$PWD/fabric-dev/go1.27.3/bin:$PWD/fabric-dev/fabric-samples/bin:$PATH"
export GOCACHE=/private/tmp/verity-go-cache GOPATH=/private/tmp/verity-go-path
cd fabric-dev/fabric-samples/test-network
./network.sh up createChannel -c rwa-consortium -ca
cd ../../..
./scripts/register-demo-identities.sh
cd fabric-dev/fabric-samples/test-network
./network.sh deployCC -c rwa-consortium -ccn verityrwa -ccv 1.0 -ccs 1 -ccp ../../../chaincode -ccl go -ccep "AND('Org1MSP.peer','Org2MSP.peer')"
```

The role-scoped CA identities carry the certificate `role` attributes enforced by chaincode. Their demo enrollment secrets are only for a disposable local network.

The Go contract is deployed as `verityrwa` on `rwa-consortium`, sequence 6, with Org1 and Org2 peer endorsement. `/api/fabric/health` checks the live connection and `/api/fabric/state` reads the ledger-backed dashboard data. Fabric mode hides the local **Reset demo** control because committed ledger history is immutable.

The prototype keeps evidence files off-ledger and stores their references and SHA-256 digests on-ledger. A production deployment still needs controlled evidence storage, private data collection policies, trusted valuation and registry providers, and real user authentication before opening transactions to users. See the official Fabric docs for [private data collections](https://hyperledger-fabric.readthedocs.io/en/release-2.5/private-data-arch.html) and [endorsement policies](https://hyperledger-fabric.readthedocs.io/en/release-2.5/endorsement-policies.html).

## Hackathon demo

Use land and vehicle records on one channel with distinct attributes and valuation methods. Verify and value each separately. Issue a 1,000-unit fractional land series and a one-unit vehicle series. Show an ineligible transfer denial, a valid buyer-accepted transfer, token-to-asset resolution, and retirement with audit history.
