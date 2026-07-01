import { create } from 'zustand';
import type {
  Calibration,
  DisplayMode,
  ImageInfo,
  Particle,
  ProcessingSettings,
  ROI,
  SortDirection,
  SortKey,
  ToolMode,
  WorkflowStep,
} from './types';

interface AnalyzerState {
  image: ImageInfo | null;
  imageElement: HTMLImageElement | null;
  displayMode: DisplayMode;
  toolMode: ToolMode;
  roi: ROI | null;
  calibration: Calibration;
  settings: ProcessingSettings;
  particles: Particle[];
  selectedParticleId: number | null;
  showExcluded: boolean;
  maskDataUrl: string | null;
  overlayDataUrl: string | null;
  sortKey: SortKey;
  sortDirection: SortDirection;
  undoStack: Particle[][];
  redoStack: Particle[][];
  currentStep: WorkflowStep;
  completedSteps: Partial<Record<WorkflowStep, boolean>>;
  dirtyFromStep: WorkflowStep | null;
  stepWarnings: Partial<Record<WorkflowStep, string>>;
  setImage: (image: ImageInfo, imageElement: HTMLImageElement) => void;
  resetImage: () => void;
  goToStep: (step: WorkflowStep) => void;
  completeStep: (step: WorkflowStep) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setToolMode: (mode: ToolMode) => void;
  setROI: (roi: ROI | null) => void;
  setCalibration: (calibration: Calibration) => void;
  setSettings: (settings: Partial<ProcessingSettings>) => void;
  setAnalysisResult: (particles: Particle[], maskDataUrl: string, overlayDataUrl: string) => void;
  setSelectedParticleId: (id: number | null) => void;
  toggleParticleExcluded: (id: number) => void;
  undo: () => void;
  redo: () => void;
  setShowExcluded: (show: boolean) => void;
  setSort: (key: SortKey) => void;
}

const defaultCalibration: Calibration = {
  pixelLength: 0,
  actualLength: 1,
  unit: 'µm',
  pixelSize: 0,
  line: null,
};

const defaultSettings: ProcessingSettings = {
  threshold: 128,
  polarity: 'bright',
  overlayOpacity: 0.5,
  blurKernel: 0,
  openingIterations: 0,
  closingIterations: 0,
};

const pushHistory = (particles: Particle[], undoStack: Particle[][]) => [
  particles.map((particle) => ({ ...particle, contour: particle.contour.map((point) => ({ ...point })) })),
  ...undoStack,
].slice(0, 30);

export const useAnalyzerStore = create<AnalyzerState>((set) => ({
  image: null,
  imageElement: null,
  displayMode: 'original',
  toolMode: 'select',
  roi: null,
  calibration: defaultCalibration,
  settings: defaultSettings,
  particles: [],
  selectedParticleId: null,
  showExcluded: true,
  maskDataUrl: null,
  overlayDataUrl: null,
  sortKey: 'id',
  sortDirection: 'asc',
  undoStack: [],
  redoStack: [],
  currentStep: 'upload',
  completedSteps: {},
  dirtyFromStep: null,
  stepWarnings: {},
  setImage: (image, imageElement) =>
    set({
      image,
      imageElement,
      displayMode: 'original',
      toolMode: 'calibrate',
      roi: null,
      calibration: defaultCalibration,
      settings: defaultSettings,
      particles: [],
      selectedParticleId: null,
      maskDataUrl: null,
      overlayDataUrl: null,
      undoStack: [],
      redoStack: [],
      currentStep: 'calibration',
      completedSteps: { upload: true },
      dirtyFromStep: null,
      stepWarnings: {},
    }),
  resetImage: () =>
    set({
      image: null,
      imageElement: null,
      roi: null,
      calibration: defaultCalibration,
      particles: [],
      selectedParticleId: null,
      maskDataUrl: null,
      overlayDataUrl: null,
      undoStack: [],
      redoStack: [],
      currentStep: 'upload',
      completedSteps: {},
      dirtyFromStep: null,
      stepWarnings: {},
    }),
  goToStep: (currentStep) =>
    set((state) => ({
      currentStep,
      toolMode:
        currentStep === 'calibration'
          ? 'calibrate'
          : currentStep === 'roi'
            ? 'roi'
            : currentStep === 'review'
              ? 'select'
              : state.toolMode,
      displayMode:
        currentStep === 'processing'
          ? 'mask'
          : currentStep === 'detection' || currentStep === 'review'
            ? 'overlay'
            : state.displayMode,
    })),
  completeStep: (step) =>
    set((state) => ({
      completedSteps: { ...state.completedSteps, [step]: true },
      stepWarnings: { ...state.stepWarnings, [step]: undefined },
    })),
  setDisplayMode: (displayMode) => set({ displayMode }),
  setToolMode: (toolMode) => set({ toolMode }),
  setROI: (roi) =>
    set((state) => ({
      roi,
      maskDataUrl: null,
      overlayDataUrl: null,
      particles: [],
      selectedParticleId: null,
      undoStack: [],
      redoStack: [],
      completedSteps: { ...state.completedSteps, roi: Boolean(roi), processing: false, detection: false, review: false },
      dirtyFromStep: 'roi',
      stepWarnings: {
        ...state.stepWarnings,
        processing: roi ? 'ROI 已變更，請重新確認 threshold。' : undefined,
        detection: undefined,
        review: undefined,
      },
    })),
  setCalibration: (calibration) =>
    set((state) => ({
      calibration,
      particles: state.particles.map((particle) => ({
        ...particle,
        areaActual: calibration.pixelSize ? particle.areaPx2 * calibration.pixelSize * calibration.pixelSize : null,
        equivalentDiameterActual: calibration.pixelSize
          ? particle.equivalentDiameterPx * calibration.pixelSize
          : null,
      })),
      completedSteps: { ...state.completedSteps, calibration: Boolean(calibration.pixelSize) },
      stepWarnings: {
        ...state.stepWarnings,
        calibration: undefined,
        review: state.particles.length ? '比例尺已更新，實際尺寸已重新換算。' : undefined,
      },
    })),
  setSettings: (settings) =>
    set((state) => {
      const invalidatesDetection = Object.keys(settings).some((key) => key !== 'overlayOpacity');
      if (!invalidatesDetection) {
        return { settings: { ...state.settings, ...settings } };
      }
      return {
        settings: { ...state.settings, ...settings },
        maskDataUrl: null,
        overlayDataUrl: null,
        particles: [],
        selectedParticleId: null,
        undoStack: [],
        redoStack: [],
        completedSteps: { ...state.completedSteps, processing: false, detection: false, review: false },
        dirtyFromStep: 'processing',
        stepWarnings: {
          ...state.stepWarnings,
          processing: '影像處理設定已變更，請重新套用並辨識粒子。',
          detection: undefined,
          review: undefined,
        },
      };
    }),
  setAnalysisResult: (particles, maskDataUrl, overlayDataUrl) =>
    set((state) => {
      const excluded = new Set(state.particles.filter((particle) => particle.excluded).map((particle) => particle.id));
      return {
        particles: particles.map((particle) => ({ ...particle, excluded: excluded.has(particle.id) })),
        maskDataUrl,
        overlayDataUrl,
        selectedParticleId: null,
        undoStack: [],
        redoStack: [],
        completedSteps: { ...state.completedSteps, processing: true, detection: true },
        dirtyFromStep: null,
        stepWarnings: { ...state.stepWarnings, processing: undefined, detection: undefined },
      };
    }),
  setSelectedParticleId: (selectedParticleId) => set({ selectedParticleId }),
  toggleParticleExcluded: (id) =>
    set((state) => ({
      particles: state.particles.map((particle) =>
        particle.id === id ? { ...particle, excluded: !particle.excluded } : particle,
      ),
      selectedParticleId: id,
      undoStack: pushHistory(state.particles, state.undoStack),
      redoStack: [],
    })),
  undo: () =>
    set((state) => {
      const [previous, ...rest] = state.undoStack;
      if (!previous) return state;
      return {
        particles: previous,
        undoStack: rest,
        redoStack: pushHistory(state.particles, state.redoStack),
      };
    }),
  redo: () =>
    set((state) => {
      const [next, ...rest] = state.redoStack;
      if (!next) return state;
      return {
        particles: next,
        redoStack: rest,
        undoStack: pushHistory(state.particles, state.undoStack),
      };
    }),
  setShowExcluded: (showExcluded) => set({ showExcluded }),
  setSort: (key) =>
    set((state) => ({
      sortKey: key,
      sortDirection: state.sortKey === key && state.sortDirection === 'asc' ? 'desc' : 'asc',
    })),
}));
