//! Tray icon: a monochrome mark with a numeric badge of the repositories
//! that need attention (DESIGN.md, Tray), a tooltip and a small menu.
//!
//! The icon is drawn in code (no image decoding at run time): the app mark's
//! rounded square and ring in ink and white, and, when the count is not
//! zero, a red pill with the count in a 3x5 pixel font ("9+" above nine).

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

pub const TRAY_ID: &str = "main";
pub const MENU_SHOW: &str = "show";
pub const MENU_RESCAN: &str = "rescan";
pub const MENU_QUIT: &str = "quit";

const SIZE: u32 = 32;
const INK: [u8; 3] = [0x16, 0x18, 0x1d];
const RING: [u8; 3] = [0xf2, 0xf3, 0xf5];
/// DESIGN.md `risk` solid (light theme).
const BADGE: [u8; 3] = [0xdd, 0x4a, 0x3a];
const BADGE_TEXT: [u8; 3] = [0xff, 0xff, 0xff];

/// 3x5 glyphs, one row per entry, bit 2 is the left pixel.
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];
const PLUS: [u8; 5] = [0b000, 0b010, 0b111, 0b010, 0b000];
const GLYPH_SCALE: u32 = 2;

/// The badge text: the count, or "9+" above nine; nothing for zero.
pub fn badge_text(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=9 => Some(count.to_string()),
        _ => Some("9+".into()),
    }
}

pub fn tooltip(count: u32) -> String {
    match count {
        0 => "Repowatch: all repositories are clean".into(),
        1 => "Repowatch: 1 repository needs attention".into(),
        _ => format!("Repowatch: {count} repositories need attention"),
    }
}

/// RGBA pixels of the tray icon for `count`, `SIZE` x `SIZE`.
pub fn render_icon(count: u32) -> Vec<u8> {
    let mut canvas = Canvas::new(SIZE);
    let size = SIZE as f32;
    // The app mark: rounded square, ring (source.svg scaled to 32 px).
    canvas.fill(INK, |x, y| {
        rounded_rect(x, y, 2.0, 2.0, size - 4.0, size - 4.0, 6.5)
    });
    canvas.fill(RING, |x, y| {
        let d = ((x - 16.0).powi(2) + (y - 16.0).powi(2)).sqrt();
        (6.7..=9.0).contains(&d)
    });
    canvas.fill(RING, |x, y| {
        ((x - 16.0).powi(2) + (y - 16.0).powi(2)).sqrt() <= 2.7
    });

    if let Some(text) = badge_text(count) {
        let glyphs: Vec<[u8; 5]> = text
            .chars()
            .map(|c| match c.to_digit(10) {
                Some(d) => DIGITS[d as usize],
                None => PLUS,
            })
            .collect();
        let count = glyphs.len() as u32;
        let text_w = count * 3 * GLYPH_SCALE + (count - 1) * GLYPH_SCALE;
        let pill_h = 16.0;
        let pill_w = (text_w as f32 + 6.0).max(pill_h);
        let left = size - pill_w;
        let top = size - pill_h;
        canvas.fill(BADGE, |x, y| {
            rounded_rect(x, y, left, top, pill_w, pill_h, pill_h / 2.0)
        });
        let mut gx = (left + (pill_w - text_w as f32) / 2.0).round() as u32;
        let gy = (top + (pill_h - 5.0 * GLYPH_SCALE as f32) / 2.0).round() as u32;
        for glyph in glyphs {
            for (row, bits) in glyph.iter().enumerate() {
                for col in 0..3u32 {
                    if bits & (0b100 >> col) != 0 {
                        canvas.rect(
                            gx + col * GLYPH_SCALE,
                            gy + row as u32 * GLYPH_SCALE,
                            GLYPH_SCALE,
                            BADGE_TEXT,
                        );
                    }
                }
            }
            gx += 4 * GLYPH_SCALE;
        }
    }
    canvas.pixels
}

fn rounded_rect(x: f32, y: f32, left: f32, top: f32, w: f32, h: f32, r: f32) -> bool {
    if x < left || y < top || x > left + w || y > top + h {
        return false;
    }
    let cx = x.clamp(left + r, left + w - r);
    let cy = y.clamp(top + r, top + h - r);
    (x - cx).powi(2) + (y - cy).powi(2) <= r * r
}

struct Canvas {
    size: u32,
    pixels: Vec<u8>,
}

impl Canvas {
    fn new(size: u32) -> Self {
        Self {
            size,
            pixels: vec![0; (size * size * 4) as usize],
        }
    }

    /// Paints the shape with 4x4 supersampled coverage (anti-aliased edges).
    fn fill(&mut self, color: [u8; 3], inside: impl Fn(f32, f32) -> bool) {
        const SAMPLES: u32 = 4;
        for py in 0..self.size {
            for px in 0..self.size {
                let mut hits = 0;
                for sy in 0..SAMPLES {
                    for sx in 0..SAMPLES {
                        let x = px as f32 + (sx as f32 + 0.5) / SAMPLES as f32;
                        let y = py as f32 + (sy as f32 + 0.5) / SAMPLES as f32;
                        if inside(x, y) {
                            hits += 1;
                        }
                    }
                }
                if hits > 0 {
                    self.blend(px, py, color, hits as f32 / (SAMPLES * SAMPLES) as f32);
                }
            }
        }
    }

    fn rect(&mut self, x: u32, y: u32, side: u32, color: [u8; 3]) {
        for py in y..(y + side).min(self.size) {
            for px in x..(x + side).min(self.size) {
                self.blend(px, py, color, 1.0);
            }
        }
    }

    /// Source-over blending of an opaque colour with `coverage` alpha.
    fn blend(&mut self, x: u32, y: u32, color: [u8; 3], coverage: f32) {
        let i = ((y * self.size + x) * 4) as usize;
        let dst_a = f32::from(self.pixels[i + 3]) / 255.0;
        let out_a = coverage + dst_a * (1.0 - coverage);
        for (c, value) in color.iter().enumerate() {
            let src = f32::from(*value);
            let dst = f32::from(self.pixels[i + c]);
            let out = (src * coverage + dst * dst_a * (1.0 - coverage)) / out_a.max(f32::EPSILON);
            self.pixels[i + c] = out.round().clamp(0.0, 255.0) as u8;
        }
        self.pixels[i + 3] = (out_a * 255.0).round().clamp(0.0, 255.0) as u8;
    }
}

/// Creates the tray icon with its menu. Menu and click handling are done by
/// `on_menu` and `on_click`.
pub fn create<R: Runtime>(
    app: &AppHandle<R>,
    on_menu: impl Fn(&AppHandle<R>, &str) + Send + Sync + 'static,
) -> tauri::Result<TrayIcon<R>> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, MENU_SHOW, "Open Repowatch", true, None::<&str>)?,
            &MenuItem::with_id(app, MENU_RESCAN, "Rescan now", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, MENU_QUIT, "Quit Repowatch", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::new_owned(render_icon(0), SIZE, SIZE))
        .tooltip(tooltip(0))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
}

/// Updates the badge and tooltip.
pub fn set_count<R: Runtime>(app: &AppHandle<R>, count: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(Image::new_owned(render_icon(count), SIZE, SIZE)));
        let _ = tray.set_tooltip(Some(tooltip(count)));
    }
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(pixels: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * SIZE + x) * 4) as usize;
        [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
    }

    #[test]
    fn badge_text_caps_at_nine_plus() {
        assert_eq!(badge_text(0), None);
        assert_eq!(badge_text(1).as_deref(), Some("1"));
        assert_eq!(badge_text(9).as_deref(), Some("9"));
        assert_eq!(badge_text(10).as_deref(), Some("9+"));
        assert_eq!(badge_text(u32::MAX).as_deref(), Some("9+"));
    }

    #[test]
    fn tooltip_names_the_count() {
        assert_eq!(tooltip(0), "Repowatch: all repositories are clean");
        assert_eq!(tooltip(1), "Repowatch: 1 repository needs attention");
        assert_eq!(tooltip(7), "Repowatch: 7 repositories need attention");
    }

    #[test]
    fn icon_without_attention_is_monochrome() {
        let pixels = render_icon(0);
        assert_eq!(pixels.len(), (SIZE * SIZE * 4) as usize);
        assert_eq!(pixel(&pixels, 0, 0)[3], 0, "transparent corner");
        assert_eq!(pixel(&pixels, 4, 16), [INK[0], INK[1], INK[2], 255]);
        for chunk in pixels.chunks(4).filter(|p| p[3] > 0) {
            // Every visible pixel is a grey between ink and white.
            let spread = chunk[..3].iter().max().unwrap() - chunk[..3].iter().min().unwrap();
            assert!(spread <= 8, "{chunk:?} is coloured");
        }
    }

    #[test]
    fn badge_is_drawn_bottom_right_only() {
        let plain = render_icon(0);
        for count in [1, 5, 12] {
            let badged = render_icon(count);
            assert_eq!(
                pixel(&badged, 31, 24)[..3],
                BADGE,
                "badge colour at the right edge"
            );
            for y in 0..SIZE {
                for x in 0..SIZE {
                    if y < 16 {
                        assert_eq!(pixel(&badged, x, y), pixel(&plain, x, y), "({x},{y})");
                    }
                }
            }
        }
        // Different counts render different glyphs.
        assert_ne!(render_icon(1), render_icon(2));
        assert_eq!(render_icon(10), render_icon(99));
        assert_ne!(render_icon(9), render_icon(10));
    }

    /// Writes raw RGBA icons for a visual check:
    /// `REPOWATCH_TRAY_DUMP=<folder> cargo test -p repowatch dump_icons -- --ignored`.
    #[test]
    #[ignore = "writes files for a manual visual check"]
    fn dump_icons() {
        let dir = std::path::PathBuf::from(std::env::var_os("REPOWATCH_TRAY_DUMP").unwrap());
        for count in [0, 3, 12] {
            std::fs::write(dir.join(format!("tray-{count}.rgba")), render_icon(count)).unwrap();
        }
    }
}
