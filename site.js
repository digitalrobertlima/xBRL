// Página pública: marca, roseta da capa e tabela de contratos (lida dos arquivos de implantação).
import { marca, roseta } from "./wallet/src/marca.js";

document.getElementById("marca").innerHTML = marca(34);
const capa = document.getElementById("roseta-capa");
if (capa) capa.innerHTML = roseta({ tam: 340, tracos: 6, classe: "desenhar", rotulo: "" });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nomes = [
  ["xBRL", "Moeda BRLS"],
  ["ReservaBRL", "Reserva"],
  ["CofreCripto", "Cofre cripto"],
  ["EscrowTrabalho", "Trabalhos"],
  ["Mensageiro", "Conversas"],
  ["Encaminhador", "Envio sem gás"],
];
const alvo = document.getElementById("tabela-contratos");
if (alvo) {
  const d = await fetch("wallet/src/deployments/137.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  alvo.innerHTML = d
    ? nomes
        .filter(([k]) => /^0x[0-9a-fA-F]{40}$/.test(d[k] || ""))
        .map(([k, n]) => `<div class="linha"><span>${n}</span><a class="quem" href="https://polygonscan.com/address/${esc(d[k])}" target="_blank" rel="noopener">${esc(d[k])}</a></div>`)
        .join("") + `<div class="linha"><span>Criador da rede (recebe metade das taxas)</span><span class="quem">${esc(d.treasury)}</span></div>`
    : `<p class="mudo">Aguardando implantação.</p>`;
}
