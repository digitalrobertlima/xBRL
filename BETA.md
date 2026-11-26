# BRLS — Beta e checklist de produção

Documento vivo: o que já está pronto, o que falta antes de divulgar em grande escala e como rodar o beta.

## 1. Onde estamos

| Área | Situação |
|---|---|
| Contratos na Polygon (BRLS, Reserva, Cofre, Escrow, Encaminhador, Mensageiro) | ✅ No ar (`wallet/src/deployments/137.json`) |
| Carteira (PWA) e BRLS dentro do APK da Caixa Forte (Tor) | ✅ |
| Vitrine (anúncios, lojas, sacola, comida com entregador) | ✅ |
| Pix ⇄ BRLS de pessoa para pessoa | ✅ |
| Corrida no modelo da 99 (categorias, tarifas, contraproposta, acompanhamento, cancelamento) | ✅ |
| Corrida/pedidos nunca se perdem + tela acesa | ✅ |
| Avisos com o app em segundo plano (navegador e APK com plantão) | ✅ |
| White papers (`WHITEPAPER.md` aqui e na Caixa Forte) | ✅ |
| **Auditoria externa dos contratos** | ⏳ Falta — obrigatória antes de divulgação ampla |
| **Parecer jurídico** (regras do Banco Central de ativos virtuais, Pix P2P, corrida, CDC) | ⏳ Falta |
| **Termos de uso e política de privacidade** (revisados por advogado) | ⏳ Falta |
| Programa de recompensa por falhas | ⏳ Depois da auditoria |
| Liquidez inicial (caixas Pix ⇄ BRLS e pools BRLS/POL, BRLS/USDT) | ⏳ Montar durante o beta |
| Suporte (canal de atendimento + perguntas frequentes) | ⏳ |
| Vídeos curtos de cada fluxo (anunciar, comprar, pedir corrida, dirigir, caixa Pix) | ⏳ |

## 2. Beta fechado (30 a 60 dias, BH)

**Quem:** 50 a 100 pessoas — a Pastelândia como primeira loja, alguns entregadores e motoristas conhecidos,
2 ou 3 "caixas" de Pix ⇄ BRLS e clientes de confiança.

**Regras do beta:**
- Valores pequenos (até R$ 100 por operação).
- Todo mundo guarda as palavras em papel antes de colocar dinheiro.
- Problema → print + horário no canal de suporte.

**O que medir (anotar toda semana):**
- pedidos feitos / entregues / cancelados;
- corridas pedidas / feitas / canceladas, e tempo até alguém aceitar;
- quanto tempo para alguém conseguir BRLS pela primeira vez (Pix ⇄ BRLS);
- falhas: tela travada, aviso que não chegou, transação que deu erro;
- depoimentos (com autorização).

## 3. Primeiro anúncio: pastel e caldo de cana (passo a passo)

1. **Tenha um pouco de POL** (taxa da rede; centavos por anúncio). Pela Caixa Forte: Trocar → POL.
2. Abra o BRLS → aba **🛍️ Vitrine** → **🗂️ Meus anúncios e loja** → **🏪 Criar minha loja**.
   - Nome: *Pastelândia*; horário; endereço de retirada no mapa (📍, só aparece para entregadores);
     bairro e cidade; quem entrega (a própria loja ou entregador da rede) e a taxa de entrega.
   - Foto da fachada ou do logo. **Segure para publicar.**
3. **➕ Novo anúncio** → categoria **🍔 Comida**:
   - *Pastel de carne* — preço — descrição — opções (ex.: "com queijo + R$ 3,00") — foto.
   - *Caldo de cana 500 ml* — preço — opções (ex.: "com limão", "700 ml + R$ 3,00") — foto.
4. Em **Meus anúncios e loja**, toque em **🔔 Receber pedidos com aviso**. No APK, o celular mostra o aviso fixo
   "BRLS de plantão" enquanto estiver recebendo.
5. Quando chegar um pedido: abra-o, toque em **aceitar**. Com entrega própria, peça o **código de entrega** ao
   cliente na porta (com a comida na mão dele) e digite para receber. Com entregador da rede, o entregador
   mostra o **código de retirada** ao buscar: digite para receber.
6. Acabou o pastel? Abra o anúncio → **⏸️ Pausar**. Mudou o preço? **✏️ Editar** (vale a última versão).

## 4. Antes de procurar canais grandes de finanças

- [ ] Relatório de auditoria publicado
- [ ] Parecer jurídico e termos de uso
- [ ] 30+ dias de beta com números reais e depoimentos
- [ ] Liquidez: pelo menos 3 caixas ativos e pools abastecidas
- [ ] Página de riscos clara (o que pode dar errado)
- [ ] Kit para criadores: e-mail curto, vídeo de 60 s, link do app, números do beta, auditoria
- [ ] Publicidade sempre identificada como tal (guia do CONAR para influenciadores)
