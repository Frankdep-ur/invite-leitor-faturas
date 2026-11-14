// Roda o robô contra o portal simulado PELO tsx (o mesmo caminho do `npm run teste-campo` no Mac).
// Usado por test/roboTsx.test.ts: o vitest transforma o código de outro jeito e não pega erros do tsx.
import { chromium } from 'playwright';
import { RoboNeoenergia } from '../src/robo/neoenergia.ts';
import { htmlFatura } from './faturaMock.ts';
import { BASE_MOCK, instalarPortal } from './portalMock.ts';

const b = await chromium.launch();
const pg = await b.newPage();
await pg.setContent(htmlFatura());
const pdf = Buffer.from(await pg.pdf({ format: 'A4' }));
await b.close();

const robo = new RoboNeoenergia({
  baseUrl: BASE_MOCK, headless: true, timeoutMs: 6000,
  aoCriarContexto: (ctx) => instalarPortal(ctx, 'resposta', pdf, { loginEmDialogo: true, ucEmCombobox: true }),
});
await robo.abrir();
const falha = await robo.login({ tipo: 'cpf', documento: '12345678901', senha: 'senha-certa', uf: 'SP' });
const mapa = await robo.mapaDaTela();
const fatura = falha ? null : await robo.baixarFatura('12345678');
await robo.fechar();
process.stdout.write(JSON.stringify({ login: falha?.status ?? 'ok', fatura: fatura?.status ?? null, mapaRota: (mapa as { rota?: string })?.rota ?? null, mapaErro: (mapa as { erro?: string })?.erro ?? null }) + '\n');
