const SHADER = /* wgsl */`
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var videoFrame: texture_external;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var toneMap: texture_2d<f32>;

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let position = positions[index];
  return VertexOutput(vec4f(position, 0.0, 1.0),
    vec2f((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5));
}

@fragment
fn fragment(input: VertexOutput) -> @location(0) vec4f {
  let sample = textureSampleBaseClampToEdge(videoFrame, linearSampler, input.uv);
  // HLG-SDR correction is a luminance correction. Mapping each channel
  // independently changes the RGB ratios and visibly over-saturates glows.
  let luma = dot(sample.rgb, vec3f(0.2627, 0.6780, 0.0593));
  let mappedLuma = textureSampleLevel(
    toneMap, linearSampler, vec2f(luma, 0.5), 0.0).r;
  if (luma <= 0.0001) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }
  return vec4f(min(sample.rgb * (mappedLuma / luma), vec3f(1.0)), 1.0);
}
`;

export class WebGpuHlgSdrRenderer {
  constructor({video, canvas, onError = () => {}, onLost = () => {}}) {
    this.video = video;
    this.canvas = canvas;
    this.onError = onError;
    this.onLost = onLost;
    this.device = null;
    this.context = null;
    this.format = null;
    this.pipeline = null;
    this.sampler = null;
    this.lut = null;
    this.lutTexture = null;
    this.enabled = false;
    this.initializing = null;
    this.failed = false;
    this.frameRequest = null;
    this.animationRequest = null;
    this.handlePlay = () => this.schedule();
    this.handlePause = () => this.cancelFrame();
    video.addEventListener('play', this.handlePlay);
    video.addEventListener('pause', this.handlePause);
    canvas.hidden = true;
  }

  setLut(lut) {
    if (!(lut instanceof Uint8Array) || lut.length < 2) {
      throw new TypeError('HLG-SDR LUT must be a Uint8Array');
    }
    this.lut = lut;
    if (this.device) this.uploadLut();
  }

  async setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.cancelFrame();
      this.canvas.hidden = true;
      return false;
    }
    if (!await this.ensureContext() || !this.enabled) return false;
    this.canvas.hidden = false;
    this.draw();
    this.schedule();
    return true;
  }

  async ensureContext() {
    if (this.device) return true;
    if (this.failed || !navigator.gpu) return false;
    if (!this.initializing) this.initializing = this.initialize();
    return this.initializing;
  }

  async initialize() {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      const context = this.canvas.getContext('webgpu');
      if (!context) return false;
      this.device = device;
      this.context = context;
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {module: device.createShaderModule({code: SHADER}), entryPoint: 'vertex'},
        fragment: {
          module: device.createShaderModule({code: SHADER}),
          entryPoint: 'fragment',
          targets: [{format: this.format}],
        },
        primitive: {topology: 'triangle-list'},
      });
      this.sampler = device.createSampler({magFilter: 'linear', minFilter: 'linear'});
      device.lost.then(() => {
        this.failed = true;
        this.enabled = false;
        this.cancelFrame();
        this.canvas.hidden = true;
        this.onLost();
      });
      this.resize();
      if (!this.lut) return false;
      this.uploadLut();
      return true;
    } catch (error) {
      this.failed = true;
      this.onError(error);
      return false;
    }
  }

  uploadLut() {
    if (!this.device || !this.lut) return;
    this.lutTexture?.destroy();
    this.lutTexture = this.device.createTexture({
      size: [this.lut.length, 1],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const bytesPerRow = Math.ceil(this.lut.length / 256) * 256;
    const bytes = new Uint8Array(bytesPerRow);
    bytes.set(this.lut);
    this.device.queue.writeTexture(
      {texture: this.lutTexture}, bytes, {bytesPerRow, rowsPerImage: 1},
      {width: this.lut.length, height: 1},
    );
  }

  resize() {
    if (!this.context || !this.device) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.context.configure({device: this.device, format: this.format, alphaMode: 'premultiplied'});
  }

  draw() {
    if (!this.enabled || !this.device || !this.context || !this.pipeline || !this.lutTexture ||
        this.video.readyState < 2 || this.video.videoWidth === 0 || this.video.videoHeight === 0) return;
    this.resize();
    const videoFrame = this.device.importExternalTexture({source: this.video});
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        {binding: 0, resource: videoFrame},
        {binding: 1, resource: this.sampler},
        {binding: 2, resource: this.lutTexture.createView()},
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

  schedule() {
    if (!this.enabled || this.video.paused || this.video.ended || this.frameRequest !== null ||
        this.animationRequest !== null) return;
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
    if (this.frameRequest !== null && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this.frameRequest);
    }
    if (this.animationRequest !== null) cancelAnimationFrame(this.animationRequest);
    this.frameRequest = null;
    this.animationRequest = null;
  }

  destroy() {
    this.cancelFrame();
    this.video.removeEventListener('play', this.handlePlay);
    this.video.removeEventListener('pause', this.handlePause);
    this.lutTexture?.destroy();
    this.canvas.hidden = true;
  }
}
