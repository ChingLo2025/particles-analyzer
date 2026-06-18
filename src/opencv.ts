import cv from '@techstark/opencv-js';
import type { Calibration, Particle, Point, ProcessingSettings, ROI } from './types';

export interface AnalysisResult {
  particles: Particle[];
  maskDataUrl: string;
  overlayDataUrl: string;
}

const clampROI = (roi: ROI | null, width: number, height: number): ROI => {
  if (!roi) return { x: 0, y: 0, width, height };
  const x = Math.max(0, Math.min(width, roi.x));
  const y = Math.max(0, Math.min(height, roi.y));
  const right = Math.max(x, Math.min(width, roi.x + roi.width));
  const bottom = Math.max(y, Math.min(height, roi.y + roi.height));
  return { x, y, width: right - x, height: bottom - y };
};

const contourToPoints = (contour: InstanceType<typeof cv.Mat>, offsetX: number, offsetY: number): Point[] => {
  const points: Point[] = [];
  for (let i = 0; i < contour.rows; i += 1) {
    points.push({
      x: contour.intPtr(i, 0)[0] + offsetX,
      y: contour.intPtr(i, 0)[1] + offsetY,
    });
  }
  return points;
};

const makeActualValues = (areaPx2: number, diameterPx: number, calibration: Calibration) => {
  if (!calibration.pixelSize) {
    return { areaActual: null, equivalentDiameterActual: null };
  }
  return {
    areaActual: areaPx2 * calibration.pixelSize * calibration.pixelSize,
    equivalentDiameterActual: diameterPx * calibration.pixelSize,
  };
};

export const analyzeImage = (
  imageElement: HTMLImageElement,
  roi: ROI | null,
  settings: ProcessingSettings,
  calibration: Calibration,
): AnalysisResult => {
  const src = cv.imread(imageElement);
  const gray = new cv.Mat();
  const processed = new cv.Mat();
  const masked = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC1);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const displayMask = new cv.Mat();
  const overlay = src.clone();
  const roiRect = clampROI(roi, src.cols, src.rows);
  const rect = new cv.Rect(Math.round(roiRect.x), Math.round(roiRect.y), Math.round(roiRect.width), Math.round(roiRect.height));

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const grayROI = gray.roi(rect);
    const workROI = processed;
    grayROI.copyTo(workROI);
    grayROI.delete();

    if (settings.blurKernel > 0) {
      cv.GaussianBlur(workROI, workROI, new cv.Size(settings.blurKernel, settings.blurKernel), 0, 0, cv.BORDER_DEFAULT);
    }

    const thresholdType = settings.polarity === 'bright' ? cv.THRESH_BINARY : cv.THRESH_BINARY_INV;
    cv.threshold(workROI, workROI, settings.threshold, 255, thresholdType);

    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    if (settings.openingIterations > 0) {
      cv.morphologyEx(workROI, workROI, cv.MORPH_OPEN, kernel, new cv.Point(-1, -1), settings.openingIterations);
    }
    if (settings.closingIterations > 0) {
      cv.morphologyEx(workROI, workROI, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), settings.closingIterations);
    }
    kernel.delete();

    const maskedROI = masked.roi(rect);
    workROI.copyTo(maskedROI);
    maskedROI.delete();

    cv.findContours(workROI, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const particles: Particle[] = [];
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      const areaPx2 = cv.contourArea(contour);
      if (areaPx2 < 4) {
        contour.delete();
        continue;
      }
      const moments = cv.moments(contour);
      if (!moments.m00) {
        contour.delete();
        continue;
      }
      const equivalentDiameterPx = 2 * Math.sqrt(areaPx2 / Math.PI);
      const actual = makeActualValues(areaPx2, equivalentDiameterPx, calibration);
      particles.push({
        id: particles.length + 1,
        areaPx2,
        areaActual: actual.areaActual,
        equivalentDiameterPx,
        equivalentDiameterActual: actual.equivalentDiameterActual,
        centroidX: moments.m10 / moments.m00 + rect.x,
        centroidY: moments.m01 / moments.m00 + rect.y,
        excluded: false,
        contour: contourToPoints(contour, rect.x, rect.y),
      });
      contour.delete();
    }

    cv.cvtColor(masked, displayMask, cv.COLOR_GRAY2RGBA);
    const maskCanvas = document.createElement('canvas');
    cv.imshow(maskCanvas, displayMask);

    particles.forEach((particle) => {
      for (let i = 0; i < particle.contour.length; i += 1) {
        const current = particle.contour[i];
        const next = particle.contour[(i + 1) % particle.contour.length];
        cv.line(overlay, new cv.Point(current.x, current.y), new cv.Point(next.x, next.y), new cv.Scalar(28, 211, 151, 255), 2);
      }
    });
    const overlayCanvas = document.createElement('canvas');
    cv.imshow(overlayCanvas, overlay);

    return {
      particles,
      maskDataUrl: maskCanvas.toDataURL('image/png'),
      overlayDataUrl: overlayCanvas.toDataURL('image/png'),
    };
  } finally {
    src.delete();
    gray.delete();
    processed.delete();
    masked.delete();
    contours.delete();
    hierarchy.delete();
    displayMask.delete();
    overlay.delete();
  }
};
