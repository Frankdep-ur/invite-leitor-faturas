import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { Cofre, ErroCofre, derivarChave, hashLogin } from '../src/cofre.js';

const chaveHex = crypto.randomBytes(32).toString('hex');

describe('Cofre AES-256-GCM', () => {
  it('cifra e decifra (round-trip)', () => {
    const cofre = new Cofre(chaveHex);
    const segredo = 'Senha#Forte!123';
    const cifrado = cofre.cifrar(segredo);
    expect(cifrado).not.toContain(segredo);
    expect(cofre.decifrar(cifrado)).toBe(segredo);
  });

  it('cada cifragem gera IV diferente (não determinística)', () => {
    const cofre = new Cofre(chaveHex);
    expect(cofre.cifrar('x')).not.toBe(cofre.cifrar('x'));
  });

  it('detecta adulteração (GCM tag)', () => {
    const cofre = new Cofre(chaveHex);
    const cifrado = cofre.cifrar('abc');
    const bytes = Buffer.from(cifrado, 'base64url');
    bytes[bytes.length - 1] ^= 0xff; // corrompe o último byte do ciphertext
    expect(() => cofre.decifrar(bytes.toString('base64url'))).toThrow(ErroCofre);
  });

  it('falha com chave errada', () => {
    const a = new Cofre(chaveHex);
    const b = new Cofre(crypto.randomBytes(32).toString('hex'));
    expect(() => b.decifrar(a.cifrar('segredo'))).toThrow(ErroCofre);
  });

  it('aceita chave em base64 de 32 bytes e rejeita tamanho errado', () => {
    expect(derivarChave(crypto.randomBytes(32).toString('base64')).length).toBe(32);
    expect(() => derivarChave('curta')).toThrow(ErroCofre);
    expect(() => derivarChave('')).toThrow(ErroCofre);
  });

  it('hashLogin é estável e normaliza', () => {
    expect(hashLogin(' Teste@Email.COM ')).toBe(hashLogin('teste@email.com'));
  });
});
