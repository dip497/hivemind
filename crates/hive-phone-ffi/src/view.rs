//! Community views on the phone, as the apps show them (docs/design/phone-app-2026-10-02.md §5.5,
//! §6.1): the views a device offers a phone, their files as the app serves them to a view's web
//! view, and a view shown there, its host on the device, on the phone's screen. A view goes on
//! across the background, the foreground and the device's reconnects: on each connection after
//! the first, it is opened again and starts again (`ViewEnded::Restarting`: its page loaded anew).

use std::{collections::HashMap, sync::Arc};

use hive_phone::{
    failure::Lost,
    viewing::{self, Viewer, Viewing},
    views,
};
use serde_json::Value;

use crate::{on_runtime, phone::Phone, PhoneError, RUNTIME};

/// A community view installed on a device that says it works on a phone: its id, name and
/// version, and the page to load to show it, served by `view_file`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ViewInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub page: String,
}

/// One of a view's files, as the device serves it to its own windows: its bytes, its type, and
/// the Content-Security-Policy the app serves it under (whose nonce a page made for it carries).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ViewFile {
    pub data: Vec<u8>,
    pub mime: String,
    pub csp: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ThemeMode {
    Dark,
    Light,
}

/// A view's fonts, by their families: for its words, and for code.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ViewFonts {
    pub ui: String,
    pub mono: String,
}

/// The look the app gives views, as the view protocol's `theme` has it: dark or light, its
/// colours by token (`bg`, `fg`, …, each `#rrggbb`), and when the app says them, its accent,
/// corner radius in pixels, fonts, panel surface and terminal background (`#rrggbb`), glass, and
/// a colour for each status tone (`working`, `attention`, `done`, `idle`, `exited`, `failed`).
/// The device refuses a screen with a colour, a token or a font it does not take.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ViewTheme {
    pub mode: ThemeMode,
    pub colors: HashMap<String, String>,
    #[uniffi(default)]
    pub accent: Option<String>,
    #[uniffi(default)]
    pub radius: Option<u32>,
    #[uniffi(default)]
    pub fonts: Option<ViewFonts>,
    #[uniffi(default)]
    pub surface: Option<String>,
    #[uniffi(default)]
    pub terminal_background: Option<String>,
    #[uniffi(default)]
    pub glass: Option<bool>,
    #[uniffi(default)]
    pub status: HashMap<String, String>,
}

/// The screen a view is shown on: the size of its web view, in CSS pixels (points on iOS, dp on
/// Android), and the look the app gives views.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Screen {
    pub width: u32,
    pub height: u32,
    pub theme: ViewTheme,
}

impl From<Screen> for views::Screen {
    fn from(screen: Screen) -> Self {
        let theme = screen.theme;
        Self {
            w: screen.width,
            h: screen.height,
            theme: views::Theme {
                colors: theme.colors.into_iter().collect(),
                mode: Some(match theme.mode {
                    ThemeMode::Dark => views::Mode::Dark,
                    ThemeMode::Light => views::Mode::Light,
                }),
                accent: theme.accent,
                radius: theme.radius,
                fonts: theme.fonts.map(|fonts| views::Fonts {
                    ui: fonts.ui,
                    mono: fonts.mono,
                }),
                surface: theme.surface,
                terminal_background: theme.terminal_background,
                glass: theme.glass,
                status: theme.status.into_iter().collect(),
            },
        }
    }
}

/// Why a view shown is told no more, or starts again.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ViewEnded {
    /// The connection to its device went, and the view has a session there again: load its page
    /// anew, so it starts again in this one. Not the last thing told; what its page of before
    /// posts until the page loaded anew says it is ready is dropped.
    Restarting,
    /// The device's host turned the view off, in its words: it flooded, or sent what it may not.
    Disabled { why: String },
    /// The device said no, in its words: it offers no such view now, …
    Refused { why: String },
    /// Its workspace is not on that device now.
    NotHeld,
    /// That device is not one of the person's now.
    Unpaired,
}

impl From<viewing::Ended> for ViewEnded {
    fn from(ended: viewing::Ended) -> Self {
        match ended {
            viewing::Ended::Restarting => Self::Restarting,
            viewing::Ended::Disabled(why) => Self::Disabled { why },
            viewing::Ended::Lost(Lost::Refused(why)) => Self::Refused { why },
            viewing::Ended::Lost(Lost::NotHeld(_)) => Self::NotHeld,
            viewing::Ended::Lost(Lost::Unpaired(_)) => Self::Unpaired,
        }
    }
}

/// What a view shown tells the app, from a thread of the core's: the app hops to its own, in the
/// order told.
#[uniffi::export(with_foreign)]
pub trait ViewListener: Send + Sync {
    /// Its host said `message` to the view: a view protocol message, as JSON, for the app to hand
    /// the page as it is.
    fn said(&self, message: String);
    /// It starts again (`Restarting`), or is told no more: then once, last.
    fn ended(&self, why: ViewEnded);
}

/// A listener, as the core tells a view's news.
struct Listening(Arc<dyn ViewListener>);

impl Viewer for Listening {
    fn said(&self, message: Value) {
        self.0.said(message.to_string())
    }

    fn ended(&self, why: viewing::Ended) {
        self.0.ended(why.into())
    }
}

/// A view shown on the phone, until stopped.
#[derive(uniffi::Object)]
pub struct ViewSession(Viewing);

#[uniffi::export]
impl ViewSession {
    /// What the view posted, as JSON, for its host: dropped when it is not JSON, or while the view
    /// posts faster than its host takes it.
    pub fn post(&self, message: String) {
        self.0.post(&message)
    }

    /// The view is shown on `screen` now (the phone turned, the keyboard came up, the look
    /// changed): its host tells it what of that changed.
    pub fn screen(&self, screen: Screen) {
        self.0.screen(screen.into())
    }

    /// It is shown no more: nothing is told after, and its device lets go of it.
    pub fn stop(&self) {
        self.0.stop()
    }
}

/// The script the app runs at the start of each view's page, in the page's own world
/// (`WKUserScript` at document start; Android's `addDocumentStartJavaScript`): it hands the view
/// its port once the page has loaded, and relays it as JSON text. The page posts through `hive`,
/// the object the app gives it (`webkit.messageHandlers.hive`, or Android's web message
/// listener), and is told through `hive.onmessage` on Android, `__hive.said(text)` on iOS.
#[uniffi::export]
pub fn view_bridge() -> String {
    viewing::BRIDGE.to_string()
}

/// Whether `message`, which a view's page posted, starts or closes something on the board: the
/// app asks the phone's lock before it posts it, and drops it when the lock says no.
#[uniffi::export]
pub fn view_asks_lock(message: String) -> bool {
    viewing::asks_lock(&message)
}

/// A live surface a view's page asks for: the tile whose terminal the app places there, and
/// where, in the page's CSS pixels (points on iOS, dp on Android) from the web view's top left;
/// `bar`: under a bar naming it.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ViewSurface {
    pub tile: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub bar: bool,
}

/// The live surfaces `message`, which a view's page posted, asks for, when it is the view's
/// surface rects (`setSurfaceRects`): the app places its own terminal at each, those it had and
/// no longer asks for gone, and posts the message nowhere. None: any other message, posted as
/// it is. Only for a view opened with `surfaces`.
#[uniffi::export]
pub fn view_surfaces(message: String) -> Option<Vec<ViewSurface>> {
    let surfaces = viewing::surfaces(&message)?;
    let placed = surfaces.into_iter().map(|s| ViewSurface {
        tile: s.tile,
        x: s.x,
        y: s.y,
        width: s.w,
        height: s.h,
        bar: s.bar,
    });
    Some(placed.collect())
}

#[uniffi::export]
impl Phone {
    /// The community views `device` offers a phone, for `workspace`, which it holds.
    pub async fn views(
        &self,
        device: String,
        workspace: String,
    ) -> Result<Vec<ViewInfo>, PhoneError> {
        let connections = self.connections.clone();
        on_runtime(async move {
            let connection = connections.holding(&device, &workspace).await?;
            let offered = views::list(&connection, &workspace).await?;
            let info = offered.into_iter().map(|view| ViewInfo {
                id: view.id,
                name: view.name,
                version: view.version,
                page: view.page,
            });
            Ok(info.collect())
        })
        .await
    }

    /// The file at `path` in the view `view`, from `device`, which holds `workspace`: served to
    /// the view's web view as it comes, under its policy.
    pub async fn view_file(
        &self,
        device: String,
        workspace: String,
        view: String,
        path: String,
    ) -> Result<ViewFile, PhoneError> {
        let connections = self.connections.clone();
        on_runtime(async move {
            let connection = connections.holding(&device, &workspace).await?;
            let file = views::file(&connection, &workspace, &view, &path).await?;
            Ok(ViewFile {
                data: file.bytes,
                mime: file.mime,
                csp: file.csp,
            })
        })
        .await
    }

    /// Show the view `view` on `workspace`, on `device`, on `screen`: what its page posts goes in
    /// by `post`, and `listener` is told what its host says, and when it starts again or ends. It
    /// goes on across the background, the foreground and the device's reconnects until stopped.
    /// `surfaces`: the app places the live surfaces the view asks for itself (`view_surfaces`),
    /// and the view is told it does.
    #[uniffi::method(default(surfaces = false))]
    pub fn open_view(
        &self,
        device: String,
        workspace: String,
        view: String,
        screen: Screen,
        listener: Arc<dyn ViewListener>,
        surfaces: bool,
    ) -> Arc<ViewSession> {
        let _runtime = RUNTIME.enter();
        let listening = Arc::new(Listening(listener));
        let (connections, screen) = (&self.connections, screen.into());
        let viewing = Viewing::start(
            connections,
            &device,
            &workspace,
            &view,
            screen,
            surfaces,
            listening,
        );
        Arc::new(ViewSession(viewing))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_screen_the_app_gives_reaches_the_device_as_the_view_protocol_has_it() {
        let theme = ViewTheme {
            mode: ThemeMode::Light,
            colors: HashMap::from([
                ("bg".into(), "#ffffff".into()),
                ("fg".into(), "#202124".into()),
            ]),
            accent: Some("#3a7bd5".into()),
            radius: Some(12),
            fonts: Some(ViewFonts {
                ui: "-apple-system".into(),
                mono: "ui-monospace".into(),
            }),
            surface: Some("#f1f3f4".into()),
            terminal_background: Some("#ffffff".into()),
            glass: Some(false),
            status: HashMap::from([("working".into(), "#4caf50".into())]),
        };
        let screen = Screen {
            width: 390,
            height: 844,
            theme,
        };
        let sent = serde_json::to_value(views::Screen::from(screen.clone())).unwrap();
        assert_eq!(
            sent,
            json!({ "w": 390, "h": 844, "theme": {
                "colors": { "bg": "#ffffff", "fg": "#202124" }, "mode": "light", "accent": "#3a7bd5",
                "radius": 12, "fonts": { "ui": "-apple-system", "mono": "ui-monospace" },
                "surface": "#f1f3f4", "terminalBackground": "#ffffff", "glass": false,
                "status": { "working": "#4caf50" },
            } })
        );
        // What the app does not say is not said.
        let plain = ViewTheme {
            mode: ThemeMode::Dark,
            colors: HashMap::new(),
            accent: None,
            radius: None,
            fonts: None,
            surface: None,
            terminal_background: None,
            glass: None,
            status: HashMap::new(),
        };
        let screen = Screen {
            theme: plain,
            ..screen
        };
        let sent = serde_json::to_value(views::Screen::from(screen)).unwrap();
        assert_eq!(
            sent,
            json!({ "w": 390, "h": 844, "theme": { "colors": {}, "mode": "dark" } })
        );
    }

    #[test]
    fn why_a_view_ends_is_told_apart_as_the_app_shows_it() {
        let cases = [
            (viewing::Ended::Restarting, ViewEnded::Restarting),
            (
                viewing::Ended::Disabled("it flooded".into()),
                ViewEnded::Disabled {
                    why: "it flooded".into(),
                },
            ),
            (
                viewing::Ended::Lost(Lost::Refused("no view x here".into())),
                ViewEnded::Refused {
                    why: "no view x here".into(),
                },
            ),
            (
                viewing::Ended::Lost(Lost::NotHeld("desk does not hold it".into())),
                ViewEnded::NotHeld,
            ),
            (
                viewing::Ended::Lost(Lost::Unpaired("d9 is not yours".into())),
                ViewEnded::Unpaired,
            ),
        ];
        for (core, app) in cases {
            assert_eq!(ViewEnded::from(core), app);
        }
    }
}
