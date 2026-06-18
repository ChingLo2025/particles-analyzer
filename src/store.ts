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
  setImage: (image: ImageInfo, imageElement: HTMLImageElement) => void;
  resetImage: () => void;
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
  setImage: (image, imageElement) =>
    set({
      image,
      imageElement,
      displayMode: 'original',
      toolMode: 'select',
      roi: null,
      calibration: defaultCalibration,
      settings: defaultSettings,
      particles: [],
      selectedParticleId: null,
      maskDataUrl: null,
      overlayDataUrl: null,
      undoStack: [],
      redoStack: [],
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
    }),
  setDisplayMode: (displayMode) => set({ displayMode }),
  setToolMode: (toolMode) => set({ toolMode }),
  setROI: (roi) => set({ roi }),
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
    })),
  setSettings: (settings) => set((state) => ({ settings: { ...state.settings, ...settings } })),
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
