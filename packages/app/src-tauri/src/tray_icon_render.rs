/// Threshold-tinted variants of the tray icon, cached after first render.
///
/// The source PNG (`icons/tray-icon.png`) is a Sentinel logo silhouette with
/// an alpha channel for antialiased edges. For each tint we replace the RGB
/// of every non-transparent pixel with the tint color, preserving the
/// original alpha so the icon edges stay smooth.
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray-icon.png");

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TintColor {
    /// `<70%` — calm.
    Blue,
    /// `70–89%` — warning.
    Orange,
    /// `>=90%` — danger.
    Red,
    /// Unknown / no data.
    Gray,
}

impl TintColor {
    /// (R, G, B) — matches `tailwind.config.js` ios-blue/orange/red/gray.
    fn rgb(self) -> (u8, u8, u8) {
        match self {
            TintColor::Blue => (0x00, 0x7A, 0xFF),
            TintColor::Orange => (0xFF, 0x9F, 0x0A),
            TintColor::Red => (0xFF, 0x45, 0x3A),
            TintColor::Gray => (0x8E, 0x8E, 0x93),
        }
    }
}

#[derive(Debug)]
pub struct RgbaBuffer {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

static CACHE: OnceLock<std::sync::Mutex<HashMap<TintColor, Arc<RgbaBuffer>>>> = OnceLock::new();

fn cache() -> &'static std::sync::Mutex<HashMap<TintColor, Arc<RgbaBuffer>>> {
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Rendered-digit cache, keyed by (percentage, tint). Bounded: at most
/// 101 percentages × 4 tints of 32×32 buffers, and in practice each pct
/// only ever pairs with its threshold color.
static DIGIT_CACHE: OnceLock<std::sync::Mutex<HashMap<(u8, TintColor), Arc<RgbaBuffer>>>> =
    OnceLock::new();

fn digit_cache() -> &'static std::sync::Mutex<HashMap<(u8, TintColor), Arc<RgbaBuffer>>> {
    DIGIT_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// 3×5 bitmap digit font, one row per array entry, low 3 bits = columns
/// (bit 2 = leftmost). The smallest fully-legible numeric font; scaled up
/// with nearest-neighbor it stays crisp at tray-icon sizes, and being
/// hand-rolled it needs no font dependency or embedded TTF.
const DIGIT_FONT: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], // 0
    [0b010, 0b110, 0b010, 0b010, 0b111], // 1
    [0b111, 0b001, 0b111, 0b100, 0b111], // 2
    [0b111, 0b001, 0b111, 0b001, 0b111], // 3
    [0b101, 0b101, 0b111, 0b001, 0b001], // 4
    [0b111, 0b100, 0b111, 0b001, 0b111], // 5
    [0b111, 0b100, 0b111, 0b101, 0b111], // 6
    [0b111, 0b001, 0b001, 0b010, 0b010], // 7
    [0b111, 0b101, 0b111, 0b101, 0b111], // 8
    [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];

const DIGIT_W: u32 = 3;
const DIGIT_H: u32 = 5;
/// Blank column between adjacent digits, in font units.
const DIGIT_GAP: u32 = 1;
/// Canvas matches the logo PNG so `set_icon` swaps between them cleanly.
const DIGIT_CANVAS: u32 = 32;

/// Decimal digit indices of `pct`, most significant first (7 → [7],
/// 47 → [4, 7], 100 → [1, 0, 0]).
fn glyphs_for(pct: u8) -> Vec<usize> {
    let mut digits: Vec<usize> = Vec::with_capacity(3);
    let mut n = u32::from(pct.min(100));
    loop {
        digits.push((n % 10) as usize);
        n /= 10;
        if n == 0 {
            break;
        }
    }
    digits.reverse();
    digits
}

/// Render `pct` as threshold-colored digits on a transparent 32×32 RGBA
/// buffer. Used for the Windows tray icon, where `set_title` is a no-op so
/// the number must live inside the icon itself. Cached per (pct, color).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn digits(pct: u8, color: TintColor) -> Arc<RgbaBuffer> {
    let pct = pct.min(100);
    {
        let map = digit_cache().lock().expect("digit-cache mutex poisoned");
        if let Some(buf) = map.get(&(pct, color)) {
            return buf.clone();
        }
    }

    let glyphs = glyphs_for(pct);
    let n = glyphs.len() as u32;
    let ink_w = n * DIGIT_W + (n - 1) * DIGIT_GAP;
    // Nearest-neighbor integer upscale, sized to fill the canvas: 6× for one
    // digit, 4× for two, 2× for three ("100").
    let scale = (DIGIT_CANVAS / ink_w).min(DIGIT_CANVAS / DIGIT_H).max(1);
    let x_off = (DIGIT_CANVAS - ink_w * scale) / 2;
    let y_off = (DIGIT_CANVAS - DIGIT_H * scale) / 2;

    let (r, g, b) = color.rgb();
    let mut bytes = vec![0u8; (DIGIT_CANVAS * DIGIT_CANVAS * 4) as usize];
    for (i, &glyph) in glyphs.iter().enumerate() {
        let glyph_x = x_off + (i as u32) * (DIGIT_W + DIGIT_GAP) * scale;
        for (row, mask) in DIGIT_FONT[glyph].iter().enumerate() {
            for col in 0..DIGIT_W {
                if mask & (1 << (DIGIT_W - 1 - col)) == 0 {
                    continue;
                }
                let px = glyph_x + col * scale;
                let py = y_off + (row as u32) * scale;
                for y in py..py + scale {
                    for x in px..px + scale {
                        let at = ((y * DIGIT_CANVAS + x) * 4) as usize;
                        bytes[at] = r;
                        bytes[at + 1] = g;
                        bytes[at + 2] = b;
                        bytes[at + 3] = 0xFF;
                    }
                }
            }
        }
    }

    let buf = Arc::new(RgbaBuffer {
        bytes,
        width: DIGIT_CANVAS,
        height: DIGIT_CANVAS,
    });
    let mut map = digit_cache().lock().expect("digit-cache mutex poisoned");
    map.entry((pct, color))
        .or_insert_with(|| buf.clone())
        .clone()
}

/// Returns the tinted icon for `color`, decoding+tinting once and caching.
/// Panics only if the embedded PNG fails to decode — which would be a build-time
/// regression, not a runtime condition.
pub fn tinted(color: TintColor) -> Arc<RgbaBuffer> {
    {
        let map = cache().lock().expect("tinted-cache mutex poisoned");
        if let Some(buf) = map.get(&color) {
            return buf.clone();
        }
    }

    let img = image::load_from_memory(TRAY_ICON_PNG)
        .expect("embedded tray-icon.png failed to decode")
        .to_rgba8();
    let (width, height) = img.dimensions();
    let (r, g, b) = color.rgb();
    let mut bytes = img.into_raw();
    for px in bytes.chunks_exact_mut(4) {
        if px[3] != 0 {
            px[0] = r;
            px[1] = g;
            px[2] = b;
        }
    }

    let buf = Arc::new(RgbaBuffer {
        bytes,
        width,
        height,
    });
    let mut map = cache().lock().expect("tinted-cache mutex poisoned");
    map.entry(color).or_insert_with(|| buf.clone()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_tint_returns_buffer_with_expected_color() {
        for color in [
            TintColor::Blue,
            TintColor::Orange,
            TintColor::Red,
            TintColor::Gray,
        ] {
            let buf = tinted(color);
            assert_eq!(buf.bytes.len(), (buf.width * buf.height * 4) as usize);
            let (r, g, b) = color.rgb();
            // Find at least one fully-opaque pixel and verify it carries the tint.
            let opaque = buf
                .bytes
                .chunks_exact(4)
                .find(|px| px[3] == 0xFF)
                .expect("tray icon has no fully opaque pixels");
            assert_eq!((opaque[0], opaque[1], opaque[2]), (r, g, b));
        }
    }

    #[test]
    fn transparent_pixels_are_preserved() {
        let buf = tinted(TintColor::Red);
        // Any fully-transparent pixel should remain (R, G, B, 0). We don't
        // assert a particular RGB value because the source PNG may carry
        // arbitrary garbage in transparent pixels; the contract is alpha == 0.
        let transparent_count = buf.bytes.chunks_exact(4).filter(|px| px[3] == 0).count();
        assert!(
            transparent_count > 0,
            "tray-icon.png has no fully-transparent pixels — test premise broken"
        );
    }

    #[test]
    fn cache_returns_same_arc_on_second_call() {
        let a = tinted(TintColor::Blue);
        let b = tinted(TintColor::Blue);
        assert!(
            Arc::ptr_eq(&a, &b),
            "expected cached Arc to be reused, got two distinct allocations"
        );
    }

    #[test]
    fn glyphs_for_splits_decimal_digits_most_significant_first() {
        assert_eq!(glyphs_for(0), vec![0]);
        assert_eq!(glyphs_for(7), vec![7]);
        assert_eq!(glyphs_for(47), vec![4, 7]);
        assert_eq!(glyphs_for(100), vec![1, 0, 0]);
        // Out-of-range input clamps rather than rendering a 4th digit.
        assert_eq!(glyphs_for(255), vec![1, 0, 0]);
    }

    #[test]
    fn digits_buffer_is_canvas_sized_rgba() {
        let buf = digits(47, TintColor::Blue);
        assert_eq!(buf.width, 32);
        assert_eq!(buf.height, 32);
        assert_eq!(buf.bytes.len(), 32 * 32 * 4);
    }

    #[test]
    fn digits_opaque_pixels_carry_the_tint_and_background_stays_transparent() {
        for color in [
            TintColor::Blue,
            TintColor::Orange,
            TintColor::Red,
            TintColor::Gray,
        ] {
            let buf = digits(90, color);
            let (r, g, b) = color.rgb();
            let opaque = buf
                .bytes
                .chunks_exact(4)
                .find(|px| px[3] == 0xFF)
                .expect("rendered digits have no opaque pixels");
            assert_eq!((opaque[0], opaque[1], opaque[2]), (r, g, b));
        }
        // Corners are outside the centered ink box at every digit count.
        let buf = digits(100, TintColor::Red);
        assert_eq!(buf.bytes[3], 0, "top-left corner should be transparent");
        let last = buf.bytes.len() - 1;
        assert_eq!(
            buf.bytes[last], 0,
            "bottom-right corner should be transparent"
        );
    }

    #[test]
    fn digits_render_distinct_shapes_per_value() {
        // A regression here (e.g. all glyphs drawing the same bitmap) would
        // make every percentage look identical in the tray.
        let a = digits(11, TintColor::Blue);
        let b = digits(88, TintColor::Blue);
        assert_ne!(a.bytes, b.bytes);
    }

    #[test]
    fn digits_cache_returns_same_arc_on_second_call() {
        let a = digits(47, TintColor::Blue);
        let b = digits(47, TintColor::Blue);
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn digits_smoke_renders_every_percentage_in_bounds() {
        for pct in 0..=100u8 {
            let buf = digits(pct, TintColor::Blue);
            assert_eq!(buf.bytes.len(), (buf.width * buf.height * 4) as usize);
            assert!(buf.bytes.chunks_exact(4).any(|px| px[3] == 0xFF));
        }
    }
}
