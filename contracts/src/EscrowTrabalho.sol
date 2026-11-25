// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title EscrowTrabalho — marketplace universal de trabalho pago em xBRL, sem intermediário
/// @notice O cliente trava o pagamento no contrato; o trabalhador recebe ao cumprir as regras da modalidade.
///
/// Modalidades:
///   0 PRESENCIAL — serviço no local (faxina, reparo, aula). Exige check-in GPS a até 80 m do endereço.
///                  Libera pelo código do cliente (se definido), pelo aceite do cliente ou, após entrega
///                  marcada, automaticamente em 3 dias sem contestação.
///   1 ENTREGA    — leva algo a um destino. Exige check-in GPS a até 80 m do destino + CÓDIGO DE ENTREGA
///                  que só o destinatário tem. Código correto = pagamento imediato.
///   2 REMOTO     — trabalho digital. Trabalhador marca entregue; cliente aprova ou, em 3 dias de silêncio,
///                  o trabalhador saca.
///   3 ETAPAS     — projeto em 2 a 50 parcelas iguais; cada etapa segue a regra do REMOTO.
///
/// GPS é declaratório (vem do aparelho do trabalhador) e fica registrado on-chain como prova; a garantia
/// forte é o código de entrega ou o aceite do cliente. Disputas: as partes propõem uma divisão; se as
/// duas propostas coincidirem, resolve na hora. Sem acordo em 30 dias, qualquer um executa 50/50.
/// Não existe árbitro, dono, pausa ou saque administrativo. Taxa: 0,1% sobre cada pagamento ao Treasury.
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
        bool checkin;
        bool clienteAvaliou;
        bool trabalhadorAvaliou;
        uint128 valor; // slot 2
        uint128 pago; // bruto já liberado (inclui taxa)
        int32 lat; // slot 3 — microdegraus
        int32 lon;
        uint64 disputaEm;
        uint16 propostaCliente; // bps para o trabalhador + 1 (0 = sem proposta)
        uint16 propostaTrabalhador;
        bytes32 codigoHash; // slot 4 — keccak256(abi.encode(address(this), cliente, codigo)); 0 = sem código
    }

    struct NovoTrabalho {
        Modalidade modalidade;
        address trabalhador; // address(0) = vaga aberta, qualquer um aceita
        uint128 valor;
        uint64 prazo;
        int32 lat;
        int32 lon;
        uint8 etapas;
        bytes32 codigoHash;
        string descricao;
    }

    struct Reputacao {
        uint32 concluidos;
        uint32 disputas;
        uint32 avaliacoes;
        uint64 somaEstrelas;
    }

    IERC20 public immutable XBRL;
    address public immutable CREATOR_TREASURY;

    uint256 public constant BPS = 10_000;
    uint256 public constant TAXA_BPS = 10; // 0,1%
    uint256 public constant RAIO_MAX_MM = 80_000; // 80 metros
    uint256 public constant PRAZO_REVISAO = 3 days;
    uint256 public constant PRAZO_DISPUTA = 30 days;
    uint8 public constant MAX_ETAPAS = 50;

    // Geodésia em ponto fixo (1e18): metros por microdegrau = 2πR/360/1e6, R = 6.371.008,8 m.
    int256 private constant NM_POR_MICRODEGRAU = 111_195_080; // nanômetros
    int256 private constant PI_E18 = 3_141_592_653_589_793_238;
    int256 private constant E18 = 1e18;

    uint256 public totalTrabalhos;
    mapping(uint256 => Trabalho) private _trabalhos;
    mapping(address => Reputacao) public reputacao;

    event TrabalhoCriado(
        uint256 indexed id,
        address indexed cliente,
        address indexed trabalhador,
        Modalidade modalidade,
        uint256 valor,
        uint64 prazo,
        int32 lat,
        int32 lon,
        uint8 etapas,
        bool comCodigo,
        string descricao
    );
    event TrabalhoAceito(uint256 indexed id, address indexed trabalhador);
    event CheckIn(uint256 indexed id, address indexed trabalhador, int32 lat, int32 lon, uint256 distanciaMm);
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
    error CoordenadasInvalidas();
    error CodigoObrigatorio();
    error NaoAutorizado();
    error EstadoInvalido(Estado atual);
    error ModalidadeInvalida();
    error ForaDoRaio(uint256 distanciaMm);
    error CheckInObrigatorio();
    error CodigoIncorreto();
    error RevisaoEmAndamento(uint256 liberaEm);
    error PrazoNaoVencido(uint256 venceEm);
    error EstrelasInvalidas();
    error BpsInvalido();
    error JaAvaliou();
    error TrabalhoInexistente();

    constructor(address xbrl, address treasury) {
        if (xbrl == address(0) || treasury == address(0)) revert ValorZero();
        XBRL = IERC20(xbrl);
        CREATOR_TREASURY = treasury;
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
        bool presencial = p.modalidade == Modalidade.Presencial || p.modalidade == Modalidade.Entrega;
        if (presencial) {
            if (p.lat < -90_000_000 || p.lat > 90_000_000 || p.lon < -180_000_000 || p.lon > 180_000_000) {
                revert CoordenadasInvalidas();
            }
        }
        if (p.modalidade == Modalidade.Entrega && p.codigoHash == bytes32(0)) revert CodigoObrigatorio();
        if (p.modalidade == Modalidade.Etapas && p.codigoHash != bytes32(0)) revert ModalidadeInvalida();

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
        if (presencial) {
            t.lat = p.lat;
            t.lon = p.lon;
        }

        XBRL.safeTransferFrom(msg.sender, address(this), p.valor);
        emit TrabalhoCriado(
            id,
            msg.sender,
            p.trabalhador,
            p.modalidade,
            p.valor,
            p.prazo,
            t.lat,
            t.lon,
            etapas,
            p.codigoHash != bytes32(0),
            p.descricao
        );
    }

    /// @notice Aceita o trabalho. Vaga aberta: qualquer um (menos o cliente). Designado: só o escolhido.
    function aceitar(uint256 id) external {
        Trabalho storage t = _existente(id);
        if (t.estado != Estado.Aberto) revert EstadoInvalido(t.estado);
        if (block.timestamp >= t.prazo) revert PrazoInvalido();
        if (t.trabalhador == address(0)) {
            if (msg.sender == t.cliente) revert NaoAutorizado();
            t.trabalhador = msg.sender;
        } else if (msg.sender != t.trabalhador) {
            revert NaoAutorizado();
        }
        t.estado = Estado.Aceito;
        emit TrabalhoAceito(id, msg.sender);
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

    /// @notice Trabalhador desiste antes de entregar. O restante volta ao cliente.
    function desistir(uint256 id) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.trabalhador) revert NaoAutorizado();
        if (t.estado != Estado.Aceito) revert EstadoInvalido(t.estado);
        t.estado = Estado.Cancelado;
        _reembolsarRestante(id, t);
        emit TrabalhoCancelado(id);
    }

    /// @notice Prazo venceu sem entrega: cliente recupera o que não foi pago.
    function reembolsarPorPrazo(uint256 id) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.cliente) revert NaoAutorizado();
        if (t.estado != Estado.Aberto && t.estado != Estado.Aceito) revert EstadoInvalido(t.estado);
        if (block.timestamp <= t.prazo) revert PrazoNaoVencido(t.prazo);
        t.estado = Estado.Cancelado;
        _reembolsarRestante(id, t);
        emit TrabalhoCancelado(id);
    }

    // ------------------------------------------------------------------
    // Execução
    // ------------------------------------------------------------------

    /// @notice Check-in GPS do trabalhador no local (≤ 80 m). Coordenadas em microdegraus (graus × 1e6).
    function checkIn(uint256 id, int32 lat, int32 lon) external {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.trabalhador) revert NaoAutorizado();
        if (t.estado != Estado.Aceito) revert EstadoInvalido(t.estado);
        if (t.modalidade != Modalidade.Presencial && t.modalidade != Modalidade.Entrega) {
            revert ModalidadeInvalida();
        }
        uint256 d = distanciaMm(t.lat, t.lon, lat, lon);
        if (d > RAIO_MAX_MM) revert ForaDoRaio(d);
        t.checkin = true;
        emit CheckIn(id, msg.sender, lat, lon, d);
    }

    /// @notice Confirma com o código secreto do cliente/destinatário (PRESENCIAL/ENTREGA exigem check-in antes).
    /// Qualquer um pode submeter; o pagamento vai sempre para o trabalhador.
    function confirmarComCodigo(uint256 id, string calldata codigo) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (t.codigoHash == bytes32(0)) revert ModalidadeInvalida();
        if (t.estado != Estado.Aceito && t.estado != Estado.Entregue) revert EstadoInvalido(t.estado);
        bool presencial = t.modalidade == Modalidade.Presencial || t.modalidade == Modalidade.Entrega;
        if (presencial && !t.checkin) revert CheckInObrigatorio();
        if (hashCodigo(t.cliente, codigo) != t.codigoHash) revert CodigoIncorreto();
        _pagarTudo(id, t);
    }

    /// @notice Trabalhador marca a entrega (da etapa atual, se ETAPAS). Inicia a janela de revisão de 3 dias.
    function marcarEntregue(uint256 id) external {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.trabalhador) revert NaoAutorizado();
        if (t.estado != Estado.Aceito) revert EstadoInvalido(t.estado);
        if (t.modalidade == Modalidade.Entrega) revert ModalidadeInvalida(); // entrega exige código
        if (t.modalidade == Modalidade.Presencial && !t.checkin) revert CheckInObrigatorio();
        t.estado = Estado.Entregue;
        t.entregueEm = uint64(block.timestamp);
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
    // Disputa (sem árbitro)
    // ------------------------------------------------------------------

    function abrirDisputa(uint256 id) external {
        Trabalho storage t = _existente(id);
        if (msg.sender != t.cliente && msg.sender != t.trabalhador) revert NaoAutorizado();
        if (t.estado != Estado.Aceito && t.estado != Estado.Entregue) revert EstadoInvalido(t.estado);
        t.estado = Estado.Disputa;
        t.disputaEm = uint64(block.timestamp);
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

    /// @notice Sem acordo em 30 dias: qualquer pessoa executa a divisão 50/50 do restante.
    function resolverPorTempo(uint256 id) external nonReentrant {
        Trabalho storage t = _existente(id);
        if (t.estado != Estado.Disputa) revert EstadoInvalido(t.estado);
        uint256 venceEm = uint256(t.disputaEm) + PRAZO_DISPUTA;
        if (block.timestamp < venceEm) revert PrazoNaoVencido(venceEm);
        _resolver(id, t, 5_000, false);
    }

    // ------------------------------------------------------------------
    // Reputação
    // ------------------------------------------------------------------

    /// @notice Avaliação mútua (1 a 5 estrelas), uma vez por parte, após a conclusão.
    function avaliar(uint256 id, uint8 estrelas) external {
        Trabalho storage t = _existente(id);
        if (t.estado != Estado.Concluido) revert EstadoInvalido(t.estado);
        if (estrelas < 1 || estrelas > 5) revert EstrelasInvalidas();
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
        ++r.avaliacoes;
        r.somaEstrelas += estrelas;
        emit Avaliacao(id, msg.sender, avaliado, estrelas);
    }

    /// @notice Nível de reputação 0 a 5 (mesma regra usada pela carteira em escrow-client.js).
    function nivel(address conta) external view returns (uint8) {
        Reputacao memory r = reputacao[conta];
        if (r.concluidos == 0) return 0;
        uint256 media100 = r.avaliacoes == 0 ? 0 : (uint256(r.somaEstrelas) * 100) / r.avaliacoes;
        uint256 disputaBps = (uint256(r.disputas) * BPS) / (uint256(r.concluidos) + r.disputas);
        if (r.concluidos >= 100 && r.avaliacoes >= 50 && media100 >= 480 && disputaBps <= 200) return 5;
        if (r.concluidos >= 50 && r.avaliacoes >= 25 && media100 >= 450 && disputaBps <= 500) return 4;
        if (r.concluidos >= 20 && r.avaliacoes >= 10 && media100 >= 400 && disputaBps <= 1_000) return 3;
        if (r.concluidos >= 5 && r.avaliacoes >= 3 && media100 >= 350 && disputaBps <= 2_000) return 2;
        return 1;
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

    /// @notice Distância aproximada (equirretangular) em milímetros entre dois pontos em microdegraus.
    /// Erro < 0,1% para distâncias de até alguns quilômetros — mais que suficiente para o raio de 80 m.
    function distanciaMm(int32 lat1, int32 lon1, int32 lat2, int32 lon2) public pure returns (uint256) {
        int256 dLat = int256(lat2) - int256(lat1);
        int256 dLon = int256(lon2) - int256(lon1);
        if (dLon > 180_000_000) dLon -= 360_000_000;
        if (dLon < -180_000_000) dLon += 360_000_000;
        int256 latMediaRad = ((int256(lat1) + int256(lat2)) * PI_E18) / (2 * 180_000_000);
        int256 c = _cos(latMediaRad);
        int256 dyNm = dLat * NM_POR_MICRODEGRAU;
        int256 dxNm = (dLon * NM_POR_MICRODEGRAU * c) / E18;
        uint256 d2 = SafeCast.toUint256(dyNm * dyNm) + SafeCast.toUint256(dxNm * dxNm);
        return Math.sqrt(d2) / 1e6; // nm → mm
    }

    /// @dev cos(x) por série de Taylor (até x^12) em ponto fixo 1e18, |x| <= π/2.
    function _cos(int256 x) private pure returns (int256 soma) {
        int256 x2 = (x * x) / E18;
        int256 termo = E18;
        soma = E18;
        for (int256 n = 1; n <= 6; ++n) {
            termo = -(termo * x2) / E18 / ((2 * n - 1) * (2 * n));
            soma += termo;
        }
        if (soma < 0) soma = 0;
    }

    // ------------------------------------------------------------------
    // Internos de pagamento
    // ------------------------------------------------------------------

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
        ++reputacao[t.cliente].concluidos;
        ++reputacao[t.trabalhador].concluidos;
        _pagar(id, t.trabalhador, restante);
        emit TrabalhoConcluido(id, t.cliente, t.trabalhador);
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
        if (taxa != 0) XBRL.safeTransfer(CREATOR_TREASURY, taxa);
        XBRL.safeTransfer(para, bruto - taxa);
        emit Pagamento(id, para, bruto - taxa, taxa);
    }
}
