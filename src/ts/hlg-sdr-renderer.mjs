const WEBGL_VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vTextureCoordinate;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vTextureCoordinate = aPosition * 0.5 + 0.5;
}
`;

const WEBGL_FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D uVideo;
uniform sampler2D uColorLut;
uniform float uLutSize;
uniform float uComparison;
varying vec2 vTextureCoordinate;

vec3 sampleColorLut(vec3 color) {
  float maximum = uLutSize - 1.0;
  vec3 coordinate = clamp(color, 0.0, 1.0) * maximum;
  float lowerBlue = floor(coordinate.b);
  float upperBlue = min(lowerBlue + 1.0, maximum);
  vec2 textureSize = vec2(uLutSize * uLutSize, uLutSize);
  vec2 lowerUv = vec2(
    lowerBlue * uLutSize + coordinate.r + 0.5,
    coordinate.g + 0.5
  ) / textureSize;
  vec2 upperUv = vec2(
    upperBlue * uLutSize + coordinate.r + 0.5,
    coordinate.g + 0.5
  ) / textureSize;
  return mix(
    texture2D(uColorLut, lowerUv).rgb,
    texture2D(uColorLut, upperUv).rgb,
    fract(coordinate.b)
  );
}

void main() {
  if (uComparison > 0.5 && vTextureCoordinate.x < 0.5) discard;
  vec4 sample = texture2D(uVideo, vTextureCoordinate);
  gl_FragColor = vec4(sampleColorLut(sample.rgb), sample.a);
}
`;

const WEBGPU_SHADER = /* wgsl */`
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

struct LutParameters {
  size: f32,
  comparison: f32,
}

@group(0) @binding(0) var videoFrame: texture_external;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var colorLut: texture_2d<f32>;
@group(0) @binding(3) var<uniform> lut: LutParameters;

fn sampleColorLut(color: vec3f) -> vec3f {
  let maximum = lut.size - 1.0;
  let coordinate = clamp(color, vec3f(0.0), vec3f(1.0)) * maximum;
  let lowerBlue = floor(coordinate.b);
  let upperBlue = min(lowerBlue + 1.0, maximum);
  let textureSize = vec2f(lut.size * lut.size, lut.size);
  let lowerUv = vec2f(
    lowerBlue * lut.size + coordinate.r + 0.5,
    coordinate.g + 0.5
  ) / textureSize;
  let upperUv = vec2f(
    upperBlue * lut.size + coordinate.r + 0.5,
    coordinate.g + 0.5
  ) / textureSize;
  return mix(
    textureSampleLevel(colorLut, linearSampler, lowerUv, 0.0).rgb,
    textureSampleLevel(colorLut, linearSampler, upperUv, 0.0).rgb,
    fract(coordinate.b)
  );
}

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let position = positions[index];
  return VertexOutput(vec4f(position, 0.0, 1.0),
    vec2f((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5));
}

@fragment
fn fragment(input: VertexOutput) -> @location(0) vec4f {
  if (lut.comparison > 0.5 && input.uv.x < 0.5) { discard; }
  let sample = textureSampleBaseClampToEdge(videoFrame, linearSampler, input.uv);
  return vec4f(sampleColorLut(sample.rgb), sample.a);
}
`;

function validateColorLut(lut) {
  if (!lut || !Number.isInteger(lut.size) || lut.size < 2 ||
      lut.width !== lut.size * lut.size || lut.height !== lut.size ||
      !(lut.data instanceof Uint8Array) ||
      lut.data.length !== lut.width * lut.height * 4) {
    throw new TypeError('invalid HLG-SDR color LUT');
  }
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const message = gl.getShaderInfoLog(shader) || 'unknown shader error';
  gl.deleteShader(shader);
  throw new Error(`HLG-SDR shader compile failed: ${message}`);
}

function createWebGlProgram(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, WEBGL_VERTEX_SHADER));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, WEBGL_FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  const message = gl.getProgramInfoLog(program) || 'unknown shader error';
  gl.deleteProgram(program);
  throw new Error(`HLG-SDR shader link failed: ${message}`);
}

class WebGlBackend {
  constructor(video, canvas, onError) {
    this.video = video;
    this.canvas = canvas;
    this.onError = onError;
    this.gl = null;
    this.program = null;
    this.videoTexture = null;
    this.lutTexture = null;
    this.lut = null;
    this.comparison = false;
    this.failed = false;
  }

  setColorLut(lut) {
    this.lut = lut;
    if (this.gl) this.uploadColorLut();
  }

  setComparisonEnabled(enabled) {
    this.comparison = enabled;
    if (!this.gl) return;
    this.gl.useProgram(this.program);
    this.gl.uniform1f(
      this.gl.getUniformLocation(this.program, 'uComparison'), enabled ? 1 : 0,
    );
  }

  initialize() {
    if (this.gl) return true;
    if (this.failed) return false;
    try {
      const gl = this.canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: false,
      });
      if (!gl) throw new Error('WebGL is unavailable');
      const program = createWebGlProgram(gl);
      gl.useProgram(program);
      const position = gl.getAttribLocation(program, 'aPosition');
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
      ]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

      this.gl = gl;
      this.program = program;
      this.videoTexture = this.createTexture();
      this.lutTexture = this.createTexture();
      gl.uniform1i(gl.getUniformLocation(program, 'uVideo'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'uColorLut'), 1);
      gl.uniform1f(gl.getUniformLocation(program, 'uComparison'), this.comparison ? 1 : 0);
      this.uploadColorLut();
      return true;
    } catch (error) {
      this.failed = true;
      this.onError('WebGL', error);
      return false;
    }
  }

  createTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  uploadColorLut() {
    if (!this.gl || !this.lutTexture || !this.lut) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.lut.width, this.lut.height,
      0, gl.RGBA, gl.UNSIGNED_BYTE, this.lut.data);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uLutSize'), this.lut.size);
  }

  draw() {
    if (!this.gl || !this.lut || this.video.readyState < 2 ||
        this.video.videoWidth === 0 || this.video.videoHeight === 0) return;
    this.resize();
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  resize() {
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  destroy() {
    this.gl?.deleteTexture(this.videoTexture);
    this.gl?.deleteTexture(this.lutTexture);
    this.gl?.deleteProgram(this.program);
  }
}

class WebGpuBackend {
  constructor(video, canvas, onError, onLost) {
    this.video = video;
    this.canvas = canvas;
    this.onError = onError;
    this.onLost = onLost;
    this.device = null;
    this.context = null;
    this.format = null;
    this.pipeline = null;
    this.sampler = null;
    this.lutTexture = null;
    this.lutUniform = null;
    this.lut = null;
    this.comparison = false;
    this.initializing = null;
    this.failed = false;
  }

  setColorLut(lut) {
    this.lut = lut;
    if (this.device) this.uploadColorLut();
  }

  setComparisonEnabled(enabled) {
    this.comparison = enabled;
    this.uploadParameters();
  }

  initialize() {
    if (this.device) return Promise.resolve(true);
    if (this.failed || !navigator.gpu) return Promise.resolve(false);
    if (!this.initializing) this.initializing = this.initializeDevice();
    return this.initializing;
  }

  async initializeDevice() {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      const context = this.canvas.getContext('webgpu');
      if (!context) return false;
      const format = navigator.gpu.getPreferredCanvasFormat();
      const shader = device.createShaderModule({code: WEBGPU_SHADER});
      this.device = device;
      this.context = context;
      this.format = format;
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {module: shader, entryPoint: 'vertex'},
        fragment: {module: shader, entryPoint: 'fragment', targets: [{format}]},
        primitive: {topology: 'triangle-list'},
      });
      this.sampler = device.createSampler({magFilter: 'linear', minFilter: 'linear'});
      this.lutUniform = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.lost.then(() => {
        this.failed = true;
        this.device = null;
        this.onLost();
      });
      this.resize();
      this.uploadColorLut();
      return this.lutTexture !== null;
    } catch (error) {
      this.failed = true;
      this.onError('WebGPU', error);
      return false;
    }
  }

  uploadColorLut() {
    if (!this.device || !this.lut || !this.lutUniform) return;
    this.lutTexture?.destroy();
    this.lutTexture = this.device.createTexture({
      size: [this.lut.width, this.lut.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const sourceBytesPerRow = this.lut.width * 4;
    const bytesPerRow = Math.ceil(sourceBytesPerRow / 256) * 256;
    const bytes = new Uint8Array(bytesPerRow * this.lut.height);
    for (let row = 0; row < this.lut.height; row += 1) {
      bytes.set(this.lut.data.subarray(
        row * sourceBytesPerRow, (row + 1) * sourceBytesPerRow,
      ), row * bytesPerRow);
    }
    this.device.queue.writeTexture(
      {texture: this.lutTexture}, bytes, {bytesPerRow, rowsPerImage: this.lut.height},
      {width: this.lut.width, height: this.lut.height},
    );
    this.uploadParameters();
  }

  uploadParameters() {
    if (!this.device || !this.lut || !this.lutUniform) return;
    this.device.queue.writeBuffer(
      this.lutUniform, 0,
      new Float32Array([this.lut.size, this.comparison ? 1 : 0, 0, 0]),
    );
  }

  draw() {
    if (!this.device || !this.context || !this.pipeline || !this.lutTexture ||
        this.video.readyState < 2 || this.video.videoWidth === 0 ||
        this.video.videoHeight === 0) return;
    this.resize();
    const videoFrame = this.device.importExternalTexture({source: this.video});
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: videoFrame},
        {binding: 1, resource: this.sampler},
        {binding: 2, resource: this.lutTexture.createView()},
        {binding: 3, resource: {buffer: this.lutUniform}},
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: {r: 0, g: 0, b: 0, a: 0},
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  resize() {
    if (!this.context || !this.device) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
    });
  }

  destroy() {
    this.lutTexture?.destroy();
    this.lutUniform?.destroy();
  }
}

export class HlgSdrRenderer {
  constructor({video, webGpuCanvas, webGlCanvas, onError = () => {},
               onBackendChange = () => {}}) {
    this.video = video;
    this.webGpuCanvas = webGpuCanvas;
    this.webGlCanvas = webGlCanvas;
    this.onBackendChange = onBackendChange;
    this.enabled = false;
    this.activeBackend = null;
    this.activeName = null;
    this.generation = 0;
    this.frameRequest = null;
    this.animationRequest = null;
    this.handlePlay = () => this.schedule();
    this.handlePause = () => this.cancelFrame();
    this.webGl = new WebGlBackend(video, webGlCanvas, onError);
    this.webGpu = new WebGpuBackend(video, webGpuCanvas, onError, () => {
      if (this.activeBackend === this.webGpu) {
        this.activeBackend = null;
        this.activeName = null;
        if (this.enabled) void this.selectBackend(++this.generation);
      }
    });
    video.addEventListener('play', this.handlePlay);
    video.addEventListener('pause', this.handlePause);
    webGpuCanvas.hidden = true;
    webGlCanvas.hidden = true;
  }

  setColorLut(lut) {
    validateColorLut(lut);
    this.webGl.setColorLut(lut);
    this.webGpu.setColorLut(lut);
    if (this.enabled && !this.activeBackend) void this.selectBackend(++this.generation);
  }

  setComparisonEnabled(enabled) {
    this.webGl.setComparisonEnabled(enabled);
    this.webGpu.setComparisonEnabled(enabled);
    if (this.enabled) this.draw();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    const generation = ++this.generation;
    if (!enabled) {
      this.cancelFrame();
      this.activeBackend = null;
      this.activeName = null;
      this.webGpuCanvas.hidden = true;
      this.webGlCanvas.hidden = true;
      return;
    }
    void this.selectBackend(generation);
  }

  async selectBackend(generation) {
    const webGpuReady = await this.webGpu.initialize();
    if (!this.enabled || generation !== this.generation) return;
    let backend = null;
    let name = null;
    if (webGpuReady) {
      backend = this.webGpu;
      name = 'WebGPU';
    } else if (this.webGl.initialize()) {
      backend = this.webGl;
      name = 'WebGL';
    }
    this.activeBackend = backend;
    this.webGpuCanvas.hidden = backend !== this.webGpu;
    this.webGlCanvas.hidden = backend !== this.webGl;
    if (name !== this.activeName) {
      this.activeName = name;
      if (name) this.onBackendChange(name);
    }
    this.draw();
    this.schedule();
  }

  draw() {
    if (this.enabled) this.activeBackend?.draw();
  }

  schedule() {
    if (!this.enabled || !this.activeBackend || this.video.paused || this.video.ended ||
        this.frameRequest !== null || this.animationRequest !== null) return;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.frameRequest = this.video.requestVideoFrameCallback(() => {
        this.frameRequest = null;
        this.draw();
        this.schedule();
      });
    } else {
      this.animationRequest = requestAnimationFrame(() => {
        this.animationRequest = null;
        this.draw();
        this.schedule();
      });
    }
  }

  cancelFrame() {
    if (this.frameRequest !== null &&
        typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this.frameRequest);
    }
    if (this.animationRequest !== null) cancelAnimationFrame(this.animationRequest);
    this.frameRequest = null;
    this.animationRequest = null;
  }

  destroy() {
    this.setEnabled(false);
    this.video.removeEventListener('play', this.handlePlay);
    this.video.removeEventListener('pause', this.handlePause);
    this.webGpu.destroy();
    this.webGl.destroy();
  }
}
