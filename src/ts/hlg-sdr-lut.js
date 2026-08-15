const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vTextureCoordinate;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vTextureCoordinate = aPosition * 0.5 + 0.5;
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uVideo;
uniform sampler2D uToneMap;
varying vec2 vTextureCoordinate;

void main() {
  if (vTextureCoordinate.x < 0.5) discard;
  vec4 sample = texture2D(uVideo, vTextureCoordinate);
  float toneMapR = texture2D(uToneMap, vec2(sample.r, 0.5)).r;
  float toneMapG = texture2D(uToneMap, vec2(sample.g, 0.5)).r;
  float toneMapB = texture2D(uToneMap, vec2(sample.b, 0.5)).r;
  gl_FragColor = vec4(
    toneMapR,
    toneMapG,
    toneMapB,
    sample.a
  );
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(`HLG-SDR shader compile failed: ${message}`);
  }
  return shader;
}

function createProgram(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'unknown program error';
    gl.deleteProgram(program);
    throw new Error(`HLG-SDR shader link failed: ${message}`);
  }
  return program;
}

export class HlgSdrRenderer {
  constructor({video, canvas, onError = () => {}}) {
    this.video = video;
    this.canvas = canvas;
    this.onError = onError;
    this.gl = null;
    this.program = null;
    this.texture = null;
    this.toneMapTexture = null;
    this.position = null;
    this.videoUniform = null;
    this.toneMapUniform = null;
    this.lut = null;
    this.enabled = false;
    this.frameRequest = null;
    this.animationRequest = null;
    this.failed = false;
    this.handlePlay = () => this.schedule();
    this.handlePause = () => this.cancelFrame();
    video.addEventListener('play', this.handlePlay);
    video.addEventListener('pause', this.handlePause);
    canvas.hidden = true;
  }

  setEnabled(enabled) {
    if (enabled === this.enabled && !enabled) return;
    if (enabled && !this.ensureContext()) return;
    this.enabled = enabled;
    this.canvas.hidden = !enabled;
    if (enabled) {
      this.draw();
      this.schedule();
    } else {
      this.cancelFrame();
    }
  }

  setLut(lut) {
    if (!(lut instanceof Uint8Array) || lut.length < 2) {
      throw new TypeError('HLG-SDR LUT must be a Uint8Array');
    }
    this.lut = lut;
    if (this.gl) this.uploadLut();
  }

  ensureContext() {
    if (this.gl) return true;
    if (this.failed) return false;
    try {
      const gl = this.canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: false,
      });
      if (!gl) throw new Error('WebGL is unavailable');
      this.gl = gl;
      this.program = createProgram(gl);
      this.videoUniform = gl.getUniformLocation(this.program, 'uVideo');
      this.toneMapUniform = gl.getUniformLocation(this.program, 'uToneMap');
      this.position = gl.getAttribLocation(this.program, 'aPosition');
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
      ]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.position);
      gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 0, 0);
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.toneMapTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.toneMapTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.uploadLut();
      return true;
    } catch (error) {
      this.failed = true;
      this.onError(error);
      return false;
    }
  }

  uploadLut() {
    if (!this.gl || !this.toneMapTexture || !this.lut) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.toneMapTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.LUMINANCE, this.lut.length, 1, 0,
      gl.LUMINANCE, gl.UNSIGNED_BYTE, this.lut,
    );
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

  draw() {
    if (!this.enabled || !this.gl || this.video.readyState < 2 ||
        this.video.videoWidth === 0 || this.video.videoHeight === 0) return;
    const gl = this.gl;
    this.resize();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.toneMapTexture);
    gl.uniform1i(this.videoUniform, 0);
    gl.uniform1i(this.toneMapUniform, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
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
    this.gl?.deleteTexture(this.texture);
    this.gl?.deleteTexture(this.toneMapTexture);
    this.gl?.deleteProgram(this.program);
    this.canvas.hidden = true;
  }
}
