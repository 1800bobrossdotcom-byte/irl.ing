// Illustrated front views, not manufacturer garment or print templates.
// The print area stays centered on the same seam axis for both products.
export const GARMENT_PRINT_AREA = Object.freeze({
  x: 330,
  y: 275,
  width: 340,
  height: 400,
});

function layout(product, width, height) {
  if (product !== "tshirt" && product !== "sweatshirt") {
    throw new RangeError("Choose a tshirt or sweatshirt garment preview.");
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError("Garment preview dimensions must be finite and positive.");
  }
  const scale = Math.min(width, height) / 1000;
  return { scale, x: (width - 1000 * scale) / 2, y: (height - 1000 * scale) / 2 };
}

export function garmentPlacement(product, width = 1000, height = 1000) {
  const view = layout(product, width, height);
  return {
    x: width / 2 - GARMENT_PRINT_AREA.width * view.scale / 2,
    y: view.y + GARMENT_PRINT_AREA.y * view.scale,
    width: GARMENT_PRINT_AREA.width * view.scale,
    height: GARMENT_PRINT_AREA.height * view.scale,
  };
}

function tshirtPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(420, 112);
  ctx.bezierCurveTo(445, 168, 555, 168, 580, 112);
  ctx.lineTo(630, 130);
  ctx.lineTo(800, 230);
  ctx.lineTo(748, 368);
  ctx.lineTo(715, 328);
  ctx.lineTo(723, 838);
  ctx.quadraticCurveTo(500, 860, 277, 838);
  ctx.lineTo(285, 328);
  ctx.lineTo(252, 368);
  ctx.lineTo(200, 230);
  ctx.lineTo(370, 130);
  ctx.closePath();
}

function sweatshirtPath(ctx) {
  ctx.beginPath();
  ctx.moveTo(420, 102);
  ctx.bezierCurveTo(445, 149, 555, 149, 580, 102);
  ctx.lineTo(642, 126);
  ctx.quadraticCurveTo(676, 136, 698, 165);
  ctx.lineTo(858, 645);
  ctx.quadraticCurveTo(864, 664, 853, 674);
  ctx.lineTo(777, 705);
  ctx.quadraticCurveTo(758, 711, 753, 692);
  ctx.lineTo(715, 435);
  ctx.lineTo(723, 866);
  ctx.quadraticCurveTo(724, 886, 705, 889);
  ctx.lineTo(295, 889);
  ctx.quadraticCurveTo(276, 886, 277, 866);
  ctx.lineTo(285, 435);
  ctx.lineTo(247, 692);
  ctx.quadraticCurveTo(242, 711, 223, 705);
  ctx.lineTo(147, 674);
  ctx.quadraticCurveTo(136, 664, 142, 645);
  ctx.lineTo(302, 165);
  ctx.quadraticCurveTo(324, 136, 358, 126);
  ctx.closePath();
}

function collar(ctx, sweatshirt) {
  const top = sweatshirt ? 102 : 112;
  const inner = sweatshirt ? 149 : 168;
  const outer = sweatshirt ? 174 : 190;
  ctx.beginPath();
  ctx.moveTo(420, top);
  ctx.bezierCurveTo(445, inner, 555, inner, 580, top);
  ctx.lineTo(587, top + 7);
  ctx.bezierCurveTo(558, outer, 442, outer, 413, top + 7);
  ctx.closePath();
  ctx.fillStyle = "rgba(68, 62, 50, .055)";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(91, 85, 72, .15)";
  ctx.stroke();
}

function seams(ctx, sweatshirt) {
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "rgba(91, 85, 72, .12)";
  ctx.beginPath();
  if (sweatshirt) {
    ctx.moveTo(367, 148);
    ctx.bezierCurveTo(328, 228, 296, 329, 285, 435);
    ctx.moveTo(633, 148);
    ctx.bezierCurveTo(672, 228, 704, 329, 715, 435);
    ctx.moveTo(151, 640);
    ctx.lineTo(244, 677);
    ctx.moveTo(849, 640);
    ctx.lineTo(756, 677);
  } else {
    ctx.moveTo(365, 150);
    ctx.bezierCurveTo(318, 196, 280, 262, 285, 328);
    ctx.moveTo(635, 150);
    ctx.bezierCurveTo(682, 196, 720, 262, 715, 328);
    ctx.moveTo(212, 237);
    ctx.lineTo(262, 354);
    ctx.moveTo(788, 237);
    ctx.lineTo(738, 354);
    ctx.moveTo(287, 824);
    ctx.quadraticCurveTo(500, 844, 713, 824);
  }
  ctx.stroke();

  // Paired faint folds avoid shifting the visual center of the chest artwork.
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(91, 85, 72, .035)";
  ctx.beginPath();
  ctx.moveTo(342, 421);
  ctx.bezierCurveTo(354, 519, 336, 683, 348, 816);
  ctx.moveTo(658, 421);
  ctx.bezierCurveTo(646, 519, 664, 683, 652, 816);
  ctx.stroke();
}

function sweatshirtRibbing(ctx) {
  ctx.fillStyle = "rgba(68, 62, 50, .035)";
  ctx.fillRect(277, 847, 446, 44);
  ctx.strokeStyle = "rgba(91, 85, 72, .13)";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(279, 849);
  ctx.quadraticCurveTo(500, 855, 721, 849);
  ctx.stroke();

  ctx.strokeStyle = "rgba(91, 85, 72, .07)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 295; x <= 705; x += 10) {
    ctx.moveTo(x, 854);
    ctx.lineTo(x, 884);
  }
  for (let i = 0; i <= 10; i++) {
    const x = 157 + i * 8;
    const y = 651 + i * 3.2;
    ctx.moveTo(x, y);
    ctx.lineTo(x - 4, y + 23);
    ctx.moveTo(1000 - x, y);
    ctx.lineTo(1004 - x, y + 23);
  }
  ctx.stroke();
}

export function drawGarment(ctx, product, width = 1000, height = 1000, color = "#f2eee6") {
  const view = layout(product, width, height);
  const placement = garmentPlacement(product, width, height);
  const sweatshirt = product === "sweatshirt";
  const outline = sweatshirt ? sweatshirtPath : tshirtPath;
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  outline(ctx);
  ctx.fillStyle = color;
  ctx.shadowColor = "rgba(51, 45, 34, .12)";
  // Canvas shadows use canvas pixels rather than the current transform.
  ctx.shadowBlur = 18 * view.scale;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 14 * view.scale;
  ctx.fill();
  ctx.shadowColor = "transparent";

  ctx.save();
  ctx.clip();
  const shade = ctx.createLinearGradient(290, 0, 710, 0);
  shade.addColorStop(0, "rgba(68, 62, 50, .045)");
  shade.addColorStop(0.22, "rgba(68, 62, 50, 0)");
  shade.addColorStop(0.5, "rgba(255, 255, 255, .1)");
  shade.addColorStop(0.78, "rgba(68, 62, 50, 0)");
  shade.addColorStop(1, "rgba(68, 62, 50, .045)");
  ctx.fillStyle = shade;
  ctx.fillRect(100, 80, 800, 840);
  collar(ctx, sweatshirt);
  seams(ctx, sweatshirt);
  if (sweatshirt) sweatshirtRibbing(ctx);
  ctx.restore();

  outline(ctx);
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = "rgba(91, 85, 72, .2)";
  ctx.stroke();
  ctx.restore();
  return placement;
}
