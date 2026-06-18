export type Unit = 'nm' | 'µm' | 'mm';
export type Polarity = 'bright' | 'dark';
export type DisplayMode = 'original' | 'mask' | 'overlay';
export type ToolMode = 'select' | 'calibrate' | 'roi' | 'pan';
export type SortKey = 'id' | 'area' | 'diameter';
export type SortDirection = 'asc' | 'desc';

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
  equivalentDiameterPx: number;
  equivalentDiameterActual: number | null;
  centroidX: number;
  centroidY: number;
  excluded: boolean;
  contour: Point[];
}

export interface ImageInfo {
  fileName: string;
  width: number;
  height: number;
  url: string;
}
