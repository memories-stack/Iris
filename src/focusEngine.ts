import * as faceapi from 'face-api.js';
import {
  BlurAnalysisResult,
  BoundingBox,
  CullingStatus,
  CullingThresholds,
  FocusRegion,
  PhotoItem,
  Point2D,
} from './types';
import {
  OFFLINE_MODEL_MANIFESTS,
  OFFLINE_MODEL_SHARDS_B64,
  b64ToArrayBuffer,
} from './offlineModels';

export const DEFAULT_THRESHOLDS: CullingThresholds = {
  sharpMin: 65,
  softMin: 42,
  portraitWeight: 1.85,
  blinkDetection: true,
  gpuConcurrency: 4,
};

// ============================================================================
// 1. 100% OFFLINE NEURAL AI INITIALIZER (TinyFaceDetector + 68-Landmark Net)
// ============================================================================
let neuralAiInitialized = false;
let neuralAiInitPromise: Promise<boolean> | null = null;
let detectedGpuName = 'Apple Silicon / WebGL2 GPU';

export async function initOfflineNeuralAI(): Promise<{ ready: boolean; gpuName: string }> {
  if (neuralAiInitialized) {
    return { ready: true, gpuName: detectedGpuName };
  }
  if (neuralAiInitPromise) {
    const ok = await neuralAiInitPromise;
    return { ready: ok, gpuName: detectedGpuName };
  }

  neuralAiInitPromise = (async () => {
    try {
      // Detect WebGL2 GPU Renderer Name
      const testCanvas = document.createElement('canvas');
      const gl = testCanvas.getContext('webgl2');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          detectedGpuName = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || detectedGpuName;
        }
      }

      // Monkey-patch fetch so face-api.js reads weights 100% from embedded RAM (zero network)
      const originalFetch = window.fetch.bind(window);
      faceapi.env.monkeyPatch({
        fetch: async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const urlStr = typeof url === 'string' ? url : url.toString();
          for (const [manifestName, manifestJson] of Object.entries(OFFLINE_MODEL_MANIFESTS)) {
            if (urlStr.endsWith(manifestName)) {
              return new Response(JSON.stringify(manifestJson), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              });
            }
          }
          for (const [shardName, b64Data] of Object.entries(OFFLINE_MODEL_SHARDS_B64)) {
            if (urlStr.endsWith(shardName)) {
              const buf = b64ToArrayBuffer(b64Data);
              return new Response(buf, {
                status: 200,
                headers: { 'Content-Type': 'application/octet-stream' },
              });
            }
          }
          return originalFetch(url, init);
        },
      });

      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri('/offline-models'),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri('/offline-models'),
      ]);

      neuralAiInitialized = true;
      return true;
    } catch (err) {
      console.warn('Neural AI fallback to WebGL2 Saliency:', err);
      return false;
    }
  })();

  const ready = await neuralAiInitPromise;
  return { ready, gpuName: detectedGpuName };
}

// ============================================================================
// 2. WEBGL2 GPU FOCUS & BLUR COMPUTE SHADER ENGINE
// ============================================================================
class WebGL2FocusComputeEngine {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private texture: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private outTex: WebGLTexture | null = null;
  private currentW = 0;
  private currentH = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.initGL();
  }

  private initGL() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) return;
    this.gl = gl;

    const vsSource = `#version 300 es
      in vec2 a_pos;
      out vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    // Computes in parallel on GPU per pixel:
    // R = 8-Neighbor Laplacian Magnitude (Normalized)
    // G = Tenengrad Sobel Gradient Magnitude (Normalized)
    // B = Directional Anisotropy (0.5 + 0.5 * (|Gx| - |Gy|) / (|Gx| + |Gy| + 1))
    // A = Human Skin Chrominance Saliency (0.0 or 1.0)
    const fsSource = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_tex;
      uniform vec2 u_texel;
      out vec4 outColor;

      float luma(vec3 c) {
        return dot(c, vec3(0.299, 0.587, 0.114));
      }

      void main() {
        vec3 c00 = texture(u_tex, v_uv + vec2(-u_texel.x, -u_texel.y)).rgb;
        vec3 c10 = texture(u_tex, v_uv + vec2(0.0,        -u_texel.y)).rgb;
        vec3 c20 = texture(u_tex, v_uv + vec2( u_texel.x, -u_texel.y)).rgb;
        vec3 c01 = texture(u_tex, v_uv + vec2(-u_texel.x,  0.0)).rgb;
        vec3 c11 = texture(u_tex, v_uv).rgb;
        vec3 c21 = texture(u_tex, v_uv + vec2( u_texel.x,  0.0)).rgb;
        vec3 c02 = texture(u_tex, v_uv + vec2(-u_texel.x,  u_texel.y)).rgb;
        vec3 c12 = texture(u_tex, v_uv + vec2(0.0,         u_texel.y)).rgb;
        vec3 c22 = texture(u_tex, v_uv + vec2( u_texel.x,  u_texel.y)).rgb;

        float l00 = luma(c00), l10 = luma(c10), l20 = luma(c20);
        float l01 = luma(c01), l11 = luma(c11), l21 = luma(c21);
        float l02 = luma(c02), l12 = luma(c12), l22 = luma(c22);

        // 8-neighbor discrete Laplacian
        float lap = abs(l00 + l10 + l20 + l01 - 8.0 * l11 + l21 + l02 + l12 + l22);

        // Sobel Gradients
        float gx = -l00 + l20 - 2.0 * l01 + 2.0 * l21 - l02 + l22;
        float gy = -l00 - 2.0 * l10 - l20 + l02 + 2.0 * l12 + l22;
        float gradMag = sqrt(gx * gx + gy * gy);

        // Anisotropy encoded in [0, 1] where 0.5 = isotropic
        float aniso = 0.5 + 0.5 * ((abs(gx) - abs(gy)) / (abs(gx) + abs(gy) + 0.005));

        // YCrCb Skin Chrominance detection (from SnapPro)
        float r = c11.r * 255.0;
        float g = c11.g * 255.0;
        float b = c11.b * 255.0;
        float cr = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        float cb = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        float isSkin = (r >= 65.0 && g >= 40.0 && b >= 25.0 && (r - g) >= 12.0 && (r - b) >= 18.0 && cr >= 133.0 && cr <= 178.0 && cb >= 80.0 && cb <= 135.0) ? 1.0 : 0.0;

        outColor = vec4(
          clamp(lap * 0.5, 0.0, 1.0),
          clamp(gradMag * 0.35, 0.0, 1.0),
          clamp(aniso, 0.0, 1.0),
          isSkin
        );
      }
    `;

    const vs = this.compileShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    this.program = prog;

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture();
    this.outTex = gl.createTexture();
    this.fbo = gl.createFramebuffer();
  }

  private compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  public computeFeatureMap(source: HTMLCanvasElement | HTMLImageElement | ImageBitmap, w: number, h: number): Uint8Array | null {
    const gl = this.gl;
    if (!gl || !this.program || !this.texture || !this.outTex || !this.fbo) return null;

    if (this.currentW !== w || this.currentH !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.currentW = w;
      this.currentH = h;

      gl.bindTexture(gl.TEXTURE_2D, this.outTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outTex, 0);
    }

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_texel'), 1.0 / w, 1.0 / h);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    const outBuf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, outBuf);
    return outBuf;
  }
}

let sharedGpuFocusEngine: WebGL2FocusComputeEngine | null = null;
let sharedWorkCanvas: HTMLCanvasElement | null = null;
let sharedThumbCanvas: HTMLCanvasElement | null = null;

// ============================================================================
// 3. EYE ASPECT RATIO (EAR) FOR BLINK / CLOSED EYE DETECTION
// ============================================================================
function dist2D(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function computeEyeAspectRatio(eyePts: { x: number; y: number }[]): number {
  if (eyePts.length < 6) return 0.3;
  // Standard 6-point eye landmarks: p0(left corner), p1, p2(top), p3(right corner), p4, p5(bottom)
  const v1 = dist2D(eyePts[1], eyePts[5]);
  const v2 = dist2D(eyePts[2], eyePts[4]);
  const h = dist2D(eyePts[0], eyePts[3]);
  if (h < 1e-4) return 0.3;
  return (v1 + v2) / (2.0 * h);
}

function computePointsBoundingBox(
  pts: { x: number; y: number }[],
  padRatio: number,
  maxW: number,
  maxH: number
): BoundingBox {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const w = Math.max(12, maxX - minX);
  const h = Math.max(12, maxY - minY);
  const padX = w * padRatio;
  const padY = h * padRatio;
  const x = Math.max(0, Math.round(minX - padX));
  const y = Math.max(0, Math.round(minY - padY));
  return {
    x,
    y,
    width: Math.min(maxW - x, Math.round(w + padX * 2)),
    height: Math.min(maxH - y, Math.round(h + padY * 2)),
  };
}

// ============================================================================
// 4. MEMORY-SAFE HIGH-SPEED IMAGE ANALYSIS (5,000+ FILES ZERO-LAG PIPELINE)
// ============================================================================
export async function analyzeImageSource(
  fileOrUrl: File | string,
  thresholds: CullingThresholds = DEFAULT_THRESHOLDS
): Promise<{ result: BlurAnalysisResult; thumbUrl: string; width: number; height: number }> {
  const startTime = performance.now();

  let bitmap: ImageBitmap;
  if (typeof fileOrUrl === 'string') {
    bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = async () => {
        try {
          const bmp = await createImageBitmap(img);
          resolve(bmp);
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error('Failed to load native image URL'));
      img.src = fileOrUrl;
    });
  } else {
    try {
      bitmap = await createImageBitmap(fileOrUrl);
    } catch {
      bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
        const url = URL.createObjectURL(fileOrUrl);
        const img = new Image();
        img.onload = async () => {
          try {
            const bmp = await createImageBitmap(img);
            URL.revokeObjectURL(url);
            resolve(bmp);
          } catch (e) {
            URL.revokeObjectURL(url);
            reject(e);
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Failed to decode image'));
        };
        img.src = url;
      });
    }
  }

  const origW = bitmap.width;
  const origH = bitmap.height;

  // 2. Generate ultra-lightweight ~12KB micro-thumbnail (320px max) so 5,000 photos use < 65MB RAM
  if (!sharedThumbCanvas) {
    sharedThumbCanvas = document.createElement('canvas');
  }
  const thumbScale = Math.min(1, 320 / Math.max(origW, origH));
  sharedThumbCanvas.width = Math.max(16, Math.round(origW * thumbScale));
  sharedThumbCanvas.height = Math.max(16, Math.round(origH * thumbScale));
  const thumbCtx = sharedThumbCanvas.getContext('2d')!;
  thumbCtx.drawImage(bitmap, 0, 0, sharedThumbCanvas.width, sharedThumbCanvas.height);

  const thumbBlob = await new Promise<Blob | null>((res) =>
    sharedThumbCanvas!.toBlob((b) => res(b), 'image/jpeg', 0.76)
  );
  const thumbUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : '';

  // 3. Draw 640px working frame for GPU Shader + Neural Landmark AI
  const analysisMaxDim = 640;
  const scale = Math.min(1, analysisMaxDim / Math.max(origW, origH));
  const sw = Math.max(32, Math.round(origW * scale));
  const sh = Math.max(32, Math.round(origH * scale));

  if (!sharedWorkCanvas) {
    sharedWorkCanvas = document.createElement('canvas');
  }
  sharedWorkCanvas.width = sw;
  sharedWorkCanvas.height = sh;
  const workCtx = sharedWorkCanvas.getContext('2d', { willReadFrequently: true })!;
  workCtx.drawImage(bitmap, 0, 0, sw, sh);

  // Immediately release full-resolution ImageBitmap from RAM!
  bitmap.close();

  // 4. Run 68-Point Neural Face & Eye Landmark Detection if initialized
  let neuralBoxes: {
    faceBox: BoundingBox;
    leftEyeBox: BoundingBox;
    rightEyeBox: BoundingBox;
    ear: number;
    landmarks: Point2D[];
  }[] = [];

  if (neuralAiInitialized) {
    try {
      const detections = await faceapi
        .detectAllFaces(
          sharedWorkCanvas,
          new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.42 })
        )
        .withFaceLandmarks(true);

      for (const det of detections) {
        const box = det.detection.box;
        const leftEyePts = det.landmarks.getLeftEye();
        const rightEyePts = det.landmarks.getRightEye();
        const earLeft = computeEyeAspectRatio(leftEyePts);
        const earRight = computeEyeAspectRatio(rightEyePts);
        const ear = (earLeft + earRight) * 0.5;

        neuralBoxes.push({
          faceBox: {
            x: Math.max(0, Math.round(box.x)),
            y: Math.max(0, Math.round(box.y)),
            width: Math.min(sw, Math.round(box.width)),
            height: Math.min(sh, Math.round(box.height)),
          },
          leftEyeBox: computePointsBoundingBox(leftEyePts, 0.85, sw, sh),
          rightEyeBox: computePointsBoundingBox(rightEyePts, 0.85, sw, sh),
          ear,
          landmarks: det.landmarks.positions.map((p) => ({
            x: Math.round(p.x / scale),
            y: Math.round(p.y / scale),
          })),
        });
      }
    } catch {
      // Ignore neural detection transient errors
    }
  }

  // 5. Run WebGL2 GPU Focus & Blur Shader
  if (!sharedGpuFocusEngine) {
    sharedGpuFocusEngine = new WebGL2FocusComputeEngine();
  }
  const gpuMap = sharedGpuFocusEngine.computeFeatureMap(sharedWorkCanvas, sw, sh);

  const result = evaluateFocusMetrics(
    gpuMap,
    sharedWorkCanvas,
    sw,
    sh,
    scale,
    neuralBoxes,
    thresholds,
    startTime
  );

  return { result, thumbUrl, width: origW, height: origH };
}

function measureBoxSharpnessFromGpuMap(
  gpuMap: Uint8Array,
  sw: number,
  sh: number,
  box: BoundingBox
): { lapEnergy: number; tenengrad: number; anisoDiff: number } {
  const x0 = Math.max(1, box.x);
  const y0 = Math.max(1, box.y);
  const x1 = Math.min(sw - 1, box.x + box.width);
  const y1 = Math.min(sh - 1, box.y + box.height);

  let lapSumSq = 0;
  let tenSum = 0;
  let gxBias = 0;
  let count = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = (y * sw + x) * 4;
      const lap = gpuMap[idx]; // 0..255
      const grad = gpuMap[idx + 1]; // 0..255
      const aniso = gpuMap[idx + 2]; // 0..255 (128 = neutral)

      lapSumSq += lap * lap;
      if (grad > 28) {
        tenSum += grad * grad;
        gxBias += aniso - 128;
      }
      count++;
    }
  }

  if (count === 0) return { lapEnergy: 0, tenengrad: 0, anisoDiff: 0 };
  return {
    lapEnergy: lapSumSq / count,
    tenengrad: tenSum / count,
    anisoDiff: Math.abs(gxBias / count),
  };
}

function evaluateFocusMetrics(
  gpuMap: Uint8Array | null,
  workCanvas: HTMLCanvasElement,
  sw: number,
  sh: number,
  scale: number,
  neuralBoxes: {
    faceBox: BoundingBox;
    leftEyeBox: BoundingBox;
    rightEyeBox: BoundingBox;
    ear: number;
    landmarks: Point2D[];
  }[],
  thresholds: CullingThresholds,
  startTime: number
): BlurAnalysisResult {
  // Ensure we have feature buffer (GPU map)
  let featureBuf = gpuMap;
  if (!featureBuf) {
    // Fallback if WebGL2 context unavailable
    featureBuf = new Uint8Array(sw * sh * 4);
  }

  // Scan whole frame for background & skin saliency
  let skinCount = 0;
  let skinSumX = 0;
  let skinSumY = 0;
  let minSkinX = sw,
    maxSkinX = 0,
    minSkinY = sh,
    maxSkinY = 0;

  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const idx = (y * sw + x) * 4;
      if (featureBuf[idx + 3] > 128) {
        skinCount++;
        skinSumX += x;
        skinSumY += y;
        if (x < minSkinX) minSkinX = x;
        if (x > maxSkinX) maxSkinX = x;
        if (y < minSkinY) minSkinY = y;
        if (y > maxSkinY) maxSkinY = y;
      }
    }
  }

  const focusRegions: FocusRegion[] = [];
  let detectedSubject: 'neural_eye' | 'skin_portrait' | 'general_object' = 'general_object';
  let leftEyeSharpness: number | undefined;
  let rightEyeSharpness: number | undefined;
  let eyeAspectRatio: number | undefined;
  let hasEyesOpen = true;
  let eyesClosedWarning = false;
  let landmarks: Point2D[] | undefined;

  let subjMetrics = { lapEnergy: 0, tenengrad: 0, anisoDiff: 0 };

  if (neuralBoxes.length > 0) {
    // Pick primary/largest face
    neuralBoxes.sort((a, b) => b.faceBox.width * b.faceBox.height - a.faceBox.width * a.faceBox.height);
    const primary = neuralBoxes[0];
    detectedSubject = 'neural_eye';
    landmarks = primary.landmarks;
    eyeAspectRatio = Math.round(primary.ear * 1000) / 1000;

    if (primary.ear < 0.195) {
      hasEyesOpen = false;
      eyesClosedWarning = true;
    }

    const leftM = measureBoxSharpnessFromGpuMap(featureBuf, sw, sh, primary.leftEyeBox);
    const rightM = measureBoxSharpnessFromGpuMap(featureBuf, sw, sh, primary.rightEyeBox);
    const faceM = measureBoxSharpnessFromGpuMap(featureBuf, sw, sh, primary.faceBox);

    leftEyeSharpness = Math.round(leftM.lapEnergy * 0.45);
    rightEyeSharpness = Math.round(rightM.lapEnergy * 0.45);

    const bestEyeLap = Math.max(leftM.lapEnergy, rightM.lapEnergy);
    subjMetrics = {
      lapEnergy: bestEyeLap * 0.72 + faceM.lapEnergy * 0.28,
      tenengrad: Math.max(leftM.tenengrad, rightM.tenengrad),
      anisoDiff: faceM.anisoDiff,
    };

    const toOrigBox = (b: BoundingBox): BoundingBox => ({
      x: Math.round(b.x / scale),
      y: Math.round(b.y / scale),
      width: Math.round(b.width / scale),
      height: Math.round(b.height / scale),
    });

    focusRegions.push(
      {
        type: 'left_eye',
        label: 'ดวงตาซ้าย (AI Eye Focus)',
        box: toOrigBox(primary.leftEyeBox),
        sharpness: leftEyeSharpness,
      },
      {
        type: 'right_eye',
        label: 'ดวงตาขวา (AI Eye Focus)',
        box: toOrigBox(primary.rightEyeBox),
        sharpness: rightEyeSharpness,
      },
      {
        type: 'face',
        label: 'กรอบใบหน้า (AI Face)',
        box: toOrigBox(primary.faceBox),
        sharpness: Math.round(faceM.lapEnergy * 0.45),
      }
    );
  } else if (skinCount > sw * sh * 0.018 && skinCount < sw * sh * 0.8) {
    detectedSubject = 'skin_portrait';
    const avgX = skinSumX / skinCount;
    const avgY = skinSumY / skinCount;
    const fw = Math.max(sw * 0.14, (maxSkinX - minSkinX) * 0.6);
    const fh = Math.max(sh * 0.14, (maxSkinY - minSkinY) * 0.55);
    const skinBox: BoundingBox = {
      x: Math.max(0, Math.round(avgX - fw * 0.5)),
      y: Math.max(0, Math.round(avgY * 0.88 - fh * 0.5)),
      width: Math.round(fw),
      height: Math.round(fh),
    };
    subjMetrics = measureBoxSharpnessFromGpuMap(featureBuf, sw, sh, skinBox);
    focusRegions.push({
      type: 'face',
      label: 'จุดโฟกัสตัวแบบ (Portrait Saliency)',
      box: {
        x: Math.round(skinBox.x / scale),
        y: Math.round(skinBox.y / scale),
        width: Math.round(skinBox.width / scale),
        height: Math.round(skinBox.height / scale),
      },
      sharpness: Math.round(subjMetrics.lapEnergy * 0.45),
    });
  } else {
    detectedSubject = 'general_object';
    const centerBox: BoundingBox = {
      x: Math.round(sw * 0.2),
      y: Math.round(sh * 0.15),
      width: Math.round(sw * 0.6),
      height: Math.round(sh * 0.7),
    };
    subjMetrics = measureBoxSharpnessFromGpuMap(featureBuf, sw, sh, centerBox);
    focusRegions.push({
      type: 'center',
      label: 'จุดโฟกัสกลางภาพ (Center Zone)',
      box: {
        x: Math.round(centerBox.x / scale),
        y: Math.round(centerBox.y / scale),
        width: Math.round(centerBox.width / scale),
        height: Math.round(centerBox.height / scale),
      },
      sharpness: Math.round(subjMetrics.lapEnergy * 0.45),
    });
  }

  // Measure outer background sharpness (top/left/right margins)
  const bgTop = measureBoxSharpnessFromGpuMap(featureBuf, sw, sh, {
    x: 0,
    y: 0,
    width: sw,
    height: Math.round(sh * 0.18),
  });
  const fullFrame = measureBoxSharpnessFromGpuMap(featureBuf, sw, sh, {
    x: 0,
    y: 0,
    width: sw,
    height: sh,
  });

  const subjSharp = Math.round(subjMetrics.lapEnergy * 0.45);
  const bgSharp = Math.round((bgTop.lapEnergy * 0.6 + fullFrame.lapEnergy * 0.4) * 0.45);
  const bokehRatio = Math.round(((subjSharp + 5) / (bgSharp + 5)) * 100) / 100;

  // Classify Blur Type
  let blurType: 'none' | 'motion_blur' | 'out_of_focus' | 'eyes_closed' | 'back_focus' = 'none';
  let motionAngle: number | undefined;
  let motionMagnitude: number | undefined;

  if (subjMetrics.anisoDiff > 16.5 && subjSharp < 180) {
    blurType = 'motion_blur';
    motionAngle = subjMetrics.anisoDiff > 0 ? 0 : 90;
    motionMagnitude = Math.round((subjMetrics.anisoDiff / 10) * 10) / 10;
  }

  // Compute Calibrated 0-100 Score
  let effectiveEnergy = subjSharp;
  if (detectedSubject !== 'general_object') {
    if (bokehRatio >= 1.2) {
      // Shallow DOF Bokeh Portrait (f/1.2 - f/2.8): Reward sharp eye/subject!
      effectiveEnergy = subjSharp * thresholds.portraitWeight;
    } else if (bokehRatio < 0.62 && bgSharp > 120) {
      // Back-focus: background trees/wall sharp, subject blurry!
      effectiveEnergy = subjSharp * 0.58;
      blurType = 'back_focus';
    }
  } else {
    effectiveEnergy = subjSharp * 0.65 + bgSharp * 0.35;
  }

  let rawScore = 0;
  if (effectiveEnergy > 0) {
    const logVal = Math.log10(effectiveEnergy + 1);
    rawScore = ((logVal - 0.85) / (2.95 - 0.85)) * 100;
  }

  if (blurType === 'motion_blur') {
    rawScore *= 0.72;
  }

  if (thresholds.blinkDetection && eyesClosedWarning) {
    blurType = 'eyes_closed';
    rawScore = Math.min(rawScore, thresholds.softMin + 5);
  }

  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  let status: CullingStatus = 'blurry';
  if (score >= thresholds.sharpMin && !(thresholds.blinkDetection && eyesClosedWarning)) {
    status = 'sharp';
  } else if (score >= thresholds.softMin) {
    status = 'soft';
  } else {
    status = 'blurry';
    if (blurType === 'none') blurType = 'out_of_focus';
  }

  return {
    score,
    status,
    detectedSubject,
    aiEngineUsed: neuralAiInitialized
      ? 'WebGL2 + TFJS 68-Landmark Neural AI'
      : 'WebGL2 GPU Shader + Saliency',
    faceCount: neuralBoxes.length,
    focusRegions,
    primaryFocusRegion: focusRegions[0],
    leftEyeSharpness,
    rightEyeSharpness,
    eyeAspectRatio,
    hasEyesOpen,
    eyesClosedWarning,
    blurType,
    motionAngle,
    motionMagnitude,
    backgroundSharpness: bgSharp,
    subjectSharpness: subjSharp,
    bokehRatio,
    laplacianVariance: Math.round(fullFrame.lapEnergy * 0.45),
    tenengradScore: Math.round(subjMetrics.tenengrad * 0.1),
    analysisTimeMs: Math.round((performance.now() - startTime) * 10) / 10,
    landmarks,
  };
}

// ============================================================================
// 5. INTEGRATED CAPABILITY FROM SNAPPRO + ZCUT PRO + TURBOCOMPRESS:
//    WebGL2 RCAS De-Halo + Skin Shield "AI Rescue Sharpen" + KB Size Limiter
// ============================================================================
export async function rescueSoftPhotoWithGpu(
  fileOrUrl: File | string,
  options: {
    sharpenStrength: number; // 0..100 (default 68)
    naturalColorBoost: boolean; // From ZCut PRO Nikon Z8 Calibration
    maxFileSizeKb?: number; // From TurboCompress Smart File Size Limiter
  }
): Promise<{ blobUrl: string; blob: Blob; finalSizeKb: number }> {
  let bitmap: ImageBitmap;
  if (typeof fileOrUrl === 'string') {
    bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = async () => {
        try {
          resolve(await createImageBitmap(img));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = fileOrUrl;
    });
  } else {
    bitmap = await createImageBitmap(fileOrUrl);
  }
  const w = bitmap.width;
  const h = bitmap.height;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const gl = canvas.getContext('webgl2', {
    alpha: false,
    depth: false,
    antialias: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });

  if (gl) {
    const vsSrc = `#version 300 es
      in vec2 a_pos;
      out vec2 v_uv;
      void main() {
        v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `;

    // SnapPro RCAS (Robust Contrast-Adaptive Sharpening) + Skin Shield + ZCut Natural Color
    const fsSrc = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      uniform sampler2D u_tex;
      uniform vec2 u_texel;
      uniform float u_sharpen;
      uniform float u_colorBoost;
      out vec4 outColor;

      float getLuma(vec3 c) {
        return dot(c, vec3(0.299, 0.587, 0.114));
      }

      void main() {
        vec3 c = texture(u_tex, v_uv).rgb;
        vec3 n = texture(u_tex, v_uv + vec2(0.0, -u_texel.y)).rgb;
        vec3 s = texture(u_tex, v_uv + vec2(0.0,  u_texel.y)).rgb;
        vec3 w = texture(u_tex, v_uv + vec2(-u_texel.x, 0.0)).rgb;
        vec3 e = texture(u_tex, v_uv + vec2( u_texel.x, 0.0)).rgb;

        float lc = getLuma(c);
        float ln = getLuma(n), ls = getLuma(s), lw = getLuma(w), le = getLuma(e);

        // Skin Shield from SnapPro (protect smooth facial skin while sharpening eyes/hair/bibs)
        float r = c.r * 255.0, g = c.g * 255.0, b = c.b * 255.0;
        bool isSkin = (r > 70.0 && g > 45.0 && b > 30.0 && (r - g) >= 12.0 && (r - b) >= 18.0);
        float skinShield = isSkin ? 0.62 : 1.0;

        // RCAS Contrast-Adaptive High-Pass with De-Halo Clamping
        vec3 blurCross = (n + s + w + e) * 0.25;
        vec3 detail = c - blurCross;
        float edgeContrast = abs(ln - ls) + abs(lw - le);
        float deHalo = 1.0 / (1.0 + max(0.0, edgeContrast - 0.12) * 3.5);

        vec3 minRing = min(c, min(min(n, s), min(w, e))) - 0.06;
        vec3 maxRing = max(c, max(max(n, s), max(w, e))) + 0.06;

        vec3 sharpened = clamp(c + detail * (u_sharpen * 1.65 * skinShield * deHalo), minRing, maxRing);

        // ZCut PRO Natural Nikon Z8 Shadow Lift & Vibrance
        if (u_colorBoost > 0.5) {
          float l = getLuma(sharpened);
          float shadowLift = (1.0 - l) * (1.0 - l) * 0.06;
          sharpened = clamp(sharpened + shadowLift, 0.0, 1.0);
          float maxC = max(sharpened.r, max(sharpened.g, sharpened.b));
          float minC = min(sharpened.r, min(sharpened.g, sharpened.b));
          float sat = maxC - minC;
          float vib = (1.0 - sat) * 0.12;
          sharpened = mix(vec3(getLuma(sharpened)), sharpened, 1.0 + vib);
        }

        outColor = vec4(clamp(sharpened, 0.0, 1.0), 1.0);
      }
    `;

    const compile = (type: number, src: string) => {
      const shd = gl.createShader(type)!;
      gl.shaderSource(shd, src);
      gl.compileShader(shd);
      return shd;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

    gl.viewport(0, 0, w, h);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_texel'), 1.0 / w, 1.0 / h);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_sharpen'), options.sharpenStrength / 100);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_colorBoost'), options.naturalColorBoost ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  } else {
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
  }

  bitmap.close();

  // TurboCompress Binary-Search File Size Limiter
  let quality = 0.93;
  let blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', quality));

  if (options.maxFileSizeKb && options.maxFileSizeKb > 100) {
    const targetBytes = options.maxFileSizeKb * 1024;
    let attempts = 0;
    while (blob.size > targetBytes && quality > 0.45 && attempts < 5) {
      quality -= 0.1;
      blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', quality));
      attempts++;
    }
  }

  return {
    blobUrl: URL.createObjectURL(blob),
    blob,
    finalSizeKb: Math.round(blob.size / 1024),
  };
}

/**
 * Group consecutive photos shot within burstIntervalMs (e.g. 2.5 seconds)
 * and automatically tag the best / sharpest shot in each burst!
 */
export function computeBurstGroups(items: PhotoItem[], burstIntervalMs: number = 2500): PhotoItem[] {
  if (items.length <= 1) return items;

  const sorted = [...items].sort((a, b) => {
    if (a.lastModified !== b.lastModified) return a.lastModified - b.lastModified;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  const updatedItems = [...sorted];
  let currentBurst: PhotoItem[] = [];

  const finalizeBurst = (burst: PhotoItem[]) => {
    if (burst.length > 1) {
      const burstId = `burst-${burst[0].id}`;
      let highestScore = -1;
      let bestItem = burst[0];
      for (const item of burst) {
        item.burstGroupId = burstId;
        item.isBestInBurst = false;
        const score = item.analysis?.score ?? 0;
        if (score > highestScore) {
          highestScore = score;
          bestItem = item;
        }
      }
      bestItem.isBestInBurst = true;
    }
  };

  for (let i = 0; i < updatedItems.length; i++) {
    const item = updatedItems[i];
    if (currentBurst.length === 0) {
      currentBurst.push(item);
    } else {
      const prev = currentBurst[currentBurst.length - 1];
      const timeDiff = Math.abs(item.lastModified - prev.lastModified);
      const nameMatch = isSameBurstName(prev.name, item.name);

      if (timeDiff <= burstIntervalMs || nameMatch) {
        currentBurst.push(item);
      } else {
        finalizeBurst(currentBurst);
        currentBurst = [item];
      }
    }
  }
  if (currentBurst.length > 0) {
    finalizeBurst(currentBurst);
  }

  return updatedItems;
}

function isSameBurstName(nameA: string, nameB: string): boolean {
  const numA = nameA.match(/\d+/g);
  const numB = nameB.match(/\d+/g);
  if (!numA || !numB) return false;
  const lastNumA = parseInt(numA[numA.length - 1], 10);
  const lastNumB = parseInt(numB[numB.length - 1], 10);
  return Math.abs(lastNumA - lastNumB) === 1;
}

/**
 * Generate Adobe Lightroom / Capture One XMP Sidecar content
 */
export function generateXmpSidecar(
  filename: string,
  flag: 'pick' | 'reject' | 'unflagged',
  score: number
): string {
  const rating = flag === 'pick' ? 5 : flag === 'reject' ? 1 : 0;
  const label = flag === 'pick' ? 'Green' : flag === 'reject' ? 'Red' : '';

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="SharpSelect PRO AI Culler">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
    xmp:Rating="${rating}"
    xmp:Label="${label}">
   <photoshop:Instructions>Sharpness Score: ${score}/100 via SharpSelect PRO (${filename})</photoshop:Instructions>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}
