/**
 * Genera los iconos PNG necesarios para el manifest.json
 * Ejecutar UNA VEZ en bistro-app/ con: node generate_icons.js
 * Requiere: npm install sharp
 */
const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

// SVG del ícono de Bistro Connect (fondo coral, tenedor+cuchillo blanco)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="100" fill="#E8563A"/>
  <text x="256" y="320" font-family="Georgia,serif" font-size="280" font-weight="bold"
        fill="white" text-anchor="middle">B</text>
</svg>`;

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const outDir = path.join(__dirname, 'public', 'icons');

fs.mkdirSync(outDir, { recursive: true });

Promise.all(
  sizes.map(size =>
    sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(path.join(outDir, `icon-${size}.png`))
      .then(() => console.log(`✅ icon-${size}.png`))
  )
).then(() => {
  // Badge monocromático para notificaciones
  const badgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">
    <rect width="72" height="72" rx="14" fill="white"/>
    <text x="36" y="52" font-family="Georgia,serif" font-size="48" font-weight="bold"
          fill="#E8563A" text-anchor="middle">B</text>
  </svg>`;
  return sharp(Buffer.from(badgeSvg)).resize(72, 72).png()
    .toFile(path.join(outDir, 'badge-72.png'))
    .then(() => console.log('✅ badge-72.png'));
}).then(() => console.log('\n🎉 Todos los iconos generados en public/icons/'));
