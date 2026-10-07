"""Browser smoke tests. Run against `npm run dev` with Python Playwright installed."""
import os
import struct
import unittest
import zlib
from playwright.sync_api import sync_playwright


def fixture_png():
    """A real, self-contained RGB PNG, avoiding test fixture dependencies."""
    width, height = 600, 400
    def chunk(kind, payload):
        return struct.pack('!I', len(payload)) + kind + payload + struct.pack('!I', zlib.crc32(kind + payload))
    pixels = b''.join(b'\0' + b''.join(bytes((225, 92, 54)) if 120<x<480 and 70<y<330 else bytes((220, 230, 205)) for x in range(width)) for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B',width,height,8,2,0,0,0)) + chunk(b'IDAT',zlib.compress(pixels)) + chunk(b'IEND',b'')


class StudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'), args=['--no-sandbox'])
        cls.photo = fixture_png()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width':1440,'height':1100}, accept_downloads=True, has_touch=True)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto(os.environ.get('STUDIO_URL','http://127.0.0.1:3001'), wait_until='networkidle')
        self.page.wait_for_function("document.querySelector('#sticker-canvas').getAttribute('aria-label').includes('flower')")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], 'Browser JavaScript errors')

    def click_option(self, group, value):
        self.page.locator(f'#{group}-options button[data-value="{value}"]').click()

    def test_configuration_and_demo_checkout(self):
        page = self.page
        self.assertEqual(page.locator('#total-price').inner_text(), '$18.00')
        self.click_option('shape','circle')
        self.assertEqual(page.locator('#measurement').inner_text(), '3″ × 3″')
        matte = page.locator('#sticker-canvas').screenshot()
        self.click_option('finish','holographic')
        self.assertNotEqual(matte, page.locator('#sticker-canvas').screenshot())
        self.assertEqual(page.locator('#total-price').inner_text(), '$26.10')
        self.click_option('size','4')
        self.click_option('quantity','100')
        self.assertEqual(page.locator('#total-price').inner_text(), '$90.05')
        self.click_option('shape','oval')
        self.assertEqual(page.locator('#measurement').inner_text(), '4″ × 3″')
        page.locator('#checkout-button').click()
        self.assertTrue(page.locator('#checkout-dialog').is_visible())
        self.assertIn('100 oval stickers', page.locator('#checkout-content').inner_text())
        self.assertIn('$90.05',page.locator('#checkout-content').inner_text())
        page.locator('#place-demo-order').click()
        self.assertIn('You’re irl’ing.',page.locator('#checkout-content').inner_text())
        self.assertIn('$0 charged',page.locator('#checkout-content').inner_text())
        self.assertIn('Nothing is being printed or shipped',page.locator('#checkout-content').inner_text())
        page.locator('#make-another').click()
        self.assertFalse(page.locator('#checkout-dialog').is_visible())

    def test_collection_persistence_and_removal(self):
        page = self.page
        page.locator('#save-object').click()
        self.assertEqual(page.locator('#collection-count').inner_text(),'1')
        page.locator('#save-object').click()
        self.assertEqual(page.locator('#collection-count').inner_text(),'1')
        page.reload(wait_until='networkidle')
        self.assertEqual(page.locator('#collection-count').inner_text(),'1')
        page.locator('#collection-nav').click()
        self.assertEqual(page.locator('.collection-card').count(),1)
        page.locator('.collection-use').click()
        page.wait_for_selector('#collection-dialog', state='hidden')
        self.assertFalse(page.locator('#collection-dialog').is_visible())
        page.locator('#collection-nav').click()
        page.get_by_role('button',name='Remove The afternoon flower').click()
        self.assertIn('Nothing here. Yet.',page.locator('#collection-grid').inner_text())
        self.assertEqual(page.locator('#collection-count').inner_text(),'0')

    def test_upload_trace_undo_export_and_reopen(self):
        page = self.page
        requests = []
        page.on('request',lambda request: requests.append(request) if request.method == 'POST' else None)
        page.locator('#photo-input').set_input_files({'name':'my-moment.png','mimeType':'image/png','buffer':self.photo})
        page.wait_for_selector('#editor-dialog[open]')
        page.locator('#trace-image').click()
        self.assertTrue(page.locator('#use-cutout').is_disabled())
        canvas = page.locator('#editor-canvas')
        box = canvas.bounding_box()
        for x,y in [(.2,.17),(.8,.17),(.8,.83),(.2,.83)]:
            canvas.click(position={'x':box['width']*x,'y':box['height']*y})
        self.assertIn('4 outline points',page.locator('#point-count').inner_text())
        page.locator('#undo-point').click()
        self.assertIn('3 outline points',page.locator('#point-count').inner_text())
        canvas.click(position={'x':box['width']*.2,'y':box['height']*.83})
        page.locator('#use-cutout').click()
        page.wait_for_selector('#editor-dialog',state='hidden')
        self.assertEqual(page.locator('#asset-status').inner_text(),'Your moment')
        selected = page.evaluate('({width: state.image.width, height: state.image.height})')
        self.assertLess(selected['width'], 600)
        self.assertLess(selected['height'], 400)
        self.assertTrue(page.locator('#quality-note').is_visible())
        page.locator('#save-object').click()
        with page.expect_download() as download_info:
            page.locator('#download-art').click()
        download = download_info.value
        self.assertTrue(download.suggested_filename.endswith('-preview.png'))
        with open(download.path(),'rb') as file:
            data = file.read()
        self.assertEqual(data[:8],b'\x89PNG\r\n\x1a\n')
        self.assertGreater(len(data),1000)
        page.locator('#edit-object').click()
        page.wait_for_selector('#editor-dialog[open]')
        self.assertTrue(page.locator('#editor-dialog').is_visible())
        self.assertEqual(page.locator('#point-count').inner_text(),'Whole image selected')
        page.locator('#editor-dialog .dialog-close').click()
        page.reload(wait_until='networkidle')
        page.locator('#collection-nav').click()
        page.get_by_role('button',name='my-moment',exact=True).click()
        page.wait_for_function("document.querySelector('#sticker-canvas').getAttribute('aria-label').includes('my-moment')")
        self.assertEqual(requests, [], 'Photos must remain local')

    def test_invalid_upload_and_restricted_storage(self):
        page = self.page
        page.locator('#photo-input').set_input_files({'name':'not-a-photo.txt','mimeType':'text/plain','buffer':b'not a photo'})
        self.assertIn('Try a JPG',page.locator('#toast').inner_text())
        page.locator('#photo-input').set_input_files({'name':'broken.png','mimeType':'image/png','buffer':b'not a png'})
        page.wait_for_function("document.querySelector('#toast').textContent.includes('could not be opened')")
        self.assertFalse(page.locator('#editor-dialog').is_visible())
        page.evaluate("() => { Storage.prototype.setItem = () => { throw new DOMException('Quota exceeded','QuotaExceededError'); }; }")
        page.locator('#save-object').click()
        self.assertIn('couldn’t save',page.locator('#toast').inner_text())
        self.assertEqual(page.locator('#collection-count').inner_text(),'0')

    def test_mobile_layout_and_touch_flow(self):
        page = self.page
        for width in [320,390,650,768,1024]:
            page.set_viewport_size({'width':width,'height':844})
            self.assertTrue(page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Overflow at {width}px')
        page.set_viewport_size({'width':390,'height':844})
        page.get_by_role('button',name='A very good cherry season',exact=True).tap()
        page.wait_for_function("document.querySelector('#sticker-canvas').getAttribute('aria-label').includes('cherry')")
        page.locator('#checkout-button').click()
        self.assertTrue(page.locator('#place-demo-order').is_visible())
        self.assertTrue(page.locator('#checkout-dialog').evaluate('(el) => el.scrollWidth <= el.clientWidth'))
        page.locator('#place-demo-order').click()
        page.locator('#make-another').click()
        page.locator('#upload-button').click()
        self.assertTrue(page.locator('#take-photo').is_visible())
        page.keyboard.press('Escape')
        self.assertFalse(page.locator('#upload-dialog').is_visible())


if __name__ == '__main__':
    unittest.main(verbosity=2)
