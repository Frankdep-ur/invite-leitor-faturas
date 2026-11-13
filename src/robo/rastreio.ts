import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

/**
 * Rastreio do robô, para calibrar seletores com o portal real.
 *
 * Por etapa grava: print da tela e um mapa da página (campos, botões, links,
 * mensagens) SEM valores digitados. Da rede grava só método, rota, status e
 * tipo — sem query string, sem corpo, com sequências de 6+ dígitos mascaradas.
 *
 * ATENÇÃO: os prints podem mostrar nome/CPF/endereço do cliente. A pasta é
 * local (dentro de `dados/`, que o git ignora) e deve ser apagada após o uso.
 */

export interface EntradaRede {
  metodo: string;
  rota: string;
  status: number;
  tipo: string;
}

const mascarar = (s: string) => s.replace(/\d{6,}/g, '<num>');

export function rotaSegura(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${mascarar(u.pathname)}${u.hash ? mascarar(u.hash.split('?')[0]!) : ''}`;
  } catch {
    return '<url-invalida>';
  }
}

export class Rastreio {
  private n = 0;
  readonly rede: EntradaRede[] = [];
  readonly etapas: string[] = [];

  constructor(
    readonly dir: string | null,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  ativo(): boolean {
    return this.dir !== null;
  }

  /** Liga a escuta de rede (só metadados). */
  escutar(page: Page): void {
    if (!this.dir) return;
    page.on('response', (r) => {
      const tipoRecurso = r.request().resourceType();
      if (!['xhr', 'fetch', 'document'].includes(tipoRecurso)) return;
      this.rede.push({
        metodo: r.request().method(),
        rota: rotaSegura(r.url()),
        status: r.status(),
        tipo: (r.headers()['content-type'] ?? '').split(';')[0]!,
      });
    });
  }

  async etapa(page: Page, nome: string): Promise<void> {
    this.etapas.push(nome);
    this.log(`etapa: ${nome}`);
    if (!this.dir) return;
    const prefixo = path.join(this.dir, `${String(++this.n).padStart(2, '0')}-${nome.replace(/[^a-z0-9-]+/gi, '_')}`);
    await fs.mkdir(this.dir, { recursive: true });
    await page.screenshot({ path: `${prefixo}.png` }).catch(() => {});
    const mapa = await page
      .evaluate(() => {
        const visivel = (e: Element) => {
          const r = (e as HTMLElement).getBoundingClientRect();
          const s = getComputedStyle(e as HTMLElement);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const txt = (e: Element) => ((e as HTMLElement).innerText || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        const rotuloDe = (e: Element) => {
          const id = e.getAttribute('id');
          const lbl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
          return (lbl ? txt(lbl) : '') || e.getAttribute('aria-label') || '';
        };
        return {
          rota: location.hash || location.pathname,
          titulo: document.title,
          campos: [...document.querySelectorAll('input,select,textarea,mat-select')].filter(visivel).map((e) => ({
            tag: e.tagName.toLowerCase(),
            id: e.id || null,
            name: e.getAttribute('name'),
            type: e.getAttribute('type'),
            formcontrolname: e.getAttribute('formcontrolname'),
            placeholder: e.getAttribute('placeholder'),
            rotulo: rotuloDe(e),
          })),
          botoes: [...document.querySelectorAll('button,[role=button],a')].filter(visivel).map(txt).filter(Boolean).slice(0, 60),
          mensagens: [...document.querySelectorAll('[role=alert],mat-error,.mat-mdc-snack-bar-container,.alert,.error,.erro,.toast')]
            .filter(visivel)
            .map(txt)
            .filter(Boolean),
          titulos: [...document.querySelectorAll('h1,h2,h3,h4')].filter(visivel).map(txt).filter(Boolean).slice(0, 20),
          iframes: [...document.querySelectorAll('iframe')].map((f) => (f.getAttribute('src') || '').split('?')[0]).slice(0, 10),
        };
      })
      .catch((e) => ({ erro: String(e) }));
    await fs.writeFile(`${prefixo}.json`, JSON.stringify(mapa, null, 2));
  }

  async salvarRede(): Promise<void> {
    if (!this.dir) return;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, 'rede.json'), JSON.stringify(this.rede, null, 2));
  }
}
