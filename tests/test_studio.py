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
        page.wait_for_function("document.querySelector('#collection-count').textContent === '1'")
        page.locator('#save-object').click()
        page.wait_for_function("document.querySelector('#collection-count').textContent === '1'")
        page.reload(wait_until='networkidle')
        page.wait_for_function("document.querySelector('#collection-count').textContent === '1'")
        page.locator('#collection-nav').click()
        self.assertEqual(page.locator('.collection-card').count(),1)
        page.locator('.collection-use').click()
        page.wait_for_selector('#collection-dialog', state='hidden')
        self.assertFalse(page.locator('#collection-dialog').is_visible())
        page.locator('#collection-nav').click()
        page.get_by_role('button',name='Remove The afternoon flower').click()
        page.wait_for_function("document.querySelector('#collection-grid').textContent.includes('Nothing here. Yet.')")
        page.wait_for_function("document.querySelector('#collection-count').textContent === '0'")

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
        self.assertTrue(page.locator('#quality-note').is_visible())
        page.locator('#save-object').click()
        page.wait_for_function("document.querySelector('#collection-count').textContent === '1'")
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
        self.assertIn('Background removed',page.locator('#point-count').inner_text())
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
        page.evaluate("() => { IDBObjectStore.prototype.put = () => { throw new DOMException('Quota exceeded','QuotaExceededError'); }; }")
        page.locator('#save-object').click()
        page.wait_for_function("document.querySelector('#toast').textContent.includes('couldn’t save')")
        page.wait_for_function("document.querySelector('#collection-count').textContent === '0'")

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

    def test_real_background_removal_brush_and_saved_configuration(self):
        page = self.page
        page.locator('#photo-input').set_input_files({'name':'subject.png','mimeType':'image/png','buffer':self.photo})
        page.wait_for_selector('#editor-dialog[open]')
        page.wait_for_function("document.querySelector('#auto-cutout').getAttribute('aria-busy') === 'false'", timeout=100000)
        self.assertIn('Your subject is ready',page.locator('#cutout-status').inner_text())
        self.assertIn('Background removed',page.locator('#point-count').inner_text())
        canvas=page.locator('#editor-canvas')
        alpha=canvas.evaluate("c=>{const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let clear=0,solid=0; for(let i=3;i<d.length;i+=4){if(d[i]<20)clear++;if(d[i]>230)solid++;} return {clear,solid};}")
        self.assertGreater(alpha['clear'],1000)
        self.assertGreater(alpha['solid'],1000)
        before=canvas.evaluate("c=>c.toDataURL()")
        page.locator('#erase-mask').click()
        box=canvas.bounding_box()
        canvas.click(position={'x':box['width']/2,'y':box['height']/2})
        erased=canvas.evaluate("c=>c.toDataURL()")
        self.assertNotEqual(before,erased)
        page.locator('#undo-point').click()
        self.assertEqual(before,canvas.evaluate("c=>c.toDataURL()"))
        page.locator('#compare-original').check()
        self.assertNotEqual(before,canvas.evaluate("c=>c.toDataURL()"))
        page.locator('#compare-original').uncheck()
        page.locator('#use-cutout').click()
        page.wait_for_selector('#editor-dialog',state='hidden')
        self.click_option('shape','oval')
        self.click_option('finish','glossy')
        self.click_option('size','4')
        self.click_option('quantity','50')
        page.locator('#save-object').click()
        page.wait_for_function("document.querySelector('#collection-count').textContent === '1'")
        page.reload(wait_until='networkidle')
        page.locator('#collection-nav').click()
        page.get_by_role('button',name='subject',exact=True).click()
        page.wait_for_selector('#collection-dialog',state='hidden')
        self.assertEqual(page.locator('#shape-options [aria-pressed=true]').get_attribute('data-value'),'oval')
        self.assertEqual(page.locator('#quantity-options [aria-pressed=true]').get_attribute('data-value'),'50')
        page.locator('#edit-object').click()
        page.wait_for_selector('#editor-dialog[open]')
        self.assertIn('Your saved cutout is ready',page.locator('#cutout-status').inner_text())

    def test_model_failure_allows_manual_fallback(self):
        page=self.page
        page.route('**/models/u2netp.onnx',lambda route:route.fulfill(status=503,body='unavailable'))
        page.locator('#photo-input').set_input_files({'name':'offline.png','mimeType':'image/png','buffer':self.photo})
        page.wait_for_selector('#editor-dialog[open]')
        page.wait_for_function("document.querySelector('#cutout-status').classList.contains('error')", timeout=30000)
        self.assertIn('couldn’t load',page.locator('#cutout-status').inner_text())
        page.locator('#whole-image').click()
        page.locator('#use-cutout').click()
        page.wait_for_selector('#editor-dialog',state='hidden')
        self.assertEqual(page.locator('#asset-status').inner_text(),'Your moment')

    def test_legacy_collection_migrates_without_losing_saved_moments(self):
        page=self.page
        page.evaluate("localStorage.setItem('irling.moments.v1',JSON.stringify([{id:'legacy',name:'An old moment',data:'/assets/cherries.svg',sample:true}]))")
        page.reload(wait_until='networkidle')
        page.wait_for_function("document.querySelector('#collection-count').textContent === '1'")
        self.assertIsNone(page.evaluate("localStorage.getItem('irling.moments.v1')"))
        page.locator('#collection-nav').click()
        self.assertTrue(page.get_by_role('button',name='An old moment',exact=True).is_visible())

    def test_phone_entry_opens_photo_picker_without_scrolling(self):
        page=self.page
        for width,height in [(320,568),(390,844),(430,932)]:
            page.set_viewport_size({'width':width,'height':height})
            page.evaluate('scrollTo(0,0)')
            for selector in ['#start-photo','#start-camera']:
                bounds=page.locator(selector).bounding_box()
                self.assertGreaterEqual(bounds['y'],0)
                self.assertLessEqual(bounds['y']+bounds['height'],height)
                self.assertGreaterEqual(bounds['height'],44)
        page.set_viewport_size({'width':390,'height':844})
        with page.expect_file_chooser() as picker:
            page.locator('#start-photo').tap()
        picker.value.set_files({'name':'phone-photo.png','mimeType':'image/png','buffer':self.photo})
        page.wait_for_selector('#editor-dialog[open]')
        page.locator('#whole-image').click()
        page.locator('#use-cutout').click()
        page.wait_for_selector('#editor-dialog',state='hidden')
        self.assertEqual(page.locator('.flow-steps [aria-current=step]').get_attribute('data-step'),'sticker')
        page.locator('#customize-sticker').tap()
        page.wait_for_function("document.activeElement.id === 'config-title'")
        self.assertTrue(page.locator('#shape-options').is_visible())

    def test_phone_example_runs_real_cutout_without_a_file_upload(self):
        page=self.page
        page.set_viewport_size({'width':390,'height':844})
        page.locator('#try-example').tap()
        page.wait_for_selector('#editor-dialog[open]')
        page.wait_for_function("document.querySelector('#auto-cutout').getAttribute('aria-busy') === 'false'",timeout=100000)
        self.assertIn('Your subject is ready',page.locator('#cutout-status').inner_text())
        page.locator('#use-cutout').tap()
        page.wait_for_selector('#editor-dialog',state='hidden')
        self.assertIn('An afternoon find',page.locator('#sticker-canvas').get_attribute('aria-label'))
        self.assertTrue(page.locator('#customize-sticker').is_visible())

    def test_import_error_is_visible_inside_photo_dialog(self):
        page=self.page
        page.locator('#upload-button').click()
        with page.expect_file_chooser() as picker:
            page.locator('#choose-photo').click()
        picker.value.set_files({'name':'broken.heic','mimeType':'image/heic','buffer':b'not a valid HEIC'})
        page.wait_for_selector('#upload-error:not([hidden])')
        self.assertIn('HEIC',page.locator('#upload-error').inner_text())
        self.assertTrue(page.locator('#upload-error').is_visible())
        self.assertTrue(page.locator('#choose-photo').is_enabled())
        self.assertTrue(page.locator('#upload-dialog').is_visible())


if __name__ == '__main__':
    unittest.main(verbosity=2)
