import { ChangeEvent, PointerEvent, ReactNode, useEffect, useMemo, useRef, useState, WheelEvent } from 'react';
import {
  AlertCircle,
  BoxSelect,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Eraser,
  FileDown,
  ImageUp,
  Maximize,
  MousePointer2,
  Move,
  Redo2,
  RotateCcw,
  Ruler,
  Scan,
  Undo2,
} from 'lucide-react';
import { downloadCSV, downloadOverlayPNG } from './exporters';
import { analyzeImage } from './opencv';
import { useAnalyzerStore } from './store';
import type {
  DiameterStats,
  DisplayMode,
  HistogramBin,
  Particle,
  Point,
  ROI,
  SortKey,
  StepStatus,
  ToolMode,
  Unit,
  WorkflowStep,
} from './types';

const displayModes: Array<{ id: DisplayMode; label: string }> = [
  { id: 'original', label: '原圖' },
  { id: 'mask', label: '二值遮罩' },
  { id: 'overlay', label: '邊界標記' },
];

const toolModes: Array<{ id: ToolMode; label: string; icon: typeof MousePointer2 }> = [
  { id: 'select', label: '選取粒子', icon: MousePointer2 },
  { id: 'calibrate', label: '校正線', icon: Ruler },
  { id: 'roi', label: 'ROI', icon: Scan },
  { id: 'pan', label: '平移', icon: Move },
  { id: 'erase', label: '橡皮擦', icon: Eraser },
  { id: 'boxErase', label: '框選橡皮擦', icon: BoxSelect },
];

const units: Unit[] = ['nm', 'µm', 'mm'];

const workflowSteps: Array<{ id: WorkflowStep; label: string }> = [
  { id: 'upload', label: '上傳影像' },
  { id: 'calibration', label: '比例尺校正' },
  { id: 'roi', label: 'ROI 抓取' },
  { id: 'processing', label: '影像處理' },
  { id: 'review', label: '手動刪除' },
];

const helpText = {
  actualLength: '輸入你在影像上拖出的比例尺實際長度。數值越高，每個 pixel 換算出的實際尺寸越大；數值越低，量測結果會等比例變小。',
  unit: '選擇比例尺標示的單位，會套用到所有實際面積、實際粒徑與 histogram。單位選錯時，數值大小不會自動換算。',
  threshold: '決定哪些像素被視為粒子。數值越高，亮粒子模式會保留更亮的區域、通常粒子變少；數值越低會納入更多區域，也更容易吃進背景雜訊。',
  polarity: '選擇粒子相對背景是偏亮或偏暗。選錯時，threshold 會抓到背景而不是粒子，辨識結果通常會大量錯誤。',
  blur: '分析前先平滑影像。數值越高越能降低雜訊，但小粒子邊界會被抹平；數值越低保留細節，但雜訊也更容易被誤判成粒子。',
  opening: '先侵蝕再膨脹，用來移除小雜點。數值越高越能清掉孤立噪點，但小粒子也可能被刪掉；數值越低較保留小特徵。',
  closing: '先膨脹再侵蝕，用來補洞與連接斷裂邊界。數值越高輪廓更完整，但靠近的粒子可能被黏在一起；數值越低較不會合併粒子。',
  showExcluded: '控制畫面是否顯示已排除粒子。開啟方便檢查刪除紀錄；關閉則讓有效粒子與統計分布更清楚。',
  overlayOpacity: '調整邊界標記疊在原圖上的透明度。數值越高標記越明顯；數值越低越容易檢查原始影像細節。',
  binWidth: '控制 histogram 每一格代表的粒徑寬度。寬度越大分布越平滑但細節較少；寬度越小解析度較高，但分布可能變得零碎。',
};

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const normalizeRect = (start: Point, end: Point): ROI => ({
  x: Math.min(start.x, end.x),
  y: Math.min(start.y, end.y),
  width: Math.abs(start.x - end.x),
  height: Math.abs(start.y - end.y),
});

const pointInPolygon = (point: Point, polygon: Point[]) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
};

const pointInRect = (point: Point, rect: ROI) =>
  point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;

const rectCorners = (rect: ROI): Point[] => [
  { x: rect.x, y: rect.y },
  { x: rect.x + rect.width, y: rect.y },
  { x: rect.x + rect.width, y: rect.y + rect.height },
  { x: rect.x, y: rect.y + rect.height },
];

const particleIntersectsRect = (particle: Particle, rect: ROI) =>
  particle.contour.some((point) => pointInRect(point, rect)) ||
  pointInRect({ x: particle.centroidX, y: particle.centroidY }, rect) ||
  rectCorners(rect).some((corner) => pointInPolygon(corner, particle.contour));

const distanceToSegment = (point: Point, start: Point, end: Point) => {
  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  if (lengthSquared === 0) return distance(point, start);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / lengthSquared));
  const projection = {
    x: start.x + t * (end.x - start.x),
    y: start.y + t * (end.y - start.y),
  };
  return distance(point, projection);
};

const particleIntersectsErasePath = (particle: Particle, path: Point[], radius: number) => {
  if (path.some((point) => pointInPolygon(point, particle.contour))) return true;
  return particle.contour.some((contourPoint) => {
    if (path.some((point) => distance(contourPoint, point) <= radius)) return true;
    for (let index = 1; index < path.length; index += 1) {
      if (distanceToSegment(contourPoint, path[index - 1], path[index]) <= radius) return true;
    }
    return false;
  });
};

type ParticleWithActualDiameter = Particle & { diameterActual: number };

const formatNumber = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 10) return value.toFixed(2);
  if (abs >= 1) return value.toFixed(3);
  return value.toPrecision(3);
};

const formatActual = (value: number | null, unit: Unit) => (value === null ? '--' : `${formatNumber(value)} ${unit}`);

const niceBinWidth = (range: number) => {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const rough = range / 12;
  const exponent = Math.floor(Math.log10(rough));
  const fraction = rough / 10 ** exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * 10 ** exponent;
};

export const App = () => {
  const {
    image,
    imageElement,
    displayMode,
    toolMode,
    roi,
    calibration,
    settings,
    particles,
    selectedParticleId,
    showExcluded,
    maskDataUrl,
    overlayDataUrl,
    sortKey,
    sortDirection,
    undoStack,
    redoStack,
    currentStep,
    completedSteps,
    stepWarnings,
    setImage,
    setDisplayMode,
    setToolMode,
    goToStep,
    completeStep,
    setROI,
    setCalibration,
    setSettings,
    setAnalysisResult,
    setSelectedParticleId,
    excludeParticles,
    undo,
    redo,
    setShowExcluded,
    setSort,
  } = useAnalyzerStore();

  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [draftPoint, setDraftPoint] = useState<Point | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [actualLength, setActualLength] = useState('1');
  const [unit, setUnit] = useState<Unit>('µm');
  const [status, setStatus] = useState('請上傳 SEM 影像開始分析。');
  const [histogramBinWidthActual, setHistogramBinWidthActual] = useState(0);
  const [hoveredBinId, setHoveredBinId] = useState<string | null>(null);
  const [highlightedParticleIds, setHighlightedParticleIds] = useState<number[]>([]);
  const [isPreviewUpdating, setIsPreviewUpdating] = useState(false);
  const [erasePath, setErasePath] = useState<Point[]>([]);
  const analysisRequestIdRef = useRef(0);

  const visibleImageUrl = useMemo(() => {
    if (displayMode === 'mask') return maskDataUrl ?? image?.url ?? '';
    return image?.url ?? '';
  }, [displayMode, image?.url, maskDataUrl]);

  const sortedParticles = useMemo(() => {
    const multiplier = sortDirection === 'asc' ? 1 : -1;
    const keyValue = (particle: Particle) => {
      if (sortKey === 'area') return particle.areaPx2;
      if (sortKey === 'diameter') return particle.diameterPx;
      return particle.id;
    };
    return [...particles].sort((a, b) => (keyValue(a) - keyValue(b)) * multiplier);
  }, [particles, sortDirection, sortKey]);

  const summary = useMemo(() => {
    const valid = particles.filter((particle) => !particle.excluded);
    return { total: particles.length, valid: valid.length };
  }, [particles]);

  const excludedCount = particles.length - summary.valid;

  const validDiameterParticles = useMemo(
    () =>
      particles.filter(
        (particle): particle is ParticleWithActualDiameter =>
          !particle.excluded &&
          particle.diameterActual !== null &&
          Number.isFinite(particle.diameterActual),
      ),
    [particles],
  );

  const diameterStats = useMemo<DiameterStats>(() => {
    if (!validDiameterParticles.length) {
      return {
        count: 0,
        min: null,
        max: null,
        range: null,
        mean: null,
        standardDeviation: null,
        unit: calibration.unit,
      };
    }

    const values = validDiameterParticles.map((particle) => particle.diameterActual);
    const count = values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean = values.reduce((total, value) => total + value, 0) / count;
    const variance =
      count > 1 ? values.reduce((total, value) => total + (value - mean) ** 2, 0) / (count - 1) : null;

    return {
      count,
      min,
      max,
      range: max - min,
      mean,
      standardDeviation: variance === null ? null : Math.sqrt(variance),
      unit: calibration.unit,
    };
  }, [calibration.unit, validDiameterParticles]);

  const binWidthBounds = useMemo(() => {
    const range = diameterStats.range ?? 0;
    const fallback = diameterStats.max ?? 1;
    const span = range > 0 ? range : Math.max(fallback, 1);
    const min = span / 50;
    const max = span;
    const step = Math.max(span / 500, min / 10);
    const auto = Math.min(max, Math.max(min, niceBinWidth(span)));
    return { min, max, step, auto };
  }, [diameterStats.max, diameterStats.range]);

  const activeBinWidth = histogramBinWidthActual > 0 ? histogramBinWidthActual : binWidthBounds.auto;

  const histogramBins = useMemo<HistogramBin[]>(() => {
    if (!validDiameterParticles.length || diameterStats.min === null || diameterStats.max === null || activeBinWidth <= 0) {
      return [];
    }

    if (diameterStats.min === diameterStats.max) {
      const halfWidth = activeBinWidth / 2;
      return [
        {
          id: 'bin-0',
          start: Math.max(0, diameterStats.min - halfWidth),
          end: diameterStats.max + halfWidth,
          count: validDiameterParticles.length,
          percentage: 100,
          particleIds: validDiameterParticles.map((particle) => particle.id),
        },
      ];
    }

    const binCount = Math.max(1, Math.ceil((diameterStats.max - diameterStats.min) / activeBinWidth));
    const bins: HistogramBin[] = Array.from({ length: binCount }, (_, index) => ({
      id: `bin-${index}`,
      start: diameterStats.min! + index * activeBinWidth,
      end: diameterStats.min! + (index + 1) * activeBinWidth,
      count: 0,
      percentage: 0,
      particleIds: [],
    }));

    validDiameterParticles.forEach((particle) => {
      const index = Math.min(
        binCount - 1,
        Math.max(0, Math.floor((particle.diameterActual - diameterStats.min!) / activeBinWidth)),
      );
      bins[index].count += 1;
      bins[index].particleIds.push(particle.id);
    });

    return bins.map((bin, index) => ({
      ...bin,
      end: index === bins.length - 1 ? diameterStats.max! : bin.end,
      percentage: diameterStats.count ? (bin.count / diameterStats.count) * 100 : 0,
    }));
  }, [activeBinWidth, diameterStats.count, diameterStats.max, diameterStats.min, validDiameterParticles]);

  const hoveredBin = histogramBins.find((bin) => bin.id === hoveredBinId) ?? null;
  const highlightedParticleIdSet = useMemo(() => new Set(highlightedParticleIds), [highlightedParticleIds]);

  const stageToolModes = useMemo(() => {
    const idsByStep: Record<WorkflowStep, ToolMode[]> = {
      upload: [],
      calibration: ['calibrate', 'pan'],
      roi: ['roi', 'pan'],
      processing: ['select', 'pan', 'erase', 'boxErase'],
      review: ['select', 'erase', 'boxErase', 'pan'],
    };
    const ids = idsByStep[currentStep];
    return ids.map((id) => toolModes.find((mode) => mode.id === id)).filter((mode): mode is (typeof toolModes)[number] => Boolean(mode));
  }, [currentStep]);
  const maxBinCount = Math.max(1, ...histogramBins.map((bin) => bin.count));

  useEffect(() => {
    if (!diameterStats.count) {
      setHistogramBinWidthActual(0);
      return;
    }
    setHistogramBinWidthActual((current) =>
      current >= binWidthBounds.min && current <= binWidthBounds.max ? current : binWidthBounds.auto,
    );
  }, [binWidthBounds.auto, binWidthBounds.max, binWidthBounds.min, diameterStats.count]);

  useEffect(() => {
    setHighlightedParticleIds([]);
  }, [histogramBinWidthActual, particles]);

  const toggleHistogramBin = (bin: HistogramBin) => {
    if (!bin.count) return;
    const nextIds = bin.particleIds;
    const isSameSelection =
      highlightedParticleIds.length === nextIds.length && nextIds.every((id) => highlightedParticleIdSet.has(id));
    setHighlightedParticleIds(isSameSelection ? [] : nextIds);
    setSelectedParticleId(null);
  };

  const canEnterStep = (step: WorkflowStep) => {
    if (step === 'upload') return true;
    if (step === 'calibration') return Boolean(imageElement);
    if (step === 'roi') return Boolean(imageElement && calibration.pixelSize);
    if (step === 'processing') return Boolean(imageElement && calibration.pixelSize && roi);
    return particles.length > 0;
  };

  const getStepStatus = (step: WorkflowStep): StepStatus => {
    if (step === currentStep) return 'active';
    if (!canEnterStep(step)) return 'locked';
    if (stepWarnings[step]) return 'warning';
    if (
      completedSteps[step] ||
      (step === 'upload' && imageElement) ||
      (step === 'calibration' && calibration.pixelSize) ||
      (step === 'roi' && roi) ||
      (step === 'processing' && particles.length > 0)
    ) {
      return 'complete';
    }
    return 'available';
  };

  const activeStepIndex = workflowSteps.findIndex((step) => step.id === currentStep);
  const previousStep = workflowSteps[Math.max(0, activeStepIndex - 1)]?.id;
  const nextStep = workflowSteps[Math.min(workflowSteps.length - 1, activeStepIndex + 1)]?.id;

  const currentStepValid = () => {
    if (currentStep === 'upload') return Boolean(imageElement);
    if (currentStep === 'calibration') return Boolean(calibration.pixelSize);
    if (currentStep === 'roi') return Boolean(roi);
    if (currentStep === 'processing') return particles.length > 0 && !isPreviewUpdating;
    return particles.length > 0;
  };

  const goNext = () => {
    if (!currentStepValid() || !nextStep) return;
    completeStep(currentStep);
    goToStep(nextStep);
  };

  const goBack = () => {
    if (previousStep) goToStep(previousStep);
  };

  const screenToImage = (clientX: number, clientY: number): Point => {
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: (clientX - bounds.left - offset.x) / scale,
      y: (clientY - bounds.top - offset.y) / scale,
    };
  };

  const fitToScreen = () => {
    if (!image || !stageRef.current) return;
    const bounds = stageRef.current.getBoundingClientRect();
    const nextScale = Math.min(bounds.width / image.width, bounds.height / image.height) * 0.92;
    setScale(Number.isFinite(nextScale) && nextScale > 0 ? nextScale : 1);
    setOffset({
      x: (bounds.width - image.width * nextScale) / 2,
      y: (bounds.height - image.height * nextScale) / 2,
    });
  };

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImage(
        {
          fileName: file.name,
          width: img.naturalWidth,
          height: img.naturalHeight,
          url,
        },
        img,
      );
      setStatus('影像已載入，請校正比例尺或直接設定 ROI 與 threshold。');
      setTimeout(fitToScreen, 50);
    };
    img.src = url;
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleFile(file);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!image) return;
    const point = screenToImage(event.clientX, event.clientY);
    setDragStart(toolMode === 'pan' ? { x: event.clientX - offset.x, y: event.clientY - offset.y } : point);
    setDraftPoint(point);
    setErasePath(toolMode === 'erase' ? [point] : []);
    setIsDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !dragStart) return;
    if (toolMode === 'pan') {
      setOffset({ x: event.clientX - dragStart.x, y: event.clientY - dragStart.y });
      return;
    }
    const point = screenToImage(event.clientX, event.clientY);
    setDraftPoint(point);
    if (toolMode === 'erase') {
      setErasePath((path) => [...path, point]);
    }
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!image || !dragStart) return;
    const point = screenToImage(event.clientX, event.clientY);
    if (toolMode === 'calibrate') {
      const pixelLength = distance(dragStart, point);
      const parsedLength = Number(actualLength);
      if (pixelLength > 1 && parsedLength > 0) {
        setCalibration({
          pixelLength,
          actualLength: parsedLength,
          unit,
          pixelSize: parsedLength / pixelLength,
          line: [dragStart, point],
        });
        completeStep('calibration');
        setStatus(`校正完成：1 px = ${(parsedLength / pixelLength).toFixed(6)} ${unit}`);
      }
    } else if (toolMode === 'roi') {
      const nextROI = normalizeRect(dragStart, point);
      if (nextROI.width > 4 && nextROI.height > 4) {
        setROI(nextROI);
        completeStep('roi');
        setStatus('ROI 已設定。');
      }
    } else if (toolMode === 'boxErase') {
      const eraseRect = normalizeRect(dragStart, point);
      if (eraseRect.width > 4 && eraseRect.height > 4) {
        const ids = particles
          .filter((particle) => !particle.excluded && particleIntersectsRect(particle, eraseRect))
          .map((particle) => particle.id);
        excludeParticles(ids);
        setStatus(ids.length ? `已排除 ${ids.length} 顆粒子。` : '框選範圍內沒有可排除粒子。');
      }
    } else if (toolMode === 'erase') {
      const path = erasePath.length ? [...erasePath, point] : [point];
      const radius = Math.max(3, 14 / scale);
      const ids = particles
        .filter((particle) => !particle.excluded && particleIntersectsErasePath(particle, path, radius))
        .map((particle) => particle.id);
      excludeParticles(ids);
      setStatus(ids.length ? `已排除 ${ids.length} 顆粒子。` : '橡皮擦路徑沒有碰到可排除粒子。');
    } else if (toolMode === 'select') {
      const particle = [...particles]
        .reverse()
        .find((candidate) => (showExcluded || !candidate.excluded) && pointInPolygon(point, candidate.contour));
      if (particle) {
        setSelectedParticleId(particle.id);
        setStatus(`已選取粒子 ${particle.id}。`);
      }
    }
    setIsDragging(false);
    setDragStart(null);
    setDraftPoint(null);
    setErasePath([]);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!image) return;
    event.preventDefault();
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const before = screenToImage(event.clientX, event.clientY);
    const zoom = event.deltaY < 0 ? 1.12 : 0.88;
    const nextScale = Math.min(12, Math.max(0.05, scale * zoom));
    setScale(nextScale);
    setOffset({
      x: event.clientX - bounds.left - before.x * nextScale,
      y: event.clientY - bounds.top - before.y * nextScale,
    });
  };

  useEffect(() => {
    const onResize = () => fitToScreen();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [image]);

  useEffect(() => {
    if (currentStep !== 'processing' || !imageElement || !roi || !calibration.pixelSize) {
      setIsPreviewUpdating(false);
      return undefined;
    }

    const requestId = analysisRequestIdRef.current + 1;
    analysisRequestIdRef.current = requestId;
    setIsPreviewUpdating(true);

    const timeoutId = window.setTimeout(() => {
      setStatus('即時辨識預覽更新中...');
      requestAnimationFrame(() => {
        if (analysisRequestIdRef.current !== requestId) return;
        try {
          const result = analyzeImage(imageElement, roi, settings, calibration);
          if (analysisRequestIdRef.current !== requestId) return;
          setAnalysisResult(result.particles, result.maskDataUrl, result.overlayDataUrl, { preserveExcluded: false });
          setDisplayMode('overlay');
          completeStep('processing');
          setIsPreviewUpdating(false);
          setStatus(`即時預覽：偵測到 ${result.particles.length} 顆粒子。`);
        } catch (error) {
          if (analysisRequestIdRef.current !== requestId) return;
          setIsPreviewUpdating(false);
          setStatus(error instanceof Error ? error.message : 'OpenCV 分析失敗。');
        }
      });
    }, 180);

    return () => {
      window.clearTimeout(timeoutId);
      analysisRequestIdRef.current += 1;
    };
  }, [calibration, completeStep, currentStep, imageElement, roi, setAnalysisResult, setDisplayMode, settings]);

  const draftROI = dragStart && draftPoint && toolMode === 'roi' ? normalizeRect(dragStart, draftPoint) : null;
  const draftEraseRect = dragStart && draftPoint && toolMode === 'boxErase' ? normalizeRect(dragStart, draftPoint) : null;
  const draftLine = dragStart && draftPoint && toolMode === 'calibrate' ? [dragStart, draftPoint] : calibration.line;
  const activeStepLabel = workflowSteps.find((step) => step.id === currentStep)?.label ?? '';
  const isReviewStep = currentStep === 'review';

  const stepPanel = (
    <section className="panel step-panel">
      <div className="step-panel-heading">
        <span>目前階段</span>
        <h2>{activeStepLabel}</h2>
        {stepWarnings[currentStep] && <p className="warning-text">{stepWarnings[currentStep]}</p>}
      </div>

      {currentStep === 'upload' && (
        <>
          <label
            className="dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (file) handleFile(file);
            }}
          >
            <ImageUp size={22} />
            <span>拖曳或選擇 SEM 影像</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onFileChange} />
          </label>
          {image && (
            <div className="image-meta">
              <strong>{image.fileName}</strong>
              <span>
                {image.width} × {image.height}px
              </span>
            </div>
          )}
        </>
      )}

      {currentStep === 'calibration' && (
        <>
          <p className="step-hint">在影像上拖曳一條已知長度的比例尺線，輸入實際長度後即可進入 ROI。</p>
          <div className="form-row">
            <label>
              <ParameterLabel help={helpText.actualLength}>實際長度</ParameterLabel>
              <input value={actualLength} onChange={(event) => setActualLength(event.target.value)} inputMode="decimal" />
            </label>
            <label>
              <ParameterLabel help={helpText.unit}>單位</ParameterLabel>
              <select value={unit} onChange={(event) => setUnit(event.target.value as Unit)}>
                {units.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="metric">
            {calibration.pixelSize ? `1 px = ${calibration.pixelSize.toFixed(6)} ${calibration.unit}` : '尚未校正'}
          </p>
        </>
      )}

      {currentStep === 'roi' && (
        <>
          <p className="step-hint">在影像上拖曳矩形 ROI。若要重新抓取，直接再畫一次即可。</p>
          <div className="button-row">
            <button type="button" onClick={() => setToolMode('roi')} className={toolMode === 'roi' ? 'active' : ''}>
              <Scan size={16} />
              ROI 工具
            </button>
            <button type="button" disabled={!roi} onClick={() => setROI(null)}>
              清除 ROI
            </button>
          </div>
          <p className="metric">
            {roi ? `ROI：${Math.round(roi.width)} × ${Math.round(roi.height)} px` : '尚未設定 ROI'}
          </p>
        </>
      )}

      {currentStep === 'processing' && (
        <>
          <p className="step-hint">調整 threshold、粒子明暗與 morphology，右側影像會自動更新粒子邊界。預覽穩定後即可進入手動刪除。</p>
          <label>
            <ParameterLabel help={helpText.threshold}>Threshold：{settings.threshold}</ParameterLabel>
            <input
              type="range"
              min="0"
              max="255"
              value={settings.threshold}
              onChange={(event) => setSettings({ threshold: Number(event.target.value) })}
            />
          </label>
          <ParameterLabel help={helpText.polarity}>粒子極性</ParameterLabel>
          <div className="segmented">
            <button
              type="button"
              className={settings.polarity === 'bright' ? 'active' : ''}
              onClick={() => setSettings({ polarity: 'bright' })}
            >
              亮粒子
            </button>
            <button
              type="button"
              className={settings.polarity === 'dark' ? 'active' : ''}
              onClick={() => setSettings({ polarity: 'dark' })}
            >
              暗粒子
            </button>
          </div>
          <label>
            <ParameterLabel help={helpText.blur}>Gaussian blur</ParameterLabel>
            <select
              value={settings.blurKernel}
              onChange={(event) => setSettings({ blurKernel: Number(event.target.value) as 0 | 3 | 5 | 7 })}
            >
              {[0, 3, 5, 7].map((item) => (
                <option key={item} value={item}>
                  {item === 0 ? 'None' : `${item}px`}
                </option>
              ))}
            </select>
          </label>
          <label>
            <ParameterLabel help={helpText.opening}>Opening：{settings.openingIterations}</ParameterLabel>
            <input
              type="range"
              min="0"
              max="3"
              value={settings.openingIterations}
              onChange={(event) => setSettings({ openingIterations: Number(event.target.value) })}
            />
          </label>
          <label>
            <ParameterLabel help={helpText.closing}>Closing：{settings.closingIterations}</ParameterLabel>
            <input
              type="range"
              min="0"
              max="3"
              value={settings.closingIterations}
              onChange={(event) => setSettings({ closingIterations: Number(event.target.value) })}
            />
          </label>
          <p className="metric">
            {isPreviewUpdating
              ? '即時預覽更新中...'
              : particles.length
                ? `目前偵測到 ${particles.length} 顆粒子`
                : '尚未偵測到粒子'}
          </p>
        </>
      )}

      {currentStep === 'review' && (
        <>
          <p className="step-hint">點擊影像上的粒子可排除，再次點擊可恢復。表格列可同步高亮粒子。</p>
          <div className="button-row">
            <button type="button" disabled={!undoStack.length} onClick={undo} title="Undo">
              <Undo2 size={16} />
              Undo
            </button>
            <button type="button" disabled={!redoStack.length} onClick={redo} title="Redo">
              <Redo2 size={16} />
              Redo
            </button>
          </div>
          <label className="checkbox-line">
            <input type="checkbox" checked={showExcluded} onChange={(event) => setShowExcluded(event.target.checked)} />
            <ParameterLabel help={helpText.showExcluded}>顯示已排除粒子</ParameterLabel>
          </label>
          <div className="button-row">
            <button type="button" disabled={!particles.length} onClick={() => downloadCSV(particles)}>
              <FileDown size={16} />
              CSV
            </button>
            <button
              type="button"
              disabled={!imageElement || !particles.length}
              onClick={() => imageElement && downloadOverlayPNG(imageElement, particles, calibration)}
            >
              <Download size={16} />
              PNG
            </button>
          </div>
        </>
      )}

      <div className="step-actions">
        <button type="button" disabled={currentStep === 'upload'} onClick={goBack}>
          <ChevronLeft size={16} />
          上一步
        </button>
        <button type="button" className="primary" disabled={!currentStepValid() || currentStep === 'review'} onClick={goNext}>
          下一步
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );

  return (
    <main className={`app-shell ${isReviewStep ? 'review-mode' : ''}`}>
      {!isReviewStep && (
      <aside className="sidebar">
        <header>
          <h1>SEM 粒徑分析器</h1>
          <p>{status}</p>
        </header>

        <WorkflowStepper
          steps={workflowSteps}
          currentStep={currentStep}
          getStatus={getStepStatus}
          onSelect={(step) => {
            if (canEnterStep(step)) goToStep(step);
          }}
        />

        {stepPanel}

        <section className="panel summary-panel">
          <h2>分析摘要</h2>
          <dl className="summary-grid">
            <div>
              <dt>影像</dt>
              <dd>{image ? `${image.width} × ${image.height}px` : '尚未上傳'}</dd>
            </div>
            <div>
              <dt>比例尺</dt>
              <dd>{calibration.pixelSize ? `${calibration.pixelSize.toFixed(5)} ${calibration.unit}/px` : '尚未校正'}</dd>
            </div>
            <div>
              <dt>ROI</dt>
              <dd>{roi ? `${Math.round(roi.width)} × ${Math.round(roi.height)}px` : '尚未設定'}</dd>
            </div>
            <div>
              <dt>粒子</dt>
              <dd>
                總數 {summary.total} / 有效 {summary.valid} / 排除 {excludedCount}
              </dd>
            </div>
          </dl>
        </section>

      </aside>
      )}

      {isReviewStep && (
        <section className="review-toolbar" aria-label="手動刪除工具列">
          <div className="review-toolbar-status">
            <strong>手動刪除</strong>
            <span>
              總數 {summary.total} / 有效 {summary.valid} / 排除 {excludedCount}
            </span>
          </div>
          <div className="review-toolbar-actions">
            <button type="button" onClick={goBack}>
              <ChevronLeft size={16} />
              上一步
            </button>
            <button type="button" disabled={!undoStack.length} onClick={undo} title="Undo">
              <Undo2 size={16} />
              Undo
            </button>
            <button type="button" disabled={!redoStack.length} onClick={redo} title="Redo">
              <Redo2 size={16} />
              Redo
            </button>
            <label className="checkbox-line compact-checkbox">
              <input type="checkbox" checked={showExcluded} onChange={(event) => setShowExcluded(event.target.checked)} />
              顯示排除
            </label>
            <button type="button" disabled={!particles.length} onClick={() => downloadCSV(particles)}>
              <FileDown size={16} />
              下載 CSV
            </button>
            <button
              type="button"
              disabled={!imageElement || !particles.length}
              onClick={() => imageElement && downloadOverlayPNG(imageElement, particles, calibration)}
            >
              <Download size={16} />
              下載 PNG
            </button>
          </div>
        </section>
      )}

      <section className={`workspace ${isReviewStep ? 'with-results' : 'preview-only'}`}>
        <div
          ref={stageRef}
          className="stage"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => {
            setIsDragging(false);
            setDragStart(null);
            setDraftPoint(null);
            setErasePath([]);
          }}
          onWheel={handleWheel}
        >
          <div
            className="stage-toolbar"
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <div className="stage-tool-row">
              {stageToolModes.map((mode) => {
                const Icon = mode.icon;
                const disabled =
                  !image ||
                  ((mode.id === 'erase' || mode.id === 'boxErase' || mode.id === 'select') && !particles.length);
                return (
                  <button
                    key={mode.id}
                    className={toolMode === mode.id ? 'active' : ''}
                    disabled={disabled}
                    onClick={() => setToolMode(mode.id)}
                    title={mode.label}
                    type="button"
                  >
                    <Icon size={18} />
                  </button>
                );
              })}
              <button type="button" disabled={!image} onClick={fitToScreen} title="符合畫面">
                <Maximize size={18} />
              </button>
            </div>
            <div className="stage-mode-row">
              {displayModes.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  className={displayMode === mode.id ? 'active' : ''}
                  disabled={!image}
                  onClick={() => setDisplayMode(mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <label className="stage-opacity-control">
              <ParameterLabel help={helpText.overlayOpacity}>疊圖 {Math.round(settings.overlayOpacity * 100)}%</ParameterLabel>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.overlayOpacity}
                onChange={(event) => setSettings({ overlayOpacity: Number(event.target.value) })}
              />
            </label>
          </div>
          {!image && <div className="empty-state">上傳 SEM 影像後即可開始校正與分析</div>}
          {image && (
            <div
              className="image-layer"
              style={{
                width: image.width,
                height: image.height,
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              }}
            >
              <img src={visibleImageUrl} alt="SEM" draggable={false} />
              <svg viewBox={`0 0 ${image.width} ${image.height}`} className="annotation-layer">
                {(roi || draftROI) && (
                  <rect
                    className="roi"
                    x={(draftROI ?? roi)!.x}
                    y={(draftROI ?? roi)!.y}
                    width={(draftROI ?? roi)!.width}
                    height={(draftROI ?? roi)!.height}
                  />
                )}
                {draftEraseRect && (
                  <rect
                    className="eraser-rect"
                    x={draftEraseRect.x}
                    y={draftEraseRect.y}
                    width={draftEraseRect.width}
                    height={draftEraseRect.height}
                  />
                )}
                {draftLine && (
                  <line
                    className="calibration-line"
                    x1={draftLine[0].x}
                    y1={draftLine[0].y}
                    x2={draftLine[1].x}
                    y2={draftLine[1].y}
                  />
                )}
                {displayMode === 'overlay' &&
                  particles
                    .filter((particle) => showExcluded || !particle.excluded)
                    .map((particle) => (
                      <polygon
                        key={particle.id}
                        points={particle.contour.map((point) => `${point.x},${point.y}`).join(' ')}
                        className={[
                          'particle-outline',
                          particle.excluded ? 'excluded' : '',
                          particle.id === selectedParticleId ? 'selected' : '',
                          highlightedParticleIdSet.has(particle.id) ? 'histogram-highlight' : '',
                        ].join(' ')}
                      />
                    ))}
              </svg>
            </div>
          )}
        </div>

        {isReviewStep ? (
        <div className="results">
          <section className="diameter-summary" aria-label="粒徑統計">
            <div className="results-heading">
              <div>
                <span>粒徑統計</span>
                <h2>有效長軸粒徑分布</h2>
              </div>
              <label className="bin-control">
                <ParameterLabel help={helpText.binWidth}>
                  Bin 寬度：{formatActual(diameterStats.count ? activeBinWidth : null, diameterStats.unit)}
                </ParameterLabel>
                <input
                  type="range"
                  min={binWidthBounds.min}
                  max={binWidthBounds.max}
                  step={binWidthBounds.step}
                  value={activeBinWidth}
                  disabled={!diameterStats.count}
                  onChange={(event) => {
                    setHistogramBinWidthActual(Number(event.target.value));
                    setHighlightedParticleIds([]);
                  }}
                />
              </label>
            </div>

            {diameterStats.count ? (
              <>
                <dl className="diameter-stat-grid">
                  <div>
                    <dt>有效粒子</dt>
                    <dd>{diameterStats.count}</dd>
                  </div>
                  <div>
                    <dt>最小值</dt>
                    <dd>{formatActual(diameterStats.min, diameterStats.unit)}</dd>
                  </div>
                  <div>
                    <dt>最大值</dt>
                    <dd>{formatActual(diameterStats.max, diameterStats.unit)}</dd>
                  </div>
                  <div>
                    <dt>R 值</dt>
                    <dd>{formatActual(diameterStats.range, diameterStats.unit)}</dd>
                  </div>
                  <div>
                    <dt>平均</dt>
                    <dd>{formatActual(diameterStats.mean, diameterStats.unit)}</dd>
                  </div>
                  <div>
                    <dt>標準差</dt>
                    <dd>{formatActual(diameterStats.standardDeviation, diameterStats.unit)}</dd>
                  </div>
                </dl>

                <div className="histogram-panel">
                  <div className="histogram-bars" style={{ gridTemplateColumns: `repeat(${histogramBins.length}, minmax(8px, 1fr))` }}>
                    {histogramBins.map((bin) => {
                      const isHighlighted =
                        bin.count > 0 &&
                        highlightedParticleIds.length === bin.particleIds.length &&
                        bin.particleIds.every((id) => highlightedParticleIdSet.has(id));
                      return (
                        <button
                          key={bin.id}
                          type="button"
                          className={`histogram-bin ${isHighlighted ? 'active-bin' : ''}`}
                          disabled={!bin.count}
                          onClick={() => toggleHistogramBin(bin)}
                          onMouseEnter={() => setHoveredBinId(bin.id)}
                          onMouseLeave={() => setHoveredBinId(null)}
                          aria-label={`${formatActual(bin.start, diameterStats.unit)} 到 ${formatActual(
                            bin.end,
                            diameterStats.unit,
                          )}，${bin.count} 顆`}
                        >
                          <span className="histogram-fill" style={{ height: `${Math.max(5, (bin.count / maxBinCount) * 100)}%` }} />
                        </button>
                      );
                    })}
                  </div>
                  <div className="histogram-axis">
                    <span>{formatActual(diameterStats.min, diameterStats.unit)}</span>
                    <span>{formatActual(diameterStats.max, diameterStats.unit)}</span>
                  </div>
                  <p className="histogram-tooltip">
                    {hoveredBin
                      ? `${formatActual(hoveredBin.start, diameterStats.unit)} - ${formatActual(
                          hoveredBin.end,
                          diameterStats.unit,
                        )}：${hoveredBin.count} 顆 (${hoveredBin.percentage.toFixed(1)}%)`
                      : highlightedParticleIds.length
                        ? `已高亮 ${highlightedParticleIds.length} 顆；再次點選同一個 bin 可取消`
                        : '滑過 bin 查看範圍，點選可在影像上高亮該粒徑區間'}
                  </p>
                </div>
              </>
            ) : (
              <div className="stats-empty">
                {particles.length ? '目前沒有有效長軸粒徑。請確認比例尺或恢復至少一顆有效粒子。' : '完成即時預覽後，這裡會顯示長軸粒徑分布與統計。'}
              </div>
            )}
          </section>

          <details className="particle-details">
            <summary>詳細粒子資料</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <SortableHead label="ID" sortKey="id" current={sortKey} direction={sortDirection} onSort={setSort} />
                    <SortableHead label="Area" sortKey="area" current={sortKey} direction={sortDirection} onSort={setSort} />
                    <SortableHead label="Long-axis diameter" sortKey="diameter" current={sortKey} direction={sortDirection} onSort={setSort} />
                    <th>Centroid X</th>
                    <th>Centroid Y</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedParticles.map((particle) => (
                    <tr
                      key={particle.id}
                      className={particle.id === selectedParticleId ? 'selected-row' : ''}
                      onClick={() => setSelectedParticleId(particle.id)}
                    >
                      <td>{particle.id}</td>
                      <td>{particle.areaPx2.toFixed(1)}</td>
                      <td>
                        {particle.diameterPx.toFixed(2)} px
                        {particle.diameterActual !== null
                          ? ` / ${particle.diameterActual.toFixed(2)} ${calibration.unit}`
                          : ''}
                      </td>
                      <td>{particle.centroidX.toFixed(1)}</td>
                      <td>{particle.centroidY.toFixed(1)}</td>
                      <td>{particle.excluded ? '排除' : '有效'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
        ) : (
          <div className="preview-strip">
            <span>
              {currentStep === 'processing'
                ? isPreviewUpdating
                  ? '即時辨識預覽更新中...'
                  : particles.length
                    ? `即時辨識預覽：${particles.length} 顆粒子，右側輪廓會跟著參數更新`
                    : '調整 threshold 與 morphology 後，右側會顯示即時粒子邊界'
                : status}
            </span>
          </div>
        )}
      </section>
    </main>
  );
};

interface ParameterLabelProps {
  children: ReactNode;
  help: string;
}

const ParameterLabel = ({ children, help }: ParameterLabelProps) => (
  <span className="parameter-label">
    <span>{children}</span>
    <HelpTip text={help} />
  </span>
);

const HelpTip = ({ text }: { text: string }) => {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [tooltip, setTooltip] = useState<{ left: number; top: number; width: number; placement: 'top' | 'bottom' } | null>(
    null,
  );

  const showTooltip = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 12;
    const width = Math.min(280, window.innerWidth - margin * 2);
    const left = Math.min(window.innerWidth - margin - width / 2, Math.max(margin + width / 2, rect.left + rect.width / 2));
    const placement = rect.top < 150 ? 'bottom' : 'top';
    setTooltip({
      left,
      top: placement === 'bottom' ? rect.bottom + 10 : rect.top - 10,
      width,
      placement,
    });
  };

  return (
    <span
      ref={triggerRef}
      className="help-tip"
      tabIndex={0}
      aria-label={text}
      onBlur={() => setTooltip(null)}
      onFocus={showTooltip}
      onMouseEnter={showTooltip}
      onMouseLeave={() => setTooltip(null)}
    >
      ?
      {tooltip && (
        <span
          className={`help-tooltip visible ${tooltip.placement}`}
          role="tooltip"
          style={{ left: tooltip.left, top: tooltip.top, width: tooltip.width }}
        >
          {text}
        </span>
      )}
    </span>
  );
};

interface SortableHeadProps {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  direction: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}

interface WorkflowStepperProps {
  steps: Array<{ id: WorkflowStep; label: string }>;
  currentStep: WorkflowStep;
  getStatus: (step: WorkflowStep) => StepStatus;
  onSelect: (step: WorkflowStep) => void;
}

const WorkflowStepper = ({ steps, currentStep, getStatus, onSelect }: WorkflowStepperProps) => (
  <nav className="workflow-stepper" aria-label="分析流程">
    {steps.map((step, index) => {
      const status = getStatus(step.id);
      const isLocked = status === 'locked';
      return (
        <button
          key={step.id}
          type="button"
          className={`workflow-step ${status} ${currentStep === step.id ? 'active' : ''}`}
          disabled={isLocked}
          onClick={() => onSelect(step.id)}
        >
          <span className="step-index">
            {status === 'complete' ? <CheckCircle2 size={15} /> : status === 'warning' ? <AlertCircle size={15} /> : index + 1}
          </span>
          <span>{step.label}</span>
        </button>
      );
    })}
  </nav>
);

const SortableHead = ({ label, sortKey, current, direction, onSort }: SortableHeadProps) => (
  <th>
    <button type="button" className="sort-button" onClick={() => onSort(sortKey)}>
      {label} {current === sortKey ? (direction === 'asc' ? '↑' : '↓') : ''}
    </button>
  </th>
);
