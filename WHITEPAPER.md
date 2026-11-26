# BRLS — Real Soberano

**White paper · versão 1.0 (beta) · novembro de 2026**

> **Aviso.** Os contratos do BRLS **não foram auditados** por empresa independente. O projeto está em
> **beta**: use valores pequenos. Este documento descreve o funcionamento técnico e econômico; não é
> oferta de investimento, não promete rendimento e não é aconselhamento jurídico ou financeiro.

---

## Sumário

1. [Resumo](#1-resumo)
2. [O problema](#2-o-problema)
3. [Princípios](#3-princípios)
4. [Visão geral do sistema](#4-visão-geral-do-sistema)
5. [O token BRLS](#5-o-token-brls)
6. [Reserva: BRLS lastreado em reais digitais](#6-reserva-brls-lastreado-em-reais-digitais)
7. [CofreCripto: BRLS contra garantia em cripto](#7-cofrecripto-brls-contra-garantia-em-cripto)
8. [Taxas e colchão](#8-taxas-e-colchão)
9. [Escrow de trabalho: pagamento garantido por contrato](#9-escrow-de-trabalho-pagamento-garantido-por-contrato)
10. [Uso sem POL (sem gás)](#10-uso-sem-pol-sem-gás)
11. [Mensageiro: conversa cifrada](#11-mensageiro-conversa-cifrada)
12. [Aplicações construídas sobre o protocolo](#12-aplicações-construídas-sobre-o-protocolo)
13. [A carteira](#13-a-carteira)
14. [Privacidade](#14-privacidade)
15. [Segurança e invariantes](#15-segurança-e-invariantes)
16. [Riscos](#16-riscos)
17. [Endereços oficiais (Polygon)](#17-endereços-oficiais-polygon)
18. [Roteiro](#18-roteiro)
19. [Glossário](#19-glossário)

---

## 1. Resumo

O **BRLS (Real Soberano)** é um real digital 1:1 na rede **Polygon**. Cada BRLS é emitido por um de dois
contratos, e somente por eles:

- a **Reserva**, contra reais digitais já existentes (BRZ, BRLA e BRL1), na proporção 1:1;
- o **CofreCripto**, contra garantia em cripto (WETH ou WPOL) depositada com folga (sobrecolateralização).

O token não tem dono, pausa, lista negra, congelamento nem atualização: ninguém, nem o criador, consegue
travar ou tomar o BRLS de alguém. Sobre o token roda um **escrow de trabalho**: o dinheiro de um serviço,
produto, corrida ou entrega fica travado no contrato e só sai para quem trabalhou quando o cliente entrega um
código (ou quando a regra de prazo, acordo ou arbitragem decide). Tudo funciona sem servidor próprio: o
site é estático, as regras estão na blockchain e as mensagens entre as partes são cifradas de ponta a ponta.

## 2. O problema

- **Taxas altas nas plataformas.** Apps de entrega e de corrida ficam com uma parte relevante de cada
  pedido. Quem trabalha e quem vende pagam essa conta.
- **Confiança entre desconhecidos.** Sem um intermediário, quem paga antes corre o risco de não receber, e
  quem entrega antes corre o risco de não ser pago.
- **Dinheiro que pode ser travado.** Contas e saldos em plataformas podem ser bloqueados por decisão de
  terceiros.
- **Dependência de servidores.** Um serviço que depende de um servidor central para de funcionar quando o
  servidor cai ou é desligado.

## 3. Princípios

1. **Autocustódia.** A chave fica no aparelho da pessoa; o protocolo nunca guarda o dinheiro de ninguém fora
   de contratos com regras públicas.
2. **Regras imutáveis.** Taxas, limites e emissores são fixados na implantação. Não há função para mudá-los.
3. **Sem rendimento.** O protocolo não promete nem paga juros. O BRLS é meio de pagamento, não investimento.
4. **Sem servidor próprio.** Site estático (GitHub Pages), blockchain e serviços públicos substituíveis.
5. **Linguagem simples.** Feito para quem mal usa Pix.

## 4. Visão geral do sistema

```
              ┌──────────────┐   BRZ/BRLA/BRL1 1:1   ┌────────────┐
  pessoa ───► │   Reserva    │ ────── emite ───────► │            │
              └──────────────┘                       │    BRLS    │ ◄── transferência livre (taxa zero)
              ┌──────────────┐   WETH/WPOL (folga)   │  (ERC-20)  │
  pessoa ───► │ CofreCripto  │ ────── emite ───────► │            │
              └──────────────┘                       └─────┬──────┘
                                                           │ trava / libera
                                                    ┌──────▼───────┐   código, prazo,
                                                    │EscrowTrabalho│   acordo, árbitros
                                                    └──────┬───────┘
                         ┌──────────────┐                  │ autoria via _msgSender()
  quem está sem POL ───► │ Encaminhador │ ─────────────────┤ (ERC-2771)
                         └──────────────┘                  │
                                                    ┌──────▼───────┐
                                                    │  Mensageiro  │  conversa cifrada e
                                                    └──────────────┘  vitrine pública
```

Seis contratos em Solidity `^0.8.24`, compilados sem nenhum aviso (`evm_version = shanghai`), com testes
unitários, de fuzzing, de invariantes do sistema inteiro e de queda brusca do preço do ETH (40% e 57%).

## 5. O token BRLS

- ERC-20 padrão, 18 casas, nome "Real Soberano", símbolo "BRLS".
- **Transferência com taxa zero** (compatível com Uniswap e com qualquer carteira).
- **Sem** dono, pausa, lista negra, congelamento, proxy/atualização ou queima administrativa.
- **Só dois emissores**, fixados uma única vez em `inicializar(reserva, cofre)`. Depois disso nenhum outro
  contrato ou pessoa pode criar BRLS.
- `burn` só queima o próprio saldo.

## 6. Reserva: BRLS lastreado em reais digitais

A **ReservaBRL** recebe reais digitais e emite BRLS 1:1 (menos a taxa); no resgate, queima BRLS e devolve o
real digital escolhido.

- **Lastros fixos no construtor:** BRZ, BRLA e BRL1. Não existe função para adicionar lastro.
- **Resgate nunca pausável.** O dono (o tesouro do criador) só pode pausar a **emissão** de um lastro
  específico — por exemplo, se esse lastro perder a paridade.
- **Teto diário de emissão por lastro:** máx(50.000, 10% da reserva) a cada 24 h, para limitar o estrago se um
  lastro perder a paridade.
- **Spread de diversificação** de até 0,40% quando há 2+ lastros e reserva ≥ 10.000: incentiva a usar o lastro
  menos representado. O spread **fica na reserva** como lastro extra.
- **Fase 2** (supply ≥ 1 milhão): resgate limitado a 20% do supply por 24 h, contra corrida bancária.
- A reserva nunca guarda BRLS.

## 7. CofreCripto: BRLS contra garantia em cripto

Quem tem cripto pode emitir BRLS sem vender a cripto, deixando-a como garantia.

| Garantia | Emissão até | Liquidação abaixo de |
|---|---|---|
| WETH | 200% de cobertura (emite até 50% do valor) | 150% |
| WPOL | 250% de cobertura (emite até 40% do valor) | 175% |

- **Preço:** Chainlink ativo/USD ÷ BRL/USD, conferido com o TWAP de 30 min da Uniswap V3 (desvio máx. 5%).
- **Emitir e retirar com dívida** usam o MENOR entre Chainlink atualizada e TWAP. **Liquidar** usa o TWAP se a
  Chainlink parar (a liquidação não para numa queda real). **Depositar e quitar nunca travam.**
- **Liquidação** por qualquer pessoa, com bônus de 10%. Se a garantia não cobrir a dívida, o prejuízo sai do
  **colchão**; o que sobrar fica público em `dividaRuim`.
- **Sem juros, sem rendimento, sem rebalanceamento:** a garantia não é negociada pelo protocolo.
- Dívida mínima: 10 BRLS. Taxa de emissão: 0,5%, somada à dívida.

## 8. Taxas e colchão

| Operação | Taxa |
|---|---|
| Transferir BRLS | **0** |
| Emitir / resgatar na Reserva | 0,1% |
| Emitir no CofreCripto | 0,5% (somada à dívida) |
| Cada pagamento do Escrow | 0,1% |

Toda taxa é dividida **50/50**: metade para o tesouro do criador e metade para o **colchão** (o saldo de BRLS
do CofreCripto), que cobre prejuízo de liquidação. As taxas são imutáveis.

**Invariante global** (testada por fuzzing):
`reserva.lastroTotal() + cofre.dividaTotalGlobal() + cofre.dividaRuim() ≥ BRLS.totalSupply()`.

## 9. Escrow de trabalho: pagamento garantido por contrato

O **EscrowTrabalho** trava o pagamento quando o trabalho é criado. Quatro modalidades:

| Modalidade | Como o trabalhador recebe |
|---|---|
| **Presencial** | Prova de chegada (código deixado no local, ou o cliente confirma) + código de liberação ou aprovação do cliente |
| **Entrega** | **Só com o código de entrega** do cliente. Sem disputa: sem código, sem entrega |
| **Remoto** | Cliente libera, ou o trabalhador reivindica 3 dias depois de marcar a entrega sem contestação |
| **Etapas** | Pagamento em partes, uma etapa por vez |

**Códigos:** 5 palavras em português (~55 bits), 6 palavras a partir de 1.000 BRLS. O contrato guarda só o
hash (`keccak256(escrow, cliente, código)`); o código nunca vai para a blockchain antes de ser usado.

**Caução do entregador** (opcional, só Entrega, mín. 200 BRLS): volta com o código de entrega ou com o código
de devolução; prazo vencido sem nenhum dos dois → a caução vai ao cliente.

**Vaga aberta:** qualquer pessoa se candidata; o cliente aprova (exceto Entrega, em que aceitar já assume).

**Prazo:** vencido o prazo sem entrega marcada, o cliente pega o valor de volta (`reembolsarPorPrazo`).

**Disputa** (não existe em Entrega):
- Acordo direto: propostas iguais das duas partes executam a divisão na hora.
- Árbitros opcionais: cada parte indica o seu; propostas iguais dos árbitros executam.
- Desempate do criador (opcional, escolhido pelo cliente): só 3 dias depois, e só entre as duas propostas.
- 30 dias sem solução: média das propostas dos árbitros, ou 50/50.

**Reputação contra contas falsas:** o nível exige contrapartes distintas, avaliadores distintos (uma nota por
par), média, taxa de disputa, volume e idade da conta (N2 a N5). Avaliação só em trabalhos ≥ 10 BRLS. A mesma
regra roda no contrato e na carteira.

**Kit de gás:** quem cria o trabalho pode deixar até 5 POL, que vão ao trabalhador quando ele é confirmado.
Assim ninguém trava por falta de taxa da rede. Se o trabalho não acontecer, o POL volta.

## 10. Uso sem POL (sem gás)

Quem não tem POL para a taxa da rede **assina** a ação de graça (ERC-2771, `Encaminhador` = `ERC2771Forwarder`
da OpenZeppelin, sem dono). Qualquer pessoa pode enviar a ação assinada e pagar a taxa. O contrato usa
`_msgSender()` para saber quem assinou, então ninguém consegue agir em nome de outro.

O pedido assinado chega à outra parte por QR/link ou pelo **avisador** (ver §12.5); o app dela confere
assinatura, prazo, trabalho e autor antes de mostrar "aceitar ou recusar".

## 11. Mensageiro: conversa cifrada

- Mensagens cifradas de ponta a ponta: ECDH secp256k1 + SHA-256 + AES-256-GCM, uma cópia cifrada por
  participante. O contrato nunca vê texto claro.
- A chave pública vem do registro no Mensageiro, da assinatura de uma transação da pessoa ou da assinatura
  EIP-712 de um pedido sem gás — sempre conferida contra o endereço.
- Endereços exatos, chaves Pix e coordenadas de mapa só circulam por aqui.

## 12. Aplicações construídas sobre o protocolo

Nenhuma delas exigiu contrato novo: são telas da carteira sobre o Escrow e o Mensageiro.

### 12.1 Vitrine incensurável
- Anúncio = mensagem **aberta** no Mensageiro (canal `keccak256("brls-vitrine-v1")`): JSON de até 4 KB +
  até 3 fotos comprimidas no aparelho e gravadas na própria blockchain.
- Fica para sempre (ninguém apaga), mas **só o autor** muda: nova versão, pausar, vendido, encerrar.
- Categorias: Comida, Mercado, Farmácia e pet, Serviços, Produtos e Pix ⇄ BRLS.
- Comprar = trabalho de Entrega designado ao vendedor (paga com o código).

### 12.2 Comida com entregador da rede
Dois trabalhos ligados, sem contrato novo:
- **A** (produto → loja): a loja recebe quando o entregador mostra o código de retirada C1.
- **B** (entrega → entregador, vaga aberta): o entregador recebe com o código C2 dado pelo cliente na porta.
C1, endereço da loja e destino vão cifrados ao entregador.

### 12.3 Corrida (modelo da 99)
- Categorias Moto/Pop/Plus, Expresso, preço sugerido por tarifas editáveis (base + km + minuto), distância
  pela rua (OSRM, com estimativa em linha reta se o serviço cair).
- Em público: só bairros, um ponto de embarque arredondado (~1 km), km, tempo e categoria.
- Motorista online com filtros, contraproposta assinada, perfil público do veículo (modelo, cor, placa).
- Na viagem: posição do motorista cifrada só para o passageiro, compartilhar corrida, botão 190.
- Cancelamento sem depender de resposta: o passageiro assina a proposta; se o motorista não responder, o
  prazo do contrato devolve 100%. Gorjeta e motoristas favoritos.

### 12.4 Pix ⇄ BRLS de pessoa para pessoa
Quem tem BRLS e conta bancária vira "caixa":
- **Comprar BRLS:** o comprador (mesmo sem POL e sem BRLS) pede; o caixa trava os BRLS num trabalho para ele;
  o comprador paga o Pix na chave aleatória do caixa e avisa; o caixa confere e libera. Se o caixa sumir, o
  comprador recebe depois da revisão de 3 dias.
- **Vender BRLS:** quem quer reais trava os BRLS para o caixa, que paga o Pix e recebe os BRLS.
O protocolo não toca em reais nem em Pix: é um acordo entre pessoas, com o BRLS travado em contrato.

### 12.5 Serviços públicos de terceiros (substituíveis)
| Serviço | Uso | Se cair |
|---|---|---|
| OpenStreetMap / Nominatim | Imagens do mapa e busca de endereço | Pino sem nome de rua; coordenada continua exata |
| OSRM público | Distância e tempo pela rua | Linha reta × 1,35 |
| ntfy (2 servidores) | Avisos rápidos e pedidos sem gás | QR/link; tudo que vale dinheiro está na blockchain |
| RPCs públicos da Polygon | Ler e enviar transações | Vários servidores, troca automática |

## 13. A carteira

- PWA (funciona no navegador e instala como app) e dentro do APK da Caixa Forte, com toda a rede pelo Tor.
- Chave BIP-39 de 12 ou 24 palavras (inglês ou português), caminho `m/44'/60'/0'/0/0`, cifrada com
  AES-256-GCM; chave de dados protegida por PIN (PBKDF2-SHA256, 600 mil iterações) e opcionalmente biometria
  (WebAuthn PRF). Bloqueio automático em 5 min.
- Mover dinheiro exige **deslizar para confirmar**; aprovações de token sempre do valor exato.
- Corrida e pedidos nunca se perdem: faixa "em andamento", volta direto à corrida, tela acesa, avisos com o
  app em segundo plano (no APK, um "plantão" visível mantém o app vivo).

## 14. Privacidade

- Endereços exatos, chaves Pix e posição do motorista circulam **cifrados** (§11).
- Em público ficam só dados necessários (bairros, ponto aproximado, valor).
- No APK da Caixa Forte, toda a rede passa pelo Tor.
- Sem analytics, sem rastreadores, sem fontes ou scripts de terceiros (CSP restritiva, `ethers` embutido).

## 15. Segurança e invariantes

- Testes: unitários, fuzzing (2.048 execuções no CI), invariantes do sistema inteiro, quedas de 40% e 57% do
  ETH, integração, e testes de ponta a ponta da carteira contra uma Polygon local.
- Sem proxy, sem atualização, sem dono com poder sobre saldos.
- Implantação automática por chave descartável, sem poder depois do deploy; verificação no Sourcify.
- **Pendente:** auditoria externa e programa de recompensa por falhas.

## 16. Riscos

- **Contratos não auditados.** Falhas podem causar perda de fundos.
- **Lastro de terceiros.** BRZ, BRLA e BRL1 dependem de seus emissores; o teto diário e a pausa de emissão por
  lastro limitam, mas não eliminam, o risco de perda de paridade.
- **Garantia em cripto.** Quedas muito rápidas podem gerar dívida ruim além do colchão.
- **Oráculos.** Chainlink e TWAP podem falhar; o desenho trava emissão nesses casos, mas não elimina o risco.
- **P2P Pix.** Golpe de devolução de Pix e fraude entre pessoas: comece pequeno e prefira quem tem reputação.
- **Serviços públicos.** Mapa, rotas e avisador podem cair (o app segue funcionando, com menos conforto).
- **Regulação.** As regras brasileiras de ativos virtuais estão em evolução; procure orientação jurídica.
- **Chave perdida = dinheiro perdido.** Guarde as palavras em papel.

## 17. Endereços oficiais (Polygon, chainId 137)

| Contrato | Endereço |
|---|---|
| BRLS (xBRL) | `0x3F5FD15e3D5250AE6700Bfd8f1aDb6b74afcA1d4` |
| ReservaBRL | `0x57b0A16b27EDf9F03FD07bfd9e710F91e94D64DF` |
| CofreCripto | `0x022F691E6FA86dd5BCa5CD885F8B508005A2D457` |
| EscrowTrabalho | `0xe1045bf93c1F88c5C41C105c795c41075f68bd17` |
| Encaminhador | `0x188a460eACbD9Aa88c674d40E2F3A528d45113C9` |
| Mensageiro | `0xC37F09B6D015bBf9cA63d2E8b5650557B45CF215` |
| Tesouro do criador | `0x2F8Fe2689411Bb336301AD4f2DC4077D433F43d1` |

A fonte oficial é `wallet/src/deployments/137.json`, gerado só pelo script de implantação.

## 18. Roteiro

- **Agora (beta):** primeiros anúncios e lojas em BH, corridas e entregas reais com valores pequenos.
- **Antes de divulgação ampla:** auditoria externa, recompensa por falhas, parecer jurídico, termos de uso.
- **Depois:** posições do cofre como NFT (num contrato **novo**, sem poder extra aos atuais), mais lastros só em
  nova implantação, melhorias de avisos e de liquidez.

## 19. Glossário

- **Autocustódia:** só você tem a chave do seu dinheiro.
- **Escrow:** dinheiro travado num contrato até uma condição ser cumprida.
- **Gás / POL:** taxa da rede Polygon, paga em POL.
- **Sobrecolateralização:** deixar mais garantia do que o valor emprestado.
- **TWAP:** preço médio num intervalo de tempo, mais difícil de manipular.
- **Hash:** "impressão digital" de um dado; não dá para voltar do hash ao dado.

Licença: ver `LICENSE`.
