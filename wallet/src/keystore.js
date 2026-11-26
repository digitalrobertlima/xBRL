// =====================================================================
// xBRL — Cofre de chaves local (autocustódia)
// - Frase de recuperação BIP-39 de 12 ou 24 palavras, em inglês (padrão MetaMask/Rabby) ou em português
//   (lista oficial BIP-39, a mesma da Caixa Forte). Caminho m/44'/60'/0'/0/0. O idioma é descoberto
//   pelas próprias palavras: nenhuma palavra existe nas duas listas.
// - A frase é cifrada com AES-256-GCM por uma CHAVE DE DADOS aleatória.
// - A chave de dados é "embrulhada" (AES-256-GCM) por:
//     a) PIN de 6 dígitos → PBKDF2-SHA256 (600.000 iterações, sal aleatório);
//     b) opcional: biometria/chave de acesso WebAuthn com extensão PRF (segredo nunca sai do chip).
// - Nada sai do aparelho. Sem servidor. Sem cópia em nuvem.
// =====================================================================
import { SEGURANCA } from "./config.js";
import { PALAVRAS } from "./palavras-pt.js";

const CHAVE_STORAGE = "xbrl.cofre.v1";
const CAMINHO = "m/44'/60'/0'/0/0";
const te = new TextEncoder();
const td = new TextDecoder();

const ethers = () => globalThis.ethers;
const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
const deB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const aleatorio = (n) => crypto.getRandomValues(new Uint8Array(n));

// --------------------------- Frase BIP-39 ---------------------------

export const QUANTIDADES = [12, 15, 18, 21, 24];
const INDICE_PT = new Map(PALAVRAS.map((w, i) => [w, i]));
let listaPt = null;
function portugues() {
  if (listaPt) return listaPt;
  class Portugues extends ethers().Wordlist {
    constructor() { super("pt"); }
    getWord(i) { return PALAVRAS[i]; }
    getWordIndex(w) { const v = INDICE_PT.get(String(w)); return v === undefined ? -1 : v; }
  }
  return (listaPt = new Portugues());
}
const lista = (idioma) => (idioma === "pt" ? portugues() : ethers().wordlists.en);

/** Minúsculas, sem acentos (as listas oficiais não têm acento), um espaço entre as palavras. */
export function normalizarFrase(frase) {
  return String(frase || "").trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/\s+/).filter(Boolean).join(" ");
}

/** "pt", "en" ou null (palavras misturadas ou fora das listas). */
export function idiomaDaFrase(frase) {
  const ws = normalizarFrase(frase).split(" ").filter(Boolean);
  if (!ws.length) return null;
  if (ws.every((w) => INDICE_PT.has(w))) return "pt";
  const en = ethers().wordlists.en;
  if (ws.every((w) => en.getWordIndex(w) >= 0)) return "en";
  return null;
}

/** Nova frase: 12 palavras (128 bits) ou 24 (256 bits), em inglês ou português. */
export function gerarFrase(quantas = 12, idioma = "en") {
  const bytes = quantas === 24 ? 32 : 16;
  return ethers().Mnemonic.fromEntropy(aleatorio(bytes), undefined, lista(idioma)).phrase;
}

export function fraseValida(frase) {
  const f = normalizarFrase(frase);
  const idioma = idiomaDaFrase(f);
  if (!idioma || !QUANTIDADES.includes(f.split(" ").length)) return false;
  return ethers().Mnemonic.isValidMnemonic(f, lista(idioma));
}

/** Por que a frase não serve (para a pessoa corrigir), ou "" se serve. */
export function problemaDaFrase(frase) {
  const f = normalizarFrase(frase);
  const ws = f ? f.split(" ") : [];
  if (!ws.length) return "Digite as palavras.";
  if (!QUANTIDADES.includes(ws.length)) return `São ${ws.length} palavras. A frase tem 12 ou 24 (às vezes 15, 18 ou 21).`;
  const en = ethers().wordlists.en;
  const estranhas = ws.filter((w) => !INDICE_PT.has(w) && en.getWordIndex(w) < 0);
  if (estranhas.length) return `Palavra que não existe na lista: "${estranhas.slice(0, 3).join('", "')}". Confira a grafia.`;
  if (!idiomaDaFrase(f)) return "Tem palavras em português e em inglês misturadas. A frase é toda numa língua só.";
  if (!fraseValida(f)) return "As palavras existem, mas a ordem ou alguma palavra não confere (o código de conferência da frase falhou).";
  return "";
}

export function carteiraDaFrase(frase) {
  const f = normalizarFrase(frase);
  return ethers().HDNodeWallet.fromPhrase(f, undefined, CAMINHO, lista(idiomaDaFrase(f) || "en"));
}

// --------------------------- Cripto base ---------------------------

async function chaveDoPin(pin, sal, iteracoes) {
  const base = await crypto.subtle.importKey("raw", te.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: sal, iterations: iteracoes },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function chaveDoSegredo(segredo, info) {
  const base = await crypto.subtle.importKey("raw", segredo, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: te.encode("xBRL.webauthn.prf.v1"), info: te.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function cifrar(chave, dados, aad) {
  const iv = aleatorio(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, chave, dados);
  return { iv: b64(iv), ct: b64(ct) };
}

async function decifrar(chave, caixa, aad) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: deB64(caixa.iv), additionalData: te.encode(aad) },
    chave,
    deB64(caixa.ct),
  );
  return new Uint8Array(pt);
}

async function importarChaveDados(bruta) {
  return crypto.subtle.importKey("raw", bruta, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// --------------------------- Persistência ---------------------------

function ler() {
  try {
    const j = JSON.parse(localStorage.getItem(CHAVE_STORAGE) || "null");
    return j && j.v === 1 ? j : null;
  } catch {
    return null;
  }
}

function gravar(c) {
  localStorage.setItem(CHAVE_STORAGE, JSON.stringify(c));
}

export function existeCofre() {
  return ler() !== null;
}

export function enderecoSalvo() {
  return ler()?.endereco ?? null;
}

export function temBiometria() {
  return !!ler()?.webauthn;
}

export function apagarCofre() {
  localStorage.removeItem(CHAVE_STORAGE);
}

export function pinValido(pin) {
  return new RegExp(`^\\d{${SEGURANCA.pinDigitos}}$`).test(String(pin)) && !/^(\d)\1+$/.test(String(pin)) &&
    !["123456", "654321", "012345", "123123"].includes(String(pin));
}

/** Cria o cofre cifrado. Retorna o endereço. */
export async function criarCofre(frase, pin) {
  if (!fraseValida(frase)) throw new Error("Frase inválida");
  if (!pinValido(pin)) throw new Error("PIN fraco ou inválido");
  const f = normalizarFrase(frase);
  const endereco = carteiraDaFrase(f).address;
  const bruta = aleatorio(32);
  const chaveDados = await importarChaveDados(bruta);
  const cifra = await cifrar(chaveDados, te.encode(f), endereco);
  const sal = aleatorio(16);
  const kPin = await chaveDoPin(String(pin), sal, SEGURANCA.pbkdf2Iteracoes);
  const pinCaixa = await cifrar(kPin, bruta, "pin:" + endereco);
  bruta.fill(0);
  gravar({
    v: 1,
    endereco,
    criadoEm: Date.now(),
    cifra,
    pin: { sal: b64(sal), iteracoes: SEGURANCA.pbkdf2Iteracoes, ...pinCaixa },
    webauthn: null,
    falhas: 0,
    esperaAte: 0,
  });
  return endereco;
}

/** Segundos restantes de espera após PINs errados (0 = liberado). */
export function esperaRestante() {
  const c = ler();
  if (!c) return 0;
  return Math.max(0, Math.ceil((c.esperaAte - Date.now()) / 1000));
}

async function abrirComChave(c, kEmbrulho, aadEmbrulho, caixa) {
  const bruta = await decifrar(kEmbrulho, caixa, aadEmbrulho);
  const chaveDados = await importarChaveDados(bruta);
  bruta.fill(0);
  const frase = td.decode(await decifrar(chaveDados, c.cifra, c.endereco));
  return { frase, chaveDados };
}

/** Abre o cofre com o PIN. Retorna a frase (fica só na memória da sessão). */
export async function abrirComPin(pin) {
  const c = ler();
  if (!c) throw new Error("Nenhuma carteira neste aparelho");
  const espera = esperaRestante();
  if (espera > 0) throw new Error(`Aguarde ${espera}s para tentar de novo`);
  try {
    const k = await chaveDoPin(String(pin), deB64(c.pin.sal), c.pin.iteracoes);
    const { frase } = await abrirComChave(c, k, "pin:" + c.endereco, c.pin);
    c.falhas = 0;
    c.esperaAte = 0;
    gravar(c);
    return frase;
  } catch {
    c.falhas = (c.falhas || 0) + 1;
    const excesso = c.falhas - SEGURANCA.tentativasAntesDeEspera;
    if (excesso >= 0) c.esperaAte = Date.now() + Math.min(3600, 15 * 2 ** excesso) * 1000;
    gravar(c);
    throw new Error("PIN incorreto");
  }
}

/** Troca o PIN (exige o PIN atual). */
export async function trocarPin(pinAtual, pinNovo) {
  if (!pinValido(pinNovo)) throw new Error("PIN novo fraco ou inválido");
  const frase = await abrirComPin(pinAtual);
  const c = ler();
  const bio = c.webauthn;
  await criarCofre(frase, pinNovo);
  if (bio) {
    const n = ler();
    n.webauthn = null; // a chave de dados mudou: biometria precisa ser reativada
    gravar(n);
  }
  return true;
}

// --------------------------- WebAuthn PRF (biometria) ---------------------------

export async function biometriaDisponivel() {
  try {
    if (!window.PublicKeyCredential || !navigator.credentials) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Ativa a biometria. Só ativa se o aparelho suportar PRF (segredo derivado no hardware). */
export async function ativarBiometria(pin) {
  const c = ler();
  if (!c) throw new Error("Nenhuma carteira");
  const k = await chaveDoPin(String(pin), deB64(c.pin.sal), c.pin.iteracoes);
  const bruta = await decifrar(k, c.pin, "pin:" + c.endereco);
  const prfSal = aleatorio(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: "xBRL Carteira", id: location.hostname },
      user: { id: aleatorio(16), name: c.endereco.slice(0, 10), displayName: "Carteira xBRL" },
      challenge: aleatorio(32),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSal } } },
    },
  });
  const ext = cred.getClientExtensionResults?.() || {};
  if (!ext.prf?.enabled) {
    bruta.fill(0);
    throw new Error("Este aparelho não suporta biometria com chave segura (PRF). Continue usando o PIN.");
  }
  let segredo = ext.prf.results?.first;
  if (!segredo) segredo = await segredoPrf(cred.rawId, prfSal);
  const kBio = await chaveDoSegredo(new Uint8Array(segredo), c.endereco);
  const caixa = await cifrar(kBio, bruta, "bio:" + c.endereco);
  bruta.fill(0);
  c.webauthn = { credId: b64(cred.rawId), prfSal: b64(prfSal), ...caixa };
  gravar(c);
  return true;
}

async function segredoPrf(rawId, prfSal) {
  const a = await navigator.credentials.get({
    publicKey: {
      challenge: aleatorio(32),
      allowCredentials: [{ type: "public-key", id: rawId }],
      userVerification: "required",
      timeout: 60_000,
      extensions: { prf: { eval: { first: prfSal } } },
    },
  });
  const r = a.getClientExtensionResults?.().prf?.results?.first;
  if (!r) throw new Error("Biometria não retornou o segredo PRF");
  return r;
}

export async function abrirComBiometria() {
  const c = ler();
  if (!c?.webauthn) throw new Error("Biometria não ativada");
  const segredo = await segredoPrf(deB64(c.webauthn.credId), deB64(c.webauthn.prfSal));
  const k = await chaveDoSegredo(new Uint8Array(segredo), c.endereco);
  const { frase } = await abrirComChave(c, k, "bio:" + c.endereco, c.webauthn);
  return frase;
}

export function desativarBiometria() {
  const c = ler();
  if (c) {
    c.webauthn = null;
    gravar(c);
  }
}
