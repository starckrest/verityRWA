#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SAMPLES="$ROOT/fabric-dev/fabric-samples"
NETWORK="$SAMPLES/test-network"
CLIENT="$SAMPLES/bin/fabric-ca-client"

register_org() {
  local org="$1" ca_name="$2" ca_port="$3" ca_dir="$4" roles="$5"
  local org_dir="$NETWORK/organizations/peerOrganizations/$org.example.com"
  local ca_cert="$NETWORK/organizations/fabric-ca/$ca_dir/ca-cert.pem"
  export FABRIC_CA_CLIENT_HOME="$org_dir"
  while IFS= read -r role; do
    [[ -n "$role" ]] || continue
    local secret
    secret="$(openssl rand -hex 16)"
    local identity="rwa${role}"
    local capitalized_role
    capitalized_role="$(printf '%s' "$role" | awk '{print toupper(substr($0, 1, 1)) substr($0, 2)}')"
    local display="Rwa${capitalized_role}@$org.example.com"
    local msp="$org_dir/users/$display/msp"
    "$CLIENT" register --caname "$ca_name" --id.name "$identity" --id.secret "$secret" \
      --id.type client --id.attrs "role=$role:ecert" --url "https://localhost:$ca_port" \
      --tls.certfiles "$ca_cert"
    "$CLIENT" enroll --url "https://$identity:$secret@localhost:$ca_port" --caname "$ca_name" \
      -M "$msp" --tls.certfiles "$ca_cert"
    cp "$org_dir/msp/config.yaml" "$msp/config.yaml"
    printf 'Enrolled %s with role=%s in %sMSP\n' "$display" "$role" "$(printf '%s' "$org" | tr '[:lower:]' '[:upper:]')"
  done <<< "$roles"
}

register_org org1 ca-org1 7054 org1 $'issuer\ninvestor\ncompliance'
register_org org2 ca-org2 8054 org2 $'verifier\nappraiser\nauditor'
