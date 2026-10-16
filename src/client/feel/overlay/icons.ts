// Inline SVG icons for feel overlays, built with createElementNS (no markup strings).

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Skull: cranium with eye sockets, nose and teeth gaps cut out (evenodd). viewBox 0 0 24 24. */
const SKULL_PATH =
  'M12 2C7 2 3.5 5.6 3.5 10.2C3.5 12.9 4.7 14.8 6.5 16V20H9.25V18H10.75V20H13.25V18H14.75V20H17.5V16' +
  'C19.3 14.8 20.5 12.9 20.5 10.2C20.5 5.6 17 2 12 2Z' +
  'M6.5 11A2.25 2.25 0 1 0 11 11A2.25 2.25 0 1 0 6.5 11Z' +
  'M13 11A2.25 2.25 0 1 0 17.5 11A2.25 2.25 0 1 0 13 11Z' +
  'M12 13.6L13.1 15.6H10.9Z';

/** Armor shield split along a crack into two shards (left / right). viewBox 0 0 24 24. */
const SHARD_LEFT = 'M12 2L10.5 8L13 11L10.5 15L12 22C7.5 19.8 4 16 4 11V5Z';
const SHARD_RIGHT = 'M12 2L20 5V11C20 16 16.5 19.8 12 22L10.5 15L13 11L10.5 8Z';

function svgRoot(doc: Document, cls: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (cls) svg.setAttribute('class', cls);
  return svg;
}

function path(doc: Document, d: string, cls?: string): SVGPathElement {
  const p = doc.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'currentColor');
  if (cls) p.setAttribute('class', cls);
  return p;
}

export function skullIcon(doc: Document, cls = ''): SVGSVGElement {
  const svg = svgRoot(doc, cls);
  const p = path(doc, SKULL_PATH);
  p.setAttribute('fill-rule', 'evenodd');
  svg.appendChild(p);
  return svg;
}

/** Shattering shield; the shards animate apart via the dzf-shard-l / dzf-shard-r classes. */
export function shatterIcon(doc: Document, cls = ''): SVGSVGElement {
  const svg = svgRoot(doc, cls);
  const l = path(doc, SHARD_LEFT, 'dzf-shard-l');
  const r = path(doc, SHARD_RIGHT, 'dzf-shard-r');
  for (const p of [l, r]) {
    p.setAttribute('stroke', 'rgba(0,0,0,.55)');
    p.setAttribute('stroke-width', '0.8');
    p.setAttribute('stroke-linejoin', 'round');
  }
  svg.appendChild(l);
  svg.appendChild(r);
  return svg;
}
