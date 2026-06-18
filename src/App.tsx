import { ChangeEvent, PointerEvent, useEffect, useMemo, useRef, useState, WheelEvent } from 'react';
import {
  Download,
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
import type { DisplayMode, Particle, Point, ROI, SortKey, ToolMode, Unit } from './types';

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
];

const units: Unit[] = ['nm', 'µm', 'mm'];

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
    setImage,
    setDisplayMode,
    setToolMode,
    setROI,
    setCalibration,
    setSettings,
    setAnalysisResult,
    setSelectedParticleId,
    toggleParticleExcluded,
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

  const visibleImageUrl = useMemo(() => {
    if (displayMode === 'mask') return maskDataUrl ?? image?.url ?? '';
    return image?.url ?? '';
  }, [displayMode, image?.url, maskDataUrl]);

  const sortedParticles = useMemo(() => {
    const multiplier = sortDirection === 'asc' ? 1 : -1;
    const keyValue = (particle: Particle) => {
      if (sortKey === 'area') return particle.areaPx2;
      if (sortKey === 'diameter') return particle.equivalentDiameterPx;
      return particle.id;
    };
    return [...particles].sort((a, b) => (keyValue(a) - keyValue(b)) * multiplier);
  }, [particles, sortDirection, sortKey]);

  const summary = useMemo(() => {
    const valid = particles.filter((particle) => !particle.excluded);
    const mean = valid.length
      ? valid.reduce((total, particle) => total + particle.equivalentDiameterPx, 0) / valid.length
      : 0;
    return { total: particles.length, valid: valid.length, mean };
  }, [particles]);

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

  const runAnalysis = () => {
    if (!imageElement) return;
    setStatus('分析中...');
    requestAnimationFrame(() => {
      try {
        const result = analyzeImage(imageElement, roi, settings, calibration);
        setAnalysisResult(result.particles, result.maskDataUrl, result.overlayDataUrl);
        setDisplayMode('overlay');
        setStatus(`完成：偵測到 ${result.particles.length} 顆粒子。`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'OpenCV 分析失敗。');
      }
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
    setIsDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDragging || !dragStart) return;
    if (toolMode === 'pan') {
      setOffset({ x: event.clientX - dragStart.x, y: event.clientY - dragStart.y });
      return;
    }
    setDraftPoint(screenToImage(event.clientX, event.clientY));
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
        setStatus(`校正完成：1 px = ${(parsedLength / pixelLength).toFixed(6)} ${unit}`);
      }
    } else if (toolMode === 'roi') {
      const nextROI = normalizeRect(dragStart, point);
      if (nextROI.width > 4 && nextROI.height > 4) {
        setROI(nextROI);
        setStatus('ROI 已設定。');
      }
    } else if (toolMode === 'select') {
      const particle = [...particles]
        .reverse()
        .find((candidate) => (showExcluded || !candidate.excluded) && pointInPolygon(point, candidate.contour));
      if (particle) {
        toggleParticleExcluded(particle.id);
        setStatus(`粒子 ${particle.id} 已${particle.excluded ? '恢復' : '排除'}。`);
      }
    }
    setIsDragging(false);
    setDragStart(null);
    setDraftPoint(null);
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

  const draftROI = dragStart && draftPoint && toolMode === 'roi' ? normalizeRect(dragStart, draftPoint) : null;
  const draftLine = dragStart && draftPoint && toolMode === 'calibrate' ? [dragStart, draftPoint] : calibration.line;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <header>
          <h1>SEM 粒徑分析器</h1>
          <p>{status}</p>
        </header>

        <section className="panel upload-panel">
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
        </section>

        <section className="panel">
          <h2>工具</h2>
          <div className="icon-grid">
            {toolModes.map((mode) => {
              const Icon = mode.icon;
              return (
                <button
                  key={mode.id}
                  className={toolMode === mode.id ? 'active' : ''}
                  onClick={() => setToolMode(mode.id)}
                  title={mode.label}
                  type="button"
                >
                  <Icon size={18} />
                </button>
              );
            })}
            <button type="button" onClick={fitToScreen} title="符合畫面">
              <Maximize size={18} />
            </button>
          </div>
          <div className="segmented">
            {displayModes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={displayMode === mode.id ? 'active' : ''}
                onClick={() => setDisplayMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>比例尺</h2>
          <div className="form-row">
            <label>
              實際長度
              <input value={actualLength} onChange={(event) => setActualLength(event.target.value)} inputMode="decimal" />
            </label>
            <label>
              單位
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
        </section>

        <section className="panel">
          <h2>Threshold</h2>
          <label>
            Threshold：{settings.threshold}
            <input
              type="range"
              min="0"
              max="255"
              value={settings.threshold}
              onChange={(event) => setSettings({ threshold: Number(event.target.value) })}
            />
          </label>
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
            疊圖透明度：{Math.round(settings.overlayOpacity * 100)}%
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.overlayOpacity}
              onChange={(event) => setSettings({ overlayOpacity: Number(event.target.value) })}
            />
          </label>
        </section>

        <section className="panel">
          <h2>影像處理</h2>
          <label>
            Gaussian blur
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
            Opening：{settings.openingIterations}
            <input
              type="range"
              min="0"
              max="3"
              value={settings.openingIterations}
              onChange={(event) => setSettings({ openingIterations: Number(event.target.value) })}
            />
          </label>
          <label>
            Closing：{settings.closingIterations}
            <input
              type="range"
              min="0"
              max="3"
              value={settings.closingIterations}
              onChange={(event) => setSettings({ closingIterations: Number(event.target.value) })}
            />
          </label>
          <button className="primary" type="button" disabled={!imageElement} onClick={runAnalysis}>
            開始分析
          </button>
          <div className="button-row">
            <button type="button" disabled={!roi} onClick={() => setROI(null)}>
              清除 ROI
            </button>
            <button type="button" disabled={!undoStack.length} onClick={undo} title="Undo">
              <Undo2 size={16} />
            </button>
            <button type="button" disabled={!redoStack.length} onClick={redo} title="Redo">
              <Redo2 size={16} />
            </button>
          </div>
          <label className="checkbox-line">
            <input type="checkbox" checked={showExcluded} onChange={(event) => setShowExcluded(event.target.checked)} />
            顯示已排除粒子
          </label>
        </section>

        <section className="panel">
          <h2>輸出</h2>
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
        </section>
      </aside>

      <section className="workspace">
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
          }}
          onWheel={handleWheel}
        >
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
                        ].join(' ')}
                      />
                    ))}
              </svg>
            </div>
          )}
        </div>

        <div className="results">
          <div className="stats">
            <span>總粒子 {summary.total}</span>
            <span>有效 {summary.valid}</span>
            <span>
              平均直徑 {summary.mean.toFixed(2)} px
              {calibration.pixelSize ? ` / ${(summary.mean * calibration.pixelSize).toFixed(2)} ${calibration.unit}` : ''}
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortableHead label="ID" sortKey="id" current={sortKey} direction={sortDirection} onSort={setSort} />
                  <SortableHead label="Area" sortKey="area" current={sortKey} direction={sortDirection} onSort={setSort} />
                  <SortableHead label="Equivalent diameter" sortKey="diameter" current={sortKey} direction={sortDirection} onSort={setSort} />
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
                      {particle.equivalentDiameterPx.toFixed(2)} px
                      {particle.equivalentDiameterActual !== null
                        ? ` / ${particle.equivalentDiameterActual.toFixed(2)} ${calibration.unit}`
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
        </div>
      </section>
    </main>
  );
};

interface SortableHeadProps {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  direction: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}

const SortableHead = ({ label, sortKey, current, direction, onSort }: SortableHeadProps) => (
  <th>
    <button type="button" className="sort-button" onClick={() => onSort(sortKey)}>
      {label} {current === sortKey ? (direction === 'asc' ? '↑' : '↓') : ''}
    </button>
  </th>
);
