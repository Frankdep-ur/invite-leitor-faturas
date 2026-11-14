import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Robô rodando pelo tsx (caminho real do npm run teste-campo)', () => {
  it('login, mapa da tela e fatura funcionam (sem "__name is not defined" dentro da página)', async () => {
    const { stdout } = await exec(process.execPath, [path.join(raiz, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(raiz, 'test', 'sondaTsx.mts')], { cwd: raiz, timeout: 90_000 });
    const r = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(r.mapaErro).toBeNull();
    expect(r.mapaRota).toBe('#/home');
    expect(r.login).toBe('ok');
    expect(r.fatura).toBe('ok');
  }, 120_000);
});
