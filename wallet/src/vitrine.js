// =====================================================================
// BRLS — Vitrine: anúncios públicos e incensuráveis (sem contrato novo)
// Cada anúncio é uma mensagem ABERTA (não cifrada) no Mensageiro, no canal público da vitrine.
// Fica para sempre na blockchain (ninguém apaga nem censura), mas só o AUTOR muda o próprio anúncio:
//   - nova versão com o mesmo id = edição (vale a última);
//   - mensagem de status = pausar, reativar, marcar como vendido ou encerrar.
// O app mostra sempre a última versão publicada pelo próprio autor (o contrato garante quem enviou).
//
// Formato de cada mensagem (Mensageiro.enviar(conversa, para[], itens[], "0x")):
//   itens[0] = "BRLSV1" + JSON (até 4096 bytes)
//   itens[1..5] = pedaços das fotos (JPEG), na ordem; o JSON diz quantos pedaços tem cada foto.
//   JSON: { t: "a" (anúncio) | "l" (perfil da loja) | "s" (status), id, ... }
// Comprar/contratar continua sendo um trabalho do EscrowTrabalho (dinheiro travado + código).
// =====================================================================
import { ABIS } from "./config.js";

const E = () => globalThis.ethers;
const MAGIC = "BRLSV1";
export const MAX_ITEM = 4096;
export const MAX_FOTOS = 3;
const ORCAMENTO_FOTOS = 5 * MAX_ITEM; // 5 itens livres na mensagem

export const CATEGORIAS = [
  { id: "comida", icone: "🍔", nome: "Comida" },
  { id: "mercado", icone: "🛒", nome: "Mercado" },
  { id: "farmacia", icone: "💊", nome: "Farmácia e pet" },
  { id: "servicos", icone: "🧰", nome: "Serviços" },
  { id: "usados", icone: "🚲", nome: "Produtos" },
  { id: "pix", icone: "💱", nome: "Pix ⇄ BRLS" },
];
export const CAT = Object.fromEntries(CATEGORIAS.map((c) => [c.id, c]));
export const STATUS = { ativo: "Ativo", pausado: "Pausado", vendido: "Vendido", encerrado: "Encerrado" };
/** Como o produto chega: o vendedor entrega/retira-se com ele, ou chama um entregador da rede. */
export const ENTREGAS = { combinar: "Retirar ou combinar com o vendedor", propria: "O vendedor entrega", entregador: "Entregador da rede BRLS" };

export const conversaVitrine = () => E().keccak256(E().AbiCoder.defaultAbiCoder().encode(["string"], ["brls-vitrine-v1"]));
export const novoId = () => E().hexlify(E().randomBytes(8)).slice(2);

// ---------- Codificar / ler (sempre desconfiando do que vem da rede) ----------
const txt = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim().slice(0, max);
const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
};
const valorTxt = (v) => (/^\d{1,9}(\.\d{1,2})?$/.test(String(v ?? "")) ? String(v) : null);

/** Limpa um objeto da vitrine (anúncio, loja ou status). Devolve null se for inválido. */
export function limpar(o) {
  if (!o || typeof o !== "object") return null;
  const id = txt(o.id, 32);
  if (!/^[0-9a-z-]{4,32}$/.test(id)) return null;
  if (o.t === "m" && id !== "motorista") return null;
  if (o.t === "s") return STATUS[o.status] ? { t: "s", id, status: o.status } : null;
  if (o.t === "l") {
    return {
      t: "l", id, nome: txt(o.nome, 60), desc: txt(o.desc, 400), horario: txt(o.horario, 80), bairro: txt(o.bairro, 40),
      endereco: txt(o.endereco, 120), lat: num(o.lat, -90, 90), lon: num(o.lon, -180, 180),
      taxa: valorTxt(o.taxa) || "0", entrega: ENTREGAS[o.entrega] ? o.entrega : "propria", status: STATUS[o.status] ? o.status : "ativo",
      fotos: Array.isArray(o.fotos) ? o.fotos.slice(0, MAX_FOTOS).map((n) => num(n, 1, 5) | 0) : [],
    };
  }
  if (o.t === "m") {
    // Perfil público do motorista (como na 99: o passageiro confere carro, cor e placa antes de entrar)
    return {
      t: "m", id: "motorista", apelido: txt(o.apelido, 30), veiculo: ["moto", "pop", "plus"].includes(o.veiculo) ? o.veiculo : "pop",
      modelo: txt(o.modelo, 40), cor: txt(o.cor, 20), placa: txt(o.placa, 10).toUpperCase(), status: STATUS[o.status] ? o.status : "ativo",
      fotos: Array.isArray(o.fotos) ? o.fotos.slice(0, MAX_FOTOS).map((n) => num(n, 1, 5) | 0) : [],
    };
  }
  if (o.t !== "a" || !CAT[o.cat]) return null;
  const a = {
    t: "a", id, cat: o.cat, titulo: txt(o.titulo, 80), desc: txt(o.desc, 900), preco: valorTxt(o.preco), bairro: txt(o.bairro, 40),
    status: STATUS[o.status] ? o.status : "ativo", entrega: ENTREGAS[o.entrega] ? o.entrega : "combinar",
    specs: Array.isArray(o.specs) ? o.specs.slice(0, 14).map((p) => [txt(p?.[0], 30), txt(p?.[1], 80)]).filter((p) => p[0] && p[1]) : [],
    opcoes: Array.isArray(o.opcoes) ? o.opcoes.slice(0, 10).map((p) => ({ nome: txt(p?.nome, 40), extra: valorTxt(p?.extra) || "0" })).filter((p) => p.nome) : [],
    servico: o.servico === "presencial" || o.servico === "remoto" ? o.servico : null,
    fotos: Array.isArray(o.fotos) ? o.fotos.slice(0, MAX_FOTOS).map((n) => num(n, 1, 5) | 0) : [],
  };
  if (!a.titulo) return null;
  if (o.cat === "pix") {
    a.pix = {
      lado: o.pix?.lado === "compro" ? "compro" : "vendo", // vendo BRLS (recebo Pix) | compro BRLS (pago Pix)
      min: valorTxt(o.pix?.min) || "10", max: valorTxt(o.pix?.max) || "500",
      premio: num(o.pix?.premio, 0, 10) ?? 0, // % a favor de quem faz o Pix / entrega os reais
      chave: txt(o.pix?.chave, 80), // chave Pix ALEATÓRIA (pública), só para quem vende BRLS
      banco: txt(o.pix?.banco, 40),
    };
    a.preco = null;
  }
  return a;
}

export function codificar(o) {
  const l = limpar(o);
  if (!l) throw new Error("Anúncio incompleto: confira o título e a categoria.");
  const b = new TextEncoder().encode(MAGIC + JSON.stringify(l));
  if (b.length > MAX_ITEM) throw new Error("Texto grande demais: encurte a descrição ou as especificações.");
  return b;
}

export function decodificar(bytes) {
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(E().getBytes(bytes));
    if (!s.startsWith(MAGIC)) return null;
    return limpar(JSON.parse(s.slice(MAGIC.length)));
  } catch {
    return null;
  }
}

// ---------- Fotos: JPEG pequeno, cortado em pedaços de 4 KB ----------
/** Comprime uma foto do celular para caber em `orcamento` bytes. */
export async function comprimirFoto(arquivo, orcamento) {
  const img = await createImageBitmap(arquivo);
  const tela = document.createElement("canvas");
  let lado = 640;
  for (let tentativa = 0; tentativa < 12; tentativa++) {
    const k = Math.min(1, lado / Math.max(img.width, img.height));
    tela.width = Math.max(1, Math.round(img.width * k));
    tela.height = Math.max(1, Math.round(img.height * k));
    tela.getContext("2d").drawImage(img, 0, 0, tela.width, tela.height);
    for (const q of [0.72, 0.6, 0.5, 0.4]) {
      const blob = await new Promise((r) => tela.toBlob(r, "image/jpeg", q));
      if (blob && blob.size <= orcamento) return new Uint8Array(await blob.arrayBuffer());
    }
    lado = Math.round(lado * 0.8);
  }
  throw new Error("Não deu para diminuir esta foto. Tente outra.");
}

/** Monta os itens da mensagem: [JSON, pedaços das fotos…]. */
export async function montarItens(obj, arquivos = []) {
  const fotos = [];
  const n = Math.min(MAX_FOTOS, arquivos.length);
  for (let i = 0; i < n; i++) fotos.push(await comprimirFoto(arquivos[i], Math.floor(ORCAMENTO_FOTOS / n) - 16));
  const pedacos = [];
  const contagem = [];
  for (const f of fotos) {
    let c = 0;
    for (let i = 0; i < f.length; i += MAX_ITEM) { pedacos.push(f.slice(i, i + MAX_ITEM)); c++; }
    contagem.push(c);
  }
  if (pedacos.length > 5) throw new Error("Fotos grandes demais.");
  return [codificar({ ...obj, fotos: contagem }), ...pedacos];
}

// ---------- Leitura da vitrine (com cache no aparelho) ----------
export class Vitrine {
  constructor(provider, chainId, mensageiro, blocoInicial = 0) {
    this.provider = provider;
    this.endereco = mensageiro;
    this.blocoInicial = Number(blocoInicial) || 0;
    this.iface = new (E().Interface)(ABIS.Mensageiro);
    this.topico = this.iface.getEvent("Mensagem").topicHash;
    this.chaveCache = `xbrl.vitrine.${chainId}.${String(mensageiro).toLowerCase()}`;
    this.fotosMem = new Map(); // tx → [Uint8Array…]
    this.passo = 20_000;
    try {
      const c = JSON.parse(localStorage.getItem(this.chaveCache) || "null");
      this.cache = c && c.v === 1 ? c : { v: 1, ultimoBloco: this.blocoInicial - 1, itens: {} };
    } catch {
      this.cache = { v: 1, ultimoBloco: this.blocoInicial - 1, itens: {} };
    }
  }

  _gravar() {
    try { localStorage.setItem(this.chaveCache, JSON.stringify(this.cache)); } catch { /* cheio: segue só na memória */ }
  }

  /** Aplica uma mensagem da vitrine (na ordem da blockchain). */
  aplicar(de, itens, bloco, tx) {
    const o = decodificar(itens[0]);
    if (!o) return;
    const k = `${de.toLowerCase()}:${o.id}`;
    if (o.t === "s") {
      const atual = this.cache.itens[k];
      if (atual) Object.assign(atual, { status: o.status, atualizado: bloco });
      return;
    }
    const anterior = this.cache.itens[k];
    this.cache.itens[k] = { ...o, de, bloco: anterior?.bloco ?? bloco, atualizado: bloco, tx, chave: k };
    if (itens.length > 1) this.fotosMem.set(tx, itens.slice(1).map((x) => E().getBytes(x)));
  }

  async sincronizar() {
    const atual = await this.provider.getBlockNumber();
    let de = this.cache.ultimoBloco + 1;
    const conversa = conversaVitrine();
    while (de <= atual) {
      const ate = Math.min(atual, de + this.passo - 1);
      let logs;
      try {
        logs = await this.provider.getLogs({ address: this.endereco, topics: [this.topico, conversa], fromBlock: de, toBlock: ate });
      } catch (erro) {
        if (this.passo > 200) { this.passo = Math.floor(this.passo / 4); continue; }
        throw erro;
      }
      for (const log of logs) {
        try {
          const ev = this.iface.parseLog(log);
          this.aplicar(ev.args.de, [...ev.args.cifrados], log.blockNumber, log.transactionHash);
        } catch { /* mensagem estranha: ignora */ }
      }
      this.cache.ultimoBloco = ate;
      de = ate + 1;
    }
    this._gravar();
  }

  /** Anúncios (t: "a"), do mais novo para o mais antigo. */
  anuncios({ cat = null, de = null, todos = false } = {}) {
    return Object.values(this.cache.itens)
      .filter((x) => x.t === "a" && (!cat || x.cat === cat) && (!de || x.de.toLowerCase() === de.toLowerCase()) && (todos || x.status === "ativo"))
      .sort((a, b) => b.atualizado - a.atualizado);
  }

  /** Perfil de loja de uma pessoa (ou null). */
  loja(conta) {
    return this.cache.itens[`${conta.toLowerCase()}:perfil`] || null;
  }

  /** Perfil de motorista de uma pessoa (ou null). */
  motorista(conta) {
    return conta ? this.cache.itens[`${conta.toLowerCase()}:motorista`] || null : null;
  }

  lojas() {
    return Object.values(this.cache.itens).filter((x) => x.t === "l" && x.status === "ativo").sort((a, b) => b.atualizado - a.atualizado);
  }

  item(chave) {
    return this.cache.itens[chave] || null;
  }

  /** Fotos de um item, como URLs para <img>. */
  async fotos(item) {
    if (!item?.fotos?.length) return [];
    let pedacos = this.fotosMem.get(item.tx);
    if (!pedacos) {
      const tx = await this.provider.getTransactionReceipt(item.tx);
      for (const log of tx?.logs || []) {
        if (log.address.toLowerCase() !== this.endereco.toLowerCase() || log.topics[0] !== this.topico) continue;
        const ev = this.iface.parseLog(log);
        const itens = [...ev.args.cifrados];
        const o = decodificar(itens[0]);
        if (o?.id === item.id && ev.args.de.toLowerCase() === item.de.toLowerCase()) {
          pedacos = itens.slice(1).map((x) => E().getBytes(x));
          this.fotosMem.set(item.tx, pedacos);
          break;
        }
      }
    }
    if (!pedacos) return [];
    const urls = [];
    let i = 0;
    for (const n of item.fotos) {
      const partes = pedacos.slice(i, i + n);
      i += n;
      if (partes.length === n) urls.push(URL.createObjectURL(new Blob(partes, { type: "image/jpeg" })));
    }
    return urls;
  }
}

/** Valor "12.50" → texto "12,50". */
export const precoBr = (v) => (v == null ? "" : Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
