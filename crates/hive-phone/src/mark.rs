//! An agent's mark as a phone draws it: its manifest's shapes (paths, rectangles, circles,
//! ellipses, each maybe transformed) made into paths of absolute moves, lines and curves alone,
//! which every phone's drawing code reads without an SVG renderer. Drawn in one colour.

use std::collections::BTreeMap;
use std::fmt::Write;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use svgtypes::{SimplePathSegment, SimplifyingPathParser, Transform};

/// An agent's icon as the computer sends it (`HomeAgent.icon`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Icon {
    pub view_box: String,
    #[serde(default)]
    pub attrs: BTreeMap<String, String>,
    #[serde(default)]
    pub shapes: Vec<BTreeMap<String, BTreeMap<String, Value>>>,
}

/// A mark: the box its paths are drawn in, and its paths in drawing order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Mark {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub shapes: Vec<MarkShape>,
}

/// One path of a mark: `d` holds only absolute `M`, `L`, `C`, `Q` and `Z`. Filled when `fill`
/// (by the even-odd rule when `even_odd`), outlined `stroke` wide when above 0, round-ended when
/// `round`, at `opacity`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MarkShape {
    pub d: String,
    pub fill: bool,
    pub even_odd: bool,
    pub stroke: f64,
    pub round: bool,
    pub opacity: f64,
}

/// The mark `icon` draws; none when its box cannot be read or no shape of it can.
pub fn mark_of(icon: &Icon) -> Option<Mark> {
    let n: Vec<f64> = icon
        .view_box
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|s| !s.is_empty())
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    let [x, y, width, height] = n.as_slice() else {
        return None;
    };
    if *width <= 0.0 || *height <= 0.0 {
        return None;
    }
    // A root attribute, by either of its spellings.
    let root = |kebab: &str, camel: &str| {
        icon.attrs
            .get(kebab)
            .or_else(|| icon.attrs.get(camel))
            .cloned()
    };
    let shapes: Vec<MarkShape> = icon
        .shapes
        .iter()
        .filter_map(|shape| {
            let (kind, attrs) = shape.iter().next()?;
            let get = |k: &str| attrs.get(k).map(text);
            let num = |k: &str| get(k).and_then(|v| v.trim().parse::<f64>().ok());
            let d = match kind.as_str() {
                "path" => get("d")?,
                "circle" => {
                    let r = num("r")?;
                    ellipse(num("cx").unwrap_or(0.0), num("cy").unwrap_or(0.0), r, r)
                }
                "ellipse" => ellipse(
                    num("cx").unwrap_or(0.0),
                    num("cy").unwrap_or(0.0),
                    num("rx")?,
                    num("ry")?,
                ),
                "rect" => rect(
                    num("x").unwrap_or(0.0),
                    num("y").unwrap_or(0.0),
                    num("width")?,
                    num("height")?,
                    num("rx"),
                    num("ry"),
                ),
                _ => return None,
            };
            let transform = get("transform")
                .and_then(|t| t.parse::<Transform>().ok())
                .unwrap_or_default();
            let d = absolute(&d, &transform)?;
            let fill = get("fill").or_else(|| root("fill", "fill"));
            let stroke = get("stroke").or_else(|| root("stroke", "stroke"));
            let painted = |v: &Option<String>| v.as_deref().is_some_and(|v| v.trim() != "none");
            let width = get("stroke-width")
                .or_else(|| root("stroke-width", "strokeWidth"))
                .and_then(|w| w.trim().parse::<f64>().ok())
                .unwrap_or(1.0);
            let even_odd = get("fill-rule")
                .or_else(|| root("fill-rule", "fillRule"))
                .is_some_and(|r| r.trim() == "evenodd");
            let round = get("stroke-linecap")
                .or_else(|| root("stroke-linecap", "strokeLinecap"))
                .is_some_and(|c| c.trim() == "round");
            let opacity = |v: Option<String>| {
                v.and_then(|o| o.trim().parse::<f64>().ok())
                    .unwrap_or(1.0)
                    .clamp(0.0, 1.0)
            };
            Some(MarkShape {
                d,
                // SVG fills a shape that says nothing of its fill.
                fill: fill.is_none() || painted(&fill),
                even_odd,
                stroke: if painted(&stroke) {
                    width * scale(&transform)
                } else {
                    0.0
                },
                round,
                opacity: opacity(get("opacity")) * opacity(root("opacity", "opacity")),
            })
        })
        .collect();
    if shapes.is_empty() {
        return None;
    }
    Some(Mark {
        x: *x,
        y: *y,
        width: *width,
        height: *height,
        shapes,
    })
}

/// An attribute's value as text: a manifest may give a number.
fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn ellipse(cx: f64, cy: f64, rx: f64, ry: f64) -> String {
    format!(
        "M{} {cy}A{rx} {ry} 0 1 0 {} {cy}A{rx} {ry} 0 1 0 {} {cy}Z",
        cx - rx,
        cx + rx,
        cx - rx
    )
}

/// A rectangle, its corners rounded `rx` by `ry` (either alone rounds both ways), as SVG does.
fn rect(x: f64, y: f64, w: f64, h: f64, rx: Option<f64>, ry: Option<f64>) -> String {
    let (rx, ry) = match (rx, ry) {
        (Some(a), Some(b)) => (a, b),
        (Some(a), None) | (None, Some(a)) => (a, a),
        (None, None) => (0.0, 0.0),
    };
    let (rx, ry) = (rx.clamp(0.0, w / 2.0), ry.clamp(0.0, h / 2.0));
    if rx == 0.0 || ry == 0.0 {
        return format!("M{x} {y}H{}V{}H{x}Z", x + w, y + h);
    }
    let (r, b) = (x + w, y + h);
    format!(
        "M{} {y}H{}A{rx} {ry} 0 0 1 {r} {}V{}A{rx} {ry} 0 0 1 {} {b}H{}A{rx} {ry} 0 0 1 {x} {}V{}A{rx} {ry} 0 0 1 {} {y}Z",
        x + rx, r - rx, y + ry, b - ry, r - rx, x + rx, b - ry, y + ry, x + rx
    )
}

/// How much `t` grows a length, on average across its axes.
fn scale(t: &Transform) -> f64 {
    ((t.a * t.a + t.b * t.b).sqrt() + (t.c * t.c + t.d * t.d).sqrt()) / 2.0
}

/// `d` as absolute moves, lines, curves and closes, moved by `t`; none when it cannot be read.
fn absolute(d: &str, t: &Transform) -> Option<String> {
    let p = |x: f64, y: f64| (t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f);
    let n = |v: f64| {
        let r = (v * 1000.0).round() / 1000.0;
        if r == 0.0 {
            0.0
        } else {
            r
        }
    };
    let mut out = String::new();
    for segment in SimplifyingPathParser::from(d) {
        match segment.ok()? {
            SimplePathSegment::MoveTo { x, y } => {
                let (x, y) = p(x, y);
                let _ = write!(out, "M{} {}", n(x), n(y));
            }
            SimplePathSegment::LineTo { x, y } => {
                let (x, y) = p(x, y);
                let _ = write!(out, "L{} {}", n(x), n(y));
            }
            SimplePathSegment::CurveTo {
                x1,
                y1,
                x2,
                y2,
                x,
                y,
            } => {
                let ((x1, y1), (x2, y2), (x, y)) = (p(x1, y1), p(x2, y2), p(x, y));
                let _ = write!(
                    out,
                    "C{} {} {} {} {} {}",
                    n(x1),
                    n(y1),
                    n(x2),
                    n(y2),
                    n(x),
                    n(y)
                );
            }
            SimplePathSegment::Quadratic { x1, y1, x, y } => {
                let ((x1, y1), (x, y)) = (p(x1, y1), p(x, y));
                let _ = write!(out, "Q{} {} {} {}", n(x1), n(y1), n(x), n(y));
            }
            SimplePathSegment::ClosePath => out.push('Z'),
        }
    }
    (!out.is_empty()).then_some(out)
}
