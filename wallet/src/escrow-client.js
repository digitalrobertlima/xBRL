// =====================================================================
// xBRL — Cliente do EscrowTrabalho
// Indexa os eventos direto do RPC público (sem servidor, sem The Graph), guarda em cache local,
// e calcula a reputação Nível 0 a 5 com a MESMA regra do contrato (EscrowTrabalho.nivel).
// =====================================================================
import { ABIS, CREATOR_TREASURY, ESCROW } from "./config.js";
import { PALAVRAS } from "./palavras-pt.js";

const e = () => globalThis.ethers;
export const PALAVRAS_CODIGO = 5; // 5 × 11 bits = 55 bits de segredo
export const PALAVRAS_CODIGO_ALTO_VALOR = 6; // 66 bits — a partir de 1.000 BRLS

// --------------------------- Reputação ---------------------------

const DIA = 86_400;
const E18 = 10n ** 18n;
/** Requisitos por nível (iguais a EscrowTrabalho.nivel): contrapartes, avaliadores, média×100, disputa máx (bps),
 * volume mínimo (BRLS) e idade mínima (dias). */
export const REGRAS_NIVEL = [
  null,
  null,
  { contrapartes: 5, avaliacoes: 3, media: 350, disputa: 2_000, volume: 500n, idade: 14 },
  { contrapartes: 15, avaliacoes: 10, media: 400, disputa: 1_000, volume: 5_000n, idade: 60 },
  { contrapartes: 40, avaliacoes: 25, media: 450, disputa: 500, volume: 25_000n, idade: 180 },
  { contrapartes: 80, avaliacoes: 50, media: 480, disputa: 200, volume: 100_000n, idade: 365 },
];

/** Replica EscrowTrabalho.nivel(conta). */
export function calcularNivel(r, agora = Math.floor(Date.now() / 1000)) {
  const concluidos = Number(r.concluidos);
  if (concluidos === 0) return 0;
  const disputas = Number(r.disputas);
  const avaliacoes = Number(r.avaliacoes);
  const media100 = avaliacoes === 0 ? 0 : Math.floor((Number(r.somaEstrelas) * 100) / avaliacoes);
  const disputaBps = Math.floor((disputas * 10_000) / (concluidos + disputas));
  const idade = agora - Number(r.desde);
  const volume = BigInt(r.volume);
  for (let n = 5; n >= 2; n--) {
    const q = REGRAS_NIVEL[n];
    if (Number(r.contrapartes) >= q.contrapartes && avaliacoes >= q.avaliacoes && media100 >= q.media &&
      disputaBps <= q.disputa && volume >= q.volume * E18 && idade >= q.idade * DIA) return n;
  }
  return 1;
}

export const NOMES_NIVEL = ["Novo", "Iniciante", "Confiável", "Experiente", "Referência", "Lenda"];

// --------------------------- Código de entrega ---------------------------

/** Código de entrega: palavras portuguesas da lista BIP-39 (11 bits cada), fáceis de ditar.
 * 5 palavras (~55 bits) por padrão; 6 (~66 bits) para valores altos, já que o hash fica público. */
export function gerarCodigoEntrega(qtd = PALAVRAS_CODIGO) {
  const n = new Uint16Array(qtd);
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
  return (p.length === PALAVRAS_CODIGO || p.length === PALAVRAS_CODIGO_ALTO_VALOR) && p.every((w) => PALAVRAS.includes(w));
}

/** keccak256(abi.encode(escrow, cliente, "chegada", codigo)) — igual a EscrowTrabalho.hashChegada. */
export function hashChegada(escrow, cliente, codigo) {
  return e().keccak256(e().AbiCoder.defaultAbiCoder().encode(["address", "address", "string", "string"], [escrow, cliente, "chegada", codigo]));
}

/** keccak256(abi.encode(escrow, cliente, codigo)) — igual a EscrowTrabalho.hashCodigo. */
export function hashCodigo(escrow, cliente, codigo) {
  return e().keccak256(e().AbiCoder.defaultAbiCoder().encode(["address", "address", "string"], [escrow, cliente, codigo]));
}

/** keccak256(abi.encode(escrow, cliente, "devolucao", codigo)) — igual a EscrowTrabalho.hashDevolucao. */
export function hashDevolucao(escrow, cliente, codigo) {
  return e().keccak256(e().AbiCoder.defaultAbiCoder().encode(["address", "address", "string", "string"], [escrow, cliente, "devolucao", codigo]));
}

/** Id da conversa de um trabalho no Mensageiro: keccak256(abi.encode("trabalho", escrow, id)). */
export function idConversa(escrow, id) {
  return e().keccak256(e().AbiCoder.defaultAbiCoder().encode(["string", "address", "uint256"], ["trabalho", escrow, BigInt(id)]));
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
      if (c && c.v === 3) return c;
    } catch { /* cache corrompido: recomeça */ }
    return { v: 3, ultimoBloco: this.blocoInicial - 1, eventos: [] };
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
          etapas: Number(ev.args.etapas),
          comCodigo: ev.args.comCodigo,
          comChegada: ev.args.comChegada,
          descricao: String(ev.args.descricao || ""),
          bloco: ev.bloco,
          historico: [],
          candidato: null,
          arbitros: [],
          caucao: 0n,
          txCriacao: ev.tx,
          txAceite: null,
          estado: 0, // estado deduzido dos eventos (para a barra de fases sem ler o contrato de novo)
          chegou: false,
          etapasPagas: 0,
          pendenteAprovacao: false,
        });
      }
      const t = mapa.get(id);
      if (!t) continue;
      t.historico.push({ nome: ev.nome, bloco: ev.bloco, tx: ev.tx, args: ev.args });
      if (ev.nome === "TrabalhoAceito") {
        t.trabalhador = ev.args.trabalhador;
        t.candidato = null;
        t.txAceite ||= ev.tx;
        t.pendenteAprovacao = false;
        if (t.estado < 1) t.estado = 1;
      }
      if (ev.nome === "ChegadaConfirmada" || ev.nome === "ChegadaConfirmadaPeloCliente") t.chegou = true;
      if (ev.nome === "EntregaMarcada" && t.estado < 2) t.estado = 2;
      if (ev.nome === "Pagamento") t.etapasPagas += 1;
      if (ev.nome === "DisputaAberta") t.estado = 3;
      if (ev.nome === "TrabalhoConfigurado") {
        if (ev.args.arbitroCliente !== e().ZeroAddress) t.arbitros = [ev.args.arbitroCliente];
        t.caucao = BigInt(ev.args.caucao);
        t.desempateCriador = ev.args.desempateCriador;
      }
      if (ev.nome === "ArbitroDoTrabalhador") t.arbitros = [t.arbitros[0], ev.args.arbitro].filter(Boolean);
      if (ev.nome === "CandidaturaRecebida") {
        t.candidato = ev.args.candidato;
        t.txAceite = ev.tx;
        t.pendenteAprovacao = true;
      }
      if (ev.nome === "CandidaturaEncerrada") { t.candidato = null; t.pendenteAprovacao = false; }
      // Terminou (vai para "Arquivados"): cancelado/reembolsado, pago ao trabalhador ou disputa resolvida
      if (ev.nome === "TrabalhoCancelado") Object.assign(t, { encerrado: true, fim: "cancelado", estado: 5 });
      if (ev.nome === "TrabalhoConcluido") Object.assign(t, { encerrado: true, fim: "concluido", estado: 4 });
      if (ev.nome === "DisputaResolvida") Object.assign(t, { encerrado: true, fim: "resolvido", estado: 4 });
      if (ev.nome === "Avaliacao") (t.avaliadores ||= []).push(String(ev.args.avaliador).toLowerCase());
    }
    return mapa;
  }

  /** Lê o estado atual on-chain de um trabalho. */
  async detalhe(id) {
    const [t, a, c, kit] = await Promise.all([this.contrato.trabalho(id), this.contrato.arbitragem(id), this.contrato.caucao(id), this.contrato.kitGas(id).catch(() => 0n)]);
    return {
      kitGas: kit,
      arbitroCliente: a.arbitroCliente,
      arbitroTrabalhador: a.arbitroTrabalhador,
      propostaArbCliente: Number(a.propostaArbCliente),
      propostaArbTrabalhador: Number(a.propostaArbTrabalhador),
      propostasEm: Number(a.propostasEm),
      desempateCriador: a.desempateCriador,
      caucao: c.valor,
      caucaoTravada: c.travada,
      devolucaoHash: c.devolucaoHash,
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
      chegou: t.chegou,
      clienteAvaliou: t.clienteAvaliou,
      trabalhadorAvaliou: t.trabalhadorAvaliou,
      pendenteAprovacao: t.pendenteAprovacao,
      valor: t.valor,
      pago: t.pago,
      disputaEm: Number(t.disputaEm),
      propostaCliente: Number(t.propostaCliente),
      propostaTrabalhador: Number(t.propostaTrabalhador),
      codigoHash: t.codigoHash,
      chegadaHash: t.chegadaHash,
    };
  }

  /** Meus trabalhos (como cliente ou trabalhador) + vagas abertas de outras pessoas. */
  async listar(conta) {
    const eu = conta.toLowerCase();
    const zero = e().ZeroAddress;
    const mapa = this.resumoTrabalhos();
    const meus = [];
    const arquivados = [];
    const vagas = [];
    const arbitragens = [];
    const souCriador = eu === CREATOR_TREASURY.toLowerCase();
    for (const t of mapa.values()) {
      const souCliente = t.cliente.toLowerCase() === eu;
      // Sem carteira (conta = 0x000…): a vaga aberta tem trabalhador = 0x000…, e isso NÃO é "sou o trabalhador"
      const souTrab = eu !== zero.toLowerCase() && ((t.trabalhador && t.trabalhador.toLowerCase() === eu) || (t.candidato && t.candidato.toLowerCase() === eu));
      const souArbitro = t.arbitros.some((x) => x.toLowerCase() === eu) || (souCriador && t.desempateCriador);
      const aberta = t.trabalhador === zero && !t.candidato && !t.encerrado && t.prazo > Math.floor(Date.now() / 1000);
      // Concluído ainda sem a sua avaliação (≥ 10 BRLS) continua na lista até você avaliar
      const falta = t.fim === "concluido" && BigInt(t.valor || 0) >= 10n ** 19n && !(t.avaliadores || []).includes(eu);
      if (falta) t.avaliar = true;
      if ((souCliente && eu !== zero.toLowerCase()) || souTrab) (t.encerrado && !falta ? arquivados : meus).push(t);
      else if (souArbitro) arbitragens.push(t);
      else if (aberta) vagas.push(t);
    }
    const ord = (a, b) => b.bloco - a.bloco;
    meus.sort(ord);
    arquivados.sort(ord);
    vagas.sort(ord);
    arbitragens.sort(ord);
    return { meus, vagas, arbitragens, arquivados };
  }

  async reputacao(conta) {
    const r = await this.contrato.reputacao(conta);
    const dados = { concluidos: r[0], disputas: r[1], avaliacoes: r[2], contrapartes: r[3], somaEstrelas: r[4], desde: r[5], volume: r[6] };
    const nivel = calcularNivel(dados);
    const media = Number(dados.avaliacoes) ? Number(dados.somaEstrelas) / Number(dados.avaliacoes) : 0;
    const idadeDias = Number(dados.desde) ? Math.floor((Date.now() / 1000 - Number(dados.desde)) / 86_400) : 0;
    return { ...dados, nivel, nomeNivel: NOMES_NIVEL[nivel], media, idadeDias };
  }

  /** Ações que a conta pode executar agora sobre o trabalho (espelha as regras do contrato). */
  acoesPossiveis(t, conta, agora = Math.floor(Date.now() / 1000)) {
    const z = e().ZeroAddress;
    const eu = conta.toLowerCase();
    const souCliente = t.cliente.toLowerCase() === eu;
    const souTrab = t.trabalhador.toLowerCase() === eu;
    const souArbC = t.arbitroCliente && t.arbitroCliente !== z && t.arbitroCliente.toLowerCase() === eu;
    const souArbT = t.arbitroTrabalhador && t.arbitroTrabalhador !== z && t.arbitroTrabalhador.toLowerCase() === eu;
    const souCriador = eu === CREATOR_TREASURY.toLowerCase();
    const vaga = t.trabalhador === z;
    const presencial = t.modalidade === 0;
    const entrega = t.modalidade === 1;
    const temCodigo = t.codigoHash !== e().ZeroHash;
    const a = [];
    switch (t.estado) {
      case 0: // Aberto
        if (souCliente) a.push("cancelar");
        if (t.pendenteAprovacao) {
          if (souCliente) a.push("aprovarCandidato", "recusarCandidato");
          if (souTrab) a.push("retirarCandidatura");
          break;
        }
        if (!souCliente && (vaga || souTrab) && agora < t.prazo) a.push("aceitar");
        if (souCliente && agora > t.prazo) a.push("reembolsarPorPrazo");
        break;
      case 1: // Aceito
        if (souTrab && presencial && !t.chegou) a.push("confirmarChegada");
        if (souCliente && presencial && !t.chegou) a.push("chegadaPeloCliente");
        if (souTrab && !entrega && (!presencial || t.chegou)) a.push("marcarEntregue");
        if (temCodigo && (!presencial || t.chegou) && (souTrab || souCliente)) a.push("confirmarComCodigo");
        if (t.caucaoTravada && (souTrab || souCliente)) a.push("confirmarDevolucao");
        if (souCliente) a.push("liberar");
        if (souTrab && !t.caucaoTravada) a.push("desistir");
        if ((souCliente || souTrab) && !entrega) a.push("abrirDisputa");
        if (souCliente && agora > t.prazo) a.push("reembolsarPorPrazo");
        break;
      case 2: // Entregue
        if (souCliente) a.push("liberar");
        if (souTrab && agora >= t.entregueEm + ESCROW.prazoRevisaoDias * 86400) a.push("reivindicar");
        if (temCodigo && (souTrab || souCliente)) a.push("confirmarComCodigo");
        if ((souCliente || souTrab) && !entrega) a.push("abrirDisputa");
        break;
      case 3: { // Disputa
        if (souCliente || souTrab) a.push("proporAcordo");
        if (souArbC || souArbT) a.push("arbitrar");
        if (souCriador && t.desempateCriador) {
          const prazo = ESCROW.prazoArbitrosDias * 86400;
          const comArbitros = t.arbitroCliente !== z;
          const pronto = comArbitros
            ? t.propostaArbCliente && t.propostaArbTrabalhador && agora >= t.propostasEm + prazo
            : agora >= t.disputaEm + prazo;
          if (pronto) a.push("desempatar");
        }
        if (agora >= t.disputaEm + ESCROW.prazoDisputaDias * 86400) a.push("resolverPorTempo");
        break;
      }
      case 4: // Concluído
        if (BigInt(t.valor) >= BigInt(ESCROW.valorMinimoAvaliacao) * 10n ** 18n) {
          if (souCliente && !t.clienteAvaliou) a.push("avaliar");
          if (souTrab && !t.trabalhadorAvaliou) a.push("avaliar");
        }
        break;
      default:
        break;
    }
    return a;
  }
}
