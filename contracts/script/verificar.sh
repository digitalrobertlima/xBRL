#!/usr/bin/env bash
# Verifica no Sourcify (sem chave de API) os contratos de wallet/src/deployments/<chainId>.json.
# Uso: cd contracts && ./script/verificar.sh 137
set -euo pipefail
CHAIN="${1:?informe o chainId}"
J="../wallet/src/deployments/${CHAIN}.json"
x() { jq -r "$1" "$J"; }
TOKEN=$(x .xBRL); RESERVA=$(x .ReservaBRL); ESCROW=$(x .EscrowTrabalho)
COFRE=$(x .CofreCripto); MENSAGEIRO=$(x .Mensageiro); ENCAMINHADOR=$(x .Encaminhador)
DEPLOYER=$(x .deployer); TREASURY=$(x .treasury)
LASTROS=$(x '.lastros | join(",")')
TETO=$(cast call "$RESERVA" "TETO_RESERVA()(uint256)" --rpc-url "${RPC:-http://127.0.0.1:8545}" | awk '{print $1}')
falhas=0
v() { # endereço  contrato  args
  echo "== $2 em $1"
  if ! forge verify-contract --chain "$CHAIN" --verifier sourcify --watch $3 "$1" "$2"; then falhas=$((falhas+1)); fi
}
v "$TOKEN" src/xBRL.sol:xBRL "--constructor-args $(cast abi-encode 'f(address)' "$DEPLOYER")"
v "$COFRE" src/CofreCripto.sol:CofreCripto "--constructor-args $(x .argsCofre)"
v "$RESERVA" src/ReservaBRL.sol:ReservaBRL "--constructor-args $(cast abi-encode 'f(address,address,address,address[],address,uint256)' "$TOKEN" "$TREASURY" "$COFRE" "[$LASTROS]" "$TREASURY" "$TETO")"
v "$ENCAMINHADOR" src/Encaminhador.sol:Encaminhador ""
v "$ESCROW" src/EscrowTrabalho.sol:EscrowTrabalho "--constructor-args $(cast abi-encode 'f(address,address,address,address)' "$TOKEN" "$TREASURY" "$COFRE" "$ENCAMINHADOR")"
v "$MENSAGEIRO" src/Mensageiro.sol:Mensageiro "--constructor-args $(cast abi-encode 'f(address)' "$ENCAMINHADOR")"
echo "Falhas: $falhas"
exit "$falhas"
