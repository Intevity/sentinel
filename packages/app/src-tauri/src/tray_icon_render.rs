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

    let buf = Arc::new(RgbaBuffer { bytes, width, height });
    let mut map = cache().lock().expect("tinted-cache mutex poisoned");
    map.entry(color).or_insert_with(|| buf.clone()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_tint_returns_buffer_with_expected_color() {
        for color in [TintColor::Blue, TintColor::Orange, TintColor::Red, TintColor::Gray] {
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
}
