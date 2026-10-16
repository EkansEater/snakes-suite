// Shapes as SVG paths in a w×h box: shared by Slides and Paint.

/** SVG path for a shape in a w×h box. */
export function shapePath(kind, w, h, radius = 0.12) {
  const p = (pts) => `M${pts.map(([x, y]) => `${(x * w).toFixed(2)},${(y * h).toFixed(2)}`).join(' L')} Z`;
  switch (kind) {
    case 'ellipse': return `M${w / 2},0 A${w / 2},${h / 2} 0 1 1 ${w / 2 - 0.01},0 Z`;
    case 'roundRect': { const r = Math.min(w, h) * radius; return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`; }
    case 'triangle': return p([[0.5, 0], [1, 1], [0, 1]]);
    case 'rightTriangle': return p([[0, 0], [1, 1], [0, 1]]);
    case 'diamond': return p([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
    case 'pentagon': return p([[0.5, 0], [1, 0.38], [0.81, 1], [0.19, 1], [0, 0.38]]);
    case 'hexagon': return p([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]);
    case 'parallelogram': return p([[0.2, 0], [1, 0], [0.8, 1], [0, 1]]);
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 ? 0.2 : 0.5;
        pts.push([0.5 + Math.cos(a) * r, 0.53 + Math.sin(a) * r * 1.05]);
      }
      return p(pts);
    }
    case 'arrowRight': return p([[0, 0.3], [0.65, 0.3], [0.65, 0], [1, 0.5], [0.65, 1], [0.65, 0.7], [0, 0.7]]);
    case 'arrowLeft': return p([[1, 0.3], [0.35, 0.3], [0.35, 0], [0, 0.5], [0.35, 1], [0.35, 0.7], [1, 0.7]]);
    case 'chevron': return p([[0, 0], [0.7, 0], [1, 0.5], [0.7, 1], [0, 1], [0.3, 0.5]]);
    case 'plus': return p([[0.35, 0], [0.65, 0], [0.65, 0.35], [1, 0.35], [1, 0.65], [0.65, 0.65], [0.65, 1], [0.35, 1], [0.35, 0.65], [0, 0.65], [0, 0.35], [0.35, 0.35]]);
    case 'callout': return `M${w * 0.08},0 H${w * 0.92} Q${w},0 ${w},${h * 0.1} V${h * 0.68} Q${w},${h * 0.78} ${w * 0.92},${h * 0.78} H${w * 0.38} L${w * 0.2},${h} L${w * 0.24},${h * 0.78} H${w * 0.08} Q0,${h * 0.78} 0,${h * 0.68} V${h * 0.1} Q0,0 ${w * 0.08},0 Z`;
    case 'heart': return `M${w / 2},${h * 0.3} C${w / 2},${h * 0.05} ${w * 0.05},${-h * 0.02} ${w * 0.02},${h * 0.32} C0,${h * 0.55} ${w * 0.3},${h * 0.72} ${w / 2},${h} C${w * 0.7},${h * 0.72} ${w},${h * 0.55} ${w * 0.98},${h * 0.32} C${w * 0.95},${-h * 0.02} ${w / 2},${h * 0.05} ${w / 2},${h * 0.3} Z`;
    case 'cloud': return `M${w * 0.25},${h * 0.85} C${w * 0.05},${h * 0.85} 0,${h * 0.55} ${w * 0.2},${h * 0.5} C${w * 0.15},${h * 0.2} ${w * 0.45},${h * 0.1} ${w * 0.55},${h * 0.3} C${w * 0.65},${h * 0.05} ${w * 0.95},${h * 0.15} ${w * 0.85},${h * 0.45} C${w},${h * 0.5} ${w},${h * 0.85} ${w * 0.8},${h * 0.85} Z`;
    case 'lightning': return p([[0.55, 0], [0.2, 0.55], [0.45, 0.55], [0.3, 1], [0.82, 0.38], [0.55, 0.38], [0.72, 0]]);
    case 'arrowUp': return p([[0.3, 1], [0.3, 0.35], [0, 0.35], [0.5, 0], [1, 0.35], [0.7, 0.35], [0.7, 1]]);
    case 'arrowDown': return p([[0.3, 0], [0.3, 0.65], [0, 0.65], [0.5, 1], [1, 0.65], [0.7, 0.65], [0.7, 0]]);
    case 'ring': return `M${w / 2},0 A${w / 2},${h / 2} 0 1 1 ${w / 2 - 0.01},0 Z M${w / 2},${h * 0.25} A${w / 4},${h / 4} 0 1 0 ${w / 2 + 0.01},${h * 0.25} Z`;
    default: return `M0,0 H${w} V${h} H0 Z`;
  }
}

