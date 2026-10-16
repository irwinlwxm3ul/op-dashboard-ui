// GPU frame timing via EXT_disjoint_timer_query_webgl2 (when the browser exposes it). Queries are
// pooled and read back asynchronously a few frames later, so measuring never stalls the pipeline.

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

const POOL = 5;

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerQueryExt;
  private readonly free: WebGLQuery[] = [];
  /** In-flight queries, oldest first (fixed capacity, no per-frame allocation). */
  private readonly pending: (WebGLQuery | null)[] = new Array<WebGLQuery | null>(POOL).fill(null);
  private head = 0;
  private count = 0;
  private active: WebGLQuery | null = null;

  private constructor(gl: WebGL2RenderingContext, ext: TimerQueryExt) {
    this.gl = gl;
    this.ext = ext;
    for (let i = 0; i < POOL; i++) {
      const q = gl.createQuery();
      if (q) this.free.push(q);
    }
  }

  /** Null when timer queries are unavailable (most browsers outside desktop Chrome). */
  static create(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuTimer | null {
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return null;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
    if (!ext) return null;
    const t = new GpuTimer(gl, ext);
    return t.free.length > 0 ? t : null;
  }

  begin(): void {
    if (this.active || this.free.length === 0) return;
    const q = this.free.pop()!;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    const q = this.active;
    if (!q) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = null;
    this.pending[(this.head + this.count) % POOL] = q;
    this.count++;
  }

  /** Latest completed GPU time in ms, or -1 if nothing new is available. */
  poll(): number {
    const gl = this.gl;
    let result = -1;
    const disjoint = this.count > 0 && !!gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.count > 0) {
      const q = this.pending[this.head]!;
      if (!disjoint && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) result = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      this.pending[this.head] = null;
      this.head = (this.head + 1) % POOL;
      this.count--;
      this.free.push(q);
    }
    return result;
  }

  dispose(): void {
    if (this.active) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.free.push(this.active);
      this.active = null;
    }
    while (this.count > 0) {
      this.free.push(this.pending[this.head]!);
      this.pending[this.head] = null;
      this.head = (this.head + 1) % POOL;
      this.count--;
    }
    for (const q of this.free) this.gl.deleteQuery(q);
    this.free.length = 0;
  }
}
