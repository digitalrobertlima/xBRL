# CLAUDE.md — Manual técnico fixo do ecossistema xBRL

> Leia inteiro antes de mudar qualquer coisa. Tudo aqui é **invariante**: só muda com decisão explícita do dono (Robert).

## 1. Identidade do projeto
- **Nome:** xBRL — O Real Soberano & Inconfiscável na Rede Polygon.
- **Público:** brasileiro comum, inclusive quem mal usa Pix. Linguagem simples, em português, sem jargão.
- **Site:** https://digitalrobertlima.github.io/xBRL (landing em `/`, carteira em `/wallet/`).
- **Sem servidor 24h.** Tudo é estático (GitHub Pages) + blockchain + RPCs públicos. Não adicionar backend, banco, analytics, CDN externo ou fontes remotas.

## 2. Endereços fixos
| Item | Valor |
|---|---|
| `CREATOR_TREASURY` (taxa 0,1% na emissão/resgate/Escrow; dono da Reserva) | `0x2F8Fe2689411Bb336301AD4f2DC4077D433F43d1` |
| Rede principal | Polygon PoS — chainId **137** |
| Rede de teste | Polygon Amoy — chainId **80002** |
| Lastro BRZ (Polygon, 18 casas) | `0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc` |
| Lastro BRLA (Polygon, 18 casas) | `0xE6A537a407488807F0bbeb0038B79004f19DDDFb` |
| USDC nativo (Polygon) | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| WPOL | `0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270` |
| Uniswap V3 SwapRouter02 / QuoterV2 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` / `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| Salt CREATE2 | `keccak256("xBRL.soberano.v1")` |

Endereços dos contratos do protocolo ficam em `wallet/src/deployments/<chainId>.json`, gerados **só** pelo script de deploy. Nunca escrever endereço de protocolo à mão no código.

## 3. Invariantes dos contratos (não negociáveis)
1. **xBRL** — ERC-20 PADRÃO, **sem taxa na transferência** (decisão do dono, 24/11/2026: compatibilidade total com Uniswap, onde ele quer parear o xBRL). Sem blacklist, sem pausa, sem congelamento, sem proxy/upgrade, sem `burnFrom` administrativo. Só a Reserva emite. `burn` só do próprio saldo. `inicializar(reserva)` roda uma única vez.
2. **Taxa de 0,1% (10 bps)** para o `CREATOR_TREASURY`, imutável, SOMENTE na emissão e no resgate (Reserva) e em cada pagamento do Escrow.
3. **Reserva** — `lastroTotal() >= totalSupply()` sempre (fuzzing + invariantes). **Lista de lastros fixa no construtor** (BRZ, BRLA): não existe função para adicionar lastro. Spread de diversificação até 0,40% (com 2+ lastros e reserva ≥ 10.000) que **fica na reserva** como lastro extra. **Teto diário de emissão por lastro**: máx(50.000, 10% da reserva) a cada 24 h (anti-drenagem se um lastro perder a paridade). Fase 2 (supply ≥ 1M): resgate até 20% do supply/24 h. Resgate **nunca** pausável. Dono (= `CREATOR_TREASURY`) só pode pausar a **emissão** de um lastro. Roteiro: migrar para lastro em cripto supercolateralizada num contrato NOVO (v2), nunca dando poder de mint extra ao v1.
4. **Sem rendimento.** Decisão do dono (24/11/2026): o protocolo não promete nem paga juros/rendimento. Não criar cofre, staking, APY ou qualquer texto de "rende X%".
5. **Escrow** — 4 modalidades (Presencial, Entrega, Remoto, Etapas). **Sem GPS** (falsificável). PRESENCIAL exige **código de chegada** (`hashChegada = keccak256(abi.encode(escrow, cliente, "chegada", codigo))`) deixado no local pelo cliente (palavras + QR). ENTREGA exige **código de entrega** (`hashCodigo = keccak256(abi.encode(escrow, cliente, codigo))`). Códigos: 5 palavras BIP-39 em português (~55 bits), 6 a partir de 1.000 xBRL, normalizadas em minúsculas com um espaço (`wallet/src/palavras-pt.js`). Vaga aberta (exceto Entrega) exige `decidirCandidato` do cliente. Revisão 3 dias; disputa sem árbitro: propostas iguais ou 50/50 após 30 dias.
   **Reputação anti-contas-falsas** (mesma regra em `EscrowTrabalho.nivel` e `escrow-client.js#calcularNivel` — mudou um, muda o outro): nível exige contrapartes distintas, avaliadores distintos (uma nota por par, a última vale), média, taxa de disputa, volume e idade da conta (N2: 5/3/3,5★/20%/500/14d · N3: 15/10/4,0/10%/5k/60d · N4: 40/25/4,5/5%/25k/180d · N5: 80/50/4,8/2%/100k/365d). Avaliação só em trabalhos ≥ 10 xBRL.
6. Compilar com **zero warnings** (`deny = "warnings"` + forge-lint). Solidity `^0.8.24`, `evm_version = shanghai`.

## 4. Carteira (PWA) — regras
- Máquina de estados em `wallet/src/app.js` (`TRANSICOES`): telas só mudam por transições declaradas; o "voltar" do aparelho não fura o bloqueio.
- Chave: BIP-39 12 palavras (`m/44'/60'/0'/0/0`), cifrada AES-256-GCM; chave de dados embrulhada por PIN (PBKDF2-SHA256 600k) e opcionalmente WebAuthn **PRF** (sem PRF, sem biometria). Auto-bloqueio 5 min.
- Mover dinheiro = **segurar para confirmar** (1,2 s). Desbloquear = **deslizar + PIN**.
- Chegada/entrega: código em palavras ou QR (gerado no aparelho com `vendor/qrcode.mjs`, MIT; leitura via `BarcodeDetector`, com digitação como alternativa). Nunca GPS.
- Biometria (WebAuthn PRF) oferecida logo após criar o PIN.
- Tanque de gás: alvo 3,0 POL, gatilho 1,0 POL, slippage máximo 1%, aprovação exata (nunca infinita), teto de preço R$ 5 / US$ 1 por POL contra cotação falsa.
- Aprovações ERC-20 sempre do valor exato. Todo texto vindo da blockchain passa por `esc()`.
- `ethers` v6 é vendorizado em `wallet/src/vendor/` (sem CDN). CSP restritiva no `<meta>`.

## 5. Identidade visual — Esmeralda & Ouro
| Token | Cor |
|---|---|
| Fundo | `#03231A` → `#021912` (gradiente radial com `#0B4A37`) |
| Esmeralda | `#063B2C`, `#0A5A43`, `#10B981`, `#6EE7B7` |
| Ouro | `#B8901F`, `#D4AF37`, `#E9C46A`, `#F5D98B` |
| Texto / mudo | `#ECFDF5` / `#9CC7B6` |
| Alerta / perigo | `#FBBF24` / `#F87171` |
Fonte do sistema (arredondada), botões grandes, mobile-first, ícones emoji, valores sempre em R$ no formato pt-BR.

## 6. Comandos
```bash
cd contracts
forge build                       # zero warnings obrigatório (forge v1.10.0, fixado no CI)
forge test                        # 63 testes (unit, fuzz, invariantes, integração, script)
FOUNDRY_PROFILE=ci forge test     # fuzz com 2048 execuções
node script/exportar-abis.cjs     # regenera wallet/src/abis.js depois de mudar contratos

# Deploy: NÃO rodar à mão. Usar o workflow "Deploy dos contratos (automático)"
# (.github/workflows/deploy-contratos.yml): cria uma chave descartável no runner (não é guardada),
# mostra o endereço, espera saldo de POL, implanta, verifica no Sourcify, grava o JSON na main,
# republica o site e devolve o troco ao CREATOR_TREASURY. A chave não tem poder após o deploy.
# NÃO disparar na Polygon (137) antes da revisão de segurança aprovada pelo dono.
#   gh api repos/digitalrobertlima/xbrl/actions/workflows/deploy-contratos.yml/dispatches -f ref=main -f inputs[rede]=polygon

# Teste local completo
anvil &
forge script script/DeployPolygon.s.sol:DeployPolygon --rpc-url http://127.0.0.1:8545 --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --broadcast
cd .. && python3 -m http.server 8080   # abrir http://127.0.0.1:8080/wallet/?rede=31337
```
O workflow de deploy commita `wallet/src/deployments/<chainId>.json` e dispara o `ci-deploy.yml` (Pages).

## 7. Antes de publicar
1. `forge build` sem warnings e `forge test` 100% verde.
2. ABIs regeneradas e commitadas.
3. Testar a carteira de ponta a ponta (criar, emitir, resgatar, enviar, entrega com código, presencial com código de chegada, vaga aberta com aprovação, avaliação, bloquear/desbloquear) contra Anvil ou Amoy.
4. Contratos não auditados: não divulgar como "auditado"; manter os avisos de risco da landing.
