import { svg } from './dom.js';

/** Symmetric 5x5 identicon derived from a key fingerprint (hex). */
export function identicon(fpHex, size = 36) {
  const bytes = [];
  for (let i = 0; i < 32; i++) bytes.push(parseInt(fpHex.substr(i * 2, 2), 16) || 0);
  const hue = Math.round((bytes[0] / 255) * 360);
  const fg = `hsl(${hue} 62% 52%)`;
  const bg = `hsl(${hue} 45% 92%)`;
  const root = svg('svg', { viewBox: '0 0 5 5', width: size, height: size, class: 'identicon', 'aria-hidden': 'true' });
  root.append(svg('rect', { width: 5, height: 5, fill: bg, rx: 1 }));
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((bytes[1 + y * 3 + x] & 1) === 0) continue;
      root.append(svg('rect', { x, y, width: 1, height: 1, fill: fg }));
      if (x < 2) root.append(svg('rect', { x: 4 - x, y, width: 1, height: 1, fill: fg }));
    }
  }
  return root;
}
