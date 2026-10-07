"""Editor regressions using a saved high-resolution matte, without inference.

Run against npm run dev: python -m unittest discover -s tests -p test_editor.py -v
"""
import base64
import io
import json
import math
import os
import unittest

from PIL import Image
from playwright.sync_api import sync_playwright


WIDTH, HEIGHT = 900, 600


def png_url(image):
    output = io.BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


def fixture_moment():
    source = Image.new("RGBA", (WIDTH, HEIGHT), (220, 235, 205, 255))
    mask = Image.new("RGBA", (WIDTH, HEIGHT), (255, 255, 255, 0))
    rgb, matte = source.load(), mask.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            if 165 <= x <= 655 and 115 <= y <= 505:
                # A mixed-color photographic edge deliberately differs from
                # the coarse mask, giving refinement real evidence to use.
                blend = min(1, (x - 164) / 5, (656 - x) / 5,
                            (y - 114) / 5, (506 - y) / 5)
                foreground, background = (210, 70, 35), (220, 235, 205)
                rgb[x, y] = tuple(round(b + blend * (f - b))
                                  for f, b in zip(foreground, background)) + (255,)
            if 155 <= x <= 665 and 105 <= y <= 515:
                a = {155: 64, 156: 128, 157: 192}.get(x, 255)
                matte[x, y] = (255, 255, 255, a)
            if 350 <= x <= 353 and 80 <= y < 105:
                matte[x, y] = (255, 255, 255, (43, 83, 127, 211)[x - 350])
            if 150 <= x < 155 and 220 <= y <= 224:
                matte[x, y] = (255, 255, 255, (37, 67, 109, 149, 201)[x - 150])
            if 770 <= x <= 820 and 220 <= y <= 380:
                matte[x, y] = (255, 255, 255, 180)
    # Two separate corner pixels keep clean exports in original coordinates
    # until the user explicitly selects one connected object.
    matte[0, 0] = matte[WIDTH - 1, HEIGHT - 1] = (255, 255, 255, 255)
    artwork = source.copy()
    artwork.putalpha(mask.getchannel("A"))
    return {
        "id": "editor-fixture", "name": "Editor fixture", "savedAt": 1,
        "source": png_url(source), "mask": png_url(mask),
        "data": png_url(artwork), "sample": False,
    }, mask.getchannel("A")


class EditorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
            args=["--no-sandbox"],
        )
        cls.moment, cls.initial_alpha = fixture_moment()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(
            viewport={"width": 1440, "height": 1100},
            has_touch=True, accept_downloads=True,
        )
        self.context.add_init_script("""
            if (!sessionStorage.getItem('editor-fixture-seeded')) {
              localStorage.setItem('irling.moments.v1', %s);
              sessionStorage.setItem('editor-fixture-seeded', 'yes');
            }
        """ % json.dumps(json.dumps([self.moment])))
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(os.environ.get("STUDIO_URL", "http://127.0.0.1:3001"),
                       wait_until="networkidle")
        self.page.wait_for_function("document.querySelector('#collection-count').textContent === '1'")
        self.page.locator("#collection-nav").click()
        self.page.locator(".collection-use").click()
        self.page.wait_for_selector("#collection-dialog", state="hidden")
        self.page.locator("#edit-object").click()
        self.page.wait_for_selector("#editor-dialog[open]")
        self.open_tools()
        self.zoom, self.pan = 1, {"x": 0, "y": 0}

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Browser JavaScript errors")

    def range_value(self, selector, value):
        self.page.locator(selector).evaluate("""(input, value) => {
            input.value = value; input.dispatchEvent(new Event('input', {bubbles:true}));
        }""", str(value))

    def open_tools(self):
        if self.page.locator("#touchup-panel").is_hidden():
            self.page.locator("#touch-up").click()
        if not self.page.locator("#more-tools").evaluate("details => details.open"):
            self.page.locator("#more-tools > summary").click()

    def clean_png(self):
        with self.page.expect_download() as event:
            self.page.locator("#download-cutout").click()
        with open(event.value.path(), "rb") as file:
            return file.read()

    def clean_image(self):
        return Image.open(io.BytesIO(self.clean_png())).convert("RGBA")

    def point_on_page(self, x, y):
        canvas = self.page.locator("#editor-canvas")
        canvas.scroll_into_view_if_needed()
        box = canvas.bounding_box()
        cw, ch = canvas.evaluate("c => [c.width,c.height]")
        scale = min(cw / WIDTH, ch / HEIGHT) * self.zoom
        vx = (cw - WIDTH * scale) / 2 + self.pan["x"] + x * scale
        vy = (ch - HEIGHT * scale) / 2 + self.pan["y"] + y * scale
        return {"x": box["x"] + vx * box["width"] / cw,
                "y": box["y"] + vy * box["height"] / ch}

    def click_source(self, x, y):
        p = self.point_on_page(x, y)
        self.page.mouse.click(p["x"], p["y"])

    def configure_brush(self, mode, diameter, hardness):
        self.page.locator("#" + mode + "-mask").click()
        self.range_value("#brush-size", diameter)
        self.range_value("#brush-hardness", hardness)

    def refine(self):
        self.page.locator("#refine-edges").click()
        self.page.wait_for_function("document.querySelector('#cutout-status').textContent.includes('Edges refined')")

    def test_default_result_has_two_actions_and_fits_small_phone(self):
        self.page.locator("#touch-up").click()
        self.assertTrue(self.page.locator("#touchup-panel").is_hidden())
        self.assertEqual(self.page.locator("#touch-up").get_attribute("aria-expanded"), "false")
        for selector in ["#erase-mask", "#trace-image", "#auto-cutout", "#refine-edges",
                         "#zoom-in", "#editor-background", "#download-cutout"]:
            self.assertFalse(self.page.locator(selector).is_visible(), selector)
        for width, height in [(320, 568), (390, 844)]:
            self.page.set_viewport_size({"width": width, "height": height})
            self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
            for selector in ["#editor-canvas", "#use-cutout", "#touch-up"]:
                bounds = self.page.locator(selector).bounding_box()
                self.assertGreaterEqual(bounds["y"], 0, selector)
                self.assertLessEqual(bounds["y"] + bounds["height"], height, selector)
            self.assertTrue(self.page.locator("#use-cutout").is_enabled())
        self.page.locator("#use-cutout").tap()
        self.page.wait_for_selector("#editor-dialog", state="hidden")
        self.assertEqual(self.page.locator("#asset-status").inner_text(), "Your moment")

    def test_touch_up_reveals_brushes_before_advanced_choices(self):
        self.page.locator("#more-tools > summary").click()
        self.page.locator("#touch-up").click()
        self.page.locator("#touch-up").click()
        self.assertEqual(self.page.locator("#touch-up").get_attribute("aria-expanded"), "true")
        for selector in ["#erase-mask", "#restore-mask", "#undo-point", "#redo-mask", "#brush-size"]:
            self.assertTrue(self.page.locator(selector).is_visible(), selector)
        for selector in ["#trace-image", "#focus-edges", "#refine-edges", "#brush-hardness", "#zoom-in"]:
            self.assertFalse(self.page.locator(selector).is_visible(), selector)
        self.page.locator("#more-tools > summary").click()
        for selector in ["#trace-image", "#focus-edges", "#refine-edges", "#brush-hardness", "#zoom-in"]:
            self.assertTrue(self.page.locator(selector).is_visible(), selector)

    def test_zoom_pan_places_three_pixel_brush_at_exact_source_coordinate(self):
        baseline = self.clean_image().getchannel("A")
        self.page.locator("#zoom-in").click()
        self.page.locator("#zoom-in").click()
        self.zoom = 2.25
        self.page.locator("#pan-image").click()
        canvas = self.page.locator("#editor-canvas")
        canvas.scroll_into_view_if_needed()
        box = canvas.bounding_box()
        cw, ch = canvas.evaluate("c => [c.width,c.height]")
        self.page.mouse.move(box["x"] + box["width"] / 2,
                             box["y"] + box["height"] / 2)
        self.page.mouse.down()
        self.page.mouse.move(box["x"] + box["width"] / 2 + 27,
                             box["y"] + box["height"] / 2 - 19)
        self.page.mouse.up()
        self.pan = {"x": 27 * cw / box["width"], "y": -19 * ch / box["height"]}
        self.configure_brush("erase", 3, 100)
        self.click_source(470.5, 290.5)
        result = self.clean_image().getchannel("A")
        self.assertEqual(result.size, (WIDTH, HEIGHT))
        self.assertEqual(result.getpixel((470, 290)), 0)
        differences = [(i % WIDTH, i // WIDTH)
                       for i, (a, b) in enumerate(zip(baseline.tobytes(), result.tobytes())) if a != b]
        self.assertGreater(len(differences), 0)
        # An antialiased pixel can overlap the disc while its center falls just
        # outside it. No changed pixel may lie beyond that intersection band.
        self.assertTrue(all(math.hypot(x - 470, y - 290) <= 1.5 + math.sqrt(0.5)
                            for x, y in differences), differences)

    def test_one_pixel_brush_on_pixel_corner_produces_localized_coverage(self):
        before = self.clean_image().getchannel("A")
        self.configure_brush("erase", 1, 100)
        self.click_source(450, 300)
        after = self.clean_image().getchannel("A")
        differences = [(i % WIDTH, i // WIDTH)
                       for i, (a, b) in enumerate(zip(before.tobytes(), after.tobytes())) if a != b]
        self.assertGreater(len(differences), 0)
        self.assertLessEqual(len(differences), 4)
        self.assertTrue(all(x in (449, 450) and y in (299, 300)
                            for x, y in differences), differences)

    def test_soft_alpha_and_undo_redo_restore_exact_export(self):
        before = self.clean_png()
        self.configure_brush("erase", 21, 0)
        self.click_source(450.5, 300.5)
        erased = self.clean_png()
        alpha = Image.open(io.BytesIO(erased)).getchannel("A")
        self.assertEqual(alpha.getpixel((450, 300)), 0)
        self.assertGreater(alpha.getpixel((455, 300)), 0)
        self.assertLess(alpha.getpixel((455, 300)), 255)
        self.assertEqual(alpha.getpixel((462, 300)), 255)
        self.page.locator("#undo-point").click()
        self.assertEqual(self.clean_png(), before)
        self.page.locator("#redo-mask").click()
        self.assertEqual(self.clean_png(), erased)

    def test_pick_object_preserves_source_resolution_hair_alpha(self):
        self.page.locator("#select-subject").click()
        self.click_source(400.5, 300.5)
        result = self.clean_image().getchannel("A")
        expected = self.initial_alpha.crop((150, 80, 666, 516))
        self.assertEqual(result.size, expected.size)
        self.assertEqual(result.tobytes(), expected.tobytes())
        self.assertEqual(result.getpixel((200, 5)), 43)
        self.assertEqual(result.getpixel((0, 140)), 37)

    def test_two_finger_pinch_rolls_back_mask_and_preserves_redo(self):
        self.configure_brush("erase", 21, 0)
        before = self.clean_png()
        self.click_source(450.5, 300.5)
        erased = self.clean_png()
        self.page.locator("#undo-point").click()
        self.assertTrue(self.page.locator("#redo-mask").is_enabled())
        a = self.point_on_page(400.5, 280.5)
        b = self.point_on_page(510.5, 320.5)
        cdp = self.context.new_cdp_session(self.page)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{**a, "id": 1}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{**a, "id": 1}, {**b, "id": 2}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [
            {"x": a["x"] - 20, "y": a["y"], "id": 1},
            {"x": b["x"] + 20, "y": b["y"], "id": 2},
        ]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        self.assertEqual(self.clean_png(), before)
        self.assertTrue(self.page.locator("#redo-mask").is_enabled())
        self.page.locator("#redo-mask").click()
        self.assertEqual(self.clean_png(), erased)

    def test_focused_refinement_locks_unpainted_alpha_and_disables_edits(self):
        before = self.clean_image().getchannel("A")
        self.page.locator("#focus-edges").click()
        self.range_value("#brush-size", 101)
        self.range_value("#brush-hardness", 100)
        self.click_source(160.5, 300.5)
        self.range_value("#edge-strength", 100)
        locks = self.page.evaluate("""() => {
            document.querySelector('#refine-edges').click();
            return ['undo-point','redo-mask','erase-mask','restore-mask','use-cutout']
              .map(id=>document.getElementById(id).disabled);
        }""")
        self.assertEqual(locks, [True] * 5)
        self.page.wait_for_function("document.querySelector('#cutout-status').textContent.includes('Edges refined')")
        after = self.clean_image().getchannel("A")
        changed = 0
        for i, (a, b) in enumerate(zip(before.tobytes(), after.tobytes())):
            if a != b:
                changed += 1
                self.assertLess(math.hypot(i % WIDTH - 160, i // WIDTH - 300), 50.5)
        self.assertGreater(changed, 0)

    def test_inspection_background_does_not_enter_clean_png(self):
        before = self.clean_png()
        self.page.locator("#editor-background").select_option("light")
        self.assertEqual(self.clean_png(), before)
        self.page.locator("#editor-background").select_option("dark")
        self.assertEqual(self.clean_png(), before)
        self.page.locator("#compare-original").check()
        self.assertEqual(self.clean_png(), before)
        self.assertEqual(Image.open(io.BytesIO(before)).getpixel((80, 80))[3], 0)

    def test_cleaned_color_persists_after_save_reload_and_focused_refinement(self):
        baseline = self.clean_png()
        self.range_value("#edge-cleanup", 80)
        self.refine()
        cleaned = self.clean_png()
        self.assertNotEqual(cleaned, baseline)
        self.page.locator("#use-cutout").click()
        self.page.wait_for_selector("#editor-dialog", state="hidden")
        self.page.locator("#save-object").click()
        self.page.wait_for_function("document.querySelector('#collection-count').textContent === '2'")
        saved = self.page.evaluate("""() => new Promise((resolve,reject) => {
            const req=indexedDB.open('irling-moments',1);
            req.onsuccess=()=>{
              const read=req.result.transaction('moments','readonly').objectStore('moments').getAll();
              read.onsuccess=()=>resolve(read.result.find(x=>x.id!=='editor-fixture'));
              read.onerror=()=>reject(read.error);
            }; req.onerror=()=>reject(req.error);
        })""")
        self.assertTrue(saved.get("colors"))
        original_colors = Image.open(io.BytesIO(base64.b64decode(
            self.moment["source"].split(",", 1)[1]))).convert("RGBA")
        saved_colors = Image.open(io.BytesIO(base64.b64decode(
            saved["colors"].split(",", 1)[1]))).convert("RGBA")
        self.assertNotEqual(saved_colors.tobytes(), original_colors.tobytes(),
                            "The fixture should exercise actual color correction")
        self.page.reload(wait_until="networkidle")
        self.page.wait_for_function("document.querySelector('#collection-count').textContent === '2'")
        self.page.locator("#collection-nav").click()
        saved_index = self.page.locator(".collection-use").evaluate_all(
            "(buttons, data) => buttons.findIndex(button=>button.querySelector('img').src===data)",
            saved["data"],
        )
        self.assertGreaterEqual(saved_index, 0)
        self.page.locator(".collection-use").nth(saved_index).click()
        self.page.wait_for_selector("#collection-dialog", state="hidden")
        self.page.locator("#edit-object").click()
        self.page.wait_for_selector("#editor-dialog[open]")
        self.open_tools()
        self.assertEqual(self.clean_png(), cleaned)
        self.page.locator("#focus-edges").click()
        self.range_value("#brush-size", 31)
        self.range_value("#brush-hardness", 100)
        self.click_source(650.5, 300.5)
        self.range_value("#edge-cleanup", 0)
        self.refine()
        focused = self.clean_image()
        previous = Image.open(io.BytesIO(cleaned)).convert("RGBA")
        # Previous cleaned colors on the opposite edge must survive another
        # refinement limited to a small area, including cleanup being off.
        self.assertEqual(focused.crop((145, 120, 175, 480)).tobytes(),
                         previous.crop((145, 120, 175, 480)).tobytes())
        focused_before = self.clean_png()
        self.range_value("#edge-cleanup", 80)
        self.refine()
        cleaned_again = self.clean_image()
        self.assertEqual(cleaned_again.crop((145, 120, 175, 480)).tobytes(),
                         previous.crop((145, 120, 175, 480)).tobytes())
        self.page.locator("#undo-point").click()
        self.assertEqual(self.clean_png(), focused_before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
