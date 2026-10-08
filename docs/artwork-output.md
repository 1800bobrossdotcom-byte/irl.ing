# Artwork, outlines, and placement

The studio separates downloadable artwork from its display preview. Artwork contains the cutout and chosen white outline or sticker shape on a transparent background. Glossy/holographic effects, garment illustrations, shadows, grids and captions belong to the preview only.

## Uniform outline

For die-cut artwork, a binary silhouette supplies an exact separable Euclidean distance transform. An antialiased outward offset is computed from distance to that silhouette. This replaces the previous 64 overlapping image copies, giving the same requested distance around horizontal, vertical and diagonal contours. The artwork itself retains its original fractional alpha and color; the threshold supplies border geometry rather than a new hard cutout mask.

The geometry threshold is 128/255, capped to the strongest source alpha for entirely translucent artwork. The total outline allowance shown by the slider is split equally between the two sides of the longest edge: 8% gives 4% on each side. A two-pixel transparent guard remains beyond the offset. Holes are preserved unless the offset naturally closes a gap smaller than twice its radius. Preview distances are cached for smooth border adjustments.

Circle and oval sticker shapes center the entire artwork rectangle inside an inner ellipse, retaining its corners instead of clipping the photo. These framed shapes are distinct from a contour-following die-cut border.

## Resolution and physical size

Normal imports retain up to a 2400-pixel edge and four megapixels. Devices reporting at most 2 GB memory retain up to 1600 pixels and two megapixels. The file limit remains 20 MB. The bundled SVG illustrations are rasterized at higher resolution for the studio. Existing saved photos keep their original stored pixel dimensions.

The artwork export targets approximately 300 DPI at the selected longest-edge size. Larger sources are downsampled; smaller sources remain at their available resolution, with no invented upscaling. The displayed pixel dimensions and effective DPI include the outline and transparent guard. PNG `pHYs` metadata encodes the actual exported density, so the complete image rectangle has the selected physical size even when its density is below 300 DPI. Changing this metadata never changes the image data or color-profile chunks.

A low-resolution note suggests a larger photo or smaller print. Changing metadata, adding a border, or enlarging a mockup cannot restore missing image detail. Existing visible-alpha crop behavior uses alpha above 8/255 to establish the cutout bounds; faint pixels within those bounds remain intact. Inference and source resolution still limit hair detail.

Each native export briefly releases the idle segmentation model to leave room for the larger canvas and distance buffers. The editor stays simple, and no automatic sharpening is applied to translucent hair or mixed-color edges.

## Products and placement

Sticker sizes remain 2, 3 and 4 inches. T-shirt and sweatshirt front-print previews offer 8, 10 and 12 inches on the longest edge. Both garment illustrations share one placement rectangle centered on their seam axis, and the artwork is fitted without stretching. Print size changes artwork scale inside that rectangle; border settings remain available for all products, including zero border. Product, size and border choices are saved with the moment.

Garments are illustrated mockups, not manufacturer templates. Their PNG artwork exports contain the graphic alone; preview downloads contain the garment view. Garment pricing and checkout are not shown. Sticker pricing and checkout remain explicitly illustrative demos. These PNGs are suitable inputs for a print-design workflow, not provider-certified production files, vector cutting contours, garment underbase separations or manufacturing proofs.

## Validation

`npm test` covers exact distances against an independently enumerated baseline, symmetry and fractional-radius coverage, nonmutation of artwork alpha, centered layouts, source-resolution limits, and PNG checksum/density/image-data preservation.

Production browser workflows cover symmetric round-subject outlines, soft source alpha at zero border, native exports and physical dimensions, finish-independent image pixels, centered garment mockups, garment-free artwork files, saved product restoration, normal/low-memory imports, and mobile layouts. They run with Chromium mobile emulation rather than hardware phones or Safari.
