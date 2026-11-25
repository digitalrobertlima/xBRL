#!/usr/bin/env bash
# Verifica no Sourcify (sem chave de API) os contratos de wallet/src/deployments/<chainId>.json.
# Uso: cd contracts && ./script/verificar.sh 80002
set -euo pipefail
CHAIN="${1:?informe o chainId}"
J="../wallet/src/deployments/${CHAIN}.json"
x() { jq -r "$1" "$J"; }
TOKEN=$(x .xBRL); RESERVA=$(x .ReservaBRL); ESCROW=$(x .EscrowTrabalho)
DEPLOYER=$(x .deployer); TREASURY=$(x .treasury)
LASTROS=$(x '.lastros | join(",")')
falhas=0
v() { # endereço  contrato  args
  echo "== $2 em $1"
  if ! forge verify-contract --chain "$CHAIN" --verifier sourcify --watch $3 "$1" "$2"; then falhas=$((falhas+1)); fi
}
v "$TOKEN" src/xBRL.sol:xBRL "--constructor-args $(cast abi-encode 'f(address)' "$DEPLOYER")"
v "$RESERVA" src/ReservaBRL.sol:ReservaBRL "--constructor-args $(cast abi-encode 'f(address,address,address[],address)' "$TOKEN" "$TREASURY" "[$LASTROS]" "$TREASURY")"
v "$ESCROW" src/EscrowTrabalho.sol:EscrowTrabalho "--constructor-args $(cast abi-encode 'f(address,address)' "$TOKEN" "$TREASURY")"
if [ "$CHAIN" != "137" ]; then
  v "$(x '.lastros[0]')" script/DeployPolygon.s.sol:BRLTeste ""
fi
echo "Falhas: $falhas"
exit "$falhas"
