import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  PhotoItem,
  CullingStatus,
  CullingFlag,
  CullingThresholds,
  FocusRegion,
} from './types';
import {
  DEFAULT_THRESHOLDS,
  initOfflineNeuralAI,
  analyzeImageSource,
  computeBurstGroups,
  rescueSoftPhotoWithGpu,
} from './focusEngine';

type WorkspaceMode = 'dashboard' | 'studio';
type ThemeMode = 'dark' | 'light';
type FilterTab = 'all' | 'sharp' | 'soft' | 'blurry';
type StrictnessPreset = 'relaxed' | 'standard' | 'strict';

const APP_VERSION = '1.6.2';
const DEFAULT_UPDATE_MANIFEST_URL = 'https://memories-stack.github.io/Iris/version.json';

interface RemoteUpdateManifest {
  version: string;
  minNativeVersion?: string;
  releasedAt?: string;
  notes?: string;
  htmlUrl?: string;
  dmgUrl?: string;
  pkgUrl?: string;
  zipUrl?: string;
}

function isNewerVersion(remoteVer: string, currentVer: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const r = parse(remoteVer);
  const c = parse(currentVer);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const rv = r[i] || 0;
    const cv = c[i] || 0;
    if (rv > cv) return true;
    if (rv < cv) return false;
  }
  return false;
}

// 1. Fluid Circular Percentage Ring with Soft Glow & Smooth Spring Transition
function CircularGraph({
  percent,
  color,
  size = 64,
}: {
  percent: number;
  color: string;
  size?: number;
}) {
  const stroke = 6.5;
  const r = (size - stroke) * 0.5;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, percent));
  const offset = c - (clamped / 100) * c;

  return (
    <svg width={size} height={size} style={{ flexShrink: 0, overflow: 'visible' }}>
      <circle
        cx={size * 0.5}
        cy={size * 0.5}
        r={r}
        fill="none"
        stroke="var(--ring-track)"
        strokeWidth={stroke}
      />
      <circle
        cx={size * 0.5}
        cy={size * 0.5}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size * 0.5} ${size * 0.5})`}
        style={{
          transition: 'stroke-dashoffset 0.75s cubic-bezier(0.22, 1, 0.36, 1)',
          filter: `drop-shadow(0 0 6px ${color}66)`,
        }}
      />
      <text
        x="50%"
        y="53%"
        dominantBaseline="middle"
        textAnchor="middle"
        fill="var(--text-main)"
        fontSize={13.5}
        fontWeight={900}
      >
        {clamped}%
      </text>
    </svg>
  );
}

// 2. Fluid Concentric 3-Ring Chart with Soft Ambient Glow
function ConcentricCirclesGraph({
  pctSharp,
  pctSoft,
  pctBlurry,
}: {
  pctSharp: number;
  pctSoft: number;
  pctBlurry: number;
}) {
  const size = 152;
  const cx = size * 0.5;
  const cy = size * 0.5;

  const rings = [
    { r: 63, pct: pctSharp, color: '#38b29a' },
    { r: 47, pct: pctSoft, color: '#f07838' },
    { r: 31, pct: pctBlurry, color: '#f43f5e' },
  ];

  return (
    <svg width={size} height={size} style={{ flexShrink: 0, overflow: 'visible' }}>
      {rings.map((ring, idx) => {
        const c = 2 * Math.PI * ring.r;
        const offset = c - (Math.max(3, ring.pct) / 100) * c;
        return (
          <g key={idx}>
            <circle
              cx={cx}
              cy={cy}
              r={ring.r}
              fill="none"
              stroke="var(--ring-track)"
              strokeWidth={10}
            />
            <circle
              cx={cx}
              cy={cy}
              r={ring.r}
              fill="none"
              stroke={ring.color}
              strokeWidth={10}
              strokeDasharray={c}
              strokeDashoffset={offset}
              strokeLinecap="round"
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{
                transition: 'stroke-dashoffset 0.85s cubic-bezier(0.22, 1, 0.36, 1)',
                filter: `drop-shadow(0 0 7px ${ring.color}55)`,
              }}
            />
          </g>
        );
      })}
      <circle
        cx={cx}
        cy={cy}
        r={14}
        fill="rgba(20, 28, 44, 0.95)"
        stroke="rgba(56, 189, 248, 0.45)"
        strokeWidth={1.5}
      />
      <path
        d={`M ${cx} ${cy - 9} Q ${cx + 1.5} ${cy - 1.5} ${cx + 9} ${cy} Q ${cx + 1.5} ${cy + 1.5} ${cx} ${cy + 9} Q ${cx - 1.5} ${cy + 1.5} ${cx - 9} ${cy} Q ${cx - 1.5} ${cy - 1.5} ${cx} ${cy - 9} Z`}
        fill="#ffffff"
        style={{ animation: 'pulseSoft 3.2s ease-in-out infinite', transformOrigin: `${cx}px ${cy}px` }}
      />
      <circle cx={cx} cy={cy} r={2.2} fill="#ff5e4d" />
    </svg>
  );
}

// 3. New Animated 3D Bionic Eye & Camera Aperture Iris Brand Logo
function IrisLogo() {
  const fibers = Array.from({ length: 24 }, (_, i) => {
    const a = (i * Math.PI * 2) / 24;
    const x1 = 50 + Math.cos(a) * 16;
    const y1 = 50 + Math.sin(a) * 16;
    const x2 = 50 + Math.cos(a) * 30;
    const y2 = 50 + Math.sin(a) * 30;
    const isWarm = Math.cos(a - 0.6) > 0.25;
    return { x1, y1, x2, y2, isWarm };
  });

  return (
    <svg width={40} height={40} viewBox="0 0 100 100" style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id="irisBgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#07121e" />
          <stop offset="55%" stopColor="#0b172a" />
          <stop offset="100%" stopColor="#1b0e1a" />
        </linearGradient>
        <radialGradient id="irisCoreGlow" cx="50%" cy="50%" r="50%">
          <stop offset="25%" stopColor="#041019" />
          <stop offset="65%" stopColor="#0f5a5e" />
          <stop offset="92%" stopColor="#2dd4bf" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#081322" />
        </radialGradient>
      </defs>
      <rect
        x={3}
        y={3}
        width={94}
        height={94}
        rx={22}
        fill="url(#irisBgGrad)"
        stroke="rgba(255, 255, 255, 0.22)"
        strokeWidth={2.5}
      />
      {/* Outer Titanium Lens Ring */}
      <circle
        cx={50}
        cy={50}
        r={37}
        fill="#060c17"
        stroke="rgba(148, 163, 184, 0.35)"
        strokeWidth={2}
      />
      {/* Bionic Iris Glow & Radial Neural Filaments */}
      <circle cx={50} cy={50} r={31} fill="url(#irisCoreGlow)" />
      {fibers.map((f, idx) => (
        <line
          key={idx}
          x1={f.x1}
          y1={f.y1}
          x2={f.x2}
          y2={f.y2}
          stroke={f.isWarm ? 'rgba(251, 146, 60, 0.85)' : 'rgba(45, 212, 191, 0.85)'}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
      {/* Slowly Rotating Dual Limbal Arcs */}
      <g style={{ animation: 'spinSlow 18s linear infinite', transformOrigin: '50px 50px' }}>
        <circle
          cx={50}
          cy={50}
          r={31.5}
          fill="none"
          stroke="#2dd4bf"
          strokeWidth={4.2}
          strokeDasharray="88 210"
          strokeLinecap="round"
        />
        <circle
          cx={50}
          cy={50}
          r={31.5}
          fill="none"
          stroke="#fb923c"
          strokeWidth={4.2}
          strokeDasharray="74 210"
          strokeDashoffset="-102"
          strokeLinecap="round"
        />
      </g>
      {/* Inner Optical Pupil & 4-Point AI Focus Sparkle */}
      <circle
        cx={50}
        cy={50}
        r={15.5}
        fill="#04070f"
        stroke="rgba(94, 234, 212, 0.85)"
        strokeWidth={1.6}
      />
      <path
        d="M 50 38 Q 51.8 48.2 62 50 Q 51.8 51.8 50 62 Q 48.2 51.8 38 50 Q 48.2 48.2 50 38 Z"
        fill="#ffffff"
        style={{ animation: 'pulseSoft 3.2s ease-in-out infinite', transformOrigin: '50px 50px' }}
      />
      <circle cx={50} cy={50} r={2.6} fill="#fb923c" />
      {/* Optical Lens Catchlight */}
      <circle cx={38} cy={36} r={3.8} fill="rgba(255, 255, 255, 0.55)" />
      <circle cx={43.5} cy={32.5} r={1.6} fill="rgba(255, 255, 255, 0.38)" />
    </svg>
  );
}

// 4. Ultra-Smooth 120fps Tri-Stream Fiber-Optic Neural Matrix Visualizer (Zero Stutter, No Cheesy Badge!)
function MiniNeuralCornerWidget({
  isScanning,
  speed,
  total,
}: {
  isScanning: boolean;
  speed: number;
  total: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isScanningRef = useRef(isScanning);
  isScanningRef.current = isScanning;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = 0;
    let lastTime = performance.now();
    let phase = 0;
    let smoothMult = 0.85;

    // 3 Fiber-Optic Source Clusters (Cyan-Teal, Magenta-Pink, Warm Amber-Gold)
    const streams = [
      { ySrcRatio: 0.25, r: 56, g: 189, b: 248, hex: '#38bdf8' },
      { ySrcRatio: 0.50, r: 236, g: 72, b: 153, hex: '#ec4899' },
      { ySrcRatio: 0.75, r: 251, g: 191, b: 36, hex: '#fbbf24' },
    ];

    // Pre-build 24 smooth bezier fiber paths fanning out from the 3 left emitters to the right matrix
    const fibers = Array.from({ length: 24 }, (_, idx) => {
      const sIdx = idx % 3;
      const lane = idx / 23; // 0..1 across right matrix height
      const phaseOffset = (idx * 0.47) % (Math.PI * 2);
      const pulseSpeed = 0.42 + (idx % 5) * 0.09;
      return { sIdx, lane, phaseOffset, pulseSpeed };
    });

    const draw = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) * 0.001));
      lastTime = now;

      const targetMult = isScanningRef.current ? 2.1 : 0.82;
      smoothMult += (targetMult - smoothMult) * Math.min(1, dt * 4.0);
      phase += dt * smoothMult;

      const dpr = Math.min(2, window.devicePixelRatio || 2);
      const cssW = canvas.clientWidth || 340;
      const cssH = 96;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.save();
      ctx.scale(dpr, dpr);

      const w = cssW;
      const h = cssH;

      // 1. Deep Midnight Navy Background
      const bgGrad = ctx.createLinearGradient(0, 0, w, h);
      bgGrad.addColorStop(0, '#040814');
      bgGrad.addColorStop(0.5, '#071024');
      bgGrad.addColorStop(1, '#050917');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      const srcX = w * 0.16;
      const matStartX = w * 0.46;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // 2. Incoming Laser Input Lines + Glowing Emitter Cores on the Left
      streams.forEach((st, sIdx) => {
        const sy = h * st.ySrcRatio + Math.sin(phase * 1.1 + sIdx * 2.1) * 1.8;

        // Input beam from left edge
        const beamGrad = ctx.createLinearGradient(0, sy, srcX, sy);
        beamGrad.addColorStop(0, `rgba(${st.r}, ${st.g}, ${st.b}, 0.05)`);
        beamGrad.addColorStop(0.7, `rgba(${st.r}, ${st.g}, ${st.b}, 0.55)`);
        beamGrad.addColorStop(1, `rgba(255, 255, 255, 0.95)`);
        ctx.strokeStyle = beamGrad;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(6, sy);
        ctx.lineTo(srcX, sy);
        ctx.stroke();

        // Traveling input data dots along the left beam
        for (let d = 0; d < 4; d++) {
          const prog = ((phase * 0.9 + d * 0.25 + sIdx * 0.15) % 1);
          const dx = 6 + prog * (srcX - 8);
          ctx.fillStyle = `rgba(${st.r}, ${st.g}, ${st.b}, ${0.3 + prog * 0.6})`;
          ctx.beginPath();
          ctx.arc(dx, sy, 1.1, 0, Math.PI * 2);
          ctx.fill();
        }

        // Outer emitter halo
        const halo = ctx.createRadialGradient(srcX, sy, 0.5, srcX, sy, 11);
        halo.addColorStop(0, `rgba(255, 255, 255, 0.95)`);
        halo.addColorStop(0.35, `rgba(${st.r}, ${st.g}, ${st.b}, 0.65)`);
        halo.addColorStop(1, `rgba(${st.r}, ${st.g}, ${st.b}, 0)`);
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(srcX, sy, 11, 0, Math.PI * 2);
        ctx.fill();
      });

      // 3. Fanning Bezier Fiber-Optic Filaments + Traveling Photon Pulses
      for (const fb of fibers) {
        const st = streams[fb.sIdx];
        const sy = h * st.ySrcRatio + Math.sin(phase * 1.1 + fb.sIdx * 2.1) * 1.8;
        const ty = 11 + fb.lane * (h - 22) + Math.sin(phase * 1.4 + fb.phaseOffset) * 1.5;

        const cp1x = srcX + (matStartX - srcX) * 0.42;
        const cp1y = sy;
        const cp2x = srcX + (matStartX - srcX) * 0.62;
        const cp2y = ty;

        ctx.strokeStyle = `rgba(${st.r}, ${st.g}, ${st.b}, 0.26)`;
        ctx.lineWidth = 1.05;
        ctx.beginPath();
        ctx.moveTo(srcX, sy);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, matStartX, ty);
        ctx.stroke();

        // Photon pulse gliding along cubic bezier curve
        const t = (phase * fb.pulseSpeed + fb.phaseOffset) % 1;
        const mt = 1 - t;
        const px =
          mt * mt * mt * srcX +
          3 * mt * mt * t * cp1x +
          3 * mt * t * t * cp2x +
          t * t * t * matStartX;
        const py =
          mt * mt * mt * sy +
          3 * mt * mt * t * cp1y +
          3 * mt * t * t * cp2y +
          t * t * t * ty;

        ctx.fillStyle = `rgba(255, 255, 255, ${0.45 + 0.5 * Math.sin(t * Math.PI)})`;
        ctx.beginPath();
        ctx.arc(px, py, 1.35, 0, Math.PI * 2);
        ctx.fill();
      }

      // 4. Right-Side Neural Binary & Dot Matrix Stream (Flowing smoothly rightwards)
      const cols = 20;
      const rows = 9;
      const matW = w - matStartX - 10;
      const colStep = matW / cols;
      const rowStep = (h - 20) / (rows - 1);

      for (let r = 0; r < rows; r++) {
        const y = 10 + r * rowStep;
        for (let c = 0; c < cols; c++) {
          const x = matStartX + c * colStep;
          const fadeRight = Math.max(0.08, 1 - (c / cols) * 0.85);
          const wave =
            Math.sin(c * 0.48 - phase * 3.2 + r * 0.75) * 0.5 +
            Math.cos(r * 0.9 - phase * 2.1 + c * 0.3) * 0.5;

          const colorIdx = (r + c) % 3;
          const st =
            c < 3
              ? streams[(r + c) % 3]
              : colorIdx === 0
              ? streams[0]
              : colorIdx === 1
              ? { r: 56, g: 189, b: 248 }
              : streams[1];

          const alpha = Math.max(0.08, (0.35 + 0.65 * Math.max(0, wave)) * fadeRight);

          if (c === 0) {
            // Bright entry nodes where fiber cables dock into the matrix
            ctx.fillStyle = `rgba(${st.r}, ${st.g}, ${st.b}, ${Math.min(1, alpha * 1.4)})`;
            ctx.beginPath();
            ctx.arc(x, y, 1.9, 0, Math.PI * 2);
            ctx.fill();
          } else if ((c + r) % 2 === 0) {
            // Crisp glowing matrix dots & micro-capsules
            ctx.fillStyle = `rgba(${st.r}, ${st.g}, ${st.b}, ${alpha})`;
            const pillW = wave > 0.35 ? 4.2 : 2.0;
            ctx.beginPath();
            ctx.roundRect(x - pillW * 0.5, y - 1.1, pillW, 2.2, 1.1);
            ctx.fill();
          } else {
            ctx.fillStyle = `rgba(56, 189, 248, ${alpha * 0.82})`;
            ctx.beginPath();
            ctx.arc(x, y, 1.15, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      ctx.restore();
      ctx.restore();

      animId = requestAnimationFrame(draw);
    };

    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, []);

  return (
    <div
      style={{
        borderRadius: 14,
        overflow: 'hidden',
        border: '1px solid rgba(56, 189, 248, 0.24)',
        background: '#040814',
        position: 'relative',
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: 96, display: 'block' }} />
      {(isScanning || total > 0) && (
        <div
          style={{
            position: 'absolute',
            top: 7,
            left: 11,
            right: 11,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              color: 'rgba(148, 163, 184, 0.88)',
              letterSpacing: '0.02em',
            }}
          >
            {total > 0 ? `${total.toLocaleString()} ภาพ` : ''}
          </span>
          {isScanning && (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: '#38bdf8',
                background: 'rgba(4, 8, 20, 0.78)',
                padding: '2px 9px',
                borderRadius: 999,
                border: '1px solid rgba(56, 189, 248, 0.38)',
              }}
            >
              ⚡ {speed} รูป/วิ
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [wsMode, setWsMode] = useState<WorkspaceMode>('dashboard');
  const [liveTick, setLiveTick] = useState<number>(0);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem('sharp_pro_theme') as ThemeMode) || 'dark';
    } catch {
      return 'dark';
    }
  });
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [preset, setPreset] = useState<StrictnessPreset>('standard');
  const [thresholds, setThresholds] = useState<CullingThresholds>(DEFAULT_THRESHOLDS);
  const [onlyBestInBurst, setOnlyBestInBurst] = useState(false);

  // Native macOS App State
  const [isNativeMacApp, setIsNativeMacApp] = useState(false);
  const [currentFolderName, setCurrentFolderName] = useState<string>('');
  const [pairedRawCount, setPairedRawCount] = useState<number>(0);

  // Scanning State
  const [neuralReady, setNeuralReady] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0, speed: 0 });
  const cancelScanRef = useRef(false);
  const pollTimerRef = useRef<number | null>(null);

  // 100% Eye Focus Loupe State (Interactive Mouse Drag Pan + Wheel Zoom + Resizable Box)
  const [loupeZoom, setLoupeZoom] = useState<number>(2.5);
  const [loupePan, setLoupePan] = useState<{ x: number; y: number }>({ x: 0, y: 0 }); // Normalized offset -1..1
  const [isDraggingLoupe, setIsDraggingLoupe] = useState<boolean>(false);
  const dragStartRef = useRef<{ clientX: number; clientY: number; startX: number; startY: number } | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState<number>(430);
  const [loupeHeight, setLoupeHeight] = useState<number>(340);
  const [showLandmarks, setShowLandmarks] = useState<boolean>(true);
  const [compareSideBySide, setCompareSideBySide] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [inspectedMeta, setInspectedMeta] = useState<{
    bib?: string;
    camera?: string;
    shutter?: string;
    fstop?: string;
    iso?: string;
    focal?: string;
    humanCount?: number;
    maskedRunner?: boolean;
  }>({});
  const [activeRegionIdx, setActiveRegionIdx] = useState<number>(0);
  const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fullResImgCacheRef = useRef<{ id: string; img: HTMLImageElement } | null>(null);

  // SnapPro RCAS AI Rescue State
  const [isRescuing, setIsRescuing] = useState(false);
  const [rescueSharpen, setRescueSharpen] = useState(72);
  const [rescueColorBoost, setRescueColorBoost] = useState(true);

  // Notification & Undo State
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);
  const [canUndoOrganize, setCanUndoOrganize] = useState(false);

  // Blurry Quick-Preview & Delete Modal State
  const [showBlurryModal, setShowBlurryModal] = useState(false);
  const [blurryPreviewId, setBlurryPreviewId] = useState<string | null>(null);
  const [uncheckedBlurryIds, setUncheckedBlurryIds] = useState<Set<string>>(new Set());
  const [modalZoom, setModalZoom] = useState<number>(1.0);
  const [modalPan, setModalPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isModalDragging, setIsModalDragging] = useState(false);
  const modalDragRef = useRef<{ cx: number; cy: number; sx: number; sy: number } | null>(null);

  // Virtual Grid State
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [gridViewport, setGridViewport] = useState({ width: 920, height: 640 });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // Apply theme attribute to document & persist
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('sharp_pro_theme', theme);
    } catch {}
  }, [theme]);

  // Live Telemetry Pulse Ticker for Luminous Dashboard
  useEffect(() => {
    if (wsMode !== 'dashboard') return;
    const timer = window.setInterval(() => {
      setLiveTick((t) => t + 1);
    }, 1100);
    return () => window.clearInterval(timer);
  }, [wsMode]);

  // Convert Native C Scan Item to PhotoItem
  const mapNativeItemToPhotoItem = useCallback((r: any): PhotoItem => {
    const w = r.w || 6192;
    const h = r.h || 4128;
    const box = {
      x: Math.round((r.bx ?? 0.25) * w),
      y: Math.round((r.by ?? 0.2) * h),
      width: Math.round((r.bw ?? 0.45) * w),
      height: Math.round((r.bh ?? 0.45) * h),
    };
    const score = r.score ?? 50;
    const status: CullingStatus =
      score >= 65 ? 'sharp' : score >= 42 ? 'soft' : 'blurry';

    const reg: FocusRegion = {
      type: r.portrait ? 'face' : 'center',
      label: r.portrait ? 'จุดโฟกัสใบหน้า/ดวงตา (AI)' : 'จุดโฟกัสตัวแบบกลางภาพ',
      box,
      sharpness: r.subj ?? 500,
    };

    return {
      id: `${r.name}-${r.idx}`,
      nativeUrl: `/__photo?name=${encodeURIComponent(r.name)}`,
      thumbUrl: `/__thumb?name=${encodeURIComponent(r.name)}`,
      name: r.name,
      size: r.size || 0,
      lastModified: r.mtime || 0,
      width: w,
      height: h,
      flag: 'unflagged',
      analysis: {
        score,
        status,
        detectedSubject: r.portrait ? 'skin_portrait' : 'general_object',
        aiEngineUsed: 'WebGL2 + TFJS 68-Landmark Neural AI',
        faceCount: r.portrait ? 1 : 0,
        focusRegions: [reg],
        primaryFocusRegion: reg,
        hasEyesOpen: r.btype !== 'eyes_closed',
        eyesClosedWarning: r.btype === 'eyes_closed',
        blurType: (r.btype as any) || 'none',
        backgroundSharpness: r.bg ?? 120,
        subjectSharpness: r.subj ?? 600,
        bokehRatio: r.bokeh ?? 1.5,
        laplacianVariance: r.subj ?? 600,
        tenengradScore: r.subj ?? 600,
        analysisTimeMs: 3.8,
      },
    };
  }, []);

  // Poll Native Apple Silicon Multi-Core Background Scanner (Incremental Zero-Jank Polling!)
  const startPollingNativeScan = useCallback(() => {
    if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
    let nextFromIdx = 0;

    const poll = async () => {
      try {
        const res = await fetch(`/__scan_status?from=${nextFromIdx}`);
        const data = await res.json();
        if (!data || !data.ok) return;

        if (data.folderName) setCurrentFolderName(data.folderName);
        if (typeof data.rawCount === 'number') setPairedRawCount(data.rawCount);

        setScanProgress({
          done: data.done || 0,
          total: data.total || 0,
          speed: data.speed || 0,
        });
        setIsScanning(Boolean(data.scanning));

        if (Array.isArray(data.items) && data.items.length > 0) {
          const mapped = data.items.map(mapNativeItemToPhotoItem);
          const maxIdx = data.items[data.items.length - 1]?.idx;
          if (typeof maxIdx === 'number') {
            nextFromIdx = maxIdx + 1;
          }
          setItems((prev) => {
            const existing = new Set(prev.map((p) => p.id));
            const merged = [...prev, ...mapped.filter((m: PhotoItem) => !existing.has(m.id))];
            if (!data.scanning) {
              return computeBurstGroups(merged);
            }
            return merged;
          });
        } else if (!data.scanning) {
          setItems((prev) => computeBurstGroups(prev));
        }

        if (!data.scanning && pollTimerRef.current) {
          window.clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } catch {
        // Ignore transient poll errors
      }
    };

    poll();
    pollTimerRef.current = window.setInterval(poll, 260);
  }, [mapNativeItemToPhotoItem]);

  // 1. Initialize on startup
  useEffect(() => {
    initOfflineNeuralAI().then(({ ready }) => {
      setNeuralReady(ready);
    });

    fetch('/__native_status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.native) {
          setIsNativeMacApp(true);
          if (data.hasFolder) {
            startPollingNativeScan();
          }
        }
      })
      .catch(() => {});

    return () => {
      if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
    };
  }, [startPollingNativeScan]);

  // 2. Apply Strictness Preset
  const handleSelectPreset = (p: StrictnessPreset) => {
    setPreset(p);
    if (p === 'relaxed') {
      setThresholds((t) => ({ ...t, sharpMin: 54, softMin: 34 }));
    } else if (p === 'standard') {
      setThresholds((t) => ({ ...t, sharpMin: 65, softMin: 42 }));
    } else {
      setThresholds((t) => ({ ...t, sharpMin: 76, softMin: 52 }));
    }
  };

  // 3. Track Virtual Grid Viewport Size
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const updateSize = () => {
      setGridViewport({ width: el.clientWidth, height: el.clientHeight });
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length, wsMode]);

  // 4. Effective Status & Detailed Breakdown Stats for Dashboard
  const effectiveItems = useMemo(() => {
    return items.map((item) => {
      if (!item.analysis) return item;
      const score = item.analysis.score;
      const eyesClosed = thresholds.blinkDetection && item.analysis.eyesClosedWarning;

      let status: CullingStatus = 'blurry';
      if (item.flag === 'pick') {
        status = 'sharp';
      } else if (item.flag === 'reject') {
        status = 'blurry';
      } else if (score >= thresholds.sharpMin && !eyesClosed) {
        status = 'sharp';
      } else if (score >= thresholds.softMin) {
        status = 'soft';
      } else {
        status = 'blurry';
      }

      return {
        ...item,
        analysis: {
          ...item.analysis,
          status,
        },
      };
    });
  }, [items, thresholds.sharpMin, thresholds.softMin, thresholds.blinkDetection]);

  const stats = useMemo(() => {
    let sharp = 0,
      soft = 0,
      blurry = 0,
      outOfFocus = 0,
      motionBlur = 0,
      backFocus = 0,
      eyesClosed = 0;

    for (const it of effectiveItems) {
      const st = it.analysis?.status;
      const bt = it.analysis?.blurType;
      if (st === 'sharp') sharp++;
      else if (st === 'soft') soft++;
      else blurry++;

      if (bt === 'motion_blur') motionBlur++;
      else if (bt === 'back_focus') backFocus++;
      else if (bt === 'eyes_closed') eyesClosed++;
      else if (st === 'blurry') outOfFocus++;
    }
    const all = effectiveItems.length;
    const pct = (n: number) => (all > 0 ? Math.round((n / all) * 100) : 0);
    return {
      all,
      sharp,
      soft,
      blurry,
      outOfFocus,
      motionBlur,
      backFocus,
      eyesClosed,
      pctSharp: pct(sharp),
      pctSoft: pct(soft),
      pctBlurry: pct(blurry),
      pctOutOfFocus: pct(outOfFocus),
      pctMotion: pct(motionBlur),
      pctBackFocus: pct(backFocus),
    };
  }, [effectiveItems]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return effectiveItems.filter((it) => {
      if (onlyBestInBurst && it.burstGroupId && !it.isBestInBurst) return false;
      if (activeTab !== 'all' && it.analysis?.status !== activeTab) return false;
      if (q && !it.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [effectiveItems, activeTab, onlyBestInBurst, searchQuery]);

  const selectedItem = useMemo(
    () => effectiveItems.find((i) => i.id === selectedId) || filteredItems[0] || null,
    [effectiveItems, filteredItems, selectedId]
  );

  // 5A. Trigger Native macOS Folder Picker + Multi-Core C Background Scan
  const handlePickNativeMacFolder = async () => {
    if (!isNativeMacApp) {
      folderInputRef.current?.click();
      return;
    }

    try {
      const res = await fetch('/__pick_source_folder');
      const data = await res.json();
      if (!data || !data.ok) return;

      setItems([]);
      setSelectedId(null);
      setCanUndoOrganize(false);
      startPollingNativeScan();
    } catch {
      // Ignore
    }
  };

  // 5B. Browser Fallback
  const handleFilesSelected = useCallback(
    async (fileList: FileList | File[]) => {
      const rawArray = Array.from(fileList);
      const imageFiles = rawArray.filter((f) => {
        const ext = f.name.toLowerCase();
        return (
          f.type.startsWith('image/') ||
          ext.endsWith('.jpg') ||
          ext.endsWith('.jpeg') ||
          ext.endsWith('.png') ||
          ext.endsWith('.webp') ||
          ext.endsWith('.heic')
        );
      });
      if (imageFiles.length === 0) return;

      imageFiles.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );
      const batchFiles = imageFiles.slice(0, 5500);

      cancelScanRef.current = false;
      setIsScanning(true);
      const startBatchTime = performance.now();
      setScanProgress({ done: 0, total: batchFiles.length, speed: 0 });

      const newItems: PhotoItem[] = [];
      let cursor = 0;
      let completed = 0;

      const workerLoop = async () => {
        while (cursor < batchFiles.length && !cancelScanRef.current) {
          const idx = cursor++;
          const file = batchFiles[idx];
          const id = `${file.name}-${file.size}-${idx}`;
          try {
            const { result, thumbUrl, width, height } = await analyzeImageSource(file, thresholds);
            newItems[idx] = {
              id,
              file,
              name: file.name,
              size: file.size,
              lastModified: file.lastModified,
              thumbUrl,
              width,
              height,
              analysis: result,
              flag: 'unflagged',
            };
          } catch {
            // Skip
          }
          completed++;
          if (completed % 12 === 0 || completed === batchFiles.length) {
            const elapsedSec = Math.max(0.1, (performance.now() - startBatchTime) / 1000);
            const speed = Math.round((completed / elapsedSec) * 10) / 10;
            setScanProgress({ done: completed, total: batchFiles.length, speed });
            setItems(newItems.filter(Boolean));
            await new Promise((r) => requestAnimationFrame(r));
          }
        }
      };

      await Promise.all(Array.from({ length: 4 }, () => workerLoop()));
      setItems((prev) => computeBurstGroups(prev));
      setIsScanning(false);
    },
    [thresholds]
  );

  // 6. Demo Set Generator
  const handleLoadDemoPhotos = async () => {
    const scenarios = [
      { name: 'DSC_0101_คมชัด_โฟกัสตา_f1.4.jpg', mode: 'sharp_open', timeOffset: 0 },
      { name: 'DSC_0102_พอใช้_กู้ความคมได้.jpg', mode: 'soft_open', timeOffset: 400 },
      { name: 'DSC_0103_ตาหลับ_กะพริบตา.jpg', mode: 'sharp_closed', timeOffset: 800 },
      { name: 'DSC_0104_เบลอ_มือสั่น.jpg', mode: 'motion_blur', timeOffset: 15000 },
      { name: 'DSC_0105_หลุดโฟกัสไปข้างหลัง.jpg', mode: 'back_focus', timeOffset: 30000 },
      { name: 'DSC_0106_นักวิ่ง_คมชัดกริบ.jpg', mode: 'sharp_runner', timeOffset: 30500 },
    ];

    const files: File[] = [];
    const baseTime = Date.now() - 60000;

    for (const sc of scenarios) {
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 800;
      const ctx = c.getContext('2d')!;

      const grad = ctx.createLinearGradient(0, 0, 1200, 800);
      grad.addColorStop(0, '#1e293b');
      grad.addColorStop(1, '#0f172a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 1200, 800);

      ctx.save();
      if (sc.mode !== 'back_focus') ctx.filter = 'blur(12px)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 2;
      for (let i = 0; i < 40; i++) {
        ctx.strokeRect(40 + (i % 10) * 110, 40 + Math.floor(i / 10) * 180, 70, 120);
      }
      ctx.restore();

      ctx.save();
      if (sc.mode === 'soft_open') ctx.filter = 'blur(2.2px)';
      else if (sc.mode === 'motion_blur') ctx.filter = 'blur(6px)';
      else if (sc.mode === 'back_focus') ctx.filter = 'blur(5.5px)';

      ctx.fillStyle = sc.mode === 'sharp_runner' ? '#38b29a' : '#4f585a';
      ctx.beginPath();
      ctx.ellipse(600, 740, 230, 180, 0, Math.PI, 0);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(510, 620, 180, 95);
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 44px sans-serif';
      ctx.fillText('20845', 532, 682);

      ctx.fillStyle = '#e09f7d';
      ctx.beginPath();
      ctx.ellipse(600, 360, 135, 170, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#18181b';
      ctx.beginPath();
      ctx.ellipse(600, 230, 142, 70, 0, Math.PI, 0);
      ctx.fill();

      ctx.strokeStyle = '#18181b';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(515, 305);
      ctx.quadraticCurveTo(548, 292, 578, 305);
      ctx.moveTo(622, 305);
      ctx.quadraticCurveTo(652, 292, 685, 305);
      ctx.stroke();

      if (sc.mode === 'sharp_closed') {
        ctx.strokeStyle = '#27272a';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(520, 340);
        ctx.quadraticCurveTo(548, 352, 576, 340);
        ctx.moveTo(624, 340);
        ctx.quadraticCurveTo(652, 352, 680, 340);
        ctx.stroke();
      } else {
        for (const ex of [548, 652]) {
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.ellipse(ex, 338, 28, 15, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#18181b';
          ctx.lineWidth = 3;
          ctx.stroke();

          ctx.fillStyle = '#451a03';
          ctx.beginPath();
          ctx.arc(ex, 338, 12, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#000000';
          ctx.beginPath();
          ctx.arc(ex, 338, 6, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(ex - 4, 334, 3, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = '#09090b';
          ctx.lineWidth = 2;
          for (let k = -22; k <= 22; k += 5) {
            ctx.beginPath();
            ctx.moveTo(ex + k, 324);
            ctx.lineTo(ex + k * 1.1, 316);
            ctx.stroke();
          }
        }
      }

      ctx.strokeStyle = '#9a5b3e';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(600, 345);
      ctx.lineTo(592, 412);
      ctx.lineTo(610, 416);
      ctx.stroke();

      ctx.strokeStyle = '#b91c1c';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(558, 458);
      ctx.quadraticCurveTo(600, 478, 642, 458);
      ctx.stroke();
      ctx.restore();

      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.94));
      files.push(
        new File([blob], sc.name, { type: 'image/jpeg', lastModified: baseTime + sc.timeOffset })
      );
    }

    setCurrentFolderName('ชุดภาพทดสอบ AI (Demo)');
    await handleFilesSelected(files);
  };

  // 7A. On-Demand Apple Vision Neural Engine Eye + Human + Bib OCR + EXIF Inspection
  useEffect(() => {
    setInspectedMeta({});
    if (!isNativeMacApp || !selectedItem || !selectedItem.nativeUrl) return;

    let cancelled = false;
    fetch(`/__inspect_face?name=${encodeURIComponent(selectedItem.name)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data || !data.ok) return;
        setInspectedMeta({
          bib: data.bib || undefined,
          camera: data.camera || undefined,
          shutter: data.shutter || undefined,
          fstop: data.fstop || undefined,
          iso: data.iso || undefined,
          focal: data.focal || undefined,
          humanCount: data.humanCount ?? undefined,
          maskedRunner: Boolean(data.maskedRunner),
        });

        if (!data.hasFace) return;
        const w = selectedItem.width || 6192;
        const h = selectedItem.height || 4128;
        const toBox = (b: any) => ({
          x: Math.round(b.x * w),
          y: Math.round(b.y * h),
          width: Math.round(b.w * w),
          height: Math.round(b.h * h),
        });
        const newRegions: FocusRegion[] = data.maskedRunner
          ? [
              {
                type: 'left_eye',
                label: '🧢 ศีรษะ/หน้ากาก (AI Human Body)',
                box: toBox(data.leftEye),
                sharpness: selectedItem.analysis?.subjectSharpness ?? 800,
              },
              {
                type: 'right_eye',
                label: '🎽 ป้ายเบอร์วิ่ง Bib (AI Chest)',
                box: toBox(data.rightEye),
                sharpness: selectedItem.analysis?.subjectSharpness ?? 800,
              },
              {
                type: 'face',
                label: '🧍 ตัวแบบ (AI Upper Body)',
                box: toBox(data.face),
                sharpness: selectedItem.analysis?.subjectSharpness ?? 800,
              },
            ]
          : [
              {
                type: 'left_eye',
                label: '👁️ ดวงตาซ้าย (Apple Vision AI)',
                box: toBox(data.leftEye),
                sharpness: selectedItem.analysis?.subjectSharpness ?? 800,
              },
              {
                type: 'right_eye',
                label: '👁️ ดวงตาขวา (Apple Vision AI)',
                box: toBox(data.rightEye),
                sharpness: selectedItem.analysis?.subjectSharpness ?? 800,
              },
              {
                type: 'face',
                label: '🧑 กรอบใบหน้า (Apple Vision AI)',
                box: toBox(data.face),
                sharpness: selectedItem.analysis?.subjectSharpness ?? 800,
              },
            ];

        setItems((prev) =>
          prev.map((it) =>
            it.id === selectedItem.id && it.analysis
              ? {
                  ...it,
                  analysis: {
                    ...it.analysis,
                    detectedSubject: 'neural_eye',
                    focusRegions: newRegions,
                    primaryFocusRegion: newRegions[0],
                  },
                }
              : it
          )
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isNativeMacApp, selectedItem?.id]);

  // Reset pan when switching photo or active region
  useEffect(() => {
    setLoupePan({ x: 0, y: 0 });
  }, [selectedItem?.id, activeRegionIdx]);

  // 7B. Render 100% Eye Focus Loupe (With Interactive Mouse Drag Pan + Mini Radar Map)
  useEffect(() => {
    const canvas = loupeCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cw = (canvas.width = inspectorWidth);
    const ch = (canvas.height = loupeHeight);

    if (!selectedItem) {
      ctx.fillStyle = '#0d1118';
      ctx.fillRect(0, 0, cw, ch);
      ctx.fillStyle = '#64748b';
      ctx.font = '600 13px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('คลิกเลือกรูปภาพจากตาราง เพื่อซูมและลากเมาส์ดูจุดโฟกัส 100%', cw * 0.5, ch * 0.5);
      return;
    }

    let cancelled = false;

    const drawToLoupe = (img: HTMLImageElement) => {
      if (cancelled || !img.width || !img.height) return;
      ctx.fillStyle = '#06080c';
      ctx.fillRect(0, 0, cw, ch);

      const regions = selectedItem.analysis?.focusRegions || [];
      const activeReg = regions[activeRegionIdx] || regions[0];

      if (loupeZoom > 1.05) {
        const scaleOrigX = img.width / (selectedItem.width || img.width);
        const scaleOrigY = img.height / (selectedItem.height || img.height);
        const box = activeReg
          ? {
              x: activeReg.box.x * scaleOrigX,
              y: activeReg.box.y * scaleOrigY,
              width: activeReg.box.width * scaleOrigX,
              height: activeReg.box.height * scaleOrigY,
            }
          : {
              x: img.width * 0.35,
              y: img.height * 0.25,
              width: img.width * 0.3,
              height: img.height * 0.3,
            };

        const baseCx = box.x + box.width * 0.5;
        const baseCy = box.y + box.height * 0.5;

        const viewW = Math.max(60, img.width / (loupeZoom * 1.8));
        const viewH = viewW * (ch / cw);

        // Apply interactive mouse drag pan offset (loupePan.x, loupePan.y in normalized image coords)
        const cx = baseCx + loupePan.x * img.width;
        const cy = baseCy + loupePan.y * img.height;

        const sx = Math.max(0, Math.min(img.width - viewW, cx - viewW * 0.5));
        const sy = Math.max(0, Math.min(img.height - viewH, cy - viewH * 0.5));

        ctx.drawImage(img, sx, sy, viewW, viewH, 0, 0, cw, ch);

        if (showLandmarks && activeReg) {
          const scaleX = cw / viewW;
          const scaleY = ch / viewH;
          const bx = (box.x - sx) * scaleX;
          const by = (box.y - sy) * scaleY;
          const bw = box.width * scaleX;
          const bh = box.height * scaleY;

          ctx.strokeStyle =
            selectedItem.analysis?.status === 'sharp'
              ? '#38b29a'
              : selectedItem.analysis?.status === 'soft'
              ? '#f07838'
              : '#f43f5e';
          ctx.lineWidth = 2.5;
          ctx.strokeRect(bx, by, bw, bh);
        }

        // Draw Mini Radar / Picture-in-Picture Navigator in Top-Right Corner
        const navW = 72;
        const navH = Math.round(navW * (img.height / img.width));
        const navX = cw - navW - 10;
        const navY = 10;
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = '#000';
        ctx.fillRect(navX - 2, navY - 2, navW + 4, navH + 4);
        ctx.drawImage(img, navX, navY, navW, navH);
        ctx.strokeStyle = '#38b29a';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(
          navX + (sx / img.width) * navW,
          navY + (sy / img.height) * navH,
          Math.max(6, (viewW / img.width) * navW),
          Math.max(6, (viewH / img.height) * navH)
        );
        ctx.restore();
      } else {
        const scale = Math.min(cw / img.width, ch / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (cw - dw) * 0.5, (ch - dh) * 0.5, dw, dh);
      }
    };

    const renderLoupe = async () => {
      const cacheKey = `${selectedItem.id}-${Boolean(selectedItem.rescuedUrl)}`;
      if (fullResImgCacheRef.current && fullResImgCacheRef.current.id === cacheKey) {
        drawToLoupe(fullResImgCacheRef.current.img);
        return;
      }

      // Draw fast thumbnail immediately (0ms) while full-res 25.6MP image decodes!
      if (selectedItem.thumbUrl) {
        const thumbImg = new Image();
        thumbImg.crossOrigin = 'anonymous';
        thumbImg.onload = () => {
          if (!cancelled && (!fullResImgCacheRef.current || fullResImgCacheRef.current.id !== cacheKey)) {
            drawToLoupe(thumbImg);
          }
        };
        thumbImg.src = selectedItem.thumbUrl;
      }

      const srcUrl =
        selectedItem.rescuedUrl ||
        selectedItem.nativeUrl ||
        (selectedItem.file ? URL.createObjectURL(selectedItem.file) : selectedItem.thumbUrl);
      const isTempBlob = Boolean(
        !selectedItem.rescuedUrl && !selectedItem.nativeUrl && selectedItem.file
      );

      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.crossOrigin = 'anonymous';
        i.onload = () => resolve(i);
        i.onerror = (e) => reject(e);
        i.src = srcUrl;
      }).catch(() => {
        if (isTempBlob) URL.revokeObjectURL(srcUrl);
        return null as any;
      });

      if (!img || cancelled) {
        if (isTempBlob) URL.revokeObjectURL(srcUrl);
        return;
      }
      fullResImgCacheRef.current = { id: cacheKey, img };
      if (isTempBlob) URL.revokeObjectURL(srcUrl);
      drawToLoupe(img);
    };

    renderLoupe();
    return () => {
      cancelled = true;
    };
  }, [
    selectedItem,
    loupeZoom,
    loupePan,
    showLandmarks,
    activeRegionIdx,
    wsMode,
    inspectorWidth,
    loupeHeight,
  ]);

  // 8. Keyboard Shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (!selectedItem || filteredItems.length === 0) return;

      const idx = filteredItems.findIndex((i) => i.id === selectedItem.id);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = filteredItems[Math.min(filteredItems.length - 1, idx + 1)];
        if (next) setSelectedId(next.id);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = filteredItems[Math.max(0, idx - 1)];
        if (prev) setSelectedId(prev.id);
      } else if (e.key === '1' || e.key.toLowerCase() === 'p') {
        setFlagForItem(selectedItem.id, 'pick');
      } else if (e.key === '2' || e.key.toLowerCase() === 'x') {
        setFlagForItem(selectedItem.id, 'reject');
      } else if (e.key === ' ') {
        e.preventDefault();
        setLoupeZoom((z) => (z > 1.5 ? 1.0 : 2.5));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedItem, filteredItems]);

  const setFlagForItem = (id: string, flag: CullingFlag) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, flag } : it)));
  };

  // 9. AI Rescue Sharpen
  const handleRescuePhoto = async () => {
    if (!selectedItem || isRescuing) return;
    const src = selectedItem.file || selectedItem.nativeUrl;
    if (!src) return;

    setIsRescuing(true);
    try {
      const { blobUrl, blob } = await rescueSoftPhotoWithGpu(src, {
        sharpenStrength: rescueSharpen,
        naturalColorBoost: rescueColorBoost,
      });

      setItems((prev) =>
        prev.map((it) =>
          it.id === selectedItem.id
            ? {
                ...it,
                rescuedUrl: blobUrl,
                flag: 'pick',
                analysis: it.analysis
                  ? {
                      ...it.analysis,
                      score: Math.min(98, it.analysis.score + 24),
                      status: 'sharp',
                    }
                  : undefined,
              }
            : it
        )
      );

      const baseName = selectedItem.name.replace(/\.[^.]+$/, '');
      const outName = `${baseName}_AI_Sharp.jpg`;

      if (isNativeMacApp) {
        await fetch(`/__save_rescued?name=${encodeURIComponent(outName)}`, {
          method: 'POST',
          body: blob,
        });
        setBannerMsg(
          `✨ กู้ความคมชัดและบันทึกไฟล์ "${outName}" ลงในโฟลเดอร์ _AI_กู้ความคมชัด เรียบร้อยแล้ว!`
        );
      } else {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = outName;
        a.click();
      }
    } finally {
      setIsRescuing(false);
    }
  };

  const blurryItems = useMemo(
    () => effectiveItems.filter((it) => it.analysis?.status === 'blurry'),
    [effectiveItems]
  );

  const activeBlurryItem = useMemo(
    () => blurryItems.find((i) => i.id === blurryPreviewId) || blurryItems[0] || null,
    [blurryItems, blurryPreviewId]
  );

  // Move 1 or multiple blurry photos (+ paired RAWs) directly to macOS Trash
  const handleTrashPhotoItems = async (targets: PhotoItem[]) => {
    if (targets.length === 0) return;

    if (isNativeMacApp) {
      const names = targets.map((t) => t.name).join('\n');
      const res = await fetch('/__trash_files', {
        method: 'POST',
        body: names,
      });
      const data = await res.json();
      if (data && data.ok) {
        const trashedSet = new Set(targets.map((t) => t.id));
        setItems((prev) => prev.filter((it) => !trashedSet.has(it.id)));
        const rawNote =
          data.trashedRaws > 0 ? ` (พร้อมไฟล์ RAW คู่กัน ${data.trashedRaws} ไฟล์)` : '';
        setBannerMsg(
          `🗑️ ลบไฟล์ภาพเบลอ ${data.trashedPhotos} รูป${rawNote} ลงถังขยะ (Trash) ของ Mac เรียบร้อยแล้ว!`
        );
      }
    } else {
      // Browser mode: remove from queue
      const trashedSet = new Set(targets.map((t) => t.id));
      setItems((prev) => prev.filter((it) => !trashedSet.has(it.id)));
      setBannerMsg(`🗑️ นำภาพเบลอ ${targets.length} รูป ออกจากรายการเรียบร้อยแล้ว`);
    }
  };

  // 10. Organize Files (0.05s Native C rename())
  const handleOrganizeFiles = async (mode: 'blurry_only' | 'all_three') => {
    if (effectiveItems.length === 0) return;

    if (isNativeMacApp) {
      const lines = effectiveItems.map(
        (it) => `${it.name}|${it.analysis?.status || 'blurry'}`
      );
      const res = await fetch(`/__organize_files?mode=${mode}`, {
        method: 'POST',
        body: lines.join('\n'),
      });
      const data = await res.json();
      if (data && data.ok) {
        setCanUndoOrganize(true);
        const rawNote =
          data.movedRaws > 0 ? ` (พร้อมย้ายไฟล์ RAW คู่กันอีก ${data.movedRaws} ไฟล์)` : '';
        setBannerMsg(
          mode === 'blurry_only'
            ? `✅ ย้ายภาพเบลอ ${data.movedPhotos} รูป${rawNote} เข้าโฟลเดอร์ "_ภาพเบลอ_Blurry" เสร็จในเสี้ยววินาที!`
            : `✅ แยกภาพทั้ง ${data.movedPhotos} รูป${rawNote} เข้าโฟลเดอร์ _ภาพคมชัด, _พอใช้, _ภาพเบลอ เรียบร้อยแล้ว!`
        );
      }
      return;
    }
  };

  const handleUndoOrganize = async () => {
    if (!isNativeMacApp) return;
    const res = await fetch('/__undo_organize', { method: 'POST' });
    const data = await res.json();
    if (data && data.ok) {
      setCanUndoOrganize(false);
      setBannerMsg(`↩️ ย้ายไฟล์ทั้ง ${data.restored} ไฟล์ กลับคืนสู่โฟลเดอร์หลักเรียบร้อยแล้ว!`);
    }
  };

  const handleRevealInFinder = async () => {
    if (!isNativeMacApp) return;
    await fetch('/__reveal_finder', { method: 'POST' });
  };

  const handleStopScan = async () => {
    cancelScanRef.current = true;
    setIsScanning(false);
    if (isNativeMacApp) {
      await fetch('/__stop_scan', { method: 'POST' });
    }
  };

  // 11. OTA Online Update Checker & 1-Click Auto-Update (Top-Right Version Button)
  const [updateInfo, setUpdateInfo] = useState<RemoteUpdateManifest | null>(null);
  const [nativeVer, setNativeVer] = useState<string>(APP_VERSION);
  const [updateStatus, setUpdateStatus] = useState<
    'idle' | 'checking' | 'available' | 'updating' | 'up-to-date' | 'error'
  >('idle');
  const [updateDismissed, setUpdateDismissed] = useState<boolean>(false);
  const [autoOtaEnabled, setAutoOtaEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem('iris_auto_ota') !== 'false';
    } catch {
      return true;
    }
  });

  const checkOnlineUpdate = useCallback(
    async (manual = false) => {
      if (isScanning) return;
      if (manual) {
        setUpdateStatus('checking');
        setUpdateDismissed(false);
      }
      try {
        let manifest: RemoteUpdateManifest | null = null;
        let currentNative = APP_VERSION;

        try {
          const res = await fetch(
            `/__check_update?url=${encodeURIComponent(DEFAULT_UPDATE_MANIFEST_URL)}&t=${Date.now()}`,
            { cache: 'no-store' }
          );
          if (res.ok) {
            const data = await res.json();
            if (data?.nativeVersion) currentNative = data.nativeVersion;
            if (data?.ok && data?.manifest) {
              manifest = data.manifest as RemoteUpdateManifest;
            }
          }
        } catch {
          // Fallback to direct browser fetch
        }

        if (!manifest) {
          const res = await fetch(`${DEFAULT_UPDATE_MANIFEST_URL}?t=${Date.now()}`, {
            cache: 'no-store',
          });
          if (res.ok) {
            manifest = (await res.json()) as RemoteUpdateManifest;
          }
        }

        setNativeVer(currentNative);
        if (manifest && manifest.version && isNewerVersion(manifest.version, APP_VERSION)) {
          setUpdateInfo(manifest);
          setUpdateStatus('available');
          setUpdateDismissed(false);
        } else {
          setUpdateInfo(null);
          setUpdateStatus(manual ? 'up-to-date' : 'idle');
          if (manual) {
            setTimeout(() => setUpdateStatus((s) => (s === 'up-to-date' ? 'idle' : s)), 3500);
          }
        }
      } catch {
        if (manual) {
          setUpdateStatus('error');
          setTimeout(() => setUpdateStatus((s) => (s === 'error' ? 'idle' : s)), 3500);
        }
      }
    },
    [isScanning]
  );

  const applyOnlineUpdate = useCallback(async () => {
    if (!updateInfo?.htmlUrl) return;
    setUpdateStatus('updating');
    try {
      const res = await fetch(
        `/__perform_ota_update?url=${encodeURIComponent(updateInfo.htmlUrl)}`,
        {
          method: 'POST',
          cache: 'no-store',
        }
      );
      if (res.ok) {
        const data = await res.json();
        if (data?.ok) {
          window.location.reload();
          return;
        }
      }
      window.open(updateInfo.htmlUrl, '_blank');
      setUpdateStatus('available');
    } catch {
      window.open(updateInfo.htmlUrl, '_blank');
      setUpdateStatus('available');
    }
  }, [updateInfo]);

  useEffect(() => {
    const startTimer = window.setTimeout(() => {
      checkOnlineUpdate(false);
    }, 2200);
    const periodicTimer = window.setInterval(() => {
      if (!isScanning) {
        checkOnlineUpdate(false);
      }
    }, 30 * 60 * 1000);
    return () => {
      window.clearTimeout(startTimer);
      window.clearInterval(periodicTimer);
    };
  }, [checkOnlineUpdate, isScanning]);

  useEffect(() => {
    if (
      autoOtaEnabled &&
      updateStatus === 'available' &&
      updateInfo?.htmlUrl &&
      !isScanning &&
      items.length === 0 &&
      (!updateInfo.minNativeVersion || !isNewerVersion(updateInfo.minNativeVersion, nativeVer))
    ) {
      applyOnlineUpdate();
    }
  }, [
    autoOtaEnabled,
    updateStatus,
    updateInfo,
    isScanning,
    items.length,
    nativeVer,
    applyOnlineUpdate,
  ]);

  // Virtual Grid Calculations
  const cardMinWidth = 192;
  const cardGap = 14;
  const rowHeight = 186;
  const cols = Math.max(
    1,
    Math.floor((gridViewport.width - 40 + cardGap) / (cardMinWidth + cardGap))
  );
  const totalRows = Math.ceil(filteredItems.length / cols);
  const totalGridHeight = totalRows * rowHeight;

  const startRow = Math.max(0, Math.floor(scrollTop / rowHeight) - 2);
  const endRow = Math.min(
    totalRows,
    Math.ceil((scrollTop + gridViewport.height) / rowHeight) + 2
  );
  const visibleSlice = filteredItems.slice(startRow * cols, endRow * cols);

  const scanPct =
    scanProgress.total > 0
      ? Math.round((scanProgress.done / scanProgress.total) * 100)
      : effectiveItems.length > 0
      ? 100
      : 0;
  const filledDots = Math.round((scanPct / 100) * 48);

  return (
    <div className="app-container">
      {/* Hidden Browser Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => e.target.files && handleFilesSelected(e.target.files)}
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory
        webkitdirectory="true"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => e.target.files && handleFilesSelected(e.target.files)}
      />

      {/* TOP STUDIO & DASHBOARD TOOLBAR */}
      <header className="dv-topbar">
        <div className="top-left">
          <div className="brand-box">
            <IrisLogo />
            <div className="brand-title">
              Iris
            </div>
          </div>

          {/* Switch between 📊 Dashboard and 🎛️ Pro Studio */}
          <div className="ws-mode-switch">
            <button
              className={`ws-mode-btn ${wsMode === 'dashboard' ? 'active' : ''}`}
              onClick={() => setWsMode('dashboard')}
            >
              📊 Dashboard (แดชบอร์ด)
            </button>
            <button
              className={`ws-mode-btn ${wsMode === 'studio' ? 'active' : ''}`}
              onClick={() => setWsMode('studio')}
            >
              🎛️ Pro Studio ({stats.all} รูป)
            </button>
          </div>
        </div>

        <div className="top-center">
          <div
            className="folder-status-pill"
            onClick={currentFolderName ? handleRevealInFinder : handlePickNativeMacFolder}
            title="คลิกเพื่อเลือกหรือเปิดดูโฟลเดอร์"
          >
            <span>📂</span>
            <span>
              {currentFolderName
                ? `${currentFolderName} • ${stats.all} ภาพ ${
                    pairedRawCount > 0 ? `(+${pairedRawCount} RAW)` : ''
                  }`
                : 'ยังไม่ได้เลือกโฟลเดอร์ (คลิกเพื่อเปิดโฟลเดอร์)'}
            </span>
          </div>
        </div>

        <div className="top-right">
          {/* Dark / Light Infographic Theme Switcher */}
          <div className="ws-mode-switch">
            <button
              className={`ws-mode-btn ${theme === 'dark' ? 'active' : ''}`}
              style={{ padding: '5px 10px', fontSize: 11.5 }}
              onClick={() => setTheme('dark')}
            >
              🌙 Dark
            </button>
            <button
              className={`ws-mode-btn ${theme === 'light' ? 'active' : ''}`}
              style={{ padding: '5px 10px', fontSize: 11.5 }}
              onClick={() => setTheme('light')}
            >
              ☀️ Light
            </button>
          </div>

          <button className="option-capsule" onClick={handleLoadDemoPhotos}>
            <span className="option-capsule-icon coral">★</span>
            <span>ชุดภาพทดสอบ AI</span>
          </button>

          <button className="option-capsule" onClick={handlePickNativeMacFolder}>
            <span className="option-capsule-icon mint">📁</span>
            <span>เลือกโฟลเดอร์รูปภาพ</span>
          </button>

          {/* OTA Version & Auto-Update Button in Top-Right Corner */}
          <button
            type="button"
            className="option-capsule"
            style={{
              borderColor:
                updateStatus === 'available'
                  ? 'rgba(45, 212, 191, 0.7)'
                  : updateStatus === 'up-to-date'
                  ? 'rgba(56, 178, 154, 0.5)'
                  : undefined,
              background:
                updateStatus === 'available'
                  ? 'rgba(45, 212, 191, 0.16)'
                  : undefined,
            }}
            onClick={() => checkOnlineUpdate(true)}
            disabled={updateStatus === 'checking' || updateStatus === 'updating'}
            title={`Iris เวอร์ชันปัจจุบัน v${APP_VERSION} — คลิกเพื่อตรวจหาอัปเดตออนไลน์`}
          >
            <span className="option-capsule-icon mint">
              {updateStatus === 'checking'
                ? '⏳'
                : updateStatus === 'updating'
                ? '⬇️'
                : updateStatus === 'available'
                ? '✨'
                : updateStatus === 'up-to-date'
                ? '✅'
                : updateStatus === 'error'
                ? '⚠️'
                : '☁️'}
            </span>
            <span style={{ fontWeight: 800 }}>
              {updateStatus === 'checking'
                ? 'กำลังเช็กอัปเดต...'
                : updateStatus === 'updating'
                ? 'กำลังอัปเดต...'
                : updateStatus === 'available' && updateInfo
                ? `อัปเดตใหม่ v${updateInfo.version}`
                : updateStatus === 'up-to-date'
                ? `ล่าสุดแล้ว v${APP_VERSION}`
                : updateStatus === 'error'
                ? `v${APP_VERSION} (Offline)`
                : `v${APP_VERSION}`}
            </span>
          </button>
        </div>
      </header>

      {/* ONLINE OTA UPDATE AVAILABLE BANNER */}
      {updateStatus === 'available' && updateInfo && !updateDismissed && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '8px 22px',
            background: 'linear-gradient(90deg, rgba(45,212,191,0.18), rgba(251,146,60,0.16))',
            borderBottom: '1px solid rgba(45,212,191,0.45)',
            fontSize: 12.5,
            color: 'var(--text-main)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span>✨</span>
            <strong style={{ color: '#2dd4bf' }}>
              มีอัปเดตใหม่ Iris v{updateInfo.version} พร้อมใช้งาน!
            </strong>
            {updateInfo.notes && (
              <span
                style={{
                  color: 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                — {updateInfo.notes}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={autoOtaEnabled}
                onChange={(e) => {
                  const val = e.target.checked;
                  setAutoOtaEnabled(val);
                  try {
                    localStorage.setItem('iris_auto_ota', String(val));
                  } catch {}
                }}
              />
              อัปเดตอัตโนมัติ
            </label>
            {!updateInfo.minNativeVersion ||
            !isNewerVersion(updateInfo.minNativeVersion, nativeVer) ? (
              <button
                type="button"
                className="btn btn-mint"
                style={{ padding: '4px 12px', fontSize: 12 }}
                onClick={applyOnlineUpdate}
                disabled={isScanning}
              >
                🚀 อัปเดตทันที (Auto-Update)
              </button>
            ) : (
              updateInfo.dmgUrl && (
                <button
                  type="button"
                  className="btn btn-coral"
                  style={{ padding: '4px 12px', fontSize: 12 }}
                  onClick={() => window.open(updateInfo.dmgUrl, '_blank')}
                >
                  ⬇️ ดาวน์โหลดตัวติดตั้งใหม่ (.dmg)
                </button>
              )
            )}
            <button
              type="button"
              className="btn"
              style={{ padding: '3px 8px', fontSize: 11.5 }}
              onClick={() => setUpdateDismissed(true)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* NOTIFICATION BANNER */}
      {bannerMsg && (
        <div
          style={{
            background: 'rgba(56, 178, 154, 0.16)',
            borderBottom: '1px solid var(--mint)',
            padding: '9px 22px',
            fontSize: 12.5,
            color: 'var(--text-main)',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>{bannerMsg}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {isNativeMacApp && (
              <button className="btn btn-mint" onClick={handleRevealInFinder}>
                📂 เปิดดูใน Finder
              </button>
            )}
            <button className="btn" onClick={() => setBannerMsg(null)}>
              ✕
            </button>
          </div>
        </div>
      )}

      {/* =====================================================================
          VIEW 1: 📊 LUXURY INFOGRAPHIC ANALYTICS DASHBOARD (เรียบหรู พรีเมียม)
         ===================================================================== */}
      {wsMode === 'dashboard' ? (
        <div className="dashboard-scroll">
          <div className="dashboard-shell">
            {/* ROW 1: 4 CIRCULAR GRAPH CARDS (CIRCULAR GRAPH - CIRCLES & PERCENTAGES) */}
            <div className="dash-circular-grid">
              <div
                className={`dash-circular-card ${activeTab === 'all' ? 'active-card' : ''}`}
                onClick={() => {
                  setActiveTab('all');
                  if (stats.all > 0) setWsMode('studio');
                }}
              >
                <CircularGraph percent={scanPct} color="#38b29a" />
                <div className="dc-info">
                  <span className="dc-tag">BATCH PROGRESS</span>
                  <span className="dc-title">รูปภาพทั้งหมด</span>
                  <span className="dc-count">{stats.all}</span>
                  <span className="dc-sub">
                    {isScanning
                      ? `กำลังสแกน ${scanProgress.done}/${scanProgress.total}...`
                      : 'คลิกเพื่อดูรูปทั้งหมด'}
                  </span>
                </div>
              </div>

              <div
                className={`dash-circular-card ${activeTab === 'sharp' ? 'active-card' : ''}`}
                onClick={() => {
                  setActiveTab('sharp');
                  if (stats.all > 0) setWsMode('studio');
                }}
              >
                <CircularGraph percent={stats.pctSharp} color="#38b29a" />
                <div className="dc-info">
                  <span className="dc-tag">SHARP FOCUS (KEEP)</span>
                  <span className="dc-title">ภาพคมชัด • เก็บไว้</span>
                  <span className="dc-count" style={{ color: 'var(--mint)' }}>
                    {stats.sharp}
                  </span>
                  <span className="dc-sub">โฟกัสเข้าตาและตัวแบบคมกริบ</span>
                </div>
              </div>

              <div
                className={`dash-circular-card ${activeTab === 'soft' ? 'active-card' : ''}`}
                onClick={() => {
                  setActiveTab('soft');
                  if (stats.all > 0) setWsMode('studio');
                }}
              >
                <CircularGraph percent={stats.pctSoft} color="#f07838" />
                <div className="dc-info">
                  <span className="dc-tag">SOFT FOCUS (RESCUE)</span>
                  <span className="dc-title">พอใช้ • กู้ความคมได้</span>
                  <span className="dc-count" style={{ color: 'var(--coral)' }}>
                    {stats.soft}
                  </span>
                  <span className="dc-sub">หลุดโฟกัสเล็กน้อย กด AI กู้ได้</span>
                </div>
              </div>

              <div
                className={`dash-circular-card ${activeTab === 'blurry' ? 'active-card' : ''}`}
                onClick={() => {
                  setActiveTab('blurry');
                  if (stats.all > 0) setWsMode('studio');
                }}
              >
                <CircularGraph percent={stats.pctBlurry} color="#f43f5e" />
                <div className="dc-info">
                  <span className="dc-tag">BLURRY / OUT OF FOCUS</span>
                  <span className="dc-title">ภาพเบลอ • คัดออก</span>
                  <span className="dc-count" style={{ color: 'var(--danger)' }}>
                    {stats.blurry}
                  </span>
                  <span className="dc-sub">มือสั่น / หลุดโฟกัส / ตาหลับ</span>
                </div>
              </div>
            </div>

            {/* ROW 2: 3-COLUMN LUXURY ANALYTICS PANELS */}
            <div className="dash-analytics-grid">
              {/* PANEL 1: CONCENTRIC CIRCLES GRAPH & STRICTNESS MODE */}
              <div className="dash-panel">
                <div className="dash-panel-head">
                  <div>
                    <div className="dash-panel-title">CONCENTRIC CIRCLES GRAPH</div>
                    <div className="dash-panel-sub">สัดส่วนคุณภาพความคมชัด 3 ระดับ</div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '6px 0' }}>
                  <ConcentricCirclesGraph
                    pctSharp={stats.pctSharp}
                    pctSoft={stats.pctSoft}
                    pctBlurry={stats.pctBlurry}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 700 }}>
                      <span style={{ color: 'var(--mint)' }}>● วงนอก: ภาพคมชัด</span>
                      <span>{stats.pctSharp}% ({stats.sharp})</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 700 }}>
                      <span style={{ color: 'var(--coral)' }}>● วงกลาง: พอใช้/กู้ได้</span>
                      <span>{stats.pctSoft}% ({stats.soft})</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 700 }}>
                      <span style={{ color: 'var(--danger)' }}>● วงใน: ภาพเบลอ</span>
                      <span>{stats.pctBlurry}% ({stats.blurry})</span>
                    </div>
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    เกณฑ์ความเข้มงวดของ AI (Strictness Preset):
                  </div>
                  <div className="ws-mode-switch" style={{ width: '100%' }}>
                    <button
                      className={`ws-mode-btn ${preset === 'relaxed' ? 'active' : ''}`}
                      style={{ flex: 1, justifyContent: 'center' }}
                      onClick={() => handleSelectPreset('relaxed')}
                    >
                      ผ่อนปรน
                    </button>
                    <button
                      className={`ws-mode-btn ${preset === 'standard' ? 'active' : ''}`}
                      style={{ flex: 1, justifyContent: 'center' }}
                      onClick={() => handleSelectPreset('standard')}
                    >
                      มาตรฐานช่างภาพ
                    </button>
                    <button
                      className={`ws-mode-btn ${preset === 'strict' ? 'active' : ''}`}
                      style={{ flex: 1, justifyContent: 'center' }}
                      onClick={() => handleSelectPreset('strict')}
                    >
                      เข้มงวดคมกริบ
                    </button>
                  </div>
                </div>
              </div>

              {/* PANEL 2: HORIZONTAL BAR GRAPH (FOCUS & BLUR BREAKDOWN) */}
              <div className="dash-panel">
                <div className="dash-panel-head">
                  <div>
                    <div className="dash-panel-title">HORIZONTAL BAR ANALYTICS</div>
                    <div className="dash-panel-sub">วิเคราะห์ลักษณะโฟกัสและสาเหตุภาพเสีย</div>
                  </div>
                </div>

                <div className="hbar-list">
                  <div className="hbar-item">
                    <div className="hbar-top">
                      <span>✅ โฟกัสเข้าดวงตาและตัวแบบคมกริบ (Sharp Focus)</span>
                      <span style={{ color: 'var(--mint)' }}>
                        {stats.sharp} รูป ({stats.pctSharp}%)
                      </span>
                    </div>
                    <div className="hbar-track">
                      <div
                        className="hbar-fill"
                        style={{ width: `${stats.pctSharp}%`, background: 'var(--mint)' }}
                      />
                    </div>
                  </div>

                  <div className="hbar-item">
                    <div className="hbar-top">
                      <span>✨ หลุดโฟกัสเล็กน้อย กู้ด้วย AI ได้ (Soft Focus)</span>
                      <span style={{ color: 'var(--coral)' }}>
                        {stats.soft} รูป ({stats.pctSoft}%)
                      </span>
                    </div>
                    <div className="hbar-track">
                      <div
                        className="hbar-fill"
                        style={{ width: `${stats.pctSoft}%`, background: 'var(--coral)' }}
                      />
                    </div>
                  </div>

                  <div className="hbar-item">
                    <div className="hbar-top">
                      <span>🔍 เลนส์หลุดโฟกัส (Out of Focus)</span>
                      <span style={{ color: 'var(--danger)' }}>
                        {stats.outOfFocus} รูป ({stats.pctOutOfFocus}%)
                      </span>
                    </div>
                    <div className="hbar-track">
                      <div
                        className="hbar-fill"
                        style={{ width: `${stats.pctOutOfFocus}%`, background: 'var(--danger)' }}
                      />
                    </div>
                  </div>

                  <div className="hbar-item">
                    <div className="hbar-top">
                      <span>💨 มือสั่น / สปีดชัตเตอร์ต่ำ (Motion Blur)</span>
                      <span>
                        {stats.motionBlur} รูป ({stats.pctMotion}%)
                      </span>
                    </div>
                    <div className="hbar-track">
                      <div
                        className="hbar-fill"
                        style={{ width: `${stats.pctMotion}%`, background: '#8b5cf6' }}
                      />
                    </div>
                  </div>

                  <div className="hbar-item">
                    <div className="hbar-top">
                      <span>🌲 โฟกัสหลุดไปเข้าฉากหลัง (Back-Focus)</span>
                      <span>
                        {stats.backFocus} รูป ({stats.pctBackFocus}%)
                      </span>
                    </div>
                    <div className="hbar-track">
                      <div
                        className="hbar-fill"
                        style={{ width: `${stats.pctBackFocus}%`, background: '#64748b' }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* PANEL 3: AI THINKING CORNER VISUALIZER & 1-CLICK COMMAND CENTER */}
              <div className="dash-panel">
                <div className="dash-panel-head">
                  <div>
                    <div className="dash-panel-title">AI NEURAL ENGINE & ACTIONS</div>
                    <div className="dash-panel-sub">
                      ความเร็ว {scanProgress.speed > 0 ? `${scanProgress.speed} รูป/วินาที` : 'Apple Silicon Multi-Core'}
                    </div>
                  </div>
                  {isScanning && (
                    <button
                      className="btn btn-coral"
                      style={{ padding: '3px 10px', fontSize: 11 }}
                      onClick={handleStopScan}
                    >
                      ⏹ หยุดสแกน
                    </button>
                  )}
                </div>

                {/* Compact Animated "AI Thinking" Spectrum Widget in this Corner Card! */}
                <MiniNeuralCornerWidget
                  isScanning={isScanning}
                  speed={scanProgress.speed}
                  total={stats.all}
                />

                {/* Option Elements Action Buttons */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
                  <button
                    className="option-capsule"
                    style={{ width: '100%', padding: '6px 16px 6px 6px' }}
                    onClick={handlePickNativeMacFolder}
                  >
                    <span className="option-capsule-icon mint">01</span>
                    <span>เลือกโฟลเดอร์รูปภาพที่ต้องการคัดแยก (5,000+ รูป)</span>
                  </button>

                  <button
                    className="option-capsule"
                    style={{ width: '100%', padding: '6px 16px 6px 6px' }}
                    disabled={stats.blurry === 0}
                    onClick={() => {
                      setBlurryPreviewId(blurryItems[0]?.id || null);
                      setUncheckedBlurryIds(new Set());
                      setModalZoom(1.0);
                      setModalPan({ x: 0, y: 0 });
                      setShowBlurryModal(true);
                    }}
                  >
                    <span className="option-capsule-icon coral">02</span>
                    <span>พรีวิวภาพเบลอ & กดลบทิ้งลงถังขยะ ({stats.blurry} รูป)</span>
                  </button>

                  <button
                    className="option-capsule"
                    style={{
                      width: '100%',
                      padding: '6px 16px 6px 6px',
                      background: 'var(--mint)',
                      color: '#fff',
                    }}
                    disabled={stats.all === 0}
                    onClick={() => handleOrganizeFiles('blurry_only')}
                  >
                    <span className="option-capsule-icon coral">03</span>
                    <span>
                      ย้ายภาพเบลอ ({stats.blurry} รูป) แยกเข้าโฟลเดอร์ _ภาพเบลอ
                    </span>
                  </button>

                  <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                    <button
                      className="btn"
                      style={{ flex: 1, justifyContent: 'center' }}
                      disabled={stats.all === 0}
                      onClick={() => handleOrganizeFiles('all_three')}
                    >
                      🗂️ แยกครบ 3 โฟลเดอร์
                    </button>
                    {canUndoOrganize && isNativeMacApp && (
                      <button
                        className="btn"
                        style={{ flex: 1, justifyContent: 'center' }}
                        onClick={handleUndoOrganize}
                      >
                        ↩️ ย้ายกลับที่เดิม
                      </button>
                    )}
                    {isNativeMacApp && currentFolderName && (
                      <button
                        className="btn"
                        style={{ flex: 1, justifyContent: 'center' }}
                        onClick={handleRevealInFinder}
                      >
                        📂 เปิด Finder
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* ROW 3: QUICK PHOTO PREVIEW STRIP IN DASHBOARD */}
            <div className="dash-panel">
              <div className="dash-panel-head">
                <div>
                  <div className="dash-panel-title">LIVE PHOTO PREVIEW STRIP</div>
                  <div className="dash-panel-sub">
                    คลิกที่รูปใดก็ได้เพื่อเปิดดูจอซูมลูกกะตา 100% ในโหมด Pro Studio
                  </div>
                </div>
                {stats.all > 0 && (
                  <button className="btn btn-mint" onClick={() => setWsMode('studio')}>
                    🎛️ เปิดดูตารางภาพทั้งหมด ({stats.all} รูป) ➔
                  </button>
                )}
              </div>

              {effectiveItems.length === 0 ? (
                <div
                  style={{
                    padding: '28px',
                    textAlign: 'center',
                    color: 'var(--text-secondary)',
                    fontSize: 13.5,
                  }}
                >
                  ยังไม่มีรูปภาพในคิว — กดปุ่ม{' '}
                  <strong style={{ color: 'var(--mint)', cursor: 'pointer' }} onClick={handlePickNativeMacFolder}>
                    📁 เลือกโฟลเดอร์รูปภาพ
                  </strong>{' '}
                  หรือ{' '}
                  <strong style={{ color: 'var(--coral)', cursor: 'pointer' }} onClick={handleLoadDemoPhotos}>
                    ★ ชุดภาพทดสอบ AI
                  </strong>{' '}
                  เพื่อดูกราฟแดชบอร์ดทันที
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(155px, 1fr))',
                    gap: 12,
                  }}
                >
                  {effectiveItems.slice(0, 14).map((item) => {
                    const st = item.analysis?.status || 'blurry';
                    const score = item.analysis?.score ?? 0;
                    return (
                      <div
                        key={item.id}
                        className="photo-card"
                        onClick={() => {
                          setSelectedId(item.id);
                          setWsMode('studio');
                        }}
                      >
                        <div className="thumb-wrap">
                          <img
                            src={item.rescuedUrl || item.thumbUrl}
                            alt={item.name}
                            className="thumb-img"
                            loading="lazy"
                          />
                          <div className={`score-pill ${st}`}>
                            {st === 'sharp'
                              ? `คม ${score}%`
                              : st === 'soft'
                              ? `พอใช้ ${score}%`
                              : `เบลอ ${score}%`}
                          </div>
                        </div>
                        <div className="photo-card-info">
                          <div className="photo-name">{item.name}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* =====================================================================
           VIEW 2: 🎛️ PRO STUDIO (ตารางรูปภาพ 5,000+ ใบ + จอซูมลูกกะตา 100%)
           ===================================================================== */
        <div className="main-layout">
          <div className="workspace-area">
            {/* Filter Strip */}
            <div className="studio-filter-strip">
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className={`btn ${activeTab === 'all' ? 'btn-mint' : ''}`}
                  onClick={() => setActiveTab('all')}
                >
                  ทั้งหมด ({stats.all})
                </button>
                <button
                  className={`btn ${activeTab === 'sharp' ? 'btn-mint' : ''}`}
                  onClick={() => setActiveTab('sharp')}
                >
                  🟢 ภาพคมชัด ({stats.sharp})
                </button>
                <button
                  className={`btn ${activeTab === 'soft' ? 'btn-coral' : ''}`}
                  onClick={() => setActiveTab('soft')}
                >
                  🟠 พอใช้/กู้ได้ ({stats.soft})
                </button>
                <button
                  className={`btn ${activeTab === 'blurry' ? 'btn-coral' : ''}`}
                  onClick={() => setActiveTab('blurry')}
                >
                  🔴 ภาพเบลอ ({stats.blurry})
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="🔍 ค้นหาชื่อไฟล์ (เช่น 34214)..."
                  style={{
                    background: 'var(--bg-subtle)',
                    border: '1px solid var(--border-strong)',
                    color: 'var(--text-main)',
                    padding: '5px 12px',
                    borderRadius: 999,
                    fontSize: 12,
                    width: 200,
                    outline: 'none',
                  }}
                />
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={onlyBestInBurst}
                    onChange={(e) => setOnlyBestInBurst(e.target.checked)}
                  />
                  <span>★ แสดงเฉพาะใบที่คมสุดในชุดรัวชัตเตอร์</span>
                </label>
              </div>
            </div>

            {/* Virtualized Photo Grid */}
            <div
              ref={gridScrollRef}
              className="photo-grid-scroll"
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            >
              <div style={{ height: totalGridHeight, position: 'relative' }}>
                <div
                  className="photo-grid"
                  style={{
                    position: 'absolute',
                    top: startRow * rowHeight,
                    left: 0,
                    right: 0,
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  }}
                >
                  {visibleSlice.map((item) => {
                    const st = item.analysis?.status || 'blurry';
                    const score = item.analysis?.score ?? 0;
                    const isSel = selectedItem?.id === item.id;

                    return (
                      <div
                        key={item.id}
                        className={`photo-card ${isSel ? 'selected' : ''}`}
                        style={{ height: rowHeight - cardGap }}
                        onClick={() => {
                          setSelectedId(item.id);
                          setActiveRegionIdx(0);
                        }}
                      >
                        <div className="thumb-wrap">
                          <img
                            src={item.rescuedUrl || item.thumbUrl}
                            alt={item.name}
                            className="thumb-img"
                            loading="lazy"
                          />
                          <div className={`score-pill ${st}`}>
                            {st === 'sharp'
                              ? `คมชัด ${score}%`
                              : st === 'soft'
                              ? `พอใช้ ${score}%`
                              : `เบลอ ${score}%`}
                          </div>
                          {item.isBestInBurst && <div className="burst-badge">★ BEST</div>}
                        </div>

                        <div className="photo-card-info">
                          <div className="photo-name" title={item.name}>
                            {item.name}
                          </div>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700 }}>
                            {item.width}×{item.height}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT 100% EYE FOCUS INSPECTOR (With Interactive Mouse Drag Pan, Wheel Zoom & Resize) */}
          <aside
            className="inspector-panel"
            style={{ width: inspectorWidth, position: 'relative' }}
          >
            {/* Left Border Drag Handle to Widen/Narrow Inspector */}
            <div
              title="ลากซ้าย-ขวาเพื่อขยายขนาดหน้าต่างดูภาพ"
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: 6,
                cursor: 'ew-resize',
                zIndex: 30,
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                const startX = e.clientX;
                const startW = inspectorWidth;
                const onMove = (me: MouseEvent) => {
                  const nextW = Math.max(340, Math.min(760, startW + (startX - me.clientX)));
                  setInspectorWidth(nextW);
                };
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove);
                  window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
              }}
            />

            <div className="inspector-header">
              <span>🔍 100% EYE & FOCUS LOUPE</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {(loupePan.x !== 0 || loupePan.y !== 0) && (
                  <button
                    className="btn"
                    style={{ padding: '4px 9px', fontSize: 11 }}
                    onClick={() => setLoupePan({ x: 0, y: 0 })}
                    title="กลับไปยังจุดโฟกัส AI อัตโนมัติ"
                  >
                    🎯 จุดโฟกัส
                  </button>
                )}
                <button
                  className="btn"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                  onClick={() => {
                    setLoupeZoom((z) => (z > 1.5 ? 1.0 : 2.5));
                    setLoupePan({ x: 0, y: 0 });
                  }}
                >
                  {loupeZoom > 1.5 ? 'ดูเต็มใบ' : 'ซูม 100%'}
                </button>
                <button
                  className="btn"
                  style={{ padding: '4px 10px', fontSize: 11 }}
                  onClick={() => setShowLandmarks((s) => !s)}
                >
                  {showLandmarks ? 'ซ่อนกรอบ' : 'แสดงกรอบ'}
                </button>
              </div>
            </div>

            <div
              className="loupe-container"
              style={{
                height: loupeHeight,
                cursor: isDraggingLoupe ? 'grabbing' : 'grab',
                userSelect: 'none',
              }}
              onMouseDown={(e) => {
                if (!selectedItem) return;
                e.preventDefault();
                if (loupeZoom <= 1.05) {
                  setLoupeZoom(2.5);
                }
                setIsDraggingLoupe(true);
                dragStartRef.current = {
                  clientX: e.clientX,
                  clientY: e.clientY,
                  startX: loupePan.x,
                  startY: loupePan.y,
                };
              }}
              onMouseMove={(e) => {
                if (!isDraggingLoupe || !dragStartRef.current) return;
                const dx = e.clientX - dragStartRef.current.clientX;
                const dy = e.clientY - dragStartRef.current.clientY;
                const sensitivity = 1.0 / (Math.max(1.2, loupeZoom) * inspectorWidth);
                setLoupePan({
                  x: Math.max(-0.85, Math.min(0.85, dragStartRef.current.startX - dx * sensitivity)),
                  y: Math.max(-0.85, Math.min(0.85, dragStartRef.current.startY - dy * sensitivity)),
                });
              }}
              onMouseUp={() => {
                setIsDraggingLoupe(false);
                dragStartRef.current = null;
              }}
              onMouseLeave={() => {
                setIsDraggingLoupe(false);
                dragStartRef.current = null;
              }}
              onDoubleClick={() => {
                setLoupeZoom((z) => (z > 1.5 ? 1.0 : 2.8));
                setLoupePan({ x: 0, y: 0 });
              }}
              onWheel={(e) => {
                e.preventDefault();
                const delta = -e.deltaY * 0.004;
                setLoupeZoom((z) => Math.max(1.0, Math.min(6.0, Number((z + delta).toFixed(2)))));
              }}
            >
              <canvas ref={loupeCanvasRef} className="loupe-canvas" />
              {selectedItem?.analysis && (
                <div className="loupe-badge" style={{ pointerEvents: 'none' }}>
                  ✋ คลิกค้างแล้วลากเมาส์เพื่อเลื่อนดูภาพ • หมุนลูกกลิ้งซูม ({loupeZoom.toFixed(1)}x)
                </div>
              )}
            </div>

            {/* Bottom Resize Handle + Interactive Zoom Slider Bar */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 14px',
                background: 'var(--bg-subtle)',
                borderBottom: '1px solid var(--border)',
                fontSize: 11.5,
                fontWeight: 700,
              }}
            >
              <span>🔍 ซูม:</span>
              <input
                type="range"
                min={1.0}
                max={6.0}
                step={0.1}
                value={loupeZoom}
                onChange={(e) => setLoupeZoom(Number(e.target.value))}
                style={{ flex: 1, accentColor: '#38b29a' }}
              />
              <span style={{ minWidth: 34, textAlign: 'right' }}>{loupeZoom.toFixed(1)}x</span>
              <span
                title="ลากขึ้น-ลงเพื่อปรับความสูงของจอภาพ"
                style={{
                  cursor: 'ns-resize',
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-strong)',
                  fontSize: 10,
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startH = loupeHeight;
                  const onMove = (me: MouseEvent) => {
                    setLoupeHeight(Math.max(220, Math.min(580, startH + (me.clientY - startY))));
                  };
                  const onUp = () => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                  };
                  window.addEventListener('mousemove', onMove);
                  window.addEventListener('mouseup', onUp);
                }}
              >
                ↕ ปรับขนาดจอ
              </span>
            </div>

            {selectedItem?.analysis && selectedItem.analysis.focusRegions.length > 1 && (
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  padding: '8px 14px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {selectedItem.analysis.focusRegions.map((reg, idx) => (
                  <button
                    key={idx}
                    className={`btn ${activeRegionIdx === idx ? 'btn-mint' : ''}`}
                    style={{ padding: '5px 8px', fontSize: 11, flex: 1, justifyContent: 'center' }}
                    onClick={() => {
                      setActiveRegionIdx(idx);
                      setLoupeZoom(2.5);
                    }}
                  >
                    {reg.type === 'left_eye'
                      ? '👁️ ตาซ้าย'
                      : reg.type === 'right_eye'
                      ? '👁️ ตาขวา'
                      : '🧑 ใบหน้า'}
                  </button>
                ))}
              </div>
            )}

            <div className="inspector-details">
              {selectedItem && selectedItem.analysis ? (
                <>
                  <div className="detail-card">
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 900,
                        color:
                          selectedItem.analysis.status === 'sharp'
                            ? 'var(--mint)'
                            : selectedItem.analysis.status === 'soft'
                            ? 'var(--coral)'
                            : 'var(--danger)',
                      }}
                    >
                      {selectedItem.analysis.status === 'sharp'
                        ? `🟢 ภาพคมชัด (${selectedItem.analysis.score}%)`
                        : selectedItem.analysis.status === 'soft'
                        ? `🟠 พอใช้ / กู้ได้ (${selectedItem.analysis.score}%)`
                        : `🔴 ภาพเบลอ / คัดออก (${selectedItem.analysis.score}%)`}
                    </div>

                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      <strong>วิเคราะห์: </strong>
                      {selectedItem.analysis.blurType === 'none'
                        ? inspectedMeta.maskedRunner
                          ? 'AI ตรวจพบตัวแบบสวมหน้ากาก/หมวก และโฟกัสเข้าเป้าคมชัด'
                          : 'โฟกัสเข้าดวงตาและตัวแบบคมกริบ'
                        : selectedItem.analysis.blurType === 'eyes_closed'
                        ? 'ตัวแบบหลับตาหรือกะพริบตา'
                        : selectedItem.analysis.blurType === 'motion_blur'
                        ? 'ภาพเบลอจากมือสั่น / สปีดชัตเตอร์ต่ำ'
                        : selectedItem.analysis.blurType === 'back_focus'
                        ? 'โฟกัสหลุดไปเข้าฉากหลัง'
                        : 'เลนส์หลุดโฟกัส'}
                    </div>

                    {/* AI Bib Number + Human Body Count + Real Camera EXIF Pills */}
                    {(inspectedMeta.bib || inspectedMeta.shutter || inspectedMeta.humanCount) && (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: 6,
                          paddingTop: 4,
                        }}
                      >
                        {inspectedMeta.bib && (
                          <span
                            style={{
                              background: 'rgba(56, 178, 154, 0.18)',
                              border: '1px solid var(--mint)',
                              color: 'var(--mint)',
                              padding: '2px 8px',
                              borderRadius: 6,
                              fontSize: 11.5,
                              fontWeight: 800,
                            }}
                          >
                            🎽 AI อ่านเบอร์วิ่ง Bib: #{inspectedMeta.bib}
                          </span>
                        )}
                        {inspectedMeta.humanCount !== undefined && inspectedMeta.humanCount > 0 && (
                          <span
                            style={{
                              background: 'var(--bg-subtle)',
                              border: '1px solid var(--border-strong)',
                              color: 'var(--text-main)',
                              padding: '2px 8px',
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 700,
                            }}
                          >
                            🧍 AI พบตัวแบบ {inspectedMeta.humanCount} คน
                          </span>
                        )}
                        {inspectedMeta.shutter && (
                          <span
                            style={{
                              background: 'var(--bg-subtle)',
                              border: '1px solid var(--border)',
                              color: 'var(--text-secondary)',
                              padding: '2px 8px',
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 600,
                            }}
                          >
                            📷 {inspectedMeta.camera || 'Camera'} • {inspectedMeta.shutter} •{' '}
                            {inspectedMeta.fstop} • {inspectedMeta.iso} • {inspectedMeta.focal}
                          </span>
                        )}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <button
                        className={`btn ${
                          selectedItem.analysis.status === 'sharp' ? 'btn-mint' : ''
                        }`}
                        style={{ flex: 1, justifyContent: 'center', padding: '9px' }}
                        onClick={() => setFlagForItem(selectedItem.id, 'pick')}
                      >
                        ✓ เก็บไว้ (กด 1)
                      </button>
                      <button
                        className={`btn ${
                          selectedItem.analysis.status === 'blurry' ? 'btn-coral' : ''
                        }`}
                        style={{ flex: 1, justifyContent: 'center', padding: '9px' }}
                        onClick={() => setFlagForItem(selectedItem.id, 'reject')}
                      >
                        ✕ คัดออก (กด 2)
                      </button>
                    </div>

                    <button
                      className="btn"
                      style={{
                        width: '100%',
                        justifyContent: 'center',
                        padding: '8px',
                        marginTop: 4,
                        borderColor: 'rgba(244, 63, 94, 0.45)',
                        color: 'var(--danger)',
                      }}
                      onClick={() => handleTrashPhotoItems([selectedItem])}
                    >
                      🗑️ ลบภาพนี้ลงถังขยะทันที (Move to Trash)
                    </button>
                  </div>

                  <div className="detail-card">
                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--coral)' }}>
                      ✨ AI SUPER-RES RESCUE
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      <span>ดึงความคมชัด:</span>
                      <input
                        type="range"
                        min={25}
                        max={100}
                        value={rescueSharpen}
                        onChange={(e) => setRescueSharpen(Number(e.target.value))}
                        style={{ width: 125, accentColor: '#38b29a' }}
                      />
                      <span>{rescueSharpen}%</span>
                    </div>
                    <button
                      className="btn btn-mint"
                      style={{ width: '100%', justifyContent: 'center', padding: '9px' }}
                      disabled={isRescuing}
                      onClick={handleRescuePhoto}
                    >
                      {isRescuing ? 'กำลังประมวลผล GPU...' : '🚀 AI กู้ความคมชัดภาพนี้ทันที'}
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ color: 'var(--text-muted)', fontSize: 12.5, textAlign: 'center', marginTop: 40 }}>
                  คลิกที่รูปภาพเพื่อซูมดูความคมชัดของดวงตา 100%
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* BOTTOM ACTION BAR */}
      <footer className="culling-actions-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span>
            <span className="kbd-badge">←</span> <span className="kbd-badge">→</span> เลื่อนดูภาพ
          </span>
          <span>
            <span className="kbd-badge">1</span> เก็บภาพคม
          </span>
          <span>
            <span className="kbd-badge">2</span> คัดออกเป็นภาพเบลอ
          </span>
          <span>
            <span className="kbd-badge">Space</span> ซูม 100%
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {canUndoOrganize && isNativeMacApp && (
            <button className="btn" onClick={handleUndoOrganize}>
              ↩️ ย้ายไฟล์กลับที่เดิม (Undo)
            </button>
          )}
          {isNativeMacApp && currentFolderName && (
            <button className="btn" onClick={handleRevealInFinder}>
              📂 เปิดดูใน Finder
            </button>
          )}
          <button
            className="btn"
            disabled={stats.all === 0}
            onClick={() => handleOrganizeFiles('all_three')}
          >
            🗂️ แยกครบ 3 โฟลเดอร์
          </button>
          <button
            className="btn btn-coral"
            style={{ padding: '9px 16px', fontSize: 13 }}
            disabled={stats.blurry === 0}
            onClick={() => {
              setBlurryPreviewId(blurryItems[0]?.id || null);
              setUncheckedBlurryIds(new Set());
              setModalZoom(1.0);
              setModalPan({ x: 0, y: 0 });
              setShowBlurryModal(true);
            }}
          >
            👁️🗑️ พรีวิวภาพเบลอ & กดลบทิ้ง ({stats.blurry} รูป)
          </button>

          <button
            className="btn btn-mint"
            style={{ padding: '9px 18px', fontSize: 13 }}
            disabled={stats.all === 0}
            onClick={() => handleOrganizeFiles('blurry_only')}
          >
            🚀 ย้ายภาพเบลอ ({stats.blurry} รูป) แยกเข้าโฟลเดอร์ _ภาพเบลอ
          </button>
        </div>
      </footer>

      {/* =====================================================================
          BLURRY QUICK-PREVIEW & DELETE LIGHTBOX MODAL (พรีวิวภาพเบลอแล้วกดลบได้ทันที)
         ===================================================================== */}
      {showBlurryModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(6, 8, 14, 0.88)',
            backdropFilter: 'blur(12px)',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Modal Header */}
          <div
            style={{
              height: 58,
              background: 'var(--bg-panel)',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 22px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 16, fontWeight: 900, color: 'var(--text-main)' }}>
                👁️🗑️ พรีวิวตรวจเช็คภาพเบลอก่อนลบทิ้ง ({blurryItems.length} รูป)
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                คลิกดูรูปขนาดใหญ่ • লากเมาส์หรือหมุนลูกกลิ้งเพื่อซูม • กดเก็บไว้ถ้ารูปไหนไม่เบลอ
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                className="btn"
                onClick={() => {
                  setModalZoom((z) => (z > 1.2 ? 1.0 : 2.5));
                  setModalPan({ x: 0, y: 0 });
                }}
              >
                🔍 {modalZoom > 1.2 ? 'ดูเต็มใบ (1.0x)' : 'ซูมขยาย (2.5x)'}
              </button>
              <button className="btn" onClick={() => setShowBlurryModal(false)}>
                ✕ ปิดหน้าต่างพรีวิว
              </button>
            </div>
          </div>

          {/* Modal Body: Left Thumbnail Strip + Right Giant Interactive Preview */}
          <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
            {/* Left Strip of Blurry Photos */}
            <div
              style={{
                width: 280,
                background: 'var(--bg-panel)',
                borderRight: '1px solid var(--border)',
                overflowY: 'auto',
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {blurryItems.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
                  ไม่มีภาพเบลอเหลืออยู่ในรายการแล้ว 🎉
                </div>
              ) : (
                blurryItems.map((it, idx) => {
                  const isActive = activeBlurryItem?.id === it.id;
                  const isCheckedForTrash = !uncheckedBlurryIds.has(it.id);
                  return (
                    <div
                      key={it.id}
                      onClick={() => {
                        setBlurryPreviewId(it.id);
                        setModalZoom(1.0);
                        setModalPan({ x: 0, y: 0 });
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: 8,
                        borderRadius: 10,
                        background: isActive ? 'rgba(240, 120, 56, 0.16)' : 'var(--bg-card)',
                        border: isActive
                          ? '2px solid var(--coral)'
                          : '1px solid var(--border)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isCheckedForTrash}
                        onChange={(e) => {
                          e.stopPropagation();
                          setUncheckedBlurryIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(it.id)) next.delete(it.id);
                            else next.add(it.id);
                            return next;
                          });
                        }}
                        title="ติ๊กถูกเพื่อรวมในรายการสั่งลบ"
                        style={{ width: 16, height: 16, accentColor: '#f43f5e' }}
                      />
                      <img
                        src={it.thumbUrl}
                        alt={it.name}
                        style={{
                          width: 64,
                          height: 46,
                          objectFit: 'cover',
                          objectPosition: 'center 18%',
                          borderRadius: 6,
                          background: '#000',
                        }}
                      />
                      <div style={{ flex: 1, overflow: 'hidden' }}>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 800,
                            color: 'var(--text-main)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {idx + 1}. {it.name}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 700 }}>
                          🔴 คะแนนความคม {it.analysis?.score ?? 0}%
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Right Giant Interactive Preview + Single/Batch Delete Controls */}
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                background: '#05070b',
                overflow: 'hidden',
              }}
            >
              {activeBlurryItem ? (
                <>
                  {/* Giant Image Viewport (Supports Mouse Drag Pan & Wheel Zoom!) */}
                  <div
                    style={{
                      flex: 1,
                      position: 'relative',
                      overflow: 'hidden',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: isModalDragging ? 'grabbing' : 'grab',
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setIsModalDragging(true);
                      modalDragRef.current = {
                        cx: e.clientX,
                        cy: e.clientY,
                        sx: modalPan.x,
                        sy: modalPan.y,
                      };
                    }}
                    onMouseMove={(e) => {
                      if (!isModalDragging || !modalDragRef.current) return;
                      setModalPan({
                        x: modalDragRef.current.sx + (e.clientX - modalDragRef.current.cx),
                        y: modalDragRef.current.sy + (e.clientY - modalDragRef.current.cy),
                      });
                    }}
                    onMouseUp={() => {
                      setIsModalDragging(false);
                      modalDragRef.current = null;
                    }}
                    onMouseLeave={() => {
                      setIsModalDragging(false);
                      modalDragRef.current = null;
                    }}
                    onWheel={(e) => {
                      e.preventDefault();
                      const d = -e.deltaY * 0.003;
                      setModalZoom((z) => Math.max(1.0, Math.min(5.0, Number((z + d).toFixed(2)))));
                    }}
                    onDoubleClick={() => {
                      setModalZoom((z) => (z > 1.2 ? 1.0 : 2.5));
                      setModalPan({ x: 0, y: 0 });
                    }}
                  >
                    <img
                      src={activeBlurryItem.nativeUrl || activeBlurryItem.thumbUrl}
                      alt={activeBlurryItem.name}
                      draggable={false}
                      style={{
                        maxWidth: '92%',
                        maxHeight: '90%',
                        objectFit: 'contain',
                        transform: `translate(${modalPan.x}px, ${modalPan.y}px) scale(${modalZoom})`,
                        transition: isModalDragging ? 'none' : 'transform 0.12s ease',
                        borderRadius: 8,
                        boxShadow: '0 12px 40px rgba(0,0,0,0.65)',
                      }}
                    />

                    <div
                      style={{
                        position: 'absolute',
                        top: 16,
                        left: 16,
                        background: 'rgba(0,0,0,0.78)',
                        border: '1px solid rgba(255,255,255,0.18)',
                        padding: '6px 14px',
                        borderRadius: 999,
                        color: '#fff',
                        fontSize: 13,
                        fontWeight: 800,
                      }}
                    >
                      📄 {activeBlurryItem.name} • คะแนน {activeBlurryItem.analysis?.score ?? 0}% • ซูม{' '}
                      {modalZoom.toFixed(1)}x
                    </div>
                  </div>

                  {/* Bottom Decision Bar inside Modal */}
                  <div
                    style={{
                      height: 70,
                      background: 'var(--bg-panel)',
                      borderTop: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0 24px',
                    }}
                  >
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button
                        className="btn btn-mint"
                        style={{ padding: '10px 18px', fontSize: 13.5 }}
                        onClick={() => {
                          const curId = activeBlurryItem.id;
                          const idx = blurryItems.findIndex((b) => b.id === curId);
                          const nextItem = blurryItems[idx + 1] || blurryItems[idx - 1] || null;
                          setFlagForItem(curId, 'pick');
                          setBlurryPreviewId(nextItem?.id || null);
                        }}
                      >
                        ✅ ภาพนี้ไม่เบลอ — เก็บไว้เป็นภาพคมชัด
                      </button>

                      <button
                        className="btn"
                        style={{
                          padding: '10px 18px',
                          fontSize: 13.5,
                          borderColor: 'var(--danger)',
                          color: 'var(--danger)',
                        }}
                        onClick={async () => {
                          const cur = activeBlurryItem;
                          const idx = blurryItems.findIndex((b) => b.id === cur.id);
                          const nextItem = blurryItems[idx + 1] || blurryItems[idx - 1] || null;
                          await handleTrashPhotoItems([cur]);
                          setBlurryPreviewId(nextItem?.id || null);
                        }}
                      >
                        🗑️ ลบเฉพาะใบนี้ลงถังขยะทันที ({activeBlurryItem.name})
                      </button>
                    </div>

                    {(() => {
                      const selectedForTrash = blurryItems.filter(
                        (b) => !uncheckedBlurryIds.has(b.id)
                      );
                      return (
                        <button
                          className="btn"
                          style={{
                            padding: '11px 22px',
                            fontSize: 14,
                            background: '#e11d48',
                            borderColor: '#f43f5e',
                            color: '#ffffff',
                          }}
                          disabled={selectedForTrash.length === 0}
                          onClick={async () => {
                            await handleTrashPhotoItems(selectedForTrash);
                            setShowBlurryModal(false);
                          }}
                        >
                          🗑️🔥 ลบภาพเบลอที่ติ๊กเลือกทั้งหมด ({selectedForTrash.length} รูป) ลงถังขยะ Mac
                        </button>
                      );
                    })()}
                  </div>
                </>
              ) : (
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'var(--text-muted)',
                    fontSize: 15,
                    fontWeight: 700,
                  }}
                >
                  จัดการภาพเบลอครบหมดแล้วครับ! 🎉
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
