// =====================================================================
// xBRL — configuração da Carteira Nativa (100% estática, sem servidor)
// ABIs vêm de ./abis.js (gerado a partir dos contratos compilados).
// Endereços do protocolo vêm de ./deployments/<chainId>.json (gerado pelo script de deploy).
// =====================================================================
import { ABIS } from "./abis.js";

export { ABIS };

export const VERSAO = "2.0.0-beta";
export const CREATOR_TREASURY = "0x2F8Fe2689411Bb336301AD4f2DC4077D433F43d1";
export const TAXA_BPS = 10n; // 0,1% na emissão, no resgate e nos pagamentos do Escrow (transferência é grátis)

export const REDE_PADRAO = 137;

/** Lista oficial de redes e tokens. Nenhum endereço aqui é editável pelo usuário. */
export const REDES = {
  137: {
    chainId: 137,
    nome: "Polygon PoS",
    curto: "Polygon",
    nativo: { simbolo: "POL", decimais: 18 },
    explorer: "https://polygonscan.com",
    // RPCs públicos, sem cadastro. A carteira usa todos com fallback automático.
    rpcs: [
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon-rpc.com",
      "https://1rpc.io/matic",
      "https://polygon.drpc.org",
    ],
    prioridadeMinimaGwei: 30n, // Polygon exige gorjeta mínima ~25–30 gwei
    tokens: [
      { simbolo: "BRZ", nome: "BRZ (Transfero)", endereco: "0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc", decimais: 18, lastro: true },
      { simbolo: "BRLA", nome: "BRLA (Avenia)", endereco: "0xE6A537a407488807F0bbeb0038B79004f19DDDFb", decimais: 18, lastro: true },
      { simbolo: "BRL1", nome: "BRL1", endereco: "0x5C067C80C00eCd2345b05E83A3e758eF799C40B5", decimais: 18, lastro: true },
      { simbolo: "WETH", nome: "Ether (WETH)", endereco: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimais: 18, cripto: true },
      { simbolo: "WPOL", nome: "POL embrulhado", endereco: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimais: 18, cripto: true },
      { simbolo: "USDC", nome: "USD Coin (nativo)", endereco: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimais: 6, moeda: "USD" },
    ],
    uniswap: {
      // Uniswap V3 — Polygon PoS
      swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
      wpol: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      taxasPool: [500, 3000, 100, 10000],
    },
  },
  80002: {
    chainId: 80002,
    nome: "Polygon Amoy (teste)",
    curto: "Amoy",
    nativo: { simbolo: "POL", decimais: 18 },
    explorer: "https://amoy.polygonscan.com",
    rpcs: ["https://rpc-amoy.polygon.technology", "https://polygon-amoy-bor-rpc.publicnode.com"],
    prioridadeMinimaGwei: 30n,
    faucetPol: "https://faucet.polygon.technology/",
    tokens: [], // tBRL vem do deploy (lastros[0])
    uniswap: null, // sem auto-swap em testnet
  },
  31337: {
    chainId: 31337,
    nome: "Anvil local (dev)",
    curto: "Local",
    nativo: { simbolo: "ETH", decimais: 18 },
    explorer: "",
    rpcs: ["http://127.0.0.1:8545"],
    prioridadeMinimaGwei: 1n,
    tokens: [],
    uniswap: null,
    somenteDev: true,
  },
};

/** Tanque de gás transparente. */
export const TANQUE = {
  alvoPol: "3.0", // enche até 3,0 POL
  gatilhoPol: "1.0", // abaixo disso sugere/realiza o abastecimento
  minimoParaOperarPol: "0.02", // reserva mínima para pagar o próprio swap
  slippageMaxBps: 100n, // 1,00% no máximo, nunca mais
  validadeSegundos: 300,
  // Trava contra cotação absurda (RPC malicioso ou pool manipulado): preço máximo aceito por 1 POL.
  precoMaximoPorPol: { BRL: "5", USD: "1" },
};

/** Regras do marketplace (iguais às do contrato). */
export const ESCROW = {
  prazoRevisaoDias: 3,
  prazoDisputaDias: 30,
  valorMinimoAvaliacao: 10,
  modalidades: [
    { id: 0, nome: "Presencial", icone: "🧹", resumo: "Serviço no local. O trabalhador prova que chegou com o código/QR que fica com você (ou você mesmo confirma a chegada)." },
    { id: 1, nome: "Entrega", icone: "🛵", resumo: "Leva até o destino. Só o código/QR de quem recebe libera o pagamento: sem código, sem entrega. Pode exigir caução do entregador." },
    { id: 2, nome: "Remoto", icone: "💻", resumo: "Trabalho digital. Aprovação ou 3 dias de silêncio." },
    { id: 3, nome: "Por etapas", icone: "🧱", resumo: "Projeto em parcelas iguais (2 a 50)." },
  ],
  caucaoMinima: 200, // xBRL — só ENTREGA
  prazoArbitrosDias: 3, // divergência dos árbitros antes do desempate do criador
  estados: ["Aberto", "Em execução", "Entregue", "Em disputa", "Concluído", "Cancelado"],
};

/** Cofre cripto (iguais ao contrato CofreCripto). */
export const COFRE = {
  taxaEmissaoBps: 50, // 0,5% somado à dívida (metade criador, metade colchão)
  bonusLiquidacaoBps: 1000,
  dividaMinima: 10,
};

export const SEGURANCA = {
  pinDigitos: 6,
  pbkdf2Iteracoes: 600_000,
  bloqueioAutomaticoMs: 5 * 60 * 1000,
  tentativasAntesDeEspera: 3,
};

/** Carrega os endereços do protocolo para a rede. Retorna null se ainda não implantado. */
export async function carregarImplantacao(chainId) {
  try {
    const r = await fetch(new URL(`./deployments/${chainId}.json`, import.meta.url), { cache: "no-cache" });
    if (!r.ok) return null;
    const j = await r.json();
    // Implantações antigas (sem cofre/mensageiro) usam ABIs diferentes: são ignoradas.
    if (Number(j.chainId) !== Number(chainId) || !j.xBRL || !j.CofreCripto || !j.Mensageiro) return null;
    return j;
  } catch {
    return null;
  }
}

export function linkExplorer(chainId, tipo, valor) {
  const base = REDES[chainId]?.explorer;
  return base ? `${base}/${tipo}/${valor}` : "";
}
