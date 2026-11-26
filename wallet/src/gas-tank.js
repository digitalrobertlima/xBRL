// =====================================================================
// xBRL — Tanque de Gás Transparente
// Mantém até 3,0 POL na carteira para pagar as taxas da rede. Quando o tanque fica abaixo de 1,0 POL,
// troca um token da própria carteira (BRLS, BRZ, BRLA ou USDC) por POL na Uniswap V3:
//   - descobre sozinho o caminho (até 3 trocas, ex.: BRLS → BRLA → USDC → POL), só por fundos que existem
//     e têm dinheiro dentro, lidos na própria blockchain (fábrica da Uniswap + Multicall3, sem servidor);
//   - cotação na hora pelo QuoterV2;
//   - slippage máximo de 1% (amountInMaximum = cotação × 1,01) — se o preço piorar, a troca falha e nada é gasto;
//   - prazo de 5 min; aprovação exata (nunca "infinita");
//   - tudo registrado no histórico local e exibido antes de assinar.
// =====================================================================
import { REDES, TANQUE } from "./config.js";

const e = () => globalThis.ethers;
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002"; // constante do SwapRouter02
const HISTORICO = "xbrl.tanque.historico";
const AUTO = "xbrl.tanque.auto";

const ABI_QUOTER = [
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  "function quoteExactOutput(bytes path,uint256 amountOut) returns (uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
];
const ABI_ROUTER = [
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
  "function exactOutput((bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum) params) payable returns (uint256 amountIn)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)",
];
const ABI_ERC20 = [
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

/** Abastecimento automático: LIGADO de fábrica (decisão do dono, 26/11/2026). Só desliga se a pessoa desligar. */
export function autoAtivo() {
  try { return localStorage.getItem(AUTO) !== "0"; } catch { return true; }
}

export function definirAuto(ativo) {
  localStorage.setItem(AUTO, ativo ? "1" : "0");
}

export function historico() {
  try {
    return JSON.parse(localStorage.getItem(HISTORICO) || "[]");
  } catch {
    return [];
  }
}

function registrar(item) {
  const h = historico();
  h.unshift({ ...item, quando: Date.now() });
  localStorage.setItem(HISTORICO, JSON.stringify(h.slice(0, 50)));
}

/** Situação do tanque. */
export async function estadoTanque(provider, endereco) {
  const saldo = await provider.getBalance(endereco);
  const alvo = e().parseEther(TANQUE.alvoPol);
  const gatilho = e().parseEther(TANQUE.gatilhoPol);
  const nivelPct = Number((saldo * 1000n) / alvo) / 10;
  return {
    saldo,
    alvo,
    gatilho,
    nivelPct: Math.min(100, nivelPct),
    precisaAbastecer: saldo < gatilho,
    faltam: saldo >= alvo ? 0n : alvo - saldo,
    podePagarSwap: saldo >= e().parseEther(TANQUE.minimoParaOperarPol),
  };
}

/** Caminho Uniswap V3 codificado para exactOutput (ordem invertida: saída → entrada). */
function caminhoReverso(tokens, taxas) {
  const tipos = [];
  const valores = [];
  for (let i = 0; i < tokens.length; i++) {
    tipos.push("address");
    valores.push(tokens[i]);
    if (i < taxas.length) {
      tipos.push("uint24");
      valores.push(taxas[i]);
    }
  }
  return e().solidityPacked(tipos, valores);
}

const ABI_FABRICA = ["function getPool(address,address,uint24) view returns (address)"];
const ABI_POOL = ["function liquidity() view returns (uint128)"];
const ABI_MULTICALL = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)"];
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Caminhos possíveis de `entrada` até `saida` (até `maxSaltos` trocas), dada a lista de fundos com dinheiro.
 * fundos = [{ a, b, taxa }]. Devolve [{ tokens: [entrada, …, saida], taxas: [...] }], os mais curtos primeiro.
 */
export function caminhosPossiveis(entrada, saida, fundos, maxSaltos = 3) {
  const low = (x) => x.toLowerCase();
  const viz = new Map();
  for (const f of fundos) {
    for (const [x, y] of [[f.a, f.b], [f.b, f.a]]) {
      if (!viz.has(low(x))) viz.set(low(x), []);
      viz.get(low(x)).push({ para: y, taxa: f.taxa });
    }
  }
  const saidas = [];
  const andar = (tokens, taxas) => {
    const atual = tokens[tokens.length - 1];
    if (low(atual) === low(saida)) return saidas.push({ tokens, taxas });
    if (taxas.length >= maxSaltos) return;
    for (const v of viz.get(low(atual)) || []) {
      if (tokens.some((t) => low(t) === low(v.para))) continue; // sem voltar por onde passou
      andar([...tokens, v.para], [...taxas, v.taxa]);
    }
  };
  andar([entrada], []);
  return saidas.sort((x, y) => x.taxas.length - y.taxas.length);
}

/** Lê na blockchain quais fundos (par + taxa) existem e têm dinheiro dentro. */
async function fundosComDinheiro(provider, u, moedas) {
  const fab = new (e().Interface)(ABI_FABRICA);
  const poolI = new (e().Interface)(ABI_POOL);
  const mc = new (e().Contract)(u.multicall3, ABI_MULTICALL, provider);
  const pares = [];
  for (let i = 0; i < moedas.length; i++) {
    for (let j = i + 1; j < moedas.length; j++) {
      for (const taxa of u.taxasPool) pares.push({ a: moedas[i], b: moedas[j], taxa });
    }
  }
  const r1 = await mc.aggregate3.staticCall(pares.map((p) => ({ target: u.fabrica, allowFailure: true, callData: fab.encodeFunctionData("getPool", [p.a, p.b, p.taxa]) })));
  const existentes = [];
  r1.forEach((r, i) => {
    if (!r.success) return;
    const end = fab.decodeFunctionResult("getPool", r.returnData)[0];
    if (end && end !== ZERO) existentes.push({ ...pares[i], pool: end });
  });
  if (!existentes.length) return [];
  const r2 = await mc.aggregate3.staticCall(existentes.map((p) => ({ target: p.pool, allowFailure: true, callData: poolI.encodeFunctionData("liquidity") })));
  return existentes.filter((p, i) => r2[i].success && poolI.decodeFunctionResult("liquidity", r2[i].returnData)[0] > 0n);
}

/**
 * Cota quanto de `tokenEntrada` é preciso para obter `quantidadePol` (wei) de POL.
 * Procura todos os caminhos de até 3 trocas por fundos com dinheiro e escolhe o mais barato.
 * `outras` = moedas extras por onde pode passar (ex.: o BRLS da implantação).
 */
export async function cotarAbastecimento(provider, chainId, tokenEntrada, quantidadePol, info = { decimais: 18, moeda: "BRL" }, outras = []) {
  const rede = REDES[chainId];
  if (!rede?.uniswap) throw new Error("Auto-swap indisponível nesta rede");
  const u = rede.uniswap;
  const quoter = new (e().Contract)(u.quoterV2, ABI_QUOTER, provider);
  const moedas = [];
  for (const m of [tokenEntrada, u.wpol, ...(u.intermediarios || [u.usdc]), ...outras]) {
    if (m && e().isAddress(m) && !moedas.some((x) => x.toLowerCase() === m.toLowerCase())) moedas.push(e().getAddress(m));
  }
  const fundos = await fundosComDinheiro(provider, u, moedas);
  const caminhos = caminhosPossiveis(tokenEntrada, u.wpol, fundos, 3).slice(0, 16);
  const simbolo = (end) => rede.tokens?.find((t) => t.endereco.toLowerCase() === end.toLowerCase())?.simbolo || (outras.some((o) => o?.toLowerCase() === end.toLowerCase()) ? "BRLS" : `${end.slice(0, 6)}…`);
  const cotados = await Promise.allSettled(caminhos.map(async (c) => {
    // exactOutput lê o caminho de trás para a frente: POL ← … ← entrada
    const path = caminhoReverso([...c.tokens].reverse(), [...c.taxas].reverse());
    const r = await quoter.quoteExactOutput.staticCall(path, quantidadePol);
    const meio = c.tokens.slice(1, -1).map(simbolo);
    return { tipo: meio.length ? `via ${meio.join(" → ")}` : "direta", taxas: c.taxas, path, entrada: r.amountIn };
  }));
  const rotas = cotados.filter((x) => x.status === "fulfilled" && x.value.entrada > 0n).map((x) => x.value);
  if (!rotas.length) throw new Error("Ainda não há fundo na Uniswap que leve esta moeda até o POL. Escolha outra moeda para abastecer.");
  rotas.sort((a, b) => (a.entrada < b.entrada ? -1 : 1));
  const melhor = rotas[0];
  const maximo = (melhor.entrada * (10_000n + TANQUE.slippageMaxBps)) / 10_000n;
  // Trava de sanidade: nunca pagar mais que o preço-teto por POL, mesmo que o RPC diga o contrário.
  const teto = e().parseUnits(TANQUE.precoMaximoPorPol[info.moeda || "BRL"], info.decimais);
  if (maximo * 10n ** 18n > teto * quantidadePol) {
    throw new Error("Cotação fora do normal — troca bloqueada por segurança. Tente mais tarde ou use outro token.");
  }
  return {
    chainId,
    tokenEntrada,
    quantidadePol,
    entradaCotada: melhor.entrada,
    entradaMaxima: maximo,
    slippageBps: TANQUE.slippageMaxBps,
    rota: melhor,
    validoAte: Math.floor(Date.now() / 1000) + TANQUE.validadeSegundos,
  };
}

/** Executa a troca cotada. Devolve o recibo da transação. */
export async function abastecer(signer, cotacao, opcoesTx = {}) {
  const rede = REDES[cotacao.chainId];
  const u = rede.uniswap;
  const dono = await signer.getAddress();
  if (Math.floor(Date.now() / 1000) > cotacao.validoAte) throw new Error("Cotação expirada. Cote de novo.");

  const token = new (e().Contract)(cotacao.tokenEntrada, ABI_ERC20, signer);
  const saldo = await token.balanceOf(dono);
  if (saldo < cotacao.entradaMaxima) throw new Error("Saldo insuficiente do token escolhido");
  const permitido = await token.allowance(dono, u.swapRouter02);
  if (permitido < cotacao.entradaMaxima) {
    // Aprovação EXATA do máximo desta troca (nunca infinita).
    const txA = await token.approve(u.swapRouter02, cotacao.entradaMaxima, opcoesTx);
    await txA.wait();
  }

  const router = new (e().Contract)(u.swapRouter02, ABI_ROUTER, signer);
  const iface = router.interface;
  let chamadaSwap;
  if (!cotacao.rota.path) {
    chamadaSwap = iface.encodeFunctionData("exactOutputSingle", [{
      tokenIn: cotacao.tokenEntrada,
      tokenOut: u.wpol,
      fee: cotacao.rota.taxas[0],
      recipient: ADDRESS_THIS,
      amountOut: cotacao.quantidadePol,
      amountInMaximum: cotacao.entradaMaxima,
      sqrtPriceLimitX96: 0,
    }]);
  } else {
    chamadaSwap = iface.encodeFunctionData("exactOutput", [{
      path: cotacao.rota.path,
      recipient: ADDRESS_THIS,
      amountOut: cotacao.quantidadePol,
      amountInMaximum: cotacao.entradaMaxima,
    }]);
  }
  const desembrulhar = iface.encodeFunctionData("unwrapWETH9", [cotacao.quantidadePol, dono]);
  const tx = await router.multicall(cotacao.validoAte, [chamadaSwap, desembrulhar], opcoesTx);
  const recibo = await tx.wait();
  registrar({
    hash: recibo.hash,
    token: cotacao.tokenEntrada,
    entradaMaxima: cotacao.entradaMaxima.toString(),
    entradaCotada: cotacao.entradaCotada.toString(),
    pol: cotacao.quantidadePol.toString(),
    rota: cotacao.rota.tipo,
  });
  return recibo;
}

/**
 * Abastecimento automático (se o usuário ativou): escolhe o primeiro token da lista com saldo suficiente.
 * `tokensPreferidos` = [{endereco, simbolo}] na ordem de preferência.
 */
export async function abastecerSeNecessario(provider, signer, chainId, tokensPreferidos, opcoesTx = {}, outras = []) {
  if (!autoAtivo() || !REDES[chainId]?.uniswap) return null;
  const dono = await signer.getAddress();
  const est = await estadoTanque(provider, dono);
  if (!est.precisaAbastecer || !est.podePagarSwap) return null;
  for (const t of tokensPreferidos) {
    try {
      const cot = await cotarAbastecimento(provider, chainId, t.endereco, est.faltam, t, outras);
      const bal = await new (e().Contract)(t.endereco, ABI_ERC20, provider).balanceOf(dono);
      if (bal >= cot.entradaMaxima) {
        const recibo = await abastecer(signer, cot, opcoesTx);
        return { recibo, cotacao: cot, simbolo: t.simbolo };
      }
    } catch {
      /* tenta o próximo token */
    }
  }
  return null;
}
