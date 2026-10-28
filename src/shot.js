// Screenshot caption strip: "Step 3 - Outlook" and the date/time, drawn as raw pixels.
// The main process glues it under the screenshot and saves the PNGs (it encodes PNG much faster).

const Shot = (() => {
  function captionBand({ width, height, step, app, time }) {
    const band = Math.max(64, Math.round(height * 0.085));
    const canvas = new OffscreenCanvas(width, band);
    const c = canvas.getContext('2d', { willReadFrequently: true });   // software canvas: quick to read back
    // White strip with the blue -> green line on top (same colours as the control bar).
    c.fillStyle = '#FFFFFF';
    c.fillRect(0, 0, width, band);
    const line = c.createLinearGradient(0, 0, width, 0);
    line.addColorStop(0, '#0473EA');
    line.addColorStop(0.6, '#0473EA');
    line.addColorStop(1, '#38D200');
    c.fillStyle = line;
    c.fillRect(0, 0, width, Math.max(3, Math.round(band * 0.06)));

    const left = Math.round(band * 0.35);
    c.textBaseline = 'alphabetic';
    c.font = `600 ${Math.round(band * 0.32)}px "Segoe UI", system-ui, sans-serif`;
    c.fillStyle = '#0473EA';
    const label = `Step ${step}`;
    c.fillText(label, left, band * 0.52);
    if (app) {
      c.fillStyle = '#0B1F3A';
      c.fillText(`  -  ${app}`, left + c.measureText(label).width, band * 0.52);
    }
    c.fillStyle = '#5F6B7A';
    c.font = `${Math.round(band * 0.21)}px "Segoe UI", system-ui, sans-serif`;
    c.fillText(time, left, band * 0.83);

    return { width, height: band, rgba: c.getImageData(0, 0, width, band).data };
  }

  return { captionBand };
})();
