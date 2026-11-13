import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { RoboNeoenergia, extrairPdfDeCorpo, type OpcoesRobo } from '../src/robo/neoenergia.js';
import { extrairTextoPdf } from '../src/leitor/pdfTexto.js';
import { lerFaturaNeoenergia } from '../src/leitor/faturaNeoenergia.js';
import { htmlFatura } from './faturaMock.js';
import { BASE_MOCK, instalarPortal, type ModoPortal } from './portalMock.js';

let PDF: Buffer;

beforeAll(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(htmlFatura());
  PDF = Buffer.from(await p.pdf({ format: 'A4' }));
  await b.close();
});

const CRED = { tipo: 'cpf' as const, documento: '123.456.789-01', senha: 'senha-certa', uf: 'SP' };

async function rodar(modo: ModoPortal, uc: string, extra: Partial<OpcoesRobo> = {}, cred = CRED) {
  const robo = new RoboNeoenergia({
    baseUrl: BASE_MOCK,
    headless: true,
    timeoutMs: 8_000,
    aoCriarContexto: (ctx) => instalarPortal(ctx, modo, PDF),
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
    expect(arquivos.some((a) => a.endsWith('login_aberto.png'))).toBe(true);
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
