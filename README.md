# SEM Particle Size Analyzer

純前端 SEM 球形填料粒徑分析 MVP。使用 React、TypeScript、Vite、OpenCV.js 與 Zustand，所有影像都只在瀏覽器本地處理。

## 功能

- SEM 影像上傳與本地預覽
- 比例尺校正與 ROI 選取
- Threshold、粒子極性、blur、opening、closing 控制
- OpenCV.js 粒子偵測與等效圓直徑量測
- 粒子表格、排序、選取、高亮、排除、Undo / Redo
- CSV 與標記 PNG 匯出

## 開發

```bash
npm install
npm run dev
```

## 建置

```bash
npm run build
```
