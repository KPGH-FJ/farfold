//! Main-page CSS coordinates to the independent child controller's physical bounds.
//! No child-page zoom is changed by this conversion.
pub(super) fn physical_bounds(
    bounds: [f64; 4],
    dpi: f64,
    zoom: f64,
    client: [i32; 2],
) -> Option<[i32; 4]> {
    let [x, y, width, height] = bounds;
    let factor = dpi * zoom;
    if ![x, y, width, height, dpi, zoom, factor]
        .iter()
        .all(|n| n.is_finite())
        || x < 0.0
        || y < 0.0
        || width <= 0.0
        || height <= 0.0
        || factor <= 0.0
        || dpi <= 0.0
        || zoom <= 0.0
    {
        return None;
    }
    let pixels = [x, y, x + width, y + height].map(|n| (n * factor).round());
    if !pixels
        .iter()
        .all(|n| n.is_finite() && *n <= i32::MAX as f64)
    {
        return None;
    }
    let rect = pixels.map(|n| n as i32);
    (rect[2] <= client[0] && rect[3] <= client[1] && rect[2] > rect[0] && rect[3] > rect[1])
        .then_some(rect)
}

#[cfg(test)]
mod tests {
    use super::physical_bounds;

    #[test]
    fn combines_os_dpi_and_main_page_zoom_once() {
        assert_eq!(
            physical_bounds([100.0, 50.0, 200.0, 100.0], 2.0, 1.25, [1000, 800]),
            Some([250, 125, 750, 375])
        );
    }

    #[test]
    fn retains_unzoomed_and_fractional_pixel_rounding() {
        assert_eq!(
            physical_bounds([10.2, 20.4, 30.5, 40.2], 1.0, 1.0, [100, 100]),
            Some([10, 20, 41, 61])
        );
    }

    #[test]
    fn refuses_invalid_zoom_and_rectangles_outside_the_actual_window() {
        for zoom in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                physical_bounds([10.0, 10.0, 20.0, 20.0], 1.0, zoom, [100, 100]),
                None
            );
        }
        assert_eq!(
            physical_bounds([50.0, 0.0, 50.0, 50.0], 2.0, 1.5, [250, 200]),
            None
        );
        assert_eq!(
            physical_bounds([0.0, 0.0, 20.0, 20.0], f64::NAN, 1.0, [100, 100]),
            None
        );
        assert_eq!(
            physical_bounds([0.0, 0.0, f64::MAX, 20.0], 2.0, 1.0, [100, 100]),
            None
        );
    }
}
