export type Unit = 'nm' | 'µm' | 'mm';
export type Polarity = 'bright' | 'dark';
export type DisplayMode = 'original' | 'mask' | 'overlay';
export type ToolMode = 'select' | 'calibrate' | 'roi' | 'pan' | 'erase' | 'boxErase';
export type SortKey = 'id' | 'area' | 'diameter';
export type SortDirection = 'asc' | 'desc';
export type WorkflowStep = 'upload' | 'calibration' | 'roi' | 'processing' | 'review';
export type StepStatus = 'locked' | 'available' | 'active' | 'complete' | 'warning';

export interface Point {
  x: number;
  y: number;
}

export interface ROI {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Calibration {
  pixelLength: number;
  actualLength: number;
  unit: Unit;
  pixelSize: number;
  line: [Point, Point] | null;
}

export interface ProcessingSettings {
  threshold: number;
  polarity: Polarity;
  overlayOpacity: number;
  blurKernel: 0 | 3 | 5 | 7;
  openingIterations: number;
  closingIterations: number;
}

export interface Particle {
  id: number;
  areaPx2: number;
  areaActual: number | null;
  diameterPx: number;
  diameterActual: number | null;
  centroidX: number;
  centroidY: number;
  excluded: boolean;
  contour: Point[];
}

export interface DiameterStats {
  count: number;
  min: number | null;
  max: number | null;
  range: number | null;
  mean: number | null;
  standardDeviation: number | null;
  unit: Unit;
}

export interface HistogramBin {
  id: string;
  start: number;
  end: number;
  count: number;
  percentage: number;
  particleIds: number[];
}

export interface ImageInfo {
  fileName: string;
  width: number;
  height: number;
  url: string;
}
