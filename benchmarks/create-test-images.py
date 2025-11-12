#!/usr/bin/env python3
"""
Generate test images for vision model benchmarking
"""
from PIL import Image, ImageDraw, ImageFont
import os

def create_test_images(output_dir='benchmarks/test-images'):
    os.makedirs(output_dir, exist_ok=True)

    # Image 1: Simple text
    img1 = Image.new('RGB', (800, 600), color='white')
    draw = ImageDraw.Draw(img1)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 40)
    except:
        font = ImageFont.load_default()
    draw.text((50, 250), "Hello World!", fill='black', font=font)
    img1.save(f'{output_dir}/text1.jpg')
    print(f"Created {output_dir}/text1.jpg")

    # Image 2: Geometric shapes
    img2 = Image.new('RGB', (800, 600), color='lightblue')
    draw = ImageDraw.Draw(img2)
    draw.rectangle([100, 100, 300, 300], fill='red', outline='black', width=3)
    draw.ellipse([400, 200, 600, 400], fill='yellow', outline='black', width=3)
    draw.polygon([(700, 100), (750, 300), (650, 300)], fill='green', outline='black')
    img2.save(f'{output_dir}/shapes.jpg')
    print(f"Created {output_dir}/shapes.jpg")

    # Image 3: Numbers
    img3 = Image.new('RGB', (800, 600), color='white')
    draw = ImageDraw.Draw(img3)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 80)
    except:
        font = ImageFont.load_default()
    draw.text((200, 250), "1 2 3 4 5", fill='navy', font=font)
    img3.save(f'{output_dir}/numbers.jpg')
    print(f"Created {output_dir}/numbers.jpg")

    # Image 4: Mixed content
    img4 = Image.new('RGB', (800, 600), color='lightyellow')
    draw = ImageDraw.Draw(img4)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 30)
    except:
        font = ImageFont.load_default()
    draw.text((50, 50), "Question: What is 2 + 2?", fill='black', font=font)
    draw.text((50, 150), "Answer: 4", fill='darkgreen', font=font)
    draw.rectangle([50, 250, 750, 550], outline='blue', width=3)
    img4.save(f'{output_dir}/math.jpg')
    print(f"Created {output_dir}/math.jpg")

    # Image 5: Color bars
    img5 = Image.new('RGB', (800, 600), color='white')
    draw = ImageDraw.Draw(img5)
    colors = ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet']
    bar_height = 600 // len(colors)
    for i, color in enumerate(colors):
        y = i * bar_height
        draw.rectangle([0, y, 800, y + bar_height], fill=color)
    img5.save(f'{output_dir}/colors.jpg')
    print(f"Created {output_dir}/colors.jpg")

    print(f"\nCreated 5 test images in {output_dir}/")

if __name__ == '__main__':
    create_test_images()
