"""Artwork/export regressions. Run against a built or development server.

STUDIO_URL=http://127.0.0.1:3003 python -m unittest discover -s tests -p test_output.py -v
"""
import base64
import io
import json
import math
import os
import struct
import unittest
import zlib

from PIL import Image, ImageChops, ImageOps
from playwright.sync_api import sync_playwright


SIDE = 601


def png_bytes(image):
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def png_url(image):
    return "data:image/png;base64," + base64.b64encode(png_bytes(image)).decode()


def saved_fixture():
    source = Image.new("RGBA", (SIDE, SIDE), (225, 70, 40, 255))
    alpha = Image.new("L", (SIDE, SIDE))
    pixels = alpha.load()
    for y in range(SIDE):
        for x in range(SIDE):
            pixels[x, y] = round(max(0, min(1, 250.5 - math.hypot(x - 300, y - 300))) * 255)
    # Visible, symmetric low-alpha corners keep source bounds intact, while
    # neighboring alpha=3 pixels exercise preservation without geometry seeds.
    for x, y in [(0, 0), (0, 600), (600, 0), (600, 600)]:
        pixels[x, y] = 12
    for x, y in [(1, 0), (0, 1), (599, 0), (600, 1),
                 (0, 599), (1, 600), (599, 600), (600, 599)]:
        pixels[x, y] = 3
    mask = Image.new("RGBA", (SIDE, SIDE), "white")
    mask.putalpha(alpha)
    artwork = source.copy()
    artwork.putalpha(alpha)
    return {"id": "output-fixture", "name": "Output fixture", "savedAt": 1,
            "source": png_url(source), "mask": png_url(mask),
            "data": png_url(artwork), "sample": False}, alpha


def density_chunk(data):
    densities = []
    offset = 8
    while offset < len(data):
        length = struct.unpack_from("!I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        checksum = struct.unpack_from("!I", data, offset + 8 + length)[0]
        assert zlib.crc32(kind + payload) & 0xffffffff == checksum
        if kind == b"pHYs":
            densities.append(struct.unpack("!IIB", payload))
        offset += length + 12
    assert len(densities) == 1, "artwork should carry exactly one valid density chunk"
    return densities[0]


class OutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
            args=["--no-sandbox"],
        )
        cls.moment, cls.source_alpha = saved_fixture()
        cls.large_photo = png_bytes(Image.new("RGB", (3200, 2400), (91, 157, 210)))

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(
            viewport={"width": 1440, "height": 1100}, has_touch=True,
            accept_downloads=True,
        )
        self.context.add_init_script("""
            if (!sessionStorage.getItem('output-fixture-seeded')) {
              localStorage.setItem('irling.moments.v1', %s);
              sessionStorage.setItem('output-fixture-seeded','yes');
            }
        """ % json.dumps(json.dumps([self.moment])))
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(os.environ.get("STUDIO_URL", "http://127.0.0.1:3001"),
                       wait_until="networkidle")
        self.page.wait_for_function("document.querySelector('#collection-count').textContent==='1'")
        self.page.locator("#collection-nav").click()
        self.page.locator(".collection-use").click()
        self.page.wait_for_selector("#collection-dialog", state="hidden")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Browser JavaScript errors")

    def option(self, group, value):
        self.page.locator(f"#{group}-options button[data-value='{value}']").click()

    def border(self, value):
        self.page.locator("#border-input").evaluate("""(input,value)=>{
            input.value=value; input.dispatchEvent(new Event('input',{bubbles:true}));
        }""", str(value))

    def download(self, selector="#download-art"):
        with self.page.expect_download() as event:
            self.page.locator(selector).click()
        with open(event.value.path(), "rb") as file:
            data = file.read()
        self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
        return data, Image.open(io.BytesIO(data)).convert("RGBA"), event.value.suggested_filename

    def check_density(self, data, image, inches):
        x, y, unit = density_chunk(data)
        self.assertEqual(unit, 1)
        self.assertEqual(x, y)
        expected = max(image.size) / inches
        self.assertAlmostEqual(x * .0254, expected, delta=.013)
        self.assertAlmostEqual(max(image.size) / (x * .0254), inches, delta=.003)

    def test_native_border_is_symmetric_and_uniform_around_round_subject(self):
        self.border(8)
        data, image, name = self.download()
        self.assertTrue(name.endswith("-artwork.png"))
        alpha = image.getchannel("A")
        self.assertIsNone(ImageChops.difference(alpha, ImageOps.mirror(alpha)).getbbox())
        self.assertIsNone(ImageChops.difference(alpha, ImageOps.flip(alpha)).getbbox())
        self.assertIsNone(alpha.crop((0, 0, image.width, 2)).getbbox())
        self.assertIsNone(alpha.crop((0, image.height - 2, image.width, image.height)).getbbox())
        center = image.width // 2
        radii = []
        for angle in [i * math.pi / 8 for i in range(16)]:
            visible = [r for r in range(250, 290)
                       if alpha.getpixel((round(center + r * math.cos(angle)),
                                          round(center + r * math.sin(angle)))) >= 128]
            self.assertTrue(visible)
            radii.append(max(visible))
        self.assertLessEqual(max(radii) - min(radii), 2)
        self.assertGreater(min(radii), 270)
        self.assertEqual(image.getpixel((center, center - 260))[:3], (255, 255, 255))
        self.check_density(data, image, 3)

    def test_border_zero_retains_every_source_alpha_and_native_pixels(self):
        self.border(0)
        data, image, _ = self.download()
        self.assertEqual(image.size, (SIDE + 4, SIDE + 4))
        alpha = image.getchannel("A")
        self.assertEqual(alpha.crop((2, 2, SIDE + 2, SIDE + 2)).tobytes(),
                         self.source_alpha.tobytes())
        self.assertEqual(alpha.getpixel((3, 2)), 3)
        self.assertEqual(alpha.getpixel((2, 2)), 12)
        self.assertEqual(image.getpixel((302, 302)), (225, 70, 40, 255))
        self.assertEqual(alpha.getpixel((0, 0)), 0)
        self.check_density(data, image, 3)

    def test_finish_effects_change_preview_and_never_artwork_pixels(self):
        matte, _, _ = self.download()
        _, matte_preview, _ = self.download("#download-preview")
        self.option("finish", "holographic")
        holographic, _, _ = self.download()
        _, holo_preview, _ = self.download("#download-preview")
        self.assertEqual(matte, holographic)
        self.assertNotEqual(matte_preview.tobytes(), holo_preview.tobytes())
        self.assertNotEqual(matte_preview.size, Image.open(io.BytesIO(matte)).size)
        self.assertIn("px", self.page.locator("#output-note").inner_text())

    def test_garment_exports_keep_native_pixels_and_encode_selected_physical_size(self):
        self.option("product", "tshirt")
        self.assertTrue(self.page.locator("#border-input").is_visible())
        self.border(0)
        self.option("size", "8")
        data8, image8, name8 = self.download()
        self.assertIn("tshirt", name8)
        self.assertEqual(image8.size, (SIDE + 4, SIDE + 4))
        self.assertEqual(image8.getchannel("A").crop((2, 2, SIDE + 2, SIDE + 2)).tobytes(),
                         self.source_alpha.tobytes())
        self.check_density(data8, image8, 8)
        self.assertTrue(self.page.locator("#quality-note").is_visible())
        self.option("size", "12")
        data12, image12, _ = self.download()
        self.assertEqual(image12.size, image8.size)
        self.assertEqual(image12.tobytes(), image8.tobytes())
        self.check_density(data12, image12, 12)
        self.assertNotEqual(density_chunk(data8), density_chunk(data12))

    def test_garment_mockups_center_artwork_and_stay_out_of_export(self):
        self.option("product", "tshirt")
        self.option("size", "10")
        _, art_tee, _ = self.download()
        _, preview_tee, _ = self.download("#download-preview")
        bbox = self.page.locator("#sticker-canvas").evaluate("""c=>{
            const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
            let left=c.width,right=-1,top=c.height,bottom=-1;
            for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
              const i=(y*c.width+x)*4;
              if(p[i]>190&&p[i+1]<100&&p[i+2]<100&&p[i+3]>128){
                left=Math.min(left,x);right=Math.max(right,x);
                top=Math.min(top,y);bottom=Math.max(bottom,y);
              }
            }return {left,right,top,bottom};
        }""")
        self.assertGreater(bbox["right"], bbox["left"])
        self.assertAlmostEqual((bbox["left"] + bbox["right"]) / 2, 500, delta=1)
        self.option("product", "sweatshirt")
        self.assertTrue(self.page.locator("#border-input").is_visible())
        self.option("size", "10")
        _, art_sweatshirt, _ = self.download()
        _, preview_sweatshirt, _ = self.download("#download-preview")
        self.assertEqual(art_tee.size, art_sweatshirt.size)
        self.assertEqual(art_tee.tobytes(), art_sweatshirt.tobytes())
        self.assertNotEqual(preview_tee.tobytes(), preview_sweatshirt.tobytes())
        self.assertNotEqual(preview_tee.size, art_tee.size)
        self.assertEqual(art_tee.getpixel((0, 0))[3], 0)

    def test_product_and_size_are_restored_from_saved_moment(self):
        self.option("product", "sweatshirt")
        self.option("size", "12")
        expected, _, _ = self.download()
        self.page.locator("#save-object").click()
        self.page.wait_for_function("!document.querySelector('#save-object').disabled")
        self.page.reload(wait_until="networkidle")
        self.page.wait_for_function("document.querySelector('#collection-count').textContent==='1'")
        self.page.locator("#collection-nav").click()
        self.page.locator(".collection-use").click()
        self.page.wait_for_selector("#collection-dialog", state="hidden")
        self.assertEqual(self.page.locator("#product-options button[aria-pressed='true']").get_attribute("data-value"),
                         "sweatshirt")
        self.assertEqual(self.page.locator("#size-options button[aria-pressed='true']").get_attribute("data-value"), "12")
        self.assertEqual(self.download()[0], expected)

    def import_and_read_source(self, name, expected_count):
        # A blocked model download keeps the test deterministic and exercises
        # the supported Keep photo path without invoking segmentation.
        self.page.locator("#photo-input").set_input_files({
            "name": name + ".png", "mimeType": "image/png", "buffer": self.large_photo,
        })
        self.page.wait_for_selector("#editor-dialog[open]")
        self.page.wait_for_selector("#keep-photo", state="visible")
        self.page.locator("#keep-photo").click()
        self.page.wait_for_selector("#editor-dialog", state="hidden")
        self.page.locator("#save-object").click()
        self.page.wait_for_function("document.querySelector('#collection-count').textContent===String(%d)" % expected_count)
        return self.page.evaluate("""name=>new Promise((resolve,reject)=>{
          const req=indexedDB.open('irling-moments',1);
          req.onsuccess=()=>{
            const get=req.result.transaction('moments','readonly').objectStore('moments').getAll();
            get.onsuccess=()=>{
              const record=get.result.find(x=>x.name===name), image=new Image();
              image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});
              image.onerror=()=>reject(new Error('Saved source image could not load'));
              image.src=record.source;
            };get.onerror=()=>reject(get.error);
          };req.onerror=()=>reject(req.error);
        })""", name)

    def test_import_preserves_higher_resolution_and_respects_memory_budgets(self):
        self.page.route("**/models/u2netp.onnx", lambda route: route.abort())
        self.page.evaluate("Object.defineProperty(navigator,'deviceMemory',{get:()=>8,configurable:true})")
        high = self.import_and_read_source("high-resolution", 2)
        self.assertGreater(max(high.values()), 1600)
        self.assertLessEqual(max(high.values()), 2400)
        self.assertLessEqual(high["width"] * high["height"], 4_000_000)
        self.page.evaluate("Object.defineProperty(navigator,'deviceMemory',{get:()=>2,configurable:true})")
        small = self.import_and_read_source("low-memory-resolution", 3)
        self.assertLessEqual(max(small.values()), 1600)
        self.assertLessEqual(small["width"] * small["height"], 2_000_000)
        self.assertGreater(high["width"], small["width"])

    def test_product_controls_do_not_overflow_phone_viewports(self):
        for width in [320, 390]:
            self.page.set_viewport_size({"width": width, "height": 844})
            for product in ["sticker", "tshirt", "sweatshirt"]:
                self.option("product", product)
                self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth"), width)
                self.assertTrue(self.page.locator("#output-note").is_visible())
                self.assertTrue(self.page.locator("#download-art").is_visible())


if __name__ == "__main__":
    unittest.main(verbosity=2)
