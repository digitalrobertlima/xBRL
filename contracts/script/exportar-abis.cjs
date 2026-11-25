// Gera wallet/src/abis.js (ABIs legíveis) a partir dos artefatos do Foundry.
// Uso: cd contracts && forge build && node script/exportar-abis.cjs
const fs = require("fs");
const path = require("path");
const { ethers } = require("../../wallet/src/vendor/ethers.umd.min.js");

const raiz = path.join(__dirname, "..");
const contratos = ["xBRL", "ReservaBRL", "EscrowTrabalho"];
const saida = {};
for (const nome of contratos) {
  const art = JSON.parse(fs.readFileSync(path.join(raiz, "out", `${nome}.sol`, `${nome}.json`), "utf8"));
  saida[nome] = new ethers.Interface(art.abi).format(false);
}
const destino = path.join(raiz, "..", "wallet", "src", "abis.js");
const js =
  "// GERADO por contracts/script/exportar-abis.cjs — não editar à mão.\n" +
  "export const ABIS = " + JSON.stringify(saida, null, 2) + ";\n";
fs.writeFileSync(destino, js);
console.log("ABIs gravadas em", destino, Object.fromEntries(Object.entries(saida).map(([k, v]) => [k, v.length])));
