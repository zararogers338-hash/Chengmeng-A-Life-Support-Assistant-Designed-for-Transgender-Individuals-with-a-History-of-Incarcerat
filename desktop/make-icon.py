"""Draw the native launcher's simple pastel C mark at icon resolutions."""
from pathlib import Path
from PIL import Image, ImageDraw

size = 256
image = Image.new('RGBA', (size, size))
mask = Image.new('L', image.size)
ImageDraw.Draw(mask).rounded_rectangle((4, 4, 252, 252), radius=58, fill=255)
pixels = image.load()
for y in range(size):
    for x in range(size):
        t = (x + y) / (2 * size)
        pixels[x, y] = (int(243 * (1-t) + 83*t), int(177 * (1-t) + 195*t), int(212 * (1-t) + 237*t), mask.getpixel((x, y)))
draw = ImageDraw.Draw(image)
draw.arc((57, 54, 201, 202), 47, 313, fill=(255, 255, 255, 255), width=26)
draw.ellipse((162, 66, 190, 94), fill='white')
draw.ellipse((162, 162, 190, 190), fill='white')
image.save(Path(__file__).with_name('chengmeng.ico'), sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
