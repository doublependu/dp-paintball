import type { WebGLRenderer } from 'three';

const HISTORY = 120;
const GRAPH_W = 120;
const GRAPH_H = 34;
/** Frame time that maps to the top of the graph. 33.3ms = 30fps. */
const GRAPH_MAX_MS = 33.3;

/**
 * Frame-time HUD. Deliberately cheap: one canvas blit and a text swap per
 * frame, and the text only updates a few times a second so it stays readable.
 */
export class PerfHud {
  private root: HTMLDivElement;
  private readout: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private frames: number[] = [];
  private textTimer = 0;
  private visible: boolean;

  constructor(visible: boolean) {
    this.visible = visible;

    this.root = document.createElement('div');
    this.root.className = 'perf-hud';
    this.root.style.display = visible ? 'block' : 'none';

    this.canvas = document.createElement('canvas');
    this.canvas.width = GRAPH_W;
    this.canvas.height = GRAPH_H;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('PerfHud: 2D context unavailable');
    this.ctx = ctx;

    this.readout = document.createElement('div');
    this.readout.className = 'perf-hud__readout';

    this.root.append(this.canvas, this.readout);
    document.body.append(this.root);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.style.display = this.visible ? 'block' : 'none';
  }

  /** Call once per rendered frame, after the draw. */
  update(dt: number, renderer: WebGLRenderer, simSteps: number): void {
    if (!this.visible) return;

    const ms = dt * 1000;
    this.frames.push(ms);
    if (this.frames.length > HISTORY) this.frames.shift();

    this.drawGraph();

    this.textTimer += dt;
    if (this.textTimer < 0.25) return;
    this.textTimer = 0;

    const avg = this.frames.reduce((a, b) => a + b, 0) / this.frames.length;
    // The 1% low is what actually reads as stutter, so show it alongside mean.
    const sorted = [...this.frames].sort((a, b) => a - b);
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
    const info = renderer.info;

    this.readout.textContent = [
      `${(1000 / avg).toFixed(0)} fps  ${avg.toFixed(1)}ms`,
      `worst ${p99.toFixed(1)}ms  steps ${simSteps}`,
      `calls ${info.render.calls}  tris ${formatCount(info.render.triangles)}`,
      `geo ${info.memory.geometries}  tex ${info.memory.textures}  prog ${info.programs?.length ?? 0}`,
    ].join('\n');
  }

  private drawGraph(): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, GRAPH_W, GRAPH_H);

    // 60fps reference line.
    const line60 = GRAPH_H - (16.7 / GRAPH_MAX_MS) * GRAPH_H;
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, line60 + 0.5);
    ctx.lineTo(GRAPH_W, line60 + 0.5);
    ctx.stroke();

    const barWidth = GRAPH_W / HISTORY;
    for (let i = 0; i < this.frames.length; i++) {
      const ms = this.frames[i]!;
      const h = Math.min(1, ms / GRAPH_MAX_MS) * GRAPH_H;
      // Green under 60fps, amber approaching 30, red past it.
      ctx.fillStyle = ms <= 17 ? '#8fd45a' : ms <= 25 ? '#ffc94a' : '#ff6b6b';
      ctx.fillRect(i * barWidth, GRAPH_H - h, Math.max(1, barWidth - 0.5), h);
    }
  }

  dispose(): void {
    this.root.remove();
  }
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
