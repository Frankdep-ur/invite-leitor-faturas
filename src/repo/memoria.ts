import crypto from 'node:crypto';
import type { Cliente, Credencial, SituacaoCredencial, SituacaoUnidade, Unidade, UnidadeComContexto } from '../dominio.js';
import type { FaturaParaGravar, NovaPendencia, RegistroConsulta, Repositorio } from '../nucleo/portas.js';
import { mesParaData } from '../nucleo/mesReferencia.js';

interface FaturaMem {
  id: string;
  unidadeId: string;
  uc: string;
  mesReferencia: string;
}

/**
 * Repositório em memória: referência do contrato e base dos testes.
 * Mesmas regras de elegibilidade e dedup do Postgres.
 */
export class RepositorioMemoria implements Repositorio {
  clientes = new Map<string, Cliente>();
  credenciais = new Map<string, Credencial>();
  unidades = new Map<string, Unidade>();
  faturas: FaturaMem[] = [];
  consultas: (RegistroConsulta & { consultadaEm: Date })[] = [];
  pendencias: (NovaPendencia & { criadaEm: Date })[] = [];
  lotes = new Map<string, { dryRun: boolean }>();
  config = new Map<string, string>();

  // ---- helpers de montagem para testes -------------------------------------
  addCliente(p: Partial<Cliente> & { nome: string }): Cliente {
    const c: Cliente = { id: p.id ?? crypto.randomUUID(), nome: p.nome, referenciaExterna: p.referenciaExterna ?? null, consentimentoEm: p.consentimentoEm ?? new Date() };
    this.clientes.set(c.id, c);
    return c;
  }
  addCredencial(p: Partial<Credencial> & { clienteId: string; distribuidora: Credencial['distribuidora']; loginCifrado: string; senhaCifrada: string }): Credencial {
    const c: Credencial = {
      id: p.id ?? crypto.randomUUID(),
      clienteId: p.clienteId,
      distribuidora: p.distribuidora,
      tipoLogin: p.tipoLogin ?? 'cpf',
      loginCifrado: p.loginCifrado,
      senhaCifrada: p.senhaCifrada,
      uf: p.uf ?? null,
      acessoImobiliaria: p.acessoImobiliaria ?? false,
      situacao: p.situacao ?? 'ativa',
    };
    this.credenciais.set(c.id, c);
    return c;
  }
  addUnidade(p: Partial<Unidade> & { credencialId: string; uc: string }): Unidade {
    const u: Unidade = {
      id: p.id ?? crypto.randomUUID(),
      credencialId: p.credencialId,
      uc: p.uc,
      titularTipo: p.titularTipo ?? null,
      titularDocumentoCifrado: p.titularDocumentoCifrado ?? null,
      apelido: p.apelido ?? null,
      situacao: p.situacao ?? 'ativa',
      proximaConsultaEm: p.proximaConsultaEm ?? null,
      ultimoMesCapturado: p.ultimoMesCapturado ?? null,
      cicloReferencia: p.cicloReferencia ?? null,
      tentativasCiclo: p.tentativasCiclo ?? 0,
    };
    this.unidades.set(u.id, u);
    return u;
  }

  private contexto(u: Unidade): UnidadeComContexto | null {
    const credencial = this.credenciais.get(u.credencialId);
    if (!credencial) return null;
    const cliente = this.clientes.get(credencial.clienteId);
    if (!cliente) return null;
    return { unidade: u, credencial, cliente };
  }

  // ---- Repositorio ---------------------------------------------------------
  async listarUnidadesParaConsultar(limite: number, hoje: Date): Promise<UnidadeComContexto[]> {
    const hojeFim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate(), 23, 59, 59));
    const out: UnidadeComContexto[] = [];
    for (const u of this.unidades.values()) {
      if (u.situacao !== 'ativa') continue;
      const cred = this.credenciais.get(u.credencialId);
      if (!cred || cred.situacao !== 'ativa') continue;
      if (u.proximaConsultaEm && u.proximaConsultaEm.getTime() > hojeFim.getTime()) continue;
      const ctx = this.contexto(u);
      if (ctx) out.push(ctx);
      if (out.length >= limite) break;
    }
    return out;
  }

  async buscarUnidadeComContexto(unidadeId: string): Promise<UnidadeComContexto | null> {
    const u = this.unidades.get(unidadeId);
    return u ? this.contexto(u) : null;
  }

  async contarConsultasNoDia(unidadeId: string, hoje: Date): Promise<number> {
    const ini = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
    const fim = new Date(ini.getTime() + 86_400_000);
    return this.consultas.filter(
      (c) => c.unidadeId === unidadeId && c.consultadaEm >= ini && c.consultadaEm < fim,
    ).length;
  }

  private existeSync(uc: string, mesReferencia: string): boolean {
    const alvo = mesParaData(mesReferencia)?.getTime();
    return this.faturas.some((f) => f.uc === uc && mesParaData(f.mesReferencia)?.getTime() === alvo);
  }

  async faturaExiste(uc: string, mesReferencia: string): Promise<boolean> {
    return this.existeSync(uc, mesReferencia);
  }

  async gravarFatura(f: FaturaParaGravar): Promise<{ id: string; duplicada: boolean }> {
    // Sem await entre checar e inserir: imita a atomicidade do UNIQUE do Postgres.
    if (this.existeSync(f.fatura.uc, f.fatura.mesReferencia)) {
      return { id: '', duplicada: true };
    }
    const id = crypto.randomUUID();
    this.faturas.push({ id, unidadeId: f.unidadeId, uc: f.fatura.uc, mesReferencia: f.fatura.mesReferencia });
    return { id, duplicada: false };
  }

  async registrarConsulta(r: RegistroConsulta): Promise<void> {
    this.consultas.push({ ...r, consultadaEm: new Date() });
  }

  async atualizarSituacaoCredencial(id: string, situacao: SituacaoCredencial, _motivo: string): Promise<void> {
    const c = this.credenciais.get(id);
    if (c) c.situacao = situacao;
  }
  async atualizarSituacaoUnidade(id: string, situacao: SituacaoUnidade, _motivo: string): Promise<void> {
    const u = this.unidades.get(id);
    if (u) u.situacao = situacao;
  }
  async marcarTentativaCredencial(_id: string, _sucesso: boolean): Promise<void> {}

  async reagendarUnidade(unidadeId: string, proximaConsultaEm: Date): Promise<void> {
    const u = this.unidades.get(unidadeId);
    if (u) u.proximaConsultaEm = proximaConsultaEm;
  }

  async registrarSucessoUnidade(unidadeId: string, mesReferencia: string, proximaConsultaEm: Date): Promise<void> {
    const u = this.unidades.get(unidadeId);
    if (!u) return;
    u.ultimoMesCapturado = mesParaData(mesReferencia);
    u.proximaConsultaEm = proximaConsultaEm;
    u.situacao = 'ativa';
  }

  async ajustarCiclo(unidadeId: string, cicloReferencia: string | null, tentativasCiclo: number): Promise<void> {
    const u = this.unidades.get(unidadeId);
    if (!u) return;
    u.cicloReferencia = cicloReferencia ? mesParaData(cicloReferencia) : null;
    u.tentativasCiclo = tentativasCiclo;
  }

  async abrirPendencia(p: NovaPendencia): Promise<void> {
    this.pendencias.push({ ...p, criadaEm: new Date() });
  }

  async gastoNoMes(ano: number, mes: number): Promise<number> {
    return this.consultas
      .filter((c) => c.billable && c.consultadaEm.getUTCFullYear() === ano && c.consultadaEm.getUTCMonth() + 1 === mes)
      .reduce((s, c) => s + (c.price ?? 0), 0);
  }

  async lerTetoMensal(padrao: number): Promise<number> {
    const v = this.config.get('teto_mensal_brl');
    return v != null ? Number(v) : padrao;
  }

  async criarLote(dryRun: boolean): Promise<string> {
    const id = crypto.randomUUID();
    this.lotes.set(id, { dryRun });
    return id;
  }
  async finalizarLote(): Promise<void> {}

  // Atalhos de leitura para testes
  pendenciasAbertas(tipo?: NovaPendencia['tipo']) {
    return this.pendencias.filter((p) => !tipo || p.tipo === tipo);
  }
}
