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
  out(`  Layout reconhecido: ${l.layout ?? 'nenhum (leitura por rótulos)'}`);
  for (const c of l.cobertura) {
    const marca = c.valor !== null ? '✓ ' : c.ausenteNaFatura ? '· ' : c.obrigatorio ? '✗!' : '✗ ';
    const texto = c.valor !== null ? JSON.stringify(c.valor) : c.ausenteNaFatura ? '— não consta nesta fatura' : '— não encontrado';
    out(`  ${marca} ${c.campo.padEnd(24)} ${texto}${c.origem ? `   [${c.origem}]` : ''}`);
  }
  if (l.verificacoes.length) {
    out('  Verificações:');
    for (const v of l.verificacoes) out(`    ${v.ok ? 'OK   ' : 'FALHA'} ${v.nome}: ${v.detalhe}`);
  }
  for (const a of l.alertas) out(`  ALERTA: ${a}`);
  const lidos = l.cobertura.filter((c) => c.valor !== null).length;
  const aplicaveis = l.cobertura.filter((c) => !c.ausenteNaFatura).length;
  out(`  Cobertura: ${lidos}/${aplicaveis} campos presentes nesta fatura | utilizável para cobrança: ${l.utilizavel ? 'SIM' : 'NÃO'}`);
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
  // TESTE_SENHA_B64 é o que o "configurar" grava: base64 só evita problemas de aspas/# na senha (não é criptografia).
  if (!env.TESTE_SENHA && env.TESTE_SENHA_B64) env.TESTE_SENHA = Buffer.from(env.TESTE_SENHA_B64, 'base64').toString('utf8');
  const faltando = ['TESTE_LOGIN', 'TESTE_SENHA', 'TESTE_UC'].filter((k) => !env[k]);
  if (faltando.length) {
    throw new Error(`Faltam variáveis no .env.teste-campo: ${faltando.join(', ')}. Rode: npm run teste-campo -- configurar`);
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

// ---------------------------------------------------------------------------
// configurar: pergunta os dados da cliente-teste no Terminal (senha mascarada)
// ---------------------------------------------------------------------------
/** Sobra de entrada já digitada/colada (várias respostas de uma vez). */
let pendente = '';

function perguntar(pergunta: string, oculto = false): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(pergunta);
    const stdin = process.stdin;
    const tty = Boolean(stdin.isTTY);
    let valor = '';
    let ouvindo = false;
    const concluir = () => {
      if (ouvindo) {
        stdin.off('data', aoDigitar);
        if (tty) stdin.setRawMode(false);
        stdin.pause();
      }
      process.stdout.write('\n');
      resolve(valor.trim());
    };
    /** Processa caracteres; devolve true quando a resposta terminou (o resto fica em `pendente`). */
    const consumir = (texto: string): boolean => {
      for (let i = 0; i < texto.length; i++) {
        const c = texto[i]!;
        if (c === '\r' || c === '\n') {
          // "\r\n" (Enter do Windows) conta como UM fim de linha; "\n\n" são duas respostas.
          pendente = texto.slice(c === '\r' && texto[i + 1] === '\n' ? i + 2 : i + 1);
          return true;
        }
        if (c === '\u0003') {
          process.stdout.write('\ncancelado.\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') {
          if (valor) {
            valor = valor.slice(0, -1);
            if (tty) process.stdout.write('\b \b');
          }
          continue;
        }
        valor += c;
        if (tty) process.stdout.write(oculto ? '*' : c);
      }
      pendente = '';
      return false;
    };
    const aoDigitar = (pedaco: string) => {
      if (consumir(pedaco)) concluir();
    };
    if (pendente && consumir(pendente)) return concluir();
    ouvindo = true;
    if (tty) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', aoDigitar);
    // Entrada acabou (ex.: redirecionada) sem Enter final: usa o que veio.
    stdin.once('end', () => {
      if (ouvindo) concluir();
    });
    stdin.resume();
  });
}

export async function configurarTesteCampo(arquivo: string): Promise<void> {
  out('Configurar teste de campo — os dados ficam SÓ neste computador, no arquivo:');
  out(`  ${arquivo}\n`);
  try {
    await fs.access(arquivo);
    const r = await perguntar('Já existe uma configuração. Substituir? (s/N) ');
    if (!/^s/i.test(r)) {
      out('Mantida a configuração atual.');
      return;
    }
  } catch {
    /* não existe: segue */
  }

  let login = '';
  while (![11, 14].includes(apenasDigitos(login).length)) {
    login = await perguntar('CPF ou CNPJ de login da cliente na Agência Virtual: ');
    if (![11, 14].includes(apenasDigitos(login).length)) out('  -> precisa ter 11 (CPF) ou 14 (CNPJ) dígitos.');
  }
  const tipo = apenasDigitos(login).length === 14 ? 'cnpj' : 'cpf';
  let senha = '';
  while (!senha) senha = await perguntar('Senha da Agência Virtual (não aparece na tela): ', true);
  const uf = ((await perguntar('Estado [SP]: ')) || 'SP').toUpperCase();
  out('\nUC = "Número da Unidade Consumidora", no topo da fatura (ex.: 1.234.567.890-12).');
  out('NÃO use o "Código débito em conta" (8 dígitos, no canhoto). Pode pôr várias, separadas por vírgula.');
  let ucs = '';
  while (!ucs) {
    ucs = await perguntar('UC(s): ');
    for (const u of ucs.split(/[,;\s]+/).filter(Boolean)) {
      for (const a of normalizarUc(u).alertas) out(`  AVISO ${u}: ${a}`);
      if (apenasDigitos(u).length === 8) out(`  AVISO ${u}: 8 dígitos costuma ser o "código débito em conta", não a UC. Confira na fatura.`);
    }
  }

  const conteudo = [
    '# Gerado por: npm run teste-campo -- configurar',
    '# CONTÉM A SENHA DA CLIENTE. Não compartilhe; apague após o teste.',
    `TESTE_LOGIN=${apenasDigitos(login)}`,
    `TESTE_TIPO_LOGIN=${tipo}`,
    '# senha em base64 só para não quebrar com aspas ou # (base64 NÃO é criptografia)',
    `TESTE_SENHA_B64=${Buffer.from(senha, 'utf8').toString('base64')}`,
    `TESTE_UF=${uf}`,
    `TESTE_UC=${ucs.split(/[,;\s]+/).filter(Boolean).join(',')}`,
    'ROBO_HEADLESS=false',
    'ROBO_ASSISTIDO=true',
    'ROBO_ESPERA_ASSISTIDO_S=180',
    'ROBO_CANAL=chrome',
    'ROBO_TIMEOUT_S=25',
    '',
  ].join('\n');
  await fs.writeFile(arquivo, conteudo, { mode: 0o600 });
  await fs.chmod(arquivo, 0o600).catch(() => {});
  out(`\nPronto. Login ${tipo.toUpperCase()} ${mascararDoc(login)}, UF ${uf}, UC(s) ${ucs}.`);
  out('Agora rode:  npm run teste-campo -- robo');
}
