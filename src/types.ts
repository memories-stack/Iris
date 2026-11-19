export type CullingStatus = 'sharp' | 'soft' | 'blurry';
export type CullingFlag = 'pick' | 'unflagged' | 'reject';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface FocusRegion {
  type: 'left_eye' | 'right_eye' | 'face' | 'center';
  label: string;
  box: BoundingBox;
  sharpness: number;
}

export interface BlurAnalysisResult {
  score: number; // 0 - 100
  status: CullingStatus;
  detectedSubject: 'neural_eye' | 'skin_portrait' | 'general_object';
  aiEngineUsed: 'WebGL2 + TFJS 68-Landmark Neural AI' | 'WebGL2 GPU Shader + Saliency';
  faceCount: number;
  focusRegions: FocusRegion[];
  primaryFocusRegion?: FocusRegion;
  leftEyeSharpness?: number;
  rightEyeSharpness?: number;
  eyeAspectRatio?: number; // EAR for blink detection (< 0.20 = eyes closed)
  hasEyesOpen: boolean;
  eyesClosedWarning: boolean;
  blurType: 'none' | 'motion_blur' | 'out_of_focus' | 'eyes_closed' | 'back_focus';
  motionAngle?: number; // degrees if motion blur detected
  motionMagnitude?: number;
  backgroundSharpness: number;
  subjectSharpness: number;
  bokehRatio: number; // subjectSharpness / (backgroundSharpness + 1)
  laplacianVariance: number;
  tenengradScore: number;
  analysisTimeMs: number;
  landmarks?: Point2D[];
}

export interface PhotoItem {
  id: string;
  file?: File;
  nativeUrl?: string; // When running inside /Applications/SharpSelect.app
  name: string;
  size: number;
  lastModified: number;
  thumbUrl: string; // Lightweight ~12KB micro-thumbnail for 5,000+ photos in RAM
  width: number;
  height: number;
  analysis?: BlurAnalysisResult;
  flag: CullingFlag;
  burstGroupId?: string;
  isBestInBurst?: boolean;
  analyzing?: boolean;
  rescuedUrl?: string; // SnapPro WebGL2 RCAS AI Rescued image blob URL
  error?: string;
}

export interface CullingThresholds {
  sharpMin: number; // e.g. 65
  softMin: number;  // e.g. 42
  portraitWeight: number; // e.g. 1.85x focus on eye/face vs bg
  blinkDetection: boolean; // Auto-downgrade or warn when eyes closed (EAR < 0.20)
  gpuConcurrency: number; // Parallel workers / batch size (2 - 8)
}
