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
| `CREATOR_TREASURY` (taxa vitalícia 0,1%) | `0x2F8Fe2689411Bb336301AD4f2DC4077D433F43d1` |
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
1. **xBRL** — sem blacklist, sem pausa, sem congelamento, sem proxy/upgrade, sem `burnFrom` administrativo. Só a Reserva emite. `burn` só do próprio saldo. `inicializar` roda uma única vez e depois o token não tem nenhum papel administrativo.
2. **Taxa de 0,1% (10 bps)** para o `CREATOR_TREASURY`, imutável: em transferências entre carteiras comuns (dentro do `_update`), na emissão e no resgate (Reserva) e em cada pagamento do Escrow. Cofre não cobra taxa. Contratos do protocolo são isentos no token para não quebrar contabilidade.
3. **Reserva** — `lastroTotal() >= totalSupply()` sempre (testado por fuzzing + invariantes). Fase 1 (< 1M xBRL): 1:1 estrito. Fase 2 (≥ 1M): spread dinâmico até 0,40% que **fica na reserva** (sobrecolateral), janela de resgate de 20% do supply/24 h. Resgate **nunca** pausável. Dono só pode: propor lastro (ativa após 7 dias, por qualquer pessoa) e pausar a **emissão** de um lastro.
4. **Cofre (ERC-4626)** — rendimento só de receita real (`depositarReceita`), liberada por segundo com teto contínuo de 1.570 bps (= 17% a.a. efetivo). Sem dono, sem taxa, offset de 6 casas contra ataque de inflação.
5. **Escrow** — 4 modalidades (Presencial, Entrega, Remoto, Etapas). Raio GPS 80 m (`RAIO_MAX_MM = 80_000`). Código de entrega: `keccak256(abi.encode(escrow, cliente, codigo))`, 12 caracteres. Revisão 3 dias; disputa sem árbitro: acordo por propostas iguais ou 50/50 após 30 dias. Reputação Nível 0–5 (mesma regra em `EscrowTrabalho.nivel` e `wallet/src/escrow-client.js#calcularNivel` — mudou um, muda o outro).
6. Compilar com **zero warnings** (`deny = "warnings"` + forge-lint). Solidity `^0.8.24`, `evm_version = shanghai`.

## 4. Carteira (PWA) — regras
- Máquina de estados em `wallet/src/app.js` (`TRANSICOES`): telas só mudam por transições declaradas; o "voltar" do aparelho não fura o bloqueio.
- Chave: BIP-39 12 palavras (`m/44'/60'/0'/0/0`), cifrada AES-256-GCM; chave de dados embrulhada por PIN (PBKDF2-SHA256 600k) e opcionalmente WebAuthn **PRF** (sem PRF, sem biometria). Auto-bloqueio 5 min.
- Mover dinheiro = **segurar para confirmar** (1,2 s). Desbloquear = **deslizar + PIN**.
- Check-in: GPS com precisão ≤ 50 m e distância ≤ 80 m.
- Tanque de gás: alvo 3,0 POL, gatilho 1,0 POL, slippage máximo 1%, aprovação exata (nunca infinita).
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
forge build                       # zero warnings obrigatório
forge test                        # 72 testes (unit, fuzz, invariantes, integração, script)
FOUNDRY_PROFILE=ci forge test     # fuzz com 2048 execuções
node script/exportar-abis.cjs     # regenera wallet/src/abis.js depois de mudar contratos

# Deploy (chave importada uma vez: cast wallet import xbrl-deployer --interactive)
forge script script/DeployPolygon.s.sol:DeployPolygon --rpc-url amoy    --account xbrl-deployer --broadcast --verify
forge script script/DeployPolygon.s.sol:DeployPolygon --rpc-url polygon --account xbrl-deployer --broadcast --verify
# variáveis: AMOY_RPC_URL, POLYGON_RPC_URL, POLYGONSCAN_API_KEY

# Teste local completo
anvil &
forge script script/DeployPolygon.s.sol:DeployPolygon --rpc-url http://127.0.0.1:8545 --unlocked --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --broadcast
cd .. && python3 -m http.server 8080   # abrir http://127.0.0.1:8080/wallet/?rede=31337
```
Depois do deploy, commitar `wallet/src/deployments/<chainId>.json` (o CI publica no Pages).

## 7. Antes de publicar
1. `forge build` sem warnings e `forge test` 100% verde.
2. ABIs regeneradas e commitadas.
3. Testar a carteira de ponta a ponta (criar, emitir, enviar, cofre, trabalho com código, bloquear/desbloquear) contra Anvil ou Amoy.
4. Contratos não auditados: não divulgar como "auditado"; manter os avisos de risco da landing.
