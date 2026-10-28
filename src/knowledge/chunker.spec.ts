import { chunkMarkdown } from './chunker';

describe('chunkMarkdown', () => {
  it('strips front matter into meta and prefixes chunks with title › heading', () => {
    const md = [
      '---',
      'title: Depozit la termen',
      'category: deposit',
      'product_slug: depozit-la-termen',
      'source_urls:',
      '  - https://www.raiffeisen.ro/depozite',
      '---',
      '# Depozit la termen',
      'Intro despre depozit.',
      '## Dobândă',
      'Dobânda se plătește la scadență.',
      '### Condiții',
      'Suma minimă este 500 RON.',
    ].join('\n');
    const { meta, chunks } = chunkMarkdown(md);
    expect(meta.title).toBe('Depozit la termen');
    expect(meta.product_slug).toBe('depozit-la-termen');
    expect(meta.source_urls).toEqual(['https://www.raiffeisen.ro/depozite']);
    expect(chunks.some((c) => c.includes('---') || c.includes('product_slug'))).toBe(false);
    expect(chunks[0]).toBe('Depozit la termen\nIntro despre depozit.');
    expect(chunks[1]).toBe('Depozit la termen › Dobândă\nDobânda se plătește la scadență.');
    expect(chunks[2]).toBe('Depozit la termen › Dobândă › Condiții\nSuma minimă este 500 RON.');
  });

  it('no chunk exceeds maxChars + heading prefix; consecutive split chunks overlap', () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Paragraful ${i} ` + 'text de umplutură '.repeat(8 + (i % 5)));
    const md = `# Ghid\n## Secțiune lungă\n${paras.join('\n\n')}`;
    const maxChars = 400;
    const overlap = 60;
    const { chunks } = chunkMarkdown(md, { maxChars, overlap });
    const prefix = 'Ghid › Secțiune lungă\n';
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.startsWith(prefix)).toBe(true);
      expect(c.length).toBeLessThanOrEqual(maxChars + prefix.length);
    }
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1].slice(prefix.length);
      const cur = chunks[i].slice(prefix.length);
      const head = cur.split('\n\n')[0];
      expect(prev.endsWith(head)).toBe(true);
    }
  });
});
