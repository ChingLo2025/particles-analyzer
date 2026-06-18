import type { Calibration, Particle } from './types';

const formatNumber = (value: number | null) => (value === null ? '' : Number(value.toFixed(6)).toString());

export const downloadCSV = (particles: Particle[]) => {
  const header = [
    'particle_id',
    'area_px2',
    'area_actual',
    'equivalent_diameter_px',
    'equivalent_diameter_actual',
    'centroid_x',
    'centroid_y',
    'excluded',
  ];
  const rows = particles.map((particle) => [
    particle.id,
    formatNumber(particle.areaPx2),
    formatNumber(particle.areaActual),
    formatNumber(particle.equivalentDiameterPx),
    formatNumber(particle.equivalentDiameterActual),
    formatNumber(particle.centroidX),
    formatNumber(particle.centroidY),
    particle.excluded ? 'true' : 'false',
  ]);
  const csv = [header, ...rows].map((row) => row.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'particles.csv';
  link.click();
  URL.revokeObjectURL(url);
};

export const downloadOverlayPNG = (image: HTMLImageElement, particles: Particle[], calibration: Calibration) => {
  void calibration;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(image, 0, 0);
  context.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) / 600));
  context.strokeStyle = '#1cd397';
  particles
    .filter((particle) => !particle.excluded)
    .forEach((particle) => {
      if (particle.contour.length === 0) return;
      context.beginPath();
      context.moveTo(particle.contour[0].x, particle.contour[0].y);
      particle.contour.slice(1).forEach((point) => context.lineTo(point.x, point.y));
      context.closePath();
      context.stroke();
    });
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = 'particles-overlay.png';
  link.click();
};
