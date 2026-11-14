import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { RoboNeoenergia, extrairPdfDeCorpo, regexNumeroInteiro, type OpcoesRobo } from '../src/robo/neoenergia.js';
import { extrairTextoPdf } from '../src/leitor/pdfTexto.js';
import { lerFaturaNeoenergia } from '../src/leitor/faturaNeoenergia.js';
import { htmlFatura } from './faturaMock.js';
import { BASE_MOCK, instalarPortal, type ModoPortal, type OpcoesPortal } from './portalMock.js';

let PDF: Buffer;

beforeAll(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(htmlFatura());
  PDF = Buffer.from(await p.pdf({ format: 'A4' }));
  await b.close();
});

const CRED = { tipo: 'cpf' as const, documento: '123.456.789-01', senha: 'senha-certa', uf: 'SP' };

async function rodar(modo: ModoPortal, uc: string, extra: Partial<OpcoesRobo> = {}, cred = CRED, portal: OpcoesPortal = {}) {
  const robo = new RoboNeoenergia({
    baseUrl: BASE_MOCK,
    headless: true,
    timeoutMs: 8_000,
    aoCriarContexto: (ctx) => instalarPortal(ctx, modo, PDF, portal),
    ...extra,
  });
  await robo.abrir();
  try {
    const falhaLogin = await robo.login(cred);
    if (falhaLogin) return falhaLogin;
    return await robo.baixarFatura(uc);
  } finally {
    await robo.fechar();
  }
}

describe('extrairPdfDeCorpo', () => {
  it('aceita PDF cru, JSON com base64 e data URL; recusa o resto', () => {
    const pdf = Buffer.from('%PDF-1.4\n' + 'x'.repeat(300));
    const b64 = pdf.toString('base64');
    expect(extrairPdfDeCorpo(pdf)).toEqual(pdf);
    expect(extrairPdfDeCorpo(Buffer.from(JSON.stringify({ fileData: b64 })))).toEqual(pdf);
    expect(extrairPdfDeCorpo(Buffer.from(`"data:application/pdf;base64,${b64}"`))).toEqual(pdf);
    expect(extrairPdfDeCorpo(Buffer.from('{"ok":true}'))).toBeNull();
  });
});

describe('regexNumeroInteiro (achar a UC na tela)', () => {
  it.each([
    ['7654321', '987.654.321-09', false], // número dentro de outro número: NÃO pode casar
    ['7654321', 'Código do Cliente 7654321', true],
    ['12345678901', '123.456.789-01', true],
    ['12345678901', '0123.456.789-01', true], // zero à esquerda
    ['12345678901', '9123.456.789-01', false],
    ['123456789012', '1.234.567.890-12', true],
    ['12345678', 'Instalação 1234.5678', true],
    ['12345678', '12345678901', false],
  ])('%s em %s => %s', (digitos, texto, esperado) => {
    expect(regexNumeroInteiro(digitos).test(texto)).toBe(esperado);
  });
});

describe('Robô contra portal simulado', () => {
  it('caminho feliz: login + UF + UC + 2ª via + PDF da resposta, e o leitor lê a fatura', async () => {
    const r = await rodar('resposta', '1234.5678');
    expect(r.status).toBe('ok');
    expect(r.origemPdf).toBe('resposta');
    const leitura = lerFaturaNeoenergia((await extrairTextoPdf(r.pdf!)).texto, { ucEsperada: '12345678' });
    expect(leitura.utilizavel).toBe(true);
    expect(leitura.fatura.valor).toBe(1234.56);
    expect(leitura.fatura.energiaInjetadaKwh).toBe(1150);
    expect(leitura.verificacoes.every((v) => v.ok)).toBe(true);
  });

  it('PDF por download (Blob local, sem rede)', async () => {
    const r = await rodar('download', '12345678');
    expect(r.status).toBe('ok');
    expect(r.origemPdf).toBe('download');
    expect(r.pdf!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('senha errada: login_recusado e não insiste', async () => {
    const r = await rodar('resposta', '12345678', {}, { ...CRED, senha: 'errada' });
    expect(r.status).toBe('login_recusado');
    expect(r.detalhe).toMatch(/Senha inválida/);
  });

  it('formato do portal real: clica LOGIN no topo, preenche o diálogo (campos sem id conhecido) e baixa', async () => {
    const r = await rodar('resposta', '12345678', {}, CRED, { loginEmDialogo: true });
    // Passa por: abrir o diálogo, não digitar no campo-isca de CPF fora dele,
    // e não confundir o texto fixo "Dados incorretos..." com recusa de login.
    expect(r.status).toBe('ok');
    expect(r.pdf!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('formato do portal real com senha errada: login_recusado pela mensagem NOVA', async () => {
    const r = await rodar('resposta', '12345678', {}, { ...CRED, senha: 'errada' }, { loginEmDialogo: true });
    expect(r.status).toBe('login_recusado');
    expect(r.detalhe).toMatch(/Usuário ou senha inválidos/);
    expect(r.detalhe).not.toMatch(/Dados incorretos impedem/);
  });

  it('UC dentro de lista suspensa (combobox): abre a lista e escolhe a UC', async () => {
    const r = await rodar('resposta', '12345678', {}, CRED, { loginEmDialogo: true, ucEmCombobox: true });
    expect(r.status).toBe('ok');
  });

  async function rodarReal(uc: string, extra: OpcoesPortal = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'real-'));
    const robo = new RoboNeoenergia({
      baseUrl: BASE_MOCK, headless: true, timeoutMs: 6_000, rastreioDir: dir,
      aoCriarContexto: (ctx) => instalarPortal(ctx, 'resposta', PDF, { estiloReal: true, ...extra }),
    });
    await robo.abrir();
    try {
      expect(await robo.login(CRED)).toBeNull();
      const r = await robo.baixarFatura(uc);
      return { r, etapas: [...robo.rastreio.etapas] };
    } finally {
      await robo.fechar();
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it('PORTAL REAL (caminho do vídeo): lista de UCs → UC → Faturas e 2ª via → Mais opções → Download → BAIXAR', async () => {
    const { r, etapas } = await rodarReal('123.456.789-01');
    expect(r.status).toBe('ok');
    for (const e of ['meus_imoveis', 'uc_selecionada', 'servico_faturas', 'opcoes_fatura', 'janela_baixar', 'pdf_capturado']) expect(etapas).toContain(e);
    expect(etapas).not.toContain('inicio_busca'); // não precisou da busca genérica
  });

  it('PORTAL REAL com a lista de UCs demorando a carregar ("Aguarde um instante...")', async () => {
    const { r, etapas } = await rodarReal('123.456.789-01', { listaLenta: true });
    expect(r.status).toBe('ok');
    expect(etapas).toContain('meus_imoveis');
    expect(etapas).not.toContain('meus_imoveis_nao_abriu');
  });

  it('PORTAL REAL com o código ANTIGO do cliente (7 dígitos): acha pela pesquisa e baixa', async () => {
    const { r, etapas } = await rodarReal('7654321');
    expect(r.status).toBe('ok');
    expect(etapas).toContain('pesquisa_uc');
  });

  it('PORTAL REAL com UC que não é do login: uc_nao_encontrada, sem baixar nada', async () => {
    const { r } = await rodarReal('55555555555');
    expect(r.status).toBe('uc_nao_encontrada');
    expect(r.pdf).toBeUndefined();
  });

  it('página de bloqueio do CDN: bloqueado, sem tentar contornar', async () => {
    const r = await rodar('bloqueado', '12345678');
    expect(r.status).toBe('bloqueado');
  });

  it('UC que não pertence ao login: uc_nao_encontrada', async () => {
    const r = await rodar('resposta', '55554444');
    expect(r.status).toBe('uc_nao_encontrada');
  });

  it('UC sem fatura disponível: sem_fatura', async () => {
    const r = await rodar('resposta', '99990000');
    expect(r.status).toBe('sem_fatura');
  });

  it('rastreio grava prints e mapas sem senha e rede com números mascarados', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rastreio-'));
    const r = await rodar('resposta', '12345678', { rastreioDir: dir });
    expect(r.status).toBe('ok');
    const arquivos = await fs.readdir(dir);
    expect(arquivos.some((a) => a.endsWith('login_formulario.png'))).toBe(true);
    expect(arquivos.some((a) => a.endsWith('pdf_capturado.json'))).toBe(true);
    const tudo = (await Promise.all(arquivos.filter((a) => a.endsWith('.json')).map((a) => fs.readFile(path.join(dir, a), 'utf8')))).join('\n');
    expect(tudo).not.toContain('senha-certa');
    expect(tudo).not.toContain('12345678901');
    const rede = await fs.readFile(path.join(dir, 'rede.json'), 'utf8');
    expect(rede).toContain('/api/ucs/<num>/faturas/1/pdf');
    expect(rede).not.toContain('12345678');
    await fs.rm(dir, { recursive: true, force: true });
  });
});
