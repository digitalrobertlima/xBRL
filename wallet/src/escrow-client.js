// =====================================================================
// xBRL — Cliente do EscrowTrabalho
// Indexa os eventos direto do RPC público (sem servidor, sem The Graph), guarda em cache local,
// e calcula a reputação Nível 0 a 5 com a MESMA regra do contrato (EscrowTrabalho.nivel).
// =====================================================================
import { ABIS, ESCROW } from "./config.js";
import { PALAVRAS } from "./palavras-pt.js";

const e = () => globalThis.ethers;
export const PALAVRAS_CODIGO = 5; // 5 × 11 bits = 55 bits de segredo

// --------------------------- Reputação ---------------------------

/** Replica EscrowTrabalho.nivel(conta). Entrada: {concluidos, disputas, avaliacoes, somaEstrelas}. */
export function calcularNivel(r) {
  const concluidos = Number(r.concluidos);
  const disputas = Number(r.disputas);
  const avaliacoes = Number(r.avaliacoes);
  const soma = Number(r.somaEstrelas);
  if (concluidos === 0) return 0;
  const media100 = avaliacoes === 0 ? 0 : Math.floor((soma * 100) / avaliacoes);
  const disputaBps = Math.floor((disputas * 10_000) / (concluidos + disputas));
  if (concluidos >= 100 && avaliacoes >= 50 && media100 >= 480 && disputaBps <= 200) return 5;
  if (concluidos >= 50 && avaliacoes >= 25 && media100 >= 450 && disputaBps <= 500) return 4;
  if (concluidos >= 20 && avaliacoes >= 10 && media100 >= 400 && disputaBps <= 1_000) return 3;
  if (concluidos >= 5 && avaliacoes >= 3 && media100 >= 350 && disputaBps <= 2_000) return 2;
  return 1;
}

export const NOMES_NIVEL = ["Novo", "Iniciante", "Confiável", "Experiente", "Referência", "Lenda"];

// --------------------------- Geodésia ---------------------------

export const paraMicro = (graus) => Math.round(Number(graus) * 1e6);

/** Mesma aproximação equirretangular do contrato (resultado em metros). */
export function distanciaMetros(lat1, lon1, lat2, lon2) {
  const k = 0.11119508; // metros por microdegrau
  let dLon = lon2 - lon1;
  if (dLon > 180e6) dLon -= 360e6;
  if (dLon < -180e6) dLon += 360e6;
  const c = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180e6);
  const dy = (lat2 - lat1) * k;
  const dx = dLon * k * c;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Lê o GPS com alta precisão. Rejeita leituras imprecisas. */
export function lerGps({ timeout = 20_000 } = {}) {
  return new Promise((ok, erro) => {
    if (!navigator.geolocation) return erro(new Error("Este aparelho não tem GPS disponível"));
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude, precisao: p.coords.accuracy }),
      (x) => erro(new Error(x.code === 1 ? "Permita o acesso à localização" : "Não foi possível ler o GPS")),
      { enableHighAccuracy: true, maximumAge: 0, timeout },
    );
  });
}

// --------------------------- Código de entrega ---------------------------

/** Código de entrega: 5 palavras portuguesas da lista BIP-39 (~55 bits), fáceis de ditar. */
export function gerarCodigoEntrega() {
  const n = new Uint16Array(PALAVRAS_CODIGO);
  crypto.getRandomValues(n);
  return [...n].map((x) => PALAVRAS[x % 2048]).join(" ");
}

/** Aceita maiúsculas, acentos, hífens e espaços extras: "Abacate-BOLSA  canela…" → "abacate bolsa canela…". */
export function normalizarCodigo(c) {
  return String(c || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
}

export function codigoTemFormatoValido(c) {
  const p = normalizarCodigo(c).split(" ");
  return p.length === PALAVRAS_CODIGO && p.every((w) => PALAVRAS.includes(w));
}

/** keccak256(abi.encode(escrow, cliente, codigo)) — igual a EscrowTrabalho.hashCodigo. */
export function hashCodigo(escrow, cliente, codigo) {
  return e().keccak256(e().AbiCoder.defaultAbiCoder().encode(["address", "address", "string"], [escrow, cliente, codigo]));
}

const CODIGOS = "xbrl.codigos";
export function guardarCodigo(hash, codigo) {
  const m = JSON.parse(localStorage.getItem(CODIGOS) || "{}");
  m[hash.toLowerCase()] = codigo;
  localStorage.setItem(CODIGOS, JSON.stringify(m));
}
export function codigoGuardado(hash) {
  const m = JSON.parse(localStorage.getItem(CODIGOS) || "{}");
  return m[String(hash).toLowerCase()] || null;
}

// --------------------------- Indexador ---------------------------

export class EscrowClient {
  constructor(provider, chainId, endereco, blocoInicial = 0) {
    this.provider = provider;
    this.chainId = chainId;
    this.endereco = endereco;
    this.blocoInicial = Number(blocoInicial) || 0;
    this.contrato = new (e().Contract)(endereco, ABIS.EscrowTrabalho, provider);
    this.iface = this.contrato.interface;
    this.chaveCache = `xbrl.escrow.${chainId}.${endereco.toLowerCase()}`;
    this.passo = 5_000;
    this.cache = this._lerCache();
  }

  _lerCache() {
    try {
      const c = JSON.parse(localStorage.getItem(this.chaveCache) || "null");
      if (c && c.v === 2) return c;
    } catch { /* cache corrompido: recomeça */ }
    return { v: 2, ultimoBloco: this.blocoInicial - 1, eventos: [] };
  }

  _gravarCache() {
    try {
      localStorage.setItem(this.chaveCache, JSON.stringify({ ...this.cache, eventos: this.cache.eventos.slice(-5000) }));
    } catch { /* storage cheio: segue só na memória */ }
  }

  /** Busca eventos novos em blocos adaptativos (RPCs públicos limitam o intervalo). */
  async sincronizar(aoProgredir) {
    const atual = await this.provider.getBlockNumber();
    let de = this.cache.ultimoBloco + 1;
    if (de < this.blocoInicial) de = this.blocoInicial;
    while (de <= atual) {
      const ate = Math.min(atual, de + this.passo - 1);
      let logs;
      try {
        logs = await this.provider.getLogs({ address: this.endereco, fromBlock: de, toBlock: ate });
      } catch (erro) {
        if (this.passo > 100) {
          this.passo = Math.floor(this.passo / 2);
          continue;
        }
        throw erro;
      }
      for (const log of logs) {
        let ev;
        try {
          ev = this.iface.parseLog(log);
        } catch {
          continue;
        }
        if (!ev) continue;
        this.cache.eventos.push({
          nome: ev.name,
          bloco: log.blockNumber,
          tx: log.transactionHash,
          args: Object.fromEntries(
            ev.fragment.inputs.map((inp, i) => [inp.name, typeof ev.args[i] === "bigint" ? ev.args[i].toString() : ev.args[i]]),
          ),
        });
      }
      this.cache.ultimoBloco = ate;
      de = ate + 1;
      if (this.passo < 50_000 && logs.length < 500) this.passo = Math.floor(this.passo * 1.5);
      aoProgredir?.({ bloco: ate, atual });
    }
    this._gravarCache();
    return this.cache.eventos.length;
  }

  /** Mapa id → resumo dos trabalhos a partir dos eventos. */
  resumoTrabalhos() {
    const mapa = new Map();
    for (const ev of this.cache.eventos) {
      const id = String(ev.args.id);
      if (ev.nome === "TrabalhoCriado") {
        mapa.set(id, {
          id,
          cliente: ev.args.cliente,
          trabalhador: ev.args.trabalhador,
          modalidade: Number(ev.args.modalidade),
          valor: BigInt(ev.args.valor),
          prazo: Number(ev.args.prazo),
          lat: Number(ev.args.lat),
          lon: Number(ev.args.lon),
          etapas: Number(ev.args.etapas),
          comCodigo: ev.args.comCodigo,
          descricao: String(ev.args.descricao || ""),
          bloco: ev.bloco,
          historico: [],
        });
      }
      const t = mapa.get(id);
      if (!t) continue;
      t.historico.push({ nome: ev.nome, bloco: ev.bloco, tx: ev.tx, args: ev.args });
      if (ev.nome === "TrabalhoAceito") t.trabalhador = ev.args.trabalhador;
    }
    return mapa;
  }

  /** Lê o estado atual on-chain de um trabalho. */
  async detalhe(id) {
    const t = await this.contrato.trabalho(id);
    return {
      id: String(id),
      cliente: t.cliente,
      prazo: Number(t.prazo),
      modalidade: Number(t.modalidade),
      estado: Number(t.estado),
      estadoNome: ESCROW.estados[Number(t.estado)],
      etapas: Number(t.etapas),
      etapasPagas: Number(t.etapasPagas),
      trabalhador: t.trabalhador,
      entregueEm: Number(t.entregueEm),
      checkin: t.checkin,
      clienteAvaliou: t.clienteAvaliou,
      trabalhadorAvaliou: t.trabalhadorAvaliou,
      valor: t.valor,
      pago: t.pago,
      lat: Number(t.lat),
      lon: Number(t.lon),
      disputaEm: Number(t.disputaEm),
      propostaCliente: Number(t.propostaCliente),
      propostaTrabalhador: Number(t.propostaTrabalhador),
      codigoHash: t.codigoHash,
    };
  }

  /** Meus trabalhos (como cliente ou trabalhador) + vagas abertas de outras pessoas. */
  async listar(conta) {
    const eu = conta.toLowerCase();
    const zero = e().ZeroAddress;
    const mapa = this.resumoTrabalhos();
    const meus = [];
    const vagas = [];
    for (const t of mapa.values()) {
      const souCliente = t.cliente.toLowerCase() === eu;
      const souTrab = t.trabalhador && t.trabalhador.toLowerCase() === eu;
      if (souCliente || souTrab) meus.push(t);
      else if (t.trabalhador === zero && !t.historico.some((h) => h.nome !== "TrabalhoCriado")) vagas.push(t);
    }
    meus.sort((a, b) => b.bloco - a.bloco);
    vagas.sort((a, b) => b.bloco - a.bloco);
    return { meus, vagas };
  }

  async reputacao(conta) {
    const r = await this.contrato.reputacao(conta);
    const dados = { concluidos: r[0], disputas: r[1], avaliacoes: r[2], somaEstrelas: r[3] };
    const nivel = calcularNivel(dados);
    const media = Number(dados.avaliacoes) ? Number(dados.somaEstrelas) / Number(dados.avaliacoes) : 0;
    return { ...dados, nivel, nomeNivel: NOMES_NIVEL[nivel], media };
  }

  /** Ações que a conta pode executar agora sobre o trabalho (espelha as regras do contrato). */
  acoesPossiveis(t, conta, agora = Math.floor(Date.now() / 1000)) {
    const eu = conta.toLowerCase();
    const souCliente = t.cliente.toLowerCase() === eu;
    const souTrab = t.trabalhador.toLowerCase() === eu;
    const vaga = t.trabalhador === e().ZeroAddress;
    const presencial = t.modalidade === 0 || t.modalidade === 1;
    const a = [];
    switch (t.estado) {
      case 0: // Aberto
        if (souCliente) a.push("cancelar");
        if (!souCliente && (vaga || souTrab) && agora < t.prazo) a.push("aceitar");
        if (souCliente && agora > t.prazo) a.push("reembolsarPorPrazo");
        break;
      case 1: // Aceito
        if (souTrab && presencial && !t.checkin) a.push("checkIn");
        if (souTrab && t.modalidade !== 1 && (t.modalidade !== 0 || t.checkin)) a.push("marcarEntregue");
        if (t.codigoHash !== e().ZeroHash && (!presencial || t.checkin) && (souTrab || souCliente)) a.push("confirmarComCodigo");
        if (souCliente) a.push("liberar");
        if (souTrab) a.push("desistir");
        if (souCliente || souTrab) a.push("abrirDisputa");
        if (souCliente && agora > t.prazo) a.push("reembolsarPorPrazo");
        break;
      case 2: // Entregue
        if (souCliente) a.push("liberar");
        if (souTrab && agora >= t.entregueEm + ESCROW.prazoRevisaoDias * 86400) a.push("reivindicar");
        if (t.codigoHash !== e().ZeroHash && (souTrab || souCliente)) a.push("confirmarComCodigo");
        if (souCliente || souTrab) a.push("abrirDisputa");
        break;
      case 3: // Disputa
        if (souCliente || souTrab) a.push("proporAcordo");
        if (agora >= t.disputaEm + ESCROW.prazoDisputaDias * 86400) a.push("resolverPorTempo");
        break;
      case 4: // Concluído
        if (souCliente && !t.clienteAvaliou) a.push("avaliar");
        if (souTrab && !t.trabalhadorAvaliou) a.push("avaliar");
        break;
      default:
        break;
    }
    return a;
  }
}
