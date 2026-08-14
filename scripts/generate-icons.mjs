import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = path.join(root, 'assets', 'icon.svg');
const png = path.join(root, 'assets', 'icon.png');
const ico = path.join(root, 'assets', 'icon.ico');
const sizes = [16, 32, 48, 64, 128, 256];

await sharp(svg).resize(512, 512).png().toFile(png);
const buffers = await Promise.all(sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()));
await fs.writeFile(ico, await pngToIco(buffers));

console.log(`Generated ${path.relative(root, png)} and ${path.relative(root, ico)}.`);
