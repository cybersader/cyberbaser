import { describe, expect, test } from 'bun:test';
import {
  ASSET_LIMITS, checkAsset, extensionType, hasLocation, imageEmbeds, MediaError, remoteImageEmbeds, sniffImage, stripLocation,
} from '../src/index.js';
import { exifTiff, GIF, jpeg, png, pngChunk, SVG, WEBP, webpWithExif, xmpPacket } from './fixtures.js';

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');

describe('type and structure', () => {
  test('real PNG, JPEG, WebP and GIF pass with their media type', () => {
    expect(checkAsset('a/cover.png', png())).toEqual({ ok: true, type: 'png', mediaType: 'image/png' });
    expect(checkAsset('a/cover.jpg', jpeg())).toEqual({ ok: true, type: 'jpeg', mediaType: 'image/jpeg' });
    expect(checkAsset('a/cover.JPEG', jpeg())).toMatchObject({ ok: true, type: 'jpeg' });
    expect(checkAsset('a/cover.webp', WEBP)).toEqual({ ok: true, type: 'webp', mediaType: 'image/webp' });
    expect(checkAsset('a/cover.gif', GIF)).toEqual({ ok: true, type: 'gif', mediaType: 'image/gif' });
  });

  test('SVG is refused by bytes and by name (asset-type-refused)', () => {
    expect(sniffImage(SVG)).toBe('svg');
    expect(checkAsset('a/logo.svg', SVG)).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(checkAsset('a/logo.png', SVG)).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(checkAsset('a/logo.svg', png())).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(extensionType('a/x.svg')).toBeNull();
  });

  test('other files and unknown names are refused', () => {
    expect(checkAsset('a/x.html', png())).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(checkAsset('a/x.png', Uint8Array.from(Buffer.from('<html><script>1</script></html>')))).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(checkAsset('a/x.png', 'not bytes')).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(checkAsset('a/noext', png())).toEqual({ ok: false, code: 'asset-type-refused' });
  });

  test('a PNG renamed to .jpg is a mismatch (asset-type-mismatch)', () => {
    expect(checkAsset('a/photo.jpg', png())).toEqual({ ok: false, code: 'asset-type-mismatch' });
    expect(checkAsset('a/photo.gif', WEBP)).toEqual({ ok: false, code: 'asset-type-mismatch' });
  });

  test('a polyglot or anything after the image end is refused', () => {
    const html = [...Buffer.from('<html><script>alert(1)</script></html>')];
    expect(checkAsset('a/x.png', png({ trailing: html }))).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(checkAsset('a/x.jpg', jpeg({ trailing: html }))).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(checkAsset('a/x.gif', Uint8Array.from([...GIF, ...html]))).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(checkAsset('a/x.webp', Uint8Array.from([...WEBP, ...html]))).toEqual({ ok: false, code: 'asset-type-refused' });
  });

  test('truncated or damaged structures are refused', () => {
    expect(checkAsset('a/x.png', png().subarray(0, 40))).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(checkAsset('a/x.jpg', jpeg().subarray(0, 30))).toEqual({ ok: false, code: 'asset-type-refused' });
    expect(checkAsset('a/x.gif', GIF.subarray(0, GIF.length - 1))).toEqual({ ok: false, code: 'asset-type-refused' });
  });

  test('5 MiB + 1 byte is too large (asset-too-large)', () => {
    const big = new Uint8Array(ASSET_LIMITS.maxAssetBytes + 1);
    big.set(png());
    expect(checkAsset('a/x.png', big)).toEqual({ ok: false, code: 'asset-too-large' });
  });
});

describe('location', () => {
  test('a JPEG whose Exif records GPS is refused (image-has-location), big and little endian', () => {
    expect(checkAsset('a/p.jpg', jpeg({ exif: exifTiff() }))).toEqual({ ok: false, code: 'image-has-location' });
    expect(checkAsset('a/p.jpg', jpeg({ exif: exifTiff({ littleEndian: true }) }))).toEqual({ ok: false, code: 'image-has-location' });
    expect(checkAsset('a/p.jpg', jpeg({ exif: exifTiff({ gps: false }) }))).toMatchObject({ ok: true });
  });

  test('XMP location, PNG eXIf, WebP EXIF and unreadable Exif all count', () => {
    expect(checkAsset('a/p.jpg', jpeg({ xmp: xmpPacket(true) })).code).toBe('image-has-location');
    expect(checkAsset('a/p.jpg', jpeg({ xmp: xmpPacket(false) })).ok).toBe(true);
    expect(checkAsset('a/p.png', png({ extra: [pngChunk('eXIf', [...exifTiff()])] })).code).toBe('image-has-location');
    expect(checkAsset('a/p.webp', webpWithExif(exifTiff())).code).toBe('image-has-location');
    expect(checkAsset('a/p.jpg', jpeg({ exif: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) })).code).toBe('image-has-location');
    const compressedXmp = pngChunk('zTXt', [...Buffer.from('XML:com.adobe.xmp\0\0'), 120, 156, 3, 0, 0, 0, 0, 1]);
    expect(checkAsset('a/p.png', png({ extra: [compressedXmp] })).code).toBe('image-has-location');
  });

  test('the stripper removes GPS from a JPEG and keeps orientation and pixels', () => {
    const original = jpeg({ exif: exifTiff(), xmp: xmpPacket(true) });
    expect(hasLocation(original)).toBe(true);
    const { bytes, changed, type } = stripLocation(original);
    expect([changed, type]).toEqual([true, 'jpeg']);
    expect(checkAsset('a/p.jpg', bytes)).toMatchObject({ ok: true });
    expect(hasLocation(bytes)).toBe(false);
    // No coordinate bytes survive anywhere in the file.
    expect(latin1(bytes)).not.toContain('GPSLatitude');
    const tail = latin1(jpeg().subarray(2));
    expect(latin1(bytes).endsWith(tail)).toBe(true);
    // Orientation (tag 0x0112 = 6) is still in IFD0.
    expect(latin1(bytes)).toContain(latin1(Uint8Array.from([0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0, 6])));
    for (const rational of [47, 122]) expect(latin1(bytes)).not.toContain(latin1(Uint8Array.from([0, 0, 0, rational, 0, 0, 0, 1])));
  });

  test('little-endian Exif is cleaned the same way', () => {
    const { bytes } = stripLocation(jpeg({ exif: exifTiff({ littleEndian: true }) }));
    expect(checkAsset('a/p.jpg', bytes)).toMatchObject({ ok: true });
  });

  test('PNG and WebP: the eXIf / EXIF chunk is dropped and the file stays well formed', () => {
    const cleanPng = stripLocation(png({ extra: [pngChunk('eXIf', [...exifTiff()])] }));
    expect(cleanPng.changed).toBe(true);
    expect(Buffer.from(cleanPng.bytes).equals(Buffer.from(png()))).toBe(true);
    const cleanWebp = stripLocation(webpWithExif(exifTiff()));
    expect(checkAsset('a/p.webp', cleanWebp.bytes)).toMatchObject({ ok: true });
    expect(cleanWebp.bytes[20] & 0x08).toBe(0);
    expect(latin1(cleanWebp.bytes)).not.toContain('EXIF');
  });

  test('a clean image is returned unchanged; trailing data is cut', () => {
    const plain = jpeg({ exif: exifTiff({ gps: false }) });
    expect(stripLocation(plain)).toEqual({ bytes: plain, type: 'jpeg', changed: false });
    const cut = stripLocation(png({ trailing: [1, 2, 3] }));
    expect(Buffer.from(cut.bytes).equals(Buffer.from(png()))).toBe(true);
  });

  test('the stripper refuses SVG and damaged files', () => {
    expect(() => stripLocation(SVG)).toThrow(MediaError);
    try { stripLocation(png().subarray(0, 20)); } catch (error) { expect(error.code).toBe('asset-type-refused'); }
  });
});

describe('embeds', () => {
  test('wiki, Markdown and HTML image embeds are listed; code is ignored', () => {
    const text = '---\ntitle: x\n---\n![[cover.webp|300]]\n![alt](attachments/a.png)\n<img src="b.gif">\n`![[no.png]]`\n';
    expect(imageEmbeds(text).map((embed) => embed.target)).toEqual(['cover.webp', 'attachments/a.png', 'b.gif']);
  });

  test('remote, protocol-relative and data: images are found (remote-image-refused upstream)', () => {
    const text = '![a](https://x.example/a.png) ![b](//x.example/b.png) ![c](data:image/png;base64,AA==) ![d](local.png)\n'
      + '<img src="local.png" srcset="https://x.example/2x.png 2x">';
    expect(remoteImageEmbeds(text).map((embed) => embed.kind)).toEqual(['md-image', 'md-image', 'md-image', 'html-attribute']);
    expect(remoteImageEmbeds('![[local.png]] ![x](a/b.png)')).toEqual([]);
  });
});
