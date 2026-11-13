import { promises as fs } from 'node:fs';
import path from 'node:path';
import { extrairTextoPdf } from './leitor/pdfTexto.js';
import { lerFaturaNeoenergia, type LeituraFatura } from './leitor/faturaNeoenergia.js';
import { RoboNeoenergia, type OpcoesRobo } from './robo/neoenergia.js';
import { ClienteInfosimples } from './infosimples/cliente.js';
import { normalizar } from './infosimples/normalizar.js';
import { normalizarUc, apenasDigitos } from './nucleo/uc.js';

/**
 * TESTE DE CAMPO — valida o robô e o leitor contra o portal e faturas REAIS,
 * sem banco de dados e sem gravar nada fora de `dados/teste-campo/<data-hora>/`.
 *
 *   teste-campo pdf --arquivo fatura.pdf [--uc 12345678]   só o leitor (sem rede)
 *   teste-campo robo                                      robô + leitor (lê TESTE_* do ambiente)
 *   teste-campo infosimples                               1 consulta paga + compara com o leitor próprio
 *
 * A pasta de saída tem o PDF, o texto extraído, o relatório JSON e (no robô) o
 * rastreio com prints. CONTÉM DADOS DO CLIENTE: é local (o git ignora `dados/`)
 * e deve ser apagada depois da calibração.
 */

export interface SaidaTeste {
  dir: string;
  ok: boolean;
}

const out = (s = '') => process.stdout.write(s + '\n');

function carimbo(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function mascararDoc(doc: string): string {
  const d = apenasDigitos(doc);
  return d.length <= 4 ? '****' : `${'*'.repeat(d.length - 4)}${d.slice(-4)}`;
}

export function imprimirLeitura(l: LeituraFatura, titulo: string): void {
  out(`\n=== ${titulo} ===`);
  for (const c of l.cobertura) {
    const marca = c.valor === null ? (c.obrigatorio ? '✗!' : '✗ ') : '✓ ';
    out(`  ${marca} ${c.campo.padEnd(24)} ${c.valor === null ? '— não encontrado' : JSON.stringify(c.valor)}${c.origem ? `   [${c.origem}]` : ''}`);
  }
  if (l.verificacoes.length) {
    out('  Verificações:');
    for (const v of l.verificacoes) out(`    ${v.ok ? 'OK   ' : 'FALHA'} ${v.nome}: ${v.detalhe}`);
  }
  for (const a of l.alertas) out(`  ALERTA: ${a}`);
  const lidos = l.cobertura.filter((c) => c.valor !== null).length;
  out(`  Cobertura: ${lidos}/${l.cobertura.length} campos | utilizável para cobrança: ${l.utilizavel ? 'SIM' : 'NÃO'}`);
}

async function lerPdfESalvar(pdf: Buffer, dir: string, nome: string, ucEsperada?: string): Promise<LeituraFatura> {
  await fs.writeFile(path.join(dir, `${nome}.pdf`), pdf);
  const { texto, numPaginas } = await extrairTextoPdf(pdf);
  await fs.writeFile(path.join(dir, `${nome}.texto.txt`), texto);
  const leitura = lerFaturaNeoenergia(texto, ucEsperada ? { ucEsperada } : {});
  await fs.writeFile(path.join(dir, `${nome}.relatorio.json`), JSON.stringify({ numPaginas, ...leitura }, null, 2));
  return leitura;
}

async function novaPasta(base: string): Promise<string> {
  const dir = path.resolve(base, 'teste-campo', carimbo());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
export async function testeCampoPdf(arquivo: string, uc: string | undefined, baseDados: string): Promise<SaidaTeste> {
  const dir = await novaPasta(baseDados);
  const pdf = await fs.readFile(arquivo);
  const leitura = await lerPdfESalvar(pdf, dir, 'fatura', uc);
  imprimirLeitura(leitura, `Leitor próprio — ${path.basename(arquivo)}`);
  out(`\nArquivos em: ${dir}`);
  out('  (o .texto.txt é o que o leitor "vê": é com ele que se calibram os padrões)');
  return { dir, ok: leitura.utilizavel };
}

// ---------------------------------------------------------------------------
export interface EntradaTesteRobo {
  login: string;
  senha: string;
  tipoLogin: 'cpf' | 'cnpj';
  uf: string;
  ucs: string[];
}

export function lerEntradaTeste(env: NodeJS.ProcessEnv): EntradaTesteRobo {
  const faltando = ['TESTE_LOGIN', 'TESTE_SENHA', 'TESTE_UC'].filter((k) => !env[k]);
  if (faltando.length) {
    throw new Error(`Faltam variáveis no .env.teste-campo: ${faltando.join(', ')}. Veja .env.teste-campo.example.`);
  }
  const tipo = (env.TESTE_TIPO_LOGIN || (apenasDigitos(env.TESTE_LOGIN!).length === 14 ? 'cnpj' : 'cpf')).toLowerCase();
  if (tipo !== 'cpf' && tipo !== 'cnpj') throw new Error('TESTE_TIPO_LOGIN deve ser cpf ou cnpj.');
  const ucs = env.TESTE_UC!.split(/[,;\s]+/).filter(Boolean);
  for (const u of ucs) {
    const n = normalizarUc(u);
    for (const a of n.alertas) out(`AVISO UC ${u}: ${a}`);
  }
  return { login: env.TESTE_LOGIN!, senha: env.TESTE_SENHA!, tipoLogin: tipo, uf: (env.TESTE_UF || 'SP').toUpperCase(), ucs };
}

export async function testeCampoRobo(entrada: EntradaTesteRobo, opcoes: OpcoesRobo, baseDados: string): Promise<SaidaTeste> {
  const dir = await novaPasta(baseDados);
  const robo = new RoboNeoenergia({ ...opcoes, rastreioDir: path.join(dir, 'rastreio'), log: (m) => out(`  [robô] ${m}`) });
  out(`Teste de campo — robô próprio`);
  out(`  login ${entrada.tipoLogin.toUpperCase()} ${mascararDoc(entrada.login)} | UF ${entrada.uf} | UCs: ${entrada.ucs.join(', ')}`);
  out(`  janela visível: ${opcoes.headless ? 'não' : 'sim'} | modo assistido: ${opcoes.assistido ? 'sim' : 'não'}`);
  const resumo: Record<string, unknown>[] = [];
  let ok = true;
  await robo.abrir();
  try {
    const falha = await robo.login({ tipo: entrada.tipoLogin, documento: entrada.login, senha: entrada.senha, uf: entrada.uf });
    if (falha) {
      out(`\nLOGIN NÃO CONCLUÍDO: ${falha.status} — ${falha.detalhe}`);
      resumo.push({ fase: 'login', status: falha.status, detalhe: falha.detalhe, etapa: falha.etapa });
      ok = false;
    } else {
      out('  Login OK.');
      for (const uc of entrada.ucs) {
        const r = await robo.baixarFatura(uc);
        if (r.status !== 'ok' || !r.pdf) {
          out(`\nUC ${uc}: ${r.status} — ${r.detalhe}`);
          resumo.push({ uc, status: r.status, detalhe: r.detalhe, etapa: r.etapa });
          ok = false;
          continue;
        }
        const leitura = await lerPdfESalvar(r.pdf, dir, `uc-${apenasDigitos(uc)}`, uc);
        imprimirLeitura(leitura, `UC ${uc} (PDF via ${r.origemPdf}, ${r.pdf.length} bytes)`);
        resumo.push({ uc, status: 'ok', origemPdf: r.origemPdf, utilizavel: leitura.utilizavel, faltando: leitura.cobertura.filter((c) => c.valor === null).map((c) => c.campo) });
        ok &&= leitura.utilizavel;
      }
    }
  } finally {
    await robo.fechar();
    await fs.writeFile(path.join(dir, 'resumo.json'), JSON.stringify(resumo, null, 2));
  }
  out(`\nEtapas percorridas: ${robo.rastreio.etapas.join(' → ')}`);
  out(`Arquivos em: ${dir}`);
  out('  rastreio/ tem prints e o mapa de cada tela (sem senha) — é com ele que se calibram os seletores.');
  out('  ATENÇÃO: contém dados do cliente. Apague a pasta após a calibração.');
  return { dir, ok };
}

// ---------------------------------------------------------------------------
export async function testeCampoInfosimples(entrada: EntradaTesteRobo, cliente: ClienteInfosimples, baseDados: string): Promise<SaidaTeste> {
  const dir = await novaPasta(baseDados);
  const uc = entrada.ucs[0]!;
  out(`Teste de campo — Infosimples (1 consulta PAGA) para a UC ${uc}`);
  const params: Record<string, string> = { login_senha: entrada.senha, uf: entrada.uf, uc: apenasDigitos(uc) };
  params[entrada.tipoLogin === 'cnpj' ? 'login_cnpj' : 'login_cpf'] = apenasDigitos(entrada.login);
  const r = await cliente.consultar('contas/neoenergia/download-ocr', params);
  await fs.writeFile(path.join(dir, 'infosimples.json'), JSON.stringify(r.brutoSemParametros, null, 2));
  out(`  code ${r.code} (${r.codeMessage}) | cobrado: ${r.billable ? 'sim' : 'não'} | preço R$ ${r.price.toFixed(2)} | ${r.duracaoMs} ms`);
  if (r.code !== 200) {
    for (const e of r.errors) out(`  erro (uso interno): ${e}`);
    return { dir, ok: false };
  }
  const deles = normalizar('neoenergia', r.data);
  out('\n=== OCR da Infosimples (normalizado) ===');
  out(JSON.stringify(deles, null, 2));
  const url = r.siteReceipts[0];
  if (url) {
    const resp = await fetch(url);
    const pdf = Buffer.from(await resp.arrayBuffer());
    const nosso = await lerPdfESalvar(pdf, dir, 'fatura', uc);
    imprimirLeitura(nosso, 'Leitor PRÓPRIO no mesmo PDF');
    if (deles) {
      out('\n=== Comparação (Infosimples x leitor próprio) ===');
      const pares: [string, unknown, unknown][] = [
        ['uc', deles.uc, nosso.fatura.uc],
        ['mes_referencia', deles.mesReferencia, nosso.fatura.mesReferencia],
        ['valor', deles.valor, nosso.fatura.valor],
        ['vencimento', deles.vencimento, nosso.fatura.vencimento],
        ['proxima_leitura', deles.proximaLeituraData, nosso.fatura.proximaLeituraData],
        ['consumo_kwh', deles.consumoKwh, nosso.fatura.consumoKwh],
      ];
      for (const [campo, a, b] of pares) out(`  ${String(a) === String(b) ? 'IGUAL    ' : 'DIFERENTE'} ${campo.padEnd(16)} infosimples=${JSON.stringify(a)}  nosso=${JSON.stringify(b)}`);
    }
  }
  out(`\nArquivos em: ${dir}`);
  return { dir, ok: true };
}
