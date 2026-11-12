import { Pool, type PoolClient } from 'pg';
import type { Credencial, SituacaoCredencial, SituacaoUnidade, Unidade, UnidadeComContexto } from '../dominio.js';
import type { FaturaParaGravar, NovaPendencia, RegistroConsulta, Repositorio } from '../nucleo/portas.js';

const N = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Repositório Postgres. Todas as tabelas no schema `fatureiro`.
 *
 * Observação sobre concorrência: a seleção de unidades usa um "claim" otimista
 * (UPDATE ... RETURNING) empurrando `proxima_consulta_em` para o fim do dia, de
 * modo que dois processos de lote não peguem a mesma unidade. Com cron único é
 * indiferente; com múltiplos, evita trabalho duplicado.
 */
export class RepositorioPostgres implements Repositorio {
  constructor(private readonly pool: Pool) {}

  static async criar(databaseUrl: string): Promise<RepositorioPostgres> {
    const pool = new Pool({ connectionString: databaseUrl });
    await pool.query('SET search_path TO fatureiro, public');
    return new RepositorioPostgres(pool);
  }

  async fechar(): Promise<void> {
    await this.pool.end();
  }

  private mapUnidade(r: Record<string, unknown>): Unidade {
    return {
      id: r.id as string,
      credencialId: r.credencial_id as string,
      uc: r.uc as string,
      titularTipo: (r.titular_tipo as Unidade['titularTipo']) ?? null,
      titularDocumentoCifrado: (r.titular_documento_cifrado as string) ?? null,
      apelido: (r.apelido as string) ?? null,
      situacao: r.situacao as SituacaoUnidade,
      proximaConsultaEm: r.proxima_consulta_em ? new Date(r.proxima_consulta_em as string) : null,
      ultimoMesCapturado: r.ultimo_mes_capturado ? new Date(r.ultimo_mes_capturado as string) : null,
      cicloReferencia: r.ciclo_referencia ? new Date(r.ciclo_referencia as string) : null,
      tentativasCiclo: Number(r.tentativas_ciclo ?? 0),
    };
  }
  private mapCredencial(r: Record<string, unknown>): Credencial {
    return {
      id: r.id as string,
      clienteId: r.cliente_id as string,
      distribuidora: r.distribuidora as Credencial['distribuidora'],
      tipoLogin: r.tipo_login as Credencial['tipoLogin'],
      loginCifrado: r.login_cifrado as string,
      senhaCifrada: r.senha_cifrada as string,
      uf: (r.uf as string) ?? null,
      acessoImobiliaria: Boolean(r.acesso_imobiliaria),
      situacao: r.situacao as SituacaoCredencial,
    };
  }

  async listarUnidadesParaConsultar(limite: number, hoje: Date): Promise<UnidadeComContexto[]> {
    const hojeISO = hoje.toISOString().slice(0, 10);
    // Claim: marca as unidades pegando para o fim do dia e devolve-as, numa transação.
    const sql = `
      WITH alvo AS (
        SELECT u.id
        FROM fatureiro.unidades u
        JOIN fatureiro.credenciais c ON c.id = u.credencial_id
        WHERE u.situacao = 'ativa' AND c.situacao = 'ativa'
          AND (u.proxima_consulta_em IS NULL OR u.proxima_consulta_em <= $1::date)
        ORDER BY u.proxima_consulta_em ASC NULLS FIRST
        LIMIT $2
        FOR UPDATE OF u SKIP LOCKED
      )
      SELECT u.*, c.id AS c_id, c.cliente_id, c.distribuidora, c.tipo_login, c.login_cifrado,
             c.senha_cifrada, c.uf, c.acesso_imobiliaria, c.situacao AS c_situacao,
             cl.nome AS cliente_nome, cl.referencia_externa, cl.consentimento_em
      FROM alvo
      JOIN fatureiro.unidades u ON u.id = alvo.id
      JOIN fatureiro.credenciais c ON c.id = u.credencial_id
      JOIN fatureiro.clientes cl ON cl.id = c.cliente_id`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(sql, [hojeISO, limite]);
      await client.query('COMMIT');
      return rows.map((r) => ({
        unidade: this.mapUnidade(r),
        credencial: this.mapCredencial({
          id: r.c_id, cliente_id: r.cliente_id, distribuidora: r.distribuidora, tipo_login: r.tipo_login,
          login_cifrado: r.login_cifrado, senha_cifrada: r.senha_cifrada, uf: r.uf,
          acesso_imobiliaria: r.acesso_imobiliaria, situacao: r.c_situacao,
        }),
        cliente: {
          id: r.cliente_id as string,
          nome: r.cliente_nome as string,
          referenciaExterna: (r.referencia_externa as string) ?? null,
          consentimentoEm: r.consentimento_em ? new Date(r.consentimento_em as string) : null,
        },
      }));
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async buscarUnidadeComContexto(unidadeId: string): Promise<UnidadeComContexto | null> {
    const { rows } = await this.pool.query(
      `SELECT u.*, c.id AS c_id, c.cliente_id, c.distribuidora, c.tipo_login, c.login_cifrado,
              c.senha_cifrada, c.uf, c.acesso_imobiliaria, c.situacao AS c_situacao,
              cl.nome AS cliente_nome, cl.referencia_externa, cl.consentimento_em
       FROM fatureiro.unidades u
       JOIN fatureiro.credenciais c ON c.id = u.credencial_id
       JOIN fatureiro.clientes cl ON cl.id = c.cliente_id
       WHERE u.id = $1`,
      [unidadeId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      unidade: this.mapUnidade(r),
      credencial: this.mapCredencial({
        id: r.c_id, cliente_id: r.cliente_id, distribuidora: r.distribuidora, tipo_login: r.tipo_login,
        login_cifrado: r.login_cifrado, senha_cifrada: r.senha_cifrada, uf: r.uf,
        acesso_imobiliaria: r.acesso_imobiliaria, situacao: r.c_situacao,
      }),
      cliente: {
        id: r.cliente_id, nome: r.cliente_nome, referenciaExterna: r.referencia_externa ?? null,
        consentimentoEm: r.consentimento_em ? new Date(r.consentimento_em) : null,
      },
    };
  }

  async contarConsultasNoDia(unidadeId: string, hoje: Date): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM fatureiro.consultas
       WHERE unidade_id = $1 AND consultada_em::date = $2::date`,
      [unidadeId, hoje.toISOString().slice(0, 10)],
    );
    return rows[0]?.n ?? 0;
  }

  async faturaExiste(uc: string, mesReferencia: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM fatureiro.faturas WHERE uc = $1 AND mes_referencia = $2::date LIMIT 1`,
      [uc, mesReferencia],
    );
    return (rowCount ?? 0) > 0;
  }

  async gravarFatura(f: FaturaParaGravar): Promise<{ id: string; duplicada: boolean }> {
    const fa = f.fatura;
    const { rows } = await this.pool.query(
      `INSERT INTO fatureiro.faturas
        (unidade_id, distribuidora, uc, mes_referencia, valor, vencimento, conta_paga,
         consumo_kwh, energia_injetada_kwh, energia_compensada_kwh, saldo_creditos_kwh,
         leitura_data, proxima_leitura_data, dias_faturados, codigo_barras, tributos,
         nota_fiscal, itens, historico_consumo, dados_brutos, pdf_chave, pdf_sha256, pdf_baixado_em)
       VALUES ($1,$2,$3,$4::date,$5,$6::date,$7,$8,$9,$10,$11,$12::date,$13::date,$14,$15,
               $16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22,$23)
       ON CONFLICT (uc, mes_referencia) DO NOTHING
       RETURNING id`,
      [
        f.unidadeId, fa.distribuidora, fa.uc, fa.mesReferencia, fa.valor, fa.vencimento, fa.contaPaga,
        fa.consumoKwh, fa.energiaInjetadaKwh, fa.energiaCompensadaKwh, fa.saldoCreditosKwh,
        fa.leituraData, fa.proximaLeituraData, fa.diasFaturados, fa.codigoBarras,
        fa.tributos ? JSON.stringify(fa.tributos) : null,
        fa.notaFiscal ? JSON.stringify(fa.notaFiscal) : null,
        fa.itens ? JSON.stringify(fa.itens) : null,
        fa.historicoConsumo ? JSON.stringify(fa.historicoConsumo) : null,
        JSON.stringify(f.dadosBrutos),
        f.pdfChave, f.pdfSha256, f.pdfBaixadoEm,
      ],
    );
    const id = rows[0]?.id as string | undefined;
    return id ? { id, duplicada: false } : { id: '', duplicada: true };
  }

  async registrarConsulta(r: RegistroConsulta): Promise<void> {
    await this.pool.query(
      `INSERT INTO fatureiro.consultas
        (lote_id, unidade_id, credencial_id, servico, modo, request_id, code, code_message,
         billable, price, elapsed_ms, duracao_ms, acao, erros)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [
        r.loteId, r.unidadeId, r.credencialId, r.servico, r.modo, r.requestId ?? null, r.code, r.codeMessage,
        r.billable, r.price, r.elapsedMs, r.duracaoMs, r.acao, r.erros ? JSON.stringify(r.erros) : null,
      ],
    );
  }

  async atualizarSituacaoCredencial(id: string, situacao: SituacaoCredencial, motivo: string): Promise<void> {
    await this.pool.query(`UPDATE fatureiro.credenciais SET situacao=$2, motivo_situacao=$3 WHERE id=$1`, [id, situacao, motivo]);
  }
  async atualizarSituacaoUnidade(id: string, situacao: SituacaoUnidade, motivo: string): Promise<void> {
    await this.pool.query(`UPDATE fatureiro.unidades SET situacao=$2, motivo_situacao=$3 WHERE id=$1`, [id, situacao, motivo]);
  }
  async marcarTentativaCredencial(id: string, sucesso: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE fatureiro.credenciais SET ultima_tentativa_em=now()${sucesso ? ', ultimo_sucesso_em=now()' : ''} WHERE id=$1`,
      [id],
    );
  }

  async reagendarUnidade(unidadeId: string, proximaConsultaEm: Date): Promise<void> {
    await this.pool.query(`UPDATE fatureiro.unidades SET proxima_consulta_em=$2::date WHERE id=$1`, [unidadeId, proximaConsultaEm.toISOString().slice(0, 10)]);
  }

  async registrarSucessoUnidade(unidadeId: string, mesReferencia: string, proximaConsultaEm: Date): Promise<void> {
    await this.pool.query(
      `UPDATE fatureiro.unidades
       SET ultimo_mes_capturado=$2::date, proxima_consulta_em=$3::date, situacao='ativa', motivo_situacao=NULL
       WHERE id=$1`,
      [unidadeId, mesReferencia, proximaConsultaEm.toISOString().slice(0, 10)],
    );
  }

  async ajustarCiclo(unidadeId: string, cicloReferencia: string | null, tentativasCiclo: number): Promise<void> {
    await this.pool.query(
      `UPDATE fatureiro.unidades SET ciclo_referencia=$2::date, tentativas_ciclo=$3 WHERE id=$1`,
      [unidadeId, cicloReferencia, tentativasCiclo],
    );
  }

  async abrirPendencia(p: NovaPendencia): Promise<void> {
    await this.pool.query(
      `INSERT INTO fatureiro.pendencias (tipo, unidade_id, credencial_id, code, mensagem, detalhes)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [p.tipo, p.unidadeId ?? null, p.credencialId ?? null, p.code ?? null, p.mensagem, p.detalhes ? JSON.stringify(p.detalhes) : null],
    );
  }

  async gastoNoMes(ano: number, mes: number): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(price),0)::float AS gasto FROM fatureiro.consultas
       WHERE billable = true
         AND date_part('year', consultada_em) = $1 AND date_part('month', consultada_em) = $2`,
      [ano, mes],
    );
    return N(rows[0]?.gasto) ?? 0;
  }

  async lerTetoMensal(padrao: number): Promise<number> {
    const { rows } = await this.pool.query(`SELECT valor FROM fatureiro.configuracoes WHERE chave='teto_mensal_brl'`);
    const v = rows[0]?.valor;
    return v != null ? Number(v) : padrao;
  }

  async criarLote(dryRun: boolean): Promise<string> {
    const { rows } = await this.pool.query(`INSERT INTO fatureiro.lotes (dry_run) VALUES ($1) RETURNING id`, [dryRun]);
    return rows[0].id as string;
  }

  async finalizarLote(
    loteId: string,
    resumo: { total: number; gravadas: number; duplicadas: number; erros: number; gasto: number; interrompidoMotivo: string | null },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE fatureiro.lotes
       SET finalizado_em=now(), total_unidades=$2, gravadas=$3, duplicadas=$4, erros=$5, gasto_brl=$6, interrompido_motivo=$7
       WHERE id=$1`,
      [loteId, resumo.total, resumo.gravadas, resumo.duplicadas, resumo.erros, resumo.gasto, resumo.interrompidoMotivo],
    );
  }

  // Leitura de pendências para a operação / CLI.
  async listarPendenciasAbertas(): Promise<Record<string, unknown>[]> {
    const { rows } = await this.pool.query(
      `SELECT p.tipo, p.code, p.mensagem, p.criada_em, u.uc, cl.nome AS cliente
       FROM fatureiro.pendencias p
       LEFT JOIN fatureiro.unidades u ON u.id = p.unidade_id
       LEFT JOIN fatureiro.credenciais c ON c.id = COALESCE(p.credencial_id, u.credencial_id)
       LEFT JOIN fatureiro.clientes cl ON cl.id = c.cliente_id
       WHERE p.resolvida_em IS NULL
       ORDER BY p.criada_em DESC`,
    );
    return rows;
  }

  pool_(): Pool {
    return this.pool;
  }
  async withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }
}
