// A small SVG builder for the guide's diagrams, after the rules of diagram-design (MIT).
import { C } from './brand.mjs';
export { C };
import { STYLE } from './brand.mjs';
// Fonts come from the page (or the SVG's own style): sans is the default, `class="m"` is mono.
export const SANS = '__SANS__';
export const MONO = '__MONO__';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Width budget from the style guide: 0.60em sans, 0.62em mono per character.
export const textW = (s, size, mono) => s.length * size * (mono ? 0.62 : 0.6);

export class Diagram {
  constructor({ slug, w, h, title, desc }) {
    Object.assign(this, { slug, w, h, title, desc });
    this.back = []; this.front = []; this.text = { sans400: '', sans600: '', mono400: '' };
  }
  use(kind, s) { this.text[kind] += s; }
  // Connector: a path through orthogonal points with r=8 rounded corners.
  wire(points, { accent = false, dashed = false, link = false, end = true, start = false, r = 8 } = {}) {
    const stroke = accent ? C.accent : link ? C.link : C.soft;
    const marker = accent ? 'arrow-accent' : link ? 'arrow-link' : 'arrow';
    let d = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i];
      if (i < points.length - 1) {
        const [px, py] = points[i - 1], [nx, ny] = points[i + 1];
        const din = [Math.sign(x - px), Math.sign(y - py)], dout = [Math.sign(nx - x), Math.sign(ny - y)];
        const rr = Math.min(r, Math.abs(x - px + y - py) / 2, Math.abs(nx - x + ny - y) / 2);
        d += ` L ${x - din[0] * rr} ${y - din[1] * rr} Q ${x} ${y} ${x + dout[0] * rr} ${y + dout[1] * rr}`;
      } else d += ` L ${x} ${y}`;
    }
    this.back.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.25"${dashed ? ' stroke-dasharray="5,4"' : ''}${end ? ` marker-end="url(#${this.slug}-${marker})"` : ''}${start ? ` marker-start="url(#${this.slug}-${marker}-start)"` : ''}/>`);
  }
  // Masked label; (x, y) is the centre of the mask. Sentence case, mono, per the site's rule.
  label(x, y, s, { anchor = 'middle', color = C.muted, mono = true, size = 12 } = {}) {
    size = Math.max(size, 12);
    const w = Math.ceil((textW(s, size, mono) + 10) / 2) * 2, h = size + 7;
    const rx = anchor === 'middle' ? x - w / 2 : anchor === 'start' ? x - 5 : x - w + 5;
    this.back.push(`<rect x="${rx}" y="${y - h / 2}" width="${w}" height="${h}" rx="2" fill="${C.paper}"/>`);
    this.back.push(`<text x="${x}" y="${y + size * 0.35}" fill="${color}" font-size="${size}" font-family="${mono ? MONO : SANS}" text-anchor="${anchor}">${esc(s)}</text>`);
    this.use(mono ? 'mono400' : 'sans400', s);
  }
  note(x, y, s, { anchor = 'middle', color = C.soft, size = 12.5, mono = false, weight = 400 } = {}) {
    size = Math.max(size, 12.5);
    this.front.push(`<text x="${x}" y="${y}" fill="${color}" font-size="${size}" font-weight="${weight}" font-family="${mono ? MONO : SANS}" text-anchor="${anchor}">${esc(s)}</text>`);
    this.use(mono ? 'mono400' : weight >= 600 ? 'sans600' : 'sans400', s);
  }
  // Node: name (Geist 600) and optional lines below it (sublabel in mono, or plain sans).
  node(x, y, w, h, name, { sub = [], mono = false, focal = false, warn = false, rx = 6, dashed = false, tag = null, plain = false } = {}) {
    const fill = focal ? C.accentTint : warn ? C.warnTint : plain ? C.paper : C.paper2;
    const stroke = focal ? C.accent : warn ? C.warn : C.ruleSolid;
    this.front.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${C.paper}"/>`);
    this.front.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1"${dashed ? ' stroke-dasharray="4,3"' : ''}/>`);
    const lines = [].concat(sub);
    const names = [].concat(name);
    const lh = 20, sh = 17;
    const total = names.length * lh + lines.length * sh;
    let cy = y + h / 2 - total / 2 + 14;
    for (const n of names) { this.front.push(`<text x="${x + w / 2}" y="${cy}" fill="${C.ink}" font-size="15" font-weight="600" font-family="${SANS}" text-anchor="middle">${esc(n)}</text>`); this.use('sans600', n); cy += lh; }
    for (const s of lines) {
      this.front.push(`<text x="${x + w / 2}" y="${cy}" fill="${C.soft}" font-size="${mono ? 12 : 12.5}" font-family="${mono ? MONO : SANS}" text-anchor="middle">${esc(s)}</text>`);
      this.use(mono ? 'mono400' : 'sans400', s); cy += sh;
    }
    if (tag) {
      const tw = Math.ceil(textW(tag, 9.5, true) + 10);
      this.front.push(`<rect x="${x + 8}" y="${y + 7}" width="${tw}" height="14" rx="2" fill="none" stroke="${focal ? C.accent : C.ruleSolid}" stroke-width="0.8"/>`);
      this.front.push(`<text x="${x + 8 + tw / 2}" y="${y + 17.5}" fill="${focal ? C.accent : C.soft}" font-size="9.5" font-family="${MONO}" text-anchor="middle">${esc(tag)}</text>`);
      this.use('mono400', tag);
    }
  }
  // A dashed region (a process, a computer, a trust boundary) with its name on a mask over the line.
  zone(x, y, w, h, name, { dashed = true, sub = null, color = C.soft } = {}) {
    this.zones = this.zones ?? [];
    this.zones.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="none" stroke="${C.ruleSolid}" stroke-width="1"${dashed ? ' stroke-dasharray="5,4"' : ''}/>`);
    const tw = Math.ceil(name.length * 12 * (0.62 + 0.08) + 14);
    this.zones.push(`<rect x="${x + 14}" y="${y - 8}" width="${tw}" height="16" fill="${C.paper}"/>`);
    this.zones.push(`<text x="${x + 20}" y="${y + 4}" fill="${color}" font-size="12" font-family="${MONO}" letter-spacing="0.08em">${esc(name.toUpperCase())}</text>`);
    if (sub) {
      this.zones.push(`<text x="${x + w - 14}" y="${y + h - 12}" fill="${C.soft}" font-size="12.5" font-family="${SANS}" text-anchor="end">${esc(sub)}</text>`);
    }
  }
  // A sequence actor's lifeline: a dashed line down from the box.
  lifeline(x, y1, y2) {
    this.back.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${C.rule}" stroke-width="1" stroke-dasharray="4,4"/>`);
  }
  raw(s, front = true, textKind = null, textStr = '') { (front ? this.front : this.back).push(s); if (textKind) this.use(textKind, textStr); }
  defs() {
    const m = (id, col, start) => `<marker id="${this.slug}-${id}${start ? '-start' : ''}" markerWidth="8" markerHeight="6" refX="${start ? 1 : 7}" refY="3" orient="auto"><polygon points="${start ? '8 0, 0 3, 8 6' : '0 0, 8 3, 0 6'}" fill="${col}"/></marker>`;
    return [m('arrow', C.soft), m('arrow-accent', C.accent), m('arrow-link', C.link), m('arrow', C.soft, true), m('arrow-accent', C.accent, true)].join('');
  }
  svg() {
    const body = `<rect width="100%" height="100%" fill="${C.paper}"/>` + (this.zones ?? []).join('') + this.back.join('') + this.front.join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" class="hm-diagram" viewBox="0 0 ${this.w} ${this.h}" width="${this.w}" height="${this.h}" role="img" aria-labelledby="${this.slug}-title ${this.slug}-desc">` +
      `<title id="${this.slug}-title">${esc(this.title)}</title><desc id="${this.slug}-desc">${esc(this.desc)}</desc>` +
      `<defs><style>${STYLE}</style>${themed(this.defs())}</defs>` + themed(body) + `</svg>`;
  }
}

// A colour that names a CSS variable has to be a style, not an attribute, to follow the theme.
function themed(markup) {
  return markup.replace(/<(\w+)([^>]*?)(\/?)>/g, (tag, name, attrs, close) => {
    const styles = [];
    let rest = attrs.replace(/\s(fill|stroke)="(var\([^"]*\))"/g, (_, prop, value) => { styles.push(`${prop}:${value}`); return ''; });
    rest = rest.replace(/\sfont-family="__SANS__"/g, '').replace(/\sfont-family="__MONO__"/g, ' class="m"');
    return `<${name}${rest}${styles.length ? ` style="${styles.join(';')}"` : ''}${close}>`;
  });
}
