// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title EscrowTrabalho — marketplace universal de trabalho pago em xBRL, sem intermediário
/// @notice O cliente trava o pagamento no contrato; o trabalhador recebe ao cumprir as regras da modalidade.
///
/// Modalidades:
///   0 PRESENCIAL — serviço no local (faxina, reparo, aula). O trabalhador prova que chegou digitando ou
///                  escaneando o CÓDIGO DE CHEGADA (palavras/QR que ficam no local, com o cliente).
///                  Libera pelo código de liberação (se definido), pelo aceite do cliente ou, após entrega
///                  marcada, automaticamente em 3 dias sem contestação.
///   1 ENTREGA    — leva algo a um destino. O CÓDIGO DE ENTREGA (palavras/QR) que só o destinatário tem
///                  prova a chegada e libera o pagamento na hora. ENTREGA NÃO TEM DISPUTA: sem código, não houve
///                  entrega. Para mercadoria de valor, o cliente exige CAUÇÃO do entregador (mínimo 200 xBRL,
///                  idealmente o valor da mercadoria): código de entrega = pagamento + caução de volta; código de
///                  DEVOLUÇÃO (mercadoria devolvida ao cliente) = reembolso ao cliente + caução de volta; prazo vencido
///                  sem nenhum dos dois = cliente recebe o pagamento de volta E a caução (indenização).
///   2 REMOTO     — trabalho digital. Trabalhador marca entregue; cliente aprova ou, em 3 dias de silêncio,
///                  o trabalhador saca.
///   3 ETAPAS     — projeto em 2 a 50 parcelas iguais; cada etapa segue a regra do REMOTO.
///
/// Sem GPS: localização de celular pode ser falsificada; códigos secretos não.
/// Vaga aberta (exceto ENTREGA) exige o cliente aprovar o candidato.
/// Disputas (PRESENCIAL, REMOTO, ETAPAS):
///   - as partes podem sempre fazer acordo direto (propostas iguais resolvem na hora);
///   - ÁRBITROS OPCIONAIS: o cliente escolhe o seu na criação e o trabalhador escolhe o seu ao aceitar. Cada um
///     representa uma parte; quando os DOIS árbitros propõem a mesma divisão, ela é executada;
///   - DESEMPATE DO CRIADOR (opcional, marcado na criação): se os árbitros não convergirem em 3 dias, o criador
///     da rede escolhe uma divisão ENTRE as duas propostas deles (nunca fora). Sem árbitros, o criador decide
///     após 3 dias de disputa;
///   - sem nada disso em 30 dias: qualquer um executa a média das propostas dos árbitros, ou 50/50.
/// Não existe dono, pausa ou saque administrativo.
/// Taxa: 0,1% sobre cada pagamento — metade ao Treasury, metade ao colchão de segurança (CofreCripto).
///
/// Reputação anti-contas-falsas: o nível considera contrapartes DISTINTAS, volume pago, idade da conta,
/// estrelas (uma por par de contas, a última vale) e taxa de disputas. Avaliação só em trabalhos >= 10 xBRL.
contract EscrowTrabalho is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Modalidade {
        Presencial,
        Entrega,
        Remoto,
        Etapas
    }

    enum Estado {
        Aberto, // aguardando trabalhador
        Aceito, // trabalhador definido, em execução
        Entregue, // trabalhador marcou entrega; aguardando aprovação ou prazo de revisão
        Disputa,
        Concluido,
        Cancelado
    }

    struct Trabalho {
        address cliente; // slot 0
        uint64 prazo;
        Modalidade modalidade;
        Estado estado;
        uint8 etapas;
        uint8 etapasPagas;
        address trabalhador; // slot 1
        uint64 entregueEm;
        bool chegou; // código de chegada confirmado (PRESENCIAL)
        bool clienteAvaliou;
        bool trabalhadorAvaliou;
        bool pendenteAprovacao; // vaga aberta: candidato aguardando o cliente aprovar
        uint128 valor; // slot 2
        uint128 pago; // bruto já liberado (inclui taxa)
        uint64 disputaEm; // slot 3
        uint16 propostaCliente; // bps para o trabalhador + 1 (0 = sem proposta)
        uint16 propostaTrabalhador;
        bytes32 codigoHash; // slot 4 — liberação/entrega: hashCodigo(cliente, codigo); 0 = sem código
        bytes32 chegadaHash; // slot 5 — chegada (PRESENCIAL): hashChegada(cliente, codigo)
    }

    struct NovoTrabalho {
        Modalidade modalidade;
        address trabalhador; // address(0) = vaga aberta, qualquer um aceita
        uint128 valor;
        uint64 prazo;
        uint8 etapas;
        bytes32 codigoHash;
        bytes32 chegadaHash;
        address arbitroCliente; // 0 = sem árbitros
        bool desempateCriador; // aceita o criador da rede como desempate
        uint128 caucao; // só ENTREGA; 0 = sem caução
        bytes32 devolucaoHash; // obrigatório com caução
        string descricao;
    }

    struct Arbitragem {
        address arbitroCliente; // slot 0
        uint16 propostaArbCliente; // bps ao trabalhador + 1 (0 = sem proposta)
        uint64 propostasEm; // quando as duas propostas dos árbitros passaram a existir/divergir
        bool desempateCriador;
        address arbitroTrabalhador; // slot 1
        uint16 propostaArbTrabalhador;
    }

    struct Caucao {
        uint128 valor; // travado pelo entregador ao aceitar
        bool travada;
        bytes32 devolucaoHash; // hashDevolucao(cliente, codigo)
    }

    struct Reputacao {
        uint32 concluidos;
        uint32 disputas;
        uint32 avaliacoes; // avaliadores distintos
        uint32 contrapartes; // pessoas distintas com quem concluiu trabalho
        uint64 somaEstrelas;
        uint64 desde; // primeiro trabalho concluído
        uint128 volume; // soma dos valores concluídos (xBRL)
    }

    IERC20 public immutable XBRL;
    address public immutable CREATOR_TREASURY;
    address public immutable COLCHAO;

    uint256 public constant BPS = 10_000;
    uint256 public constant CAUCAO_MINIMA = 200e18;
    uint256 public constant PRAZO_ARBITROS = 3 days;
    uint256 public constant TAXA_BPS = 10; // 0,1%
    uint256 public constant VALOR_MIN_AVALIACAO = 10e18;
    uint256 public constant PRAZO_REVISAO = 3 days;
    uint256 public constant PRAZO_DISPUTA = 30 days;
    uint8 public constant MAX_ETAPAS = 50;

    uint256 public totalTrabalhos;
    mapping(uint256 => Trabalho) private _trabalhos;
    mapping(address => Reputacao) public reputacao;
    mapping(uint256 => Arbitragem) private _arbitragens;
    mapping(uint256 => Caucao) private _caucoes;
    mapping(bytes32 => bool) private _parJaConcluiu; // par (a, b) sem ordem
    mapping(bytes32 => uint8) private _estrelasDoPar; // avaliador -> avaliado (última nota)

    event TrabalhoCriado(
        uint256 indexed id,
        address indexed cliente,
        address indexed trabalhador,
        Modalidade modalidade,
        uint256 valor,
        uint64 prazo,
        uint8 etapas,
        bool comCodigo,
        bool comChegada,
        string descricao
    );
    event TrabalhoConfigurado(
        uint256 indexed id, address indexed arbitroCliente, bool desempateCriador, uint256 caucao
    );
    event TrabalhoAceito(uint256 indexed id, address indexed trabalhador);
    event ArbitroDoTrabalhador(uint256 indexed id, address indexed arbitro);
    event CaucaoTravada(uint256 indexed id, address indexed entregador, uint256 valor);
    event CaucaoLiberada(uint256 indexed id, address indexed para, uint256 valor);
    event ChegadaConfirmadaPeloCliente(uint256 indexed id);
    event Devolvido(uint256 indexed id);
    event ArbitroPropos(uint256 indexed id, address indexed arbitro, uint16 bpsTrabalhador);
    event DesempateDoCriador(uint256 indexed id, uint16 bpsTrabalhador);
    event CandidaturaRecebida(uint256 indexed id, address indexed candidato);
    event CandidaturaEncerrada(uint256 indexed id, address indexed candidato, bool porCliente);
    event ChegadaConfirmada(uint256 indexed id, address indexed trabalhador);
    event EntregaMarcada(uint256 indexed id, uint8 etapa);
    event Pagamento(uint256 indexed id, address indexed para, uint256 liquido, uint256 taxa);
    event Reembolso(uint256 indexed id, address indexed cliente, uint256 valor);
    event TrabalhoConcluido(uint256 indexed id, address indexed cliente, address indexed trabalhador);
    event TrabalhoCancelado(uint256 indexed id);
    event DisputaAberta(uint256 indexed id, address indexed por);
    event AcordoProposto(uint256 indexed id, address indexed por, uint16 bpsTrabalhador);
    event DisputaResolvida(uint256 indexed id, uint256 paraTrabalhador, uint256 paraCliente, bool porAcordo);
    event Avaliacao(uint256 indexed id, address indexed avaliador, address indexed avaliado, uint8 estrelas);

    error ValorZero();
    error PrazoInvalido();
    error EtapasInvalidas();
    error CodigoObrigatorio();
    error NaoAutorizado();
    error EstadoInvalido(Estado atual);
    error ModalidadeInvalida();
    error ChegadaObrigatoria();
    error CodigoIncorreto();
    error RevisaoEmAndamento(uint256 liberaEm);
    error PrazoNaoVencido(uint256 venceEm);
    error EstrelasInvalidas();
    error BpsInvalido();
    error JaAvaliou();
    error ValorBaixoParaAvaliar();
    error TrabalhoInexistente();
    error ArbitroInvalido();
    error CaucaoInvalida();
    error SemDisputaNaEntrega();
    error ForaDoIntervaloDosArbitros();
    error AguardandoArbitros(uint256 liberaEm);

    constructor(address xbrl, address treasury, address colchao) {
        if (xbrl == address(0) || treasury == address(0) || colchao == address(0)) revert ValorZero();
        XBRL = IERC20(xbrl);
        CREATOR_TREASURY = treasury;
        COLCHAO = colchao;
    }

    // ------------------------------------------------------------------
    // Criação e aceite
    // ------------------------------------------------------------------

    function criarTrabalho(NovoTrabalho calldata p) external nonReentrant returns (uint256 id) {
        if (p.valor == 0) revert ValorZero();
        if (p.prazo <= block.timestamp) revert PrazoInvalido();
        if (p.trabalhador == msg.sender) revert NaoAutorizado();
        uint8 etapas = 1;
        if (p.modalidade == Modalidade.Etapas) {
            if (p.etapas < 2 || p.etapas > MAX_ETAPAS) revert EtapasInvalidas();
            etapas = p.etapas;
        } else if (p.etapas > 1) {
            revert EtapasInvalidas();
        }
        if (p.modalidade == Modalidade.Entrega && p.codigoHash == bytes32(0)) revert CodigoObrigatorio();
        if (p.modalidade == Modalidade.Presencial && p.chegadaHash == bytes32(0)) revert CodigoObrigatorio();
        if (p.modalidade != Modalidade.Presencial && p.chegadaHash != bytes32(0)) {
            revert ModalidadeInvalida();
        }
        if (p.modalidade == Modalidade.Etapas && p.codigoHash != bytes32(0)) revert ModalidadeInvalida();
        _validarConfig(p);

        id = ++totalTrabalhos;
        Trabalho storage t = _trabalhos[id];
        t.cliente = msg.sender;
        t.trabalhador = p.trabalhador;
        t.modalidade = p.modalidade;
        t.estado = Estado.Aberto;
        t.valor = p.valor;
        t.prazo = p.prazo;
        t.etapas = etapas;
        t.codigoHash = p.codigoHash;
        t.chegadaHash = p.chegadaHash;
        if (p.arbitroCliente != address(0) || p.desempateCriador) {
            Arbitragem storage a = _arbitragens[id];
            a.arbitroCliente = p.arbitroCliente;
            a.desempateCriador = p.desempateCriador;
        }
        if (p.caucao != 0) {
            Caucao storage c = _caucoes[id];
            c.valor = p.caucao;
            c.devolucaoHash = p.devolucaoHash;
        }

        XBRL.safeTransferFrom(msg.sender, address(this), p.valor);
        if (p.arbitroCliente != address(0) || p.desempateCriador || p.caucao != 0) {
            emit TrabalhoConfigurado(id, p.arbitroCliente, p.desempateCriador, p.caucao);
        }
        emit TrabalhoCriado(
            id,
            msg.sender,
            p.trabalhador,
            p.modalidade,
            p.valor,
            p.prazo,
            etapas,
            p.codigoHash != bytes32(0),
            p.chegadaHash != bytes32(0),
            p.descricao
        );
    }

    /// @notice Aceita o trabalho. Designado: só o escolhido, e já começa.
    /// Vaga aberta de ENTREGA: qualquer um aceita e já começa (sem o código não há pagamento).
    /// Vaga aberta das demais modalidades: vira candidatura e o cliente precisa aprovar — impede que um
    /// estranho aceite, marque "entregue" sem fazer nada e force a divisão da disputa.
    /// @param arbitro árbitro escolhido pelo trabalhador (obrigatório se o cliente escolheu um; senão, zero).
    /// Com caução, o entregador trava o valor da caução neste momento (precisa aprovar o xBRL antes).
    function aceitar(uint256 id, address arbitro) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (t.estado != Estado.Aberto) revert EstadoInvalido(t.estado);
        if (block.timestamp >= t.prazo) revert PrazoInvalido();
        if (t.trabalhador == address(0)) {
            if (msg.sender == t.cliente) revert NaoAutorizado();
        } else if (msg.sender != t.trabalhador || t.pendenteAprovacao) {
            revert NaoAutorizado();
        }
        Arbitragem storage a = _arbitragens[id];
        if (a.arbitroCliente == address(0)) {
            if (arbitro != address(0)) revert ArbitroInvalido();
        } else if (arbitro == address(0) || arbitro == t.cliente || arbitro == msg.sender) {
            revert ArbitroInvalido();
        } else if (a.arbitroCliente == msg.sender) {
            revert ArbitroInvalido(); // o árbitro do cliente não pode ser o próprio trabalhador
        }
        a.arbitroTrabalhador = arbitro;
        if (arbitro != address(0)) emit ArbitroDoTrabalhador(id, arbitro);

        if (t.trabalhador == address(0)) {
            t.trabalhador = msg.sender;
            if (t.modalidade != Modalidade.Entrega) {
                t.pendenteAprovacao = true;
                emit CandidaturaRecebida(id, msg.sender);
                return;
            }
        }
        _travarCaucao(id, msg.sender);
        t.estado = Estado.Aceito;
        emit TrabalhoAceito(id, msg.sender);
    }

    /// @notice Cliente aprova (true) ou recusa (false) o candidato de uma vaga aberta.
    function decidirCandidato(uint256 id, bool aprovar) external {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.cliente) revert NaoAutorizado();
        if (t.estado != Estado.Aberto || !t.pendenteAprovacao) revert EstadoInvalido(t.estado);
        address candidato = t.trabalhador;
        t.pendenteAprovacao = false;
        if (aprovar) {
            t.estado = Estado.Aceito;
            emit TrabalhoAceito(id, candidato);
        } else {
            t.trabalhador = address(0);
            _arbitragens[id].arbitroTrabalhador = address(0);
            emit CandidaturaEncerrada(id, candidato, true);
        }
    }

    /// @notice Cliente cancela enquanto ninguém aceitou. Reembolso integral, sem taxa.
    function cancelar(uint256 id) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.cliente) revert NaoAutorizado();
        if (t.estado != Estado.Aberto) revert EstadoInvalido(t.estado);
        t.estado = Estado.Cancelado;
        _reembolsarRestante(id, t);
        emit TrabalhoCancelado(id);
    }

    /// @notice Trabalhador desiste antes de entregar (o restante volta ao cliente).
    /// Candidato ainda não aprovado apenas retira a candidatura (a vaga reabre).
    function desistir(uint256 id) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.trabalhador) revert NaoAutorizado();
        if (t.pendenteAprovacao) {
            t.pendenteAprovacao = false;
            t.trabalhador = address(0);
            _arbitragens[id].arbitroTrabalhador = address(0);
            emit CandidaturaEncerrada(id, msg.sender, false);
            return;
        }
        if (t.estado != Estado.Aceito) revert EstadoInvalido(t.estado);
        // Com caução a mercadoria pode estar com o entregador: só sai pelo código de entrega ou de devolução.
        if (_caucoes[id].travada) revert CaucaoInvalida();
        t.estado = Estado.Cancelado;
        _reembolsarRestante(id, t);
        emit TrabalhoCancelado(id);
    }

    /// @notice Prazo venceu sem entrega: cliente recupera o que não foi pago.
    /// ENTREGA com caução: sem código de entrega nem de devolução até o prazo, a caução vai ao cliente.
    function reembolsarPorPrazo(uint256 id) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.cliente) revert NaoAutorizado();
        if (t.estado != Estado.Aberto && t.estado != Estado.Aceito) revert EstadoInvalido(t.estado);
        if (block.timestamp <= t.prazo) revert PrazoNaoVencido(t.prazo);
        t.estado = Estado.Cancelado;
        _reembolsarRestante(id, t);
        _liberarCaucao(id, t.cliente);
        emit TrabalhoCancelado(id);
    }

    /// @notice ENTREGA com caução: o entregador devolveu a mercadoria ao cliente e recebeu dele o código de
    /// devolução. O cliente recebe o pagamento de volta e o entregador recupera a caução.
    function confirmarDevolucao(uint256 id, string calldata codigo) external nonReentrant {
        Trabalho storage t = _existente(id);
        Caucao storage c = _caucoes[id];
        if (!c.travada) revert CaucaoInvalida();
        if (t.estado != Estado.Aceito) revert EstadoInvalido(t.estado);
        if (hashDevolucao(t.cliente, codigo) != c.devolucaoHash) revert CodigoIncorreto();
        t.estado = Estado.Cancelado;
        _reembolsarRestante(id, t);
        _liberarCaucao(id, t.trabalhador);
        emit Devolvido(id);
    }

    // ------------------------------------------------------------------
    // Execução
    // ------------------------------------------------------------------

    /// @notice PRESENCIAL: o trabalhador prova que chegou com o código de chegada que fica no local
    /// (palavras ou QR mostrados pelo cliente). Sem isso não dá para marcar entrega nem liberar por código.
    function confirmarChegada(uint256 id, string calldata codigo) external {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.trabalhador) revert NaoAutorizado();
        if (t.estado != Estado.Aceito) revert EstadoInvalido(t.estado);
        if (t.modalidade != Modalidade.Presencial) revert ModalidadeInvalida();
        if (hashChegada(t.cliente, codigo) != t.chegadaHash) revert CodigoIncorreto();
        t.chegou = true;
        emit ChegadaConfirmada(id, msg.sender);
    }

    /// @notice PRESENCIAL: o próprio cliente confirma que o trabalhador chegou (alternativa sem câmera).
    function confirmarChegadaPeloCliente(uint256 id) external {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.cliente) revert NaoAutorizado();
        if (t.estado != Estado.Aceito) revert EstadoInvalido(t.estado);
        if (t.modalidade != Modalidade.Presencial) revert ModalidadeInvalida();
        t.chegou = true;
        emit ChegadaConfirmadaPeloCliente(id);
    }

    /// @notice Confirma com o código de liberação/entrega do cliente (PRESENCIAL exige a chegada antes).
    /// Qualquer um pode submeter; o pagamento vai sempre para o trabalhador.
    function confirmarComCodigo(uint256 id, string calldata codigo) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (t.codigoHash == bytes32(0)) revert ModalidadeInvalida();
        if (t.estado != Estado.Aceito && t.estado != Estado.Entregue) revert EstadoInvalido(t.estado);
        if (t.modalidade == Modalidade.Presencial && !t.chegou) revert ChegadaObrigatoria();
        if (hashCodigo(t.cliente, codigo) != t.codigoHash) revert CodigoIncorreto();
        _pagarTudo(id, t);
        _liberarCaucao(id, t.trabalhador);
    }

    /// @notice Trabalhador marca a entrega (da etapa atual, se ETAPAS). Inicia a janela de revisão de 3 dias.
    function marcarEntregue(uint256 id) external {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.trabalhador) revert NaoAutorizado();
        if (t.estado != Estado.Aceito) revert EstadoInvalido(t.estado);
        if (t.modalidade == Modalidade.Entrega) revert ModalidadeInvalida(); // entrega exige código
        if (t.modalidade == Modalidade.Presencial && !t.chegou) revert ChegadaObrigatoria();
        t.estado = Estado.Entregue;
        t.entregueEm = SafeCast.toUint64(block.timestamp);
        emit EntregaMarcada(id, t.etapasPagas + 1);
    }

    /// @notice Cliente aprova e libera (tudo, ou a próxima etapa).
    function liberar(uint256 id) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.cliente) revert NaoAutorizado();
        if (t.estado != Estado.Aceito && t.estado != Estado.Entregue) revert EstadoInvalido(t.estado);
        _liberarProxima(id, t);
    }

    /// @notice Trabalhador saca após 3 dias da entrega marcada sem contestação.
    function reivindicar(uint256 id) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.trabalhador) revert NaoAutorizado();
        if (t.estado != Estado.Entregue) revert EstadoInvalido(t.estado);
        uint256 liberaEm = uint256(t.entregueEm) + PRAZO_REVISAO;
        if (block.timestamp < liberaEm) revert RevisaoEmAndamento(liberaEm);
        _liberarProxima(id, t);
    }

    // ------------------------------------------------------------------
    // Disputa: acordo direto, árbitros das partes e desempate opcional do criador
    // ------------------------------------------------------------------

    function abrirDisputa(uint256 id) external {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.cliente && msg.sender != t.trabalhador) revert NaoAutorizado();
        if (t.estado != Estado.Aceito && t.estado != Estado.Entregue) revert EstadoInvalido(t.estado);
        if (t.modalidade == Modalidade.Entrega) revert SemDisputaNaEntrega();
        t.estado = Estado.Disputa;
        t.disputaEm = SafeCast.toUint64(block.timestamp);
        ++reputacao[t.cliente].disputas;
        ++reputacao[t.trabalhador].disputas;
        emit DisputaAberta(id, msg.sender);
    }

    /// @notice Propõe a fatia do valor restante que vai ao trabalhador (0 a 10.000 bps).
    /// Quando as duas partes propõem o mesmo número, a disputa se resolve automaticamente.
    function proporAcordo(uint256 id, uint16 bpsTrabalhador) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (t.estado != Estado.Disputa) revert EstadoInvalido(t.estado);
        if (bpsTrabalhador > BPS) revert BpsInvalido();
        uint16 codificado = bpsTrabalhador + 1;
        if (msg.sender == t.cliente) {
            t.propostaCliente = codificado;
        } else if (msg.sender == t.trabalhador) {
            t.propostaTrabalhador = codificado;
        } else {
            revert NaoAutorizado();
        }
        emit AcordoProposto(id, msg.sender, bpsTrabalhador);
        if (t.propostaCliente != 0 && t.propostaCliente == t.propostaTrabalhador) {
            _resolver(id, t, bpsTrabalhador, true);
        }
    }

    /// @notice Árbitro de uma das partes propõe a fatia do restante que vai ao trabalhador.
    /// Quando os dois árbitros propõem o mesmo número, a divisão é executada.
    function arbitrar(uint256 id, uint16 bpsTrabalhador) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (t.estado != Estado.Disputa) revert EstadoInvalido(t.estado);
        if (bpsTrabalhador > BPS) revert BpsInvalido();
        Arbitragem storage a = _arbitragens[id];
        if (a.arbitroCliente == address(0)) revert ArbitroInvalido();
        bool ehCliente = msg.sender == a.arbitroCliente;
        bool ehTrabalhador = msg.sender == a.arbitroTrabalhador;
        if (!ehCliente && !ehTrabalhador) revert NaoAutorizado();
        uint16 codificado = bpsTrabalhador + 1;
        if (ehCliente) a.propostaArbCliente = codificado;
        if (ehTrabalhador) a.propostaArbTrabalhador = codificado;
        emit ArbitroPropos(id, msg.sender, bpsTrabalhador);
        if (a.propostaArbCliente != 0 && a.propostaArbTrabalhador != 0) {
            if (a.propostaArbCliente == a.propostaArbTrabalhador) {
                _resolver(id, t, bpsTrabalhador, true);
            } else {
                a.propostasEm = SafeCast.toUint64(block.timestamp);
            }
        }
    }

    /// @notice Desempate do criador da rede (só se o cliente marcou essa opção na criação).
    /// Com árbitros: só depois de 3 dias de divergência, e só ENTRE as duas propostas deles.
    /// Sem árbitros: depois de 3 dias de disputa sem acordo das partes.
    function desempatar(uint256 id, uint16 bpsTrabalhador) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (t.estado != Estado.Disputa) revert EstadoInvalido(t.estado);
        if (msg.sender != CREATOR_TREASURY) revert NaoAutorizado();
        if (bpsTrabalhador > BPS) revert BpsInvalido();
        Arbitragem storage a = _arbitragens[id];
        if (!a.desempateCriador) revert NaoAutorizado();
        if (a.arbitroCliente != address(0)) {
            if (a.propostaArbCliente == 0 || a.propostaArbTrabalhador == 0) revert AguardandoArbitros(0);
            uint256 libera = uint256(a.propostasEm) + PRAZO_ARBITROS;
            if (block.timestamp < libera) revert AguardandoArbitros(libera);
            uint256 x = uint256(a.propostaArbCliente) - 1;
            uint256 y = uint256(a.propostaArbTrabalhador) - 1;
            (uint256 menor, uint256 maior) = x < y ? (x, y) : (y, x);
            if (bpsTrabalhador < menor || bpsTrabalhador > maior) revert ForaDoIntervaloDosArbitros();
        } else {
            uint256 libera = uint256(t.disputaEm) + PRAZO_ARBITROS;
            if (block.timestamp < libera) revert AguardandoArbitros(libera);
        }
        emit DesempateDoCriador(id, bpsTrabalhador);
        _resolver(id, t, bpsTrabalhador, false);
    }

    /// @notice Sem solução em 30 dias: qualquer pessoa executa a média das propostas dos dois árbitros
    /// (se ambos propuseram) ou a divisão 50/50 do restante.
    function resolverPorTempo(uint256 id) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (t.estado != Estado.Disputa) revert EstadoInvalido(t.estado);
        uint256 venceEm = uint256(t.disputaEm) + PRAZO_DISPUTA;
        if (block.timestamp < venceEm) revert PrazoNaoVencido(venceEm);
        Arbitragem storage a = _arbitragens[id];
        uint256 bps = 5_000;
        if (a.propostaArbCliente != 0 && a.propostaArbTrabalhador != 0) {
            bps = (uint256(a.propostaArbCliente) + a.propostaArbTrabalhador - 2) / 2;
        }
        _resolver(id, t, bps, false);
    }

    // ------------------------------------------------------------------
    // Reputação
    // ------------------------------------------------------------------

    /// @notice Avaliação mútua (1 a 5 estrelas), uma vez por parte, após a conclusão de trabalhos >= 10 xBRL.
    /// Cada pessoa conta UMA vez na média de quem ela avalia (a nota mais recente substitui a anterior):
    /// repetir trabalhos falsos entre as mesmas contas não infla a reputação.
    function avaliar(uint256 id, uint8 estrelas) external {
        Trabalho storage t = _existente(id);
        if (t.estado != Estado.Concluido) revert EstadoInvalido(t.estado);
        if (estrelas < 1 || estrelas > 5) revert EstrelasInvalidas();
        if (t.valor < VALOR_MIN_AVALIACAO) revert ValorBaixoParaAvaliar();
        address avaliado;
        if (msg.sender == t.cliente) {
            if (t.clienteAvaliou) revert JaAvaliou();
            t.clienteAvaliou = true;
            avaliado = t.trabalhador;
        } else if (msg.sender == t.trabalhador) {
            if (t.trabalhadorAvaliou) revert JaAvaliou();
            t.trabalhadorAvaliou = true;
            avaliado = t.cliente;
        } else {
            revert NaoAutorizado();
        }
        Reputacao storage r = reputacao[avaliado];
        bytes32 chave = keccak256(abi.encode(msg.sender, avaliado));
        uint8 anterior = _estrelasDoPar[chave];
        if (anterior == 0) ++r.avaliacoes;
        else r.somaEstrelas -= anterior;
        r.somaEstrelas += estrelas;
        _estrelasDoPar[chave] = estrelas;
        emit Avaliacao(id, msg.sender, avaliado, estrelas);
    }

    /// @notice Nível de reputação 0 a 5 (mesma regra usada pela carteira em escrow-client.js).
    /// Barreiras contra contas falsas: contrapartes distintas, avaliadores distintos, volume e idade da conta.
    /// Idade não se compra: subir de nível exige tempo real de histórico.
    function nivel(address conta) external view returns (uint8) {
        Reputacao memory r = reputacao[conta];
        if (r.concluidos == 0) return 0;
        uint256 media100 = r.avaliacoes == 0 ? 0 : (uint256(r.somaEstrelas) * 100) / r.avaliacoes;
        uint256 disputaBps = (uint256(r.disputas) * BPS) / (uint256(r.concluidos) + r.disputas);
        uint256 idade = block.timestamp - r.desde;
        if (_atinge(r, media100, disputaBps, idade, 80, 50, 480, 200, 100_000e18, 365 days)) return 5;
        if (_atinge(r, media100, disputaBps, idade, 40, 25, 450, 500, 25_000e18, 180 days)) return 4;
        if (_atinge(r, media100, disputaBps, idade, 15, 10, 400, 1_000, 5_000e18, 60 days)) return 3;
        if (_atinge(r, media100, disputaBps, idade, 5, 3, 350, 2_000, 500e18, 14 days)) return 2;
        return 1;
    }

    function _atinge(
        Reputacao memory r,
        uint256 media100,
        uint256 disputaBps,
        uint256 idade,
        uint256 contrapartes,
        uint256 avaliacoes,
        uint256 mediaMin,
        uint256 disputaMax,
        uint256 volumeMin,
        uint256 idadeMin
    ) private pure returns (bool) {
        return r.contrapartes >= contrapartes && r.avaliacoes >= avaliacoes && media100 >= mediaMin
            && disputaBps <= disputaMax && r.volume >= volumeMin && idade >= idadeMin;
    }

    // ------------------------------------------------------------------
    // Leitura e utilidades
    // ------------------------------------------------------------------

    function trabalho(uint256 id) external view returns (Trabalho memory) {
        return _trabalhos[id];
    }

    /// @notice Hash do código de entrega, como deve ser gravado em `codigoHash`.
    function hashCodigo(address cliente, string calldata codigo) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), cliente, codigo));
    }

    function arbitragem(uint256 id) external view returns (Arbitragem memory) {
        return _arbitragens[id];
    }

    function caucao(uint256 id) external view returns (Caucao memory) {
        return _caucoes[id];
    }

    /// @notice Hash do código de devolução (ENTREGA com caução).
    function hashDevolucao(address cliente, string calldata codigo) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), cliente, "devolucao", codigo));
    }

    /// @notice Hash do código de chegada (domínio separado do código de liberação).
    function hashChegada(address cliente, string calldata codigo) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), cliente, "chegada", codigo));
    }

    // ------------------------------------------------------------------
    // Internos de pagamento
    // ------------------------------------------------------------------

    function _validarConfig(NovoTrabalho calldata p) private view {
        bool entrega = p.modalidade == Modalidade.Entrega;
        if (p.caucao != 0) {
            if (!entrega || p.caucao < CAUCAO_MINIMA || p.devolucaoHash == bytes32(0)) {
                revert CaucaoInvalida();
            }
        } else if (p.devolucaoHash != bytes32(0)) {
            revert CaucaoInvalida();
        }
        if (entrega && (p.arbitroCliente != address(0) || p.desempateCriador)) revert SemDisputaNaEntrega();
        if (
            p.arbitroCliente != address(0)
                && (p.arbitroCliente == msg.sender
                    || (p.trabalhador != address(0) && p.arbitroCliente == p.trabalhador))
        ) revert ArbitroInvalido();
    }

    function _travarCaucao(uint256 id, address entregador) private {
        Caucao storage c = _caucoes[id];
        if (c.valor == 0) return;
        c.travada = true;
        XBRL.safeTransferFrom(entregador, address(this), c.valor);
        emit CaucaoTravada(id, entregador, c.valor);
    }

    function _liberarCaucao(uint256 id, address para) private {
        Caucao storage c = _caucoes[id];
        if (!c.travada) return;
        c.travada = false;
        XBRL.safeTransfer(para, c.valor);
        emit CaucaoLiberada(id, para, c.valor);
    }

    function _existente(uint256 id) private view returns (Trabalho storage t) {
        t = _trabalhos[id];
        if (t.cliente == address(0)) revert TrabalhoInexistente();
    }

    function _liberarProxima(uint256 id, Trabalho storage t) private {
        if (t.modalidade != Modalidade.Etapas) {
            _pagarTudo(id, t);
            return;
        }
        uint256 parcela = uint256(t.valor) / t.etapas;
        uint8 proxima = t.etapasPagas + 1;
        if (proxima == t.etapas) {
            _pagarTudo(id, t);
            return;
        }
        t.etapasPagas = proxima;
        t.pago += SafeCast.toUint128(parcela);
        t.estado = Estado.Aceito;
        t.entregueEm = 0;
        _pagar(id, t.trabalhador, parcela);
    }

    function _pagarTudo(uint256 id, Trabalho storage t) private {
        uint256 restante = uint256(t.valor) - t.pago;
        t.pago = t.valor;
        t.etapasPagas = t.etapas;
        t.estado = Estado.Concluido;
        _registrarConclusao(t.cliente, t.trabalhador, t.valor);
        _pagar(id, t.trabalhador, restante);
        emit TrabalhoConcluido(id, t.cliente, t.trabalhador);
    }

    function _registrarConclusao(address a, address b, uint128 valor) private {
        (address x, address y) = a < b ? (a, b) : (b, a);
        bytes32 par = keccak256(abi.encode(x, y));
        bool novoPar = !_parJaConcluiu[par];
        if (novoPar) _parJaConcluiu[par] = true;
        _somar(reputacao[a], valor, novoPar);
        _somar(reputacao[b], valor, novoPar);
    }

    function _somar(Reputacao storage r, uint128 valor, bool novoPar) private {
        ++r.concluidos;
        r.volume += valor;
        if (novoPar) ++r.contrapartes;
        if (r.desde == 0) r.desde = SafeCast.toUint64(block.timestamp);
    }

    function _resolver(uint256 id, Trabalho storage t, uint256 bpsTrabalhador, bool porAcordo) private {
        uint256 restante = uint256(t.valor) - t.pago;
        uint256 paraTrabalhador = (restante * bpsTrabalhador) / BPS;
        uint256 paraCliente = restante - paraTrabalhador;
        t.pago = t.valor;
        t.estado = Estado.Concluido;
        if (paraTrabalhador != 0) _pagar(id, t.trabalhador, paraTrabalhador);
        if (paraCliente != 0) {
            XBRL.safeTransfer(t.cliente, paraCliente);
            emit Reembolso(id, t.cliente, paraCliente);
        }
        emit DisputaResolvida(id, paraTrabalhador, paraCliente, porAcordo);
    }

    function _reembolsarRestante(uint256 id, Trabalho storage t) private {
        uint256 restante = uint256(t.valor) - t.pago;
        t.pago = t.valor;
        if (restante != 0) {
            XBRL.safeTransfer(t.cliente, restante);
            emit Reembolso(id, t.cliente, restante);
        }
    }

    function _pagar(uint256 id, address para, uint256 bruto) private {
        uint256 taxa = (bruto * TAXA_BPS) / BPS;
        if (taxa != 0) {
            XBRL.safeTransfer(CREATOR_TREASURY, taxa - taxa / 2);
            XBRL.safeTransfer(COLCHAO, taxa / 2);
        }
        XBRL.safeTransfer(para, bruto - taxa);
        emit Pagamento(id, para, bruto - taxa, taxa);
    }
}
