// Post-process public/tailwind.build.css so legacy offline browsers (Win10 LTSC / Edge 92)
// apply utility rules, theme colors, and transforms without dropping CSS inside @layer or oklch().
const fs = require('fs');
const path = require('path');

function oklchToCss(raw) {
  const m = raw.match(/^\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*([\d.]+)(%?))?\s*$/i);
  if (!m) return null;
  const L = m[2] ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
  const C = parseFloat(m[3]);
  const H = parseFloat(m[4]) * Math.PI / 180;
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const linR = +4.0767416621 * l - 3.3077115913 * m3 + 0.2309699292 * s;
  const linG = -1.2684380046 * l + 2.6097574011 * m3 - 0.3413193965 * s;
  const linB = -0.0041960863 * l - 0.7034186147 * m3 + 1.7076147010 * s;

  const toByte = x => {
    const c = Math.max(0, Math.min(1, x));
    const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
  };
  const r = toByte(linR), g = toByte(linG), bl = toByte(linB);
  if (m[5] !== undefined) {
    const alpha = m[6] ? parseFloat(m[5]) / 100 : parseFloat(m[5]);
    return `rgba(${r},${g},${bl},${Number(alpha.toFixed(4))})`;
  }
  const hex = n => n.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
}

// Balanced scanner unwraps `@layer name { ... }` while respecting string quotes and CSS comments.
function unwrapLayers(css) {
  let out = '';
  let i = 0;
  const len = css.length;
  while (i < len) {
    if (css.startsWith('@layer', i) && (i === 0 || /[\s};]/.test(css[i - 1]))) {
      const rest = css.slice(i);
      const m = rest.match(/^@layer\b([^{};]*?)([;{])/);
      if (m) {
        if (m[2] === ';') {
          i += m[0].length;
          continue;
        }
        let j = i + m[0].length;
        const innerStart = j;
        let depth = 1;
        let quote = '';
        while (j < len && depth > 0) {
          const ch = css[j];
          if (quote) {
            if (ch === '\\') { j += 2; continue; }
            if (ch === quote) quote = '';
          } else if (ch === '"' || ch === "'") {
            quote = ch;
          } else if (ch === '/' && css[j + 1] === '*') {
            const end = css.indexOf('*/', j + 2);
            j = end === -1 ? len : end + 2;
            continue;
          } else if (ch === '{') {
            depth++;
          } else if (ch === '}') {
            depth--;
            if (depth === 0) break;
          }
          j++;
        }
        out += unwrapLayers(css.slice(innerStart, j));
        i = j + 1;
        continue;
      }
    }
    out += css[i++];
  }
  return out;
}

function compatTransform(css) {
  let out = unwrapLayers(css);
  out = out.replace(/oklch\(([^()]+)\)/gi, (full, inner) => oklchToCss(inner) || full);
  // Individual `rotate` property landed in Edge 104; pair with `transform:rotate(...)`.
  out = out.replace(/(^|[;{])rotate:(\d+(?:\.\d+)?deg)/g, '$1transform:rotate($2);rotate:$2');
  return out;
}

if (require.main === module) {
  const target = path.join(__dirname, '..', 'public', 'tailwind.build.css');
  const src = fs.readFileSync(target, 'utf8');
  const next = compatTransform(src);
  fs.writeFileSync(target, next, 'utf8');
}

module.exports = { compatTransform, oklchToCss, unwrapLayers };
