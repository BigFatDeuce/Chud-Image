// Broadcast-style glitch transition rendered with WebGL2: the outgoing picture tears
// into shifted horizontal slices, its colour channels split, blocks of the incoming
// picture punch through, and grain/scanlines flicker, before settling on a clean image.
// Inspired by canvasui's Glitch component; rewritten here to blend two pictures.

const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform vec2 uRes;
uniform float uProgress;
uniform float uEnv;
uniform float uSeed;
uniform float uBurst;
uniform float uSlices;
uniform float uShift;
uniform float uRgb;
uniform float uBlocks;
uniform float uNoise;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec4 pick(vec2 uv, float useTo) {
  uv = clamp(uv, vec2(0.0), vec2(1.0));
  return mix(texture(uFrom, uv), texture(uTo, uv), useTo);
}

void main() {
  vec2 uv = vUv;
  float e = uEnv;
  vec2 g = uv;

  // 1. Slice tearing.
  float band = floor(uv.y * uSlices);
  float torn = step(1.0 - 0.32 * min(e, 1.0), hash12(vec2(band, uSeed)));
  float dir = hash12(vec2(band, uSeed + 13.0)) * 2.0 - 1.0;
  g.x += torn * dir * e * uShift / uRes.x;

  // 2. Micro jitter on finer bands.
  float sub = floor(uv.y * uSlices * 7.0);
  g.x += (hash12(vec2(sub, uSeed + 7.0)) - 0.5) * uNoise * e * 8.0 / uRes.x;

  // 3. Corrupted blocks.
  vec2 cell = floor(vec2(uv.x * 10.0, uv.y * uSlices * 0.5));
  float corrupt = step(1.0 - 0.14 * uBlocks * e * 2.5, hash12(cell + uSeed * 0.37));
  g += corrupt * vec2(hash12(cell + 3.1) - 0.5, (hash12(cell + 5.7) - 0.5) * 0.25) * 0.08 * e;

  // Which picture: chunks of the new one punch through progressively (monotonic per
  // transition), so the switch itself reads as data corruption.
  vec2 chunk = vec2(floor(uv.x * 7.0), band);
  float threshold = hash12(chunk + uBurst);
  float useTo = step(threshold, clamp((uProgress - 0.18) / 0.5, 0.0, 1.0));
  useTo = max(useTo, corrupt * step(0.45, uProgress));

  // 4. RGB split.
  float split = uRgb * e / uRes.x;
  vec4 base = pick(g, useTo);
  float r = pick(g + vec2(split, 0.0), useTo).r;
  float b = pick(g - vec2(split, 0.0), useTo).b;
  vec3 col = vec3(r, base.g, b);

  // 5. Grain and bright scanlines.
  float grain = hash12(gl_FragCoord.xy + uSeed * 17.0) - 0.5;
  col += grain * uNoise * e * 0.22;
  float row = floor(gl_FragCoord.y / 2.0);
  float line = step(0.985 - 0.012 * uNoise * e, hash12(vec2(row, uSeed + 31.0)));
  col += line * 0.22 * uNoise * e;

  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export interface GlitchOptions {
  duration: number;
  intensity: number;
  slices: number;
  shift: number;
  rgbShift: number;
  blocks: number;
  noise: number;
}

export const DEFAULT_GLITCH: GlitchOptions = {
  duration: 520,
  intensity: 1,
  slices: 24,
  shift: 34,
  rgbShift: 6,
  blocks: 0.55,
  noise: 0.35,
};

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class GlitchRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private textures: [WebGLTexture, WebGLTexture];
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private raf = 0;
  private finish: (() => void) | null = null;

  private constructor(private canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = GlitchRenderer.link(gl);
    gl.useProgram(this.program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const name of ["uFrom", "uTo", "uRes", "uProgress", "uEnv", "uSeed", "uBurst", "uSlices", "uShift", "uRgb", "uBlocks", "uNoise"]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
    const make = () => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    this.textures = [make(), make()];
    gl.uniform1i(this.uniforms.uFrom, 0);
    gl.uniform1i(this.uniforms.uTo, 1);
  }

  static create(canvas: HTMLCanvasElement): GlitchRenderer | null {
    try {
      const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true });
      if (!gl) return null;
      return new GlitchRenderer(canvas, gl);
    } catch {
      return null;
    }
  }

  private static link(gl: WebGL2RenderingContext): WebGLProgram {
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    return p;
  }

  cancel() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const done = this.finish;
    this.finish = null;
    done?.();
  }

  /** Plays the transition between two same-sized canvases. Resolves when finished. */
  play(from: HTMLCanvasElement, to: HTMLCanvasElement, opts: GlitchOptions = DEFAULT_GLITCH): Promise<void> {
    this.cancel();
    const gl = this.gl;
    this.canvas.width = from.width;
    this.canvas.height = from.height;
    gl.viewport(0, 0, from.width, from.height);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // Throws on tainted canvases: the caller falls back to a plain cut.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, from);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures[1]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, to);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const u = this.uniforms;
    gl.uniform2f(u.uRes, from.width / dpr, from.height / dpr);
    gl.uniform1f(u.uSlices, opts.slices);
    gl.uniform1f(u.uShift, opts.shift);
    gl.uniform1f(u.uRgb, opts.rgbShift);
    gl.uniform1f(u.uBlocks, opts.blocks);
    gl.uniform1f(u.uNoise, opts.noise);
    const burst = Math.floor(Math.random() * 1000);
    gl.uniform1f(u.uBurst, burst);

    return new Promise((resolve) => {
      this.finish = resolve;
      const start = performance.now();
      const frame = (now: number) => {
        const p = Math.min(1, (now - start) / opts.duration);
        const tick = Math.floor(((now - start) / 1000) * 24);
        // Rises fast, decays quadratically, flickers 24 times per second.
        const env = Math.pow(Math.sin(Math.PI * Math.min(1, p * 1.15)), 0.7) * (0.7 + 0.3 * hash(burst + tick)) * opts.intensity;
        gl.uniform1f(u.uProgress, p);
        gl.uniform1f(u.uEnv, p >= 1 ? 0 : env);
        gl.uniform1f(u.uSeed, tick + burst);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        if (p < 1) {
          this.raf = requestAnimationFrame(frame);
        } else {
          this.raf = 0;
          this.finish = null;
          resolve();
        }
      };
      // First frame synchronously: the overlay must cover the swap before the next paint.
      frame(performance.now());
    });
  }
}
