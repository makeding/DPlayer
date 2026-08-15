// Adapted from tlvdemux/demo/{webgpu-hlg-sdr,hlg-sdr-lut}.js.  The demo's
// side-by-side comparison is intentionally changed to a full-frame overlay.
const webGlVertexShader = `
attribute vec2 aPosition;
varying vec2 vTextureCoordinate;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vTextureCoordinate = aPosition * 0.5 + 0.5;
}`;
const webGlFragmentShader = `
precision mediump float;
uniform sampler2D uVideo;
uniform sampler2D uToneMap;
varying vec2 vTextureCoordinate;
void main() {
  vec4 sample = texture2D(uVideo, vTextureCoordinate);
  float luma = dot(sample.rgb, vec3(0.2627, 0.6780, 0.0593));
  float mappedLuma = texture2D(uToneMap, vec2(luma, 0.5)).r;
  if (luma <= 0.0001) gl_FragColor = vec4(0.0, 0.0, 0.0, sample.a);
  else gl_FragColor = vec4(min(sample.rgb * (mappedLuma / luma), vec3(1.0)), sample.a);
}`;
const webGpuShader = /* wgsl */`
struct Output { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@group(0) @binding(0) var videoFrame: texture_external;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var toneMap: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Output {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let position = positions[index];
  return Output(vec4f(position, 0.0, 1.0), vec2f((position.x + 1.0) * 0.5, (1.0 - position.y) * 0.5));
}
@fragment fn fragment(input: Output) -> @location(0) vec4f {
  let sample = textureSampleBaseClampToEdge(videoFrame, linearSampler, input.uv);
  let luma = dot(sample.rgb, vec3f(0.2627, 0.6780, 0.0593));
  let mappedLuma = textureSampleLevel(toneMap, linearSampler, vec2f(luma, 0.5), 0.0).r;
  if (luma <= 0.0001) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return vec4f(min(sample.rgb * (mappedLuma / luma), vec3f(1.0)), 1.0);
}`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    const message = gl.getShaderInfoLog(shader) || 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(`HLG-SDR shader compile failed: ${message}`);
}

class WebGlHlgSdrRenderer {
    private gl: WebGLRenderingContext | null = null;
    private program: WebGLProgram | null = null;
    private videoTexture: WebGLTexture | null = null;
    private toneMapTexture: WebGLTexture | null = null;
    private position = -1;
    private videoUniform: WebGLUniformLocation | null = null;
    private toneMapUniform: WebGLUniformLocation | null = null;
    private frameRequest: number | null = null;
    private animationRequest: number | null = null;
    private enabled = false;
    private failed = false;
    private lut: Uint8Array | null = null;

    constructor(private readonly video: HTMLVideoElement, private readonly canvas: HTMLCanvasElement) {
        video.addEventListener('play', this.schedule);
        video.addEventListener('pause', this.cancelFrame);
        canvas.hidden = true;
    }

    setLut(lut: Uint8Array): void { this.lut = lut; if (this.gl) this.uploadLut(); }
    setEnabled(enabled: boolean): boolean {
        if (enabled && !this.ensureContext()) return false;
        this.enabled = enabled;
        this.canvas.hidden = !enabled;
        if (enabled) { this.draw(); this.schedule(); } else this.cancelFrame();
        return enabled;
    }
    destroy(): void {
        this.cancelFrame();
        this.video.removeEventListener('play', this.schedule);
        this.video.removeEventListener('pause', this.cancelFrame);
        this.gl?.deleteTexture(this.videoTexture);
        this.gl?.deleteTexture(this.toneMapTexture);
        this.gl?.deleteProgram(this.program);
        this.canvas.remove();
    }
    private ensureContext(): boolean {
        if (this.gl) return true;
        if (this.failed || !this.lut) return false;
        try {
            const gl = this.canvas.getContext('webgl', {alpha: true, antialias: false, premultipliedAlpha: false});
            if (!gl) throw new Error('WebGL is unavailable');
            const program = gl.createProgram()!;
            gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, webGlVertexShader));
            gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, webGlFragmentShader));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'HLG-SDR shader link failed');
            this.gl = gl;
            this.program = program;
            this.videoUniform = gl.getUniformLocation(program, 'uVideo');
            this.toneMapUniform = gl.getUniformLocation(program, 'uToneMap');
            this.position = gl.getAttribLocation(program, 'aPosition');
            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(this.position);
            gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 0, 0);
            this.videoTexture = this.createTexture(gl);
            this.toneMapTexture = this.createTexture(gl);
            this.uploadLut();
            return true;
        } catch {
            this.failed = true;
            return false;
        }
    }
    private createTexture(gl: WebGLRenderingContext): WebGLTexture {
        const texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    }
    private uploadLut(): void {
        if (!this.gl || !this.toneMapTexture || !this.lut) return;
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.toneMapTexture);
        this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, 1);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.LUMINANCE, this.lut.length, 1, 0,
            this.gl.LUMINANCE, this.gl.UNSIGNED_BYTE, this.lut);
    }
    private resize(): void {
        if (!this.gl) return;
        const ratio = Math.min(devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
        if (this.canvas.width === width && this.canvas.height === height) return;
        this.canvas.width = width;
        this.canvas.height = height;
        this.gl.viewport(0, 0, width, height);
    }
    private draw = (): void => {
        if (!this.enabled || !this.gl || !this.program || this.video.readyState < 2 || !this.video.videoWidth) return;
        this.resize();
        const gl = this.gl;
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(this.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.toneMapTexture);
        gl.uniform1i(this.videoUniform, 0);
        gl.uniform1i(this.toneMapUniform, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    private schedule = (): void => {
        if (!this.enabled || this.video.paused || this.video.ended || this.frameRequest !== null || this.animationRequest !== null) return;
        if (typeof this.video.requestVideoFrameCallback === 'function') {
            this.frameRequest = this.video.requestVideoFrameCallback(() => { this.frameRequest = null; this.draw(); this.schedule(); });
        } else this.animationRequest = requestAnimationFrame(() => { this.animationRequest = null; this.draw(); this.schedule(); });
    };
    private cancelFrame = (): void => {
        if (this.frameRequest !== null && typeof this.video.cancelVideoFrameCallback === 'function') this.video.cancelVideoFrameCallback(this.frameRequest);
        if (this.animationRequest !== null) cancelAnimationFrame(this.animationRequest);
        this.frameRequest = null;
        this.animationRequest = null;
    };
}

class WebGpuHlgSdrRenderer {
    private device: any = null;
    private context: any = null;
    private pipeline: any = null;
    private sampler: any = null;
    private lutTexture: any = null;
    private lut: Uint8Array | null = null;
    private enabled = false;
    private failed = false;
    private initializing: Promise<boolean> | null = null;
    private frameRequest: number | null = null;
    private animationRequest: number | null = null;
    constructor(private readonly video: HTMLVideoElement, private readonly canvas: HTMLCanvasElement) {
        video.addEventListener('play', this.schedule);
        video.addEventListener('pause', this.cancelFrame);
        canvas.hidden = true;
    }
    setLut(lut: Uint8Array): void { this.lut = lut; if (this.device) this.uploadLut(); }
    async setEnabled(enabled: boolean): Promise<boolean> {
        this.enabled = enabled;
        if (!enabled) { this.cancelFrame(); this.canvas.hidden = true; return false; }
        if (!await this.ensureContext() || !this.enabled) return false;
        this.canvas.hidden = false;
        this.draw(); this.schedule();
        return true;
    }
    destroy(): void {
        this.cancelFrame();
        this.video.removeEventListener('play', this.schedule);
        this.video.removeEventListener('pause', this.cancelFrame);
        this.lutTexture?.destroy();
        this.canvas.remove();
    }
    private async ensureContext(): Promise<boolean> {
        if (this.device) return true;
        if (this.failed || !this.lut || !(navigator as Navigator & {gpu?: any}).gpu) return false;
        if (!this.initializing) this.initializing = this.initialize();
        return this.initializing;
    }
    private async initialize(): Promise<boolean> {
        try {
            const gpu = (navigator as Navigator & {gpu: any}).gpu;
            const adapter = await gpu.requestAdapter();
            if (!adapter) return false;
            this.device = await adapter.requestDevice();
            this.context = this.canvas.getContext('webgpu');
            if (!this.context) return false;
            const format = gpu.getPreferredCanvasFormat();
            this.pipeline = this.device.createRenderPipeline({layout: 'auto', vertex: {module: this.device.createShaderModule({code: webGpuShader}), entryPoint: 'vertex'}, fragment: {module: this.device.createShaderModule({code: webGpuShader}), entryPoint: 'fragment', targets: [{format}]}, primitive: {topology: 'triangle-list'}});
            this.sampler = this.device.createSampler({magFilter: 'linear', minFilter: 'linear'});
            this.device.lost.then(() => { this.failed = true; this.enabled = false; this.cancelFrame(); this.canvas.hidden = true; });
            this.resize(format);
            this.uploadLut();
            return true;
        } catch { this.failed = true; return false; }
    }
    private uploadLut(): void {
        if (!this.device || !this.lut) return;
        this.lutTexture?.destroy();
        this.lutTexture = this.device.createTexture({size: [this.lut.length, 1], format: 'r8unorm', usage: 0x04 | 0x08});
        const bytesPerRow = Math.ceil(this.lut.length / 256) * 256;
        const bytes = new Uint8Array(bytesPerRow); bytes.set(this.lut);
        this.device.queue.writeTexture({texture: this.lutTexture}, bytes, {bytesPerRow, rowsPerImage: 1}, {width: this.lut.length, height: 1});
    }
    private resize(format?: any): void {
        if (!this.context || !this.device) return;
        const ratio = Math.min(devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
        if (this.canvas.width === width && this.canvas.height === height) return;
        this.canvas.width = width; this.canvas.height = height;
        this.context.configure({device: this.device, format: format ?? (navigator as Navigator & {gpu: any}).gpu.getPreferredCanvasFormat(), alphaMode: 'premultiplied'});
    }
    private draw = (): void => {
        if (!this.enabled || !this.device || !this.context || !this.pipeline || !this.lutTexture || this.video.readyState < 2 || !this.video.videoWidth) return;
        this.resize();
        const bindGroup = this.device.createBindGroup({layout: this.pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: this.device.importExternalTexture({source: this.video})}, {binding: 1, resource: this.sampler}, {binding: 2, resource: this.lutTexture.createView()}]});
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({colorAttachments: [{view: this.context.getCurrentTexture().createView(), clearValue: {r: 0, g: 0, b: 0, a: 0}, loadOp: 'clear', storeOp: 'store'}]});
        pass.setPipeline(this.pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
        this.device.queue.submit([encoder.finish()]);
    };
    private schedule = (): void => {
        if (!this.enabled || this.video.paused || this.video.ended || this.frameRequest !== null || this.animationRequest !== null) return;
        if (typeof this.video.requestVideoFrameCallback === 'function') this.frameRequest = this.video.requestVideoFrameCallback(() => { this.frameRequest = null; this.draw(); this.schedule(); });
        else this.animationRequest = requestAnimationFrame(() => { this.animationRequest = null; this.draw(); this.schedule(); });
    };
    private cancelFrame = (): void => {
        if (this.frameRequest !== null && typeof this.video.cancelVideoFrameCallback === 'function') this.video.cancelVideoFrameCallback(this.frameRequest);
        if (this.animationRequest !== null) cancelAnimationFrame(this.animationRequest);
        this.frameRequest = null; this.animationRequest = null;
    };
}

export default class HlgSdrRenderer {
    private readonly webGpuCanvas = document.createElement('canvas');
    private readonly webGlCanvas = document.createElement('canvas');
    private readonly webGpu: WebGpuHlgSdrRenderer;
    private readonly webGl: WebGlHlgSdrRenderer;
    private readonly layoutObserver: MutationObserver;
    private readonly resizeObserver: ResizeObserver;
    private enabled = false;
    constructor(video: HTMLVideoElement, mediaPlane: HTMLElement) {
        for (const canvas of [this.webGpuCanvas, this.webGlCanvas]) {
            canvas.className = 'dplayer-hlg-sdr-canvas';
            canvas.setAttribute('aria-hidden', 'true');
            Object.assign(canvas.style, {position: 'absolute', zIndex: '2', inset: '0', width: '100%', height: '100%', pointerEvents: 'none'});
            mediaPlane.append(canvas);
        }
        this.webGpu = new WebGpuHlgSdrRenderer(video, this.webGpuCanvas);
        this.webGl = new WebGlHlgSdrRenderer(video, this.webGlCanvas);
        this.layoutObserver = new MutationObserver(() => this.syncLayout(video));
        this.layoutObserver.observe(video, {attributes: true, attributeFilter: ['style']});
        this.resizeObserver = new ResizeObserver(() => this.syncLayout(video));
        this.resizeObserver.observe(video);
        this.syncLayout(video);
    }
    setLut(lut: Uint8Array): void {
        this.webGpu.setLut(lut);
        this.webGl.setLut(lut);
        if (this.enabled) this.setEnabled(true);
    }
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (!enabled) { this.webGl.setEnabled(false); void this.webGpu.setEnabled(false); return; }
        // WebGPU external textures may be available but reject an MSE-backed
        // video only while drawing. Prefer the demo's synchronous WebGL path
        // so a transparent WebGPU canvas cannot mask the working fallback.
        if (this.webGl.setEnabled(true)) {
            void this.webGpu.setEnabled(false);
            return;
        }
        void this.webGpu.setEnabled(true);
    }
    destroy(): void {
        this.layoutObserver.disconnect();
        this.resizeObserver.disconnect();
        this.webGpu.destroy();
        this.webGl.destroy();
    }

    private syncLayout(video: HTMLVideoElement): void {
        const externalPlane = video.style.position === 'absolute' && video.style.width !== '' && video.style.height !== '';
        for (const canvas of [this.webGpuCanvas, this.webGlCanvas]) {
            if (externalPlane) {
                Object.assign(canvas.style, {
                    inset: 'auto',
                    left: video.style.left,
                    top: video.style.top,
                    width: video.style.width,
                    height: video.style.height,
                    zIndex: video.style.zIndex || '1',
                });
            } else {
                Object.assign(canvas.style, {
                    inset: '0',
                    left: 'auto',
                    top: 'auto',
                    width: '100%',
                    height: '100%',
                    zIndex: '2',
                });
            }
        }
    }
}
