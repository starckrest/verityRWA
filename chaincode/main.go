package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type SmartContract struct{ contractapi.Contract }

type Evidence struct {
	Kind   string `json:"kind"`
	URI    string `json:"uri"`
	SHA256 string `json:"sha256"`
}
type Valuation struct {
	Amount       string `json:"amount"`
	Currency     string `json:"currency"`
	Method       string `json:"method"`
	AsOf         string `json:"asOf"`
	Source       string `json:"source"`
	ReportSHA256 string `json:"reportSha256"`
}
type Policy struct {
	MaxUnits          uint64   `json:"maxUnits"`
	AllowedBuyerMSPs  []string `json:"allowedBuyerMsps"`
	RequireCompliance bool     `json:"requireCompliance"`
}
type Asset struct {
	ID                 string            `json:"id"`
	Type               string            `json:"assetType"`
	Attributes         map[string]string `json:"attributes"`
	Jurisdiction       string            `json:"jurisdiction"`
	Evidence           []Evidence        `json:"evidence"`
	OwnerMSP           string            `json:"ownerMsp"`
	OwnerID            string            `json:"ownerId"`
	Status             string            `json:"status"`
	Verification       string            `json:"verification"`
	VerificationReason string            `json:"verificationReason"`
	Valuation          Valuation         `json:"valuation"`
	TokenID            string            `json:"tokenId"`
	Policy             Policy            `json:"transferPolicy"`
	Version            uint64            `json:"version"`
}
type Token struct {
	ID             string `json:"id"`
	AssetID        string `json:"assetId"`
	Representation string `json:"representation"`
	TotalUnits     uint64 `json:"totalUnits"`
	UnitName       string `json:"unitName"`
	Status         string `json:"status"`
}
type Holding struct {
	TokenID  string `json:"tokenId"`
	OwnerMSP string `json:"ownerMsp"`
	OwnerID  string `json:"ownerId"`
	Units    uint64 `json:"units"`
}
type Transfer struct {
	ID            string `json:"id"`
	TokenID       string `json:"tokenId"`
	FromMSP       string `json:"fromMsp"`
	FromID        string `json:"fromId"`
	ToMSP         string `json:"toMsp"`
	ToID          string `json:"toId"`
	Units         uint64 `json:"units"`
	Status        string `json:"status"`
	Reason        string `json:"reason"`
	ComplianceRef string `json:"complianceRef"`
}
type Audit struct {
	AssetID  string `json:"assetId"`
	TxID     string `json:"txId"`
	ActorID  string `json:"actorId"`
	ActorMSP string `json:"actorMsp"`
	Role     string `json:"role"`
	Action   string `json:"action"`
	From     string `json:"from"`
	To       string `json:"to"`
	Reason   string `json:"reason"`
	At       string `json:"at"`
}

func role(ctx contractapi.TransactionContextInterface, want string) error {
	v, ok, e := ctx.GetClientIdentity().GetAttributeValue("role")
	if e != nil {
		return e
	}
	if !ok || v != want {
		return fmt.Errorf("caller must have role=%s", want)
	}
	return nil
}
func identity(ctx contractapi.TransactionContextInterface) (string, string, error) {
	m, e := ctx.GetClientIdentity().GetMSPID()
	if e != nil {
		return "", "", e
	}
	i, e := ctx.GetClientIdentity().GetID()
	return m, i, e
}
func save(ctx contractapi.TransactionContextInterface, k string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return ctx.GetStub().PutState(k, b)
}
func load[T any](ctx contractapi.TransactionContextInterface, k string) (T, error) {
	var v T
	b, e := ctx.GetStub().GetState(k)
	if e != nil {
		return v, e
	}
	if b == nil {
		return v, fmt.Errorf("%s not found", k)
	}
	e = json.Unmarshal(b, &v)
	return v, e
}
func logEvent(ctx contractapi.TransactionContextInterface, assetID, action, from, to, reason string) error {
	m, id, e := identity(ctx)
	if e != nil {
		return e
	}
	t, e := ctx.GetStub().GetTxTimestamp()
	if e != nil {
		return e
	}
	a := Audit{assetID, ctx.GetStub().GetTxID(), id, m, "", action, from, to, reason, time.Unix(t.Seconds, int64(t.Nanos)).UTC().Format(time.RFC3339Nano)}
	a.Role, _, _ = ctx.GetClientIdentity().GetAttributeValue("role")
	b, e := json.Marshal(a)
	if e != nil {
		return e
	}
	k, e := ctx.GetStub().CreateCompositeKey("audit", []string{assetID, a.TxID})
	if e != nil {
		return e
	}
	return ctx.GetStub().PutState(k, b)
}
func exists(ctx contractapi.TransactionContextInterface, k string) (bool, error) {
	b, e := ctx.GetStub().GetState(k)
	return b != nil, e
}
func validateDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, e := strconv.ParseUint(s[:16], 16, 64)
	if e != nil {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

// RegisterAsset creates an unverified claim. Attributes hold the different fields required by each asset type.
func (s *SmartContract) RegisterAsset(ctx contractapi.TransactionContextInterface, id, assetType, attributesJSON, jurisdiction, evidenceJSON, policyJSON string) error {
	if e := role(ctx, "issuer"); e != nil {
		return e
	}
	if id == "" || assetType == "" || jurisdiction == "" {
		return errors.New("id, assetType, jurisdiction required")
	}
	var attrs map[string]string
	if e := json.Unmarshal([]byte(attributesJSON), &attrs); e != nil || len(attrs) == 0 {
		return errors.New("attributesJSON must be a non-empty string map")
	}
	var ev []Evidence
	if e := json.Unmarshal([]byte(evidenceJSON), &ev); e != nil || len(ev) == 0 {
		return errors.New("at least one evidence reference required")
	}
	for _, x := range ev {
		if x.Kind == "" || x.URI == "" || !validateDigest(x.SHA256) {
			return errors.New("evidence requires kind, uri and SHA-256 digest")
		}
	}
	var p Policy
	if policyJSON != "" {
		if e := json.Unmarshal([]byte(policyJSON), &p); e != nil {
			return e
		}
	}
	key := "asset:" + id
	ok, e := exists(ctx, key)
	if e != nil {
		return e
	}
	if ok {
		return errors.New("asset already exists")
	}
	m, owner, e := identity(ctx)
	if e != nil {
		return e
	}
	if p.AllowedBuyerMSPs == nil {
		p.AllowedBuyerMSPs = []string{}
	}
	a := Asset{ID: id, Type: assetType, Attributes: attrs, Jurisdiction: jurisdiction, Evidence: ev, OwnerMSP: m, OwnerID: owner, Status: "REGISTERED", Verification: "PENDING", VerificationReason: "", Valuation: Valuation{}, TokenID: "", Policy: p, Version: 1}
	if e = save(ctx, key, a); e != nil {
		return e
	}
	return logEvent(ctx, id, "REGISTER", "", "REGISTERED", "claim submitted")
}
func (s *SmartContract) VerifyAsset(ctx contractapi.TransactionContextInterface, id, decision, reason string) error {
	if e := role(ctx, "verifier"); e != nil {
		return e
	}
	a, e := load[Asset](ctx, "asset:"+id)
	if e != nil {
		return e
	}
	if a.Status != "REGISTERED" && a.Status != "REJECTED" {
		return errors.New("asset cannot be verified in current state")
	}
	if decision != "APPROVE" && decision != "REJECT" {
		return errors.New("decision must be APPROVE or REJECT")
	}
	if reason == "" {
		return errors.New("reason required")
	}
	old := a.Status
	a.Verification = decision
	a.VerificationReason = reason
	if decision == "APPROVE" {
		a.Status = "VERIFIED"
	} else {
		a.Status = "REJECTED"
	}
	a.Version++
	if e = save(ctx, "asset:"+id, a); e != nil {
		return e
	}
	return logEvent(ctx, id, "VERIFY", old, a.Status, reason)
}
func (s *SmartContract) RecordValuation(ctx contractapi.TransactionContextInterface, id, valuationJSON string) error {
	if e := role(ctx, "appraiser"); e != nil {
		return e
	}
	a, e := load[Asset](ctx, "asset:"+id)
	if e != nil {
		return e
	}
	if a.Status != "VERIFIED" && a.Status != "VALUED" {
		return errors.New("verify asset before valuation")
	}
	var v Valuation
	if e = json.Unmarshal([]byte(valuationJSON), &v); e != nil {
		return e
	}
	if v.Amount == "" || v.Currency == "" || v.Method == "" || v.Source == "" || !validateDigest(v.ReportSHA256) {
		return errors.New("valuation requires amount, currency, method, source and report digest")
	}
	if _, e = time.Parse("2006-01-02", v.AsOf); e != nil {
		return errors.New("asOf must use YYYY-MM-DD")
	}
	a.Valuation = v
	a.Status = "VALUED"
	a.Version++
	if e = save(ctx, "asset:"+id, a); e != nil {
		return e
	}
	return logEvent(ctx, id, "VALUE", "", v.Amount+" "+v.Currency, v.Method+"; "+v.Source+"; "+v.AsOf)
}
func (s *SmartContract) ApproveAsset(ctx contractapi.TransactionContextInterface, id, reason string) error {
	if e := role(ctx, "compliance"); e != nil {
		return e
	}
	a, e := load[Asset](ctx, "asset:"+id)
	if e != nil {
		return e
	}
	if a.Status != "VALUED" || a.Valuation.Amount == "" || a.Verification != "APPROVE" {
		return errors.New("approved verification and valuation required")
	}
	if reason == "" {
		return errors.New("approval reason required")
	}
	a.Status = "APPROVED"
	a.Version++
	if e = save(ctx, "asset:"+id, a); e != nil {
		return e
	}
	return logEvent(ctx, id, "APPROVE", "VALUED", "APPROVED", reason)
}
func (s *SmartContract) IssueToken(ctx contractapi.TransactionContextInterface, assetID, tokenID, representation, totalUnits, unitName string) error {
	if e := role(ctx, "issuer"); e != nil {
		return e
	}
	a, e := load[Asset](ctx, "asset:"+assetID)
	if e != nil {
		return e
	}
	if a.Status != "APPROVED" || a.TokenID != "" {
		return errors.New("asset must be approved and not already tokenized")
	}
	units, e := strconv.ParseUint(totalUnits, 10, 64)
	if e != nil || units == 0 {
		return errors.New("totalUnits must be positive")
	}
	if representation != "WHOLE" && representation != "FRACTIONAL" {
		return errors.New("representation must be WHOLE or FRACTIONAL")
	}
	if representation == "WHOLE" && units != 1 {
		return errors.New("WHOLE requires exactly one unit")
	}
	if tokenID == "" || unitName == "" {
		return errors.New("tokenID and unitName required")
	}
	ok, e := exists(ctx, "token:"+tokenID)
	if e != nil {
		return e
	}
	if ok {
		return errors.New("token ID already exists")
	}
	m, owner, e := identity(ctx)
	if e != nil {
		return e
	}
	if m != a.OwnerMSP || owner != a.OwnerID {
		return errors.New("only current owner may issue")
	}
	t := Token{tokenID, assetID, representation, units, unitName, "ACTIVE"}
	if e = save(ctx, "token:"+tokenID, t); e != nil {
		return e
	}
	h := Holding{tokenID, m, owner, units}
	if e = save(ctx, holdingKey(tokenID, m, owner), h); e != nil {
		return e
	}
	a.TokenID = tokenID
	a.Status = "TOKENIZED"
	a.Version++
	if e = save(ctx, "asset:"+assetID, a); e != nil {
		return e
	}
	return logEvent(ctx, assetID, "TOKENIZE", "APPROVED", "TOKENIZED", fmt.Sprintf("token=%s; %s %d %s", tokenID, representation, units, unitName))
}
func holdingKey(token, msp, id string) string { return "holding:" + token + ":" + msp + ":" + id }
func hasMSP(m string, list []string) bool {
	if len(list) == 0 {
		return true
	}
	for _, x := range list {
		if x == m {
			return true
		}
	}
	return false
}
func (s *SmartContract) SubmitTransfer(ctx contractapi.TransactionContextInterface, requestID, tokenID, toMSP, toID, unitsText, complianceRef string) error {
	if requestID == "" || toMSP == "" || toID == "" {
		return errors.New("request and buyer identity required")
	}
	units, e := strconv.ParseUint(unitsText, 10, 64)
	if e != nil || units == 0 {
		return errors.New("units must be positive")
	}
	tok, e := load[Token](ctx, "token:"+tokenID)
	if e != nil {
		return e
	}
	a, e := load[Asset](ctx, "asset:"+tok.AssetID)
	if e != nil {
		return e
	}
	m, id, e := identity(ctx)
	if e != nil {
		return e
	}
	if a.Status != "TOKENIZED" || tok.Status != "ACTIVE" {
		return errors.New("asset or token is not transferable")
	}
	if tok.Representation == "WHOLE" && (m != a.OwnerMSP || id != a.OwnerID) {
		return errors.New("only registered owner may initiate whole-asset transfer")
	}
	if !hasMSP(toMSP, a.Policy.AllowedBuyerMSPs) {
		return errors.New("buyer organization is not eligible")
	}
	if a.Policy.MaxUnits > 0 && units > a.Policy.MaxUnits {
		return errors.New("transfer exceeds unit limit")
	}
	if a.Policy.RequireCompliance && complianceRef == "" {
		return errors.New("compliance attestation required")
	}
	if tok.Representation == "WHOLE" && units != 1 {
		return errors.New("whole asset transfer requires one unit")
	}
	h, e := load[Holding](ctx, holdingKey(tokenID, m, id))
	if e != nil {
		return e
	}
	if h.Units < units {
		return errors.New("insufficient units")
	}
	key := "transfer:" + requestID
	ok, e := exists(ctx, key)
	if e != nil {
		return e
	}
	if ok {
		return errors.New("request ID already exists")
	}
	r := Transfer{requestID, tokenID, m, id, toMSP, toID, units, "PENDING", "", complianceRef}
	if e = save(ctx, key, r); e != nil {
		return e
	}
	return logEvent(ctx, a.ID, "TRANSFER_REQUEST", "HELD", "PENDING", fmt.Sprintf("request=%s units=%d buyer=%s/%s", requestID, units, toMSP, toID))
}
func (s *SmartContract) AcceptTransfer(ctx contractapi.TransactionContextInterface, requestID string) error {
	r, e := load[Transfer](ctx, "transfer:"+requestID)
	if e != nil {
		return e
	}
	if r.Status != "PENDING" {
		return errors.New("transfer is not pending")
	}
	m, id, e := identity(ctx)
	if e != nil {
		return e
	}
	if m != r.ToMSP || id != r.ToID {
		return errors.New("only buyer can accept")
	}
	tok, e := load[Token](ctx, "token:"+r.TokenID)
	if e != nil {
		return e
	}
	a, e := load[Asset](ctx, "asset:"+tok.AssetID)
	if e != nil {
		return e
	}
	fromKey := holdingKey(r.TokenID, r.FromMSP, r.FromID)
	toKey := holdingKey(r.TokenID, r.ToMSP, r.ToID)
	from, e := load[Holding](ctx, fromKey)
	if e != nil {
		return e
	}
	if from.Units < r.Units {
		return errors.New("seller balance changed")
	}
	to := Holding{TokenID: r.TokenID, OwnerMSP: r.ToMSP, OwnerID: r.ToID}
	b, e := ctx.GetStub().GetState(toKey)
	if e != nil {
		return e
	}
	if b != nil {
		if e = json.Unmarshal(b, &to); e != nil {
			return e
		}
	}
	from.Units -= r.Units
	to.Units += r.Units
	if e = save(ctx, fromKey, from); e != nil {
		return e
	}
	if e = save(ctx, toKey, to); e != nil {
		return e
	}
	r.Status = "ACCEPTED"
	if e = save(ctx, "transfer:"+requestID, r); e != nil {
		return e
	}
	if tok.Representation == "WHOLE" {
		a.OwnerMSP = r.ToMSP
		a.OwnerID = r.ToID
		a.Version++
		if e = save(ctx, "asset:"+a.ID, a); e != nil {
			return e
		}
	}
	return logEvent(ctx, a.ID, "TRANSFER", r.FromMSP+"/"+r.FromID, r.ToMSP+"/"+r.ToID, fmt.Sprintf("request=%s units=%d", requestID, r.Units))
}

// RejectTransfer records a compliance review decision for a pending request.
func (s *SmartContract) RejectTransfer(ctx contractapi.TransactionContextInterface, requestID, reason string) error {
	if e := role(ctx, "compliance"); e != nil {
		return e
	}
	if reason == "" {
		return errors.New("denial reason required")
	}
	r, e := load[Transfer](ctx, "transfer:"+requestID)
	if e != nil {
		return e
	}
	if r.Status != "PENDING" {
		return errors.New("transfer is not pending")
	}
	tok, e := load[Token](ctx, "token:"+r.TokenID)
	if e != nil {
		return e
	}
	r.Status, r.Reason = "REJECTED", reason
	if e = save(ctx, "transfer:"+requestID, r); e != nil {
		return e
	}
	return logEvent(ctx, tok.AssetID, "TRANSFER_REJECTED", "PENDING", "REJECTED", reason)
}

// MyIdentity exposes the caller identity to the local demo UI for buyer selection.
func (s *SmartContract) MyIdentity(ctx contractapi.TransactionContextInterface) (map[string]string, error) {
	m, id, e := identity(ctx)
	if e != nil {
		return nil, e
	}
	return map[string]string{"msp": m, "id": id}, nil
}

// RecordRejectedAttempt must be submitted by compliance as a separate valid transaction so the denial itself persists on-ledger.
func (s *SmartContract) RecordRejectedAttempt(ctx contractapi.TransactionContextInterface, requestID, tokenID, buyerMSP, buyerID, units, reason string) error {
	if e := role(ctx, "compliance"); e != nil {
		return e
	}
	if reason == "" || requestID == "" {
		return errors.New("request ID and denial reason required")
	}
	n, e := strconv.ParseUint(units, 10, 64)
	if e != nil || n == 0 {
		return errors.New("units must be positive")
	}
	tok, e := load[Token](ctx, "token:"+tokenID)
	if e != nil {
		return e
	}
	a, e := load[Asset](ctx, "asset:"+tok.AssetID)
	if e != nil {
		return e
	}
	ok, e := exists(ctx, "transfer:"+requestID)
	if e != nil {
		return e
	}
	if ok {
		return errors.New("request ID already exists")
	}
	r := Transfer{requestID, tokenID, a.OwnerMSP, a.OwnerID, buyerMSP, buyerID, n, "REJECTED", reason, ""}
	if e = save(ctx, "transfer:"+requestID, r); e != nil {
		return e
	}
	return logEvent(ctx, a.ID, "TRANSFER_REJECTED", "PENDING", "REJECTED", reason)
}
func (s *SmartContract) CloseAsset(ctx contractapi.TransactionContextInterface, id, action, reason string) error {
	if e := role(ctx, "issuer"); e != nil {
		return e
	}
	if action != "REDEEM" && action != "RETIRE" {
		return errors.New("action must be REDEEM or RETIRE")
	}
	if reason == "" {
		return errors.New("reason required")
	}
	a, e := load[Asset](ctx, "asset:"+id)
	if e != nil {
		return e
	}
	if a.Status != "TOKENIZED" {
		return errors.New("only tokenized assets can close")
	}
	old := a.Status
	if action == "REDEEM" {
		a.Status = "REDEEMED"
	} else {
		a.Status = "RETIRED"
	}
	a.Version++
	if e = save(ctx, "asset:"+id, a); e != nil {
		return e
	}
	t, e := load[Token](ctx, "token:"+a.TokenID)
	if e != nil {
		return e
	}
	t.Status = "CLOSED"
	if e = save(ctx, "token:"+t.ID, t); e != nil {
		return e
	}
	return logEvent(ctx, id, action, old, a.Status, reason)
}
func (s *SmartContract) ReadAsset(ctx contractapi.TransactionContextInterface, id string) (*Asset, error) {
	a, e := load[Asset](ctx, "asset:"+id)
	if e == nil && a.Policy.AllowedBuyerMSPs == nil {
		a.Policy.AllowedBuyerMSPs = []string{}
	}
	return &a, e
}
func (s *SmartContract) ReadToken(ctx contractapi.TransactionContextInterface, id string) (*Token, error) {
	t, e := load[Token](ctx, "token:"+id)
	return &t, e
}
func (s *SmartContract) ReadTransfer(ctx contractapi.TransactionContextInterface, id string) (*Transfer, error) {
	t, e := load[Transfer](ctx, "transfer:"+id)
	return &t, e
}

// ListAssets returns every current asset record for the application dashboard.
func (s *SmartContract) ListAssets(ctx contractapi.TransactionContextInterface) ([]Asset, error) {
	it, e := ctx.GetStub().GetStateByRange("asset:", "asset;")
	if e != nil {
		return nil, e
	}
	defer it.Close()
	out := []Asset{}
	for it.HasNext() {
		x, e := it.Next()
		if e != nil {
			return nil, e
		}
		var a Asset
		if e = json.Unmarshal(x.Value, &a); e != nil {
			return nil, e
		}
		if a.Policy.AllowedBuyerMSPs == nil {
			a.Policy.AllowedBuyerMSPs = []string{}
		}
		out = append(out, a)
	}
	return out, nil
}

// ListTransfers returns every transfer request, including rejected attempts.
func (s *SmartContract) ListTransfers(ctx contractapi.TransactionContextInterface) ([]Transfer, error) {
	it, e := ctx.GetStub().GetStateByRange("transfer:", "transfer;")
	if e != nil {
		return nil, e
	}
	defer it.Close()
	out := []Transfer{}
	for it.HasNext() {
		x, e := it.Next()
		if e != nil {
			return nil, e
		}
		var t Transfer
		if e = json.Unmarshal(x.Value, &t); e != nil {
			return nil, e
		}
		out = append(out, t)
	}
	return out, nil
}

// ListHoldings returns token balances for the dashboard.
func (s *SmartContract) ListHoldings(ctx contractapi.TransactionContextInterface) ([]Holding, error) {
	it, e := ctx.GetStub().GetStateByRange("holding:", "holding;")
	if e != nil {
		return nil, e
	}
	defer it.Close()
	out := []Holding{}
	for it.HasNext() {
		x, e := it.Next()
		if e != nil {
			return nil, e
		}
		var h Holding
		if e = json.Unmarshal(x.Value, &h); e != nil {
			return nil, e
		}
		out = append(out, h)
	}
	return out, nil
}
func (s *SmartContract) AssetAudit(ctx contractapi.TransactionContextInterface, id string) ([]Audit, error) {
	it, e := ctx.GetStub().GetStateByPartialCompositeKey("audit", []string{id})
	if e != nil {
		return nil, e
	}
	defer it.Close()
	out := []Audit{}
	for it.HasNext() {
		x, e := it.Next()
		if e != nil {
			return nil, e
		}
		var a Audit
		if e = json.Unmarshal(x.Value, &a); e != nil {
			return nil, e
		}
		out = append(out, a)
	}
	return out, nil
}
func (s *SmartContract) AssetHistory(ctx contractapi.TransactionContextInterface, id string) ([]map[string]string, error) {
	it, e := ctx.GetStub().GetHistoryForKey("asset:" + id)
	if e != nil {
		return nil, e
	}
	defer it.Close()
	out := []map[string]string{}
	for it.HasNext() {
		x, e := it.Next()
		if e != nil {
			return nil, e
		}
		stamp := ""
		if x.Timestamp != nil {
			stamp = time.Unix(x.Timestamp.Seconds, int64(x.Timestamp.Nanos)).UTC().Format(time.RFC3339Nano)
		}
		out = append(out, map[string]string{"txId": x.TxId, "timestamp": stamp, "value": string(x.Value), "deleted": strconv.FormatBool(x.IsDelete)})
	}
	return out, nil
}

func main() {
	cc, e := contractapi.NewChaincode(&SmartContract{})
	if e != nil {
		panic(e)
	}
	if e = cc.Start(); e != nil {
		panic(e)
	}
}
